import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { listBrowser } from '../app/js/browser.js';
import { listConflicts } from '../app/js/conflicts.js';
import { deleteDatabase, getFile, getMeta, listFiles, openDatabase, putFile } from '../app/js/db.js';
import { listVaultEntries, selectMarkdown } from '../app/js/github-api.js';
import { saveGithubSession, saveGithubTarget } from '../app/js/github-store.js';
import {
  createAutoSync,
  fetchRemoteBlob,
  loadConflictRemote,
  RACE_RETRY_LIMIT,
  raceDelay,
  REMOTE_LOAD_TIMEOUT_MS,
  remoteDeleteDecision,
  shouldAutoUpload,
  SYNC_STATUS,
} from '../app/js/github-sync.js';
import { notePathFromName, notePathFromWikilink } from '../app/js/notes.js';
import { cleanSegment, liveNotes } from '../app/js/organize.js';
import { isIgnoredPath } from '../app/js/vault-paths.js';
import { createFakeGit } from './helpers/fake-git.js';

const TOKEN = 'gho_testtokenvalue123456';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80]);

function vault() {
  return {
    'Notes/A.md': 'alpha\n',
    'Notes/B.md': 'one\ntwo\nthree\n',
    'Daily/2026-10-21.md': 'day\n',
    '.obsidian/workspace.json': '{"active":"Notes/A.md"}\n',
    '.obsidian/app.json': '{"attachmentFolderPath":"assets"}\n',
    '.obsidian/plugins/obsidian-git/data.json': '{"autoSaveInterval":5}\n',
    '.trash/Old.md': 'old trashed note\n',
    '.gitignore': '.obsidian/workspace.json\n',
    'assets/pic.png': PNG,
  };
}

async function harness(files = vault()) {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await saveGithubSession(db, { token: TOKEN, login: 'octocat' });
  await saveGithubTarget(db, { repo: 'owner/repo', branch: 'main', root: '' });
  const git = createFakeGit({ token: TOKEN, files });
  const history = [];
  const sleeps = [];
  const scheduled = [];
  let time = 1_700_000_000_000;
  const sync = createAutoSync({
    db,
    fetchImpl: git.fetchImpl,
    now: () => time,
    random: () => 0,
    setTimer(fn, ms) {
      const id = { fn, ms, unref() {} };
      scheduled.push(id);
      return id;
    },
    clearTimer() {},
    async sleep(ms) {
      sleeps.push(ms);
    },
    onStatus(text) {
      history.push(text);
    },
  });
  return {
    db,
    git,
    sync,
    history,
    sleeps,
    scheduled,
    tick(ms) {
      time += ms;
    },
    async edit(path, content) {
      const file = await getFile(db, path);
      const next = file
        ? { ...file, content, dirty: true, updatedAt: Date.now() }
        : { path, content, kind: 'markdown', encoding: 'utf-8', createdAt: 1, updatedAt: 1, trashedAt: null, dirty: true, origin: 'user' };
      await putFile(db, next);
      await sync.noteEdited(next);
      return next;
    },
    async close() {
      sync.stop();
      db.close();
      await deleteDatabase(name);
    },
  };
}

function dotEntries(git, sha) {
  return [...git.entriesAt(sha)].filter(([path]) => isIgnoredPath(path)).map(([path, entry]) => [path, entry.sha, entry.mode]);
}

function treeWrites(git) {
  return git.state.log.filter((item) => item.method === 'POST' && item.path.endsWith('/git/trees'));
}

test('dot-folders and dot-files are never notes', () => {
  for (const path of ['.obsidian/app.json', '.trash/Old.md', '.gitignore', '.github/workflows/ci.yml', 'Notes/.hidden/x.md', '.git-crypt/keys']) {
    assert.equal(isIgnoredPath(path), true, path);
  }
  for (const path of ['Notes/A.md', 'Daily/2026-10-21.md', 'a.b/c.md', 'Notes/v1.2.md']) {
    assert.equal(isIgnoredPath(path), false, path);
  }
  const tree = {
    truncated: false,
    tree: Object.keys(vault()).map((path) => ({ path, type: 'blob', sha: `s-${path}` })),
  };
  assert.deepEqual(selectMarkdown(tree, '').map((note) => note.localPath), ['Daily/2026-10-21.md', 'Notes/A.md', 'Notes/B.md']);
  assert.deepEqual(listVaultEntries(tree, '').map((entry) => entry.path), ['assets/pic.png', 'Daily/2026-10-21.md', 'Notes/A.md', 'Notes/B.md'].sort((a, b) => a.localeCompare(b)));
  assert.throws(() => notePathFromName('.obsidian', []), /dot/);
  assert.throws(() => notePathFromWikilink('.trash/Old', []), /dot/);
  assert.throws(() => cleanSegment('.trash'), /dot/);
  assert.equal(shouldAutoUpload({ path: '.trash/Old.md', kind: 'markdown', dirty: true, origin: 'user' }), false);
  const files = [
    { path: 'Notes/A.md', kind: 'markdown', content: 'a' },
    { path: '.trash/Old.md', kind: 'markdown', content: 'old', baseSha: 'x' },
    { path: '.obsidian/x.md', kind: 'markdown', content: 'x', conflict: true },
    { path: '.trash/Gone.md', kind: 'markdown', content: 'g', trashedAt: 5 },
  ];
  assert.deepEqual(liveNotes(files).map((file) => file.path), ['Notes/A.md']);
  const rows = listBrowser({ files, folders: ['.trash', '.obsidian', 'Notes'], expanded: ['Notes'], recent: ['.trash/Old.md'], query: '', currentPath: '' });
  assert.equal(rows.some((row) => String(row.path || '').startsWith('.')), false, JSON.stringify(rows));
  assert.equal(rows.some((row) => row.type === 'trash'), false);
  assert.deepEqual(listConflicts(files), []);
  assert.equal(remoteDeleteDecision({ path: '.trash/Old.md', baseSha: 'x', remoteSha: 'x', syncedCommit: 'c1' }, { headSha: 'c2' }), 'keep');
});

test('the first sync downloads notes, indexes attachments, and leaves .obsidian and .trash on GitHub', async () => {
  const box = await harness();
  try {
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const files = await listFiles(box.db);
    const paths = files.map((file) => file.path).sort();
    assert.deepEqual(paths, ['Daily/2026-10-21.md', 'Notes/A.md', 'Notes/B.md', 'assets/pic.png']);
    const pic = files.find((file) => file.path === 'assets/pic.png');
    assert.equal(pic.kind, 'binary');
    assert.equal(pic.content, '');
    const cursor = await getMeta(box.db, 'githubSyncCursor');
    assert.equal(Object.keys(cursor.lastBlobs).some(isIgnoredPath), false);
    assert.equal(box.git.state.log.some((item) => /\/git\/blobs\/./.test(item.path) && item.method === 'GET'
      && [...box.git.entriesAt()].some(([path, entry]) => isIgnoredPath(path) && item.path.endsWith(entry.sha))), false);
    assert.equal(box.git.state.log.some((item) => /\/git\/blobs\/./.test(item.path) && item.method === 'GET'
      && item.path.endsWith(pic.remoteSha)), false);
  } finally {
    await box.close();
  }
});

test('a push that races an Obsidian vault backup rebuilds on the new head and keeps dot-folders byte-identical', async () => {
  const box = await harness();
  try {
    await box.sync.runNow();
    const before = box.git.state.head;
    let raced = '';
    box.git.state.hooks.beforePatch = () => {
      if (raced) return;
      raced = box.git.commitOn(box.git.state.head, {
        'Daily/2026-10-21.md': 'day\nfrom the computer\n',
        '.obsidian/workspace.json': '{"active":"Daily/2026-10-21.md"}\n',
        '.trash/Older.md': 'trashed on the computer\n',
      });
      box.git.advance(raced);
    };
    await box.edit('Notes/A.md', 'alpha\nfrom the phone\n');
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    assert.equal(box.history.includes(SYNC_STATUS.failed), false);
    assert.equal(box.history.includes(SYNC_STATUS.conflict), false);
    assert.equal(box.git.state.rejectedPatches, 1);
    assert.equal(box.sleeps.length, 1);
    const head = box.git.state.head;
    assert.notEqual(head, raced);
    assert.equal(box.git.descends(head, raced), true);
    assert.equal(box.git.descends(head, before), true);
    const remote = box.git.snapshot(head);
    assert.equal(remote.get('Notes/A.md'), 'alpha\nfrom the phone\n');
    assert.equal(remote.get('Daily/2026-10-21.md'), 'day\nfrom the computer\n');
    assert.deepEqual(dotEntries(box.git, head), dotEntries(box.git, raced));
    assert.equal(box.git.blobShaAt('assets/pic.png', head), box.git.blobShaAt('assets/pic.png', before));
    for (const write of treeWrites(box.git)) {
      assert.equal(write.body.tree.some((entry) => isIgnoredPath(entry.path)), false);
      assert.equal(typeof write.body.base_tree, 'string');
    }
    const local = await getFile(box.db, 'Daily/2026-10-21.md');
    assert.equal(local.content, 'day\nfrom the computer\n');
    assert.equal((await listFiles(box.db)).some((file) => isIgnoredPath(file.path)), false);
    assert.equal((await listFiles(box.db)).some((file) => file.conflict || file.conflictCopy), false);
  } finally {
    await box.close();
  }
});

test('a push that races an Obsidian merge commit lands on the merge and keeps both sides', async () => {
  const box = await harness();
  try {
    await box.sync.runNow();
    const desktopBase = box.git.state.head;
    await box.edit('Notes/B.md', 'one\ntwo\nthree\nphone first push\n');
    await box.sync.runNow();
    const phonePush = box.git.state.head;
    assert.notEqual(phonePush, desktopBase);
    const desktop = box.git.commitOn(desktopBase, {
      'Daily/2026-10-21.md': 'day\ndesktop\n',
      '.obsidian/workspace.json': '{"active":"Daily"}\n',
    });
    let merge = '';
    box.git.state.hooks.beforePatch = () => {
      if (merge) return;
      merge = box.git.mergeFiles(desktop, phonePush);
      box.git.advance(merge);
    };
    await box.edit('Notes/A.md', 'alpha\nsecond phone push\n');
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    assert.equal(box.git.state.commits.get(merge).parents.length, 2);
    const head = box.git.state.head;
    assert.deepEqual(box.git.state.commits.get(head).parents, [merge]);
    const remote = box.git.snapshot(head);
    assert.equal(remote.get('Notes/A.md'), 'alpha\nsecond phone push\n');
    assert.equal(remote.get('Notes/B.md'), 'one\ntwo\nthree\nphone first push\n');
    assert.equal(remote.get('Daily/2026-10-21.md'), 'day\ndesktop\n');
    assert.deepEqual(dotEntries(box.git, head), dotEntries(box.git, merge));
    assert.equal(box.history.includes(SYNC_STATUS.conflict), false);
    assert.equal((await getFile(box.db, 'Notes/B.md')).content, 'one\ntwo\nthree\nphone first push\n');
    assert.equal((await getFile(box.db, 'Daily/2026-10-21.md')).content, 'day\ndesktop\n');
  } finally {
    await box.close();
  }
});

test('a race on the same note with different lines merges without a conflict', async () => {
  const box = await harness();
  try {
    await box.sync.runNow();
    let raced = '';
    box.git.state.hooks.beforePatch = () => {
      if (raced) return;
      raced = box.git.advance(box.git.commitOn(box.git.state.head, { 'Notes/B.md': 'one\ntwo\nthree desktop\n' }));
    };
    await box.edit('Notes/B.md', 'one phone\ntwo\nthree\n');
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    assert.equal(box.git.snapshot().get('Notes/B.md'), 'one phone\ntwo\nthree desktop\n');
    const local = await getFile(box.db, 'Notes/B.md');
    assert.equal(local.content, 'one phone\ntwo\nthree desktop\n');
    assert.equal(local.conflict, false);
    assert.equal((await listFiles(box.db)).some((file) => file.conflictCopy), false);
  } finally {
    await box.close();
  }
});

test('a race that edits the same line is the only kind that becomes a Conflict, and GitHub keeps the desktop text', async () => {
  const box = await harness();
  try {
    await box.sync.runNow();
    let raced = '';
    box.git.state.hooks.beforePatch = () => {
      if (raced) return;
      raced = box.git.advance(box.git.commitOn(box.git.state.head, { 'Notes/B.md': 'one\ntwo desktop\nthree\n' }));
    };
    await box.edit('Notes/B.md', 'one\ntwo phone\nthree\n');
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.conflict);
    assert.equal(box.git.state.head, raced);
    assert.equal(box.git.snapshot().get('Notes/B.md'), 'one\ntwo desktop\nthree\n');
    const local = await getFile(box.db, 'Notes/B.md');
    assert.equal(local.content, 'one\ntwo phone\nthree\n');
    assert.equal(local.conflict, true);
    assert.equal(local.conflictReason, 'both');
    assert.equal(local.conflictRemote, 'one\ntwo desktop\nthree\n');
  } finally {
    await box.close();
  }
});

test('a race that keeps losing backs off within bounds and stays pending without a conflict', async () => {
  const box = await harness();
  try {
    await box.sync.runNow();
    let n = 0;
    box.git.state.hooks.beforePatch = () => {
      n += 1;
      box.git.advance(box.git.commitOn(box.git.state.head, { '.obsidian/workspace.json': `{"n":${n}}\n` }));
    };
    await box.edit('Notes/A.md', 'alpha\nkeep trying\n');
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.pending);
    assert.equal(box.git.state.rejectedPatches, RACE_RETRY_LIMIT + 1);
    assert.deepEqual(box.sleeps, Array.from({ length: RACE_RETRY_LIMIT }, (_, i) => raceDelay(i, () => 0)));
    assert.equal(box.history.includes(SYNC_STATUS.failed), false);
    assert.equal(box.history.includes(SYNC_STATUS.conflict), false);
    const local = await getFile(box.db, 'Notes/A.md');
    assert.equal(local.content, 'alpha\nkeep trying\n');
    assert.equal(local.dirty, true);
    assert.equal(local.conflict, false);
    box.git.state.hooks.beforePatch = null;
    const retry = box.scheduled.find((item) => item.ms > 0 && item.ms < 60_000);
    assert.ok(retry);
    box.tick(retry.ms);
    const later = await box.sync.runNow('retry');
    assert.equal(later.status, SYNC_STATUS.synced);
    assert.equal(box.git.snapshot().get('Notes/A.md'), 'alpha\nkeep trying\n');
    assert.equal(box.git.snapshot().get('.obsidian/workspace.json'), `{"n":${n}}\n`);
  } finally {
    await box.close();
  }
});

test('a note deleted on the computer is removed through a merge commit whose first parent is older', async () => {
  const box = await harness();
  try {
    await box.sync.runNow();
    const desktopBase = box.git.state.head;
    await box.edit('Notes/A.md', 'alpha\nphone\n');
    await box.sync.runNow();
    const phonePush = box.git.state.head;
    const desktop = box.git.commitOn(desktopBase, { 'Daily/2026-10-21.md': null });
    const merge = box.git.advance(box.git.mergeFiles(desktop, phonePush));
    assert.deepEqual(box.git.state.commits.get(merge).parents, [desktop, phonePush]);
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    assert.equal(await getFile(box.db, 'Daily/2026-10-21.md'), undefined);
    assert.equal((await getFile(box.db, 'Notes/A.md')).content, 'alpha\nphone\n');
  } finally {
    await box.close();
  }
});

test('a note only on the merge’s second parent is never deleted by a first-parent view', async () => {
  const box = await harness();
  try {
    await box.sync.runNow();
    const desktopBase = box.git.state.head;
    await box.edit('Notes/New.md', 'made on the phone\n');
    await box.sync.runNow();
    const phonePush = box.git.state.head;
    assert.equal(box.git.snapshot(phonePush).has('Notes/New.md'), true);
    const desktop = box.git.commitOn(desktopBase, { 'Notes/B.md': 'one\ntwo\nthree\ndesktop\n' });
    assert.equal(box.git.snapshot(desktop).has('Notes/New.md'), false);
    const merge = box.git.advance(box.git.mergeFiles(desktop, phonePush));
    const later = box.git.advance(box.git.commitOn(merge, { '.obsidian/workspace.json': '{}\n' }));
    assert.equal(box.git.snapshot(later).has('Notes/New.md'), true);
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const kept = await getFile(box.db, 'Notes/New.md');
    assert.equal(kept.content, 'made on the phone\n');
    assert.equal(kept.conflict, false);
    assert.equal((await getFile(box.db, 'Notes/B.md')).content, 'one\ntwo\nthree\ndesktop\n');
  } finally {
    await box.close();
  }
});

test('a delete after a long Obsidian history walks from the last synced head, not the note’s old pull', async () => {
  const box = await harness();
  try {
    await box.sync.runNow();
    const pulledAt = (await getFile(box.db, 'Daily/2026-10-21.md')).syncedCommit;
    let head = box.git.state.head;
    for (let i = 0; i < 240; i += 1) {
      const side = box.git.commitOn(head, { '.obsidian/workspace.json': `{"i":${i}}\n` });
      head = i % 3 === 0
        ? box.git.mergeFiles(box.git.commitOn(head, { 'Notes/B.md': `one\ntwo\nthree\n${i}\n` }), side)
        : side;
    }
    box.git.advance(head);
    await box.sync.runNow();
    assert.equal((await getFile(box.db, 'Daily/2026-10-21.md')).syncedCommit, pulledAt);
    box.git.advance(box.git.commitOn(head, { 'Daily/2026-10-21.md': null }));
    const reads = box.git.state.log.length;
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    assert.equal(await getFile(box.db, 'Daily/2026-10-21.md'), undefined);
    const commitReads = box.git.state.log.slice(reads).filter((item) => item.method === 'GET' && item.path.includes('/git/commits/'));
    assert.equal(commitReads.length <= 2, true, String(commitReads.length));
  } finally {
    await box.close();
  }
});

test('rewritten history that drops a note becomes a Conflict and keeps the phone text', async () => {
  const box = await harness();
  try {
    await box.sync.runNow();
    const files = vault();
    delete files['Daily/2026-10-21.md'];
    const rewritten = box.git.mergeCommit([], Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : v])), 'rewrite');
    box.git.advance(rewritten);
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.conflict);
    const kept = await getFile(box.db, 'Daily/2026-10-21.md');
    assert.equal(kept.content, 'day\n');
    assert.equal(kept.conflict, true);
    assert.equal(kept.conflictReason, 'deleted');
  } finally {
    await box.close();
  }
});

test('when GitHub cannot answer the ancestry question nothing is removed and the cursor stays put', async () => {
  const box = await harness();
  try {
    await box.sync.runNow();
    const cursorBefore = (await getMeta(box.db, 'githubSyncCursor')).headSha;
    const mid = box.git.commitOn(box.git.state.head, { 'Notes/B.md': 'one\n' });
    box.git.advance(box.git.commitOn(mid, { 'Daily/2026-10-21.md': null }));
    box.git.state.failCommitReads = true;
    const result = await box.sync.runNow();
    assert.notEqual(result.status, SYNC_STATUS.synced);
    assert.equal(box.history.includes(SYNC_STATUS.conflict), false);
    assert.equal((await getFile(box.db, 'Daily/2026-10-21.md')).content, 'day\n');
    assert.equal((await getMeta(box.db, 'githubSyncCursor')).headSha, cursorBefore);
    box.git.state.failCommitReads = false;
    const later = await box.sync.runNow('retry');
    assert.equal(later.status, SYNC_STATUS.synced);
    assert.equal(await getFile(box.db, 'Daily/2026-10-21.md'), undefined);
  } finally {
    await box.close();
  }
});

test('dot-folder notes left on the phone by older versions are never uploaded, deleted, or conflicted', async () => {
  const box = await harness();
  try {
    await box.sync.runNow();
    const trashSha = box.git.blobShaAt('.trash/Old.md');
    await putFile(box.db, {
      path: '.trash/Old.md', content: 'edited on an old phone\n', kind: 'markdown', encoding: 'utf-8', createdAt: 1, updatedAt: 1,
      trashedAt: null, baseSha: 'b-stale', remoteSha: 'b-stale', dirty: true, syncedCommit: 'c-old',
    });
    await putFile(box.db, {
      path: '.obsidian/snippets/note.md', content: 'local only\n', kind: 'markdown', encoding: 'utf-8', createdAt: 1, updatedAt: 1,
      trashedAt: null, dirty: true, origin: 'user',
    });
    await box.sync.noteEdited(await getFile(box.db, '.trash/Old.md'));
    await box.edit('Notes/A.md', 'alpha\nnormal edit\n');
    box.git.advance(box.git.commitOn(box.git.state.head, { '.trash/Old.md': null, '.obsidian/app.json': '{}\n' }));
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const head = box.git.state.head;
    assert.equal(box.git.snapshot(head).get('Notes/A.md'), 'alpha\nnormal edit\n');
    assert.equal(box.git.snapshot(head).has('.trash/Old.md'), false);
    assert.equal(box.git.snapshot(head).has('.obsidian/snippets/note.md'), false);
    assert.notEqual(trashSha, '');
    const posted = box.git.state.log.filter((item) => item.method === 'POST' && item.path.endsWith('/git/blobs'));
    assert.equal(posted.some((item) => String(item.body.content).includes('old phone') || String(item.body.content).includes('local only')), false);
    for (const write of treeWrites(box.git)) assert.equal(write.body.tree.some((entry) => isIgnoredPath(entry.path)), false);
    assert.equal((await getFile(box.db, '.trash/Old.md')).content, 'edited on an old phone\n');
    assert.equal((await getFile(box.db, '.obsidian/snippets/note.md')).content, 'local only\n');
    assert.equal((await listFiles(box.db)).some((file) => file.conflict || file.conflictCopy), false);
  } finally {
    await box.close();
  }
});

test('loading GitHub’s side times out with a retry message instead of hanging', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  try {
    await saveGithubSession(db, { token: TOKEN, login: 'octocat' });
    await saveGithubTarget(db, { repo: 'owner/repo', branch: 'main', root: '' });
    assert.equal(REMOTE_LOAD_TIMEOUT_MS, 15000);
    const file = { path: 'Notes/A.md', content: 'phone\n', kind: 'markdown', conflict: true };
    const signals = [];
    const abortable = (url, options = {}) => new Promise((resolve, reject) => {
      signals.push(options.signal);
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const started = Date.now();
    const timed = await loadConflictRemote({ db, file, fetchImpl: abortable, timeoutMs: 40 });
    assert.equal(Date.now() - started < 2000, true);
    assert.equal(timed.state, 'timeout');
    assert.match(timed.reason, /too long/);
    assert.match(timed.reason, /Try again/);
    assert.equal(timed.file, file);
    assert.equal(signals[0].aborted, true);
    const deaf = () => new Promise(() => {});
    const stuck = await loadConflictRemote({ db, file, fetchImpl: deaf, timeoutMs: 40 });
    assert.equal(stuck.state, 'timeout');
    const copy = await loadConflictRemote({ db, file, fetchImpl: deaf, timeoutMs: 40, sibling: { path: 'Notes/A (conflict 2026-10-20 1718).md', content: 'copy\n' } });
    assert.equal(copy.source, 'copy');
    assert.equal(copy.file.conflictRemote, 'copy\n');
    const offline = await loadConflictRemote({ db, file, fetchImpl: deaf, offline: () => true });
    assert.equal(offline.state, 'offline');
    assert.match(offline.reason, /isn't available offline/);
    for (const reason of [timed.reason, offline.reason]) assert.equal(reason.includes(TOKEN), false);
    const git = createFakeGit({ token: TOKEN, files: vault() });
    const seen = [];
    const spy = (url, options) => {
      seen.push(options.signal);
      return git.fetchImpl(url, options);
    };
    const controller = new AbortController();
    const fetched = await fetchRemoteBlob(spy, { token: TOKEN, repo: 'owner/repo', branch: 'main', root: '' }, 'Notes/A.md', { signal: controller.signal });
    assert.equal(fetched.text, 'alpha\n');
    assert.equal(seen.length, 4);
    assert.equal(seen.every((signal) => signal === controller.signal), true);
    assert.equal(await fetchRemoteBlob(spy, { token: TOKEN, repo: 'owner/repo', branch: 'main', root: '' }, '.trash/Old.md'), null);
  } finally {
    db.close();
    await deleteDatabase(name);
  }
});

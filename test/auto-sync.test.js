import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, getFile, getMeta, listFiles, listOps, openDatabase, putFile, saveLocalFile } from '../app/js/db.js';
import { encodeBytesBase64, encodeUtf8Base64 } from '../app/js/github-api.js';
import { cachedImage, rememberImage } from '../app/js/images.js';
import { saveGithubSession, saveGithubTarget } from '../app/js/github-store.js';
import {
  backoffDelay,
  conflictCopyPath,
  createAutoSync,
  createSyncClock,
  isAppGenerated,
  isLocalCopyName,
  loadConflictRemote,
  presentSyncStatus,
  RACE_RETRY_LIMIT,
  reconcileAttachments,
  reconcileNotes,
  reuseBinaryBlobSha,
  refReadPath,
  refUpdateBody,
  refUpdatePath,
  retryDelay,
  shouldAutoUpload,
  shouldRemoveLocal,
  SYNC_DEBOUNCE_MS,
  SYNC_POLL_MS,
  SYNC_STATUS,
  syncAlert,
  syncAlertFocus,
  syncAlertTone,
  ATTACHMENT_BYTES_MISSING,
} from '../app/js/github-sync.js';

const TOKEN = 'gho_testtokenvalue123456';

function note(path, content, extra = {}) {
  return {
    path,
    content,
    kind: 'markdown',
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 2,
    trashedAt: null,
    remoteSha: null,
    baseSha: null,
    dirty: false,
    conflict: false,
    ...extra,
  };
}

function attachment(path, extra = {}) {
  return {
    path,
    content: '',
    kind: 'binary',
    encoding: 'binary',
    bytes: extra.bytes || 0,
    createdAt: 1,
    updatedAt: 2,
    trashedAt: null,
    remoteSha: null,
    baseSha: null,
    dirty: false,
    conflict: false,
    ...extra,
  };
}

function json(status, body, headers = {}) {
  if (status === 304) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function gitServer() {
  const state = {
    head: 'commit-1',
    tree: 'tree-1',
    missing: false,
    wrongRef: false,
    rate: false,
    failPatch: false,
    moveOnSecondRef: false,
    files: new Map([['Field Notes.md', { sha: 'blob-1', text: 'Local line\n' }]]),
    blobs: new Map([['blob-1', 'Local line\n']]),
    parents: new Map(),
  };
  const log = [];
  let refReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    const text = String(url);
    if (text.includes(TOKEN)) throw new Error('token leaked into the url');
    const path = new URL(text).pathname;
    log.push({ method, url: text, body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} });
    if (path === '/user' && method === 'GET') {
      if (state.userStatus) return json(state.userStatus, { message: 'nope' });
      return json(200, { login: 'octocat' });
    }
    if (path === '/repos/owner/repo/git/ref/heads/main' && method === 'GET') {
      refReads += 1;
      if (state.missing) return json(404, { message: 'Not Found' });
      if (state.rate) {
        return json(403, { message: 'rate limit' }, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(state.rateReset || Math.floor(Date.now() / 1000) + 30),
        });
      }
      if (state.retryAfter) return json(429, { message: 'slow down' }, { 'retry-after': String(state.retryAfter) });
      const etag = `"${state.head}"`;
      const match = options.headers && options.headers['If-None-Match'];
      if (match && match === etag) return json(304, null, { etag });
      let sha = state.head;
      if (state.moveOnSecondRef && refReads === 2) sha = 'commit-moved';
      const ref = state.wrongRef ? 'refs/heads/other' : 'refs/heads/main';
      return json(200, { ref, object: { sha, type: 'commit' } }, { etag });
    }
    const commitRead = path.match(/^\/repos\/owner\/repo\/git\/commits\/([^/]+)$/);
    if (commitRead && method === 'GET') {
      const sha = decodeURIComponent(commitRead[1]);
      return json(200, {
        sha,
        tree: { sha: state.tree },
        parents: (state.parents.get(sha) || []).map((parent) => ({ sha: parent })),
        committer: { date: state.commitDate || '2026-10-21T00:00:00.000Z' },
      });
    }
    const treeRead = path.match(/^\/repos\/owner\/repo\/git\/trees\/([^/]+)$/);
    if (treeRead && method === 'GET') {
      return json(200, {
        sha: state.tree,
        truncated: Boolean(state.truncated),
        tree: [...state.files].map(([notePath, file]) => ({ path: notePath, mode: '100644', type: 'blob', sha: file.sha })),
      });
    }
    const blobRead = path.match(/^\/repos\/owner\/repo\/git\/blobs\/([^/]+)$/);
    if (blobRead && method === 'GET') {
      const sha = decodeURIComponent(blobRead[1]);
      const content = state.blobs.get(sha);
      if (content == null) return json(404, { message: 'Not Found' });
      return json(200, { sha, encoding: 'base64', content: encodeUtf8Base64(content) });
    }
    if (path === '/repos/owner/repo/git/blobs' && method === 'POST') {
      const sha = `blob-new-${state.blobs.size + 1}`;
      state.blobs.set(sha, options.body ? JSON.parse(options.body).content : '');
      return json(201, { sha });
    }
    if (path === '/repos/owner/repo/git/trees' && method === 'POST') {
      const body = JSON.parse(options.body);
      const tree = `tree-${state.blobs.size}`;
      const files = new Map(state.files);
      for (const entry of body.tree) {
        if (entry.sha == null) files.delete(entry.path);
        else files.set(entry.path, { sha: entry.sha, text: state.blobs.get(entry.sha) || '' });
      }
      state.pending = { tree, files };
      return json(201, { sha: tree });
    }
    if (path === '/repos/owner/repo/git/commits' && method === 'POST') {
      state.commits = (state.commits || 0) + 1;
      state.commit = `commit-${state.commits + 1}`;
      state.parents.set(state.commit, JSON.parse(options.body).parents || []);
      return json(201, { sha: state.commit, committer: { date: state.commitDate || '2026-10-21T12:00:00.000Z' } });
    }
    if (path === '/repos/owner/repo/git/refs/heads/main' && method === 'PATCH') {
      const body = JSON.parse(options.body);
      if (body.force !== false) return json(422, { message: 'force is not allowed' });
      if (state.holdPatch) {
        state.patchHeld = true;
        await state.holdPatch;
        state.patchHeld = false;
      }
      if (state.failPatch) return json(500, { message: 'no' });
      if (state.patchStatus) return json(state.patchStatus, { message: state.patchStatus === 404 ? 'Not Found' : 'rejected' });
      if (state.notForward) {
        const mode = state.notForward;
        if (!state.stickNotForward) state.notForward = null;
        state.pending = null;
        state.head = 'commit-moved';
        if (mode === 'conflict') {
          state.tree = 'tree-theirs';
          state.files.set('Field Notes.md', { sha: 'blob-theirs', text: 'Theirs\n' });
          state.blobs.set('blob-theirs', 'Theirs\n');
        }
        return json(422, { message: 'Update is not a fast forward' });
      }
      state.head = body.sha;
      if (state.pending) {
        state.tree = state.pending.tree;
        state.files = state.pending.files;
        state.pending = null;
      }
      return json(200, { ref: 'refs/heads/main', object: { sha: body.sha } });
    }
    return json(404, { message: 'Not Found' });
  };
  return { state, log, fetchImpl };
}

async function until(check, { tries = 80, ms = 10 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  throw new Error('timed out');
}

function timers() {
  const scheduled = [];
  return {
    scheduled,
    setTimer(fn, ms) {
      const id = { fn, ms, unref() {} };
      scheduled.push(id);
      return id;
    },
    clearTimer(id) {
      const index = scheduled.indexOf(id);
      if (index >= 0) scheduled.splice(index, 1);
    },
  };
}

async function harness(extra = {}) {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await saveGithubSession(db, { token: TOKEN, login: 'octocat' });
  await saveGithubTarget(db, { repo: 'owner/repo', branch: 'main', root: '' });
  const git = gitServer();
  const clock = timers();
  const history = [];
  const sleeps = [];
  let pulled = 0;
  const sync = createAutoSync({
    db,
    fetchImpl: git.fetchImpl,
    now: () => extra.now || 1_700_000_000_000,
    random: () => 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    async sleep(ms) {
      sleeps.push(ms);
    },
    offline: () => Boolean(extra.isOffline ? extra.isOffline() : extra.offline),
    onStatus(text) {
      history.push(text);
    },
    onPulled() {
      pulled += 1;
    },
    ...extra.sync,
  });
  return {
    db,
    git,
    clock,
    history,
    sleeps,
    sync,
    pulled: () => pulled,
    async close() {
      sync.stop();
      db.close();
      await deleteDatabase(name);
    },
  };
}

test('sync debounce is its own clock and batches one fire', () => {
  assert.equal(SYNC_DEBOUNCE_MS >= 2000 && SYNC_DEBOUNCE_MS <= 5000, true);
  assert.equal(SYNC_POLL_MS, 60_000);
  const fired = [];
  const pending = [];
  const clock = createSyncClock({
    debounceMs: 3000,
    pollMs: 60_000,
    setTimer(fn, ms) {
      const id = { fn, ms };
      pending.push(id);
      return id;
    },
    clearTimer(id) {
      const index = pending.indexOf(id);
      if (index >= 0) pending.splice(index, 1);
    },
    onDebounced() {
      fired.push('edit');
    },
    onPoll() {
      fired.push('poll');
    },
  });
  clock.edited();
  clock.edited();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ms, 3000);
  pending[0].fn();
  assert.deepEqual(fired, ['edit']);
  clock.start();
  assert.equal(pending.filter((item) => item.ms === 60_000).length, 1);
  clock.flush();
  assert.deepEqual(fired, ['edit', 'edit']);
});

test('backoff grows with jitter and rate limits wait out the reset', () => {
  assert.equal(backoffDelay(0, () => 0), 1000);
  assert.equal(backoffDelay(0, () => 1), 2000);
  assert.equal(backoffDelay(1, () => 0), 2000);
  assert.equal(backoffDelay(1, () => 1), 4000);
  assert.equal(backoffDelay(20, () => 1), 5 * 60 * 1000);
  const now = 1_700_000_000_000;
  assert.equal(retryDelay({
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now / 1000) + 30) },
    now,
  }), 30_000);
  assert.equal(retryDelay({ status: 429, headers: { 'retry-after': '12' }, now }), 12_000);
  assert.equal(retryDelay({ status: 403, headers: { 'x-ratelimit-remaining': '10' }, now }), 0);
  assert.equal(refUpdateBody('abc').force, false);
  assert.equal(refReadPath('main'), '/git/ref/heads/main');
  assert.equal(refUpdatePath('main'), '/git/refs/heads/main');
  assert.notEqual(refReadPath('main'), refUpdatePath('main'));
});

test('the note screen flags only conflicts, conflict copies, sign-in and failed syncs', () => {
  assert.equal(syncAlert({ configured: true, confirmed: true }), '');
  assert.equal(syncAlert({ configured: true, syncing: true }), '');
  assert.equal(syncAlert({ configured: true, pending: true }), '');
  assert.equal(syncAlert({ configured: true, offline: true }), '');
  assert.equal(syncAlert({ configured: false, conflict: true }), '');
  assert.equal(syncAlert({ configured: true, conflict: true, copies: 2 }), 'conflict');
  assert.equal(syncAlert({ configured: true, confirmed: true, copies: 1 }), 'copies');
  assert.equal(syncAlert({ configured: true, authRequired: true }), 'auth');
  assert.equal(syncAlert({ configured: true, failed: true }), 'failed');
  assert.equal(syncAlertTone(''), '');
  assert.equal(syncAlertTone(syncAlert({ configured: true, pending: true })), '');
  assert.equal(syncAlertTone(syncAlert({ configured: true, offline: true })), '');
  assert.equal(syncAlertTone('failed'), 'danger');
  assert.equal(syncAlertTone('auth'), 'danger');
  assert.equal(syncAlertTone('conflict'), 'attention');
  assert.equal(syncAlertTone('copies'), 'attention');
  assert.equal(syncAlertFocus('auth'), 'github');
  assert.equal(syncAlertFocus('failed'), 'sync');
  assert.equal(syncAlertFocus('conflict'), 'sync');
  assert.equal(syncAlertFocus('copies'), 'sync');
  assert.equal(syncAlertFocus(''), '');
});

test('status is never Synced before a confirmed write, and a conflict keeps both sides', () => {
  assert.equal(presentSyncStatus({ configured: true, confirmed: false }), SYNC_STATUS.syncing);
  assert.equal(presentSyncStatus({ configured: true, confirmed: true, pending: true }), SYNC_STATUS.pending);
  assert.equal(presentSyncStatus({ configured: true, confirmed: true, syncing: true }), SYNC_STATUS.syncing);
  assert.equal(presentSyncStatus({ configured: true, confirmed: true }), SYNC_STATUS.synced);
  assert.equal(presentSyncStatus({ configured: true, confirmed: true, copies: 1 }), 'Synced · 1 conflict copy');
  assert.equal(presentSyncStatus({ configured: true, confirmed: true, copies: 2 }), 'Synced · 2 conflict copies');
  assert.equal(presentSyncStatus({ configured: true, conflict: true, copies: 2 }), SYNC_STATUS.conflict);
  assert.notEqual(presentSyncStatus({ configured: true, pending: true }), SYNC_STATUS.synced);
  assert.equal(presentSyncStatus({ configured: false, confirmed: true }), '');

  const when = new Date('2026-10-21T19:18:00Z');
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}`;
  assert.equal(conflictCopyPath('Field Notes.md', when), `Field Notes (conflict ${stamp}).md`);
  const taken = new Set([`Field Notes (conflict ${stamp}).md`]);
  assert.equal(conflictCopyPath('Field Notes.md', when, taken), `Field Notes (conflict ${stamp}-2).md`);
  assert.equal(isLocalCopyName(`Field Notes (conflict ${stamp}).md`), true);
  assert.equal(isLocalCopyName('Field Notes (backup 2026-10-20 1718).md'), true);
  assert.equal(isLocalCopyName('Welcome.md'), false);
  assert.equal(isAppGenerated(note('Welcome.md', '# Welcome\n')), true);
  assert.equal(shouldAutoUpload(note('Welcome.md', '# Welcome\n')), false);
  assert.equal(shouldAutoUpload(note('Draft.md', 'new\n', { origin: 'user' })), true);
  assert.equal(shouldAutoUpload({
    path: 'assets/Site Log/shot.png',
    kind: 'binary',
    dirty: true,
    origin: 'user',
    trashedAt: null,
  }), true);
  assert.equal(shouldAutoUpload({
    path: 'assets/Site Log/shot.png',
    kind: 'binary',
    dirty: false,
    origin: '',
    trashedAt: null,
  }), false);
  assert.equal(reuseBinaryBlobSha({ path: 'assets/Field Log/shot.png', kind: 'binary' }, [
    { kind: 'rename', from: 'assets/Site Log/shot.png', to: 'assets/Field Log/shot.png', id: 'assets/Field Log/shot.png', baseSha: 'png-1' },
  ]), 'png-1');
  assert.equal(reuseBinaryBlobSha({ path: 'assets/Field Log/shot.png', kind: 'binary' }, [
    { kind: 'rename', from: 'assets/Site Log/shot.png', to: 'assets/Field Log/shot.png', id: 'assets/Field Log/shot.png' },
  ]), '');
  assert.equal(ATTACHMENT_BYTES_MISSING.includes('still on this device'), false);
  assert.equal(shouldRemoveLocal(note('Field Notes.md', 'x\n', { baseSha: 'a', remoteSha: 'a', updatedAt: 2 }), { headSha: 'c2', headDate: 10 }), false);
  assert.equal(shouldRemoveLocal(note('Field Notes.md', 'x\n', { baseSha: 'a', remoteSha: 'a', syncedCommit: 'c1', syncedAt: 1 }), { headSha: 'c1', headDate: 10 }), false);

  const local = note('Field Notes.md', 'mine\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' });
  const both = reconcileNotes([local], [{ localPath: 'Field Notes.md', repoPath: 'Field Notes.md', sha: 'blob-9' }]);
  assert.equal(both.pushes.length, 0);
  assert.equal(both.conflicts[0].reason, 'both');
  const gone = reconcileNotes([local], []);
  assert.equal(gone.conflicts[0].reason, 'deleted');
  const safe = reconcileNotes([local], [{ localPath: 'Field Notes.md', repoPath: 'Field Notes.md', sha: 'blob-1' }]);
  assert.equal(safe.pushes.length, 1);
  assert.equal(safe.conflicts.length, 0);
});

test('a batch push checks the remote head first and confirms the ref before Synced', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Field Notes.md', 'one\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    await putFile(box.db, note('Other.md', 'two\n', { dirty: true }));
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const posts = box.git.log.filter((item) => item.method === 'POST' || item.method === 'PATCH');
    const refs = box.git.log.filter((item) => new URL(item.url).pathname === '/repos/owner/repo/git/ref/heads/main');
    assert.equal(refs.length >= 2, true);
    assert.ok(box.git.log.indexOf(refs[1]) < box.git.log.indexOf(posts[0]));
    assert.deepEqual(posts.map((item) => `${item.method} ${new URL(item.url).pathname}`), [
      'POST /repos/owner/repo/git/blobs',
      'POST /repos/owner/repo/git/blobs',
      'POST /repos/owner/repo/git/trees',
      'POST /repos/owner/repo/git/commits',
      'PATCH /repos/owner/repo/git/refs/heads/main',
    ]);
    const commit = posts.find((item) => item.url.endsWith('/git/commits'));
    assert.deepEqual(commit.body.parents, ['commit-1']);
    assert.equal(commit.body.message.includes(TOKEN), false);
    const patch = posts.find((item) => item.method === 'PATCH');
    assert.equal(patch.body.force, false);
    assert.equal(patch.body.sha, 'commit-2');
    assert.equal(box.git.state.head, 'commit-2');
    const saved = await getFile(box.db, 'Field Notes.md');
    assert.equal(saved.dirty, false);
    assert.equal(saved.baseSha, saved.remoteSha);
    assert.equal((await listOps(box.db)).length, 0);
    const syncedAt = box.history.indexOf(SYNC_STATUS.synced);
    assert.equal(syncedAt, box.history.length - 1);
    assert.equal(box.history.includes(SYNC_STATUS.syncing), true);
  } finally {
    await box.close();
  }
});

test('a head that moves before the write is read again and never written on', async () => {
  const box = await harness();
  try {
    box.git.state.moveOnSecondRef = true;
    await putFile(box.db, note('Field Notes.md', 'changed\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const moved = box.git.log.findIndex((item) => item.method === 'GET' && item.url.endsWith('/git/ref/heads/main') && box.git.log.indexOf(item) > 0);
    const firstWrite = box.git.log.findIndex((item) => item.method === 'POST');
    assert.equal(firstWrite > moved, true);
    const commits = box.git.log.filter((item) => item.method === 'POST' && item.url.endsWith('/git/commits'));
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].body.parents, ['commit-1']);
    assert.deepEqual(box.sleeps.length, 1);
    const saved = await getFile(box.db, 'Field Notes.md');
    assert.equal(saved.content, 'changed\n');
    assert.equal(saved.dirty, false);
    assert.equal(box.history.includes(SYNC_STATUS.failed), false);
    assert.equal(box.history.includes(SYNC_STATUS.conflict), false);
  } finally {
    await box.close();
  }
});

test('a failed push keeps the note and the operation across a reopened database', async () => {
  const box = await harness();
  const name = box.db.name;
  try {
    box.git.state.failPatch = true;
    await putFile(box.db, note('Field Notes.md', 'keep me\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    const result = await box.sync.runNow();
    assert.notEqual(result.status, SYNC_STATUS.synced);
    assert.equal(box.history.includes(SYNC_STATUS.synced), false);
    assert.equal(box.git.state.head, 'commit-1');
    const saved = await getFile(box.db, 'Field Notes.md');
    assert.equal(saved.content, 'keep me\n');
    assert.equal(saved.dirty, true);
    const ops = await listOps(box.db);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].path, 'Field Notes.md');
    assert.equal((await getMeta(box.db, 'githubToken')), TOKEN);
    box.db.close();
    const again = await openDatabase(name);
    const reopened = await getFile(again, 'Field Notes.md');
    assert.equal(reopened.content, 'keep me\n');
    assert.equal((await listOps(again)).length, 1);
    assert.equal((await getMeta(again, 'githubToken')), TOKEN);
    again.close();
  } finally {
    await deleteDatabase(name);
  }
});

test('a rate limit waits and does not sign out', async () => {
  const box = await harness();
  try {
    box.git.state.rate = true;
    box.git.state.rateReset = 1_700_000_000 + 30;
    await putFile(box.db, note('Field Notes.md', 'later\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.pending);
    assert.equal(box.history.includes(SYNC_STATUS.synced), false);
    assert.equal(box.clock.scheduled.some((item) => item.ms === 30_000), true);
    assert.equal((await getMeta(box.db, 'githubToken')), TOKEN);
    const op = (await listOps(box.db))[0];
    assert.equal(op.attempts, 1);
    assert.ok(op.nextAttemptAt > 1_700_000_000_000);
  } finally {
    await box.close();
  }
});

test('only a 401 from GET /user requires authentication, and a missing branch stops', async () => {
  const denied = await harness();
  try {
    denied.git.state.userStatus = 401;
    const first = denied.git.fetchImpl;
    denied.git.fetchImpl = async (url, options) => {
      if (String(url).includes('/git/ref/')) return json(401, { message: 'Bad credentials' });
      return first(url, options);
    };
    const sync = createAutoSync({
      db: denied.db,
      fetchImpl: denied.git.fetchImpl,
      setTimer: denied.clock.setTimer,
      clearTimer: denied.clock.clearTimer,
      random: () => 0,
    });
    const result = await sync.runNow();
    assert.equal(result.status, SYNC_STATUS.auth);
    assert.equal((await getMeta(denied.db, 'githubToken')), TOKEN);
    sync.stop();
  } finally {
    await denied.close();
  }

  const other = await harness();
  try {
    const first = other.git.fetchImpl;
    other.git.fetchImpl = async (url, options) => {
      if (String(url).includes('/git/ref/')) return json(401, { message: 'Bad credentials' });
      if (String(url).endsWith('/user')) return json(200, { login: 'octocat' });
      return first(url, options);
    };
    const sync = createAutoSync({
      db: other.db,
      fetchImpl: other.git.fetchImpl,
      setTimer: other.clock.setTimer,
      clearTimer: other.clock.clearTimer,
    });
    const result = await sync.runNow();
    assert.equal(result.status, SYNC_STATUS.failed);
    assert.notEqual(result.status, SYNC_STATUS.auth);
    assert.equal((await getMeta(other.db, 'githubToken')), TOKEN);
    sync.stop();
  } finally {
    await other.close();
  }

  const missing = await harness();
  try {
    missing.git.state.missing = true;
    const result = await missing.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.failed);
    assert.equal(missing.git.log.some((item) => item.method === 'POST' || item.method === 'PATCH'), false);
    missing.git.state.missing = false;
    missing.git.state.wrongRef = true;
    const wrong = await missing.sync.runNow();
    assert.equal(wrong.status, SYNC_STATUS.failed);
    assert.equal(missing.git.log.some((item) => item.method === 'POST'), false);
  } finally {
    await missing.close();
  }
});

test('a remote change is pulled, and a conflict keeps both copies', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Field Notes.md', 'Local line\n', { remoteSha: 'blob-1', baseSha: 'blob-1' }));
    const clean = await box.sync.runNow();
    assert.equal(clean.status, SYNC_STATUS.synced);
    box.git.state.head = 'commit-9';
    box.git.state.tree = 'tree-9';
    box.git.state.files.set('Field Notes.md', { sha: 'blob-9', text: 'From GitHub\n' });
    box.git.state.blobs.set('blob-9', 'From GitHub\n');
    const pulled = await box.sync.runNow();
    assert.equal(pulled.status, SYNC_STATUS.synced);
    assert.equal(box.pulled() > 0, true);
    assert.equal((await getFile(box.db, 'Field Notes.md')).content, 'From GitHub\n');

    const dirty = await getFile(box.db, 'Field Notes.md');
    await putFile(box.db, { ...dirty, content: 'Mine\n', dirty: true });
    box.git.state.files.set('Field Notes.md', { sha: 'blob-8', text: 'Theirs\n' });
    box.git.state.blobs.set('blob-8', 'Theirs\n');
    box.git.state.head = 'commit-8';
    const conflict = await box.sync.runNow();
    assert.equal(conflict.status, SYNC_STATUS.conflict);
    assert.equal(box.git.log.some((item) => item.method === 'PATCH'), false);
    const local = await getFile(box.db, 'Field Notes.md');
    assert.equal(local.content, 'Mine\n');
    assert.equal(local.conflict, true);
    const files = await listFiles(box.db);
    const sibling = files.find((file) => file.conflictCopy);
    assert.ok(sibling);
    assert.equal(sibling.content, 'Theirs\n');
    assert.equal(sibling.dirty, false);
    assert.equal((await listOps(box.db)).some((op) => op.path === 'Field Notes.md'), true);
  } finally {
    await box.close();
  }
});

test('a singular ref update is a 404, and a failed update is not written again', async () => {
  const git = gitServer();
  const base = 'https://api.github.com/repos/owner/repo';
  const rejected = [
    ['PATCH', `${base}/git/ref/heads/main`],
    ['POST', `${base}/git/ref/heads/main`],
    ['GET', `${base}/git/refs/heads/main`],
    ['POST', `${base}/git/refs`],
    ['DELETE', `${base}/git/refs/heads/main`],
    ['GET', `${base}/git/blobs`],
    ['PATCH', `${base}/git/blobs`],
    ['POST', `${base}/git/blobs/blob-1`],
    ['GET', `${base}/git/commits`],
    ['PATCH', `${base}/git/commits/commit-1`],
    ['GET', `${base}/git/trees`],
    ['PATCH', `${base}/git/trees`],
    ['GET', `${base}/compare/main...main`],
    ['PUT', `${base}/contents/Field%20Notes.md`],
  ];
  for (const [method, url] of rejected) {
    const response = await git.fetchImpl(url, { method, body: method === 'GET' ? undefined : '{}' });
    assert.equal(response.status, 404, `${method} ${url}`);
  }

  const box = await harness();
  try {
    box.git.state.patchStatus = 404;
    await putFile(box.db, note('Field Notes.md', 'keep me\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    const first = await box.sync.runNow();
    assert.equal(first.status, SYNC_STATUS.failed);
    assert.equal(first.detail, 'Not Found');
    assert.equal(box.history.includes(SYNC_STATUS.synced), false);
    const created = box.git.log.filter((item) => item.method === 'POST' && item.url.endsWith('/git/commits')).length;
    assert.equal(created, 1);
    const again = await box.sync.runNow();
    assert.equal(again.status, SYNC_STATUS.failed);
    assert.equal(box.git.log.filter((item) => item.method === 'POST' && item.url.endsWith('/git/commits')).length, created);
    assert.equal(box.git.log.filter((item) => item.method === 'POST' && item.url.endsWith('/git/blobs')).length, 1);
    assert.equal(box.git.log.filter((item) => item.method === 'POST' && item.url.endsWith('/git/trees')).length, 1);
    const patches = box.git.log.filter((item) => item.method === 'PATCH');
    assert.equal(patches.length, 2);
    assert.equal(patches.every((item) => new URL(item.url).pathname === '/repos/owner/repo/git/refs/heads/main'), true);
    assert.equal((await getFile(box.db, 'Field Notes.md')).content, 'keep me\n');
    assert.equal((await listOps(box.db)).length, 1);
  } finally {
    await box.close();
  }
});

test('a 422 ref update reads the branch again and recommits when the note is unchanged', async () => {
  const box = await harness();
  try {
    box.git.state.notForward = 'recommit';
    await putFile(box.db, note('Field Notes.md', 'from the phone\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const commits = box.git.log.filter((item) => item.method === 'POST' && item.url.endsWith('/git/commits'));
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0].body.parents, ['commit-1']);
    assert.deepEqual(commits[1].body.parents, ['commit-moved']);
    const patches = box.git.log.filter((item) => item.method === 'PATCH');
    assert.equal(patches.length, 2);
    assert.equal(patches.every((item) => item.body.force === false), true);
    assert.equal(box.git.state.head, patches[1].body.sha);
    assert.equal((await getFile(box.db, 'Field Notes.md')).dirty, false);
    assert.equal(box.git.log.some((item) => item.method === 'POST' && new URL(item.url).pathname === '/repos/owner/repo/git/refs'), false);
  } finally {
    await box.close();
  }
});

test('a 422 ref update keeps both copies when the remote note changed', async () => {
  const box = await harness();
  try {
    box.git.state.notForward = 'conflict';
    await putFile(box.db, note('Field Notes.md', 'mine\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.conflict);
    assert.equal(box.history.includes(SYNC_STATUS.synced), false);
    const local = await getFile(box.db, 'Field Notes.md');
    assert.equal(local.content, 'mine\n');
    assert.equal(local.conflict, true);
    const sibling = (await listFiles(box.db)).find((file) => file.conflictCopy);
    assert.ok(sibling);
    assert.equal(sibling.content, 'Theirs\n');
    const patches = box.git.log.filter((item) => item.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].body.force, false);
    assert.equal(box.git.state.head, 'commit-moved');
  } finally {
    await box.close();
  }
});

test('offline keeps the queue and does not call GitHub', async () => {
  const box = await harness({ offline: true });
  try {
    await putFile(box.db, note('Field Notes.md', 'queued\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    await box.sync.noteEdited(note('Field Notes.md', 'queued\n', { dirty: true }));
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.offline);
    assert.equal(box.git.log.length, 0);
    assert.equal((await getFile(box.db, 'Field Notes.md')).content, 'queued\n');
    assert.equal((await listOps(box.db)).length, 1);
  } finally {
    await box.close();
  }
});

test('a delete is one commit with a null blob sha, and it survives a relaunch', async () => {
  const box = await harness();
  const name = box.db.name;
  try {
    await putFile(box.db, note('Field Notes.md', 'Local line\n', { baseSha: 'blob-1', remoteSha: 'blob-1', trashedAt: 9 }));
    await box.sync.noteTrashed({ file: { path: 'Field Notes.md' }, baseSha: 'blob-1' });
    box.sync.stop();
    box.db.close();
    const db = await openDatabase(name);
    const clock = timers();
    const sync = createAutoSync({
      db,
      fetchImpl: box.git.fetchImpl,
      now: () => 1_700_000_000_000,
      random: () => 0,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const result = await sync.runNow();
    sync.stop();
    assert.equal(result.status, SYNC_STATUS.synced);
    const tree = box.git.log.find((item) => item.method === 'POST' && item.url.endsWith('/git/trees'));
    assert.equal(tree.body.tree.some((entry) => entry.path === 'Field Notes.md' && entry.sha === null), true);
    assert.equal(box.git.state.files.has('Field Notes.md'), false);
    const patches = box.git.log.filter((item) => item.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.equal(new URL(patches[0].url).pathname, '/repos/owner/repo/git/refs/heads/main');
    assert.equal(patches[0].body.force, false);
    assert.equal((await listOps(db)).length, 0);
    db.close();
  } finally {
    await deleteDatabase(name);
  }
});

test('a delete is not sent when the remote note changed or the note was never synced', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Field Notes.md', 'phone\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1', trashedAt: 9 }));
    box.git.state.files.set('Field Notes.md', { sha: 'blob-9', text: 'theirs\n' });
    box.git.state.blobs.set('blob-9', 'theirs\n');
    await box.sync.noteTrashed({ file: { path: 'Field Notes.md' }, baseSha: 'blob-1' });
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.conflict);
    assert.equal(box.git.state.files.has('Field Notes.md'), true);
    assert.equal(box.git.log.some((item) => item.method === 'PATCH'), false);
    const local = await getFile(box.db, 'Field Notes.md');
    assert.equal(local.content, 'phone\n');
    assert.equal(local.trashedAt, null);
    assert.equal(local.conflictReason, 'delete');
    const tree = box.git.log.find((item) => item.method === 'POST' && item.url.endsWith('/git/trees'));
    assert.equal(tree, undefined);

    await box.sync.noteTrashed({ file: { path: 'Fresh.md' }, baseSha: '' });
    assert.equal((await listOps(box.db)).some((op) => op.kind === 'delete' && op.path === 'Fresh.md'), false);
  } finally {
    await box.close();
  }
});

test('a rename deletes the old path in the same commit as the new note', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Logs.md', 'See [[Field Notes]]\n', { baseSha: 'blob-1', remoteSha: 'blob-1' }));
    box.git.state.files.set('Logs.md', { sha: 'blob-1', text: 'See [[Field Notes]]\n' });
    box.git.state.files.delete('Field Notes.md');
    await putFile(box.db, note('Journal.md', 'See [[Journal]]\n', { dirty: true }));
    await box.sync.noteRenamed({
      from: 'Logs.md',
      to: 'Journal.md',
      baseSha: 'blob-1',
      file: note('Journal.md', 'See [[Journal]]\n', { dirty: true }),
    });
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const tree = box.git.log.find((item) => item.method === 'POST' && item.url.endsWith('/git/trees'));
    assert.equal(tree.body.tree.some((entry) => entry.path === 'Logs.md' && entry.sha === null), true);
    assert.equal(tree.body.tree.some((entry) => entry.path === 'Journal.md' && entry.sha), true);
    assert.equal(box.git.state.files.has('Logs.md'), false);
    assert.equal(box.git.state.files.get('Journal.md').text, 'See [[Journal]]\n');
    const commit = box.git.log.find((item) => item.method === 'POST' && item.url.endsWith('/git/commits'));
    assert.equal(commit.body.parents[0], 'commit-1');
    assert.equal(commit.body.message.includes('gho_'), false);
  } finally {
    await box.close();
  }
});

test('a rename does not delete the old path when GitHub changed it', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Journal.md', 'phone\n', { dirty: true }));
    box.git.state.files.set('Field Notes.md', { sha: 'blob-9', text: 'remote edit\n' });
    box.git.state.blobs.set('blob-9', 'remote edit\n');
    await box.sync.noteRenamed({
      from: 'Field Notes.md',
      to: 'Journal.md',
      baseSha: 'blob-1',
      file: note('Journal.md', 'phone\n', { dirty: true }),
    });
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.conflict);
    assert.equal(box.git.state.files.get('Field Notes.md').text, 'remote edit\n');
    assert.equal(box.git.log.some((item) => item.body && item.body.tree && item.body.tree.some((entry) => entry.sha === null)), false);
    const oldLocal = await getFile(box.db, 'Field Notes.md');
    assert.equal(oldLocal.content, 'remote edit\n');
    assert.equal(oldLocal.dirty, false);
    const renamed = await getFile(box.db, 'Journal.md');
    assert.equal(renamed.content, 'phone\n');
    assert.equal(renamed.conflictReason, 'rename');
  } finally {
    await box.close();
  }
});

test('a user-created note uploads, Welcome and copies do not, and a clean GitHub delete is removed locally', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Welcome.md', '# Welcome\n'));
    await putFile(box.db, note('Draft.md', 'new\n', { dirty: true, origin: 'user' }));
    await putFile(box.db, note('Field Notes.md', 'Local line\n', { baseSha: 'blob-1', remoteSha: 'blob-1', syncedAt: 1, syncedCommit: 'commit-old' }));
    const created = await box.sync.runNow();
    assert.equal(created.status, SYNC_STATUS.synced);
    assert.equal(box.git.state.files.has('Welcome.md'), false);
    assert.equal((await getFile(box.db, 'Welcome.md')).remoteSha, null);
    assert.equal(box.git.state.files.get('Draft.md').text, 'new\n');
    const draft = await getFile(box.db, 'Draft.md');
    assert.equal(draft.dirty, false);
    assert.ok(draft.baseSha);

    box.git.state.parents.set('commit-1', ['commit-old']);
    box.git.state.parents.set('commit-deleted', [box.git.state.head]);
    box.git.state.files.delete('Field Notes.md');
    box.git.state.head = 'commit-deleted';
    box.git.state.commitDate = '2026-10-21T12:00:00.000Z';
    const removed = await box.sync.runNow();
    assert.equal(removed.status, SYNC_STATUS.synced);
    assert.equal(await getFile(box.db, 'Field Notes.md'), undefined);

    await putFile(box.db, note('Field Notes.md', 'still editing\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    const conflict = await box.sync.runNow();
    assert.equal(conflict.status, SYNC_STATUS.conflict);
    const kept = await getFile(box.db, 'Field Notes.md');
    assert.equal(kept.content, 'still editing\n');
    assert.equal(kept.conflictReason, 'deleted');
  } finally {
    await box.close();
  }
});

test('non-overlapping edits auto-merge into one push', async () => {
  const box = await harness();
  try {
    box.git.state.blobs.set('blob-1', 'a\nb\n');
    box.git.state.files.set('Field Notes.md', { sha: 'blob-9', text: 'a\nB\n' });
    box.git.state.blobs.set('blob-9', 'a\nB\n');
    await putFile(box.db, note('Field Notes.md', 'A\nb\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const saved = await getFile(box.db, 'Field Notes.md');
    assert.equal(saved.content, 'A\nB\n');
    assert.equal(saved.conflict, false);
    assert.equal(box.git.state.files.get('Field Notes.md').text, 'A\nB\n');
  } finally {
    await box.close();
  }
});

test('a ref update that keeps losing the race stays pending with bounded backoff, never a conflict', async () => {
  const box = await harness();
  try {
    box.git.state.notForward = 'recommit';
    box.git.state.stickNotForward = true;
    await putFile(box.db, note('Field Notes.md', 'from the phone\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.pending);
    assert.equal(box.history.includes(SYNC_STATUS.conflict), false);
    assert.equal(box.history.includes(SYNC_STATUS.failed), false);
    const patches = box.git.log.filter((item) => item.method === 'PATCH');
    assert.equal(patches.length, RACE_RETRY_LIMIT + 1);
    assert.equal(patches.every((item) => item.body.force === false), true);
    assert.equal(box.sleeps.length, RACE_RETRY_LIMIT);
    for (let i = 1; i < box.sleeps.length; i += 1) assert.equal(box.sleeps[i] > box.sleeps[i - 1], true);
    assert.equal(box.sleeps.every((ms) => ms <= 4000), true);
    assert.equal(box.clock.scheduled.some((item) => item.ms > 0 && item.ms !== SYNC_POLL_MS), true);
    const saved = await getFile(box.db, 'Field Notes.md');
    assert.equal(saved.content, 'from the phone\n');
    assert.equal(saved.dirty, true);
    assert.equal(saved.conflict, false);
    assert.equal((await listFiles(box.db)).some((file) => file.conflictCopy), false);
    assert.equal((await listOps(box.db)).length, 1);
  } finally {
    await box.close();
  }
});

test('a v24 profile does not upload Welcome or leftover copies until an explicit resolve', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Welcome.md', '# Welcome\n'));
    await putFile(box.db, note('Field Notes.md', 'mine\n', {
      dirty: true,
      conflict: true,
      conflictReason: 'both',
      conflictAt: 1,
      conflictRemote: 'theirs\n',
      conflictRemoteSha: 'blob-9',
      conflictBase: 'Local line\n',
      baseSha: 'blob-1',
      remoteSha: 'blob-1',
    }));
    await putFile(box.db, note('Field Notes (conflict 2026-10-20 1718).md', 'theirs\n', { conflictCopy: true }));
    await putFile(box.db, note('Logs (conflict 2026-10-20 1718).md', 'orphan\n'));
    box.git.state.files.set('Field Notes.md', { sha: 'blob-9', text: 'theirs\n' });
    box.git.state.blobs.set('blob-9', 'theirs\n');
    const first = await box.sync.runNow();
    assert.equal(first.status, SYNC_STATUS.conflict);
    assert.equal(box.git.log.some((item) => item.method === 'POST' || item.method === 'PATCH'), false);
    assert.equal(box.git.state.files.has('Welcome.md'), false);
    assert.equal(box.git.state.files.has('Field Notes (conflict 2026-10-20 1718).md'), false);
    assert.equal(box.git.state.files.has('Logs (conflict 2026-10-20 1718).md'), false);

    const resolved = note('Field Notes.md', 'resolved\n', {
      dirty: true,
      origin: 'user',
      baseSha: 'blob-9',
      remoteSha: 'blob-1',
    });
    await putFile(box.db, resolved);
    await box.sync.noteEdited(resolved);
    const after = await box.sync.runNow('resolve');
    assert.equal(after.status, 'Synced · 1 conflict copy');
    const writes = box.git.log.filter((item) => item.method === 'POST' || item.method === 'PATCH');
    assert.deepEqual(writes.map((item) => `${item.method} ${new URL(item.url).pathname}`), [
      'POST /repos/owner/repo/git/blobs',
      'POST /repos/owner/repo/git/trees',
      'POST /repos/owner/repo/git/commits',
      'PATCH /repos/owner/repo/git/refs/heads/main',
    ]);
    const tree = writes.find((item) => item.url.endsWith('/git/trees'));
    assert.equal(tree.body.tree.some((entry) => entry.path === 'Field Notes.md'), true);
    assert.equal(tree.body.tree.some((entry) => String(entry.path).includes('Welcome') || String(entry.path).includes('(conflict ')), false);
    assert.equal((await getFile(box.db, 'Welcome.md')).remoteSha, null);
    assert.equal(after.copies >= 1, true);
  } finally {
    await box.close();
  }
});

test('restoring a note after its delete has synced uploads it again', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Field Notes.md', 'Local line\n', { baseSha: 'blob-1', remoteSha: 'blob-1', trashedAt: 9 }));
    await box.sync.noteTrashed({ file: { path: 'Field Notes.md' }, baseSha: 'blob-1' });
    const deleted = await box.sync.runNow();
    assert.equal(deleted.status, SYNC_STATUS.synced);
    assert.equal(box.git.state.files.has('Field Notes.md'), false);
    const trashed = await getFile(box.db, 'Field Notes.md');
    assert.equal(trashed.trashedAt, 9);
    assert.equal(trashed.baseSha, null);

    const restored = { ...trashed, trashedAt: null };
    await putFile(box.db, restored);
    await box.sync.noteRestored(restored);
    const queued = await getFile(box.db, 'Field Notes.md');
    assert.equal(queued.dirty, true);
    assert.equal(queued.origin, 'user');
    assert.equal(queued.baseSha, null);
    const uploaded = await box.sync.runNow();
    assert.equal(uploaded.status, SYNC_STATUS.synced);
    assert.equal(box.git.state.files.get('Field Notes.md').text, 'Local line\n');
  } finally {
    await box.close();
  }
});

test('a queued delete is cancelled on restore and the base is kept', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Field Notes.md', 'Local line\n', { baseSha: 'blob-1', remoteSha: 'blob-1' }));
    await box.sync.noteTrashed({ file: { path: 'Field Notes.md' }, baseSha: 'blob-1' });
    assert.equal((await listOps(box.db)).some((op) => op.kind === 'delete'), true);
    await putFile(box.db, note('Field Notes.md', 'Local line\n', { baseSha: 'blob-1', remoteSha: 'blob-1' }));
    await box.sync.noteRestored(note('Field Notes.md', 'Local line\n', { baseSha: 'blob-1', remoteSha: 'blob-1' }));
    assert.equal((await listOps(box.db)).some((op) => op.kind === 'delete'), false);
    const saved = await getFile(box.db, 'Field Notes.md');
    assert.equal(saved.baseSha, 'blob-1');
    assert.equal(saved.dirty, false);
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    assert.equal(box.git.state.files.has('Field Notes.md'), true);
    assert.equal(box.git.log.some((item) => item.method === 'POST' && item.url.endsWith('/git/trees')), false);
  } finally {
    await box.close();
  }
});

test('a local note is not removed unless the base matches and the remote tree is newer', async () => {
  const sameHead = await harness();
  try {
    await putFile(sameHead.db, note('Field Notes.md', 'Local line\n', {
      baseSha: 'blob-1',
      remoteSha: 'blob-1',
      syncedAt: 1,
      syncedCommit: 'commit-1',
    }));
    sameHead.git.state.files.delete('Field Notes.md');
    const kept = await sameHead.sync.runNow();
    assert.equal(kept.status, SYNC_STATUS.synced);
    assert.ok(await getFile(sameHead.db, 'Field Notes.md'));
  } finally {
    await sameHead.close();
  }

  const mismatch = await harness();
  try {
    await putFile(mismatch.db, note('Field Notes.md', 'Local line\n', {
      baseSha: 'blob-1',
      remoteSha: 'blob-other',
      syncedAt: 1,
      syncedCommit: 'commit-old',
    }));
    mismatch.git.state.files.delete('Field Notes.md');
    mismatch.git.state.head = 'commit-deleted';
    const kept = await mismatch.sync.runNow();
    assert.equal(await getFile(mismatch.db, 'Field Notes.md') !== undefined, true);
    assert.notEqual(kept.status, undefined);
  } finally {
    await mismatch.close();
  }
});

test('a GitHub delete from a slow-clock computer is removed by ancestry, not by date', async () => {
  const box = await harness({ now: Date.parse('2026-10-22T09:00:00.000Z') });
  try {
    await putFile(box.db, note('Field Notes.md', 'Local line\n', {
      baseSha: 'blob-1',
      remoteSha: 'blob-1',
      syncedAt: Date.parse('2026-10-22T08:00:00.000Z'),
      syncedCommit: 'commit-1',
    }));
    const first = await box.sync.runNow();
    assert.equal(first.status, SYNC_STATUS.synced);
    box.git.state.parents.set('commit-slow', ['commit-1']);
    box.git.state.files.delete('Field Notes.md');
    box.git.state.head = 'commit-slow';
    box.git.state.tree = 'tree-slow';
    box.git.state.commitDate = '2020-01-01T00:00:00.000Z';
    const removed = await box.sync.runNow();
    assert.equal(removed.status, SYNC_STATUS.synced);
    assert.equal(await getFile(box.db, 'Field Notes.md'), undefined);
    const walked = box.git.log.filter((item) => item.method === 'GET' && /\/git\/commits\/commit-slow$/.test(new URL(item.url).pathname));
    assert.equal(walked.length >= 1, true);
    assert.equal(box.git.log.some((item) => new URL(item.url).pathname.includes('/compare/')), false);
  } finally {
    await box.close();
  }
});

test('a GitHub delete on a head that does not descend from the base becomes a conflict', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Field Notes.md', 'Local line\n', {
      baseSha: 'blob-1',
      remoteSha: 'blob-1',
      syncedAt: 1,
      syncedCommit: 'commit-1',
    }));
    box.git.state.parents.set('commit-rewritten', ['commit-unrelated']);
    box.git.state.files.delete('Field Notes.md');
    box.git.state.head = 'commit-rewritten';
    box.git.state.commitDate = '2030-01-01T00:00:00.000Z';
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.conflict);
    const kept = await getFile(box.db, 'Field Notes.md');
    assert.equal(kept.content, 'Local line\n');
    assert.equal(kept.conflictReason, 'deleted');
    assert.equal(box.git.log.some((item) => item.method === 'PATCH'), false);
  } finally {
    await box.close();
  }
});

test('a new conflict records the path of its own copy', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Notes/Beta.md', 'phone\n', { dirty: true, baseSha: 'blob-b0', remoteSha: 'blob-b0' }));
    box.git.state.files.set('Notes/Beta.md', { sha: 'blob-b9', text: 'github\n' });
    box.git.state.blobs.set('blob-b9', 'github\n');
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.conflict);
    const marked = await getFile(box.db, 'Notes/Beta.md');
    const copy = (await listFiles(box.db)).find((file) => file.conflictCopy);
    assert.equal(marked.conflictCopyPath, copy.path);
    assert.equal(copy.path.startsWith('Notes/Beta (conflict '), true);
    assert.equal(marked.conflictRemote, 'github\n');
  } finally {
    await box.close();
  }
});

test('a legacy conflict loads GitHub text by its own path online and its exact copy offline', async () => {
  const box = await harness();
  try {
    box.git.state.files.set('Notes/sL1.md', { sha: 'blob-s1', text: 'github one\n' });
    box.git.state.files.set('Notes/sL2.md', { sha: 'blob-s2', text: 'github two\n' });
    box.git.state.blobs.set('blob-s1', 'github one\n');
    box.git.state.blobs.set('blob-s2', 'github two\n');
    const legacy = note('Notes/sL2.md', 'phone two\n', { dirty: true, conflict: true });
    const online = await loadConflictRemote({
      db: box.db,
      file: legacy,
      sibling: note('Notes/sL2 (conflict 2026-10-20 1718).md', 'older copy\n', { conflictCopy: true }),
      fetchImpl: box.git.fetchImpl,
    });
    assert.equal(online.source, 'github');
    assert.equal(online.file.conflictRemote, 'github two\n');
    assert.equal(online.file.conflictRemoteSha, 'blob-s2');
    const reads = box.git.log.filter((item) => item.method !== 'GET');
    assert.deepEqual(reads, []);
    assert.equal(box.git.log.every((item) => item.headers.Authorization === `Bearer ${TOKEN}`), true);
    assert.equal(box.git.log.some((item) => item.url.includes(TOKEN)), false);

    const offline = await loadConflictRemote({
      db: box.db,
      file: legacy,
      sibling: note('Notes/sL2 (conflict 2026-10-20 1718).md', 'github two from copy\n', { conflictCopy: true }),
      fetchImpl: box.git.fetchImpl,
      offline: () => true,
    });
    assert.equal(offline.source, 'copy');
    assert.equal(offline.file.conflictRemote, 'github two from copy\n');

    const neither = await loadConflictRemote({ db: box.db, file: legacy, sibling: null, fetchImpl: box.git.fetchImpl, offline: () => true });
    assert.equal(neither.source, '');
    assert.equal(neither.reason.includes('offline'), true);
    assert.equal(neither.file.conflictRemote, undefined);
  } finally {
    await box.close();
  }
});

test('a rename does not download the old path after the commit', async () => {
  const box = await harness();
  try {
    box.git.state.files.set('Logs.md', { sha: 'blob-1', text: 'See [[Field Notes]]\n' });
    box.git.state.files.delete('Field Notes.md');
    await putFile(box.db, note('Journal.md', 'See [[Journal]]\n', { dirty: true, origin: 'user' }));
    await box.sync.noteRenamed({
      from: 'Logs.md',
      to: 'Journal.md',
      baseSha: 'blob-1',
      file: note('Journal.md', 'See [[Journal]]\n', { dirty: true, origin: 'user' }),
    });
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const blobGets = box.git.log.filter((item) => item.method === 'GET' && /\/git\/blobs\/[^/]+$/.test(new URL(item.url).pathname));
    assert.equal(blobGets.some((item) => item.url.endsWith('/blob-1')), false);
    assert.equal(await getFile(box.db, 'Logs.md'), undefined);
    const tree = box.git.log.find((item) => item.method === 'POST' && item.url.endsWith('/git/trees'));
    assert.equal(tree.body.tree.some((entry) => entry.path === 'Logs.md' && entry.sha === null), true);
    const cursor = await getMeta(box.db, 'githubSyncCursor');
    assert.equal(cursor.headSha, box.git.state.head);
    assert.equal(cursor.treeSha, box.git.state.tree);
  } finally {
    await box.close();
  }
});

test('leftover conflict copies appear on the status and stay local', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Field Notes.md', 'Local line\n', { baseSha: 'blob-1', remoteSha: 'blob-1' }));
    await putFile(box.db, note('Field Notes (conflict 2026-10-20 1718).md', 'theirs\n', { conflictCopy: true }));
    const result = await box.sync.runNow();
    assert.equal(result.status, 'Synced · 1 conflict copy');
    assert.equal(result.copies, 1);
    assert.equal(box.git.state.files.has('Field Notes (conflict 2026-10-20 1718).md'), false);
    const copy = await getFile(box.db, 'Field Notes (conflict 2026-10-20 1718).md');
    assert.equal(copy.trashedAt, null);
    assert.equal(copy.remoteSha, null);
  } finally {
    await box.close();
  }
});

test('an offline delete stays queued until the phone is online again', async () => {
  let offline = true;
  const box = await harness({ isOffline: () => offline });
  const name = box.db.name;
  try {
    await putFile(box.db, note('Field Notes.md', 'Local line\n', { baseSha: 'blob-1', remoteSha: 'blob-1', trashedAt: 4 }));
    await box.sync.noteTrashed({ file: { path: 'Field Notes.md' }, baseSha: 'blob-1' });
    const queued = await box.sync.runNow();
    assert.equal(queued.status, SYNC_STATUS.offline);
    assert.equal(box.git.log.length, 0);
    box.sync.stop();
    box.db.close();
    offline = false;
    const db = await openDatabase(name);
    const clock = timers();
    const sync = createAutoSync({
      db,
      fetchImpl: box.git.fetchImpl,
      now: () => 1_700_000_000_000,
      random: () => 0,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const result = await sync.runNow();
    sync.stop();
    assert.equal(result.status, SYNC_STATUS.synced);
    assert.equal(box.git.state.files.has('Field Notes.md'), false);
    db.close();
  } finally {
    await deleteDatabase(name);
  }
});

test('sync stores attachment stubs from the tree without fetching bytes', async () => {
  const box = await harness();
  try {
    await putFile(box.db, note('Field Notes.md', 'Local line\n', { baseSha: 'blob-1', remoteSha: 'blob-1' }));
    box.git.state.files.set('assets/Site Log/shot.png', { sha: 'png-1', text: '' });
    const remote = [{ localPath: 'assets/Site Log/shot.png', sha: 'png-1', size: 80 }];
    const plan = reconcileAttachments([
      { path: 'Field Notes.md', kind: 'markdown', trashedAt: null },
    ], remote);
    assert.equal(plan.stubs.length, 1);
    assert.equal(plan.pushes.length, 0);
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const stub = await getFile(box.db, 'assets/Site Log/shot.png');
    assert.equal(stub.kind, 'binary');
    assert.equal(stub.content, '');
    assert.equal(stub.remoteSha, 'png-1');
    assert.equal(box.git.log.some((item) => item.method === 'GET' && String(item.url).includes('/git/blobs/png-1')), false);
  } finally {
    await box.close();
  }
});

test('a local image stays queued offline and later uploads the original bytes', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9]);
  let offline = true;
  const box = await harness({ isOffline: () => offline });
  try {
    const path = 'assets/Site Log/image-20260102030405006.png';
    const file = {
      path,
      content: '',
      kind: 'binary',
      encoding: 'binary',
      bytes: png.byteLength,
      createdAt: 1,
      updatedAt: 2,
      trashedAt: null,
      remoteSha: null,
      baseSha: null,
      dirty: true,
      conflict: false,
      origin: 'user',
    };
    await putFile(box.db, note('Site Log.md', '![[image-20260102030405006.png]]\n', { origin: 'user', dirty: true }));
    await putFile(box.db, file);
    await rememberImage(box.db, { repo: 'owner/repo', path, data: png.buffer.slice(0), type: 'image/png' });
    await box.sync.noteEdited(file);
    const queued = await box.sync.runNow();
    assert.equal(queued.status, SYNC_STATUS.offline);
    assert.equal(box.git.log.length, 0);
    offline = false;
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const posted = box.git.log.filter((item) => item.method === 'POST' && item.url.endsWith('/git/blobs'));
    const binary = posted.find((item) => item.body && item.body.encoding === 'base64');
    assert.ok(binary);
    assert.equal(binary.body.content, encodeBytesBase64(png));
    const saved = await getFile(box.db, path);
    assert.equal(saved.dirty, false);
    assert.ok(saved.remoteSha);
    assert.equal(box.git.state.files.has(path), true);
  } finally {
    await box.close();
  }
});

test('renaming a note reuses attachment blob shas and drops the old paths in one commit', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9]);
  const box = await harness();
  try {
    const imageFrom = 'assets/Site Log/shot.png';
    const pdfFrom = 'assets/Site Log/notes.pdf';
    const imageTo = 'assets/Field Log/shot.png';
    const pdfTo = 'assets/Field Log/notes.pdf';
    box.git.state.files.delete('Field Notes.md');
    box.git.state.files.set('Site Log.md', { sha: 'blob-note', text: '![[shot.png]]\n' });
    box.git.state.files.set(imageFrom, { sha: 'png-1', text: '' });
    box.git.state.files.set(pdfFrom, { sha: 'pdf-1', text: '' });
    box.git.state.blobs.set('blob-note', '![[shot.png]]\n');
    await putFile(box.db, note('Field Log.md', '![[shot.png]]\n', { dirty: true }));
    await putFile(box.db, attachment(imageTo, { bytes: png.byteLength, dirty: true }));
    await putFile(box.db, attachment(pdfTo, { bytes: 1200, dirty: true }));
    await rememberImage(box.db, {
      repo: 'owner/repo',
      path: imageFrom,
      data: png.buffer.slice(0),
      type: 'image/png',
      sha: 'png-1',
    });
    await box.sync.noteRenamed({
      from: 'Site Log.md',
      to: 'Field Log.md',
      baseSha: 'blob-note',
      file: note('Field Log.md', '![[shot.png]]\n', { dirty: true }),
    });
    await box.sync.noteRenamed({
      from: imageFrom,
      to: imageTo,
      baseSha: 'png-1',
      file: attachment(imageTo, { bytes: png.byteLength, dirty: true }),
    });
    await box.sync.noteRenamed({
      from: pdfFrom,
      to: pdfTo,
      baseSha: 'pdf-1',
      file: attachment(pdfTo, { bytes: 1200, dirty: true }),
    });
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const trees = box.git.log.filter((item) => item.method === 'POST' && item.url.endsWith('/git/trees'));
    assert.equal(trees.length, 1);
    const tree = trees[0].body.tree;
    assert.equal(tree.some((entry) => entry.path === imageTo && entry.sha === 'png-1'), true);
    assert.equal(tree.some((entry) => entry.path === pdfTo && entry.sha === 'pdf-1'), true);
    assert.equal(tree.some((entry) => entry.path === imageFrom && entry.sha === null), true);
    assert.equal(tree.some((entry) => entry.path === pdfFrom && entry.sha === null), true);
    assert.equal(tree.some((entry) => entry.path === 'Site Log.md' && entry.sha === null), true);
    const blobPosts = box.git.log.filter((item) => item.method === 'POST' && item.url.endsWith('/git/blobs'));
    assert.equal(blobPosts.some((item) => item.body && item.body.encoding === 'base64'), false);
    assert.equal(box.git.state.files.has(imageFrom), false);
    assert.equal(box.git.state.files.has(pdfFrom), false);
    assert.equal(box.git.state.files.has('Site Log.md'), false);
    assert.equal(box.git.state.files.get(imageTo).sha, 'png-1');
    assert.equal(box.git.state.files.get(pdfTo).sha, 'pdf-1');
    assert.equal(await getFile(box.db, imageFrom), undefined);
    assert.equal(await getFile(box.db, pdfFrom), undefined);
    assert.equal(await getFile(box.db, 'Site Log.md'), undefined);
    const localImage = await getFile(box.db, imageTo);
    const localPdf = await getFile(box.db, pdfTo);
    assert.equal(localImage.dirty, false);
    assert.equal(localImage.remoteSha, 'png-1');
    assert.equal(localPdf.dirty, false);
    assert.equal(localPdf.remoteSha, 'pdf-1');
    const moved = await cachedImage(box.db, 'owner/repo', imageTo);
    assert.ok(moved?.data);
    assert.equal(moved.bytes, png.byteLength);
    assert.equal(await cachedImage(box.db, 'owner/repo', imageFrom), null);
    const files = await listFiles(box.db);
    assert.equal(files.some((file) => file.path.startsWith('assets/Site Log/')), false);
    assert.equal((await listOps(box.db)).length, 0);
  } finally {
    await box.close();
  }
});

test('one unresolvable attachment does not block a note edit', async () => {
  const box = await harness();
  try {
    const stuck = attachment('assets/Site Log/mystery.bin', { bytes: 40, dirty: true, origin: 'user' });
    await putFile(box.db, note('Field Notes.md', 'edited\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    await putFile(box.db, stuck);
    await box.sync.noteEdited(note('Field Notes.md', 'edited\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    await box.sync.noteEdited(stuck);
    const result = await box.sync.runNow();
    assert.equal(box.git.state.files.get('Field Notes.md').text, 'edited\n');
    assert.equal(box.git.state.files.has(stuck.path), false);
    const local = await getFile(box.db, stuck.path);
    assert.equal(local.dirty, true);
    assert.equal(result.status, SYNC_STATUS.failed);
    assert.equal(result.detail, ATTACHMENT_BYTES_MISSING);
    assert.equal(result.detail.includes('still on this device'), false);
    const remaining = await listOps(box.db);
    assert.equal(remaining.some((op) => op.path === stuck.path || op.id === stuck.path), true);
    const noteFile = await getFile(box.db, 'Field Notes.md');
    assert.equal(noteFile.dirty, false);
    assert.equal(noteFile.content, 'edited\n');
  } finally {
    await box.close();
  }
});

async function editDuringFirstPatch(box, path, firstText, secondText, extra = {}) {
  let release;
  box.git.state.holdPatch = new Promise((resolve) => {
    release = () => {
      box.git.state.holdPatch = null;
      resolve();
    };
  });
  await putFile(box.db, note(path, firstText, { dirty: true, origin: 'user', ...extra }));
  const firstSync = box.sync.runNow();
  await until(() => box.git.state.patchHeld);
  await putFile(box.db, {
    ...note(path, secondText, { dirty: true, origin: 'user', ...extra }),
  });
  release();
  const first = await firstSync;
  const remoteAfterFirst = box.git.state.files.get(path);
  const mid = await getFile(box.db, path);
  assert.equal(remoteAfterFirst.text, firstText);
  assert.equal(mid.content, secondText);
  assert.equal(mid.dirty, true);
  assert.equal(mid.baseSha, remoteAfterFirst.sha);
  assert.equal(mid.remoteSha, remoteAfterFirst.sha);
  assert.equal(mid.conflict, false);
  assert.notEqual(first.status, SYNC_STATUS.conflict);
  assert.equal(first.conflict, false);
  const copies = (await listFiles(box.db)).filter((file) => file.conflictCopy || isLocalCopyName(file.path));
  assert.equal(copies.length, 0);
  const uploadedSha = remoteAfterFirst.sha;
  const second = await box.sync.runNow();
  assert.equal(second.status, SYNC_STATUS.synced);
  assert.equal(second.conflict, false);
  assert.equal(box.git.state.files.get(path).text, secondText);
  const done = await getFile(box.db, path);
  assert.equal(done.content, secondText);
  assert.equal(done.dirty, false);
  assert.equal(done.conflict, false);
  assert.equal(done.baseSha, box.git.state.files.get(path).sha);
  assert.equal((await listFiles(box.db)).some((file) => file.conflictCopy || isLocalCopyName(file.path)), false);
  assert.equal((await listOps(box.db)).length, 0);
  return { first, second, uploadedSha, mid, done };
}

test('typing during the first upload of a new Untitled note records the SHA and syncs the later text', async () => {
  const box = await harness();
  try {
    const { uploadedSha, mid } = await editDuringFirstPatch(box, 'Untitled.md', 'A\n', 'B\n');
    assert.equal(mid.baseSha, uploadedSha);
    assert.equal(mid.dirty, true);
  } finally {
    await box.close();
  }
});

test('typing during an existing note upload records the new SHA instead of a three-way conflict', async () => {
  const box = await harness();
  try {
    const { uploadedSha, mid } = await editDuringFirstPatch(
      box,
      'Field Notes.md',
      'A\n',
      'B\n',
      { baseSha: 'blob-1', remoteSha: 'blob-1' },
    );
    assert.equal(uploadedSha === 'blob-1', false);
    assert.equal(mid.baseSha, uploadedSha);
    assert.equal(mid.dirty, true);
  } finally {
    await box.close();
  }
});

test('a stale editor save after acknowledgement does not revert base metadata', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  try {
    await putFile(db, note('Untitled.md', 'B\n', {
      dirty: true,
      origin: 'user',
      baseSha: 'blob-new-1',
      remoteSha: 'blob-new-1',
      syncedAt: 99,
      syncedCommit: 'commit-2',
    }));
    const saved = await saveLocalFile(db, note('Untitled.md', 'B\n', { dirty: true, origin: 'user' }));
    assert.equal(saved.baseSha, 'blob-new-1');
    assert.equal(saved.remoteSha, 'blob-new-1');
    assert.equal(saved.syncedCommit, 'commit-2');
    assert.equal(saved.syncedAt, 99);
    assert.equal(saved.content, 'B\n');
    assert.equal(saved.dirty, true);
    const kept = await saveLocalFile(db, note('Untitled.md', 'C\n', {
      dirty: true,
      origin: 'user',
      baseSha: 'blob-1',
      remoteSha: 'blob-1',
      syncedAt: 1,
      syncedCommit: 'commit-old',
    }));
    assert.equal(kept.baseSha, 'blob-new-1');
    assert.equal(kept.remoteSha, 'blob-new-1');
    assert.equal(kept.syncedCommit, 'commit-2');
    assert.equal(kept.syncedAt, 99);
    assert.equal(kept.content, 'C\n');
    assert.equal(kept.dirty, true);
  } finally {
    db.close();
    await deleteDatabase(name);
  }
});

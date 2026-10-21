import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, getFile, getMeta, listFiles, listOps, openDatabase, putFile } from '../app/js/db.js';
import { encodeUtf8Base64 } from '../app/js/github-api.js';
import { saveGithubSession, saveGithubTarget } from '../app/js/github-store.js';
import {
  backoffDelay,
  conflictCopyPath,
  createAutoSync,
  createSyncClock,
  presentSyncStatus,
  reconcileNotes,
  refUpdateBody,
  retryDelay,
  SYNC_DEBOUNCE_MS,
  SYNC_POLL_MS,
  SYNC_STATUS,
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

function json(status, body, headers = {}) {
  return new Response(status === 304 ? '' : JSON.stringify(body), {
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
  };
  const log = [];
  let refReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    const text = String(url);
    if (text.includes(TOKEN)) throw new Error('token leaked into the url');
    log.push({ method, url: text, body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} });
    if (text.endsWith('/user')) {
      if (state.userStatus) return json(state.userStatus, { message: 'nope' });
      return json(200, { login: 'octocat' });
    }
    if (text.includes('/git/ref/heads/') && method !== 'PATCH') {
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
    if (text.includes('/git/commits/')) {
      return json(200, { sha: state.head, tree: { sha: state.tree } });
    }
    if (text.includes('/git/trees/') && method === 'GET') {
      return json(200, {
        sha: state.tree,
        truncated: Boolean(state.truncated),
        tree: [...state.files].map(([path, file]) => ({ path, mode: '100644', type: 'blob', sha: file.sha })),
      });
    }
    if (text.includes('/git/blobs/') && method === 'GET') {
      const sha = text.split('/').pop();
      const content = state.blobs.get(sha);
      if (content == null) return json(404, { message: 'Not Found' });
      return json(200, { sha, encoding: 'base64', content: encodeUtf8Base64(content) });
    }
    if (text.endsWith('/git/blobs') && method === 'POST') {
      const sha = `blob-new-${state.blobs.size + 1}`;
      state.blobs.set(sha, options.body ? JSON.parse(options.body).content : '');
      return json(201, { sha });
    }
    if (text.endsWith('/git/trees') && method === 'POST') {
      const body = JSON.parse(options.body);
      state.tree = 'tree-2';
      for (const entry of body.tree) {
        state.files.set(entry.path, { sha: entry.sha, text: state.blobs.get(entry.sha) || '' });
      }
      return json(201, { sha: state.tree });
    }
    if (text.endsWith('/git/commits') && method === 'POST') {
      state.commit = 'commit-2';
      return json(201, { sha: state.commit });
    }
    if (text.includes('/git/ref/heads/') && method === 'PATCH') {
      const body = JSON.parse(options.body);
      if (body.force !== false) return json(500, { message: 'force' });
      if (state.failPatch) return json(500, { message: 'no' });
      state.head = body.sha;
      return json(200, { ref: 'refs/heads/main', object: { sha: body.sha } });
    }
    return json(404, { message: 'Not Found' });
  };
  return { state, log, fetchImpl };
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
  let pulled = 0;
  const sync = createAutoSync({
    db,
    fetchImpl: git.fetchImpl,
    now: () => extra.now || 1_700_000_000_000,
    random: () => 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    offline: () => Boolean(extra.offline),
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
});

test('status is never Synced before a confirmed write, and a conflict keeps both sides', () => {
  assert.equal(presentSyncStatus({ configured: true, confirmed: false }), SYNC_STATUS.syncing);
  assert.equal(presentSyncStatus({ configured: true, confirmed: true, pending: true }), SYNC_STATUS.pending);
  assert.equal(presentSyncStatus({ configured: true, confirmed: true, syncing: true }), SYNC_STATUS.syncing);
  assert.equal(presentSyncStatus({ configured: true, confirmed: true }), SYNC_STATUS.synced);
  assert.notEqual(presentSyncStatus({ configured: true, pending: true }), SYNC_STATUS.synced);
  assert.equal(presentSyncStatus({ configured: false, confirmed: true }), '');

  const when = new Date('2026-10-21T19:18:00Z');
  assert.equal(conflictCopyPath('Field Notes.md', when), 'Field Notes.md'.replace('.md', ' (conflict 2026-10-21 1918).md'));
  const taken = new Set(['Field Notes (conflict 2026-10-21 1918).md']);
  assert.equal(conflictCopyPath('Field Notes.md', when, taken), 'Field Notes (conflict 2026-10-21 1918-2).md');

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
    const refs = box.git.log.filter((item) => item.url.includes('/git/ref/'));
    assert.equal(refs.length >= 2, true);
    assert.ok(box.git.log.indexOf(refs[1]) < box.git.log.indexOf(posts[0]));
    assert.equal(posts.filter((item) => item.url.endsWith('/git/blobs')).length, 2);
    assert.equal(posts.filter((item) => item.url.endsWith('/git/trees')).length, 1);
    assert.equal(posts.filter((item) => item.url.endsWith('/git/commits')).length, 1);
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

test('a moved head is not written', async () => {
  const box = await harness();
  try {
    box.git.state.moveOnSecondRef = true;
    await putFile(box.db, note('Field Notes.md', 'changed\n', { dirty: true, baseSha: 'blob-1', remoteSha: 'blob-1' }));
    const result = await box.sync.runNow();
    assert.notEqual(result.status, SYNC_STATUS.synced);
    assert.equal(box.git.log.some((item) => item.method === 'POST' || item.method === 'PATCH'), false);
    const saved = await getFile(box.db, 'Field Notes.md');
    assert.equal(saved.content, 'changed\n');
    assert.equal(saved.dirty, true);
    assert.equal((await listOps(box.db)).length, 1);
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

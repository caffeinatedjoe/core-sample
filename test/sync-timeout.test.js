import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, getFile, listOps, openDatabase, putFile } from '../app/js/db.js';
import { saveGithubSession, saveGithubTarget } from '../app/js/github-store.js';
import { createAutoSync, SYNC_STATUS, timedFetch } from '../app/js/github-sync.js';
import { createFakeGit } from './helpers/fake-git.js';

const TOKEN = 'fake-oauth-value-0001';

function never() {
  return new Promise(() => {});
}

async function until(read, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

async function harness({ files = {}, hang = () => false, beforeSync } = {}) {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await saveGithubSession(db, { token: TOKEN, login: 'octocat' });
  await saveGithubTarget(db, { repo: 'owner/repo', branch: 'main', root: '' });
  const git = createFakeGit({ token: TOKEN, files });
  const history = [];
  const calls = [];
  // The sync timers are unref'd like the app's; this keeps the test process up.
  const alive = setInterval(() => {}, 1000);
  const sync = createAutoSync({
    db,
    fetchImpl: async (url, options = {}) => {
      assert.equal(String(url).includes(TOKEN), false);
      const call = { method: options.method || 'GET', path: new URL(String(url)).pathname, signal: options.signal };
      calls.push(call);
      if (hang(call, calls)) return never();
      return git.fetchImpl(url, options);
    },
    random: () => 0,
    debounceMs: 1_000_000,
    pollMs: 1_000_000,
    requestTimeoutMs: 40,
    blobTimeoutMs: 40,
    stallMs: 150,
    authRecheckMs: [],
    beforeSync,
    onStatus(text) {
      history.push(text);
    },
  });
  return {
    db,
    git,
    sync,
    history,
    calls,
    async done() {
      sync.stop();
      clearInterval(alive);
      db.close();
      await deleteDatabase(name);
    },
  };
}

test('a request that never answers times out and aborts, even when the fetch ignores the signal', async () => {
  let seen = null;
  const send = timedFetch((url, init) => {
    seen = init.signal;
    return never();
  }, { timeoutMs: 20 });
  await assert.rejects(send('https://api.github.com/user', { headers: {} }), (error) => error.timedOut === true);
  assert.equal(seen.aborted, true);

  const slowBody = timedFetch(async () => ({
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    arrayBuffer: never,
  }), { timeoutMs: 20 });
  await assert.rejects(slowBody('https://api.github.com/repos/owner/repo/git/ref/heads/main'), (error) => error.timedOut === true);
});

test('a first sync whose request never answers recovers on its own retry without reopening', async () => {
  const app = await harness({
    files: { 'Notes/A.md': 'alpha\n' },
    hang: (call, calls) => calls.length === 1,
  });
  try {
    const first = await app.sync.start();
    assert.equal(first.status, SYNC_STATUS.pending);
    assert.equal(first.syncing, false);
    assert.equal(app.calls[0].signal.aborted, true);
    await until(async () => (await getFile(app.db, 'Notes/A.md'))?.content === 'alpha\n');
    await until(() => app.sync.status() === SYNC_STATUS.synced);
    assert.equal(app.history.includes(SYNC_STATUS.failed), false);
  } finally {
    await app.done();
  }
});

test('a push whose ref update never answers keeps the queue and pushes on the retry', async () => {
  let patches = 0;
  const app = await harness({
    files: { 'A.md': 'alpha\n' },
    hang: (call) => call.method === 'PATCH' && (patches += 1) === 1,
  });
  try {
    await app.sync.start();
    await until(() => app.sync.status() === SYNC_STATUS.synced);
    const file = await getFile(app.db, 'A.md');
    await putFile(app.db, { ...file, content: 'alpha\nbeta\n', dirty: true, updatedAt: Date.now() });
    await app.sync.noteEdited({ ...file, content: 'alpha\nbeta\n' });
    const stuck = await app.sync.runNow('edit');
    assert.equal(stuck.status, SYNC_STATUS.pending);
    assert.equal((await listOps(app.db)).length, 1);
    await until(() => app.git.snapshot().get('A.md') === 'alpha\nbeta\n');
    await until(() => app.sync.status() === SYNC_STATUS.synced);
    assert.equal((await listOps(app.db)).length, 0);
    assert.equal(app.history.includes(SYNC_STATUS.failed), false);
  } finally {
    await app.done();
  }
});

test('a run stuck outside any request is let go so the next sync runs', async () => {
  let flushes = 0;
  const app = await harness({
    files: { 'A.md': 'alpha\n' },
    beforeSync: () => ((flushes += 1) === 1 ? never() : Promise.resolve()),
  });
  try {
    const stalled = await app.sync.runNow('launch');
    assert.equal(stalled.syncing, false);
    assert.equal(stalled.status, SYNC_STATUS.pending);
    await until(() => app.sync.status() === SYNC_STATUS.synced);
    assert.equal((await getFile(app.db, 'A.md')).content, 'alpha\n');
  } finally {
    await app.done();
  }
});

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deleteDatabase, getMeta, listFiles, openDatabase } from '../app/js/db.js';
import { loadSession, makeFile } from '../app/js/notes.js';
import { putFile } from '../app/js/db.js';
import {
  disconnectGithub,
  eraseLocalNotes,
  loadGithubSettings,
  loadPendingFlow,
  loadStorageFlag,
  rememberStoragePersistence,
  recordStoragePersistence,
  saveGithubConfig,
  saveGithubSession,
  saveGithubTarget,
  savePendingFlow,
  storagePersistenceText,
} from '../app/js/github-store.js';

const TOKEN = 'gho_testtokenvalue123456';

test('disconnect removes the token and repo settings and keeps notes and the client id', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await putFile(db, makeFile('Field notes.md', 'keep me'));
  await saveGithubConfig(db, { clientId: 'Iv1.public', relay: 'https://relay.example' });
  await saveGithubSession(db, { token: TOKEN, login: 'octocat' });
  await saveGithubTarget(db, { repo: 'owner/repo', branch: 'main', root: '' });
  await savePendingFlow(db, {
    deviceCode: 'dc_supersecretvalue',
    userCode: 'ABCD-1234',
    interval: 5,
    expiresAt: Date.now() + 60_000,
  });

  await disconnectGithub(db);
  const settings = await loadGithubSettings(db);
  assert.equal(settings.token, '');
  assert.equal(settings.repo, '');
  assert.equal(settings.branch, '');
  assert.equal(settings.root, '');
  assert.equal(settings.login, '');
  assert.equal(settings.clientId, 'Iv1.public');
  assert.equal(settings.relay, 'https://relay.example');
  assert.equal(await loadPendingFlow(db), null);
  const files = await listFiles(db);
  assert.equal(files.length, 1);
  assert.equal(files[0].content, 'keep me');
  assert.equal(JSON.stringify(files).includes(TOKEN), false);

  db.close();
  await deleteDatabase(name);
});

test('erasing the local copy removes notes and does not remove the token or bring Welcome back', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await loadSession(db);
  await saveGithubSession(db, { token: TOKEN, login: 'octocat' });
  await eraseLocalNotes(db);
  assert.equal((await listFiles(db)).length, 0);
  assert.equal((await loadGithubSettings(db)).token, TOKEN);
  assert.equal(await getMeta(db, 'seeded'), true);

  const again = await loadSession(db);
  assert.equal(again.files.length, 0);
  assert.equal(again.current, null);
  db.close();
  await deleteDatabase(name);
});

test('opening the same database again keeps the github token', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await saveGithubSession(db, { token: TOKEN, login: 'octocat' });
  await saveGithubTarget(db, { repo: 'owner/repo', branch: 'main', root: 'notes' });
  db.close();
  const again = await openDatabase(name);
  const settings = await loadGithubSettings(again);
  assert.equal(settings.token, TOKEN);
  assert.equal(settings.repo, 'owner/repo');
  assert.equal(settings.branch, 'main');
  assert.equal(settings.root, 'notes');
  again.close();
  await deleteDatabase(name);
});

test('persistent storage is remembered without dropping the token', async () => {
  assert.equal(await rememberStoragePersistence(undefined), false);
  let calls = 0;
  assert.equal(await rememberStoragePersistence({
    persisted: async () => false,
    persist: async () => {
      calls += 1;
      return true;
    },
  }), true);
  assert.equal(calls, 1);
  assert.equal(await rememberStoragePersistence({
    persisted: async () => true,
    persist: async () => {
      throw new Error('already granted');
    },
  }), true);
  assert.equal(storagePersistenceText(true), 'Storage on this phone is set to stay.');
  assert.equal(storagePersistenceText(false), 'Storage on this phone is not set to stay.');

  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await saveGithubSession(db, { token: TOKEN, login: 'octocat' });
  assert.equal(await recordStoragePersistence(db, {
    persisted: async () => false,
    persist: async () => true,
  }), true);
  assert.equal(await loadStorageFlag(db), true);
  assert.equal((await loadGithubSettings(db)).token, TOKEN);
  db.close();
  await deleteDatabase(name);
});

test('no migration, upgrade, or service worker path deletes the meta store or the github token', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const db = read('app/js/db.js');
  const sw = read('app/sw.js');
  const main = read('app/js/main.js');
  assert.match(db, /const DB_VERSION = 3/);
  assert.equal(db.includes('deleteObjectStore'), false);
  assert.equal(sw.includes('indexedDB'), false);
  assert.equal(sw.includes('githubToken'), false);
  assert.equal(sw.includes('deleteDatabase'), false);
  assert.equal(sw.includes('deleteObjectStore'), false);
  assert.equal(main.includes('githubToken'), false);
  assert.equal(main.includes('deleteDatabase'), false);
  assert.equal(main.includes('deleteObjectStore'), false);
  const files = readdirSync(join(root, 'app/js')).filter((name) => name.endsWith('.js'));
  const callers = [];
  for (const name of files) {
    const text = read(`app/js/${name}`);
    if (name !== 'github-store.js' && text.includes('TOKEN_KEY')) callers.push(name);
    if (text.includes('deleteObjectStore')) callers.push(`${name}:deleteObjectStore`);
    if (name !== 'db.js' && text.includes('deleteDatabase')) callers.push(`${name}:deleteDatabase`);
  }
  assert.deepEqual(callers, []);
  const store = read('app/js/github-store.js');
  assert.equal(store.split('clear(db, TOKEN_KEY)').length, 2);
  const ui = read('app/js/github-ui.js');
  assert.equal(ui.split('disconnectGithub(').length, 2);
});

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, getMeta, listFiles, openDatabase } from '../app/js/db.js';
import { loadSession, makeFile } from '../app/js/notes.js';
import { putFile } from '../app/js/db.js';
import {
  disconnectGithub,
  eraseLocalNotes,
  loadGithubSettings,
  saveGithubConfig,
  saveGithubSession,
  saveGithubTarget,
} from '../app/js/github-store.js';

const TOKEN = 'gho_testtokenvalue123456';

test('disconnect removes the token and repo settings and keeps notes and the client id', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await putFile(db, makeFile('Field notes.md', 'keep me'));
  await saveGithubConfig(db, { clientId: 'Iv1.public', relay: 'https://relay.example' });
  await saveGithubSession(db, { token: TOKEN, login: 'octocat' });
  await saveGithubTarget(db, { repo: 'owner/repo', branch: 'main', root: '' });

  await disconnectGithub(db);
  const settings = await loadGithubSettings(db);
  assert.equal(settings.token, '');
  assert.equal(settings.repo, '');
  assert.equal(settings.branch, '');
  assert.equal(settings.root, '');
  assert.equal(settings.login, '');
  assert.equal(settings.clientId, 'Iv1.public');
  assert.equal(settings.relay, 'https://relay.example');
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

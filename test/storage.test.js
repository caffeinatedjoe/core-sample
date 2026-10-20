import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, getMeta, openDatabase, putFile, setMeta } from '../app/js/db.js';
import { loadSession, makeFile, notePathFromName, WELCOME_PATH } from '../app/js/notes.js';

async function reopen(name) {
  return openDatabase(name);
}

test('saves a note and restores it after the database is closed and reopened', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const session = await loadSession(db);
  assert.equal(session.current.path, WELCOME_PATH);
  assert.match(session.current.content, /Core Sample keeps notes/);

  session.current.content = 'hello 日本語 🌧️\n- [ ] box\n';
  session.current.updatedAt = 50;
  await putFile(db, { ...session.current });
  await setMeta(db, 'lastOpened', WELCOME_PATH);
  db.close();

  const again = await reopen(name);
  const restored = await loadSession(again);
  assert.equal(restored.notes.length, 1);
  assert.equal(restored.current.path, WELCOME_PATH);
  assert.equal(restored.current.content, 'hello 日本語 🌧️\n- [ ] box\n');
  assert.equal(await getMeta(again, 'lastOpened'), WELCOME_PATH);
  again.close();
  await deleteDatabase(name);
});

test('restores the last opened note rather than a newer sibling', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await loadSession(db);
  const other = makeFile('Field notes.md', '# Field notes\n\ncores', 10);
  other.updatedAt = 999;
  await putFile(db, other);
  await setMeta(db, 'lastOpened', WELCOME_PATH);
  db.close();

  const again = await openDatabase(name);
  const restored = await loadSession(again);
  assert.equal(restored.notes.length, 2);
  assert.equal(restored.current.path, WELCOME_PATH);
  again.close();
  await deleteDatabase(name);
});

test('seeds the welcome note once', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await loadSession(db);
  db.close();
  const again = await openDatabase(name);
  const restored = await loadSession(again);
  assert.equal(restored.notes.length, 1);
  assert.equal(restored.current.path, WELCOME_PATH);
  again.close();
  await deleteDatabase(name);
});

test('names new notes without clobbering an existing path', () => {
  assert.equal(notePathFromName('Field notes', []), 'Field notes.md');
  assert.equal(notePathFromName('Field notes.md', []), 'Field notes.md');
  assert.equal(notePathFromName('   ', ['Untitled.md']), 'Untitled 2.md');
  assert.throws(() => notePathFromName('Field notes', ['Field notes.md']), /already exists/);
  assert.throws(() => notePathFromName('a/b', []), /slashes/);
});

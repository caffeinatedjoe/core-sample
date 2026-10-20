import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { commitFiles, deleteDatabase, openDatabase } from '../app/js/db.js';
import { loadSession, makeFile, planWikilink } from '../app/js/notes.js';
import { planEmptyTrash, planRestore, planTrash } from '../app/js/organize.js';

test('trash keeps the text, restore brings it back, and empty trash is a separate step', () => {
  const files = [
    makeFile('Keep.md', '# Keep\n\nstay'),
    makeFile('Work/Gone.md', '# Gone\n\nplease keep this'),
  ];
  const trashed = planTrash(files, ['Work'], 'Work', 80);
  assert.equal(trashed.remove.length, 0);
  assert.equal(trashed.files.find((file) => file.path === 'Work/Gone.md').content, '# Gone\n\nplease keep this');
  assert.equal(trashed.files.find((file) => file.path === 'Work/Gone.md').trashedAt, 80);
  assert.equal(trashed.files.find((file) => file.path === 'Keep.md').trashedAt, undefined);
  assert.deepEqual(trashed.folders, []);

  const restored = planRestore(trashed.files, 'Work/Gone.md', 90);
  assert.equal(restored.files.find((file) => file.path === 'Work/Gone.md').trashedAt, null);
  assert.match(restored.files.find((file) => file.path === 'Work/Gone.md').content, /please keep this/);

  const again = planTrash(restored.files, [], 'Work/Gone.md', 100);
  const emptied = planEmptyTrash(again.files);
  assert.deepEqual(emptied.remove, ['Work/Gone.md']);
  assert.equal(emptied.files.some((file) => file.path === 'Work/Gone.md'), false);
  assert.equal(emptied.files[0].path, 'Keep.md');
});

test('a wikilink to a trashed note restores it instead of creating a second copy', () => {
  const notes = [{ path: 'Another note.md', kind: 'markdown', content: '# Another note\n\nbody', trashedAt: 5 }];
  assert.deepEqual(planWikilink(notes, 'Another note'), {
    action: 'restore',
    path: 'Another note.md',
  });
});

test('a trashed note is still there after the database is reopened', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const session = await loadSession(db);
  const extra = makeFile('Field notes.md', '# Field notes\n\ncores and clay');
  const trashed = planTrash([session.current, extra], [], 'Field notes.md', 120);
  await commitFiles(db, { put: trashed.put });
  db.close();

  const again = await openDatabase(name);
  const restored = await loadSession(again);
  assert.equal(restored.notes.some((file) => file.path === 'Field notes.md'), false);
  const saved = restored.files.find((file) => file.path === 'Field notes.md');
  assert.match(saved.content, /cores and clay/);
  assert.equal(saved.trashedAt, 120);
  const back = planRestore(restored.files, 'Field notes.md', 130);
  await commitFiles(again, { put: back.put });
  again.close();

  const third = await openDatabase(name);
  const live = await loadSession(third);
  assert.match(live.notes.find((file) => file.path === 'Field notes.md').content, /cores and clay/);
  third.close();
  await deleteDatabase(name);
});

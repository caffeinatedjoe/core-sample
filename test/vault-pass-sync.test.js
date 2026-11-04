import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getFile, listFiles, putFile } from '../app/js/db.js';
import { isIgnoredPath } from '../app/js/vault-paths.js';
import { SYNC_STATUS } from '../app/js/github-sync.js';
import { vaultPassHarness, vaultPassName } from './helpers/vault-pass.js';

test(vaultPassName('first download pulls fixture notes and attachment stubs'), async () => {
  const box = await vaultPassHarness();
  try {
    const { loaded, writes } = await box.download();
    const paths = writes.map((file) => file.path).sort();
    assert.equal(paths.includes('Site Log.md'), true);
    assert.equal(paths.includes('Inbox.md'), true);
    assert.equal(paths.includes('Board.md'), true);
    assert.equal(paths.includes('Daily.md'), true);
    assert.equal(paths.includes('Site Log (conflict 2026-10-29 1235).md'), true);
    assert.equal(paths.includes('assets/Site Log/image-20261029123530322.png'), true);
    assert.equal(paths.includes('assets/Site Log/core-notes.pdf'), true);
    assert.equal(paths.some((path) => isIgnoredPath(path)), false);
    assert.equal(loaded.some((note) => isIgnoredPath(note.localPath)), false);

    const site = await getFile(box.db, 'Site Log.md');
    assert.match(site.content, /!\[\[image-20261029123530322\.png\]\]/);
    assert.equal(site.dirty, false);
    assert.ok(site.baseSha);
    const stub = await getFile(box.db, 'assets/Site Log/image-20261029123530322.png');
    assert.equal(stub.kind, 'binary');
    assert.equal(stub.content, '');
    assert.ok(stub.remoteSha);

    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    assert.equal(box.git.textAt('.obsidian/app.json').includes('attachmentFolderPath'), true);
    assert.equal(JSON.stringify(box.github.outbound).includes(box.token), false);
  } finally {
    await box.close();
  }
});

test(vaultPassName('edit and push writes the new text to the fake repo'), async () => {
  const box = await vaultPassHarness();
  try {
    await box.download();
    await box.sync.runNow();
    await box.edit('Daily.md', '# Daily\n\nedited on the phone\n');
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    assert.equal(box.git.textAt('Daily.md'), '# Daily\n\nedited on the phone\n');
    const saved = await getFile(box.db, 'Daily.md');
    assert.equal(saved.dirty, false);
    assert.equal(saved.content, '# Daily\n\nedited on the phone\n');
    assert.equal(box.git.textAt('Inbox.md').includes('#todo'), true);
  } finally {
    await box.close();
  }
});

test(vaultPassName('pull a remote change updates the local note'), async () => {
  const box = await vaultPassHarness();
  try {
    await box.download();
    await box.sync.runNow();
    const next = box.git.commitOn(box.git.state.head, { 'Daily.md': '# Daily\n\nfrom the computer\n' }, 'vault backup');
    box.git.advance(next);
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const saved = await getFile(box.db, 'Daily.md');
    assert.equal(saved.content, '# Daily\n\nfrom the computer\n');
    assert.equal(saved.dirty, false);
  } finally {
    await box.close();
  }
});

test(vaultPassName('overlapping edits keep the phone text and write a conflict copy'), async () => {
  const box = await vaultPassHarness();
  try {
    await box.download();
    await box.sync.runNow();
    await box.edit('Daily.md', '# Daily\n\nphone side\n');
    const next = box.git.commitOn(box.git.state.head, { 'Daily.md': '# Daily\n\ncomputer side\n' }, 'vault backup');
    box.git.advance(next);
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.conflict);
    const phone = await getFile(box.db, 'Daily.md');
    assert.equal(phone.content, '# Daily\n\nphone side\n');
    assert.equal(phone.conflict, true);
    const files = await listFiles(box.db);
    const copy = files.find((file) => file.conflictCopy && file.path.startsWith('Daily (conflict '));
    assert.ok(copy);
    assert.equal(copy.content, '# Daily\n\ncomputer side\n');
    assert.equal(box.git.textAt('Daily.md'), '# Daily\n\ncomputer side\n');
  } finally {
    await box.close();
  }
});

test(vaultPassName('delete syncs then Trash restore uploads the note again'), async () => {
  const box = await vaultPassHarness();
  try {
    await box.download();
    await box.sync.runNow();
    const daily = await getFile(box.db, 'Daily.md');
    const trashed = { ...daily, trashedAt: 9 };
    await putFile(box.db, trashed);
    await box.sync.noteTrashed({ file: { path: 'Daily.md' }, baseSha: daily.baseSha });
    const deleted = await box.sync.runNow();
    assert.equal(deleted.status, SYNC_STATUS.synced);
    assert.equal(box.git.blobShaAt('Daily.md'), '');
    const still = await getFile(box.db, 'Daily.md');
    assert.equal(still.trashedAt, 9);

    const restored = { ...still, trashedAt: null };
    await putFile(box.db, restored);
    await box.sync.noteRestored(restored);
    const queued = await getFile(box.db, 'Daily.md');
    assert.equal(queued.dirty, true);
    assert.equal(queued.origin, 'user');
    const uploaded = await box.sync.runNow();
    assert.equal(uploaded.status, SYNC_STATUS.synced);
    assert.equal(box.git.textAt('Daily.md'), daily.content);
  } finally {
    await box.close();
  }
});

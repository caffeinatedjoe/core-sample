import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attachmentDestination,
  embedLinkFor,
  extraAttachmentFiles,
  mergePlans,
  planRenameAttachmentFolder,
} from '../app/js/attachments.js';
import { resolveEmbedPath } from '../app/js/embeds.js';
import { fetchRawBytes } from '../app/js/github-api.js';
import { ATTACHMENT_BYTES_MISSING, SYNC_STATUS } from '../app/js/github-sync.js';
import { commitFiles, getFile, listFiles, putFile } from '../app/js/db.js';
import { parseDql, runDql } from '../app/js/dql.js';
import { rememberImage } from '../app/js/images.js';
import { planFileRename } from '../app/js/organize.js';
import { createTaskIndex } from '../app/js/task-index.js';
import { applyTaskToggle } from '../app/js/tasks.js';
import { vaultPassHarness, vaultPassName } from './helpers/vault-pass.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9]);
const STAMP = new Date(2026, 9, 29, 12, 35, 30, 322);

function boardQuery(content) {
  const match = String(content).match(/```dataview\n([\s\S]*?)```/);
  assert.ok(match, 'Board.md has a dataview block');
  return match[1].trim();
}

test(vaultPassName('sidebar lists assets and bare filename embeds resolve to fixture bytes'), async () => {
  const box = await vaultPassHarness();
  try {
    await box.download();
    const files = await listFiles(box.db);
    const binaries = files.filter((file) => file.kind === 'binary').map((file) => file.path).sort();
    assert.deepEqual(binaries, [
      'assets/Site Log/core-notes.pdf',
      'assets/Site Log/image-20261029123530322.png',
      'assets/Site Log/image-20261029124011200.jpg',
      'assets/Site Log/image-20261029124500000.gif',
    ]);
    const extra = extraAttachmentFiles(files, binaries);
    assert.equal(extra.length, 0);

    const paths = files.map((file) => file.path);
    const pngPath = resolveEmbedPath('image-20261029123530322.png', {
      notePath: 'Site Log.md',
      paths,
      attachmentFolderPath: './assets/${filename}',
    });
    assert.equal(pngPath, 'assets/Site Log/image-20261029123530322.png');
    const raw = await fetchRawBytes(box.github.fetchImpl, {
      repo: box.repo,
      path: pngPath,
      branch: 'main',
      token: box.token,
    });
    const bytes = Buffer.from(raw.bytes);
    assert.equal(bytes[0], 0x89);
    assert.deepEqual(bytes, box.git.bytesAt(pngPath));
  } finally {
    await box.close();
  }
});

test(vaultPassName('pasted image and Image button store original bytes at assets/<note>/image-<stamp>'), async () => {
  const box = await vaultPassHarness();
  try {
    await box.download();
    await box.sync.runNow();
    const existing = (await listFiles(box.db)).map((file) => file.path);
    const dest = attachmentDestination('Site Log.md', {
      mime: 'image/png',
      filename: 'photo.png',
      existingPaths: existing,
      pasted: true,
      now: STAMP,
    });
    assert.equal(dest.path, 'assets/Site Log/image-20261029123530322 1.png');
    const picker = attachmentDestination('Site Log.md', {
      mime: 'image/png',
      filename: 'from-picker.png',
      existingPaths: [...existing, dest.path],
      pasted: true,
      now: new Date(STAMP.getTime() + 1),
    });
    assert.match(picker.path, /^assets\/Site Log\/image-\d{17}\.png$/);

    const file = {
      path: dest.path,
      content: '',
      kind: 'binary',
      encoding: 'binary',
      bytes: PNG.byteLength,
      createdAt: 1,
      updatedAt: 1,
      trashedAt: null,
      remoteSha: null,
      baseSha: null,
      dirty: true,
      conflict: false,
      origin: 'user',
    };
    await putFile(box.db, file);
    await rememberImage(box.db, {
      repo: box.repo,
      path: dest.path,
      data: PNG.buffer.slice(0),
      type: 'image/png',
    });
    const link = embedLinkFor(dest.path, [...existing, dest.path]);
    assert.equal(link, `![[${dest.path.split('/').pop()}]]`);
    const note = await getFile(box.db, 'Site Log.md');
    await box.edit('Site Log.md', `${note.content}\n${link}\n`);
    await box.sync.noteEdited(file);
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    assert.deepEqual(box.git.bytesAt(dest.path), Buffer.from(PNG));
    assert.match(box.git.textAt('Site Log.md'), /!\[\[image-20261029123530322 1\.png\]\]/);
  } finally {
    await box.close();
  }
});

test(vaultPassName('rename moves assets/<old>/ to assets/<new>/ and reuses blob shas'), async () => {
  const box = await vaultPassHarness();
  try {
    await box.download();
    await box.sync.runNow();
    const files = await listFiles(box.db);
    const pngFrom = 'assets/Site Log/image-20261029123530322.png';
    const pdfFrom = 'assets/Site Log/core-notes.pdf';
    const pngSha = box.git.blobShaAt(pngFrom);
    const pdfSha = box.git.blobShaAt(pdfFrom);
    const noteBase = files.find((file) => file.path === 'Site Log.md').baseSha;
    const blobByFrom = Object.fromEntries(
      files.filter((file) => file.kind === 'binary' && file.path.startsWith('assets/Site Log/'))
        .map((file) => [file.path, file.baseSha || box.git.blobShaAt(file.path)]),
    );
    const renamed = planFileRename(files, 'Site Log.md', 'Field Log.md', 50);
    const folders = ['assets', 'assets/Site Log'];
    const moved = planRenameAttachmentFolder(renamed.files, folders, 'Site Log.md', 'Field Log.md', 50);
    const merged = mergePlans(renamed, moved);
    await commitFiles(box.db, { put: merged.put, remove: merged.remove });
    const note = await getFile(box.db, 'Field Log.md');
    await box.sync.noteRenamed({
      from: 'Site Log.md',
      to: 'Field Log.md',
      baseSha: noteBase,
      file: note,
    });
    for (const [from, to] of Object.entries(merged.pathMap)) {
      if (from === 'Site Log.md') continue;
      const file = await getFile(box.db, to);
      await box.sync.noteRenamed({
        from,
        to,
        baseSha: blobByFrom[from],
        file,
      });
    }
    const result = await box.sync.runNow();
    assert.equal(result.status, SYNC_STATUS.synced);
    const pngTo = 'assets/Field Log/image-20261029123530322.png';
    const pdfTo = 'assets/Field Log/core-notes.pdf';
    assert.equal(box.git.blobShaAt(pngTo), pngSha);
    assert.equal(box.git.blobShaAt(pdfTo), pdfSha);
    assert.equal(box.git.blobShaAt(pngFrom), '');
    assert.equal(box.git.blobShaAt('Site Log.md'), '');
    const treeWrite = box.git.state.log.find((item) => item.method === 'POST' && item.path.endsWith('/git/trees'));
    assert.equal(treeWrite.body.tree.some((entry) => entry.path === pngTo && entry.sha === pngSha), true);
    assert.equal(treeWrite.body.tree.some((entry) => entry.path === pngFrom && entry.sha === null), true);
    assert.equal(box.git.state.log.some((item) => item.method === 'POST' && item.path.endsWith('/git/blobs') && item.body?.encoding === 'base64'), false);
  } finally {
    await box.close();
  }
});

test(vaultPassName('a missing blob is skipped without blocking the rest of sync'), async () => {
  const box = await vaultPassHarness();
  try {
    await box.download();
    await box.sync.runNow();
    await box.edit('Daily.md', '# Daily\n\nstill goes up\n');
    await putFile(box.db, {
      path: 'assets/Site Log/mystery.bin',
      content: '',
      kind: 'binary',
      encoding: 'binary',
      bytes: 40,
      createdAt: 1,
      updatedAt: 1,
      trashedAt: null,
      dirty: true,
      origin: 'user',
    });
    await box.sync.noteEdited({
      path: 'assets/Site Log/mystery.bin',
      kind: 'binary',
      dirty: true,
      origin: 'user',
    });
    const result = await box.sync.runNow();
    assert.equal(box.git.textAt('Daily.md'), '# Daily\n\nstill goes up\n');
    assert.equal(box.git.blobShaAt('assets/Site Log/mystery.bin'), '');
    assert.equal((await getFile(box.db, 'Daily.md')).dirty, false);
    assert.equal((await getFile(box.db, 'assets/Site Log/mystery.bin')).dirty, true);
    assert.equal(result.detail, ATTACHMENT_BYTES_MISSING);
    assert.equal(result.status, SYNC_STATUS.failed);
  } finally {
    await box.close();
  }
});

test(vaultPassName('Dataview TASK rollups list #todo tasks and refresh after a toggle'), async () => {
  const box = await vaultPassHarness();
  try {
    await box.download();
    const files = await listFiles(box.db);
    const board = files.find((file) => file.path === 'Board.md');
    const query = boardQuery(board.content);
    const index = createTaskIndex();
    index.rebuild(files);
    const first = runDql(parseDql(query), index);
    assert.equal(first.supported, true);
    const texts = first.groups.flatMap((group) => group.tasks.map((task) => `${group.name}:${task.text}`));
    assert.deepEqual(texts, ['Inbox:Label the trays #todo']);
    assert.equal(first.groups.some((group) => group.name.includes('conflict')), false);

    const inbox = await getFile(box.db, 'Inbox.md');
    const task = index.tasksIn('Inbox.md').find((item) => item.text.includes('Label the trays'));
    const toggled = applyTaskToggle(inbox.content, task);
    assert.match(toggled.content, /- \[x\] Label the trays #todo/);
    await box.edit('Inbox.md', toggled.content);
    index.replace('Inbox.md', toggled.content);
    const second = runDql(parseDql(query), index);
    assert.equal(second.count, 0);
    assert.equal((await box.sync.runNow()).status, SYNC_STATUS.synced);
    assert.match(box.git.textAt('Inbox.md'), /- \[x\] Label the trays #todo/);
    assert.equal(box.git.textAt('Board.md'), board.content);
  } finally {
    await box.close();
  }
});

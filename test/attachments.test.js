import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATTACHMENT_FOLDER,
  attachmentDestination,
  attachmentIcon,
  closestPath,
  embedLinkFor,
  extensionForMime,
  extraAttachmentFiles,
  formatAttachmentStamp,
  formatByteSize,
  makeBinaryFile,
  mergePlans,
  noteAttachmentFolder,
  pastedImageFileName,
  pathDistance,
  planRenameAttachmentFolder,
  shortestWikilink,
  uniqueCollisionPath,
} from '../app/js/attachments.js';
import { resolveEmbedPath } from '../app/js/embeds.js';
import { planFileRename } from '../app/js/organize.js';

test('root and subfolder notes use the v0.0.9 ./assets/${filename} folder', () => {
  assert.equal(ATTACHMENT_FOLDER, './assets/${filename}');
  assert.equal(noteAttachmentFolder('Site Log.md'), 'assets/Site Log');
  assert.equal(noteAttachmentFolder('Site Log.md', './assets/${filename}'), 'assets/Site Log');
  assert.equal(noteAttachmentFolder('Agility Onboarding 2026.md'), 'assets/Agility Onboarding 2026');
  assert.equal(noteAttachmentFolder('Projects/Café Notes.md'), 'Projects/assets/Café Notes');
  assert.equal(noteAttachmentFolder('Field/Deep/Core 7.md'), 'Field/Deep/assets/Core 7');
});

test('pasted names are image-<17-digit local stamp>.<ext> and jpeg becomes jpg', () => {
  const when = new Date(2026, 9, 29, 12, 35, 30, 322);
  assert.equal(formatAttachmentStamp(when).length, 17);
  assert.equal(formatAttachmentStamp(when), '20261029123530322');
  assert.equal(pastedImageFileName(when, 'png'), 'image-20261029123530322.png');
  assert.equal(extensionForMime('image/png'), 'png');
  assert.equal(extensionForMime('image/jpeg'), 'jpg');
  assert.equal(extensionForMime('image/gif'), 'gif');
  assert.equal(extensionForMime('image/webp'), 'webp');
  assert.equal(extensionForMime('image/heic'), 'heic');
  assert.equal(extensionForMime('', 'photo.jpeg'), 'jpg');
});

test('paste and picker rename; dropped files keep their names; collisions use a space suffix', () => {
  const when = new Date(2026, 0, 2, 3, 4, 5, 6);
  const pasted = attachmentDestination('Site Log.md', {
    mime: 'image/png',
    filename: 'image.jpg',
    existingPaths: ['Site Log.md'],
    pasted: true,
    now: when,
  });
  assert.equal(pasted.path, 'assets/Site Log/image-20260102030405006.png');
  assert.equal(pasted.name, 'image-20260102030405006.png');

  const picked = attachmentDestination('Projects/Café Notes.md', {
    mime: 'image/jpeg',
    filename: 'image.jpg',
    existingPaths: ['Projects/Café Notes.md'],
    pasted: true,
    now: when,
  });
  assert.equal(picked.path, 'Projects/assets/Café Notes/image-20260102030405006.jpg');

  const dropped = attachmentDestination('Daily.md', {
    mime: 'image/gif',
    filename: 'noidea.gif',
    existingPaths: ['Daily.md'],
    pasted: false,
    now: when,
  });
  assert.equal(dropped.path, 'assets/Daily/noidea.gif');

  const clash = uniqueCollisionPath('assets/Site Log/image-20260102030405006.png', [
    'assets/Site Log/image-20260102030405006.png',
  ]);
  assert.equal(clash, 'assets/Site Log/image-20260102030405006 1.png');
  assert.equal(
    uniqueCollisionPath('assets/Site Log/image-20260102030405006.png', [
      'assets/Site Log/image-20260102030405006.png',
      'assets/Site Log/image-20260102030405006 1.png',
    ]),
    'assets/Site Log/image-20260102030405006 2.png',
  );
});

test('the inserted wikilink is the shortest unique path', () => {
  assert.equal(shortestWikilink('assets/Site Log/shot.png', ['assets/Site Log/shot.png', 'Note.md']), 'shot.png');
  assert.equal(
    shortestWikilink('assets/Site Log/shot.png', [
      'assets/Site Log/shot.png',
      'other/shot.png',
    ]),
    'Site Log/shot.png',
  );
  assert.equal(
    embedLinkFor('assets/Site Log/image-1.png', ['assets/Site Log/image-1.png', 'Note.md']),
    '![[image-1.png]]',
  );
});

test('ambiguous embeds prefer the file closest to the note', () => {
  const paths = [
    'Meetings/photo.jpg',
    'other/photo.jpg',
    'short/dup.png',
    'assets/much-longer-folder/dup.png',
    'assets/Site Log/pic.png',
    'zz/pic.png',
  ];
  assert.equal(resolveEmbedPath('Meetings/photo.jpg', { notePath: 'Elsewhere.md', paths }), 'Meetings/photo.jpg');
  assert.equal(resolveEmbedPath('unique-only.png', { notePath: 'Note.md', paths: ['folder/unique-only.png'] }), 'folder/unique-only.png');
  assert.equal(resolveEmbedPath('photo.jpg', { notePath: 'Meetings/Weekly.md', paths }), 'Meetings/photo.jpg');
  assert.equal(resolveEmbedPath('dup.png', { notePath: 'Notes.md', paths }), 'short/dup.png');
  assert.equal(
    resolveEmbedPath('pic.png', {
      notePath: 'Site Log.md',
      paths,
      attachmentFolderPath: './assets/${filename}',
    }),
    'assets/Site Log/pic.png',
  );
  assert.equal(
    resolveEmbedPath('pic.png', {
      notePath: 'Elsewhere.md',
      paths: ['zz/pic.png', 'other/deep/pic.png'],
    }),
    'zz/pic.png',
  );
  assert.equal(resolveEmbedPath('missing.png', { notePath: 'Notes.md', paths }), null);
  assert.equal(pathDistance('Meetings/Weekly.md', 'Meetings/photo.jpg'), 0);
  assert.equal(pathDistance('Meetings/Weekly.md', 'other/photo.jpg'), 2);
  assert.equal(closestPath('Meetings/Weekly.md', ['other/photo.jpg', 'Meetings/photo.jpg']), 'Meetings/photo.jpg');
});

test('renaming a note moves assets/<old basename>/ when that folder exists', () => {
  const files = [
    { path: 'Site Log.md', kind: 'markdown', content: '![[shot.png]]\n', trashedAt: null },
    { path: 'assets/Site Log/shot.png', kind: 'binary', content: '', trashedAt: null },
    { path: 'assets/Site Log/noidea.gif', kind: 'binary', content: '', trashedAt: null },
  ];
  const folders = ['assets', 'assets/Site Log'];
  const renamed = planFileRename(files, 'Site Log.md', 'Field Log.md', 50);
  const moved = planRenameAttachmentFolder(renamed.files, folders, 'Site Log.md', 'Field Log.md', 50);
  assert.ok(moved);
  const merged = mergePlans(renamed, moved);
  assert.equal(merged.files.some((file) => file.path === 'Field Log.md'), true);
  assert.equal(merged.files.some((file) => file.path === 'assets/Field Log/shot.png'), true);
  assert.equal(merged.files.some((file) => file.path === 'assets/Field Log/noidea.gif'), true);
  assert.equal(merged.files.some((file) => file.path === 'assets/Site Log/shot.png'), false);
  assert.equal(merged.pathMap['assets/Site Log/shot.png'], 'assets/Field Log/shot.png');
  const skip = planRenameAttachmentFolder(files, folders, 'Other.md', 'Renamed.md', 50);
  assert.equal(skip, null);
});

test('vault index paths become attachment rows without downloading bytes', () => {
  const files = [{ path: 'Site Log.md', kind: 'markdown', content: '', trashedAt: null }];
  const extra = extraAttachmentFiles(files, [
    'Site Log.md',
    'assets/Site Log/shot.png',
    '.obsidian/app.json',
    'assets/Site Log/shot.png',
  ]);
  assert.deepEqual(extra.map((file) => file.path), ['assets/Site Log/shot.png']);
  assert.equal(extra[0].kind, 'binary');
  assert.equal(extra[0].content, '');
  assert.equal(attachmentIcon('assets/Site Log/shot.png'), 'image');
  assert.equal(attachmentIcon('assets/Site Log/notes.pdf'), 'file');
  assert.equal(formatByteSize(1), '1 byte');
  assert.equal(formatByteSize(200), '200 bytes');
  assert.equal(makeBinaryFile('assets/Site Log/shot.png', { bytes: 12, origin: 'user' }).kind, 'binary');
});

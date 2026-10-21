import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attachmentFolderFor,
  embedCandidates,
  listImageEmbeds,
  parseWikilinkImage,
  readAttachmentSetting,
  resolveEmbedPath,
} from '../app/js/embeds.js';
import { renderMarkdown } from '../app/js/markdown.js';

const PATHS = [
  'img.png',
  'a/img.png',
  'assets/Note Name/image-100.png',
  'assets/Other Note/image-200.png',
  'sub/folder/img.png',
  'Meetings/photo.jpg',
  'Meetings/assets/Weekly/shot.png',
  'short/dup.png',
  'assets/much-longer-folder/dup.png',
];

test('resolution prefers an exact path, then the note, then the shortest filename', () => {
  assert.equal(resolveEmbedPath('sub/folder/img.png', { notePath: 'Elsewhere.md', paths: PATHS }), 'sub/folder/img.png');
  assert.equal(resolveEmbedPath('photo.jpg', { notePath: 'Meetings/Weekly.md', paths: PATHS }), 'Meetings/photo.jpg');
  assert.equal(resolveEmbedPath('dup.png', { notePath: 'Notes.md', paths: PATHS }), 'short/dup.png');
  assert.equal(resolveEmbedPath('missing.png', { notePath: 'Notes.md', paths: PATHS }), null);
});

test('a percent-encoded path and the attachment folder are honored', () => {
  const setting = readAttachmentSetting('{"attachmentFolderPath":"./assets/Note Name","alwaysUpdateLinks":true}');
  assert.equal(setting, './assets/Note Name');
  assert.equal(attachmentFolderFor('Weekly.md', setting), 'assets/Note Name');
  assert.equal(attachmentFolderFor('Meetings/Weekly.md', './assets/Weekly'), 'Meetings/assets/Weekly');
  assert.equal(
    resolveEmbedPath('image-100.png', {
      notePath: 'Weekly.md',
      paths: PATHS,
      attachmentFolderPath: './assets/Note Name',
    }),
    'assets/Note Name/image-100.png',
  );
  assert.equal(
    resolveEmbedPath('assets/my%20folder/img.png', {
      notePath: 'Weekly.md',
      paths: ['assets/my folder/img.png', 'img.png'],
    }),
    'assets/my folder/img.png',
  );
  assert.equal(
    resolveEmbedPath('shot.png', {
      notePath: 'Meetings/Weekly.md',
      paths: PATHS,
      attachmentFolderPath: './assets/Weekly',
    }),
    'Meetings/assets/Weekly/shot.png',
  );
});

test('a bare filename is requested from the attachment folder when the list omitted it', () => {
  const setting = './assets/Field Notes';
  assert.equal(attachmentFolderFor('Field Notes.md', setting), 'assets/Field Notes');
  assert.equal(attachmentFolderFor('Field Notes.md', './/assets//Field Notes'), 'assets/Field Notes');
  assert.equal(attachmentFolderFor('Field Notes.md', '/assets/Field Notes'), 'assets/Field Notes');
  assert.equal(attachmentFolderFor('Field Notes.md', './assets/${noteFileName}'), 'assets/Field Notes');
  assert.equal(attachmentFolderFor('Meetings/Field Notes.md', 'assets/${noteFileName}'), 'assets/Field Notes');
  assert.deepEqual(
    embedCandidates('image-1710000000000.png', {
      notePath: 'Field Notes.md',
      attachmentFolderPath: setting,
    }),
    ['image-1710000000000.png', 'assets/Field Notes/image-1710000000000.png'],
  );
  assert.equal(
    resolveEmbedPath('image-1710000000000.png', {
      notePath: 'Field Notes.md',
      paths: ['Field Notes.md', '.obsidian/app.json'],
      attachmentFolderPath: setting,
    }),
    null,
  );
  assert.equal(
    resolveEmbedPath('image-1710000000000.png', {
      notePath: 'Field Notes.md',
      paths: ['Assets/Field Notes/Image-1710000000000.PNG', 'zz/longer/image-1710000000000.png'],
      attachmentFolderPath: setting,
    }),
    'zz/longer/image-1710000000000.png',
  );
  assert.equal(
    resolveEmbedPath('n.png', {
      notePath: 'Field Notes.md',
      paths: ['b/n.png', 'a/n.png'],
    }),
    'a/n.png',
  );
});

test('a root note resolves an embed into an attachment folder whose name has spaces', () => {
  const setting = readAttachmentSetting('{"attachmentFolderPath":"./assets/Field Notes"}');
  assert.equal(setting, './assets/Field Notes');
  assert.equal(attachmentFolderFor('Field Notes.md', setting), 'assets/Field Notes');
  assert.equal(
    resolveEmbedPath('image-1710000000000.png', {
      notePath: 'Field Notes.md',
      paths: [
        'Field Notes.md',
        'assets/Field Notes/image-1710000000000.png',
        '.obsidian/app.json',
      ],
      attachmentFolderPath: setting,
    }),
    'assets/Field Notes/image-1710000000000.png',
  );
});

test('wikilink size syntax and markdown images do not leave a broken source', () => {
  const sized = renderMarkdown('![[img.png|300]]\n\n![[img.png|300x200]]\n\n![[sub/folder/img.png]]\n');
  assert.match(sized, /data-embed="img.png" data-width="300"/);
  assert.match(sized, /data-embed="img.png" data-width="300" data-height="200"/);
  assert.match(sized, /data-embed="sub\/folder\/img.png"/);
  assert.equal(sized.includes('<img'), false);
  assert.match(sized, /class="embed-fallback">img\.png</);
  assert.equal(parseWikilinkImage('img.png|300x200').height, 200);

  const encoded = renderMarkdown('![room](my%20folder/img.png)');
  assert.match(encoded, /data-embed="my folder\/img.png"/);
  assert.match(encoded, /class="embed-fallback">img\.png</);
  assert.equal(encoded.includes('%20'), false);
  assert.equal(encoded.includes('src='), false);

  const remote = renderMarkdown('![see (this): note](https://example.com/a.png)\n\n![300](https://example.com/b.png)');
  assert.match(remote, /alt="see \(this\): note" src="https:\/\/example\.com\/a\.png"/);
  assert.match(remote, /src="https:\/\/example\.com\/b\.png" style="width:300px"/);
  assert.equal(remote.includes('api.github.com'), false);

  const data = renderMarkdown('![\u200bicon](data:image/png;base64,aaaa)');
  assert.match(data, /src="data:image\/png;base64,aaaa"/);

  const missing = renderMarkdown('![[nope.png]]\n\n![gone](folder/nope.jpg)\n\n![[scan.heic]]');
  assert.equal(missing.includes('<img'), false);
  assert.equal(missing.includes('src='), false);
  assert.match(missing, /embed-fallback">nope\.png</);
  assert.match(missing, /embed-fallback">nope\.jpg</);
  assert.match(missing, /embed-fallback">scan\.heic</);
  assert.equal(missing.includes('data-embed="scan.heic"'), false);
});

test('both image embed forms are collected and code is not', () => {
  const found = listImageEmbeds([
    '![[image-1710000000000.png|300]]',
    '![diagram](figures/diagram.svg)',
    '![remote](https://example.com/a.png)',
    '`![[coded.png]]`',
    '```',
    '![[hidden.png]]',
    '```',
    '![[scan.heic]]',
  ].join('\n'));
  assert.deepEqual(found, [
    { link: 'image-1710000000000.png', raw: 'image-1710000000000.png|300' },
    { link: 'figures/diagram.svg', raw: 'figures/diagram.svg' },
  ]);
});

test('a token and a javascript url never appear in an embed src', () => {
  const token = 'gho_testtokenvalue123456';
  const html = renderMarkdown('![[img.png]]\n\n![x](https://example.com/a.png)\n\n![click](javascript:alert(1))');
  assert.equal(html.includes(token), false);
  assert.equal(html.includes('api.github.com'), false);
  assert.equal(html.includes('javascript:'), false);
  assert.equal(html.includes('Authorization'), false);
});

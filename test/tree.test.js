import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listBrowser, rememberRecent } from '../app/js/browser.js';
import { folderDestination } from '../app/js/organize.js';

const files = [
  { path: 'e.md', kind: 'markdown', content: '# Root\n', trashedAt: null },
  { path: 'a/d.md', kind: 'markdown', content: '# Dee\n', trashedAt: null },
  { path: 'a/b/c.md', kind: 'markdown', content: '# See\n', trashedAt: null },
  { path: 'a/b/gone.md', kind: 'markdown', content: '# Gone\n', trashedAt: 10 },
];

test('the browser nests folders and hides collapsed children', () => {
  const open = listBrowser({
    files,
    folders: ['empty'],
    expanded: ['a', 'a/b'],
    recent: [],
    query: '',
    currentPath: 'a/b/c.md',
  });
  const kinds = open.map((row) => `${row.type}:${row.path || row.text || ''}`);
  assert.ok(kinds.includes('folder:a'));
  assert.ok(kinds.includes('folder:a/b'));
  assert.ok(kinds.includes('folder:empty'));
  assert.ok(kinds.includes('note:a/d.md'));
  assert.ok(kinds.includes('note:a/b/c.md'));
  assert.ok(kinds.includes('note:e.md'));
  assert.equal(kinds.includes('note:a/b/gone.md'), false);
  const nested = open.find((row) => row.path === 'a/b/c.md');
  assert.equal(nested.depth, 2);
  assert.equal(nested.current, true);
  assert.equal(nested.title, 'c');
  const empty = open.find((row) => row.path === 'empty');
  assert.equal(empty.type, 'folder');
  assert.equal(empty.open, false);

  const closed = listBrowser({
    files,
    folders: ['empty'],
    expanded: [],
    recent: [],
    query: '',
    currentPath: '',
  });
  assert.equal(closed.some((row) => row.path === 'a/d.md'), false);
  assert.equal(closed.some((row) => row.path === 'a'), true);
});

test('a new folder is a path, not a second copy of a note', () => {
  const path = folderDestination('', 'Field work', []);
  assert.equal(path, 'Field work');
  assert.equal(folderDestination('Field work', 'Cores', [path]), 'Field work/Cores');
  assert.throws(() => folderDestination('', 'Field work', [path]), /already exists/);
  assert.throws(() => folderDestination('', 'notes.md', []), /\.md/);
});

test('the tree lists attachments with their filename and a type icon', () => {
  const rows = listBrowser({
    files: [
      { path: 'Site Log.md', kind: 'markdown', content: '# Site\n', trashedAt: null },
      { path: 'assets/Site Log/shot.png', kind: 'binary', content: '', trashedAt: null },
      { path: 'assets/Site Log/notes.pdf', kind: 'binary', content: '', trashedAt: null },
    ],
    folders: ['assets', 'assets/Site Log'],
    expanded: ['assets', 'assets/Site Log'],
    recent: [],
    query: '',
    currentPath: 'Site Log.md',
  });
  const shot = rows.find((row) => row.path === 'assets/Site Log/shot.png');
  const pdf = rows.find((row) => row.path === 'assets/Site Log/notes.pdf');
  assert.equal(shot.type, 'attachment');
  assert.equal(shot.title, 'shot.png');
  assert.equal(shot.icon, 'image');
  assert.equal(pdf.type, 'attachment');
  assert.equal(pdf.title, 'notes.pdf');
  assert.equal(pdf.icon, 'file');

  const fromIndex = listBrowser({
    files: [{ path: 'Site Log.md', kind: 'markdown', content: '', trashedAt: null }],
    folders: [],
    expanded: ['assets', 'assets/Site Log'],
    recent: [],
    query: '',
    currentPath: '',
    extraPaths: ['assets/Site Log/shot.png', 'Site Log.md'],
  });
  assert.equal(fromIndex.some((row) => row.path === 'assets/Site Log/shot.png' && row.type === 'attachment'), true);
});

test('recent notes stay in open order and drop duplicates', () => {
  assert.deepEqual(rememberRecent(['b.md', 'a.md'], 'a.md'), ['a.md', 'b.md']);
  assert.equal(rememberRecent(['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md'], 'i.md').length, 8);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listBrowser, NO_MATCHES, searchNotes, vaultSummary } from '../app/js/browser.js';

const files = [
  { path: 'Welcome.md', kind: 'markdown', content: '# Welcome\n\nclay strata', trashedAt: null },
  { path: 'logs/Core.md', kind: 'markdown', content: '# Not the filename\n\nquartz vein', trashedAt: null },
  { path: 'logs/Hidden.md', kind: 'markdown', content: '# Hidden\n\nclay in trash', trashedAt: 4 },
];

test('search matches a filename or the note text and skips trash', () => {
  const byName = searchNotes(files, 'core');
  assert.equal(byName.length, 1);
  assert.equal(byName[0].path, 'logs/Core.md');
  assert.equal(byName[0].title, 'Core');
  assert.equal(byName[0].kind, 'name');

  const byText = searchNotes(files, 'quartz');
  assert.equal(byText[0].kind, 'content');
  assert.match(byText[0].snippet, /quartz/);

  const hidden = searchNotes(files, 'trash');
  assert.equal(hidden.length, 0);

  const rows = listBrowser({
    files,
    folders: [],
    expanded: [],
    recent: [],
    query: 'clay',
    currentPath: 'Welcome.md',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, 'Welcome.md');
  assert.equal(rows[0].title, 'Welcome');
  const named = listBrowser({
    files,
    folders: [],
    expanded: ['logs'],
    recent: ['logs/Core.md'],
    query: '',
    currentPath: '',
  });
  assert.equal(named.find((row) => row.path === 'logs/Core.md').title, 'Core');
  assert.equal(named.some((row) => row.title === 'Not the filename'), false);
  assert.equal(rows.some((row) => row.type === 'trash'), false);
});

test('match case narrows names and text, and text search can be turned off', () => {
  assert.equal(searchNotes(files, 'Core', { matchCase: true }).length, 1);
  assert.equal(searchNotes(files, 'CORE', { matchCase: true }).length, 0);
  assert.equal(searchNotes(files, 'CORE').length, 1);
  assert.equal(searchNotes(files, 'Quartz', { matchCase: true }).length, 0);
  assert.equal(searchNotes(files, 'quartz', { matchCase: true })[0].snippet.includes('quartz'), true);
  assert.equal(searchNotes(files, 'quartz', { content: false }).length, 0);
  assert.equal(searchNotes(files, 'core', { content: false }).length, 1);
});

test('a search with no hits says No matches found.', () => {
  const rows = listBrowser({ files, folders: [], expanded: [], recent: [], query: 'basalt', currentPath: '' });
  assert.deepEqual(rows, [{ type: 'empty', text: NO_MATCHES }]);
  assert.equal(NO_MATCHES, 'No matches found.');
  const cased = listBrowser({ files, folders: [], expanded: [], recent: [], query: 'CLAY', currentPath: '', matchCase: true });
  assert.equal(cased[0].text, NO_MATCHES);
});

test('the vault summary counts live notes and their folders', () => {
  const summary = vaultSummary([
    ...files,
    { path: '.obsidian/app.md', kind: 'markdown', content: '', trashedAt: null },
    { path: 'a/b/Deep.md', kind: 'markdown', content: '', trashedAt: null },
  ], ['Empty', '.trash']);
  assert.equal(summary.files, 3);
  assert.deepEqual([summary.folders, summary.text], [4, '3 files, 4 folders']);
  assert.equal(vaultSummary([files[0]], []).text, '1 file, 0 folders');
});

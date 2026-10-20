import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listBrowser, searchNotes } from '../app/js/browser.js';

const files = [
  { path: 'Welcome.md', kind: 'markdown', content: '# Welcome\n\nclay strata', trashedAt: null },
  { path: 'logs/Core.md', kind: 'markdown', content: '# Core\n\nquartz vein', trashedAt: null },
  { path: 'logs/Hidden.md', kind: 'markdown', content: '# Hidden\n\nclay in trash', trashedAt: 4 },
];

test('search matches a filename or the note text and skips trash', () => {
  const byName = searchNotes(files, 'core');
  assert.equal(byName.length, 1);
  assert.equal(byName[0].path, 'logs/Core.md');
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
  assert.equal(rows.some((row) => row.type === 'trash'), false);
});

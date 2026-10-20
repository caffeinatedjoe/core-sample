import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBackup, mergeBackup, parseBackup } from '../app/js/backup.js';

function file(path, content, extra = {}) {
  return {
    path,
    content,
    kind: 'markdown',
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 2,
    trashedAt: null,
    ...extra,
  };
}

test('export and import round-trip without dropping text, trash, or folders', () => {
  const files = [
    file('Welcome.md', '# Welcome\n\n日本語 🌧️'),
    file('Work/Core.md', '# Core\n\n- [ ] sample', { trashedAt: 9, updatedAt: 9 }),
  ];
  const backup = buildBackup(files, {
    folders: ['Work', 'Empty'],
    lastOpened: 'Welcome.md',
    editorMode: 'preview',
    recent: ['Welcome.md'],
  }, 50);
  const parsed = parseBackup(JSON.stringify(backup));
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[1].path, 'Work/Core.md');
  assert.equal(parsed.files[1].content, '# Core\n\n- [ ] sample');
  assert.equal(parsed.files[1].trashedAt, 9);
  assert.equal(parsed.files[0].content, '# Welcome\n\n日本語 🌧️');
  assert.deepEqual(parsed.folders, ['Empty', 'Work']);
  assert.equal(parsed.lastOpened, 'Welcome.md');
  assert.equal(parsed.editorMode, 'preview');
  assert.deepEqual(parsed.recent, ['Welcome.md']);
  assert.throws(() => parseBackup('{"format":"other"}'), /not a Core Sample backup/);
});

test('adding a backup keeps notes that exist only on one side', () => {
  const local = [file('Local.md', 'keep me'), file('Shared.md', 'device copy')];
  const backup = parseBackup(JSON.stringify(buildBackup([
    file('Shared.md', 'backup copy'),
    file('Imported.md', 'from the file'),
  ], { folders: ['Field'] })));
  const merged = mergeBackup(local, [], backup);
  assert.equal(merged.files.find((item) => item.path === 'Local.md').content, 'keep me');
  assert.equal(merged.files.find((item) => item.path === 'Shared.md').content, 'device copy');
  assert.equal(merged.files.find((item) => item.path === 'Imported.md').content, 'from the file');
  const aside = merged.files.find((item) => item.path === 'Shared (imported).md');
  assert.equal(aside.content, 'backup copy');
  assert.deepEqual(merged.keptAside, [{ from: 'Shared.md', path: 'Shared (imported).md' }]);
  assert.deepEqual(merged.folders, ['Field']);
  assert.equal(merged.put.some((item) => item.path === 'Local.md'), false);
});

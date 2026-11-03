import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTaskToggle,
  extractTags,
  listNoteTasks,
  noteTags,
  parseTaskLine,
} from '../app/js/tasks.js';

test('parses dash, star, plus, numbered, and nested tab tasks', () => {
  const src = [
    '- [ ] top',
    '* [x] star',
    '+ [X] plus',
    '1. [ ] numbered',
    '2) [ ] paren',
    '\t- [ ] child',
    '    - [ ] spaces',
    '> - [ ] quoted',
  ].join('\n');
  const tasks = listNoteTasks(src, 'Lab.md');
  assert.deepEqual(tasks.map((task) => ({
    text: task.text, status: task.status, completed: task.completed, indent: task.indent, parent: task.parent,
  })), [
    { text: 'top', status: ' ', completed: false, indent: 0, parent: null },
    { text: 'star', status: 'x', completed: true, indent: 0, parent: null },
    { text: 'plus', status: 'X', completed: true, indent: 0, parent: null },
    { text: 'numbered', status: ' ', completed: false, indent: 0, parent: null },
    { text: 'paren', status: ' ', completed: false, indent: 0, parent: null },
    { text: 'child', status: ' ', completed: false, indent: 4, parent: 4 },
    { text: 'spaces', status: ' ', completed: false, indent: 4, parent: 4 },
    { text: 'quoted', status: ' ', completed: false, indent: 0, parent: null },
  ]);
  assert.equal(parseTaskLine('- [/] custom').completed, false);
  assert.equal(parseTaskLine('- [/] custom').checked, true);
});

test('skips fenced lines and records tags, path, and fullyCompleted', () => {
  const src = [
    '- [x] parent #todo',
    '\t- [x] child #todo',
    '\t- [ ] open',
    '```',
    '- [ ] fake #todo',
    '```',
    '- [ ] sibling #later',
  ].join('\n');
  const tasks = listNoteTasks(src, 'Projects/Plan.md');
  assert.deepEqual(tasks.map((task) => task.text), ['parent #todo', 'child #todo', 'open', 'sibling #later']);
  assert.equal(tasks[0].fullyCompleted, false);
  assert.equal(tasks[1].fullyCompleted, true);
  assert.equal(tasks[0].path, 'Projects/Plan.md');
  assert.equal(tasks[0].file.name, 'Plan');
  assert.deepEqual(tasks[0].tags, ['#todo']);
  assert.deepEqual(extractTags('Buy milk #todo #todo/work'), ['#todo', '#todo/work']);
});

test('noteTags include body tags and frontmatter tags, not fenced ones', () => {
  const src = '---\ntags: [alpha, beta]\n---\n# Heading #inbox\n```\n#fenced\n```\n- [ ] item #todo\n';
  const tags = noteTags(src);
  assert.ok(tags.includes('#alpha'));
  assert.ok(tags.includes('#beta'));
  assert.ok(tags.includes('#inbox'));
  assert.ok(tags.includes('#todo'));
  assert.equal(tags.includes('#fenced'), false);
});

test('toggle flips one status character and keeps CRLF, tabs, and trailing spaces', () => {
  const src = '- [ ] keep #todo  \r\n\t- [x] nested\r\n';
  const next = applyTaskToggle(src, { line: 0, text: 'keep #todo  ', status: ' ' });
  assert.equal(next.error, undefined);
  assert.equal(next.content, '- [x] keep #todo  \r\n\t- [x] nested\r\n');
  assert.equal(next.content.length, src.length);
  const back = applyTaskToggle(next.content, { line: 1, text: 'nested', status: 'x' });
  assert.equal(back.content, '- [x] keep #todo  \r\n\t- [ ] nested\r\n');
  assert.equal(back.content.length, src.length);
});

test('relocates by text when the original line moved, and refuses a duplicate', () => {
  const moved = '# Head\n\n- [ ] sample #todo\n';
  const found = applyTaskToggle(moved, { line: 0, text: 'sample #todo' });
  assert.equal(found.content, '# Head\n\n- [x] sample #todo\n');

  const gone = applyTaskToggle('- [ ] other\n', { line: 0, text: 'sample #todo' });
  assert.equal(gone.content, '- [ ] other\n');
  assert.match(gone.error, /gone/);

  const dup = applyTaskToggle('- [ ] sample #todo\n- [ ] sample #todo\n', { line: 5, text: 'sample #todo' });
  assert.equal(dup.content, '- [ ] sample #todo\n- [ ] sample #todo\n');
  assert.match(dup.error, /moved/);
});

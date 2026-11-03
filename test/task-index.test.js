import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskIndex, isIndexableNote } from '../app/js/task-index.js';

function notes() {
  return [
    { path: 'Inbox.md', content: '- [ ] Buy milk #todo\n- [x] Done #todo\n' },
    { path: 'Projects/Plan.md', content: '- [ ] Write summary #todo\n' },
  ];
}

test('rebuilds from notes and updates only the paths that change', () => {
  const index = createTaskIndex();
  index.rebuild(notes());
  assert.equal(index.tasks().length, 3);
  assert.equal(index.notes().length, 2);

  index.replace('Inbox.md', '- [ ] Buy milk #todo\n');
  assert.deepEqual(index.tasks().map((task) => `${task.path}:${task.text}`), [
    'Inbox.md:Buy milk #todo',
    'Projects/Plan.md:Write summary #todo',
  ]);

  index.remove('Projects/Plan.md');
  assert.equal(index.tasks().length, 1);
  assert.equal(index.tasks()[0].path, 'Inbox.md');

  index.rename('Inbox.md', 'Desk.md', '- [ ] Buy milk #todo\n- [ ] Extra #todo\n');
  assert.deepEqual(index.tasks().map((task) => `${task.path}:${task.text}`), [
    'Desk.md:Buy milk #todo',
    'Desk.md:Extra #todo',
  ]);
  assert.equal(index.tasksIn('Inbox.md').length, 0);
});

test('rebuild replaces the whole index, including an empty vault', () => {
  const index = createTaskIndex();
  index.rebuild(notes());
  index.rebuild([]);
  assert.equal(index.tasks().length, 0);
  assert.equal(index.notes().length, 0);
});

test('conflict copies, backup copies, and other leftover copies stay out of the index', () => {
  const task = '- [ ] Buy milk #todo\n';
  const live = { path: 'Inbox.md', content: task, kind: 'markdown' };
  const conflict = {
    path: 'Inbox (conflict 2026-10-20 1718).md',
    content: task,
    kind: 'markdown',
    conflictCopy: true,
  };
  const backup = {
    path: 'Inbox (backup 2026-10-20 1718).md',
    content: task,
    kind: 'markdown',
    backup: true,
    conflictCopy: true,
  };
  const imported = { path: 'Inbox (imported).md', content: task, kind: 'markdown' };
  const named = { path: 'Inbox (conflict 2026-10-21 1918-2).md', content: task, kind: 'markdown' };

  assert.equal(isIndexableNote(live), true);
  assert.equal(isIndexableNote(conflict), false);
  assert.equal(isIndexableNote(backup), false);
  assert.equal(isIndexableNote(imported), false);
  assert.equal(isIndexableNote(named), false);

  const index = createTaskIndex();
  index.rebuild([live, conflict, backup, imported, named]);
  assert.deepEqual(index.tasks().map((item) => item.path), ['Inbox.md']);

  index.replace(conflict.path, conflict.content);
  assert.equal(index.tasksIn(conflict.path).length, 0);
  index.replace(live.path, live.content);
  assert.equal(index.tasks().length, 1);
});

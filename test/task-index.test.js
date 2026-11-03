import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskIndex } from '../app/js/task-index.js';

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

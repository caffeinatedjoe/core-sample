import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDebouncedSaver } from '../app/js/save.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('flush stores the latest edit and does not write again when the timer fires', async () => {
  const writes = [];
  let content = 'a';
  const saver = createDebouncedSaver({
    delay: 40,
    write(note) {
      writes.push(note.content);
      return Promise.resolve();
    },
  });
  saver.schedule(() => ({ content, path: 'Welcome.md' }));
  content = 'abc';
  saver.schedule(() => ({ content, path: 'Welcome.md' }));
  assert.equal(writes.length, 0);
  assert.equal(saver.pending, true);
  await saver.flush();
  await wait(70);
  assert.deepEqual(writes, ['abc']);
  assert.equal(saver.pending, false);
});

test('a pause writes the latest edit once', async () => {
  const writes = [];
  let content = 'a';
  const saver = createDebouncedSaver({
    delay: 30,
    write(note) {
      writes.push(note.content);
      return Promise.resolve();
    },
  });
  saver.schedule(() => ({ content }));
  content = 'ab';
  saver.schedule(() => ({ content }));
  await wait(50);
  assert.deepEqual(writes, ['ab']);
});

test('a failed write stays pending so the next flush can retry', async () => {
  const writes = [];
  const statuses = [];
  let fail = true;
  const saver = createDebouncedSaver({
    delay: 1000,
    write(note) {
      if (fail) return Promise.reject(new Error('quota'));
      writes.push(note.content);
      return Promise.resolve();
    },
    onStatus(state) {
      statuses.push(state);
    },
  });
  let content = 'keep me';
  saver.schedule(() => ({ content }));
  await assert.rejects(() => saver.flush(), /quota/);
  assert.equal(saver.pending, true);
  assert.equal(statuses.at(-1), 'error');
  fail = false;
  content = 'keep me still';
  await saver.flush();
  assert.deepEqual(writes, ['keep me still']);
  assert.equal(saver.pending, false);
  assert.equal(statuses.at(-1), 'saved');
});

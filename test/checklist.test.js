import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listTasks, toggleChecklist } from '../app/js/checklist.js';

test('toggles one checkbox and leaves the rest of the note alone', () => {
  const src = 'Café ☕️\n- [ ] beans\n- [x] water\n';
  const next = toggleChecklist(src, 0);
  assert.equal(next.length, src.length);
  assert.equal(next, 'Café ☕️\n- [x] beans\n- [x] water\n');
  const back = toggleChecklist(next, 1);
  assert.equal(back.length, next.length);
  assert.equal(back, 'Café ☕️\n- [x] beans\n- [ ] water\n');
});

test('clears a capital X without changing length', () => {
  const src = '  - [X] sample';
  const next = toggleChecklist(src, 0);
  assert.equal(next, '  - [ ] sample');
  assert.equal(next.length, src.length);
});

test('ignores tasks inside fenced code and only flips the asked index', () => {
  const src = '- [ ] real\n```js\n- [ ] fake\n```\n- [ ] also\n';
  assert.deepEqual(listTasks(src).map((task) => task.text), ['real', 'also']);
  assert.equal(toggleChecklist(src, 1), '- [ ] real\n```js\n- [ ] fake\n```\n- [x] also\n');
  assert.equal(toggleChecklist(src, 5), src);
});

test('preserves a wide gap between the bullet and the box', () => {
  const src = '-  [ ] spaced';
  assert.equal(toggleChecklist(src, 0), '-  [x] spaced');
});

test('does not treat a tilde fence as closed by backticks', () => {
  const src = '~~~\n- [ ] inside\n```\n- [ ] still inside\n~~~\n- [ ] outside\n';
  assert.deepEqual(listTasks(src).map((task) => task.text), ['outside']);
  assert.equal(
    toggleChecklist(src, 0),
    '~~~\n- [ ] inside\n```\n- [ ] still inside\n~~~\n- [x] outside\n',
  );
});

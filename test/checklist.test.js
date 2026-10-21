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

test('flips the asked nested line when the words are identical', () => {
  const src = '- [ ] item text\n\t- [ ] item text\n- [ ] item text\n';
  assert.equal(
    toggleChecklist(src, 1),
    '- [ ] item text\n\t- [x] item text\n- [ ] item text\n',
  );
  assert.equal(
    toggleChecklist(src, 0),
    '- [x] item text\n\t- [ ] item text\n- [ ] item text\n',
  );
  assert.equal(
    toggleChecklist(src, 2),
    '- [ ] item text\n\t- [ ] item text\n- [x] item text\n',
  );
});

test('keeps a tab-and-spaces indent byte for byte', () => {
  const src = '- item text\n\t    - [ ] item text\n\t- [x] item text\n';
  const next = toggleChecklist(src, 0);
  assert.equal(next, '- item text\n\t    - [x] item text\n\t- [x] item text\n');
  assert.equal(next.split('\n')[1].slice(0, 5), '\t    ');
  const back = toggleChecklist(next, 1);
  assert.equal(back, '- item text\n\t    - [x] item text\n\t- [ ] item text\n');
  assert.equal(back.length, src.length);
});

test('toggles an empty nested box without eating the indent', () => {
  const src = '- [ ] \n\t- [ ]\n';
  assert.equal(toggleChecklist(src, 1), '- [ ] \n\t- [x]\n');
  assert.deepEqual(listTasks(src).map((task) => task.line), [0, 1]);
});

test('does not treat a tilde fence as closed by backticks', () => {
  const src = '~~~\n- [ ] inside\n```\n- [ ] still inside\n~~~\n- [ ] outside\n';
  assert.deepEqual(listTasks(src).map((task) => task.text), ['outside']);
  assert.equal(
    toggleChecklist(src, 0),
    '~~~\n- [ ] inside\n```\n- [ ] still inside\n~~~\n- [x] outside\n',
  );
});

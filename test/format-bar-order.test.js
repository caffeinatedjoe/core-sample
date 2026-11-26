import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FORMAT_BAR_ORDER,
  FORMAT_BAR_ORDER_KEY,
  mergeFormatBarOrder,
  moveItem,
  neighborTransforms,
  readFormatBarOrder,
  targetDropIndex,
  writeFormatBarOrder,
} from '../app/js/format-bar-order.js';

test('mergeFormatBarOrder keeps saved ids, drops unknown, appends new defaults', () => {
  const saved = ['bold', 'italic', 'bogus', 'bold', 'task', 'removed'];
  assert.deepEqual(mergeFormatBarOrder(saved), [
    'bold',
    'italic',
    'task',
    'bullet',
    'numbered',
    'link',
    'image',
    'heading',
    'indent',
    'outdent',
    'lineUp',
    'lineDown',
    'quote',
    'code',
    'strike',
    'fence',
    'highlight',
    'comment',
    'rule',
    'undo',
    'redo',
  ]);
});

test('mergeFormatBarOrder with no save returns defaults', () => {
  assert.deepEqual(mergeFormatBarOrder(null), DEFAULT_FORMAT_BAR_ORDER);
  assert.deepEqual(mergeFormatBarOrder([]), DEFAULT_FORMAT_BAR_ORDER);
});

test('targetDropIndex picks the slot under the pointer', () => {
  const centers = [22, 66, 110, 154];
  assert.equal(targetDropIndex(0, centers, 10), 0);
  assert.equal(targetDropIndex(0, centers, 45), 1);
  assert.equal(targetDropIndex(1, centers, 35), 0);
  assert.equal(targetDropIndex(1, centers, 95), 2);
  assert.equal(targetDropIndex(2, centers, 200), 3);
});

test('neighborTransforms shifts only the items between from and to', () => {
  assert.deepEqual(neighborTransforms(4, 1, 3, 44), [0, 0, -44, -44]);
  assert.deepEqual(neighborTransforms(4, 3, 0, 44), [44, 44, 44, 0]);
  assert.deepEqual(neighborTransforms(4, 1, 1, 44), [0, 0, 0, 0]);
});

test('moveItem reorders an array like a toolbar commit', () => {
  const order = ['task', 'bold', 'italic', 'link'];
  assert.deepEqual(moveItem(order, 1, 3), ['task', 'italic', 'link', 'bold']);
  assert.deepEqual(moveItem(order, 3, 0), ['link', 'task', 'bold', 'italic']);
});

test('localStorage round-trip uses the versioned key', () => {
  const storage = new Map();
  const shim = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
  };
  writeFormatBarOrder(['bold', 'task'], shim);
  assert.equal(storage.get(FORMAT_BAR_ORDER_KEY), '["bold","task"]');
  assert.deepEqual(readFormatBarOrder(shim), ['bold', 'task']);
});
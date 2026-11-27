import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FORMAT_BAR_LAYOUT,
  DEFAULT_FORMAT_BAR_ORDER,
  FORMAT_BAR_LAYOUT_KEY,
  FORMAT_BAR_ORDER_KEY,
  applyTileMove,
  mergeFormatBarLayout,
  migrateFormatBarLayoutFromV1,
  moveItem,
  neighborTransforms,
  readFormatBarLayout,
  resetFormatBarLayout,
  targetDropIndex,
  targetHiddenFrom,
  stabilizeGridDropIndex,
  stabilizeHiddenFrom,
  resolveIntoHidden,
  visibleBarOrder,
  writeFormatBarLayout,
  writeFormatBarOrder,
} from '../app/js/format-bar-order.js';

test('mergeFormatBarLayout keeps saved order and appends unknown defaults before hiddenFrom', () => {
  const saved = { order: ['bold', 'italic'], hiddenFrom: 1 };
  const merged = mergeFormatBarLayout(saved);
  assert.equal(merged.order[0], 'bold');
  assert.ok(merged.hiddenFrom >= 1);
  assert.ok(merged.order.length === DEFAULT_FORMAT_BAR_ORDER.length);
  for (const id of DEFAULT_FORMAT_BAR_ORDER) assert.ok(merged.order.includes(id));
});

test('mergeFormatBarLayout with no save returns defaults with nothing hidden', () => {
  assert.deepEqual(mergeFormatBarLayout(null), DEFAULT_FORMAT_BAR_LAYOUT);
});

test('visibleBarOrder excludes hidden ids', () => {
  const layout = { order: ['bold', 'italic', 'task'], hiddenFrom: 1 };
  assert.deepEqual(visibleBarOrder(layout), ['bold']);
});

test('migrateFormatBarLayoutFromV1 moves order to v2 and clears v1', () => {
  const storage = new Map();
  const shim = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    },
  };
  writeFormatBarOrder(['bold', 'task', 'italic'], shim);
  const migrated = migrateFormatBarLayoutFromV1(shim);
  assert.ok(migrated);
  assert.equal(storage.has(FORMAT_BAR_ORDER_KEY), false);
  assert.ok(storage.get(FORMAT_BAR_LAYOUT_KEY));
  assert.deepEqual(readFormatBarLayout(shim).order.slice(0, 3), ['bold', 'task', 'italic']);
});

test('resetFormatBarLayout shows every default control', () => {
  const layout = resetFormatBarLayout();
  assert.deepEqual(layout.order, DEFAULT_FORMAT_BAR_ORDER);
  assert.equal(layout.hiddenFrom, DEFAULT_FORMAT_BAR_ORDER.length);
});

test('applyTileMove moves into hidden without breaking hiddenFrom', () => {
  const layout = {
    order: ['task', 'bold', 'italic', 'link'],
    hiddenFrom: 2,
  };
  const next = applyTileMove(layout, 0, 3);
  assert.equal(next.order[2], 'task');
  assert.equal(next.hiddenFrom, 1);
});

test('applyTileMove can hide when all were shown and drop is below divider', () => {
  const layout = {
    order: DEFAULT_FORMAT_BAR_ORDER.slice(),
    hiddenFrom: DEFAULT_FORMAT_BAR_ORDER.length,
  };
  const next = applyTileMove(layout, 3, layout.order.length, { intoHidden: true });
  assert.equal(next.hiddenFrom, next.order.length - 1);
  assert.equal(visibleBarOrder(next).includes('bold'), false);
});

test('applyTileMove pulls from hidden to shown', () => {
  const layout = { order: ['task', 'bold', 'italic'], hiddenFrom: 1 };
  const next = applyTileMove(layout, 2, 0);
  assert.equal(next.order[0], 'italic');
  assert.equal(next.hiddenFrom, 2);
});

test('targetDropIndex picks the slot under the pointer', () => {
  const centers = [22, 66, 110, 154];
  assert.equal(targetDropIndex(0, centers, 10), 0);
  assert.equal(targetDropIndex(0, centers, 45), 1);
});

test('neighborTransforms shifts only the items between from and to', () => {
  assert.deepEqual(neighborTransforms(4, 1, 3, 44), [0, 0, -44, -44]);
});

test('moveItem reorders an array like a toolbar commit', () => {
  const order = ['task', 'bold', 'italic', 'link'];
  assert.deepEqual(moveItem(order, 1, 3), ['task', 'italic', 'bold', 'link']);
});

test('targetHiddenFrom tracks pointer Y across tile rows', () => {
  const cells = [
    { index: 0, top: 0, height: 64, width: 70, left: 0 },
    { index: 1, top: 0, height: 64, width: 70, left: 80 },
    { index: 2, top: 72, height: 64, width: 70, left: 0 },
  ];
  assert.equal(targetHiddenFrom(3, cells, 20), 0);
  assert.equal(targetHiddenFrom(3, cells, 90), 2);
  assert.equal(targetHiddenFrom(3, cells, 200), 3);
});

test('stabilizeGridDropIndex holds until slop into the next cell', () => {
  const cells = [
    { index: 0, top: 0, height: 64, width: 70, left: 0 },
    { index: 1, top: 0, height: 64, width: 70, left: 80 },
    { index: 2, top: 72, height: 64, width: 70, left: 0 },
  ];
  const proposed = stabilizeGridDropIndex(cells, 42, 20, 0, 0, {});
  assert.equal(proposed, 0);
  const crossed = stabilizeGridDropIndex(cells, 48, 20, 0, 0, {});
  assert.equal(crossed, 1);
});

test('resolveIntoHidden uses divider midline hysteresis', () => {
  const mid = 100;
  assert.equal(resolveIntoHidden(90, mid, false), false);
  assert.equal(resolveIntoHidden(113, mid, false), true);
  assert.equal(resolveIntoHidden(90, mid, true), true);
  assert.equal(resolveIntoHidden(85, mid, true), false);
});

test('stabilizeHiddenFrom only moves split past row midline slop', () => {
  const cells = [
    { index: 0, top: 0, height: 64, width: 70, left: 0 },
    { index: 1, top: 72, height: 64, width: 70, left: 0 },
    { index: 2, top: 144, height: 64, width: 70, left: 0 },
  ];
  assert.equal(stabilizeHiddenFrom(3, cells, 40, 0), 0);
  assert.equal(stabilizeHiddenFrom(3, cells, 48, 0), 1);
  assert.equal(stabilizeHiddenFrom(3, cells, 48, 1), 1);
});

test('layout round-trip uses the v2 key', () => {
  const storage = new Map();
  const shim = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    },
  };
  writeFormatBarLayout({ order: ['bold', 'task'], hiddenFrom: 1 }, shim);
  assert.equal(storage.get(FORMAT_BAR_LAYOUT_KEY), '{"order":["bold","task"],"hiddenFrom":1}');
  assert.deepEqual(readFormatBarLayout(shim), { order: ['bold', 'task'], hiddenFrom: 1 });
});
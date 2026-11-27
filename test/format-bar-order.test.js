import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FORMAT_BAR_LAYOUT,
  DEFAULT_FORMAT_BAR_ORDER,
  FORMAT_BAR_DIVIDER,
  FORMAT_BAR_LAYOUT_KEY,
  FORMAT_BAR_ORDER_KEY,
  buildFormatEditHitCells,
  itemsToLayout,
  layoutToItems,
  targetGridDropIndex,
  mergeFormatBarLayout,
  migrateFormatBarLayoutFromV1,
  moveItem,
  neighborTransforms,
  previewLayoutFromItems,
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

function orderMultiset(order) {
  return [...order].sort().join('\0');
}

test('layoutToItems and itemsToLayout round-trip', () => {
  const layout = { order: ['task', 'bold', 'italic', 'link'], hiddenFrom: 2 };
  const items = layoutToItems(layout);
  assert.deepEqual(items, ['task', 'bold', FORMAT_BAR_DIVIDER, 'italic', 'link']);
  assert.deepEqual(itemsToLayout(items), layout);
});

test('moving a shown tile within shown slots keeps hiddenFrom', () => {
  const layout = { order: ['task', 'bold', 'italic', 'link'], hiddenFrom: 2 };
  const items = layoutToItems(layout);
  const next = previewLayoutFromItems(items, 0, 2);
  assert.equal(next.hiddenFrom, 2);
  assert.deepEqual(next.order, ['bold', 'task', 'italic', 'link']);
});

test('shown to hidden decrements hiddenFrom by one', () => {
  const layout = { order: ['task', 'bold', 'italic', 'link'], hiddenFrom: 2 };
  const items = layoutToItems(layout);
  const next = previewLayoutFromItems(items, 0, 4);
  assert.equal(next.hiddenFrom, 1);
  assert.equal(next.order.includes('task'), true);
});

test('hidden to shown increments hiddenFrom by one', () => {
  const layout = { order: ['task', 'bold', 'italic'], hiddenFrom: 1 };
  const items = layoutToItems(layout);
  const italicIdx = items.indexOf('italic');
  const next = previewLayoutFromItems(items, italicIdx, 0);
  assert.equal(next.hiddenFrom, 2);
  assert.equal(next.order[0], 'italic');
});

test('divider move sets hiddenFrom to sentinel index', () => {
  const layout = { order: ['a', 'b', 'c', 'd'], hiddenFrom: 1 };
  const items = layoutToItems(layout);
  const dividerAt = items.indexOf(FORMAT_BAR_DIVIDER);
  const next = previewLayoutFromItems(items, dividerAt, 3);
  assert.equal(next.hiddenFrom, 2);
});

test('item-list move invariants for lengths 1–12 (property)', () => {
  const letters = 'abcdefghijklmnopqrstuvwx'.split('');
  for (let len = 1; len <= 12; len += 1) {
    const order = letters.slice(0, len);
    for (let hf = 0; hf <= len; hf += 1) {
      const layout = { order: order.slice(), hiddenFrom: hf };
      const startItems = layoutToItems(layout);
      for (let from = 0; from < startItems.length; from += 1) {
        for (let to = 0; to <= startItems.length; to += 1) {
          const nextItems = moveItem(startItems, from, to);
          const next = itemsToLayout(nextItems);
          assert.equal(orderMultiset(next.order), orderMultiset(layout.order));
          assert.equal(next.hiddenFrom, nextItems.indexOf(FORMAT_BAR_DIVIDER));
          assert.ok(next.hiddenFrom >= 0 && next.hiddenFrom <= next.order.length);
        }
      }
    }
  }
});

test('previewLayoutFromItems from one snapshot is idempotent', () => {
  const layout = { order: ['task', 'bold', 'italic', 'link', 'image'], hiddenFrom: 3 };
  const startItems = layoutToItems(layout);
  for (const [from, to] of [[0, 2], [4, 1], [3, 5], [1, 6]]) {
    const once = previewLayoutFromItems(startItems, from, to);
    const again = previewLayoutFromItems(startItems, from, to);
    assert.deepEqual(once, again);
  }
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

test('targetGridDropIndex below the divider row inserts after the sentinel', () => {
  const layout = { order: ['task', 'bold', 'italic'], hiddenFrom: 3 };
  const items = layoutToItems(layout);
  const cells = buildFormatEditHitCells({
    columnCount: 5,
    cellWidth: 70,
    cellHeight: 64,
    gapX: 10,
    gapY: 8,
    dividerHeight: 44,
    items,
  });
  const div = cells.find((c) => c.isDivider);
  const belowY = div.top + div.height + 48;
  const target = targetGridDropIndex(cells, div.left + div.width / 2, belowY, 1, {
    itemsLength: items.length,
  });
  assert.ok(target > div.index, 'drop below divider must target hidden region');
  const hidden = previewLayoutFromItems(items, items.indexOf('bold'), target);
  assert.ok(!visibleBarOrder(hidden).includes('bold'));
});

test('targetGridDropIndex uses divider mid-Y when pointer is on the divider row', () => {
  const items = ['task', 'bold', FORMAT_BAR_DIVIDER];
  const cells = buildFormatEditHitCells({
    columnCount: 5,
    cellWidth: 70,
    cellHeight: 64,
    items,
    dividerHeight: 44,
  });
  const div = cells.find((c) => c.isDivider);
  const topHalf = targetGridDropIndex(cells, div.left + 10, div.top + 8, 0, {
    itemsLength: items.length,
  });
  const bottomHalf = targetGridDropIndex(cells, div.left + 10, div.top + div.height - 8, 0, {
    itemsLength: items.length,
  });
  assert.equal(topHalf, div.index);
  assert.equal(bottomHalf, div.index + 1);
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
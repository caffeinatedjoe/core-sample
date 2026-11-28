import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FORMAT_BAR_LAYOUT,
  DEFAULT_FORMAT_BAR_ORDER,
  FORMAT_BAR_DIVIDER,
  FORMAT_BAR_LAYOUT_KEY,
  FORMAT_BAR_ORDER_KEY,
  FORMAT_EDIT_SECTION_HIDDEN,
  FORMAT_EDIT_SECTION_SHOWN,
  commitFormatEditMove,
  formatEditProjectionSlots,
  formatEditSlotTranslate,
  itemsToLayout,
  layoutToItems,
  layoutToSections,
  mergeFormatBarLayout,
  migrateFormatBarLayoutFromV1,
  moveItem,
  neighborTransforms,
  pickFormatEditDragTarget,
  pickFormatEditSection,
  pointerToFormatEditSlot,
  readFormatBarLayout,
  resetFormatBarLayout,
  sectionsToLayout,
  targetDropIndex,
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

test('layoutToSections and sectionsToLayout round-trip', () => {
  const layout = { order: ['task', 'bold', 'italic', 'link'], hiddenFrom: 2 };
  const { shown, hidden } = layoutToSections(layout);
  assert.deepEqual(shown, ['task', 'bold']);
  assert.deepEqual(hidden, ['italic', 'link']);
  assert.deepEqual(sectionsToLayout(shown, hidden), layout);
});

test('commitFormatEditMove hiding drops into hidden at slot', () => {
  const shown = ['task', 'bold'];
  const hidden = ['italic'];
  const layout = commitFormatEditMove(shown, hidden, 'bold', FORMAT_EDIT_SECTION_SHOWN, 1, {
    section: FORMAT_EDIT_SECTION_HIDDEN,
    slot: 0,
  });
  assert.equal(layout.hiddenFrom, 1);
  assert.deepEqual(visibleBarOrder(layout), ['task']);
  assert.ok(layout.order.includes('bold'));
});

test('commitFormatEditMove shown reorder', () => {
  const shown = ['task', 'bold', 'italic'];
  const hidden = [];
  const layout = commitFormatEditMove(shown, hidden, 'task', FORMAT_EDIT_SECTION_SHOWN, 0, {
    section: FORMAT_EDIT_SECTION_SHOWN,
    slot: 2,
  });
  assert.deepEqual(visibleBarOrder(layout), ['bold', 'italic', 'task']);
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

test('pickFormatEditSection hysteresis at header midline', () => {
  const mid = 200;
  assert.equal(pickFormatEditSection(185, mid, FORMAT_EDIT_SECTION_SHOWN), FORMAT_EDIT_SECTION_SHOWN);
  assert.equal(pickFormatEditSection(214, mid, FORMAT_EDIT_SECTION_SHOWN), FORMAT_EDIT_SECTION_HIDDEN);
  assert.equal(pickFormatEditSection(214, mid, FORMAT_EDIT_SECTION_HIDDEN), FORMAT_EDIT_SECTION_HIDDEN);
  assert.equal(pickFormatEditSection(185, mid, FORMAT_EDIT_SECTION_HIDDEN), FORMAT_EDIT_SECTION_SHOWN);
});

test('pointerToFormatEditSlot clamps past last row', () => {
  const slot = pointerToFormatEditSlot(40, 500, 0, 0, 5, 70, 64, 10, 8, 9);
  assert.equal(slot, 8);
});

test('pickFormatEditDragTarget stays on edges until inner 70%', () => {
  const geom = {
    localX: 35,
    localY: 32,
    headerMidY: 400,
    prevSection: null,
    currentTarget: { section: FORMAT_EDIT_SECTION_SHOWN, slot: 0 },
    shownOriginY: 0,
    hiddenOriginY: 500,
    originX: 0,
    columnCount: 5,
    cellWidth: 70,
    cellHeight: 64,
    gapX: 10,
    gapY: 8,
    shownCount: 9,
    hiddenCount: 3,
    dragFromSection: FORMAT_EDIT_SECTION_SHOWN,
  };
  const onEdge = pickFormatEditDragTarget(geom);
  assert.deepEqual(onEdge, { section: FORMAT_EDIT_SECTION_SHOWN, slot: 0 });
  const inner = pickFormatEditDragTarget({ ...geom, localX: 95, localY: 35 });
  assert.equal(inner.slot, 1);
});

test('formatEditProjectionSlots shifts neighbors for a gap', () => {
  const shown = ['a', 'b', 'c'];
  const hidden = [];
  const proj = formatEditProjectionSlots(shown, hidden, 'a', FORMAT_EDIT_SECTION_SHOWN, {
    section: FORMAT_EDIT_SECTION_SHOWN,
    slot: 2,
  });
  assert.deepEqual(proj.get('b'), { section: FORMAT_EDIT_SECTION_SHOWN, slot: 0 });
  assert.deepEqual(proj.get('c'), { section: FORMAT_EDIT_SECTION_SHOWN, slot: 1 });
});

test('formatEditSlotTranslate is pure arithmetic', () => {
  const t = formatEditSlotTranslate(0, 1, 5, 70, 64, 10, 8);
  assert.equal(t.dx, 80);
  assert.equal(t.dy, 0);
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
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FORMAT_BAR_LAYOUT,
  DEFAULT_FORMAT_BAR_ORDER,
  FORMAT_BAR_DIVIDER,
  FORMAT_BAR_LAYOUT_KEY,
  FORMAT_BAR_ORDER_KEY,
  FORMAT_EDIT_SECTION_HIDDEN,
  FORMAT_EDIT_SECTION_HYSTERESIS_PX,
  FORMAT_EDIT_SECTION_SHOWN,
  FORMAT_EDIT_SLOT_HYSTERESIS_PX,
  commitFormatEditMove,
  formatEditProjectionSlots,
  formatEditFrozenRows,
  formatEditShownContentBottomY,
  formatEditSlotTranslate,
  itemsToLayout,
  layoutToItems,
  layoutToSections,
  mergeFormatBarLayout,
  migrateFormatBarLayoutFromV1,
  moveItem,
  neighborTransforms,
  pastFormatEditSlotBoundary,
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

test('commitFormatEditMove ignores stale fromIndex when dragId mismatches', () => {
  const shown = ['task', 'bold', 'undo', 'redo'];
  const hidden = [];
  const layout = commitFormatEditMove(shown, hidden, 'redo', FORMAT_EDIT_SECTION_SHOWN, 2, {
    section: FORMAT_EDIT_SECTION_HIDDEN,
    slot: 0,
  });
  const next = layoutToSections(layout);
  assert.deepEqual(next.shown, ['task', 'bold', 'undo']);
  assert.deepEqual(next.hidden, ['redo']);
});

test('commitFormatEditMove hiding redo keeps undo before hiddenFrom', () => {
  const order = [
    'task',
    'bullet',
    'numbered',
    'bold',
    'italic',
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
  ];
  const hiddenFrom = order.length;
  const { shown, hidden } = layoutToSections({ order, hiddenFrom });
  const fromIndex = shown.indexOf('redo');
  const layout = commitFormatEditMove(shown, hidden, 'redo', FORMAT_EDIT_SECTION_SHOWN, fromIndex, {
    section: FORMAT_EDIT_SECTION_HIDDEN,
    slot: 0,
  });
  const next = layoutToSections(layout);
  assert.deepEqual(next.shown, shown.filter((id) => id !== 'redo'));
  assert.equal(next.shown[next.shown.length - 1], 'undo');
  assert.deepEqual(next.hidden, ['redo']);
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

test('pickFormatEditSection hysteresis at header midline is small and symmetric', () => {
  const mid = 200;
  const h = FORMAT_EDIT_SECTION_HYSTERESIS_PX;
  assert.ok(h >= 4 && h <= 6);
  assert.equal(pickFormatEditSection(mid + h, mid, FORMAT_EDIT_SECTION_SHOWN), FORMAT_EDIT_SECTION_SHOWN);
  assert.equal(pickFormatEditSection(mid + h + 1, mid, FORMAT_EDIT_SECTION_SHOWN), FORMAT_EDIT_SECTION_HIDDEN);
  assert.equal(pickFormatEditSection(mid - h, mid, FORMAT_EDIT_SECTION_HIDDEN), FORMAT_EDIT_SECTION_HIDDEN);
  assert.equal(pickFormatEditSection(mid - h - 1, mid, FORMAT_EDIT_SECTION_HIDDEN), FORMAT_EDIT_SECTION_SHOWN);
  assert.equal(pickFormatEditSection(mid + 2, mid, FORMAT_EDIT_SECTION_SHOWN), FORMAT_EDIT_SECTION_SHOWN);
  assert.equal(pickFormatEditSection(mid - 2, mid, FORMAT_EDIT_SECTION_HIDDEN), FORMAT_EDIT_SECTION_HIDDEN);
});

test('formatEditShownContentBottomY ignores spare row', () => {
  const bottom = formatEditShownContentBottomY(21, FORMAT_EDIT_SECTION_SHOWN, 7, 44, 6, 0);
  assert.equal(bottom, 44 * 3 + 6 * 2);
});

test('formatEditFrozenRows adds one spare row by column count', () => {
  assert.equal(formatEditFrozenRows(9, 7), 3);
  assert.equal(formatEditFrozenRows(12, 7), 3);
  assert.equal(formatEditFrozenRows(1, 5), 2);
});

test('pointerToFormatEditSlot clamps past last row', () => {
  const slot = pointerToFormatEditSlot(40, 500, 0, 0, 5, 70, 64, 10, 8, 9);
  assert.equal(slot, 8);
});

test('pointerToFormatEditSlot uses closest centers, not cell leading edges', () => {
  // cell 0 [0,70] center 35; gap 10; cell 1 [80,150] center 115; midpoint 75
  assert.equal(pointerToFormatEditSlot(74, 32, 0, 0, 5, 70, 64, 10, 8, 9), 0);
  assert.equal(pointerToFormatEditSlot(76, 32, 0, 0, 5, 70, 64, 10, 8, 9), 1);
  assert.equal(pointerToFormatEditSlot(35, 32, 0, 0, 5, 70, 64, 10, 8, 9), 0);
  assert.equal(pointerToFormatEditSlot(115, 32, 0, 0, 5, 70, 64, 10, 8, 9), 1);
});

test('pickFormatEditDragTarget switches at closest-center with 6px slot hysteresis', () => {
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
  assert.deepEqual(pickFormatEditDragTarget(geom), { section: FORMAT_EDIT_SECTION_SHOWN, slot: 0 });
  const mid = 75;
  const sticky = pickFormatEditDragTarget({ ...geom, localX: mid + 2, localY: 32 });
  assert.equal(sticky.slot, 0);
  const crossed = pickFormatEditDragTarget({ ...geom, localX: mid + FORMAT_EDIT_SLOT_HYSTERESIS_PX, localY: 32 });
  assert.equal(crossed.slot, 1);
});

test('pickFormatEditDragTarget does not force hidden in the shown spare row', () => {
  const target = pickFormatEditDragTarget({
    localX: 35,
    localY: 160,
    headerMidY: 400,
    prevSection: FORMAT_EDIT_SECTION_SHOWN,
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
  });
  assert.equal(target.section, FORMAT_EDIT_SECTION_SHOWN);
});

test('pickFormatEditDragTarget has no inner-70% dead zone in a cell gap', () => {
  const geom = {
    localX: 76,
    localY: 32,
    headerMidY: 400,
    prevSection: FORMAT_EDIT_SECTION_SHOWN,
    currentTarget: null,
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
  assert.equal(pickFormatEditDragTarget(geom).slot, 1);
});

test('slot boundary ±2px flickers at most once over 30 samples', () => {
  const mid = 75;
  let current = { section: FORMAT_EDIT_SECTION_SHOWN, slot: 0 };
  let changes = 0;
  for (let i = 0; i < 30; i += 1) {
    const localX = mid + ((i % 2) ? 2 : -2);
    const next = pickFormatEditDragTarget({
      localX,
      localY: 32,
      headerMidY: 400,
      prevSection: FORMAT_EDIT_SECTION_SHOWN,
      currentTarget: current,
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
    });
    if (next.section !== current.section || next.slot !== current.slot) {
      changes += 1;
      current = next;
    }
  }
  assert.ok(changes <= 1, `target changed ${changes} times`);
});

test('pastFormatEditSlotBoundary is the same in every direction', () => {
  const args = [5, 70, 64, 10, 8, 0, 0, FORMAT_EDIT_SLOT_HYSTERESIS_PX];
  assert.equal(pastFormatEditSlotBoundary(75 + 2, 32, 0, 1, ...args), false);
  assert.equal(pastFormatEditSlotBoundary(75 + 6, 32, 0, 1, ...args), true);
  assert.equal(pastFormatEditSlotBoundary(75 - 2, 32, 1, 0, ...args), false);
  assert.equal(pastFormatEditSlotBoundary(75 - 6, 32, 1, 0, ...args), true);
});

test('hiding any default shown item preserves neighbor order in the model', () => {
  const order = [
    'task', 'bullet', 'numbered', 'bold', 'italic', 'link', 'image', 'heading', 'indent',
    'outdent', 'lineUp', 'lineDown', 'quote', 'code', 'strike', 'fence', 'highlight',
    'comment', 'rule', 'undo', 'redo',
  ];
  const { shown, hidden } = layoutToSections({ order, hiddenFrom: order.length });
  for (const dragId of shown) {
    for (const slot of [0, hidden.length]) {
      const fromIndex = shown.indexOf(dragId);
      const layout = commitFormatEditMove(shown, hidden, dragId, FORMAT_EDIT_SECTION_SHOWN, fromIndex, {
        section: FORMAT_EDIT_SECTION_HIDDEN,
        slot,
      });
      const next = layoutToSections(layout);
      assert.deepEqual(next.shown, shown.filter((id) => id !== dragId));
    }
  }
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
// Format toolbar layout merge, persistence, and drag index math. No DOM.

export const FORMAT_BAR_ORDER_KEY = 'core-sample-format-bar-order-v1';
export const FORMAT_BAR_LAYOUT_KEY = 'core-sample-format-bar-layout-v2';

/** ids in the scroll row; dismiss lives outside and is not editable */
export const DEFAULT_FORMAT_BAR_ORDER = [
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

export const DEFAULT_FORMAT_BAR_LAYOUT = {
  order: DEFAULT_FORMAT_BAR_ORDER,
  hiddenFrom: DEFAULT_FORMAT_BAR_ORDER.length,
};

export function formatBarId(node) {
  const id = node?.dataset?.format;
  return id || null;
}

export function mergeFormatBarOrder(saved, defaults = DEFAULT_FORMAT_BAR_ORDER) {
  const known = new Set(defaults);
  const out = [];
  for (const id of saved || []) {
    if (typeof id !== 'string' || !known.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  for (const id of defaults) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Merge persisted layout; new ids insert in the shown region (before hiddenFrom). */
export function mergeFormatBarLayout(saved, defaults = DEFAULT_FORMAT_BAR_ORDER) {
  const known = new Set(defaults);
  const base = { order: [], hiddenFrom: defaults.length };
  let hiddenFrom = defaults.length;
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    if (Array.isArray(saved.order)) {
      for (const id of saved.order) {
        if (typeof id !== 'string' || !known.has(id) || base.order.includes(id)) continue;
        base.order.push(id);
      }
    }
    if (typeof saved.hiddenFrom === 'number' && Number.isFinite(saved.hiddenFrom)) {
      hiddenFrom = Math.trunc(saved.hiddenFrom);
    }
  } else if (Array.isArray(saved)) {
    base.order = mergeFormatBarOrder(saved, defaults);
    hiddenFrom = base.order.length;
  }
  for (const id of defaults) {
    if (!base.order.includes(id)) {
      const at = Math.max(0, Math.min(hiddenFrom, base.order.length));
      base.order.splice(at, 0, id);
      hiddenFrom += 1;
    }
  }
  base.hiddenFrom = clampHiddenFrom(hiddenFrom, base.order.length);
  return base;
}

export function clampHiddenFrom(hiddenFrom, length) {
  return Math.max(0, Math.min(length, Math.trunc(hiddenFrom)));
}

export function visibleBarOrder(layout) {
  const { order, hiddenFrom } = layout;
  return order.slice(0, clampHiddenFrom(hiddenFrom, order.length));
}

export function hiddenBarOrder(layout) {
  const { order, hiddenFrom } = layout;
  return order.slice(clampHiddenFrom(hiddenFrom, order.length));
}

export function readFormatBarOrder(storage) {
  try {
    const raw = storage?.getItem?.(FORMAT_BAR_ORDER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeFormatBarOrder(order, storage) {
  storage?.setItem?.(FORMAT_BAR_ORDER_KEY, JSON.stringify(order));
}

export function readFormatBarLayout(storage) {
  try {
    const raw = storage?.getItem?.(FORMAT_BAR_LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.order)) return parsed;
    }
    const migrated = migrateFormatBarLayoutFromV1(storage);
    if (migrated) return migrated;
    return null;
  } catch {
    return null;
  }
}

export function writeFormatBarLayout(layout, storage) {
  storage?.setItem?.(FORMAT_BAR_LAYOUT_KEY, JSON.stringify(layout));
}

/** Read v1 once, write v2, remove v1. */
export function migrateFormatBarLayoutFromV1(storage) {
  const v1 = readFormatBarOrder(storage);
  if (!v1) return null;
  const order = mergeFormatBarOrder(v1);
  const layout = { order, hiddenFrom: order.length };
  writeFormatBarLayout(layout, storage);
  try {
    storage?.removeItem?.(FORMAT_BAR_ORDER_KEY);
  } catch {
    /* ok */
  }
  return layout;
}

export function resetFormatBarLayout() {
  return {
    order: DEFAULT_FORMAT_BAR_ORDER.slice(),
    hiddenFrom: DEFAULT_FORMAT_BAR_ORDER.length,
  };
}

export function orderFromScrollChildren(ids) {
  return ids.filter((id) => DEFAULT_FORMAT_BAR_ORDER.includes(id));
}

/** Horizontal centers in scroll content coordinates. */
export function targetDropIndex(fromIndex, centers, pointerX) {
  const n = centers.length;
  if (!n || fromIndex < 0 || fromIndex >= n) return fromIndex;
  let target = fromIndex;
  for (let i = 0; i < n; i++) {
    const left = i === 0 ? -Infinity : (centers[i - 1] + centers[i]) / 2;
    const right = i === n - 1 ? Infinity : (centers[i] + centers[i + 1]) / 2;
    if (pointerX >= left && pointerX < right) {
      target = i;
      break;
    }
  }
  return target;
}

/** translateX offsets (px) for neighbors while dragging from -> to; stride = item width. */
export function neighborTransforms(length, from, to, stride) {
  const transforms = Array.from({ length }, () => 0);
  if (from === to || !stride) return transforms;
  if (from < to) {
    for (let i = from + 1; i <= to; i++) transforms[i] = -stride;
  } else {
    for (let i = to; i < from; i++) transforms[i] = stride;
  }
  return transforms;
}

export function moveItem(order, from, to) {
  const next = order.slice();
  if (from < 0 || from >= next.length || to < 0 || to > next.length) return next;
  if (from === to) return next;
  const [item] = next.splice(from, 1);
  const insertAt = to > from ? to - 1 : to;
  next.splice(insertAt, 0, item);
  return next;
}

/** Sentinel in the edit-sheet item list; hiddenFrom is its index. */
export const FORMAT_BAR_DIVIDER = '__format_bar_divider__';

export function layoutToItems(layout) {
  const hf = clampHiddenFrom(layout.hiddenFrom, layout.order.length);
  return [
    ...layout.order.slice(0, hf),
    FORMAT_BAR_DIVIDER,
    ...layout.order.slice(hf),
  ];
}

export function itemsToLayout(items) {
  const divIdx = items.indexOf(FORMAT_BAR_DIVIDER);
  if (divIdx < 0) {
    return { order: items.slice(), hiddenFrom: items.length };
  }
  const order = [
    ...items.slice(0, divIdx),
    ...items.slice(divIdx + 1),
  ];
  return { order, hiddenFrom: divIdx };
}

/** One move in the item list (tiles + divider); hiddenFrom follows the sentinel. */
export function previewLayoutFromItems(startItems, from, to) {
  const nextItems = moveItem(startItems, from, to);
  return itemsToLayout(nextItems);
}

export const FORMAT_EDIT_MIN_CELL_PX = 44;
export const FORMAT_EDIT_GAP_X_PX = 8;
export const FORMAT_EDIT_GAP_Y_PX = 6;

/** Columns that fit under repeat(auto-fill, minmax(minCell, 1fr)). */
export function formatEditGridColumnCount(gridWidth, gapX, minCell = FORMAT_EDIT_MIN_CELL_PX) {
  if (gridWidth <= 0) return 1;
  return Math.max(1, Math.floor((gridWidth + gapX) / (minCell + gapX)));
}

export const FORMAT_EDIT_SECTION_SHOWN = 'shown';
export const FORMAT_EDIT_SECTION_HIDDEN = 'hidden';
/** Symmetric band around the Hidden header midline. */
export const FORMAT_EDIT_SECTION_HYSTERESIS_PX = 5;
/** Symmetric band around the closest-center slot boundary. */
export const FORMAT_EDIT_SLOT_HYSTERESIS_PX = 6;

export function layoutToSections(layout) {
  const hf = clampHiddenFrom(layout.hiddenFrom, layout.order.length);
  return {
    shown: layout.order.slice(0, hf),
    hidden: layout.order.slice(hf),
  };
}

export function sectionsToLayout(shown, hidden) {
  return { order: [...shown, ...hidden], hiddenFrom: shown.length };
}

/** Occupied rows for tiles plus one spare row for drag projection. */
export function formatEditFrozenRows(tileCount, columnCount) {
  const cols = Math.max(1, columnCount);
  const occupied = Math.ceil(Math.max(0, tileCount) / cols) || 1;
  return occupied + 1;
}

export function formatEditGridPixelHeight(rowCount, cellHeight, gapY) {
  if (rowCount <= 0) return 0;
  return rowCount * cellHeight + Math.max(0, rowCount - 1) * gapY;
}

export function formatEditSlotRect(slot, columnCount, cellWidth, cellHeight, gapX, gapY, originX = 0, originY = 0) {
  const row = Math.floor(slot / columnCount);
  const col = slot % columnCount;
  return {
    left: originX + col * (cellWidth + gapX),
    top: originY + row * (cellHeight + gapY),
    width: cellWidth,
    height: cellHeight,
  };
}

/** Scroll-local Y → section. Same ±hysteresis in both directions; no downward special case. */
export function pickFormatEditSection(localY, headerMidY, prevSection, hysteresis = FORMAT_EDIT_SECTION_HYSTERESIS_PX) {
  if (prevSection === FORMAT_EDIT_SECTION_SHOWN) {
    return localY <= headerMidY + hysteresis ? FORMAT_EDIT_SECTION_SHOWN : FORMAT_EDIT_SECTION_HIDDEN;
  }
  if (prevSection === FORMAT_EDIT_SECTION_HIDDEN) {
    return localY >= headerMidY - hysteresis ? FORMAT_EDIT_SECTION_HIDDEN : FORMAT_EDIT_SECTION_SHOWN;
  }
  return localY < headerMidY ? FORMAT_EDIT_SECTION_SHOWN : FORMAT_EDIT_SECTION_HIDDEN;
}

/** Bottom Y (scroll-local) of occupied shown rows, excluding the spare drag row. */
export function formatEditShownContentBottomY(
  shownCount,
  dragFromSection,
  columnCount,
  cellHeight,
  gapY,
  originY,
) {
  const effective = dragFromSection === FORMAT_EDIT_SECTION_SHOWN
    ? Math.max(0, shownCount - 1)
    : shownCount;
  const rows = Math.max(1, Math.ceil(effective / Math.max(1, columnCount)));
  return originY + formatEditGridPixelHeight(rows, cellHeight, gapY);
}

export function formatEditProjectedSlotCount(shownCount, hiddenCount, section, dragFromSection) {
  if (section === FORMAT_EDIT_SECTION_SHOWN) {
    const base = dragFromSection === FORMAT_EDIT_SECTION_SHOWN ? shownCount - 1 : shownCount;
    return Math.max(1, base + 1);
  }
  const base = dragFromSection === FORMAT_EDIT_SECTION_HIDDEN ? hiddenCount - 1 : hiddenCount;
  return Math.max(1, base + 1);
}

/**
 * Insertion slot under the pointer: row from Y vs row centers, then column
 * from X vs cell centers (dnd-kit closestCenter, axis-separated). Past the
 * last tile is the end of the section.
 */
export function pointerToFormatEditSlot(localX, localY, originX, originY, columnCount, cellWidth, cellHeight, gapX, gapY, projectedSlotCount) {
  const count = Math.max(1, projectedSlotCount);
  const cols = Math.max(1, columnCount);
  const rows = Math.ceil(count / cols);
  const relX = localX - originX;
  const relY = localY - originY;
  const strideX = cellWidth + gapX;
  const strideY = cellHeight + gapY;
  const gridBottom = originY + formatEditGridPixelHeight(rows, cellHeight, gapY);
  if (localY >= gridBottom) return count - 1;
  let row = relY < 0 ? 0 : Math.round((relY - cellHeight / 2) / strideY);
  row = Math.max(0, Math.min(rows - 1, row));
  let col = Math.round((relX - cellWidth / 2) / strideX);
  col = Math.max(0, Math.min(cols - 1, col));
  return Math.max(0, Math.min(count - 1, row * cols + col));
}

function slotCenter(slot, columnCount, cellWidth, cellHeight, gapX, gapY, originX, originY) {
  const rect = formatEditSlotRect(slot, columnCount, cellWidth, cellHeight, gapX, gapY, originX, originY);
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** True when the pointer is at least `hysteresis` past the closest-center boundary toward `proposedSlot`. */
export function pastFormatEditSlotBoundary(
  localX,
  localY,
  currentSlot,
  proposedSlot,
  columnCount,
  cellWidth,
  cellHeight,
  gapX,
  gapY,
  originX,
  originY,
  hysteresis = FORMAT_EDIT_SLOT_HYSTERESIS_PX,
) {
  if (currentSlot === proposedSlot) return true;
  const current = slotCenter(currentSlot, columnCount, cellWidth, cellHeight, gapX, gapY, originX, originY);
  const proposed = slotCenter(proposedSlot, columnCount, cellWidth, cellHeight, gapX, gapY, originX, originY);
  const dx = proposed.x - current.x;
  const dy = proposed.y - current.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return true;
  const midX = (current.x + proposed.x) / 2;
  const midY = (current.y + proposed.y) / 2;
  const past = ((localX - midX) * dx + (localY - midY) * dy) / len;
  return past >= hysteresis;
}

/**
 * Drag target { section, slot }. Section uses a small symmetric header-midline
 * band. Slot is closest-center, with the same small band around the current
 * slot boundary so a gap registers on the next move without edge flicker.
 */
export function pickFormatEditDragTarget({
  localX,
  localY,
  headerMidY,
  prevSection,
  currentTarget,
  shownOriginY,
  hiddenOriginY,
  originX,
  columnCount,
  cellWidth,
  cellHeight,
  gapX,
  gapY,
  shownCount,
  hiddenCount,
  dragFromSection,
  sectionHysteresis = FORMAT_EDIT_SECTION_HYSTERESIS_PX,
  slotHysteresis = FORMAT_EDIT_SLOT_HYSTERESIS_PX,
}) {
  const section = pickFormatEditSection(
    localY,
    headerMidY,
    prevSection ?? currentTarget?.section,
    sectionHysteresis,
  );
  const projected = formatEditProjectedSlotCount(shownCount, hiddenCount, section, dragFromSection);
  const originY = section === FORMAT_EDIT_SECTION_SHOWN ? shownOriginY : hiddenOriginY;
  const slot = pointerToFormatEditSlot(
    localX,
    localY,
    originX,
    originY,
    columnCount,
    cellWidth,
    cellHeight,
    gapX,
    gapY,
    projected,
  );
  const proposed = { section, slot };
  if (!currentTarget) return proposed;
  if (proposed.section === currentTarget.section && proposed.slot === currentTarget.slot) return currentTarget;
  if (proposed.section !== currentTarget.section) return proposed;
  return pastFormatEditSlotBoundary(
    localX,
    localY,
    currentTarget.slot,
    proposed.slot,
    columnCount,
    cellWidth,
    cellHeight,
    gapX,
    gapY,
    originX,
    originY,
    slotHysteresis,
  ) ? proposed : currentTarget;
}

/** Project lists with a gap at target; omit dragId from lists (placeholder at home). */
export function projectFormatEditLists(shown, hidden, dragId, fromSection, target) {
  let projShown = shown.filter((id) => id !== dragId);
  let projHidden = hidden.filter((id) => id !== dragId);
  if (target.section === FORMAT_EDIT_SECTION_SHOWN) {
    const slot = Math.max(0, Math.min(target.slot, projShown.length));
    projShown = [...projShown.slice(0, slot), null, ...projShown.slice(slot)];
  } else {
    const slot = Math.max(0, Math.min(target.slot, projHidden.length));
    projHidden = [...projHidden.slice(0, slot), null, ...projHidden.slice(slot)];
  }
  return { projShown, projHidden };
}

export function homeSlotIndex(id, ids) {
  const i = ids.indexOf(id);
  return i < 0 ? null : i;
}

/** Map each visible id to projected slot in its section (null gap skipped for real ids). */
export function formatEditProjectionSlots(shown, hidden, dragId, fromSection, target) {
  const { projShown, projHidden } = projectFormatEditLists(shown, hidden, dragId, fromSection, target);
  const map = new Map();
  const fold = (list, section) => {
    let slot = 0;
    for (const id of list) {
      if (id === null) {
        slot += 1;
        continue;
      }
      if (id === dragId) continue;
      map.set(id, { section, slot });
      slot += 1;
    }
  };
  fold(projShown, FORMAT_EDIT_SECTION_SHOWN);
  fold(projHidden, FORMAT_EDIT_SECTION_HIDDEN);
  return map;
}

export function formatEditSlotTranslate(homeSlot, projSlot, columnCount, cellWidth, cellHeight, gapX, gapY) {
  if (homeSlot == null || projSlot == null || homeSlot === projSlot) return { dx: 0, dy: 0 };
  const a = formatEditSlotRect(homeSlot, columnCount, cellWidth, cellHeight, gapX, gapY);
  const b = formatEditSlotRect(projSlot, columnCount, cellWidth, cellHeight, gapX, gapY);
  return { dx: b.left - a.left, dy: b.top - a.top };
}

/** Commit a tile move between shown and hidden lists. */
export function commitFormatEditMove(shown, hidden, dragId, fromSection, fromIndex, target) {
  const nextShown = shown.slice();
  const nextHidden = hidden.slice();
  const fromList = fromSection === FORMAT_EDIT_SECTION_SHOWN ? nextShown : nextHidden;
  let removeAt = fromList.indexOf(dragId);
  if (removeAt < 0) removeAt = fromIndex;
  if (fromSection === FORMAT_EDIT_SECTION_SHOWN) nextShown.splice(removeAt, 1);
  else nextHidden.splice(removeAt, 1);
  const dest = target.section === FORMAT_EDIT_SECTION_SHOWN ? nextShown : nextHidden;
  const insertAt = Math.max(0, Math.min(target.slot, dest.length));
  dest.splice(insertAt, 0, dragId);
  return sectionsToLayout(
    target.section === FORMAT_EDIT_SECTION_SHOWN ? dest : nextShown,
    target.section === FORMAT_EDIT_SECTION_HIDDEN ? dest : nextHidden,
  );
}
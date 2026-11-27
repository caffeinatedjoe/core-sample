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

/** Reorder a tile and keep hiddenFrom aligned with the shown/hidden split. */
export function applyTileMove(layout, from, to, { intoHidden = false } = {}) {
  const order = layout.order.slice();
  const hf0 = clampHiddenFrom(layout.hiddenFrom, order.length);
  if (from < 0 || from >= order.length) return { order, hiddenFrom: hf0 };
  let hf = hf0;
  const wasShown = from < hf;
  const [item] = order.splice(from, 1);
  if (from < hf) hf -= 1;
  let insertAt = to;
  if (to > from) insertAt = to - 1;
  insertAt = Math.max(0, Math.min(insertAt, order.length));
  order.splice(insertAt, 0, item);
  const nowShown = insertAt < hf;
  if (intoHidden && hf0 === layout.order.length && wasShown) {
    hf = Math.min(insertAt, order.length);
  } else if (!wasShown && nowShown) hf += 1;
  return { order, hiddenFrom: clampHiddenFrom(hf, order.length) };
}

export const DRAG_CELL_SLOP_PX = 8;
export const DRAG_DIVIDER_SLOP_PX = 12;

/** Each cell: { left, top, width, height, index }. Returns flat order index or divider index. */
export function targetGridDropIndex(cells, pointerX, pointerY, fromIndex, { dividerRow = null } = {}) {
  if (!cells.length) return 0;
  const hit = cells.find((cell) => (
    pointerX >= cell.left
    && pointerX < cell.left + cell.width
    && pointerY >= cell.top
    && pointerY < cell.top + cell.height
  ));
  if (hit) {
    const midX = hit.left + hit.width / 2;
    return pointerX < midX ? hit.index : hit.index + 1;
  }
  if (dividerRow) {
    const row = dividerRow;
    if (pointerY >= row.top && pointerY < row.top + row.height) {
      return row.index;
    }
  }
  let best = fromIndex;
  let bestDist = Infinity;
  for (const cell of cells) {
    const cx = cell.left + cell.width / 2;
    const cy = cell.top + cell.height / 2;
    const d = (pointerX - cx) ** 2 + (pointerY - cy) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = cell.index + (pointerX >= cx ? 1 : 0);
    }
  }
  return Math.max(0, Math.min(cells.length, best));
}

/** Stabilize drop index: stick with currentTarget until pointer crosses into the next slot. */
export function stabilizeGridDropIndex(cells, pointerX, pointerY, fromIndex, currentTarget, opts = {}) {
  const proposed = targetGridDropIndex(cells, pointerX, pointerY, fromIndex, opts);
  if (currentTarget == null) return proposed;
  if (proposed === currentTarget) return currentTarget;
  const slop = opts.slop ?? DRAG_CELL_SLOP_PX;
  const movingDown = proposed > currentTarget;
  const anchor = movingDown
    ? cells.find((c) => c.index === currentTarget) || cells.find((c) => c.index === proposed - 1)
    : cells.find((c) => c.index === proposed) || cells.find((c) => c.index === currentTarget - 1);
  if (!anchor) return proposed;
  const midX = anchor.left + anchor.width / 2;
  const midY = anchor.top + anchor.height / 2;
  if (movingDown) {
    const crossed = pointerX >= midX + slop || pointerY >= midY + slop;
    return crossed ? proposed : currentTarget;
  }
  const crossed = pointerX <= midX - slop && pointerY <= midY - slop;
  return crossed ? proposed : currentTarget;
}

/** With hysteresis around divider midline (grid-local Y). */
export function resolveIntoHidden(localY, dividerMidY, prevIntoHidden, slop = DRAG_DIVIDER_SLOP_PX) {
  if (prevIntoHidden == null) return localY > dividerMidY;
  if (prevIntoHidden) return localY > dividerMidY - slop;
  return localY > dividerMidY + slop;
}

/** Pick hiddenFrom (0..orderLength) from pointer Y and tile rows. */
export function targetHiddenFrom(orderLength, cells, pointerY) {
  if (!cells.length) return clampHiddenFrom(0, orderLength);
  if (pointerY <= cells[0].top) return 0;
  const last = cells[cells.length - 1];
  if (pointerY >= last.top + last.height) return clampHiddenFrom(orderLength, orderLength);
  let hiddenFrom = 0;
  for (const cell of cells) {
    if (pointerY >= cell.top + cell.height / 2) hiddenFrom = cell.index + 1;
  }
  return clampHiddenFrom(hiddenFrom, orderLength);
}

/** Stabilize hiddenFrom when dragging the divider (12px past row midline). */
export function stabilizeHiddenFrom(orderLength, cells, pointerY, currentHf, slop = DRAG_DIVIDER_SLOP_PX) {
  const proposed = targetHiddenFrom(orderLength, cells, pointerY, slop);
  if (proposed === currentHf) return currentHf;
  const movingDown = proposed > currentHf;
  const edgeCell = movingDown
    ? cells.find((c) => c.index === currentHf)
    : cells.filter((c) => c.index < currentHf).sort((a, b) => b.index - a.index)[0];
  if (!edgeCell) return proposed;
  const midY = edgeCell.top + edgeCell.height / 2;
  if (movingDown) {
    return pointerY >= midY + slop ? proposed : currentHf;
  }
  return pointerY <= midY - slop ? proposed : currentHf;
}
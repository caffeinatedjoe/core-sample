// Format toolbar button ids, saved order merge, and drag index math. No DOM.

export const FORMAT_BAR_ORDER_KEY = 'core-sample-format-bar-order-v1';

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

export function orderFromScrollChildren(ids) {
  return ids.filter((id) => DEFAULT_FORMAT_BAR_ORDER.includes(id));
}

/** Horizontal centers in the same coordinate system (e.g. scroll content). */
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
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
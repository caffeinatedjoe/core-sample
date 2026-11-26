// Long-press on the format bar opens the Edit toolbar sheet.

import {
  formatBarId,
  mergeFormatBarLayout,
  readFormatBarLayout,
  writeFormatBarLayout,
} from './format-bar-order.js';

const LONG_PRESS_MS = 500;
const SLOP_PX = 8;

export function applyFormatBarLayout(bar, layout) {
  const scroll = bar?.querySelector?.('.format-scroll');
  if (!scroll || !layout) return;
  const merged = mergeFormatBarLayout(layout);
  const { order, hiddenFrom } = merged;
  const byId = new Map();
  for (const child of scroll.children) {
    if (!child.classList?.contains('format-btn')) continue;
    const id = formatBarId(child);
    if (id) byId.set(id, child);
  }
  for (const id of order) {
    const node = byId.get(id);
    if (node) scroll.appendChild(node);
  }
  for (let index = 0; index < order.length; index += 1) {
    const node = byId.get(order[index]);
    if (!node) continue;
    node.hidden = index >= hiddenFrom;
  }
}

export function applySavedFormatBarLayout(bar, storage = globalThis.localStorage) {
  const saved = mergeFormatBarLayout(readFormatBarLayout(storage));
  applyFormatBarLayout(bar, saved);
}

export function persistFormatBarLayout(bar, layout, storage = globalThis.localStorage) {
  writeFormatBarLayout(mergeFormatBarLayout(layout), storage);
}

export function readLayoutFromBar(bar) {
  const scroll = bar?.querySelector?.('.format-scroll');
  if (!scroll) return null;
  const order = [];
  let hiddenFrom = 0;
  for (const child of scroll.children) {
    if (!child.classList.contains('format-btn')) continue;
    const id = formatBarId(child);
    if (!id) continue;
    order.push(id);
    if (!child.hidden) hiddenFrom = order.length;
  }
  return { order, hiddenFrom };
}

export function mountFormatBarLongPress(scroll, {
  onEditToolbar,
  sheetOpen = () => false,
} = {}) {
  const view = scroll?.ownerDocument?.defaultView;
  if (!scroll || !view) {
    return { suppressClick: () => false, destroy() {} };
  }

  let longPress = null;
  let suppressClickUntil = 0;

  const cancelLongPress = () => {
    if (!longPress) return;
    view.clearTimeout(longPress.timer);
    longPress = null;
  };

  const onPointerDown = (event) => {
    if (event.button && event.button !== 0) return;
    if (sheetOpen()) return;
    const btn = event.target.closest?.('.format-scroll .format-btn');
    if (!btn || !scroll.contains(btn)) return;

    cancelLongPress();
    longPress = {
      node: btn,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      moved: false,
      timer: view.setTimeout(() => {
        const press = longPress;
        longPress = null;
        if (!press || press.moved) return;
        suppressClickUntil = Date.now() + 800;
        onEditToolbar?.(press.node);
      }, LONG_PRESS_MS),
    };
  };

  const onPointerMove = (event) => {
    if (!longPress || event.pointerId !== longPress.pointerId) return;
    if (Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > SLOP_PX) {
      longPress.moved = true;
      cancelLongPress();
    }
  };

  const onPointerUp = () => {
    if (longPress) {
      suppressClickUntil = Date.now() + 400;
    }
    cancelLongPress();
  };

  const onClickCapture = (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  scroll.addEventListener('pointerdown', onPointerDown);
  scroll.addEventListener('pointermove', onPointerMove);
  scroll.addEventListener('pointerup', onPointerUp);
  scroll.addEventListener('pointercancel', onPointerUp);
  scroll.addEventListener('click', onClickCapture, true);

  return {
    suppressClick() {
      return Date.now() < suppressClickUntil || sheetOpen();
    },
    destroy() {
      cancelLongPress();
      scroll.removeEventListener('pointerdown', onPointerDown);
      scroll.removeEventListener('pointermove', onPointerMove);
      scroll.removeEventListener('pointerup', onPointerUp);
      scroll.removeEventListener('pointercancel', onPointerUp);
      scroll.removeEventListener('click', onClickCapture, true);
    },
  };
}
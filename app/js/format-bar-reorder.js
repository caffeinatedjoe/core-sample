// Long-press move mode and drag-to-reorder for the format toolbar scroll row.

import {
  formatBarId,
  mergeFormatBarOrder,
  neighborTransforms,
  readFormatBarOrder,
  targetDropIndex,
  writeFormatBarOrder,
} from './format-bar-order.js';

const LONG_PRESS_MS = 500;
const SLOP_PX = 8;
const EDGE_INSET = 28;
const SCROLL_STEP = 10;

export function applySavedFormatBarOrder(bar, storage = globalThis.localStorage) {
  const scroll = bar?.querySelector?.('.format-scroll');
  if (!scroll) return;
  const saved = mergeFormatBarOrder(readFormatBarOrder(storage));
  applyDomOrder(scroll, saved);
}

function applyDomOrder(scroll, order) {
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
}

function readDomOrder(scroll) {
  return [...scroll.children]
    .filter((node) => node.classList.contains('format-btn'))
    .map((node) => formatBarId(node))
    .filter(Boolean);
}

export function mountFormatBarReorder(doc, bar, {
  storage = globalThis.localStorage,
  onMoveModeChange,
} = {}) {
  const scroll = bar.querySelector('.format-scroll');
  const view = doc.defaultView;
  if (!scroll || !view) {
    return { active: () => false, destroy() {} };
  }

  let moveMode = false;
  let longPress = null;
  let suppressClickUntil = 0;
  let drag = null;
  let raf = 0;
  let pendingPointer = null;
  let exitListeners = null;
  let moveModeEnteredAt = 0;

  const clearTransforms = () => {
    for (const child of scroll.children) {
      if (!child.classList.contains('format-btn')) continue;
      child.style.transform = '';
      child.style.opacity = '';
      child.classList.remove('is-dragging');
    }
  };

  const persistOrder = () => {
    writeFormatBarOrder(readDomOrder(scroll), storage);
  };

  const exitMoveMode = () => {
    if (!moveMode && !drag) return;
    if (drag) finishDrag(false);
    moveMode = false;
    bar.classList.remove('is-format-reorder');
    scroll.classList.remove('is-format-reorder');
    clearTransforms();
    unbindExitListeners();
    persistOrder();
    onMoveModeChange?.(false);
  };

  const enterMoveMode = () => {
    if (moveMode) return;
    moveMode = true;
    moveModeEnteredAt = Date.now();
    bar.classList.add('is-format-reorder');
    scroll.classList.add('is-format-reorder');
    onMoveModeChange?.(true);
    view.requestAnimationFrame(() => {
      if (moveMode) bindExitListeners();
    });
    suppressClickUntil = Date.now() + 600;
  };

  const bindExitListeners = () => {
    if (exitListeners) return;
    const onOutside = (event) => {
      if (Date.now() - moveModeEnteredAt < 80) return;
      if (bar.contains(event.target)) return;
      exitMoveMode();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') exitMoveMode();
    };
    doc.addEventListener('pointerdown', onOutside, true);
    doc.addEventListener('keydown', onKey);
    exitListeners = () => {
      doc.removeEventListener('pointerdown', onOutside, true);
      doc.removeEventListener('keydown', onKey);
      exitListeners = null;
    };
  };

  const unbindExitListeners = () => {
    exitListeners?.();
  };

  const cancelLongPress = () => {
    if (!longPress) return;
    view.clearTimeout(longPress.timer);
    longPress = null;
  };

  const pointerXContent = (clientX) => {
    const box = scroll.getBoundingClientRect();
    return clientX - box.left + scroll.scrollLeft;
  };

  const measureItems = () => {
    const box = scroll.getBoundingClientRect();
    const items = [...scroll.querySelectorAll(':scope > .format-btn')];
    return items.map((node, index) => {
      const r = node.getBoundingClientRect();
      const width = r.width;
      const left = r.left - box.left + scroll.scrollLeft;
      return { node, index, id: formatBarId(node), width, left, center: left + width / 2 };
    });
  };

  const autoScroll = (clientX) => {
    const box = scroll.getBoundingClientRect();
    let delta = 0;
    if (clientX < box.left + EDGE_INSET) delta = -SCROLL_STEP;
    else if (clientX > box.right - EDGE_INSET) delta = SCROLL_STEP;
    if (!delta) return false;
    const before = scroll.scrollLeft;
    scroll.scrollLeft += delta;
    return scroll.scrollLeft !== before;
  };

  const applyDropIndex = (clientX) => {
    if (!drag) return;
    const contentX = pointerXContent(clientX);
    drag.to = targetDropIndex(drag.from, drag.centers, contentX);
  };

  const paintDragFrame = () => {
    raf = 0;
    if (!drag || !pendingPointer) return;
    const { clientX, clientY } = pendingPointer;
    pendingPointer = null;

    if (autoScroll(clientX)) {
      drag.items = measureItems();
      const item = drag.items[drag.from];
      if (item) {
        drag.stride = item.width;
        drag.centers = drag.items.map((row) => row.center);
      }
    }

    applyDropIndex(clientX);

    const dragged = drag.items[drag.from]?.node;
    if (dragged) {
      const dx = clientX - drag.anchorX;
      const dy = clientY - drag.anchorY;
      dragged.style.transform = `translate(${dx}px, ${dy}px)`;
    }

    const offsets = neighborTransforms(drag.items.length, drag.from, drag.to, drag.stride);
    for (let i = 0; i < drag.items.length; i++) {
      const node = drag.items[i].node;
      if (i === drag.from) continue;
      const tx = offsets[i];
      node.style.transform = tx ? `translateX(${tx}px)` : '';
      node.style.opacity = tx ? '0.92' : '';
    }
  };

  const scheduleFrame = (clientX, clientY) => {
    pendingPointer = { clientX, clientY };
    if (!raf) raf = view.requestAnimationFrame(paintDragFrame);
  };

  const startDrag = (index, clientX, clientY, pointerId) => {
    const items = measureItems();
    const from = items.findIndex((row) => row.index === index);
    if (from < 0) return;
    drag = {
      pointerId,
      from,
      to: from,
      anchorX: clientX,
      anchorY: clientY,
      items,
      centers: items.map((row) => row.center),
      stride: items[from].width,
    };
    const node = items[from].node;
    node.classList.add('is-dragging');
    try {
      scroll.setPointerCapture(pointerId);
    } catch {
      /* already captured */
    }
    scheduleFrame(clientX, clientY);
  };

  const commitDomReorder = () => {
    if (!drag || drag.from === drag.to) return;
    const order = readDomOrder(scroll);
    const next = order.slice();
    const [item] = next.splice(drag.from, 1);
    next.splice(drag.to, 0, item);
    applyDomOrder(scroll, next);
  };

  const finishDrag = (commit, clientX = null) => {
    if (!drag) return;
    if (raf) {
      view.cancelAnimationFrame(raf);
      raf = 0;
    }
    const finalX = clientX ?? pendingPointer?.clientX;
    pendingPointer = null;
    if (finalX != null) applyDropIndex(finalX);
    try {
      scroll.releasePointerCapture(drag.pointerId);
    } catch {
      /* ok */
    }
    if (commit) commitDomReorder();
    clearTransforms();
    drag = null;
    suppressClickUntil = Date.now() + 400;
  };

  const onScrollPointerDown = (event) => {
    if (event.button && event.button !== 0) return;
    const btn = event.target.closest?.('.format-scroll .format-btn');
    if (!btn || !scroll.contains(btn)) return;
    if (btn.tagName === 'BUTTON' || moveMode || drag) event.preventDefault();

    if (moveMode) {
      suppressClickUntil = Date.now() + 400;
      const items = measureItems();
      const row = items.find((item) => item.node === btn);
      if (row) startDrag(row.index, event.clientX, event.clientY, event.pointerId);
      return;
    }

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
        enterMoveMode();
      }, LONG_PRESS_MS),
    };
  };

  const onScrollPointerMove = (event) => {
    if (longPress) {
      if (Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > SLOP_PX) {
        longPress.moved = true;
        cancelLongPress();
      }
      return;
    }
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    scheduleFrame(event.clientX, event.clientY);
  };

  const onScrollPointerUp = (event) => {
    cancelLongPress();
    if (!drag || event.pointerId !== drag.pointerId) return;
    finishDrag(true, event.clientX);
  };

  const onScrollPointerCancel = (event) => {
    cancelLongPress();
    if (!drag || event.pointerId !== drag.pointerId) return;
    finishDrag(false, event.clientX);
  };

  const onScrollClick = (event) => {
    if (Date.now() < suppressClickUntil || moveMode || drag) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  scroll.addEventListener('pointerdown', onScrollPointerDown);
  scroll.addEventListener('pointermove', onScrollPointerMove, { passive: false });
  scroll.addEventListener('pointerup', onScrollPointerUp);
  scroll.addEventListener('pointercancel', onScrollPointerCancel);
  scroll.addEventListener('click', onScrollClick, true);

  return {
    active() {
      return moveMode || Boolean(drag);
    },
    suppressClick() {
      return Date.now() < suppressClickUntil || moveMode || Boolean(drag);
    },
    destroy() {
      cancelLongPress();
      finishDrag(false);
      exitMoveMode();
      scroll.removeEventListener('pointerdown', onScrollPointerDown);
      scroll.removeEventListener('pointermove', onScrollPointerMove);
      scroll.removeEventListener('pointerup', onScrollPointerUp);
      scroll.removeEventListener('pointercancel', onScrollPointerCancel);
      scroll.removeEventListener('click', onScrollClick, true);
    },
  };
}
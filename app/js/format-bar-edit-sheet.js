// Edit toolbar sheet: one grid, draggable divider, live bar updates.

import {
  applyTileMove,
  clampHiddenFrom,
  mergeFormatBarLayout,
  readFormatBarLayout,
  resetFormatBarLayout,
  targetGridDropIndex,
  targetHiddenFrom,
} from './format-bar-order.js';
import {
  applyFormatBarLayout,
  persistFormatBarLayout,
  readLayoutFromBar,
} from './format-bar-reorder.js';

const SLOP_PX = 8;
const HOLD_MS = 150;
const TILE_MIN = 44;

export function mountFormatBarEditSheet(doc, bar, {
  storage = globalThis.localStorage,
  onOpen,
  onClose,
  focusEditor,
} = {}) {
  const root = doc.getElementById('format-edit-sheet');
  const grid = doc.getElementById('format-edit-grid');
  const scrim = doc.getElementById('format-edit-scrim');
  const doneBtn = doc.getElementById('format-edit-done');
  const resetBtn = doc.getElementById('format-edit-reset');
  const scroll = bar?.querySelector?.('.format-scroll');
  const view = doc.defaultView;
  if (!root || !grid || !scroll || !view) {
    return { open: () => false, destroy() {} };
  }

  let layout = mergeFormatBarLayout(readFormatBarLayout(storage));
  let open = false;
  let savedSelection = null;

  let drag = null;
  let raf = 0;
  let pendingPointer = null;
  let holdTimer = 0;
  let press = null;

  const tileRects = () => {
    const tiles = [...grid.querySelectorAll('.format-edit-tile')];
    const gridBox = grid.getBoundingClientRect();
    return tiles.map((node) => {
      const r = node.getBoundingClientRect();
      return {
        node,
        index: Number(node.dataset.index),
        left: r.left - gridBox.left + grid.scrollLeft,
        top: r.top - gridBox.top + grid.scrollTop,
        width: r.width,
        height: r.height,
      };
    });
  };

  const measureCells = () => tileRects().map((row) => ({
    index: row.index,
    left: row.left,
    top: row.top,
    width: row.width,
    height: row.height,
  }));

  const dividerEl = () => grid.querySelector('.format-edit-divider');

  const runFlip = (beforeRects) => {
    const after = new Map();
    for (const row of tileRects()) {
      after.set(row.node, row);
    }
    for (const [node, prev] of beforeRects) {
      const next = after.get(node);
      if (!next) continue;
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (!dx && !dy) continue;
      node.style.transform = `translate(${dx}px, ${dy}px)`;
      node.style.transition = 'none';
    }
    view.requestAnimationFrame(() => {
      for (const node of after.keys()) {
        node.style.transition = 'transform 180ms ease';
        node.style.transform = '';
      }
      view.setTimeout(() => {
        for (const node of after.keys()) {
          node.style.transition = '';
        }
      }, 200);
    });
  };

  const labelFor = (id) => {
    const src = scroll.querySelector(`[data-format="${id}"]`);
    if (!src) return id;
    return src.getAttribute('aria-label') || src.getAttribute('title') || id;
  };

  const iconHtmlFor = (id) => {
    const src = scroll.querySelector(`[data-format="${id}"]`);
    if (!src) return '';
    const inner = src.querySelector('svg') || (src.classList.contains('format-comment') ? src : null);
    return inner ? inner.outerHTML : '';
  };

  const render = () => {
    const { order, hiddenFrom } = layout;
    const hf = clampHiddenFrom(hiddenFrom, order.length);
    grid.replaceChildren();
    const addTile = (id, index) => {
      const tile = doc.createElement('button');
      tile.type = 'button';
      tile.className = 'format-edit-tile';
      tile.dataset.id = id;
      tile.dataset.index = String(index);
      tile.setAttribute('aria-label', labelFor(id));
      const icon = doc.createElement('span');
      icon.className = 'format-edit-icon';
      icon.innerHTML = iconHtmlFor(id);
      const label = doc.createElement('span');
      label.className = 'format-edit-label';
      label.textContent = labelFor(id);
      tile.append(icon, label);
      grid.appendChild(tile);
    };
    for (let i = 0; i < hf; i += 1) addTile(order[i], i);
    const divider = doc.createElement('div');
    divider.className = 'format-edit-divider';
    divider.dataset.role = 'divider';
    divider.innerHTML = '<span class="format-edit-divider-label">Hidden below</span><span class="format-edit-divider-grip" aria-hidden="true"></span>';
    grid.appendChild(divider);
    for (let i = hf; i < order.length; i += 1) addTile(order[i], i);
    const empty = doc.createElement('p');
    empty.className = 'format-edit-empty';
    empty.hidden = hf < order.length;
    empty.textContent = 'No hidden controls.';
    grid.appendChild(empty);
  };

  const applyLive = () => {
    applyFormatBarLayout(bar, layout);
    persistFormatBarLayout(bar, layout, storage);
  };

  const bounceTile = (node) => {
    if (!node || node.dataset.role === 'divider') return;
    node.classList.remove('is-bounce');
    void node.offsetWidth;
    node.classList.add('is-bounce');
    view.setTimeout(() => node.classList.remove('is-bounce'), 220);
  };

  const setSheetOpen = (visible) => {
    open = visible;
    if (visible) {
      root.hidden = false;
      root.setAttribute('aria-hidden', 'false');
      view.requestAnimationFrame(() => root.classList.add('is-open'));
    } else {
      root.classList.remove('is-open');
      root.setAttribute('aria-hidden', 'true');
      const hide = () => {
        root.hidden = true;
      };
      if (view.matchMedia('(prefers-reduced-motion: reduce)').matches) hide();
      else view.setTimeout(hide, 240);
    }
  };

  const closeSheet = ({ refocus = true } = {}) => {
    if (!open) return;
    finishDrag(false);
    setSheetOpen(false);
    onClose?.();
    if (refocus) focusEditor?.(savedSelection);
    savedSelection = null;
  };

  const openSheet = (selection) => {
    layout = mergeFormatBarLayout(readFormatBarLayout(storage) || readLayoutFromBar(bar));
    savedSelection = selection ?? null;
    render();
    applyLive();
    setSheetOpen(true);
    onOpen?.();
  };

  const clearDragTransforms = () => {
    for (const node of grid.querySelectorAll('.format-edit-tile, .format-edit-divider')) {
      node.style.transform = '';
      node.style.opacity = '';
      node.classList.remove('is-dragging');
      node.style.touchAction = '';
    }
  };

  const startDrag = (kind, node, pointerId, clientX, clientY) => {
    const tileId = node.dataset.id;
    drag = {
      kind,
      node,
      tileId,
      pointerId,
      anchorX: clientX,
      anchorY: clientY,
      fromIndex: Number(node.dataset.index ?? -1),
      previewTo: null,
    };
    node.classList.add('is-dragging');
    node.style.touchAction = 'none';
    try {
      grid.setPointerCapture(pointerId);
    } catch {
      /* ok */
    }
  };

  const paintDrag = () => {
    raf = 0;
    if (!drag || !pendingPointer) return;
    const { clientX, clientY } = pendingPointer;
    pendingPointer = null;
    const dx = clientX - drag.anchorX;
    const dy = clientY - drag.anchorY;
    drag.node.style.transform = `translate(${dx}px, ${dy}px)`;
    const gridBox = grid.getBoundingClientRect();

    if (drag.kind === 'divider') {
      const cells = measureCells();
      const localY = clientY - gridBox.top + grid.scrollTop;
      const nextHf = targetHiddenFrom(layout.order.length, cells, localY);
      if (nextHf !== layout.hiddenFrom) {
        const beforeRects = new Map(tileRects().map((row) => [row.node, row]));
        layout = { ...layout, hiddenFrom: nextHf };
        render();
        runFlip(beforeRects);
        applyLive();
      }
      return;
    }

    const localX = clientX - gridBox.left + grid.scrollLeft;
    const localY = clientY - gridBox.top + grid.scrollTop;
    const cells = measureCells();
    const divider = dividerEl();
    let dividerRow = null;
    if (divider) {
      const r = divider.getBoundingClientRect();
      dividerRow = {
        index: clampHiddenFrom(layout.hiddenFrom, layout.order.length),
        top: r.top - gridBox.top + grid.scrollTop,
        height: r.height,
      };
    }
    const target = targetGridDropIndex(
      cells,
      localX,
      localY,
      drag.fromIndex,
      { dividerRow },
    );
    const clamped = Math.max(0, Math.min(target, layout.order.length));
    const dividerBox = dividerEl()?.getBoundingClientRect();
    const intoHidden = dividerBox ? clientY > dividerBox.bottom - 4 : false;
    if (clamped !== drag.previewTo) {
      drag.previewTo = clamped;
      const beforeRects = new Map(tileRects().map((row) => [row.node, row]));
      layout = applyTileMove(layout, drag.fromIndex, clamped, { intoHidden });
      drag.fromIndex = layout.order.indexOf(drag.tileId);
      render();
      runFlip(beforeRects);
      applyLive();
      const fresh = grid.querySelector(`[data-id="${drag.tileId}"]`);
      if (fresh) drag.node = fresh;
      drag.node?.classList.add('is-dragging');
      drag.node.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  };

  const scheduleFrame = (clientX, clientY) => {
    pendingPointer = { clientX, clientY };
    if (!raf) raf = view.requestAnimationFrame(paintDrag);
  };

  const finishDrag = (commit) => {
    if (!drag) return;
    if (raf) {
      view.cancelAnimationFrame(raf);
      raf = 0;
    }
  pendingPointer = null;
    try {
      grid.releasePointerCapture(drag.pointerId);
    } catch {
      /* ok */
    }
    if (commit) {
      if (drag.kind === 'tile' && drag.previewTo != null) {
        /* layout already committed during drag */
      }
      applyLive();
    }
    clearDragTransforms();
    drag = null;
  };

  const clearHold = () => {
    if (holdTimer) {
      view.clearTimeout(holdTimer);
      holdTimer = 0;
    }
  };

  const tryStartDrag = (node, pointerId, clientX, clientY) => {
    if (node.dataset.role === 'divider') startDrag('divider', node, pointerId, clientX, clientY);
    else startDrag('tile', node, pointerId, clientX, clientY);
  };

  const onGridPointerDown = (event) => {
    if (!open || (event.button && event.button !== 0)) return;
    const tile = event.target.closest?.('.format-edit-tile, .format-edit-divider');
    if (!tile || !grid.contains(tile)) return;
    clearHold();
    if (tile.dataset.role === 'divider') {
      press = {
        node: tile,
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
        dragging: true,
      };
      tryStartDrag(tile, event.pointerId, event.clientX, event.clientY);
      return;
    }
    press = {
      node: tile,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      dragging: false,
    };
    holdTimer = view.setTimeout(() => {
      if (!press || press.dragging || drag) return;
      press.dragging = true;
      tryStartDrag(press.node, press.pointerId, press.x, press.y);
    }, HOLD_MS);
  };

  const onGridPointerMove = (event) => {
    if (!press || event.pointerId !== press.pointerId) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    const dist = Math.hypot(dx, dy);
    const isDivider = press.node?.dataset?.role === 'divider';
    if (!press.dragging && !drag && dist > SLOP_PX) {
      if (Math.abs(dx) >= Math.abs(dy) || isDivider) {
        press.dragging = true;
        clearHold();
        tryStartDrag(press.node, press.pointerId, event.clientX, event.clientY);
      }
    }
    if (drag && event.pointerId === drag.pointerId) {
      event.preventDefault();
      scheduleFrame(event.clientX, event.clientY);
    }
  };

  const onGridPointerUp = (event) => {
    if (press && event.pointerId === press.pointerId) {
      clearHold();
      if (drag && event.pointerId === drag.pointerId) {
        pendingPointer = { clientX: event.clientX, clientY: event.clientY };
        if (raf) view.cancelAnimationFrame(raf);
        paintDrag();
        finishDrag(true);
      } else if (!press.dragging) {
        bounceTile(press.node);
      }
      press = null;
    }
  };

  const onReset = () => {
    layout = resetFormatBarLayout();
    render();
    applyLive();
  };

  const onDone = () => {
    applyLive();
    closeSheet({ refocus: true });
  };

  doneBtn?.addEventListener('click', onDone);
  resetBtn?.addEventListener('click', onReset);
  scrim?.addEventListener('click', () => closeSheet({ refocus: true }));

  const onKey = (event) => {
    if (event.key === 'Escape' && open) closeSheet({ refocus: true });
  };
  doc.addEventListener('keydown', onKey);
  grid.addEventListener('pointerdown', onGridPointerDown);
  grid.addEventListener('pointermove', onGridPointerMove, { passive: false });
  grid.addEventListener('pointerup', onGridPointerUp);
  grid.addEventListener('pointercancel', onGridPointerUp);

  return {
    open: () => open,
    show(selection) {
      openSheet(selection);
    },
    close() {
      closeSheet({ refocus: false });
    },
    destroy() {
      finishDrag(false);
      clearHold();
      doneBtn?.removeEventListener('click', onDone);
      resetBtn?.removeEventListener('click', onReset);
      scrim?.removeEventListener('click', () => closeSheet({ refocus: true }));
      doc.removeEventListener('keydown', onKey);
      grid.removeEventListener('pointerdown', onGridPointerDown);
      grid.removeEventListener('pointermove', onGridPointerMove);
      grid.removeEventListener('pointerup', onGridPointerUp);
      grid.removeEventListener('pointercancel', onGridPointerUp);
    },
  };
}
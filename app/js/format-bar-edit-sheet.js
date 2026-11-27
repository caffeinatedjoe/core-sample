// Edit toolbar sheet: one grid, draggable divider, live bar updates.

import {
  applyTileMove,
  clampHiddenFrom,
  mergeFormatBarLayout,
  readFormatBarLayout,
  resetFormatBarLayout,
  resolveIntoHidden,
  stabilizeGridDropIndex,
  stabilizeHiddenFrom,
} from './format-bar-order.js';
import {
  applyFormatBarLayout,
  persistFormatBarLayout,
  readLayoutFromBar,
} from './format-bar-reorder.js';

const SLOP_PX = 8;
const HOLD_MS = 150;

export function mountFormatBarEditSheet(doc, bar, {
  storage = globalThis.localStorage,
  onOpen,
  onClose,
  focusEditor,
  blurEditor,
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
  let flipTimers = new Set();

  const layoutTiles = () => [...grid.querySelectorAll('.format-edit-tile')];

  const measureCells = () => {
    const cells = [];
    for (const node of layoutTiles()) {
      if (node.classList.contains('is-placeholder')) continue;
      cells.push({
        node,
        index: Number(node.dataset.index),
        left: node.offsetLeft,
        top: node.offsetTop,
        width: node.offsetWidth,
        height: node.offsetHeight,
      });
    }
    return cells;
  };

  const dividerEl = () => grid.querySelector('.format-edit-divider');
  const emptyEl = () => grid.querySelector('.format-edit-empty');

  const visualRects = () => {
    const gridBox = grid.getBoundingClientRect();
    const map = new Map();
    for (const node of grid.querySelectorAll('.format-edit-tile, .format-edit-divider')) {
      if (node.classList.contains('is-placeholder')) continue;
      const r = node.getBoundingClientRect();
      map.set(node, {
        left: r.left - gridBox.left + grid.scrollLeft,
        top: r.top - gridBox.top + grid.scrollTop,
        width: r.width,
        height: r.height,
      });
    }
    return map;
  };

  const layoutRects = () => {
    const map = new Map();
    for (const row of measureCells()) {
      map.set(row.node, row);
    }
    const div = dividerEl();
    if (div) {
      map.set(div, {
        left: div.offsetLeft,
        top: div.offsetTop,
        width: div.offsetWidth,
        height: div.offsetHeight,
      });
    }
    return map;
  };

  const runFlip = (beforeVisual, afterNodes = null) => {
    const moving = afterNodes || [...grid.querySelectorAll('.format-edit-tile, .format-edit-divider')];
    const after = layoutRects();
    for (const node of moving) {
      if (node.classList.contains('is-placeholder')) continue;
      if (drag?.placeholder === node) continue;
      const prev = beforeVisual.get(node);
      const next = after.get(node);
      if (!prev || !next) continue;
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (!dx && !dy) {
        node.style.transition = '';
        node.style.transform = '';
        continue;
      }
      node.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      node.style.transition = 'none';
    }
    view.requestAnimationFrame(() => {
      for (const node of moving) {
        if (node.classList.contains('is-placeholder')) continue;
        if (!after.has(node)) continue;
        node.style.transition = 'transform 180ms ease';
        node.style.transform = '';
      }
      const t = view.setTimeout(() => {
        flipTimers.delete(t);
        for (const node of moving) {
          node.style.transition = '';
        }
      }, 200);
      flipTimers.add(t);
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

  const makeTile = (id, index) => {
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
    return tile;
  };

  const ensureDivider = () => {
    let divider = dividerEl();
    if (!divider) {
      divider = doc.createElement('div');
      divider.className = 'format-edit-divider';
      divider.dataset.role = 'divider';
      divider.innerHTML = '<span class="format-edit-divider-label">Hidden below</span><span class="format-edit-divider-grip" aria-hidden="true"></span>';
      grid.appendChild(divider);
    }
    return divider;
  };

  const ensureEmpty = () => {
    let empty = emptyEl();
    if (!empty) {
      empty = doc.createElement('p');
      empty.className = 'format-edit-empty';
      empty.textContent = 'No hidden controls.';
      grid.appendChild(empty);
    }
    return empty;
  };

  const updateEmptyVisibility = () => {
    const empty = emptyEl();
    if (!empty) return;
    const hf = clampHiddenFrom(layout.hiddenFrom, layout.order.length);
    const hasHidden = hf < layout.order.length;
    empty.hidden = false;
    empty.style.visibility = hasHidden ? 'hidden' : 'visible';
    empty.setAttribute('aria-hidden', hasHidden ? 'true' : 'false');
  };

  const syncGridDom = () => {
    const { order, hiddenFrom } = layout;
    const hf = clampHiddenFrom(hiddenFrom, order.length);
    const divider = ensureDivider();
    const empty = ensureEmpty();
    const orderSet = new Set(order);
    for (const node of layoutTiles()) {
      if (!orderSet.has(node.dataset.id)) node.remove();
    }
    for (let i = 0; i < order.length; i += 1) {
      let tile = grid.querySelector(`[data-id="${order[i]}"]`);
      if (!tile) tile = makeTile(order[i], i);
      tile.dataset.index = String(i);
    }
    const sequence = [
      ...order.slice(0, hf).map((id) => grid.querySelector(`[data-id="${id}"]`)),
      divider,
      ...order.slice(hf).map((id) => grid.querySelector(`[data-id="${id}"]`)),
      empty,
    ];
    for (const node of sequence) {
      if (node) grid.appendChild(node);
    }
    updateEmptyVisibility();
  };

  const render = () => {
    const { order } = layout;
    grid.replaceChildren();
    for (let i = 0; i < order.length; i += 1) {
      grid.appendChild(makeTile(order[i], i));
    }
    ensureDivider();
    ensureEmpty();
    syncGridDom();
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
    blurEditor?.();
  };

  const removeGhost = () => {
    root.querySelectorAll('.format-edit-ghost, .format-edit-divider-ghost').forEach((n) => n.remove());
  };

  const clearDragTransforms = () => {
    for (const node of grid.querySelectorAll('.format-edit-tile, .format-edit-divider')) {
      node.style.transform = '';
      node.style.opacity = '';
      node.classList.remove('is-dragging', 'is-placeholder');
      node.style.touchAction = '';
    }
    removeGhost();
  };

  const placeTileGhost = (source, clientX, clientY) => {
    removeGhost();
    const r = source.getBoundingClientRect();
    drag.grabOffsetX = clientX - (r.left + r.width / 2);
    drag.grabOffsetY = clientY - (r.top + r.height / 2);
    drag.ghostW = r.width;
    drag.ghostH = r.height;
    const ghost = source.cloneNode(true);
    ghost.classList.add('format-edit-ghost');
    ghost.classList.remove('is-dragging', 'is-placeholder', 'is-bounce');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    root.appendChild(ghost);
    drag.ghost = ghost;
    drag.placeholder = source;
    source.classList.add('is-placeholder');
    source.style.opacity = '0';
    void ghost.offsetWidth;
    moveGhost(clientX, clientY);
  };

  const placeDividerGhost = (source, clientX, clientY) => {
    removeGhost();
    const r = source.getBoundingClientRect();
    drag.grabOffsetY = clientY - (r.top + r.height / 2);
    drag.ghostW = r.width;
    drag.ghostH = r.height;
    const ghost = doc.createElement('div');
    ghost.className = 'format-edit-divider-ghost';
    ghost.innerHTML = '<span class="format-edit-divider-grip" aria-hidden="true"></span>';
    ghost.style.width = `${r.width}px`;
    root.appendChild(ghost);
    drag.ghost = ghost;
    source.style.opacity = '0.35';
    void ghost.offsetWidth;
    moveDividerGhost(clientX, clientY);
  };

  const moveGhost = (clientX, clientY) => {
    if (!drag?.ghost) return;
    const cx = clientX - drag.grabOffsetX;
    const cy = clientY - drag.grabOffsetY;
    const hw = (drag.ghostW || drag.ghost.offsetWidth) / 2;
    const hh = (drag.ghostH || drag.ghost.offsetHeight) / 2;
    drag.ghost.style.transform = `translate3d(${cx - hw}px, ${cy - hh}px, 0)`;
  };

  const moveDividerGhost = (clientX, clientY) => {
    if (!drag?.ghost) return;
    const cy = clientY - drag.grabOffsetY;
    const hw = (drag.ghostW || drag.ghost.offsetWidth) / 2;
    const hh = (drag.ghostH || drag.ghost.offsetHeight || 44) / 2;
    drag.ghost.style.transform = `translate3d(${clientX - hw}px, ${cy - hh}px, 0)`;
  };

  const startDrag = (kind, node, pointerId, clientX, clientY) => {
    const tileId = node.dataset.id;
    drag = {
      kind,
      node,
      tileId,
      pointerId,
      fromIndex: Number(node.dataset.index ?? -1),
      previewTo: null,
      intoHidden: null,
      ghost: null,
      placeholder: null,
      grabOffsetX: 0,
      grabOffsetY: 0,
      ghostW: 0,
      ghostH: 0,
    };
    node.classList.add('is-dragging');
    node.style.touchAction = 'none';
    if (kind === 'tile') placeTileGhost(node, clientX, clientY);
    else placeDividerGhost(node, clientX, clientY);
    try {
      grid.setPointerCapture(pointerId);
    } catch {
      /* ok */
    }
  };

  const dividerMidLocalY = () => {
    const div = dividerEl();
    if (!div) return 0;
    return div.offsetTop + div.offsetHeight / 2;
  };

  const commitDomReorder = (beforeVisual) => {
    syncGridDom();
    const flipNodes = layoutTiles().filter((n) => n !== drag?.placeholder);
    flipNodes.push(dividerEl());
    runFlip(beforeVisual, flipNodes.filter(Boolean));
  };

  const paintDrag = () => {
    raf = 0;
    if (!drag || !pendingPointer) return;
    const { clientX, clientY } = pendingPointer;
    pendingPointer = null;

    if (drag.kind === 'divider') {
      moveDividerGhost(clientX, clientY);
      const cells = measureCells();
      const localY = clientY - grid.getBoundingClientRect().top + grid.scrollTop;
      const nextHf = stabilizeHiddenFrom(
        layout.order.length,
        cells,
        localY,
        layout.hiddenFrom,
      );
      if (nextHf !== layout.hiddenFrom) {
        const beforeVisual = visualRects();
        layout = { ...layout, hiddenFrom: nextHf };
        commitDomReorder(beforeVisual);
        applyLive();
      }
      return;
    }

    moveGhost(clientX, clientY);
    const gridBox = grid.getBoundingClientRect();
    const localX = clientX - gridBox.left + grid.scrollLeft;
    const localY = clientY - gridBox.top + grid.scrollTop;
    const cells = measureCells();
    const hf = clampHiddenFrom(layout.hiddenFrom, layout.order.length);
    const div = dividerEl();
    const dividerRow = div ? {
      index: hf,
      top: div.offsetTop,
      height: div.offsetHeight,
    } : null;
    const midY = dividerMidLocalY();
    const intoHidden = resolveIntoHidden(localY, midY, drag.intoHidden);
    const target = stabilizeGridDropIndex(
      cells,
      localX,
      localY,
      drag.fromIndex,
      drag.previewTo,
      { dividerRow },
    );
    const clamped = Math.max(0, Math.min(target, layout.order.length));
    if (clamped !== drag.previewTo || intoHidden !== drag.intoHidden) {
      const beforeVisual = visualRects();
      drag.previewTo = clamped;
      drag.intoHidden = intoHidden;
      layout = applyTileMove(layout, drag.fromIndex, clamped, { intoHidden });
      drag.fromIndex = layout.order.indexOf(drag.tileId);
      commitDomReorder(beforeVisual);
      applyLive();
      if (drag.placeholder) {
        drag.placeholder.dataset.index = String(drag.fromIndex);
      }
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
    for (const t of flipTimers) view.clearTimeout(t);
    flipTimers.clear();
    if (commit) applyLive();
    syncGridDom();
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
      if (drag.kind === 'tile') moveGhost(event.clientX, event.clientY);
      else moveDividerGhost(event.clientX, event.clientY);
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
  const onGridTouchMove = (event) => {
    if (drag) event.preventDefault();
  };

  grid.addEventListener('pointerdown', onGridPointerDown);
  grid.addEventListener('pointermove', onGridPointerMove, { passive: false });
  grid.addEventListener('pointerup', onGridPointerUp);
  grid.addEventListener('pointercancel', onGridPointerUp);
  grid.addEventListener('touchmove', onGridTouchMove, { passive: false });

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
      grid.removeEventListener('touchmove', onGridTouchMove);
    },
  };
}
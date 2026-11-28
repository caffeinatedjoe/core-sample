// Edit toolbar sheet: shown/hidden grids, transform-only drag until drop.

import {
  FORMAT_EDIT_SECTION_HIDDEN,
  FORMAT_EDIT_SECTION_SHOWN,
  clampHiddenFrom,
  commitFormatEditMove,
  FORMAT_EDIT_MIN_CELL_PX,
  formatEditFrozenRows,
  formatEditGridColumnCount,
  formatEditGridPixelHeight,
  formatEditProjectionSlots,
  formatEditProjectedSlotCount,
  formatEditSlotRect,
  formatEditSlotTranslate,
  pointerToFormatEditSlot,
  layoutToSections,
  mergeFormatBarLayout,
  pickFormatEditDragTarget,
  pickFormatEditSection,
  readFormatBarLayout,
  resetFormatBarLayout,
  sectionsToLayout,
} from './format-bar-order.js';
import {
  applyFormatBarLayout,
  persistFormatBarLayout,
  readLayoutFromBar,
} from './format-bar-reorder.js';

const SLOP_PX = 8;
const HOLD_MS = 150;
const TILE_TRANSITION = 'transform 180ms ease';
const GHOST_SETTLE_MS = 150;

export function mountFormatBarEditSheet(doc, bar, {
  storage = globalThis.localStorage,
  onOpen,
  onClose,
  focusEditor,
  blurEditor,
} = {}) {
  const root = doc.getElementById('format-edit-sheet');
  const scroll = doc.getElementById('format-edit-scroll');
  const shownGrid = doc.getElementById('format-edit-shown');
  const hiddenGrid = doc.getElementById('format-edit-hidden');
  const hiddenHead = doc.getElementById('format-edit-hidden-head');
  const scrim = doc.getElementById('format-edit-scrim');
  const doneBtn = doc.getElementById('format-edit-done');
  const resetBtn = doc.getElementById('format-edit-reset');
  const barScroll = bar?.querySelector?.('.format-scroll');
  const view = doc.defaultView;
  if (!root || !scroll || !shownGrid || !hiddenGrid || !hiddenHead || !barScroll || !view) {
    return { open: () => false, destroy() {} };
  }

  let layout = mergeFormatBarLayout(readFormatBarLayout(storage));
  let open = false;
  let savedSelection = null;

  let drag = null;
  let raf = 0;
  let pendingFrame = null;
  let holdTimer = 0;
  let press = null;
  let sheetGeom = null;

  const sections = () => layoutToSections(layout);
  const layoutTiles = () => [...shownGrid.querySelectorAll('.format-edit-tile'), ...hiddenGrid.querySelectorAll('.format-edit-tile')];

  const labelFor = (id) => {
    const src = barScroll.querySelector(`[data-format="${id}"]`);
    if (!src) return id;
    return src.getAttribute('aria-label') || src.getAttribute('title') || id;
  };

  const iconHtmlFor = (id) => {
    const src = barScroll.querySelector(`[data-format="${id}"]`);
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

  const ensureEmpty = () => {
    let empty = scroll.querySelector('.format-edit-empty');
    if (!empty) {
      empty = doc.createElement('p');
      empty.className = 'format-edit-empty';
      empty.textContent = 'No hidden controls.';
      scroll.appendChild(empty);
    }
    return empty;
  };

  const updateEmptyVisibility = () => {
    const empty = ensureEmpty();
    const { hidden } = sections();
    const hasHidden = hidden.length > 0;
    empty.hidden = hasHidden;
    empty.setAttribute('aria-hidden', hasHidden ? 'true' : 'false');
  };

  const syncGridDom = () => {
    hiddenHead.hidden = false;
    const { shown, hidden } = sections();
    const orderSet = new Set([...shown, ...hidden]);
    for (const node of layoutTiles()) {
      if (!orderSet.has(node.dataset.id)) node.remove();
    }
    for (let i = 0; i < shown.length; i += 1) {
      let tile = shownGrid.querySelector(`[data-id="${shown[i]}"]`);
      if (!tile) tile = makeTile(shown[i], i);
      tile.dataset.index = String(i);
      shownGrid.appendChild(tile);
    }
    while (shownGrid.children.length > shown.length) {
      shownGrid.lastElementChild.remove();
    }
    for (let i = 0; i < hidden.length; i += 1) {
      let tile = hiddenGrid.querySelector(`[data-id="${hidden[i]}"]`);
      if (!tile) tile = makeTile(hidden[i], shown.length + i);
      tile.dataset.index = String(shown.length + i);
      hiddenGrid.appendChild(tile);
    }
    while (hiddenGrid.children.length > hidden.length) {
      hiddenGrid.lastElementChild.remove();
    }
    updateEmptyVisibility();
    if (!drag) {
      applySheetLayout(measureDragGeometry());
    }
  };

  const applyLive = () => {
    applyFormatBarLayout(bar, layout);
    persistFormatBarLayout(bar, layout, storage);
  };

  const bounceTile = (node) => {
    if (!node) return;
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
    root.querySelector('.format-edit-card')?.classList.remove('is-tight');
    view.visualViewport?.removeEventListener('resize', onViewportResize);
    view.visualViewport?.removeEventListener('scroll', onViewportResize);
    finishDrag(false);
    setSheetOpen(false);
    onClose?.();
    if (refocus) focusEditor?.(savedSelection);
    savedSelection = null;
  };

  const onViewportResize = () => {
    if (!open) return;
    fitSheetCard();
    syncSheetDensity();
  };

  const openSheet = (selection) => {
    layout = mergeFormatBarLayout(readFormatBarLayout(storage) || readLayoutFromBar(bar));
    scroll.scrollTop = 0;
    syncGridDom();
    applyLive();
    setSheetOpen(true);
    view.requestAnimationFrame(() => {
      fitSheetCard();
      syncSheetDensity();
    });
    view.visualViewport?.addEventListener('resize', onViewportResize);
    view.visualViewport?.addEventListener('scroll', onViewportResize);
    onOpen?.();
    blurEditor?.();
  };

  const removeGhost = () => {
    root.querySelectorAll('.format-edit-ghost').forEach((n) => n.remove());
  };

  const clearDragTransforms = () => {
    for (const node of layoutTiles()) {
      node.style.transition = '';
      node.style.transform = '';
      node.style.opacity = '';
      node.classList.remove('is-dragging', 'is-placeholder');
    }
    scroll.classList.remove('is-drag-scroll-lock');
    scroll.style.overscrollBehavior = '';
    shownGrid.style.height = '';
    hiddenGrid.style.height = '';
    removeGhost();
  };

  const measureDragGeometry = () => {
    const scrollBox = scroll.getBoundingClientRect();
    const scrollTop = scroll.scrollTop;
    const sample = shownGrid.querySelector('.format-edit-tile') || hiddenGrid.querySelector('.format-edit-tile');
    const styles = view.getComputedStyle(shownGrid);
    const gapX = Number.parseFloat(styles.columnGap) || 10;
    const gapY = Number.parseFloat(styles.rowGap) || 8;
    const cellWidth = sample?.offsetWidth ?? 64;
    const cellHeight = sample?.offsetHeight ?? 64;
    const columnCount = formatEditGridColumnCount(shownGrid.clientWidth, gapX, FORMAT_EDIT_MIN_CELL_PX);
    const headBox = hiddenHead.getBoundingClientRect();
    const shownBox = shownGrid.getBoundingClientRect();
    const hiddenBox = hiddenGrid.getBoundingClientRect();
    const originX = shownBox.left - scrollBox.left + scroll.scrollLeft;
    const shownOriginY = shownBox.top - scrollBox.top + scrollTop;
    const hiddenOriginY = hiddenBox.top - scrollBox.top + scrollTop;
    const headerMidY = (headBox.top + headBox.bottom) / 2 - scrollBox.top + scrollTop;
    return {
      scrollBox,
      scrollTop,
      gapX,
      gapY,
      cellWidth,
      cellHeight,
      columnCount,
      originX,
      shownOriginY,
      hiddenOriginY,
      headerMidY,
    };
  };

  const fitSheetCard = () => {
    const card = root.querySelector('.format-edit-card');
    const vv = view.visualViewport;
    if (!card || !vv) return;
    const rootEl = view.document.documentElement;
    const shellRaw = view.getComputedStyle(rootEl).getPropertyValue('--shell-h').trim();
    const shellPx = shellRaw.endsWith('px') ? Number.parseFloat(shellRaw) : 0;
    const useKeyboardShell = rootEl.classList.contains('is-keyboard') && shellPx > 0;
    const topInset = Math.max(0, vv.offsetTop);
    const viewH = useKeyboardShell ? shellPx : Math.floor(vv.height);
    const maxH = Math.max(120, Math.floor(viewH - topInset - 6));
    card.style.maxHeight = `${maxH}px`;
  };

  const clearFrozenGridHeights = () => {
    sheetGeom = null;
    shownGrid.style.height = '';
    shownGrid.style.minHeight = '';
    hiddenGrid.style.height = '';
    hiddenGrid.style.minHeight = '';
  };

  const syncSheetDensity = () => {
    const card = root.querySelector('.format-edit-card');
    if (!card) return;
    card.classList.remove('is-tight');
    clearFrozenGridHeights();
    applySheetLayout(measureDragGeometry());
    if (scroll.scrollHeight > scroll.clientHeight + 1) {
      card.classList.add('is-tight');
      clearFrozenGridHeights();
      applySheetLayout(measureDragGeometry());
    }
  };

  const applySheetLayout = (geom) => {
    const unchanged = sheetGeom
      && sheetGeom.columnCount === geom.columnCount
      && sheetGeom.cellWidth === geom.cellWidth
      && sheetGeom.cellHeight === geom.cellHeight
      && sheetGeom.gapX === geom.gapX
      && sheetGeom.gapY === geom.gapY;
    if (unchanged) return;
    freezeGridColumns(geom);
    applyFrozenGridHeights(geom);
    sheetGeom = { ...geom };
  };

  const applyFrozenGridHeights = (geom) => {
    const { shown, hidden } = sections();
    const { cellHeight, gapY, columnCount } = geom;
    const shownRows = formatEditGridPixelHeight(formatEditFrozenRows(shown.length, columnCount), cellHeight, gapY);
    const hiddenRows = formatEditGridPixelHeight(formatEditFrozenRows(hidden.length, columnCount), cellHeight, gapY);
    shownGrid.style.minHeight = `${shownRows}px`;
    shownGrid.style.height = `${shownRows}px`;
    hiddenGrid.style.minHeight = `${hiddenRows}px`;
    hiddenGrid.style.height = `${hiddenRows}px`;
  };

  const freezeGridColumns = (geom) => {
    const template = `repeat(${geom.columnCount}, minmax(${FORMAT_EDIT_MIN_CELL_PX}px, 1fr))`;
    shownGrid.style.gridTemplateColumns = template;
    hiddenGrid.style.gridTemplateColumns = template;
  };

  const lockScrollForDrag = () => {
    scroll.classList.add('is-drag-scroll-lock');
    scroll.style.overscrollBehavior = 'contain';
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
    writeGhostTransform(clientX, clientY);
  };

  const writeGhostTransform = (clientX, clientY) => {
    if (!drag?.ghost) return;
    const cx = clientX - drag.grabOffsetX;
    const cy = clientY - drag.grabOffsetY;
    const hw = (drag.ghostW || drag.ghost.offsetWidth) / 2;
    const hh = (drag.ghostH || drag.ghost.offsetHeight) / 2;
    drag.ghost.style.transform = `translate3d(${cx - hw}px, ${cy - hh}px, 0)`;
    const probe = view.__formatEditDragProbe;
    if (probe) probe.ghostWrites = (probe.ghostWrites || 0) + 1;
  };

  const applyTileTransforms = (target) => {
    if (!drag) return;
    const { shown, hidden } = drag.startSections;
    const proj = formatEditProjectionSlots(shown, hidden, drag.tileId, drag.fromSection, target);
    const { columnCount, cellWidth, cellHeight, gapX, gapY } = drag.geom;
    for (const node of layoutTiles()) {
      if (node === drag.placeholder) continue;
      const id = node.dataset.id;
      const homeSection = shown.includes(id) ? FORMAT_EDIT_SECTION_SHOWN : FORMAT_EDIT_SECTION_HIDDEN;
      const homeList = homeSection === FORMAT_EDIT_SECTION_SHOWN ? shown : hidden;
      const homeSlot = homeList.indexOf(id);
      const projected = proj.get(id);
      if (!projected || projected.section !== homeSection) {
        node.style.transition = TILE_TRANSITION;
        node.style.transform = '';
        continue;
      }
      const { dx, dy } = formatEditSlotTranslate(
        homeSlot,
        projected.slot,
        columnCount,
        cellWidth,
        cellHeight,
        gapX,
        gapY,
      );
      node.style.transition = TILE_TRANSITION;
      node.style.transform = dx || dy ? `translate3d(${dx}px, ${dy}px, 0)` : '';
    }
  };

  const pointerScrollLocal = (clientX, clientY) => {
    const box = drag.geom.scrollBox;
    return {
      localX: clientX - box.left + scroll.scrollLeft,
      localY: clientY - box.top + scroll.scrollTop,
    };
  };

  const buildDragTargetArgs = (localX, localY, headerMidY, hold) => {
    const { shown, hidden } = drag.startSections;
    return {
      localX,
      localY,
      headerMidY,
      prevSection: hold ? drag.target?.section : null,
      currentTarget: hold ? drag.target : null,
      shownOriginY: drag.geom.shownOriginY,
      hiddenOriginY: drag.geom.hiddenOriginY,
      originX: drag.geom.originX,
      columnCount: drag.geom.columnCount,
      cellWidth: drag.geom.cellWidth,
      cellHeight: drag.geom.cellHeight,
      gapX: drag.geom.gapX,
      gapY: drag.geom.gapY,
      shownCount: shown.length,
      hiddenCount: hidden.length,
      dragFromSection: drag.fromSection,
    };
  };

  const targetAt = (clientX, clientY, hold) => {
    const { localX, localY } = pointerScrollLocal(clientX, clientY);
    return pickFormatEditDragTarget(
      buildDragTargetArgs(localX, localY, drag.geom.headerMidY, hold),
    );
  };

  /** One layout read at drop so commit uses the finger position on screen. */
  const targetAtDrop = (clientX, clientY) => {
    const scrollBox = scroll.getBoundingClientRect();
    const headBox = hiddenHead.getBoundingClientRect();
    const shownBox = shownGrid.getBoundingClientRect();
    const hiddenBox = hiddenGrid.getBoundingClientRect();
    const localX = clientX - scrollBox.left + scroll.scrollLeft;
    const localY = clientY - scrollBox.top + scroll.scrollTop;
    const headerMidY = (headBox.top + headBox.bottom) / 2 - scrollBox.top + scroll.scrollTop;
    let section = drag.target?.section ?? null;
    if (clientY >= headBox.bottom - 0.5) {
      section = FORMAT_EDIT_SECTION_HIDDEN;
    } else if (clientY <= headBox.top + 0.5) {
      section = FORMAT_EDIT_SECTION_SHOWN;
    } else {
      section = pickFormatEditSection(localY, headerMidY, section);
    }
    const originY = section === FORMAT_EDIT_SECTION_SHOWN
      ? shownBox.top - scrollBox.top + scroll.scrollTop
      : hiddenBox.top - scrollBox.top + scroll.scrollTop;
    const { shown, hidden } = drag.startSections;
    const projected = formatEditProjectedSlotCount(
      shown.length,
      hidden.length,
      section,
      drag.fromSection,
    );
    const slot = pointerToFormatEditSlot(
      localX,
      localY,
      drag.geom.originX,
      originY,
      drag.geom.columnCount,
      drag.geom.cellWidth,
      drag.geom.cellHeight,
      drag.geom.gapX,
      drag.geom.gapY,
      projected,
    );
    return { section, slot };
  };

  const paintDragFrame = () => {
    raf = 0;
    const probe = view.__formatEditDragProbe;
    if (probe && pendingFrame) {
      probe.rafFrames = (probe.rafFrames || 0) + 1;
      const now = view.performance?.now?.() ?? Date.now();
      if (probe.lastRafAt != null) probe.rafDeltas?.push(now - probe.lastRafAt);
      probe.lastRafAt = now;
    }
    if (drag?.scrollLockTop != null && scroll.scrollTop !== drag.scrollLockTop) {
      scroll.scrollTop = drag.scrollLockTop;
    }
    if (!drag || !pendingFrame) return;
    const { clientX, clientY } = pendingFrame;
    pendingFrame = null;
    writeGhostTransform(clientX, clientY);
    const next = targetAt(clientX, clientY, true);
    const changed = !drag.target
      || next.section !== drag.target.section
      || next.slot !== drag.target.slot;
    if (changed) {
      drag.target = next;
      applyTileTransforms(next);
      if (view.__formatEditLastTargetKey != null) {
        view.__formatEditLastTargetKey = `${next.section}:${next.slot}`;
      }
    }
  };

  const scheduleFrame = (clientX, clientY) => {
    pendingFrame = { clientX, clientY };
  };

  const startDrag = (node, pointerId, clientX, clientY) => {
    const tileId = node.dataset.id;
    const { shown, hidden } = sections();
    const fromSection = shown.includes(tileId) ? FORMAT_EDIT_SECTION_SHOWN : FORMAT_EDIT_SECTION_HIDDEN;
    const fromIndex = fromSection === FORMAT_EDIT_SECTION_SHOWN
      ? shown.indexOf(tileId)
      : hidden.indexOf(tileId);
    const geom = measureDragGeometry();
    applySheetLayout(geom);
    lockScrollForDrag();
    const scrollLockTop = scroll.scrollTop;
    view.__formatEditLastTargetKey = `${fromSection}:${fromIndex}`;
    view.__formatEditDropDone = false;
    drag = {
      tileId,
      node,
      pointerId,
      fromSection,
      fromIndex,
      startSections: { shown: shown.slice(), hidden: hidden.slice() },
      startLayout: { ...layout, order: layout.order.slice() },
      geom,
      target: null,
      ghost: null,
      placeholder: null,
      grabOffsetX: 0,
      grabOffsetY: 0,
      ghostW: 0,
      ghostH: 0,
      scrollLockTop,
    };
    node.classList.add('is-dragging');
    placeTileGhost(node, clientX, clientY);
    try {
      scroll.setPointerCapture(pointerId);
    } catch {
      /* ok */
    }
    scheduleFrame(clientX, clientY);
    if (!raf) {
      const probe = view.__formatEditDragProbe;
      if (probe) probe.rafScheduled = (probe.rafScheduled || 0) + 1;
      raf = view.requestAnimationFrame(paintDragFrame);
    }
  };

  const ghostToDropSlot = (target) => {
    return new Promise((resolve) => {
      if (!drag?.ghost) {
        resolve();
        return;
      }
      const { columnCount, cellWidth, cellHeight, gapX, gapY, originX, scrollBox } = drag.geom;
      const originY = target.section === FORMAT_EDIT_SECTION_SHOWN
        ? drag.geom.shownOriginY
        : drag.geom.hiddenOriginY;
      const rect = formatEditSlotRect(
        target.slot,
        columnCount,
        cellWidth,
        cellHeight,
        gapX,
        gapY,
        originX,
        originY,
      );
      const cx = scrollBox.left - scroll.scrollLeft + rect.left + rect.width / 2;
      const cy = scrollBox.top - scroll.scrollTop + rect.top + rect.height / 2;
      const hw = drag.ghostW / 2;
      const hh = drag.ghostH / 2;
      drag.ghost.style.transition = `transform ${GHOST_SETTLE_MS}ms ease`;
      drag.ghost.style.transform = `translate3d(${cx - hw}px, ${cy - hh}px, 0)`;
      view.setTimeout(resolve, GHOST_SETTLE_MS);
    });
  };

  const finishDrag = async (commit) => {
    if (!drag) return;
    view.__formatEditDropDone = false;
    if (raf) {
      view.cancelAnimationFrame(raf);
      raf = 0;
    }
    pendingFrame = null;
    const snapshot = drag;
    try {
      scroll.releasePointerCapture(snapshot.pointerId);
    } catch {
      /* ok */
    }
    if (commit) {
      const target = snapshot.target || {
        section: snapshot.fromSection,
        slot: snapshot.fromIndex,
      };
      view.__formatEditDropTarget = `${target.section}:${target.slot}`;
      await ghostToDropSlot(target);
      layout = commitFormatEditMove(
        snapshot.startSections.shown,
        snapshot.startSections.hidden,
        snapshot.tileId,
        snapshot.fromSection,
        snapshot.fromIndex,
        target,
      );
      syncGridDom();
      applyLive();
    } else if (!commit) {
      layout = snapshot.startLayout;
      syncGridDom();
    }
    clearDragTransforms();
    drag = null;
    view.__formatEditLastTargetKey = '';
    view.__formatEditDropDone = true;
  };

  const clearHold = () => {
    if (holdTimer) {
      view.clearTimeout(holdTimer);
      holdTimer = 0;
    }
  };

  const onTilePointerDown = (event) => {
    if (!open || (event.button && event.button !== 0)) return;
    const tile = event.target.closest?.('.format-edit-tile');
    if (!tile || (!shownGrid.contains(tile) && !hiddenGrid.contains(tile))) return;
    event.preventDefault();
    clearHold();
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
      startDrag(press.node, press.pointerId, press.x, press.y);
    }, HOLD_MS);
  };

  const onPointerMove = (event) => {
    if (press && event.pointerId === press.pointerId) {
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      const dist = Math.hypot(dx, dy);
      if (!press.dragging && !drag && dist > SLOP_PX) {
        press.dragging = true;
        clearHold();
        startDrag(press.node, press.pointerId, event.clientX, event.clientY);
      }
    }
    if (drag && event.pointerId === drag.pointerId) {
      event.preventDefault();
      scheduleFrame(event.clientX, event.clientY);
      if (!raf) {
        const probe = view.__formatEditDragProbe;
        if (probe) probe.rafScheduled = (probe.rafScheduled || 0) + 1;
        raf = view.requestAnimationFrame(paintDragFrame);
      }
    }
  };

  const onPointerUp = (event) => {
    if (press && event.pointerId === press.pointerId) {
      clearHold();
      if (drag && event.pointerId === drag.pointerId) {
        pendingFrame = { clientX: event.clientX, clientY: event.clientY };
        paintDragFrame();
        drag.target = targetAtDrop(event.clientX, event.clientY) || targetAt(event.clientX, event.clientY, false);
        if (drag.target) {
          view.__formatEditLastTargetKey = `${drag.target.section}:${drag.target.slot}`;
        }
        finishDrag(true);
      } else if (!press.dragging) {
        bounceTile(press.node);
      }
      press = null;
    }
  };

  const onPointerCancel = (event) => {
    if (press && event.pointerId === press.pointerId) {
      clearHold();
      if (drag) finishDrag(false);
      press = null;
    }
  };

  const onReset = () => {
    layout = resetFormatBarLayout();
    syncGridDom();
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

  const onTouchMove = (event) => {
    if (drag || press?.dragging) event.preventDefault();
  };

  scroll.addEventListener('pointerdown', onTilePointerDown);
  scroll.addEventListener('pointermove', onPointerMove, { passive: false });
  scroll.addEventListener('pointerup', onPointerUp);
  scroll.addEventListener('pointercancel', onPointerCancel);
  scroll.addEventListener('touchmove', onTouchMove, { passive: false });

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
      scroll.removeEventListener('pointerdown', onTilePointerDown);
      scroll.removeEventListener('pointermove', onPointerMove);
      scroll.removeEventListener('pointerup', onPointerUp);
      scroll.removeEventListener('pointercancel', onPointerCancel);
      scroll.removeEventListener('touchmove', onTouchMove);
    },
  };
}
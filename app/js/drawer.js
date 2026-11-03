import { beginSwipe, endSwipe, moveSwipe } from './drawer-gesture.js';

// The notes sidebar: the round panel button, the dimmed strip beside the
// panel, and the left-edge swipe. Touch listeners are passive. A standing
// non-passive listener once stopped iOS painting inline images, and the
// swipe never needs to cancel scrolling: it only starts at the very edge and
// only takes clearly sideways drags.
export function mountDrawer(doc, { beforeOpen = () => {}, afterClose = () => {}, blocked = () => false } = {}) {
  const root = doc.getElementById('notes-sheet');
  const button = doc.getElementById('notes-button');
  const scrim = doc.getElementById('notes-close');
  const panel = root?.querySelector?.('.drawer-panel') || null;
  const view = doc.defaultView || globalThis;
  let open = false;
  let swipe = null;
  let dragging = false;
  let prepared = false;

  function flag(name, on) {
    root?.classList?.toggle?.(name, on);
  }

  function progress(value) {
    if (value == null) root?.style?.removeProperty?.('--drawer-progress');
    else root?.style?.setProperty?.('--drawer-progress', String(value));
  }

  // beforeOpen runs once when the panel starts to show, by button or drag;
  // afterClose runs once when it is put away, including a drag let go early.
  function prepare() {
    if (prepared) return;
    prepared = true;
    beforeOpen();
  }

  function setOpen(next) {
    if (next) prepare();
    open = next;
    if (root) root.inert = !open;
    flag('is-open', open);
    button?.setAttribute?.('aria-expanded', open ? 'true' : 'false');
    if (open) return;
    const active = doc.activeElement;
    if (active && root?.contains?.(active)) active.blur?.();
    if (prepared) {
      prepared = false;
      afterClose();
    }
  }

  function stopDrag() {
    if (!dragging) return;
    dragging = false;
    flag('is-dragging', false);
    progress(null);
  }

  function width() {
    const rect = panel?.getBoundingClientRect?.();
    if (rect && rect.width > 0) return rect.width;
    return Math.min((view.innerWidth || 0) * 0.85, 420);
  }

  function safeLeft() {
    const probe = doc.getElementById('safe-probe');
    if (!probe || !view.getComputedStyle) return 0;
    return parseFloat(view.getComputedStyle(probe).paddingLeft) || 0;
  }

  function point(event, list = 'touches') {
    const touch = event[list] && event[list][0];
    return touch ? { x: touch.clientX, y: touch.clientY, t: event.timeStamp } : null;
  }

  // A drag that starts on selected text is moving a selection handle.
  function selecting() {
    const selection = doc.getSelection?.();
    return Boolean(selection && !selection.isCollapsed && selection.toString());
  }

  function onStart(event) {
    swipe = null;
    if (event.touches.length !== 1 || blocked()) return;
    if (!open && selecting()) return;
    const at = point(event);
    swipe = beginSwipe({ ...at, open, width: width(), left: safeLeft() });
  }

  function onMove(event) {
    if (!swipe) return;
    const at = point(event);
    if (!at) return;
    swipe = moveSwipe(swipe, at);
    if (swipe.phase === 'cancel') {
      swipe = null;
      stopDrag();
      return;
    }
    if (swipe.phase !== 'drag') return;
    if (!dragging) {
      dragging = true;
      prepare();
      flag('is-dragging', true);
    }
    progress(swipe.progress);
  }

  function onEnd() {
    const settle = endSwipe(swipe);
    const dragged = dragging;
    swipe = null;
    stopDrag();
    if (settle !== null) setOpen(settle);
    else if (dragged) setOpen(open);
  }

  function onCancel() {
    const dragged = dragging;
    swipe = null;
    stopDrag();
    if (dragged) setOpen(open);
  }

  if (root) root.inert = true;
  button?.addEventListener('click', () => setOpen(!open));
  scrim?.addEventListener('click', () => setOpen(false));
  doc.addEventListener('touchstart', onStart, { passive: true });
  doc.addEventListener('touchmove', onMove, { passive: true });
  doc.addEventListener('touchend', onEnd, { passive: true });
  doc.addEventListener('touchcancel', onCancel, { passive: true });
  doc.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') setOpen(false);
  });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
  };
}

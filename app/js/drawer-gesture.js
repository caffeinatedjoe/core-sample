// Edge-swipe rules for the notes sidebar. Pure: the caller feeds touch points
// and times, and applies the progress and the final open state.

// A swipe to open must start this close to the left edge (after the safe
// area). Further in, a sideways drag belongs to the text: selection, caret
// placement, and the note's own scrolling.
export const EDGE_ZONE = 28;
// Movement under this is still a tap or the start of a long press.
export const SLOP = 10;
// A finger held still this long is selecting text, not swiping.
export const LONG_PRESS = 450;
// The drag must be clearly sideways to take over from vertical scrolling.
export const LOCK_RATIO = 1.5;
// px per ms. A quick flick settles in its direction regardless of distance.
export const FLICK = 0.35;

function clamp(value) {
  return Math.min(1, Math.max(0, value));
}

// `left` is where the edge zone starts (the left safe-area inset).
export function beginSwipe({ x, y, t, open, width, left = 0 }) {
  if (!(width > 0)) return null;
  if (!open && (x < left - SLOP || x > left + EDGE_ZONE)) return null;
  return {
    x0: x,
    y0: y,
    t0: t,
    open: Boolean(open),
    width,
    phase: 'pending',
    progress: open ? 1 : 0,
    lastX: x,
    lastT: t,
    velocity: 0,
  };
}

export function moveSwipe(swipe, { x, y, t }) {
  if (!swipe || swipe.phase === 'cancel') return swipe;
  const dx = x - swipe.x0;
  const dy = y - swipe.y0;
  let phase = swipe.phase;
  if (phase === 'pending') {
    const held = t - swipe.t0 >= LONG_PRESS;
    if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) {
      return held ? { ...swipe, phase: 'cancel' } : swipe;
    }
    const toward = swipe.open ? dx < 0 : dx > 0;
    const sideways = Math.abs(dx) > Math.abs(dy) * LOCK_RATIO;
    phase = toward && sideways && !held ? 'drag' : 'cancel';
    if (phase === 'cancel') return { ...swipe, phase };
  }
  const base = swipe.open ? 1 : 0;
  const dt = t - swipe.lastT;
  return {
    ...swipe,
    phase,
    progress: clamp(base + dx / swipe.width),
    lastX: x,
    lastT: t,
    velocity: dt > 0 ? (x - swipe.lastX) / dt : swipe.velocity,
  };
}

// Returns the open state to settle on, or null when the touch was not a
// sidebar swipe and nothing should change.
export function endSwipe(swipe) {
  if (!swipe || swipe.phase !== 'drag') return null;
  if (swipe.velocity >= FLICK) return true;
  if (swipe.velocity <= -FLICK) return false;
  return swipe.open ? swipe.progress > 2 / 3 : swipe.progress > 1 / 3;
}

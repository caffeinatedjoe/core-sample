// Standalone iOS paints from physical y=0, but innerHeight, 100%, 100dvh, and
// 100svh can all stop a status-bar height short of the screen (Joe: 797 vs
// 844). A JS pixel height on a fixed frame lands in that strip and cannot be
// touched. CSS owns the shell size (100lvh in standalone). This module only
// answers two questions: whether the keyboard is open, and how much extra
// padding keeps the last controls inside innerHeight when it stays short.
// screen.width / screen.height do not swap on iOS; use the oriented side.
export const KEYBOARD_THRESHOLD = 80;

export function layoutFrame({
  innerHeight = 0,
  screenWidth = 0,
  screenHeight = 0,
  visualViewportHeight = null,
  visualViewportOffsetTop = 0,
  standalone = false,
  landscape = false,
  safeBottom = 0,
} = {}) {
  const inner = Number(innerHeight) || 0;
  const vvHeight = visualViewportHeight == null || Number.isNaN(Number(visualViewportHeight))
    ? inner
    : Number(visualViewportHeight);
  const overlap = inner - vvHeight - (Number(visualViewportOffsetTop) || 0);
  const keyboard = overlap > KEYBOARD_THRESHOLD ? Math.round(overlap) : 0;

  const screenSpan = orientedScreen(screenWidth, screenHeight, landscape);
  const gap = standalone ? Math.max(0, Math.round(screenSpan - inner)) : 0;
  const safe = Math.max(0, Math.round(Number(safeBottom) || 0));
  return {
    keyboard,
    gap,
    scrollPad: Math.max(safe, gap),
    screenSpan: Math.round(screenSpan),
  };
}

function orientedScreen(screenWidth, screenHeight, landscape) {
  const width = Number(screenWidth) || 0;
  const height = Number(screenHeight) || 0;
  if (width > 0 && height > 0) return landscape ? Math.min(width, height) : Math.max(width, height);
  return height || width;
}

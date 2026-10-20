// iOS standalone with a translucent status bar paints from physical y=0, but
// the layout viewport (innerHeight, 100%, inset:0) is shorter by the status
// bar. On Joe's phone that is 844 - 47 = 797, so a frame sized to the layout
// viewport ends 47px above the physical bottom. outerHeight is the physical
// height and follows orientation. screen.width/height stay in portrait.
export const KEYBOARD_THRESHOLD = 80;

export function layoutFrame({
  innerHeight = 0,
  outerHeight = 0,
  screenWidth = 0,
  screenHeight = 0,
  visualViewportHeight = null,
  visualViewportOffsetTop = 0,
  standalone = false,
  landscape = false,
} = {}) {
  const inner = Number(innerHeight) || 0;
  const vvHeight = visualViewportHeight == null || Number.isNaN(Number(visualViewportHeight))
    ? inner
    : Number(visualViewportHeight);
  const overlap = inner - vvHeight - (Number(visualViewportOffsetTop) || 0);
  const keyboard = overlap > KEYBOARD_THRESHOLD ? Math.round(overlap) : 0;

  let full = inner;
  let source = 'innerHeight';
  if (standalone) {
    const outer = Number(outerHeight) || 0;
    if (outer > 0) {
      full = outer;
      source = 'outerHeight';
    } else {
      full = orientedScreen(screenWidth, screenHeight, landscape) || inner;
      source = full === inner && !(Number(screenWidth) || Number(screenHeight)) ? 'innerHeight' : 'screen';
    }
  }

  full = Math.round(full);
  return {
    keyboard,
    full,
    appH: Math.max(0, full - keyboard),
    source,
  };
}

function orientedScreen(screenWidth, screenHeight, landscape) {
  const width = Number(screenWidth) || 0;
  const height = Number(screenHeight) || 0;
  if (width > 0 && height > 0) return landscape ? Math.min(width, height) : Math.max(width, height);
  return height || width;
}

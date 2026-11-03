import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginSwipe, EDGE_ZONE, endSwipe, LONG_PRESS, moveSwipe } from '../app/js/drawer-gesture.js';

const WIDTH = 330;

function drag(start, points) {
  let swipe = beginSwipe({ width: WIDTH, ...start });
  for (const point of points) swipe = moveSwipe(swipe, point);
  return swipe;
}

test('only a touch near the left edge can open the closed sidebar', () => {
  assert.ok(beginSwipe({ x: 4, y: 300, t: 0, open: false, width: WIDTH }));
  assert.ok(beginSwipe({ x: EDGE_ZONE, y: 300, t: 0, open: false, width: WIDTH }));
  assert.equal(beginSwipe({ x: EDGE_ZONE + 1, y: 300, t: 0, open: false, width: WIDTH }), null);
  assert.ok(beginSwipe({ x: 60, y: 300, t: 0, open: false, width: WIDTH, left: 44 }));
  assert.ok(beginSwipe({ x: 200, y: 300, t: 0, open: true, width: WIDTH }));
  assert.equal(beginSwipe({ x: 4, y: 300, t: 0, open: false, width: 0 }), null);
});

test('a slow swipe past a third of the panel opens it', () => {
  const short = drag({ x: 5, y: 300, t: 0, open: false }, [
    { x: 30, y: 302, t: 100 },
    { x: 100, y: 304, t: 400 },
    { x: 100, y: 304, t: 600 },
  ]);
  assert.equal(short.phase, 'drag');
  assert.ok(Math.abs(short.progress - 95 / WIDTH) < 1e-9);
  assert.equal(endSwipe(short), false);

  const far = drag({ x: 5, y: 300, t: 0, open: false }, [
    { x: 30, y: 302, t: 100 },
    { x: 160, y: 304, t: 700 },
    { x: 160, y: 304, t: 900 },
  ]);
  assert.equal(endSwipe(far), true);
});

test('a quick flick settles in its direction', () => {
  const flick = drag({ x: 5, y: 300, t: 0, open: false }, [
    { x: 25, y: 300, t: 16 },
    { x: 60, y: 300, t: 40 },
  ]);
  assert.ok(flick.progress < 1 / 3);
  assert.equal(endSwipe(flick), true);

  const back = drag({ x: 250, y: 300, t: 0, open: true }, [
    { x: 235, y: 300, t: 16 },
    { x: 210, y: 300, t: 40 },
  ]);
  assert.ok(back.progress > 2 / 3);
  assert.equal(endSwipe(back), false);
});

test('swiping left closes an open panel and progress stays in range', () => {
  const swipe = drag({ x: 300, y: 400, t: 0, open: true }, [
    { x: 280, y: 400, t: 50 },
    { x: -200, y: 405, t: 800 },
    { x: -200, y: 405, t: 1000 },
  ]);
  assert.equal(swipe.progress, 0);
  assert.equal(endSwipe(swipe), false);
  const over = drag({ x: 5, y: 300, t: 0, open: false }, [{ x: 30, y: 300, t: 100 }, { x: 900, y: 300, t: 900 }]);
  assert.equal(over.progress, 1);
});

test('vertical scrolls, wrong-way drags and taps leave the sidebar alone', () => {
  const scroll = drag({ x: 5, y: 300, t: 0, open: false }, [{ x: 15, y: 340, t: 60 }, { x: 90, y: 360, t: 300 }]);
  assert.equal(scroll.phase, 'cancel');
  assert.equal(endSwipe(scroll), null);

  const wrongWay = drag({ x: 300, y: 300, t: 0, open: true }, [{ x: 330, y: 300, t: 60 }]);
  assert.equal(endSwipe(wrongWay), null);

  const tap = drag({ x: 5, y: 300, t: 0, open: false }, [{ x: 7, y: 301, t: 80 }]);
  assert.equal(tap.phase, 'pending');
  assert.equal(endSwipe(tap), null);
  assert.equal(endSwipe(null), null);
});

test('a long press before moving is text selection, not a swipe', () => {
  const held = drag({ x: 8, y: 300, t: 0, open: false }, [
    { x: 9, y: 301, t: LONG_PRESS + 10 },
    { x: 120, y: 301, t: LONG_PRESS + 300 },
  ]);
  assert.equal(held.phase, 'cancel');
  assert.equal(endSwipe(held), null);

  const lateMove = drag({ x: 8, y: 300, t: 0, open: false }, [{ x: 80, y: 300, t: LONG_PRESS + 1 }]);
  assert.equal(endSwipe(lateMove), null);
});

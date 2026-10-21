import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DOUBLE_TAP_ZOOM,
  MAX_ZOOM,
  PAN_FRICTION,
  centeredPose,
  dismissOpacity,
  doubleTapTarget,
  fitScale,
  panBounds,
  pinchFrame,
  releasePan,
  releaseZoom,
  rubberBand,
  shouldDismiss,
  slideDecision,
  zoomAbout,
} from '../app/js/viewer-gestures.js';

const image = { w: 200, h: 100 };
const viewport = { w: 100, h: 100 };

test('zoom about a focal point keeps that image point under the fingers', () => {
  const start = { x: 10, y: 20, scale: 0.5 };
  const focalX = 40;
  const focalY = 30;
  const next = zoomAbout({ ...start, focalX, focalY, nextScale: 2 });
  const before = (focalX - start.x) / start.scale;
  const after = (focalX - next.x) / next.scale;
  assert.equal(before, after);
  assert.equal((focalY - start.y) / start.scale, (focalY - next.y) / next.scale);
  assert.equal(next.scale, 2);
});

test('pan bounds center a fitted image and clamp a zoomed one', () => {
  const fit = fitScale(image, viewport);
  assert.equal(fit, 0.5);
  const fitted = panBounds(image, viewport, fit);
  assert.equal(fitted.x.min, fitted.x.max);
  assert.equal(fitted.y.min, 25);
  const zoomed = panBounds(image, viewport, fit * 2);
  assert.equal(zoomed.x.min, -100);
  assert.equal(zoomed.x.max, 0);
  assert.equal(zoomed.y.min, zoomed.y.max);
});

test('rubber-band keeps the full move inside the edge and a fraction past it', () => {
  assert.equal(rubberBand(-40, -100, 0), -40);
  assert.equal(rubberBand(20, -100, 0), 20 * PAN_FRICTION);
  assert.equal(rubberBand(-120, -100, 0), -100 + (-20 * PAN_FRICTION));
});

test('a flick projects and then stops on the pan edge', () => {
  assert.equal(releasePan({ position: -10, velocity: 0, min: -100, max: 0 }), -10);
  assert.equal(releasePan({ position: -10, velocity: 1, min: -100, max: 0 }), 0);
  assert.ok(releasePan({ position: -80, velocity: -0.2, min: -100, max: 0 }) < -80);
});

test('a pinch scales about the midpoint between the fingers', () => {
  const start = centeredPose(image, viewport);
  const startMid = { x: 20, y: 40 };
  const frame = pinchFrame({
    start,
    startDistance: 40,
    startMid,
    nextDistance: 80,
    nextMid: startMid,
  });
  assert.equal(frame.scale, start.scale * 2);
  const before = (startMid.x - start.x) / start.scale;
  assert.ok(Math.abs((startMid.x - frame.x) / frame.scale - before) < 1e-9);
  const moved = pinchFrame({
    start,
    startDistance: 40,
    startMid,
    nextDistance: 40,
    nextMid: { x: startMid.x + 12, y: startMid.y - 5 },
  });
  assert.equal(moved.x, start.x + 12);
  assert.equal(moved.y, start.y - 5);
  const capped = pinchFrame({
    start,
    startDistance: 10,
    startMid,
    nextDistance: 1000,
    nextMid: startMid,
    maxScale: start.scale * MAX_ZOOM,
  });
  assert.ok(capped.scale > start.scale * MAX_ZOOM);
  assert.ok(capped.scale < start.scale * MAX_ZOOM * 1.4);
});

test('releasing below fit springs back to the centered fit pose', () => {
  const fit = centeredPose(image, viewport);
  const released = releaseZoom({
    x: 5,
    y: 5,
    scale: fit.scale * 0.4,
    fit: fit.scale,
    image,
    viewport,
    focalX: 50,
    focalY: 50,
  });
  assert.deepEqual(released, fit);
  const high = releaseZoom({
    x: fit.x,
    y: fit.y,
    scale: fit.scale * 8,
    fit: fit.scale,
    image,
    viewport,
    focalX: 50,
    focalY: 50,
  });
  assert.equal(high.scale, fit.scale * MAX_ZOOM);
});

test('double-tap aims at 2.5x around the tap, and a second tap returns to fit', () => {
  const fit = centeredPose(image, viewport);
  const target = doubleTapTarget({
    ...fit,
    focalX: 10,
    focalY: fit.y,
    image,
    viewport,
  });
  assert.equal(target.scale, fit.scale * DOUBLE_TAP_ZOOM);
  assert.ok(target.x < fit.x);
  const bounds = panBounds(image, viewport, target.scale);
  assert.ok(target.x >= bounds.x.min && target.x <= bounds.x.max);
  const back = doubleTapTarget({ ...target, focalX: 10, focalY: 10, image, viewport });
  assert.deepEqual(back, fit);
});

test('a short vertical drag stays, and a past-threshold drag dismisses', () => {
  assert.equal(shouldDismiss({ offsetY: 10, velocityY: 0, viewportH: 300 }), false);
  assert.equal(shouldDismiss({ offsetY: 50, velocityY: 0, viewportH: 300 }), true);
  assert.equal(shouldDismiss({ offsetY: -50, velocityY: 0, viewportH: 300 }), true);
  assert.equal(shouldDismiss({ offsetY: 30, velocityY: -2, viewportH: 300 }), false);
  assert.ok(dismissOpacity(0, 300) === 1);
  assert.ok(dismissOpacity(50, 300) < 1);
  assert.ok(dismissOpacity(50, 300) > 0);
});

test('a sideways swipe moves the index and stops at the ends', () => {
  assert.equal(slideDecision({ offsetX: -60, velocityX: 0, viewportW: 100, index: 1, count: 3 }), 2);
  assert.equal(slideDecision({ offsetX: 60, velocityX: 0, viewportW: 100, index: 1, count: 3 }), 0);
  assert.equal(slideDecision({ offsetX: -20, velocityX: -0.6, viewportW: 100, index: 1, count: 3 }), 2);
  assert.equal(slideDecision({ offsetX: 80, velocityX: 1, viewportW: 100, index: 0, count: 3 }), 0);
  assert.equal(slideDecision({ offsetX: -80, velocityX: -1, viewportW: 100, index: 2, count: 3 }), 2);
  assert.equal(slideDecision({ offsetX: 10, velocityX: 0, viewportW: 100, index: 1, count: 3 }), 1);
  assert.equal(slideDecision({ offsetX: -80, velocityX: -1, viewportW: 100, index: 0, count: 1 }), 0);
});

// Gesture math for the photo viewer, modeled on PhotoSwipe 5.4.4:
// zoom about a focal point, pan friction 0.35 past the edges, vertical-drag
// friction 0.6, and a dismiss when the projected drag passes 0.4 of a third
// of the viewport. Pinch release is capped at 4x fit. Double-tap is 2.5x fit,
// which is the iOS Photos step rather than PhotoSwipe's 3x secondary zoom.
// Momentum uses PhotoSwipe's 0.995 deceleration (px per millisecond).

export const MAX_ZOOM = 4;
export const DOUBLE_TAP_ZOOM = 2.5;
export const PAN_FRICTION = 0.35;
export const DISMISS_FRICTION = 0.6;
export const DISMISS_RATIO = 0.4;
export const DECELERATION = 0.995;
export const SLIDE_SPEED = 0.5;
export const DOUBLE_TAP_MS = 280;
export const DOUBLE_TAP_DISTANCE = 30;
export const TAP_DISTANCE = 10;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function fitScale(image, viewport) {
  if (!image?.w || !image?.h || !viewport?.w || !viewport?.h) return 1;
  return Math.min(viewport.w / image.w, viewport.h / image.h);
}

export function panBounds(image, viewport, scale) {
  const width = image.w * scale;
  const height = image.h * scale;
  const x = width <= viewport.w
    ? { min: (viewport.w - width) / 2, max: (viewport.w - width) / 2 }
    : { min: viewport.w - width, max: 0 };
  const y = height <= viewport.h
    ? { min: (viewport.h - height) / 2, max: (viewport.h - height) / 2 }
    : { min: viewport.h - height, max: 0 };
  return { x, y };
}

export function centeredPose(image, viewport) {
  const scale = fitScale(image, viewport);
  const bounds = panBounds(image, viewport, scale);
  return { scale, x: bounds.x.min, y: bounds.y.min };
}

// The image point under (focalX, focalY) stays under that point.
export function zoomAbout({ x, y, scale, focalX, focalY, nextScale }) {
  const ratio = scale ? nextScale / scale : 1;
  return {
    scale: nextScale,
    x: focalX - (focalX - x) * ratio,
    y: focalY - (focalY - y) * ratio,
  };
}

// Past the edge, only `friction` of the overflow is shown. Inside, the
// position is the finger's position.
export function rubberBand(potential, min, max, friction = PAN_FRICTION) {
  if (potential < min) return min + (potential - min) * friction;
  if (potential > max) return max + (potential - max) * friction;
  return potential;
}

export function project(velocity, rate = DECELERATION) {
  return velocity * rate / (1 - rate);
}

export function releasePan({ position, velocity, min, max }) {
  return clamp(position + project(velocity), min, max);
}

export function pinchFrame({
  start,
  startDistance,
  startMid,
  nextDistance,
  nextMid,
  maxScale,
  friction = PAN_FRICTION,
}) {
  let scale = startDistance ? start.scale * (nextDistance / startDistance) : start.scale;
  if (maxScale && scale > maxScale) {
    const extra = scale / maxScale - 1;
    scale = maxScale * (1 + (extra * friction) / (1 + extra));
  }
  const zoomed = zoomAbout({
    x: start.x,
    y: start.y,
    scale: start.scale,
    focalX: startMid.x,
    focalY: startMid.y,
    nextScale: scale,
  });
  return {
    scale,
    x: zoomed.x + (nextMid.x - startMid.x),
    y: zoomed.y + (nextMid.y - startMid.y),
  };
}

export function releaseZoom({ x, y, scale, fit, image, viewport, focalX, focalY }) {
  const max = fit * MAX_ZOOM;
  if (scale < fit) return centeredPose(image, viewport);
  const next = Math.min(scale, max);
  const zoomed = zoomAbout({ x, y, scale, focalX, focalY, nextScale: next });
  const bounds = panBounds(image, viewport, next);
  return {
    scale: next,
    x: clamp(zoomed.x, bounds.x.min, bounds.x.max),
    y: clamp(zoomed.y, bounds.y.min, bounds.y.max),
  };
}

export function doubleTapTarget({ x, y, scale, focalX, focalY, image, viewport }) {
  const fit = fitScale(image, viewport);
  if (scale > fit * 1.05) return centeredPose(image, viewport);
  const nextScale = fit * DOUBLE_TAP_ZOOM;
  const zoomed = zoomAbout({ x, y, scale, focalX, focalY, nextScale });
  const bounds = panBounds(image, viewport, nextScale);
  return {
    scale: nextScale,
    x: clamp(zoomed.x, bounds.x.min, bounds.x.max),
    y: clamp(zoomed.y, bounds.y.min, bounds.y.max),
  };
}

export function dismissDrag(deltaY) {
  return deltaY * DISMISS_FRICTION;
}

export function verticalDragRatio(offsetY, viewportH) {
  return offsetY / (viewportH / 3);
}

export function dismissOpacity(offsetY, viewportH) {
  return clamp(1 - Math.abs(verticalDragRatio(offsetY, viewportH)), 0, 1);
}

export function shouldDismiss({ offsetY, velocityY, viewportH }) {
  const ratio = verticalDragRatio(offsetY, viewportH);
  const projected = offsetY + project(velocityY);
  const projectedRatio = verticalDragRatio(projected, viewportH);
  return (ratio < 0 && projectedRatio < -DISMISS_RATIO)
    || (ratio > 0 && projectedRatio > DISMISS_RATIO);
}

// Positive offsetX is a drag to the right, which reveals the previous image.
export function slideDecision({ offsetX, velocityX, viewportW, index, count }) {
  if (count < 2 || !viewportW) return index;
  const ratio = offsetX / viewportW;
  if ((velocityX < -SLIDE_SPEED && ratio < 0) || (velocityX < 0.1 && ratio < -0.5)) {
    return Math.min(count - 1, index + 1);
  }
  if ((velocityX > SLIDE_SPEED && ratio > 0) || (velocityX > -0.1 && ratio > 0.5)) {
    return Math.max(0, index - 1);
  }
  return index;
}

export function thumbPose(rect, image) {
  if (!rect || rect.width <= 0 || rect.height <= 0 || !image?.w) return null;
  return { x: rect.left, y: rect.top, scale: rect.width / image.w };
}

export function thumbOnScreen(rect, viewport) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.right ?? rect.left + rect.width, viewport.w);
  const bottom = Math.min(rect.bottom ?? rect.top + rect.height, viewport.h);
  return right - left > 1 && bottom - top > 1;
}

export function tapKind({ movement, elapsed, previous, now, x, y }) {
  if (movement > TAP_DISTANCE || elapsed > 400) return 'drag';
  if (previous
    && now - previous.t <= DOUBLE_TAP_MS
    && Math.hypot(x - previous.x, y - previous.y) <= DOUBLE_TAP_DISTANCE) {
    return 'double';
  }
  return 'single';
}

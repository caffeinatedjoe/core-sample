// Full-screen photo viewer. Gestures live in viewer-gestures.js. This file
// only maps those poses onto translate3d/scale and backdrop opacity, on
// requestAnimationFrame. Pointer events drive the gestures. Touch and
// Safari gesture listeners exist so a pinch cannot zoom the page behind it.

import {
  DISMISS_FRICTION,
  MAX_ZOOM,
  PAN_FRICTION,
  centeredPose,
  dismissDrag,
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
  tapKind,
  thumbOnScreen,
  thumbPose,
} from './viewer-gestures.js';

const OPEN_MS = 280;
const CLOSE_MS = 260;
const FADE_MS = 140;

export function createImageViewer(doc, root, { onClose } = {}) {
  if (!root) {
    return {
      open() {},
      close() {},
      isOpen: () => false,
      isUsing: () => false,
    };
  }

  const closeBtn = root.querySelector('#image-viewer-close');
  const count = root.querySelector('#image-viewer-count');
  const backdrop = root.querySelector('.image-viewer-backdrop');
  const stage = root.querySelector('.image-viewer-stage');
  const view = doc.defaultView;

  let slides = [];
  let index = 0;
  let pose = { x: 0, y: 0, scale: 1 };
  let dragX = 0;
  let dismissY = 0;
  let open = false;
  let restoreFocus = true;
  let returnFocus = null;
  let scrollEl = null;
  let savedTop = 0;
  let savedWindow = { x: 0, y: 0 };
  let gesture = null;
  let lastTap = null;
  let suppressClick = false;
  let poseGen = 0;
  let fadeGen = 0;
  const pointers = new Map();
  const mounted = new Map();
  const loading = new Set();
  const ownedUrls = new Set();
  let samples = [];
  let blocking = false;
  let srcSerial = 0;

  function reduced() {
    return Boolean(view.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  }

  function viewportSize() {
    const visual = view.visualViewport;
    return {
      w: visual?.width || view.innerWidth,
      h: visual?.height || view.innerHeight,
    };
  }

  function sizeOf(slide) {
    if (!slide) return null;
    if (slide.size?.w) return slide.size;
    const thumb = slide.thumb;
    if (thumb?.naturalWidth) {
      slide.size = { w: thumb.naturalWidth, h: thumb.naturalHeight };
    }
    return slide.size || null;
  }

  function cancelAnim() {
    poseGen += 1;
    fadeGen += 1;
  }

  function lock(el) {
    scrollEl = el || null;
    savedWindow = { x: view.scrollX, y: view.scrollY };
    if (scrollEl) {
      savedTop = scrollEl.scrollTop;
      scrollEl.style.overflow = 'hidden';
      scrollEl.scrollTop = savedTop;
    }
    doc.documentElement.classList.add('viewer-scroll-lock');
  }

  function unlock() {
    if (scrollEl) {
      const top = savedTop;
      scrollEl.style.overflow = '';
      scrollEl.scrollTop = top;
    }
    view.scrollTo(savedWindow.x, savedWindow.y);
    doc.documentElement.classList.remove('viewer-scroll-lock');
    scrollEl = null;
  }

  function blockGesture(event) {
    if (open) event.preventDefault();
  }

  // These listeners are non-passive because they cancel a pinch. They exist
  // only while the viewer is open. Leaving them on the document makes iOS
  // treat the preview scroller as non-passive and skip painting its images.
  function armBlocking() {
    if (blocking) return;
    blocking = true;
    doc.addEventListener('touchmove', blockGesture, { passive: false });
    for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
      doc.addEventListener(name, blockGesture, { passive: false });
    }
  }

  function disarmBlocking() {
    if (!blocking) return;
    blocking = false;
    doc.removeEventListener('touchmove', blockGesture);
    for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
      doc.removeEventListener(name, blockGesture);
    }
  }

  function releaseOwned() {
    for (const url of ownedUrls) {
      const used = [...doc.querySelectorAll('img')].some((img) => img.getAttribute('src') === url);
      if (!used) URL.revokeObjectURL(url);
    }
    ownedUrls.clear();
  }

  function useSrc(img, src, blob) {
    const key = src || (blob instanceof Blob ? `bytes:${blob.size}:${blob.type || ''}` : '');
    if (!key || img.dataset.sourceSrc === key) return;
    const token = String(++srcSerial);
    img.dataset.sourceSrc = key;
    img.dataset.srcToken = token;
    const apply = (url) => {
      if (!img.isConnected || img.dataset.srcToken !== token) {
        if (ownedUrls.has(url)) {
          ownedUrls.delete(url);
          URL.revokeObjectURL(url);
        }
        return;
      }
      img.src = url;
    };
    if (blob instanceof Blob) {
      // Safari drops a blob URL that is assigned before the element is in the
      // document, and sharing that URL with the preview blanks the inline image.
      // Copy the bytes, then point this element at the copy.
      blob.arrayBuffer().then((bytes) => {
        const copy = new Blob([bytes], { type: blob.type || 'application/octet-stream' });
        const url = URL.createObjectURL(copy);
        ownedUrls.add(url);
        apply(url);
      }).catch(() => {
        if (src && !src.startsWith('blob:')) apply(src);
      });
      return;
    }
    apply(src);
  }

  function setBackdrop(value) {
    if (backdrop) backdrop.style.opacity = String(value);
  }

  function showChrome() {
    root.classList.remove('is-chrome-hidden');
  }

  function toggleChrome() {
    root.classList.toggle('is-chrome-hidden');
  }

  function paintCount() {
    const total = slides.length;
    if (!count || total < 2) {
      if (count) count.hidden = true;
      root.setAttribute('aria-label', 'Photo');
      return;
    }
    count.hidden = false;
    count.textContent = `${index + 1} of ${total}`;
    root.setAttribute('aria-label', `Photo, ${index + 1} of ${total}`);
  }

  function clearSlides() {
    for (const el of mounted.values()) el.remove();
    mounted.clear();
    loading.clear();
  }

  function layout() {
    const viewport = viewportSize();
    for (const [slot, el] of mounted) {
      const slide = slides[slot];
      const size = sizeOf(slide);
      el.style.transform = `translate3d(${(slot - index) * viewport.w + dragX}px, ${slot === index ? dismissY : 0}px, 0)`;
      const img = el.querySelector('img');
      if (!img || !size) continue;
      const frame = slot === index ? pose : centeredPose(size, viewport);
      img.style.width = `${size.w}px`;
      img.style.height = `${size.h}px`;
      img.style.transform = `translate3d(${frame.x}px, ${frame.y}px, 0) scale(${frame.scale})`;
    }
  }

  function rememberSize(slide, img, slot) {
    if (slide.size?.w || !img.naturalWidth) return;
    slide.size = { w: img.naturalWidth, h: img.naturalHeight };
    if (slot === index && root.dataset.state !== 'dragging' && root.dataset.state !== 'closing') {
      const viewport = viewportSize();
      if (pose.scale <= fitScale(slide.size, viewport) * 1.05) {
        pose = centeredPose(slide.size, viewport);
      }
    }
    layout();
  }

  function mount(slot) {
    const slide = slides[slot];
    const el = doc.createElement('div');
    el.className = 'image-viewer-slide';
    const img = doc.createElement('img');
    img.className = 'image-viewer-photo';
    img.alt = slide.alt || '';
    img.draggable = false;
    img.addEventListener('load', () => rememberSize(slide, img, slot));
    el.append(img);
    stage.append(el);
    mounted.set(slot, el);
    if (slide.src || slide.blob) useSrc(img, slide.src, slide.blob);
    if (img.complete && img.getAttribute('src')) rememberSize(slide, img, slot);
    return el;
  }

  function syncSlides() {
    const keep = new Set([index - 1, index, index + 1].filter((slot) => slot >= 0 && slot < slides.length));
    for (const [slot, el] of mounted) {
      if (!keep.has(slot)) {
        el.remove();
        mounted.delete(slot);
      }
    }
    for (const slot of keep) {
      const el = mounted.get(slot) || mount(slot);
      const img = el.querySelector('img');
      const slide = slides[slot];
      if (slide.src || slide.blob) useSrc(img, slide.src, slide.blob);
      img.alt = slide.alt || '';
    }
    layout();
  }

  function ensure(slot) {
    const slide = slides[slot];
    if (!slide || slide.src || loading.has(slot) || typeof slide.load !== 'function') {
      syncSlides();
      return;
    }
    loading.add(slot);
    Promise.resolve()
      .then(() => slide.load())
      .then((src) => {
        loading.delete(slot);
        if (!open || !src) return;
        slide.src = src;
        syncSlides();
      })
      .catch(() => {
        loading.delete(slot);
      });
  }

  function prefetch() {
    for (const slot of [index - 1, index, index + 1]) ensure(slot);
  }

  function animatePose(from, to, ms, done) {
    const gen = ++poseGen;
    const draw = (amount) => {
      pose = {
        x: from.x + (to.x - from.x) * amount,
        y: from.y + (to.y - from.y) * amount,
        scale: from.scale + (to.scale - from.scale) * amount,
      };
      layout();
    };
    if (reduced() || ms <= 0) {
      draw(1);
      done?.();
      return;
    }
    const started = view.performance.now();
    const step = (now) => {
      if (gen !== poseGen) return;
      const t = Math.min(1, (now - started) / ms);
      draw(1 - (1 - t) ** 3);
      if (t < 1) view.requestAnimationFrame(step);
      else done?.();
    };
    view.requestAnimationFrame(step);
  }

  function animateOpacity(from, to, ms, done) {
    const gen = ++fadeGen;
    const draw = (amount) => {
      root.style.opacity = String(from + (to - from) * amount);
    };
    if (ms <= 0) {
      draw(1);
      done?.();
      return;
    }
    const started = view.performance.now();
    const step = (now) => {
      if (gen !== fadeGen) return;
      const t = Math.min(1, (now - started) / ms);
      draw(1 - (1 - t) ** 3);
      if (t < 1) view.requestAnimationFrame(step);
      else done?.();
    };
    view.requestAnimationFrame(step);
  }

  function animateNumber(from, to, ms, apply, done) {
    const gen = ++poseGen;
    if (reduced() || ms <= 0) {
      apply(to);
      done?.();
      return;
    }
    const started = view.performance.now();
    const step = (now) => {
      if (gen !== poseGen) return;
      const t = Math.min(1, (now - started) / ms);
      const eased = 1 - (1 - t) ** 3;
      apply(from + (to - from) * eased);
      if (t < 1) view.requestAnimationFrame(step);
      else done?.();
    };
    view.requestAnimationFrame(step);
  }

  function settle() {
    if (!open || root.dataset.state === 'closing') return;
    dragX = 0;
    if (root.dataset.state !== 'closing') root.dataset.state = 'open';
    layout();
  }

  function hide() {
    if (!open && root.hidden) return;
    cancelAnim();
    open = false;
    gesture = null;
    pointers.clear();
    disarmBlocking();
    root.dataset.state = 'closed';
    root.hidden = true;
    root.removeAttribute('aria-modal');
    root.style.opacity = '';
    setBackdrop(1);
    showChrome();
    clearSlides();
    releaseOwned();
    unlock();
    const thumb = restoreFocus ? returnFocus : null;
    returnFocus = null;
    onClose?.();
    if (thumb?.isConnected && typeof thumb.focus === 'function') {
      try {
        thumb.focus({ preventScroll: true });
      } catch {
        thumb.focus();
      }
    }
  }

  function runClose(animate) {
    if (!open) return;
    if (!animate) {
      hide();
      return;
    }
    if (root.dataset.state === 'closing') return;
    root.dataset.state = 'closing';
    pointers.clear();
    gesture = null;
    const size = sizeOf(slides[index]);
    const viewport = viewportSize();
    const rect = slides[index]?.thumb?.getBoundingClientRect?.();
    const dest = size && !reduced() && thumbOnScreen(rect, viewport) ? thumbPose(rect, size) : null;
    if (!dest) {
      animateOpacity(Number(root.style.opacity || 1), 0, FADE_MS, hide);
      return;
    }
    pose = { ...pose, y: pose.y + dismissY };
    dismissY = 0;
    const from = { ...pose };
    animatePose(from, dest, CLOSE_MS, hide);
    const gen = ++fadeGen;
    const started = view.performance.now();
    const initial = Number(backdrop?.style.opacity || 1);
    const step = (now) => {
      if (gen !== fadeGen) return;
      const t = Math.min(1, (now - started) / CLOSE_MS);
      setBackdrop(initial * (1 - (1 - (1 - t) ** 3)));
      if (t < 1) view.requestAnimationFrame(step);
    };
    view.requestAnimationFrame(step);
  }

  function runOpen() {
    const size = sizeOf(slides[index]);
    const viewport = viewportSize();
    const fitted = size ? centeredPose(size, viewport) : { x: 0, y: 0, scale: 1 };
    const rect = slides[index]?.thumb?.getBoundingClientRect?.();
    const from = size && !reduced() && thumbOnScreen(rect, viewport) ? thumbPose(rect, size) : null;
    dragX = 0;
    dismissY = 0;
    root.dataset.state = 'opening';
    if (!from) {
      pose = fitted;
      layout();
      root.style.opacity = '0';
      setBackdrop(1);
      animateOpacity(0, 1, FADE_MS, settle);
      return;
    }
    pose = from;
    root.style.opacity = '1';
    setBackdrop(0);
    layout();
    animatePose(from, fitted, OPEN_MS, settle);
    const fade = ++fadeGen;
    const started = view.performance.now();
    const step = (now) => {
      if (fade !== fadeGen) return;
      const t = Math.min(1, (now - started) / 180);
      setBackdrop(1 - (1 - t) ** 3);
      if (t < 1) view.requestAnimationFrame(step);
    };
    view.requestAnimationFrame(step);
  }

  function velocity() {
    if (samples.length < 2) return { x: 0, y: 0 };
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return { x: 0, y: 0 };
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }

  function hitImage(x, y) {
    const img = mounted.get(index)?.querySelector('img');
    if (!img) return false;
    const rect = img.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function applyPinch() {
    const points = [...pointers.values()];
    if (points.length < 2) return;
    const mid = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    const size = sizeOf(slides[index]);
    const viewport = viewportSize();
    const fit = size ? fitScale(size, viewport) : pose.scale;
    pose = pinchFrame({
      start: gesture.start,
      startDistance: gesture.startDistance,
      startMid: gesture.startMid,
      nextDistance: distance,
      nextMid: mid,
      maxScale: fit * MAX_ZOOM,
    });
    gesture.lastMid = mid;
    dragX = 0;
    dismissY = 0;
    setBackdrop(1);
    layout();
  }

  function applyDrag(point) {
    const dx = point.x - gesture.x;
    const dy = point.y - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) > 8) gesture.moved = true;
    const now = view.performance.now();
    samples.push({ x: point.x, y: point.y, t: now });
    const cutoff = now - 80;
    while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
    const size = sizeOf(slides[index]);
    const viewport = viewportSize();
    const fit = size ? fitScale(size, viewport) : pose.scale;
    const zoomed = Boolean(size) && pose.scale > fit * 1.05;
    if (zoomed) {
      const bounds = panBounds(size, viewport, pose.scale);
      pose.x = rubberBand(gesture.startPose.x + dx, bounds.x.min, bounds.x.max);
      pose.y = rubberBand(gesture.startPose.y + dy, bounds.y.min, bounds.y.max);
      dragX = 0;
      dismissY = 0;
      setBackdrop(1);
      layout();
      return;
    }
    if (!gesture.axis && gesture.moved) gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (gesture.axis !== 'x') {
      dragX = 0;
      dismissY = gesture.axis === 'y' ? dismissDrag(dy) : 0;
      setBackdrop(dismissOpacity(dismissY, viewport.h));
      layout();
      return;
    }
    dismissY = 0;
    setBackdrop(1);
    const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === slides.length - 1) || slides.length < 2;
    dragX = atEdge ? dx * PAN_FRICTION : dx;
    layout();
  }

  function finishPinch() {
    if (!gesture || gesture.type !== 'pinch') return;
    const size = sizeOf(slides[index]);
    const viewport = viewportSize();
    const fit = size ? fitScale(size, viewport) : pose.scale;
    const focal = gesture.lastMid || { x: viewport.w / 2, y: viewport.h / 2 };
    const next = size
      ? releaseZoom({ ...pose, fit, image: size, viewport, focalX: focal.x, focalY: focal.y })
      : pose;
    const from = { ...pose };
    gesture = null;
    animatePose(from, next, 220, settle);
  }

  function finishDrag(point) {
    const started = gesture;
    const elapsed = view.performance.now() - started.t;
    const movement = Math.hypot(point.x - started.x, point.y - started.y);
    const moved = started.moved || movement > 10;
    const viewport = viewportSize();
    const size = sizeOf(slides[index]);
    const fit = size ? fitScale(size, viewport) : pose.scale;
    const zoomed = Boolean(size) && pose.scale > fit * 1.05;
    const speed = velocity();
    gesture = null;
    if (!moved) {
      const kind = tapKind({
        movement,
        elapsed,
        previous: lastTap,
        now: view.performance.now(),
        x: point.x,
        y: point.y,
      });
      const onImage = hitImage(point.x, point.y);
      if (kind === 'double' && onImage && lastTap?.onImage && size) {
        lastTap = null;
        const target = doubleTapTarget({
          ...pose,
          focalX: point.x,
          focalY: point.y,
          image: size,
          viewport,
        });
        showChrome();
        animatePose({ ...pose }, target, reduced() ? 0 : 220, settle);
        return;
      }
      lastTap = { t: view.performance.now(), x: point.x, y: point.y, onImage };
      if (!onImage) {
        runClose(true);
        return;
      }
      toggleChrome();
      settle();
      return;
    }
    suppressClick = true;
    lastTap = null;
    if (!zoomed && started.axis === 'y') {
      if (shouldDismiss({ offsetY: dismissY, velocityY: speed.y * DISMISS_FRICTION, viewportH: viewport.h })) {
        runClose(true);
        return;
      }
      const from = dismissY;
      animateNumber(from, 0, 220, (value) => {
        dismissY = value;
        setBackdrop(dismissOpacity(value, viewport.h));
        layout();
      }, settle);
      return;
    }
    if (!zoomed && started.axis === 'x') {
      const next = slideDecision({
        offsetX: dragX,
        velocityX: speed.x,
        viewportW: viewport.w,
        index,
        count: slides.length,
      });
      const dest = next === index ? 0 : (next > index ? -viewport.w : viewport.w);
      animateNumber(dragX, dest, reduced() ? 0 : 240, (value) => {
        dragX = value;
        layout();
      }, () => {
        if (next !== index) {
          index = next;
          dragX = 0;
          const nextSize = sizeOf(slides[index]);
          pose = nextSize ? centeredPose(nextSize, viewportSize()) : pose;
          dismissY = 0;
          setBackdrop(1);
          showChrome();
          paintCount();
          prefetch();
        }
        settle();
      });
      return;
    }
    if (zoomed && size) {
      const bounds = panBounds(size, viewport, pose.scale);
      animatePose({ ...pose }, {
        x: releasePan({ position: pose.x, velocity: speed.x, min: bounds.x.min, max: bounds.x.max }),
        y: releasePan({ position: pose.y, velocity: speed.y, min: bounds.y.min, max: bounds.y.max }),
        scale: pose.scale,
      }, reduced() ? 0 : 280, settle);
      return;
    }
    settle();
  }

  function onPointerDown(event) {
    if (!open || root.dataset.state === 'closing' || event.button > 0) return;
    event.preventDefault();
    cancelAnim();
    if (root.dataset.state === 'opening') {
      const size = sizeOf(slides[index]);
      if (size) pose = centeredPose(size, viewportSize());
      root.dataset.state = 'open';
    }
    try {
      stage.setPointerCapture?.(event.pointerId);
    } catch {
      // A second synthetic finger, and some WebKit builds, have no capturable
      // pointer. The coordinates still drive the pinch.
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      const points = [...pointers.values()];
      gesture = {
        type: 'pinch',
        start: { ...pose },
        startDistance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) || 1,
        startMid: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 },
        lastMid: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 },
        moved: true,
      };
      dragX = 0;
      dismissY = 0;
    } else {
      gesture = {
        type: 'drag',
        x: event.clientX,
        y: event.clientY,
        t: view.performance.now(),
        startPose: { ...pose },
        axis: null,
        moved: false,
      };
      samples = [{ x: event.clientX, y: event.clientY, t: gesture.t }];
    }
    root.dataset.state = 'dragging';
  }

  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture?.type === 'pinch') applyPinch();
    else if (gesture?.type === 'drag') applyDrag(pointers.get(event.pointerId));
  }

  function onPointerUp(event) {
    if (!pointers.has(event.pointerId)) return;
    const point = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (gesture?.type === 'pinch') {
      if (pointers.size >= 2) return;
      finishPinch();
      return;
    }
    if (pointers.size > 0) return;
    if (gesture?.type === 'drag') finishDrag(point);
  }

  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);
  stage.addEventListener('touchend', (event) => {
    if (!open || pointers.size > 0 || event.touches.length > 0) return;
    if (gesture?.type === 'pinch') finishPinch();
  }, { passive: true });
  stage.addEventListener('touchmove', (event) => {
    if (!open) return;
    event.preventDefault();
    if (event.touches.length < 2 || pointers.size >= 2) return;
    const points = [...event.touches].slice(0, 2).map((touch) => ({ x: touch.clientX, y: touch.clientY }));
    if (!gesture || gesture.type !== 'pinch') {
      gesture = {
        type: 'pinch',
        start: { ...pose },
        startDistance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) || 1,
        startMid: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 },
        moved: true,
      };
    }
    pointers.clear();
    applyPinchFrom(points);
  }, { passive: false });
  root.addEventListener('contextmenu', (event) => {
    if (open) event.preventDefault();
  });
  root.addEventListener('click', (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  });
  closeBtn?.addEventListener('click', (event) => {
    if (suppressClick) return;
    event.stopPropagation();
    runClose(true);
  });
  doc.addEventListener('keydown', (event) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      runClose(true);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      try {
        closeBtn?.focus({ preventScroll: true });
      } catch {
        closeBtn?.focus();
      }
      return;
    }
    if (root.dataset.state === 'dragging' || root.dataset.state === 'closing') return;
    if (event.key === 'ArrowRight') nudge(1);
    else if (event.key === 'ArrowLeft') nudge(-1);
  });
  view.visualViewport?.addEventListener('resize', () => {
    if (!open || root.dataset.state === 'dragging' || root.dataset.state === 'closing') return;
    const size = sizeOf(slides[index]);
    if (!size) return;
    const viewport = viewportSize();
    const fit = fitScale(size, viewport);
    if (pose.scale <= fit * 1.05) pose = centeredPose(size, viewport);
    else {
      const bounds = panBounds(size, viewport, pose.scale);
      pose.x = Math.min(bounds.x.max, Math.max(bounds.x.min, pose.x));
      pose.y = Math.min(bounds.y.max, Math.max(bounds.y.min, pose.y));
    }
    layout();
  });

  function applyPinchFrom(points) {
    const mid = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    const size = sizeOf(slides[index]);
    const viewport = viewportSize();
    const fit = size ? fitScale(size, viewport) : pose.scale;
    pose = pinchFrame({
      start: gesture.start,
      startDistance: gesture.startDistance,
      startMid: gesture.startMid,
      nextDistance: distance,
      nextMid: mid,
      maxScale: fit * MAX_ZOOM,
    });
    gesture.lastMid = mid;
    dragX = 0;
    dismissY = 0;
    setBackdrop(1);
    layout();
  }

  function nudge(delta) {
    const size = sizeOf(slides[index]);
    const viewport = viewportSize();
    const fit = size ? fitScale(size, viewport) : pose.scale;
    if (size && pose.scale > fit * 1.05) return;
    const next = index + delta;
    if (next < 0 || next >= slides.length) return;
    const dest = delta > 0 ? -viewport.w : viewport.w;
    root.dataset.state = 'dragging';
    animateNumber(0, dest, reduced() ? 0 : 240, (value) => {
      dragX = value;
      layout();
    }, () => {
      index = next;
      dragX = 0;
      const nextSize = sizeOf(slides[index]);
      pose = nextSize ? centeredPose(nextSize, viewportSize()) : pose;
      paintCount();
      prefetch();
      settle();
    });
  }

  function openViewer({ slides: next, index: start = 0, scrollEl: scroller } = {}) {
    const usable = (next || []).filter((slide) => slide && (slide.src || slide.load || slide.thumb));
    if (!usable.length) return;
    if (open) hide();
    slides = usable;
    index = Math.min(usable.length - 1, Math.max(0, start));
    for (const slide of slides) sizeOf(slide);
    const opener = slides[index];
    returnFocus = opener?.thumb || null;
    if (returnFocus && !returnFocus.hasAttribute('tabindex')) {
      returnFocus.setAttribute('tabindex', '-1');
    }
    restoreFocus = true;
    lock(scroller);
    root.hidden = false;
    root.setAttribute('aria-modal', 'true');
    armBlocking();
    root.style.opacity = '1';
    showChrome();
    open = true;
    paintCount();
    prefetch();
    syncSlides();
    runOpen();
    try {
      closeBtn?.focus({ preventScroll: true });
    } catch {
      closeBtn?.focus();
    }
    if (scrollEl) scrollEl.scrollTop = savedTop;
    view.scrollTo(savedWindow.x, savedWindow.y);
  }

  function closeViewer({ animate = true, restoreFocus: restore = true } = {}) {
    restoreFocus = restore;
    if (!open) return;
    if (!animate) hide();
    else runClose(true);
  }

  return {
    open: openViewer,
    close: closeViewer,
    isOpen: () => open,
    isUsing: (url) => Boolean(open && url && slides.some((slide) => slide.src === url)),
  };
}

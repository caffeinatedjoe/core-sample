import {
  commentQuote,
  commentsForList,
  isOrphan,
  relativeTime,
} from './comments.js';
import { renderInlineMarkdown } from './markdown.js';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const TAP_MS = 500;
const SLOP_PX = 10;
const FLICK_VEL = 0.35;

function isTap(gesture) {
  if (!gesture) return false;
  if (gesture.moved) return false;
  if (Date.now() - gesture.at > TAP_MS) return false;
  const dx = (gesture.endX ?? gesture.x) - gesture.x;
  const dy = (gesture.endY ?? gesture.y) - gesture.y;
  return Math.hypot(dx, dy) <= SLOP_PX;
}

function firstEntry(comment) {
  return comment.thread && comment.thread[0] ? comment.thread[0] : null;
}

function stampOf(comment) {
  const last = comment.thread && comment.thread.length
    ? comment.thread[comment.thread.length - 1]
    : null;
  return last?.timestamp || comment.createdAt || '';
}

function replyCount(comment) {
  return Math.max(0, (comment.thread || []).length - 1);
}

export function mountComments(doc, hooks = {}) {
  const sheet = doc.getElementById('comment-sheet');
  const chip = doc.getElementById('comments-chip');
  const pill = doc.getElementById('comment-pill');
  if (!sheet) {
    return {
      paintChip() {},
      openList() {},
      openThread() {},
      showPill() {},
      hidePill() {},
      close() {},
      showing() { return false; },
    };
  }

  const card = sheet.querySelector('.comment-sheet-card');
  const scrim = doc.getElementById('comment-sheet-scrim');
  const back = doc.getElementById('comment-sheet-back');
  const quoteBtn = doc.getElementById('comment-sheet-quote');
  const resolveBtn = doc.getElementById('comment-sheet-resolve');
  const prevBtn = doc.getElementById('comment-sheet-prev');
  const nextBtn = doc.getElementById('comment-sheet-next');
  const closeBtn = doc.getElementById('comment-sheet-close');
  const tabs = doc.getElementById('comment-sheet-tabs');
  const list = doc.getElementById('comment-sheet-list');
  const thread = doc.getElementById('comment-sheet-thread');
  const composer = doc.getElementById('comment-sheet-composer');
  const replyBox = doc.getElementById('comment-reply');
  const sendBtn = doc.getElementById('comment-send');

  let mode = 'thread';
  let tab = 'open';
  let currentId = '';
  let size = 'half';
  let fromList = false;
  let exactTimes = new Set();
  let pillHits = [];
  let pillFade = 0;

  function comments() {
    return hooks.comments?.() || [];
  }

  function walkList() {
    if (fromList) {
      const groups = commentsForList(comments(), tab);
      return [...groups.anchored, ...groups.orphans];
    }
    return comments().filter((comment) => comment.body);
  }

  function current() {
    return comments().find((comment) => comment.id === currentId) || null;
  }

  function paintChip() {
    if (!chip) return;
    const count = hooks.openCount?.() ?? 0;
    chip.hidden = count < 1;
    chip.textContent = `💬 ${count}`;
    chip.setAttribute('aria-label', count === 1 ? '1 open comment' : `${count} open comments`);
  }

  function setSize(next) {
    size = next;
    sheet.dataset.size = next;
    card?.style.removeProperty('--comment-sheet-drag');
  }

  function showSheet() {
    sheet.hidden = false;
    hooks.onOpen?.();
  }

  function hideSheet() {
    sheet.hidden = true;
    currentId = '';
    fromList = false;
    exactTimes = new Set();
    if (replyBox) replyBox.value = '';
    hooks.onClose?.();
  }

  function paintTabs() {
    if (!tabs) return;
    for (const button of tabs.querySelectorAll('[data-tab]')) {
      button.setAttribute('aria-selected', button.dataset.tab === tab ? 'true' : 'false');
    }
  }

  function row(comment) {
    const button = el(doc, 'button', 'comment-row');
    button.type = 'button';
    button.dataset.commentId = comment.id;
    const quote = el(doc, 'p', 'comment-row-quote', commentQuote(comment, hooks.doc?.()) || 'Comment');
    const first = firstEntry(comment);
    const preview = el(doc, 'p', 'comment-row-text', first ? first.text : '');
    const meta = el(doc, 'p', 'comment-row-meta');
    const replies = replyCount(comment);
    const when = relativeTime(stampOf(comment));
    meta.textContent = replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'} · ${when}` : when;
    button.append(quote, preview, meta);
    return button;
  }

  function paintList() {
    if (!list) return;
    list.replaceChildren();
    const groups = commentsForList(comments(), tab);
    for (const comment of groups.anchored) list.append(row(comment));
    if (groups.orphans.length) {
      list.append(el(doc, 'h3', 'comment-orphan-heading', 'Text no longer in note'));
      for (const comment of groups.orphans) list.append(row(comment));
    }
    if (!groups.anchored.length && !groups.orphans.length) {
      list.append(el(doc, 'p', 'comment-empty', tab === 'resolved' ? 'No resolved comments' : 'No comments'));
    }
  }

  function paintThread() {
    if (!thread) return;
    thread.replaceChildren();
    const comment = current();
    if (!comment) return;
    const quote = commentQuote(comment, hooks.doc?.()) || (isOrphan(comment) ? 'Text no longer in note' : 'Comment');
    if (quoteBtn) quoteBtn.textContent = quote;
    if (resolveBtn) {
      const resolved = comment.status === 'resolved';
      resolveBtn.setAttribute('aria-label', resolved ? 'Reopen' : 'Resolve');
      resolveBtn.setAttribute('aria-pressed', resolved ? 'true' : 'false');
      resolveBtn.textContent = resolved ? '↩' : '✓';
    }
    const items = walkList();
    const index = items.findIndex((item) => item.id === comment.id);
    if (prevBtn) prevBtn.disabled = index <= 0;
    if (nextBtn) nextBtn.disabled = index < 0 || index >= items.length - 1;
    for (const [i, entry] of (comment.thread || []).entries()) {
      const item = el(doc, 'article', 'comment-entry');
      const head = el(doc, 'header', 'comment-entry-head');
      head.append(el(doc, 'span', 'comment-entry-author', entry.author || 'me'));
      const time = el(doc, 'button', 'comment-entry-time', exactTimes.has(i) ? (entry.timestamp || '') : relativeTime(entry.timestamp));
      time.type = 'button';
      time.dataset.entry = String(i);
      if (entry.timestamp) time.setAttribute('title', entry.timestamp);
      head.append(time);
      const body = el(doc, 'div', 'comment-entry-body');
      body.innerHTML = renderInlineMarkdown(entry.text || '');
      item.append(head, body);
      thread.append(item);
    }
  }

  function showList() {
    mode = 'list';
    fromList = true;
    setSize('full');
    showSheet();
    if (back) back.hidden = true;
    if (quoteBtn) quoteBtn.hidden = true;
    if (resolveBtn) resolveBtn.hidden = true;
    if (prevBtn) prevBtn.hidden = true;
    if (nextBtn) nextBtn.hidden = true;
    if (tabs) tabs.hidden = false;
    if (list) list.hidden = false;
    if (thread) thread.hidden = true;
    if (composer) composer.hidden = true;
    paintTabs();
    paintList();
  }

  function showThread(id, { listOrigin = fromList } = {}) {
    const comment = comments().find((item) => item.id === id);
    if (!comment) return;
    mode = 'thread';
    currentId = id;
    fromList = listOrigin;
    exactTimes = new Set();
    showSheet();
    if (back) back.hidden = !fromList;
    if (quoteBtn) quoteBtn.hidden = false;
    if (resolveBtn) resolveBtn.hidden = false;
    if (prevBtn) prevBtn.hidden = false;
    if (nextBtn) nextBtn.hidden = false;
    if (tabs) tabs.hidden = true;
    if (list) list.hidden = true;
    if (thread) thread.hidden = false;
    if (composer) composer.hidden = false;
    paintThread();
    hooks.reveal?.(id);
  }

  function move(delta) {
    const items = walkList();
    const index = items.findIndex((item) => item.id === currentId);
    const next = items[index + delta];
    if (next) showThread(next.id, { listOrigin: fromList });
  }

  function hidePill() {
    if (!pill) return;
    pill.hidden = true;
    pillHits = [];
    if (pillFade) doc.defaultView?.clearTimeout(pillFade);
    pillFade = 0;
  }

  function showPill(hits, coords) {
    if (!pill) return;
    if (sheet.hidden === false || !hits || !hits.length || !coords) {
      hidePill();
      return;
    }
    pillHits = hits;
    const n = hits.length;
    pill.textContent = n === 1 ? '💬 1 comment' : `💬 ${n} comments`;
    pill.hidden = false;
    const app = doc.getElementById('app');
    const box = app?.getBoundingClientRect?.() || { left: 0, top: 0, width: 320, height: 500 };
    const width = pill.offsetWidth || 140;
    const height = pill.offsetHeight || 32;
    const left = clamp(coords.left - box.left - width / 2, 8, Math.max(8, box.width - width - 8));
    const top = clamp(coords.top - box.top - height - 8, 8, Math.max(8, box.height - height - 8));
    pill.style.left = `${left}px`;
    pill.style.top = `${top}px`;
    if (pillFade) doc.defaultView?.clearTimeout(pillFade);
    pillFade = 0;
  }

  function fadePill() {
    if (!pill || pill.hidden) return;
    pill.classList.add('is-fading');
    if (pillFade) doc.defaultView?.clearTimeout(pillFade);
    pillFade = doc.defaultView?.setTimeout(() => {
      pill.classList.remove('is-fading');
      hidePill();
    }, 180);
  }

  chip?.addEventListener('click', () => {
    hidePill();
    tab = 'open';
    showList();
  });

  let pillGesture = null;
  pill?.addEventListener('pointerdown', (event) => {
    if (event.button && event.button !== 0) return;
    pillGesture = { x: event.clientX, y: event.clientY, at: Date.now(), moved: false };
  });
  pill?.addEventListener('pointermove', (event) => {
    if (!pillGesture) return;
    if (Math.hypot(event.clientX - pillGesture.x, event.clientY - pillGesture.y) > SLOP_PX) pillGesture.moved = true;
  });
  pill?.addEventListener('pointerup', (event) => {
    const gesture = pillGesture;
    pillGesture = null;
    if (!gesture) return;
    gesture.endX = event.clientX;
    gesture.endY = event.clientY;
    if (!isTap(gesture)) return;
    event.preventDefault();
    const id = pillHits[0]?.id;
    if (id) {
      hidePill();
      setSize('half');
      showThread(id, { listOrigin: false });
    }
  });
  pill?.addEventListener('pointercancel', () => { pillGesture = null; });

  scrim?.addEventListener('click', hideSheet);
  closeBtn?.addEventListener('click', hideSheet);
  back?.addEventListener('click', () => {
    if (fromList) showList();
    else hideSheet();
  });

  quoteBtn?.addEventListener('click', () => {
    if (currentId) hooks.jump?.(currentId);
  });

  resolveBtn?.addEventListener('click', () => {
    const comment = current();
    if (!comment) return;
    const next = comment.status === 'resolved' ? 'open' : 'resolved';
    if (hooks.setStatus?.(comment.id, next)) paintThread();
    paintChip();
    if (mode === 'list') paintList();
  });

  prevBtn?.addEventListener('click', () => move(-1));
  nextBtn?.addEventListener('click', () => move(1));

  tabs?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-tab]');
    if (!button) return;
    tab = button.dataset.tab || 'open';
    paintTabs();
    paintList();
  });

  list?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-comment-id]');
    if (!button) return;
    setSize('full');
    showThread(button.dataset.commentId, { listOrigin: true });
  });

  thread?.addEventListener('click', (event) => {
    const button = event.target.closest?.('.comment-entry-time');
    if (!button) return;
    const index = Number(button.dataset.entry);
    if (exactTimes.has(index)) exactTimes.delete(index);
    else exactTimes.add(index);
    paintThread();
  });

  sendBtn?.addEventListener('click', () => {
    const text = replyBox?.value || '';
    if (!text.trim() || !currentId) return;
    if (hooks.reply?.(currentId, text)) {
      replyBox.value = '';
      paintThread();
      paintChip();
    }
  });

  replyBox?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendBtn?.click();
    }
  });

  let drag = null;
  const handle = sheet.querySelector('.comment-sheet-handle');
  const head = sheet.querySelector('.comment-sheet-head');

  function sheetHeight() {
    const app = doc.getElementById('app');
    return app?.getBoundingClientRect?.().height || 500;
  }

  function snapHeight(dy, vel) {
    if (vel > FLICK_VEL) {
      if (size === 'half') hideSheet();
      else setSize('half');
      return;
    }
    if (vel < -FLICK_VEL) {
      setSize('full');
      return;
    }
    if (dy > 90) {
      if (size === 'half') hideSheet();
      else setSize('half');
      return;
    }
    if (dy < -60) setSize('full');
    else setSize(size);
  }

  function onDragDown(event, surface) {
    if (event.button && event.button !== 0) return;
    drag = {
      id: event.pointerId,
      surface,
      x: event.clientX,
      y: event.clientY,
      at: Date.now(),
      size,
      moved: false,
      samples: [{ y: event.clientY, t: Date.now() }],
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (event.cancelable) event.preventDefault();
  }

  function onDragMove(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const dy = event.clientY - drag.y;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > SLOP_PX) drag.moved = true;
    drag.samples.push({ y: event.clientY, t: Date.now() });
    if (drag.samples.length > 6) drag.samples.shift();
    if (card) {
      const height = sheetHeight();
      const base = drag.size === 'full' ? height : height * 0.5;
      card.style.setProperty('--comment-sheet-drag', `${clamp(base - dy, height * 0.35, height)}px`);
    }
    if (event.cancelable) event.preventDefault();
  }

  function onDragUp(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const active = drag;
    drag = null;
    const dy = event.clientY - active.y;
    const gesture = {
      ...active,
      endX: event.clientX,
      endY: event.clientY,
    };
    let vel = 0;
    if (active.samples.length >= 2) {
      const a = active.samples[active.samples.length - 2];
      const b = active.samples[active.samples.length - 1];
      vel = (b.y - a.y) / Math.max(1, b.t - a.t);
    }
    if (!active.moved && active.surface === 'handle' && isTap(gesture)) {
      setSize(size === 'full' ? 'half' : 'full');
      return;
    }
    if (!active.moved) {
      setSize(size);
      return;
    }
    snapHeight(dy, vel);
  }

  function bindDragSurface(node, surface) {
    if (!node) return;
    const down = (event) => onDragDown(event, surface);
    node.addEventListener('pointerdown', down);
    node.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 1) return;
      const point = event.touches[0];
      onDragDown({
        button: 0,
        pointerId: 1,
        clientX: point.clientX,
        clientY: point.clientY,
        currentTarget: node,
        preventDefault() { event.preventDefault(); },
        setPointerCapture() {},
      }, surface);
    }, { passive: false });
  }

  function headWantsDrag(event) {
    if (event.target.closest?.('.comment-icon-btn, #comment-sheet-close, #comment-sheet-back, #comment-sheet-quote, .comment-sheet-tabs')) {
      return false;
    }
    return event.target === head || head.contains(event.target);
  }

  bindDragSurface(handle, 'handle');
  head?.addEventListener('pointerdown', (event) => {
    if (!headWantsDrag(event)) return;
    onDragDown(event, 'head');
  });
  head?.addEventListener('touchstart', (event) => {
    if (!headWantsDrag(event) || event.touches.length !== 1) return;
    const point = event.touches[0];
    onDragDown({
      button: 0,
      pointerId: 1,
      clientX: point.clientX,
      clientY: point.clientY,
      currentTarget: head,
      preventDefault() { event.preventDefault(); },
      setPointerCapture() {},
    }, 'head');
  }, { passive: false });
  sheet.addEventListener('pointermove', onDragMove);
  sheet.addEventListener('pointerup', onDragUp);
  sheet.addEventListener('touchmove', (event) => {
    if (!drag || event.touches.length !== 1) return;
    const point = event.touches[0];
    onDragMove({
      pointerId: drag.id,
      clientX: point.clientX,
      clientY: point.clientY,
      preventDefault() { event.preventDefault(); },
    });
  }, { passive: false });
  sheet.addEventListener('touchend', (event) => {
    if (!drag) return;
    const point = event.changedTouches[0];
    if (!point) return;
    onDragUp({
      pointerId: drag.id,
      clientX: point.clientX,
      clientY: point.clientY,
    });
  });
  sheet.addEventListener('pointercancel', () => { drag = null; setSize(size); });
  sheet.addEventListener('touchcancel', () => { drag = null; setSize(size); });

  return {
    paintChip,
    openList() {
      hidePill();
      tab = 'open';
      showList();
    },
    openThread(id) {
      hidePill();
      setSize('half');
      showThread(id, { listOrigin: false });
    },
    showPill,
    hidePill,
    fadePill,
    close: hideSheet,
    showing() {
      return !sheet.hidden;
    },
  };
}

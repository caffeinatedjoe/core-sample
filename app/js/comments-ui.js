import {
  COMMENT_REACTIONS,
  authorBubbleHue,
  authorInitial,
  authorsMatch,
  commentQuote,
  commentsForList,
  entryIsUnread,
  firstUnreadIndex,
  isOrphan,
  reactionsForEntry,
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

function sheetHeightLimits(doc, appHeight) {
  const view = doc.defaultView;
  const rootStyle = view?.getComputedStyle(doc.documentElement);
  const probe = doc.getElementById('safe-probe');
  const probeStyle = probe && view?.getComputedStyle(probe);
  const px = (raw) => {
    const value = raw ? Number.parseFloat(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  };
  const safeTop = probeStyle ? px(probeStyle.paddingTop) : px(rootStyle?.getPropertyValue('--safe-top'));
  const gap = px(rootStyle?.getPropertyValue('--comment-sheet-gap-top')) || 8;
  const topClear = safeTop + gap;
  const max = Math.max(0, appHeight - topClear);
  return { max, topClear };
}

const TAP_MS = 500;
const SLOP_PX = 10;
const FLICK_VEL = 0.35;
const SNAP_MS = 220;
const VELOCITY_WINDOW_MS = 100;
const LONG_PRESS_MS = 450;
const CLOSE_VISIBLE = 0.25;
const FULL_NEAR_PX = 80;
const RUBBER = 1 / 3;
const REPLY_LINES = 5;

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
      startCreate() {},
      paintIfOpen() {},
    };
  }

  const card = sheet.querySelector('.comment-sheet-card');
  const chrome = sheet.querySelector('.comment-sheet-chrome');
  const scrim = doc.getElementById('comment-sheet-scrim');
  const prevBtn = doc.getElementById('comment-sheet-prev');
  const nextBtn = doc.getElementById('comment-sheet-next');
  const tabs = doc.getElementById('comment-sheet-tabs');
  const list = doc.getElementById('comment-sheet-list');
  const thread = doc.getElementById('comment-sheet-thread');
  const composer = doc.getElementById('comment-sheet-composer');
  const replyBox = doc.getElementById('comment-reply');
  const sendBtn = doc.getElementById('comment-send');
  const composerCancel = doc.getElementById('comment-composer-cancel');
  const actionSheet = doc.getElementById('comment-action-sheet');
  const actionScrim = doc.getElementById('comment-action-scrim');
  const actionReactions = doc.getElementById('comment-action-reactions');
  const actionRows = doc.getElementById('comment-action-rows');
  const actionCancel = doc.getElementById('comment-action-cancel');
  const reanchorBar = doc.getElementById('comment-reanchor-bar');
  const reanchorAttach = doc.getElementById('comment-reanchor-attach');
  const reanchorCancel = doc.getElementById('comment-reanchor-cancel');

  let mode = 'thread';
  let tab = 'open';
  let currentId = '';
  let size = 'half';
  let fromList = false;
  let exactTimes = new Set();
  let pillHits = [];
  let pillFade = 0;
  let composerMode = 'reply';
  let editingEntry = -1;
  let pendingCreate = null;
  let draftHighlightId = '';
  let reanchorId = '';
  let longPress = null;
  let suppressBubbleClick = false;
  let drag = null;
  let dragRaf = 0;
  let keyboardRaf = 0;

  function comments() {
    return hooks.comments?.() || [];
  }

  function authorName() {
    return hooks.author?.() || 'me';
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

  function hideActionSheet() {
    if (actionSheet) actionSheet.hidden = true;
    suppressBubbleClick = false;
  }

  function hideMenus() {
    hideActionSheet();
  }

  function paintChip() {
    if (!chip) return;
    const count = hooks.openCount?.() ?? 0;
    chip.hidden = count < 1;
    chip.textContent = `💬 ${count}`;
    chip.setAttribute('aria-label', count === 1 ? '1 open comment' : `${count} open comments`);
  }

  function clearDragVisual() {
    card?.style.removeProperty('height');
    card?.style.removeProperty('transform');
    card?.classList.remove('is-snap-animating');
    composer?.style.removeProperty('transform');
    sheet.classList.remove('is-dragging');
  }

  function setSize(next) {
    size = next;
    if (typeof next === 'number') {
      sheet.dataset.size = 'custom';
      card?.style.setProperty('--comment-sheet-rest', `${next}px`);
    } else {
      sheet.dataset.size = next;
      card?.style.removeProperty('--comment-sheet-rest');
    }
    clearDragVisual();
  }

  function showSheet() {
    sheet.hidden = false;
    hooks.onOpen?.();
    scheduleKeyboard();
  }

  function clearComposer() {
    if (replyBox) {
      replyBox.value = '';
      resizeReplyBox();
    }
    composerMode = 'reply';
    editingEntry = -1;
    pendingCreate = null;
    draftHighlightId = '';
    if (sendBtn) sendBtn.textContent = 'Send';
    if (composerCancel) composerCancel.hidden = true;
  }

  function hideSheet() {
    hideMenus();
    if (reanchorId) hooks.onReanchorEnd?.();
    reanchorId = '';
    if (reanchorBar) reanchorBar.hidden = true;
    drag = null;
    if (dragRaf) {
      doc.defaultView?.cancelAnimationFrame?.(dragRaf);
      dragRaf = 0;
    }
    clearDragVisual();
    card?.style.removeProperty('--comment-keyboard');
    sheet.hidden = true;
    currentId = '';
    fromList = false;
    exactTimes = new Set();
    clearComposer();
    hooks.onClose?.();
  }

  function paintTabs() {
    if (!tabs) return;
    for (const button of tabs.querySelectorAll('[data-tab]')) {
      button.setAttribute('aria-selected', button.dataset.tab === tab ? 'true' : 'false');
    }
  }

  function orphanRow(comment) {
    const wrap = el(doc, 'div', 'comment-orphan-row');
    wrap.append(row(comment));
    const actions = el(doc, 'div', 'comment-orphan-actions');
    const del = el(doc, 'button', 'comment-orphan-btn', 'Delete');
    del.type = 'button';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      if (window.confirm('Delete this comment thread?')) hooks.deleteComment?.(comment.id);
      paintList();
      paintChip();
    });
    const re = el(doc, 'button', 'comment-orphan-btn', 'Re-anchor');
    re.type = 'button';
    re.addEventListener('click', (event) => {
      event.stopPropagation();
      startReanchor(comment.id);
    });
    actions.append(del, re);
    wrap.append(actions);
    return wrap;
  }

  function row(comment) {
    const button = el(doc, 'button', 'comment-row');
    button.type = 'button';
    button.dataset.commentId = comment.id;
    const unread = hooks.hasUnread?.(comment.id);
    if (unread) button.classList.add('has-unread');
    const quote = el(doc, 'p', 'comment-row-quote', commentQuote(comment, hooks.doc?.()) || 'Comment');
    if (unread) quote.classList.add('is-unread');
    const first = firstEntry(comment);
    const preview = el(doc, 'p', 'comment-row-text', first ? first.text : '');
    const meta = el(doc, 'p', 'comment-row-meta');
    const replies = replyCount(comment);
    const when = relativeTime(stampOf(comment));
    meta.textContent = replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'} · ${when}` : when;
    button.append(quote, preview, meta);
    if (unread) {
      const dot = el(doc, 'span', 'comment-row-dot');
      dot.setAttribute('aria-hidden', 'true');
      button.append(dot);
    }
    return button;
  }

  function paintList() {
    if (!list) return;
    list.replaceChildren();
    const groups = commentsForList(comments(), tab);
    for (const comment of groups.anchored) list.append(row(comment));
    if (groups.orphans.length) {
      list.append(el(doc, 'h3', 'comment-orphan-heading', 'Text no longer in note'));
      for (const comment of groups.orphans) list.append(orphanRow(comment));
    }
    if (!groups.anchored.length && !groups.orphans.length) {
      list.append(el(doc, 'p', 'comment-empty', tab === 'resolved' ? 'No resolved comments' : 'No comments'));
    }
  }

  function paintReactions(comment, index, parent) {
    const bar = el(doc, 'div', 'comment-reaction-bar');
    for (const row of reactionsForEntry(comment, index)) {
      const chipBtn = el(doc, 'button', 'comment-reaction-chip', `${row.emoji} ${row.count}`);
      chipBtn.type = 'button';
      chipBtn.dataset.emoji = row.emoji;
      chipBtn.dataset.entry = String(index);
      if (row.authors.some((name) => canonical(name) === canonical(authorName()))) {
        chipBtn.classList.add('is-mine');
      }
      bar.append(chipBtn);
    }
    parent.append(bar);
  }

  function canonical(name) {
    return String(name ?? '').trim().replace(/\s+/g, '_');
  }

  function ownEntry(entry) {
    return canonical(entry.author) === canonical(authorName());
  }

  function paintQuoteLine(text, orphan) {
    const quote = el(doc, 'button', 'comment-thread-quote', text);
    quote.id = 'comment-sheet-quote';
    quote.type = 'button';
    if (orphan) quote.classList.add('is-orphan');
    return quote;
  }

  function setArrowVisibility(prevOn, nextOn) {
    if (prevBtn) prevBtn.hidden = !prevOn;
    if (nextBtn) nextBtn.hidden = !nextOn;
  }

  function paintArrows() {
    if (mode !== 'thread' || pendingCreate) {
      setArrowVisibility(false, false);
      return;
    }
    const comment = current();
    if (!comment) {
      setArrowVisibility(false, false);
      return;
    }
    const items = walkList();
    if (items.length <= 1) {
      setArrowVisibility(false, false);
      return;
    }
    const index = items.findIndex((item) => item.id === comment.id);
    setArrowVisibility(index > 0, index >= 0 && index < items.length - 1);
  }

  function paintThread() {
    if (!thread) return;
    thread.replaceChildren();
    hideMenus();
    const comment = current();
    if (!comment && !pendingCreate) return;
    const docText = hooks.doc?.() || '';
    const quote = pendingCreate
      ? (pendingCreate.expected || 'New comment')
      : (commentQuote(comment, docText) || (isOrphan(comment) ? 'Text no longer in note' : 'Comment'));
    thread.append(paintQuoteLine(quote, Boolean(comment && isOrphan(comment))));
    paintArrows();
    if (!comment) return;
    const selfName = hooks.author?.() || 'me';
    const lastSeen = hooks.lastSeen?.(comment.id) || '';
    const unreadFrom = firstUnreadIndex(comment, lastSeen);
    const entries = comment.thread || [];
    for (const [i, entry] of entries.entries()) {
      if (i === unreadFrom && unreadFrom >= 0) {
        const divider = el(doc, 'div', 'comment-new-divider');
        divider.append(el(doc, 'span', null, 'New'));
        thread.append(divider);
      }
      const author = entry.author || 'me';
      const own = authorsMatch(author, selfName);
      const prev = i > 0 ? entries[i - 1] : null;
      const showMeta = !prev || !authorsMatch(author, prev.author);
      const row = el(doc, 'article', `comment-bubble-row ${own ? 'is-own' : 'is-other'}`);
      row.dataset.entry = String(i);
      if (!showMeta) row.classList.add('is-grouped');
      if (!own) {
        if (showMeta) {
          const avatar = el(doc, 'span', 'comment-bubble-avatar', authorInitial(author));
          avatar.style.setProperty('--bubble-hue', String(authorBubbleHue(author)));
          row.append(avatar);
        } else {
          row.append(el(doc, 'span', 'comment-bubble-avatar-spacer'));
        }
      }
      const wrap = el(doc, 'div', 'comment-bubble-stack');
      if (showMeta) {
        const head = el(doc, 'header', 'comment-bubble-meta');
        head.append(el(doc, 'span', 'comment-bubble-author', author));
        const time = el(doc, 'button', 'comment-bubble-time', exactTimes.has(i) ? (entry.timestamp || '') : relativeTime(entry.timestamp));
        time.type = 'button';
        time.dataset.entry = String(i);
        if (entry.timestamp) time.setAttribute('title', entry.timestamp);
        head.append(time);
        wrap.append(head);
      }
      const bubble = el(doc, 'div', `comment-bubble ${own ? 'is-own' : 'is-other'}`);
      if (!own) bubble.style.setProperty('--bubble-hue', String(authorBubbleHue(author)));
      if (entryIsUnread(entry, lastSeen)) bubble.classList.add('is-unread');
      bubble.innerHTML = renderInlineMarkdown(entry.text || '');
      wrap.append(bubble);
      paintReactions(comment, i, wrap);
      row.append(wrap);
      thread.append(row);
    }
    if (doc.activeElement === replyBox) scrollLatestAboveComposer();
  }

  function resizeReplyBox() {
    if (!replyBox) return;
    replyBox.style.height = 'auto';
    const styles = doc.defaultView?.getComputedStyle(replyBox);
    const line = Number.parseFloat(styles?.lineHeight) || 23;
    const pad = (Number.parseFloat(styles?.paddingTop) || 0) + (Number.parseFloat(styles?.paddingBottom) || 0);
    const max = line * REPLY_LINES + pad;
    replyBox.style.height = `${Math.min(replyBox.scrollHeight, max)}px`;
  }

  function scrollLatestAboveComposer() {
    if (!thread) return;
    const last = [...thread.querySelectorAll('.comment-bubble-row')].at(-1);
    if (last) last.scrollIntoView({ block: 'end', inline: 'nearest' });
    else thread.scrollTop = thread.scrollHeight;
  }

  function keyboardOverlap() {
    const view = doc.defaultView;
    const vv = view?.visualViewport;
    if (!view || !vv) return 0;
    return Math.max(0, view.innerHeight - vv.height - vv.offsetTop);
  }

  function applyKeyboardInset() {
    if (!card || sheet.hidden) return;
    const overlap = keyboardOverlap();
    const app = doc.getElementById('app');
    const appBottom = app?.getBoundingClientRect?.().bottom ?? 0;
    const view = doc.defaultView;
    const already = view ? Math.max(0, view.innerHeight - appBottom) : 0;
    const pad = Math.max(0, overlap - already);
    card.style.setProperty('--comment-keyboard', `${pad}px`);
    if (doc.activeElement === replyBox) scrollLatestAboveComposer();
  }

  function scheduleKeyboard() {
    const view = doc.defaultView;
    if (!view?.requestAnimationFrame || keyboardRaf) {
      if (!view?.requestAnimationFrame) applyKeyboardInset();
      return;
    }
    keyboardRaf = view.requestAnimationFrame(() => {
      keyboardRaf = 0;
      applyKeyboardInset();
    });
  }

  function focusComposer() {
    replyBox?.focus();
    if (replyBox) {
      const len = replyBox.value.length;
      replyBox.setSelectionRange(len, len);
    }
    resizeReplyBox();
  }

  function setComposerCreate() {
    composerMode = 'create';
    if (sendBtn) sendBtn.textContent = 'Add';
    if (composerCancel) composerCancel.hidden = false;
    focusComposer();
  }

  function showList() {
    mode = 'list';
    fromList = true;
    setSize('full');
    showSheet();
    setArrowVisibility(false, false);
    if (tabs) tabs.hidden = false;
    if (list) list.hidden = false;
    if (thread) thread.hidden = true;
    if (composer) composer.hidden = true;
    paintTabs();
    paintList();
  }

  function showThread(id, { listOrigin = fromList, create = false } = {}) {
    const comment = comments().find((item) => item.id === id);
    if (!comment && !pendingCreate) return;
    mode = 'thread';
    currentId = id || '';
    fromList = listOrigin;
    exactTimes = new Set();
    showSheet();
    if (tabs) tabs.hidden = true;
    if (list) list.hidden = true;
    if (thread) thread.hidden = false;
    if (composer) composer.hidden = false;
    paintThread();
    if (create) setComposerCreate();
    else if (comment && id) {
      hooks.reveal?.(id);
      const view = doc.defaultView;
      const markLater = () => {
        Promise.resolve(hooks.markSeen?.(id)).then(() => {
          if (currentId !== id || mode !== 'thread') return;
          paintThread();
          if (fromList) paintList();
        });
      };
      if (view?.requestAnimationFrame) {
        view.requestAnimationFrame(() => view.requestAnimationFrame(markLater));
      } else {
        markLater();
      }
    }
  }

  function startCreate(range) {
    hideMenus();
    hidePill();
    pendingCreate = range;
    draftHighlightId = '';
    currentId = '';
    composerMode = 'create';
    mode = 'thread';
    fromList = false;
    setSize('full');
    showSheet();
    setArrowVisibility(false, false);
    if (tabs) tabs.hidden = true;
    if (list) list.hidden = true;
    if (thread) {
      thread.hidden = false;
      thread.replaceChildren(paintQuoteLine(range.expected || 'New comment', false));
    }
    if (composer) composer.hidden = false;
    setComposerCreate();
    hooks.onOpen?.();
  }

  function startReanchor(id) {
    reanchorId = id;
    if (reanchorBar) reanchorBar.hidden = false;
    hideSheet();
    hooks.onReanchorStart?.(id);
  }

  function finishReanchor() {
    const range = hooks.selectionRange?.();
    const id = reanchorId;
    if (!id || !range || range.to <= range.from) return;
    if (hooks.reanchor?.(id, range.from, range.to)) {
      reanchorId = '';
      if (reanchorBar) reanchorBar.hidden = true;
      hooks.onReanchorEnd?.();
      setSize('half');
      showThread(id, { listOrigin: false });
      paintChip();
    }
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

  function addActionRow(label, action, className) {
    if (!actionRows) return;
    const button = el(doc, 'button', className || '', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      hideActionSheet();
      action();
    });
    actionRows.append(button);
  }

  function showActionSheet(index) {
    hideMenus();
    const comment = current();
    if (!comment || !actionSheet) return;
    const entry = comment.thread[index];
    if (!entry) return;
    if (actionReactions) {
      actionReactions.replaceChildren();
      const mine = new Set(
        reactionsForEntry(comment, index)
          .filter((row) => row.authors.some((name) => canonical(name) === canonical(authorName())))
          .map((row) => row.emoji),
      );
      for (const emoji of COMMENT_REACTIONS) {
        const button = el(doc, 'button', mine.has(emoji) ? 'is-mine' : '', emoji);
        button.type = 'button';
        button.dataset.emoji = emoji;
        button.setAttribute('aria-label', emoji);
        button.addEventListener('click', () => {
          hooks.toggleReaction?.(comment.id, index, emoji);
          hideActionSheet();
          paintThread();
        });
        actionReactions.append(button);
      }
    }
    if (actionRows) actionRows.replaceChildren();
    if (ownEntry(entry)) addActionRow('Edit', () => beginEditEntry(index));
    if (index > 0) {
      addActionRow('Delete reply', () => {
        if (hooks.deleteEntry?.(comment.id, index)) {
          paintThread();
          paintChip();
          if (mode === 'list') paintList();
        }
      });
    }
    const resolved = comment.status === 'resolved';
    addActionRow(resolved ? 'Reopen thread' : 'Resolve thread', () => {
      const next = resolved ? 'open' : 'resolved';
      if (hooks.setStatus?.(comment.id, next)) {
        paintThread();
        paintChip();
        if (mode === 'list') paintList();
      }
    });
    if (isOrphan(comment)) {
      addActionRow('Re-anchor', () => startReanchor(comment.id));
    }
    addActionRow('Delete comment', () => {
      if (!window.confirm('Delete this comment? The highlighted text will stay.')) return;
      if (hooks.deleteComment?.(comment.id)) {
        hideSheet();
        paintChip();
      }
    }, 'is-danger');
    actionSheet.hidden = false;
  }

  function beginEditEntry(index) {
    const comment = current();
    if (!comment) return;
    const entry = comment.thread[index];
    if (!entry || !ownEntry(entry)) return;
    composerMode = 'edit';
    editingEntry = index;
    if (replyBox) replyBox.value = entry.text;
    if (sendBtn) sendBtn.textContent = 'Save';
    if (composerCancel) composerCancel.hidden = false;
    focusComposer();
  }

  function submitComposer() {
    const text = replyBox?.value || '';
    if (!text.trim() && composerMode !== 'edit') {
      cancelComposer();
      return;
    }
    if (composerMode === 'create' && pendingCreate) {
      const range = pendingCreate;
      pendingCreate = null;
      if (!hooks.createComment?.(range, text)) {
        pendingCreate = range;
        return;
      }
      clearComposer();
      paintChip();
      return;
    }
    if (composerMode === 'edit' && editingEntry >= 0 && currentId) {
      if (!text.trim()) return;
      if (hooks.editEntry?.(currentId, editingEntry, text)) {
        clearComposer();
        paintThread();
      }
      return;
    }
    if (!text.trim() || !currentId) return;
    if (hooks.reply?.(currentId, text)) {
      replyBox.value = '';
      resizeReplyBox();
      paintThread();
      paintChip();
      if (mode === 'list') paintList();
      scrollLatestAboveComposer();
    }
  }

  function cancelComposer() {
    if (composerMode === 'create') {
      if (draftHighlightId) hooks.cancelDraft?.(draftHighlightId);
      pendingCreate = null;
      hideSheet();
      return;
    }
    if (composerMode === 'edit') {
      clearComposer();
      return;
    }
    if (draftHighlightId) {
      hooks.cancelDraft?.(draftHighlightId);
      draftHighlightId = '';
      hideSheet();
    }
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
    if (suppressBubbleClick) {
      suppressBubbleClick = false;
      event.preventDefault();
      return;
    }
    if (event.target.closest?.('#comment-sheet-quote')) {
      if (currentId) hooks.jump?.(currentId);
      return;
    }
    const button = event.target.closest?.('.comment-bubble-time');
    if (button) {
      const index = Number(button.dataset.entry);
      if (exactTimes.has(index)) exactTimes.delete(index);
      else exactTimes.add(index);
      paintThread();
      return;
    }
    const reaction = event.target.closest?.('.comment-reaction-chip');
    if (reaction && currentId) {
      hooks.toggleReaction?.(currentId, Number(reaction.dataset.entry), reaction.dataset.emoji);
      paintThread();
    }
  });

  thread?.addEventListener('contextmenu', (event) => {
    if (event.target.closest?.('.comment-bubble, .comment-bubble-row')) event.preventDefault();
  });

  function cancelLongPress() {
    if (!longPress) return;
    doc.defaultView?.clearTimeout(longPress.timer);
    longPress = null;
  }

  thread?.addEventListener('pointerdown', (event) => {
    if (event.button && event.button !== 0) return;
    const row = event.target.closest?.('.comment-bubble-row');
    if (!row || !current()) return;
    const index = Number(row.dataset.entry);
    if (!Number.isFinite(index)) return;
    cancelLongPress();
    const view = doc.defaultView;
    longPress = {
      index,
      x: event.clientX,
      y: event.clientY,
      scroll: thread.scrollTop,
      moved: false,
      timer: view?.setTimeout(() => {
        const press = longPress;
        longPress = null;
        if (!press || press.moved || drag) return;
        suppressBubbleClick = true;
        showActionSheet(press.index);
        view?.setTimeout?.(() => { suppressBubbleClick = false; }, 400);
      }, LONG_PRESS_MS),
    };
  });
  thread?.addEventListener('pointermove', (event) => {
    if (!longPress) return;
    if (Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > SLOP_PX) {
      longPress.moved = true;
      cancelLongPress();
    }
  });
  thread?.addEventListener('pointerup', cancelLongPress);
  thread?.addEventListener('pointercancel', cancelLongPress);
  thread?.addEventListener('scroll', () => {
    if (!longPress) return;
    if (Math.abs(thread.scrollTop - longPress.scroll) > 0) {
      longPress.moved = true;
      cancelLongPress();
    }
  }, { passive: true });

  actionScrim?.addEventListener('click', hideActionSheet);
  actionCancel?.addEventListener('click', hideActionSheet);

  sendBtn?.addEventListener('click', submitComposer);
  composerCancel?.addEventListener('click', cancelComposer);

  replyBox?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitComposer();
    }
  });
  replyBox?.addEventListener('input', resizeReplyBox);
  replyBox?.addEventListener('focus', () => {
    if (drag) return;
    snapToFullForComposer();
  });

  reanchorAttach?.addEventListener('click', finishReanchor);
  reanchorCancel?.addEventListener('click', () => {
    reanchorId = '';
    if (reanchorBar) reanchorBar.hidden = true;
    hooks.onReanchorEnd?.();
  });

  function sheetHeight() {
    const app = doc.getElementById('app');
    return app?.getBoundingClientRect?.().height || 500;
  }

  function prefersReducedMotion() {
    return doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  }

  function velocityFromSamples(samples) {
    if (samples.length < 2) return 0;
    const end = samples[samples.length - 1];
    const cutoff = end.t - VELOCITY_WINDOW_MS;
    let start = samples[0];
    for (const sample of samples) {
      if (sample.t >= cutoff) {
        start = sample;
        break;
      }
    }
    if (start === end) return 0;
    return (end.y - start.y) / Math.max(1, end.t - start.t);
  }

  function rubberband(translateY) {
    if (translateY < 0) return translateY * RUBBER;
    return translateY;
  }

  function restingTranslateY(state, target) {
    if (target === 'full') return 0;
    if (target === 'half') return Math.max(0, state.fullHeight - state.appHeight * 0.5);
    if (typeof target === 'number') return Math.max(0, state.fullHeight - target);
    return Math.max(0, state.fullHeight - state.appHeight * 0.5);
  }

  function composerCounterY(translateY, state) {
    if (!state) return 0;
    const max = Math.max(0, state.fullHeight - state.chromeHeight - state.composerHeight);
    return Math.min(Math.max(translateY, 0), max);
  }

  function applyDragTransform(translateY, state) {
    if (!card) return;
    card.style.transform = `translate3d(0, ${translateY}px, 0)`;
    if (!composer || !state) return;
    const counter = composerCounterY(translateY, state);
    if (counter > 0) composer.style.transform = `translate3d(0, ${-counter}px, 0)`;
    else composer.style.removeProperty('transform');
  }

  function measureSheet() {
    const appHeight = sheetHeight();
    const limits = sheetHeightLimits(doc, appHeight);
    const fullHeight = limits.max;
    const app = doc.getElementById('app');
    const appRect = app?.getBoundingClientRect?.() || { top: 0, bottom: appHeight };
    const restingTopFull = appRect.bottom - fullHeight;
    const rect = card?.getBoundingClientRect?.();
    const translateY = rect ? rect.top - restingTopFull : restingTranslateY({ appHeight, fullHeight }, size);
    const chromeHeight = chrome?.getBoundingClientRect?.().height ?? 0;
    const composerHeight = composer?.getBoundingClientRect?.().height ?? 0;
    return {
      appHeight,
      limits,
      fullHeight,
      restingTopFull,
      translateY,
      size,
      chromeHeight,
      composerHeight,
    };
  }

  function scheduleDragPaint() {
    const view = doc.defaultView;
    if (!view || dragRaf || !drag || drag.pendingTranslateY == null) return;
    dragRaf = view.requestAnimationFrame(() => {
      dragRaf = 0;
      if (!drag || drag.pendingTranslateY == null) return;
      drag.translateY = rubberband(drag.pendingTranslateY);
      applyDragTransform(drag.translateY, drag);
      drag.pendingTranslateY = null;
    });
  }

  function beginDragVisual(state) {
    if (!card) return;
    sheet.classList.add('is-dragging');
    card.style.height = `${state.fullHeight}px`;
    card.style.removeProperty('--comment-sheet-drag');
    applyDragTransform(state.translateY, state);
  }

  function finishDragMotion(active, targetY, done) {
    if (!card) {
      done?.();
      return;
    }
    const startY = active.translateY;
    if (prefersReducedMotion() || Math.abs(targetY - startY) < 0.5) {
      applyDragTransform(targetY, active);
      done?.();
      return;
    }
    const view = doc.defaultView;
    const run = () => {
      if (!card) {
        done?.();
        return;
      }
      card.classList.add('is-snap-animating');
      applyDragTransform(targetY, active);
      let settled = false;
      const onEnd = (event) => {
        if (settled) return;
        if (event.target !== card || event.propertyName !== 'transform') return;
        settled = true;
        card.removeEventListener('transitionend', onEnd);
        card.classList.remove('is-snap-animating');
        composer?.style.removeProperty('transform');
        done?.();
      };
      card.addEventListener('transitionend', onEnd);
      view?.setTimeout?.(() => {
        if (settled || !card.classList.contains('is-snap-animating')) return;
        onEnd({ target: card, propertyName: 'transform' });
      }, SNAP_MS + 60);
    };
    if (view?.requestAnimationFrame) view.requestAnimationFrame(run);
    else run();
  }

  function settleDrag(active, vel) {
    const visible = active.fullHeight - active.translateY;
    if (vel < -FLICK_VEL || active.translateY <= FULL_NEAR_PX) {
      finishDragMotion(active, 0, () => setSize('full'));
      return;
    }
    if (vel > FLICK_VEL || visible < CLOSE_VISIBLE * active.appHeight) {
      finishDragMotion(active, active.fullHeight + 24, () => hideSheet());
      return;
    }
    finishDragMotion(active, active.translateY, () => setSize(Math.max(0, visible)));
  }

  function animateToSize(target) {
    const state = measureSheet();
    beginDragVisual(state);
    const targetY = restingTranslateY(state, target);
    finishDragMotion({ ...state, translateY: state.translateY }, targetY, () => setSize(target));
  }

  function snapToFullForComposer() {
    const after = () => {
      scheduleKeyboard();
      resizeReplyBox();
      scrollLatestAboveComposer();
    };
    if (size !== 'full') {
      const state = measureSheet();
      beginDragVisual(state);
      finishDragMotion({ ...state, translateY: state.translateY }, 0, () => {
        setSize('full');
        after();
      });
      return;
    }
    after();
  }

  function onDragDown(event, surface) {
    if (event.button && event.button !== 0) return;
    if (drag) return;
    hideMenus();
    cancelLongPress();
    const state = measureSheet();
    drag = {
      id: event.pointerId,
      surface,
      x: event.clientX,
      y: event.clientY,
      at: Date.now(),
      size,
      moved: false,
      appHeight: state.appHeight,
      limits: state.limits,
      fullHeight: state.fullHeight,
      chromeHeight: state.chromeHeight,
      composerHeight: state.composerHeight,
      restingTopFull: state.restingTopFull,
      startTranslateY: state.translateY,
      translateY: state.translateY,
      pendingTranslateY: null,
      samples: [{ y: event.clientY, t: event.timeStamp }],
    };
    beginDragVisual(drag);
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Headless WebKit rejects capture on some synthetic pointer events.
    }
    if (event.cancelable) event.preventDefault();
  }

  function onDragMove(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const dy = event.clientY - drag.y;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > SLOP_PX) drag.moved = true;
    drag.samples.push({ y: event.clientY, t: event.timeStamp });
    if (drag.samples.length > 12) drag.samples.shift();
    drag.pendingTranslateY = drag.startTranslateY + dy;
    scheduleDragPaint();
    if (event.cancelable) event.preventDefault();
  }

  function onDragUp(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const active = drag;
    drag = null;
    if (dragRaf) {
      doc.defaultView?.cancelAnimationFrame?.(dragRaf);
      dragRaf = 0;
    }
    if (active.pendingTranslateY != null) {
      active.translateY = rubberband(active.pendingTranslateY);
      applyDragTransform(active.translateY, active);
      active.pendingTranslateY = null;
    }
    const gesture = {
      ...active,
      endX: event.clientX,
      endY: event.clientY,
    };
    const vel = velocityFromSamples(active.samples);
    const tappedHandle = event.target.closest?.('.comment-sheet-handle');
    if (!active.moved && tappedHandle && isTap(gesture)) {
      clearDragVisual();
      animateToSize(size === 'full' ? 'half' : 'full');
      return;
    }
    if (!active.moved) {
      clearDragVisual();
      setSize(size);
      return;
    }
    settleDrag(active, vel);
  }

  function chromeWantsDrag(event) {
    if (event.target.closest?.('#comment-sheet-prev, #comment-sheet-next')) return false;
    return event.target === chrome || chrome.contains(event.target);
  }

  chrome?.addEventListener('pointerdown', (event) => {
    if (!chromeWantsDrag(event)) return;
    const surface = event.target.closest?.('.comment-sheet-handle') ? 'handle' : 'head';
    onDragDown(event, surface);
  });
  sheet.addEventListener('pointermove', onDragMove);
  sheet.addEventListener('pointerup', onDragUp);
  sheet.addEventListener('pointercancel', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const active = drag;
    drag = null;
    if (dragRaf) {
      doc.defaultView?.cancelAnimationFrame?.(dragRaf);
      dragRaf = 0;
    }
    finishDragMotion(active, restingTranslateY(active, active.size), () => setSize(active.size));
  });

  const view = doc.defaultView;
  view?.visualViewport?.addEventListener('resize', scheduleKeyboard);
  view?.visualViewport?.addEventListener('scroll', scheduleKeyboard);

  return {
    paintChip,
    openList() {
      hidePill();
      tab = 'open';
      showList();
    },
    openThread(id) {
      hidePill();
      if (sheet.hidden) setSize('half');
      showThread(id, { listOrigin: false });
    },
    startCreate,
    showPill,
    hidePill,
    fadePill,
    close: hideSheet,
    showing() {
      return !sheet.hidden;
    },
    paintIfOpen() {
      if (sheet.hidden) return;
      if (mode === 'list') paintList();
      else paintThread();
      paintChip();
    },
  };
}

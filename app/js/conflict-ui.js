import {
  decideAll,
  formatWhen,
  hunksForConflict,
  listConflicts,
  mergedText,
  planResolution,
  sideMarks,
  unresolvedCount,
} from './conflicts.js';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(doc, className, text) {
  const node = el(doc, 'button', className, text);
  node.type = 'button';
  return node;
}

function marksFor(hunk, side) {
  const lines = side === 'phone' ? hunk.phone : hunk.github;
  const other = side === 'phone' ? hunk.github : hunk.phone;
  const base = hunk.base && hunk.base.length ? hunk.base : other;
  return sideMarks(base, lines);
}

export function mountConflictScreen(doc, { files, apply, dismiss } = {}) {
  const sheet = doc.getElementById('conflict-sheet');
  if (!sheet || !doc.getElementById('undo-toast')) {
    return { open() {}, close() {}, showing() { return false; } };
  }
  const listView = doc.getElementById('conflict-list-view');
  const resolveView = doc.getElementById('conflict-resolve-view');
  const heading = doc.getElementById('conflict-heading');
  const toast = doc.getElementById('undo-toast');
  const toastText = doc.getElementById('undo-toast-text');
  const toastButton = doc.getElementById('undo-toast-action');
  let path = '';
  let hunks = [];
  let trailing = true;
  let choice = '';
  let handwritten = false;
  let focusAt = 0;
  let undo = null;
  let toastTimer = null;
  let pendingOffer = '';

  function fileByPath(notePath) {
    return (files() || []).find((file) => file.path === notePath && !file.trashedAt);
  }

  function siblingFor(note) {
    return (files() || []).find((file) => file.conflictCopy && !file.backup && !file.trashedAt && file.path.includes('(conflict ') && file.path.startsWith(note.path.slice(0, note.path.lastIndexOf('/') + 1)));
  }

  function showToast(summary, undoFn) {
    undo = undoFn;
    toastText.textContent = summary;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    const win = doc.defaultView;
    toastTimer = win.setTimeout(() => {
      toast.hidden = true;
    }, 8000);
  }

  toastButton.addEventListener('click', async () => {
    const run = undo;
    undo = null;
    toast.hidden = true;
    if (toastTimer) clearTimeout(toastTimer);
    if (run) await run();
    if (!sheet.hidden) paintList();
  });

  function resolveBar() {
    return doc.getElementById('conflict-resolve-bar');
  }

  function stepBar() {
    return doc.getElementById('conflict-step-bar');
  }

  function paintList() {
    listView.hidden = false;
    resolveView.hidden = true;
    for (const bar of [resolveBar(), stepBar()]) {
      if (bar) bar.hidden = true;
    }
    heading.textContent = 'Conflicts';
    listView.replaceChildren();
    if (pendingOffer) {
      const leftover = (files() || []).find((file) => file.path === pendingOffer && file.conflictCopy && !file.trashedAt);
      if (!leftover) pendingOffer = '';
      else {
        const offer = el(doc, 'div', 'conflict-offer');
        offer.append(el(doc, 'p', 'conflict-offer-text', 'Move the leftover conflict copy to Trash? You can restore it later.'));
        const actions = el(doc, 'div', 'conflict-offer-actions');
        const trash = button(doc, 'conflict-primary', 'Move copy to Trash');
        trash.id = 'conflict-trash-copy';
        trash.addEventListener('click', async () => {
          const path = pendingOffer;
          pendingOffer = '';
          await dismiss(path);
          paintList();
        });
        const keep = button(doc, 'conflict-dismiss', 'Keep copy');
        keep.id = 'conflict-keep-copy';
        keep.addEventListener('click', () => {
          pendingOffer = '';
          paintList();
        });
        actions.append(trash, keep);
        offer.append(actions);
        listView.append(offer);
      }
    }
    const items = listConflicts(files());
    if (!items.length && !pendingOffer) {
      listView.append(el(doc, 'p', 'conflict-empty', 'No conflicts on this phone.'));
      return;
    }
    if (!items.length) return;
    const list = el(doc, 'ul', 'conflict-list');
    list.id = 'conflict-list';
    for (const item of items) {
      const row = el(doc, 'li', 'conflict-row');
      const open = button(doc, 'conflict-open', '');
      open.dataset.path = item.path;
      open.append(
        el(doc, 'span', 'conflict-path', item.path),
        el(doc, 'span', 'conflict-why', item.why),
        el(doc, 'span', 'conflict-when', item.whenLabel ? `Recorded ${item.whenLabel}` : 'Recorded before this version'),
      );
      open.addEventListener('click', () => {
        const target = item.role === 'sibling' && item.originalPath ? item.originalPath : item.path;
        if (item.role === 'sibling' && !item.originalPath) return;
        openResolve(target);
      });
      row.append(open);
      if (item.role === 'sibling') {
        const drop = button(doc, 'conflict-dismiss', 'Dismiss');
        drop.dataset.path = item.path;
        drop.addEventListener('click', async () => {
          await dismiss(item.path);
          paintList();
        });
        row.append(drop);
      }
      list.append(row);
    }
    listView.append(list);
  }

  function currentFile() {
    return fileByPath(path);
  }

  function previewText() {
    const file = currentFile();
    if (!file) return '';
    if (handwritten) {
      const editor = resolveView.querySelector('#merge-editor');
      return editor ? editor.value : '';
    }
    if (choice === 'phone') return String(file.content ?? '');
    if (choice === 'github' || choice === 'separate') return String(file.conflictRemote ?? '');
    return mergedText(hunks, trailing);
  }

  function refreshChrome() {
    const conflicts = hunks.filter((hunk) => hunk.kind === 'conflict');
    const left = unresolvedCount(hunks);
    const count = doc.getElementById('conflict-remaining');
    if (count) {
      count.textContent = left === 0 ? 'No conflicts left' : `${left} conflict${left === 1 ? '' : 's'} left`;
    }
    const label = doc.getElementById('conflict-step-label');
    if (label) {
      const shown = Math.min(focusAt + 1, Math.max(conflicts.length, 1));
      label.textContent = conflicts.length ? `Conflict ${shown} of ${conflicts.length}` : 'No conflicting lines';
    }
    const prev = doc.getElementById('conflict-prev');
    const next = doc.getElementById('conflict-next');
    if (prev) prev.disabled = focusAt <= 0;
    if (next) next.disabled = focusAt >= conflicts.length - 1;
    const resolve = doc.getElementById('conflict-resolve-button');
    if (resolve) {
      const ready = choice === 'phone' || choice === 'github' || choice === 'separate' || left === 0;
      resolve.disabled = !ready;
    }
    const preview = resolveView.querySelector('#merge-preview');
    const editor = resolveView.querySelector('#merge-editor');
    const text = previewText();
    if (preview) preview.textContent = text || 'Nothing selected yet.';
    if (editor && !handwritten && doc.activeElement !== editor) editor.value = text;
  }

  function renderResolve() {
    const file = currentFile();
    resolveView.replaceChildren();
    if (!file) {
      for (const bar of [resolveBar(), stepBar()]) {
        if (bar) bar.hidden = true;
      }
      resolveView.append(el(doc, 'p', 'conflict-empty', 'That note is no longer on this phone.'));
      return;
    }
    heading.textContent = file.path;
    const nav = el(doc, 'div', 'conflict-nav');
    const prev = button(doc, 'conflict-step', '‹');
    prev.id = 'conflict-prev';
    prev.setAttribute('aria-label', 'Previous conflict');
    const counts = el(doc, 'div', 'conflict-counts');
    const step = el(doc, 'p', 'conflict-step-label', '');
    step.id = 'conflict-step-label';
    const left = el(doc, 'p', 'conflict-remaining', '');
    left.id = 'conflict-remaining';
    left.setAttribute('aria-live', 'polite');
    counts.append(step, left);
    const next = button(doc, 'conflict-step', '›');
    next.id = 'conflict-next';
    next.setAttribute('aria-label', 'Next conflict');
    prev.addEventListener('click', () => focusConflict(-1));
    next.addEventListener('click', () => focusConflict(1));
    nav.append(prev, counts, next);
    const fixedStep = stepBar();
    if (fixedStep) {
      fixedStep.replaceChildren(nav);
      fixedStep.hidden = false;
    } else {
      const bar = el(doc, 'div', 'conflict-bar');
      bar.append(nav);
      resolveView.append(bar);
    }

    const whole = el(doc, 'div', 'conflict-whole');
    whole.append(el(doc, 'p', 'conflict-section-label', 'Whole note'));
    const actions = el(doc, 'div', 'conflict-whole-actions');
    const phone = button(doc, 'conflict-choice', 'Keep phone');
    phone.id = 'keep-phone';
    phone.setAttribute('aria-pressed', choice === 'phone' ? 'true' : 'false');
    const github = button(doc, 'conflict-choice', 'Keep GitHub');
    github.id = 'keep-github';
    github.setAttribute('aria-pressed', choice === 'github' ? 'true' : 'false');
    const both = button(doc, 'conflict-choice', 'Keep both notes');
    both.id = 'keep-both';
    both.setAttribute('aria-pressed', choice === 'separate' ? 'true' : 'false');
    phone.addEventListener('click', () => chooseWhole('phone'));
    github.addEventListener('click', () => chooseWhole('github'));
    both.addEventListener('click', () => chooseWhole('separate'));
    actions.append(phone, github, both);
    whole.append(actions);
    resolveView.append(whole);

    const phoneWhen = formatWhen(file.updatedAt);
    const githubWhen = formatWhen(file.conflictRemoteAt || file.conflictAt);
    hunks.forEach((hunk, index) => {
      if (hunk.kind === 'same') {
        const block = el(doc, 'div', 'hunk hunk-context');
        const toggle = button(doc, 'hunk-toggle', `${hunk.lines.length} unchanged line${hunk.lines.length === 1 ? '' : 's'}`);
        toggle.setAttribute('aria-expanded', 'false');
        const body = el(doc, 'pre', 'diff-block');
        body.hidden = true;
        for (const line of hunk.lines) body.append(el(doc, 'span', 'diff-line', line));
        toggle.addEventListener('click', () => {
          const open = toggle.getAttribute('aria-expanded') === 'true';
          toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
          body.hidden = open;
          toggle.textContent = open
            ? `${hunk.lines.length} unchanged line${hunk.lines.length === 1 ? '' : 's'}`
            : 'Hide unchanged lines';
        });
        block.append(toggle, body);
        resolveView.append(block);
        return;
      }
      const block = el(doc, 'section', 'hunk hunk-conflict');
      block.dataset.hunk = String(index);
      block.append(sideBlock('On this phone', phoneWhen ? `Changed ${phoneWhen}` : 'Changed on this phone', marksFor(hunk, 'phone')));
      block.append(sideBlock('On GitHub', githubWhen ? `As of ${githubWhen}` : 'As of the last sync', marksFor(hunk, 'github')));
      const choices = el(doc, 'div', 'hunk-choices');
      choices.setAttribute('role', 'group');
      choices.setAttribute('aria-label', 'Choose a side for this change');
      for (const [name, label] of [['phone', 'Phone'], ['github', 'GitHub'], ['both', 'Both']]) {
        const pick = button(doc, 'hunk-choice', label);
        pick.dataset.choice = name;
        pick.setAttribute('aria-pressed', hunk.decision === name ? 'true' : 'false');
        pick.addEventListener('click', () => chooseHunk(index, name));
        choices.append(pick);
      }
      block.append(choices);
      if (hunk.decision === 'both' || resolveView.dataset.ordering === String(index)) {
        const order = el(doc, 'div', 'hunk-order');
        for (const [name, label] of [['phone-first', 'Phone, then GitHub'], ['github-first', 'GitHub, then phone']]) {
          const pick = button(doc, 'order-choice', label);
          pick.dataset.order = name;
          pick.setAttribute('aria-pressed', hunk.decision === 'both' && hunk.order === name ? 'true' : 'false');
          pick.addEventListener('click', () => chooseOrder(index, name));
          order.append(pick);
        }
        block.append(order);
      }
      resolveView.append(block);
    });

    const editLabel = el(doc, 'label', 'merge-edit-label', 'Merged result');
    const editor = el(doc, 'textarea', 'merge-editor');
    editor.id = 'merge-editor';
    editor.value = previewText();
    editor.addEventListener('input', () => {
      handwritten = true;
      choice = choice === 'separate' ? 'merge' : (choice || 'merge');
      const preview = resolveView.querySelector('#merge-preview');
      if (preview) preview.textContent = editor.value || 'Nothing selected yet.';
    });
    editLabel.append(editor);
    const previewHeading = el(doc, 'h3', 'merge-preview-heading', 'Preview');
    const preview = el(doc, 'pre', 'merge-preview');
    preview.id = 'merge-preview';
    resolveView.append(editLabel, previewHeading, preview);

    const resolve = button(doc, 'conflict-primary', 'Resolve');
    resolve.id = 'conflict-resolve-button';
    resolve.addEventListener('click', () => confirm());
    const actionBar = resolveBar();
    if (actionBar) {
      actionBar.replaceChildren(resolve);
      actionBar.hidden = false;
    } else {
      resolveView.append(resolve);
    }
    refreshChrome();
    const conflicts = [...resolveView.querySelectorAll('.hunk-conflict')];
    if (conflicts[focusAt]) conflicts[focusAt].scrollIntoView({ block: 'nearest' });
  }

  function sideBlock(title, when, marks) {
    const side = el(doc, 'div', 'conflict-side');
    const head = el(doc, 'div', 'conflict-side-head');
    head.append(el(doc, 'span', 'conflict-side-title', title), el(doc, 'span', 'conflict-side-when', when));
    const body = el(doc, 'pre', 'diff-block');
    if (!marks.length) body.append(el(doc, 'span', 'diff-line diff-empty', 'No lines'));
    for (const mark of marks) {
      const line = el(doc, 'span', `diff-line${mark.mark === '+' ? ' diff-add' : ''}${mark.mark === '−' ? ' diff-del' : ''}`);
      if (mark.mark) {
        line.append(el(doc, 'span', 'diff-mark', mark.mark));
        line.append(el(doc, 'span', 'diff-word', mark.word));
      }
      line.append(doc.createTextNode(mark.text || ' '));
      body.append(line);
    }
    side.append(head, body);
    return side;
  }

  function chooseWhole(next) {
    handwritten = false;
    choice = next;
    if (next === 'phone') hunks = decideAll(hunks, 'phone');
    else if (next === 'github') hunks = decideAll(hunks, 'github');
    renderResolve();
  }

  function chooseHunk(index, decision) {
    handwritten = false;
    choice = 'merge';
    hunks = hunks.map((hunk, at) => {
      if (at !== index || hunk.kind !== 'conflict') return hunk;
      if (decision === 'both') return { ...hunk, decision: null, order: hunk.order || 'phone-first' };
      return { ...hunk, decision };
    });
    resolveView.dataset.ordering = decision === 'both' ? String(index) : '';
    renderResolve();
  }

  function chooseOrder(index, order) {
    handwritten = false;
    choice = 'merge';
    hunks = hunks.map((hunk, at) => (at === index ? { ...hunk, decision: 'both', order } : hunk));
    resolveView.dataset.ordering = '';
    renderResolve();
  }

  function focusConflict(step) {
    const conflicts = hunks.filter((hunk) => hunk.kind === 'conflict');
    focusAt = Math.max(0, Math.min(conflicts.length - 1, focusAt + step));
    renderResolve();
  }

  async function confirm() {
    const file = currentFile();
    if (!file) return;
    const mode = choice === 'phone' || choice === 'github' || choice === 'separate' ? choice : 'merge';
    const taken = new Set((files() || []).map((item) => item.path));
    const plan = planResolution({
      file,
      hunks,
      trailing,
      mode,
      editedText: handwritten ? resolveView.querySelector('#merge-editor').value : null,
      now: Date.now(),
      taken,
    });
    const sibling = (files() || []).find((item) => (
      item.conflictCopy && !item.backup && !item.trashedAt && item.path.includes('(conflict ')
      && item.path.startsWith(file.path.replace(/[^/]+$/, ''))
      && item.path !== file.path
    ));
    const result = await apply(plan);
    pendingOffer = sibling && sibling.path ? sibling.path : '';
    showToast(plan.summary, async () => {
      pendingOffer = '';
      if (result && result.undo) await result.undo();
    });
    paintList();
  }

  function openResolve(notePath) {
    const file = fileByPath(notePath);
    if (!file) {
      paintList();
      return;
    }
    path = file.path;
    const merged = hunksForConflict(file, siblingFor(file));
    hunks = merged.hunks;
    trailing = merged.trailing;
    choice = '';
    handwritten = false;
    focusAt = 0;
    listView.hidden = true;
    resolveView.hidden = false;
    renderResolve();
  }

  doc.getElementById('conflict-close').addEventListener('click', () => {
    sheet.hidden = true;
  });
  const back = doc.getElementById('conflict-back');
  if (back) {
    back.addEventListener('click', () => {
      if (!resolveView.hidden) paintList();
      else sheet.hidden = true;
    });
  }

  return {
    open() {
      sheet.hidden = false;
      paintList();
    },
    close() {
      sheet.hidden = true;
    },
    showing() {
      return !sheet.hidden;
    },
  };
}

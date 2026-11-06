// The note editor: one CodeMirror view that draws Markdown in place. The text
// is never rewritten for display; live-rules.js decides what to draw, and the
// host gets the same hooks the old textarea gave it (input, blur, taps).
import {
  Compartment,
  Decoration,
  EditorState,
  EditorView,
  ViewPlugin,
  WidgetType,
  defaultKeymap,
  ensureSyntaxTree,
  history,
  historyKeymap,
  keymap,
  placeholder,
  redo,
  syntaxTree,
  undo,
} from '../vendor/codemirror.js';
import { calloutFoldChange, calloutHeight } from './callouts.js';
import { basename } from './embeds.js';
import { formatChange } from './format.js';
import { propertyChange, propertiesHeight } from './frontmatter.js';
import { continueEnter, indentChange } from './list-continue.js';
import { liveSpecs, markdownLanguage, taskToggle } from './live-rules.js';
import { renderMarkdown } from './markdown.js';
import { mathHTML } from './math.js';
import { planPreviewClick } from './preview-tap.js';
import { tableCellChange, tableHeight } from './tables.js';

const CHECK = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 6.2 4.6 9 10 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const HOLD_MS = 450;
const SLOP_PX = 10;

function classOf(base, extra) {
  return extra ? `${base} ${extra}` : base;
}

function make(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function drawImage(doc, image, view, hooks) {
  const node = make(doc, 'span', 'embed');
  if (image.kind === 'remote') {
    node.dataset.live = 'image';
    const img = make(doc, 'img', 'embed-image');
    img.alt = image.alt || '';
    if (image.width) img.style.width = `${Number(image.width)}px`;
    if (image.height) img.style.height = `${Number(image.height)}px`;
    img.addEventListener('load', () => view.requestMeasure());
    img.src = image.src;
    node.append(img);
    return node;
  }
  node.append(make(doc, 'span', 'embed-fallback', basename(image.name) || image.name || 'image'));
  if (image.kind !== 'embed') return node;
  node.dataset.live = 'image';
  node.dataset.embed = image.embed;
  if (image.width) node.dataset.width = String(image.width);
  if (image.height) node.dataset.height = String(image.height);
  hooks.hydrate?.(node);
  return node;
}

function setHTML(node, html) {
  node.innerHTML = html;
}

function drawTable(doc, spec) {
  const wrap = make(doc, 'div', 'cm-table-widget');
  wrap.setAttribute('contenteditable', 'false');
  wrap.dataset.live = 'table';
  const table = make(doc, 'table');
  const head = make(doc, 'thead');
  const body = make(doc, 'tbody');
  for (const [rowIndex, row] of (spec.table?.rows || []).entries()) {
    const tr = make(doc, 'tr');
    const tag = row.kind === 'header' ? 'th' : 'td';
    const parent = row.kind === 'header' ? head : body;
    for (const [colIndex, cell] of row.cells.entries()) {
      const td = make(doc, tag);
      td.textContent = cell.text;
      td.dataset.live = 'table-cell';
      td.dataset.row = String(rowIndex);
      td.dataset.col = String(colIndex);
      td.style.textAlign = cell.align || 'left';
      tr.append(td);
    }
    parent.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

function drawCallout(doc, spec, hooks) {
  const callout = spec.callout || {};
  const node = make(doc, 'div', `cm-callout is-${callout.kind || 'note'}`);
  node.setAttribute('contenteditable', 'false');
  node.dataset.live = 'callout';
  if (callout.fold) node.dataset.fold = callout.fold;
  const title = make(doc, 'div', 'callout-title', callout.title || 'Note');
  title.dataset.live = 'callout-title';
  node.append(title);
  if (callout.fold !== '-') {
    const body = make(doc, 'div', 'callout-body');
    setHTML(body, renderMarkdown(callout.body || ''));
    node.append(body);
  }
  hooks.hydrate?.(node);
  return node;
}

function drawMath(doc, spec) {
  const node = make(doc, spec.display ? 'div' : 'span', classOf(spec.display ? 'cm-math cm-math-block' : 'cm-math', spec.cls));
  node.dataset.live = 'math';
  setHTML(node, mathHTML(spec.tex, spec.display));
  return node;
}

function drawNoteEmbed(doc, spec, hooks) {
  const node = make(doc, 'div', 'cm-note-embed');
  node.setAttribute('contenteditable', 'false');
  node.dataset.live = 'note-embed';
  node.dataset.wikilink = spec.target || '';
  node.dataset.heading = spec.heading || '';
  const result = spec.result;
  const title = make(doc, 'div', 'note-embed-title', result?.title || spec.label || spec.target || 'Note');
  title.dataset.live = 'note-embed-open';
  title.setAttribute('role', 'link');
  node.append(title);
  if (!result || result.status !== 'ok') {
    node.classList.add('is-missing');
    node.append(make(doc, 'p', 'note-embed-status', result?.message || 'Note not on this phone'));
    hooks.hydrate?.(node);
    return node;
  }
  const body = make(doc, 'div', 'note-embed-body');
  setHTML(body, renderMarkdown(result.body || ''));
  node.append(body);
  if (result.clipped) node.append(make(doc, 'p', 'note-embed-status', 'Open the note to see the rest'));
  hooks.hydrate?.(node);
  return node;
}

function drawProperties(doc, spec) {
  const node = make(doc, 'div', 'cm-properties');
  node.setAttribute('contenteditable', 'false');
  node.dataset.live = 'properties';
  node.append(make(doc, 'div', 'prop-head', 'Properties'));
  for (const [index, field] of (spec.fields || []).entries()) {
    const row = make(doc, 'div', 'prop-row');
    row.append(make(doc, 'div', 'prop-key', field.key));
    if (field.kind === 'bool') {
      const box = make(doc, 'span', 'task-toggle');
      box.dataset.live = 'prop-bool';
      box.dataset.prop = String(index);
      box.setAttribute('role', 'checkbox');
      box.setAttribute('aria-checked', field.value ? 'true' : 'false');
      box.setAttribute('aria-label', field.key);
      const mark = make(doc, 'span', 'task-box');
      if (field.value) mark.innerHTML = CHECK;
      box.append(mark);
      row.append(box);
    } else if (field.kind === 'raw') {
      row.append(make(doc, 'div', 'prop-value is-raw', String(field.raw || field.value || '')));
    } else {
      const value = make(doc, 'div', 'prop-value', field.kind === 'list' ? (field.value || []).join(', ') : String(field.value ?? ''));
      value.dataset.live = 'prop-value';
      value.dataset.prop = String(index);
      row.append(value);
    }
    node.append(row);
  }
  if (!(spec.fields || []).length) node.append(make(doc, 'p', 'prop-empty', 'No properties'));
  return node;
}

function drawFold(doc, spec) {
  const node = make(doc, 'span', spec.folded ? 'cm-fold is-folded' : 'cm-fold');
  node.dataset.live = 'fold';
  node.dataset.foldKey = spec.key || '';
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', spec.folded ? 'Unfold heading' : 'Fold heading');
  node.setAttribute('aria-expanded', spec.folded ? 'false' : 'true');
  return node;
}

function draw(spec, view, hooks) {
  const doc = view.dom.ownerDocument;
  if (spec.kind === 'bullet') {
    const node = make(doc, 'span', 'cm-bullet');
    node.setAttribute('aria-hidden', 'true');
    return node;
  }
  if (spec.kind === 'task') {
    const node = make(doc, 'span', 'task-toggle cm-task');
    node.dataset.live = 'task';
    node.setAttribute('role', 'checkbox');
    node.setAttribute('aria-checked', spec.checked ? 'true' : 'false');
    node.setAttribute('aria-label', spec.checked ? 'Mark not done' : 'Mark done');
    const box = make(doc, 'span', 'task-box');
    box.setAttribute('aria-hidden', 'true');
    if (spec.checked) box.innerHTML = CHECK;
    node.append(box);
    return node;
  }
  if (spec.kind === 'link') {
    if (!spec.href) return make(doc, 'span', classOf('cm-link-widget is-dead', spec.cls), spec.label);
    const node = make(doc, 'a', classOf('cm-link-widget', spec.cls), spec.label);
    node.setAttribute('href', spec.href);
    node.rel = 'noopener';
    node.dataset.live = 'link';
    return node;
  }
  if (spec.kind === 'wikilink') {
    const node = make(doc, 'span', classOf('wikilink', spec.cls), spec.label);
    node.dataset.live = 'wikilink';
    node.dataset.wikilink = spec.target;
    node.dataset.heading = spec.heading || '';
    node.setAttribute('role', 'link');
    return node;
  }
  if (spec.kind === 'image') return drawImage(doc, spec.image, view, hooks);
  if (spec.kind === 'rule') {
    const node = make(doc, 'span', 'cm-rule');
    node.setAttribute('aria-hidden', 'true');
    return node;
  }
  if (spec.kind === 'fence') return make(doc, 'span', 'cm-fence-label', spec.info);
  if (spec.kind === 'dataview') return drawDataview(doc, spec);
  if (spec.kind === 'table') return drawTable(doc, spec);
  if (spec.kind === 'callout') return drawCallout(doc, spec, hooks);
  if (spec.kind === 'math') return drawMath(doc, spec);
  if (spec.kind === 'note-embed') return drawNoteEmbed(doc, spec, hooks);
  if (spec.kind === 'properties') return drawProperties(doc, spec);
  if (spec.kind === 'fold') return drawFold(doc, spec);
  return make(doc, 'span');
}

function liveInner(target, root, event) {
  const origin = target?.nodeType === 1 ? target : target?.parentElement;
  let node = origin?.closest?.('[data-live]');
  if ((!node || node === root) && event) {
    const point = event.changedTouches?.[0] || event.touches?.[0] || event;
    const x = point.clientX;
    const y = point.clientY;
    if (typeof x === 'number' && typeof y === 'number') {
      node = root.ownerDocument.elementFromPoint(x, y)?.closest?.('[data-live]');
    }
  }
  if (!node || node === root || !root.contains(node)) return null;
  return node;
}

// Widgets are contenteditable=false, so iOS retargets taps onto the
// widget root. Handle them here instead of waiting for bubble to the
// editor content, which is how in-note checkboxes work.
function bindDataview(node, view, hooks) {
  let touch = null;
  let touchedAt = 0;
  const run = (inner, held) => {
    if (held) {
      try {
        const pos = view.posAtDOM(node);
        view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, pos + 1) } });
      } catch { /* the widget was redrawn */ }
      view.focus();
      return;
    }
    if (inner.dataset.live === 'dv-check') {
      const hint = taskHint(inner);
      if (hint) hooks.onDataviewToggle?.(hint);
      return;
    }
    if (inner.dataset.live === 'dv-open') {
      const hint = taskHint(inner);
      if (hint) hooks.onDataviewOpen?.(hint);
      return;
    }
    if (inner.dataset.live === 'dv-file') {
      hooks.onDataviewOpen?.({ path: inner.dataset.dvPath || '', line: 0, text: '' });
    }
  };
  node.addEventListener('touchstart', (event) => {
    const inner = event.touches.length === 1 ? liveInner(event.target, node, event) : null;
    const point = event.touches[0];
    touch = inner && point ? { inner, x: point.clientX, y: point.clientY, at: Date.now(), moved: false } : null;
  }, { passive: true });
  node.addEventListener('touchmove', (event) => {
    if (!touch) return;
    const point = event.touches[0];
    if (!point || Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > SLOP_PX) touch.moved = true;
  }, { passive: true });
  node.addEventListener('touchcancel', () => { touch = null; });
  node.addEventListener('touchend', (event) => {
    const started = touch;
    touch = null;
    if (!started || started.moved || !started.inner.isConnected) return;
    event.preventDefault();
    event.stopPropagation();
    touchedAt = Date.now();
    run(started.inner, Date.now() - started.at >= HOLD_MS);
  });
  node.addEventListener('mousedown', (event) => {
    const active = node.ownerDocument.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active !== event.target) {
      active.blur();
    }
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
    if (liveInner(event.target, node, event)) event.preventDefault();
  });
  node.addEventListener('click', (event) => {
    const inner = liveInner(event.target, node, event);
    if (!inner) return;
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() - touchedAt < 800) return;
    run(inner, false);
  });
}

function drawDataview(doc, spec) {
  const node = make(doc, 'div', 'cm-dataview');
  node.setAttribute('contenteditable', 'false');
  const result = spec.result;
  if (!result || result.supported === false) {
    node.classList.add('is-unsupported');
    const source = make(doc, 'pre', 'dv-source', spec.query || result?.query || '');
    const note = make(doc, 'p', 'dv-note', result?.message || 'Not supported in Core Sample yet');
    node.append(source, note);
    return node;
  }
  const groups = result.groups || [];
  if (!groups.length) {
    node.append(make(doc, 'p', 'dv-empty', 'No matching tasks'));
    return node;
  }
  for (const group of groups) {
    const heading = make(doc, 'div', 'dv-file', group.name || group.path || '');
    heading.dataset.live = 'dv-file';
    heading.dataset.dvPath = group.path || '';
    heading.setAttribute('role', 'link');
    node.append(heading);
    for (const task of group.tasks || []) {
      const row = make(doc, 'div', 'dv-task');
      if (task.depth) row.style.paddingLeft = `${task.depth * 22}px`;
      row.dataset.dvPath = task.path || '';
      row.dataset.dvLine = String(task.line ?? '');
      row.dataset.dvText = task.text || '';
      row.dataset.dvStatus = task.status || ' ';
      const box = make(doc, 'span', 'task-toggle');
      box.dataset.live = 'dv-check';
      box.setAttribute('role', 'checkbox');
      box.setAttribute('aria-checked', task.completed ? 'true' : 'false');
      box.setAttribute('aria-label', task.completed ? 'Mark not done' : 'Mark done');
      const mark = make(doc, 'span', 'task-box');
      mark.setAttribute('aria-hidden', 'true');
      if (task.completed) mark.innerHTML = CHECK;
      box.append(mark);
      const label = make(doc, 'span', 'dv-text', task.text || '');
      label.dataset.live = 'dv-open';
      if (task.completed) label.classList.add('cm-task-done');
      row.append(box, label);
      node.append(row);
    }
  }
  return node;
}

function taskHint(node) {
  const row = node?.closest?.('[data-dv-path][data-dv-line]');
  if (!row) return null;
  return {
    path: row.dataset.dvPath || '',
    line: Number(row.dataset.dvLine),
    text: row.dataset.dvText || '',
    status: row.dataset.dvStatus || ' ',
  };
}

function bindPointer(node, run) {
  let touch = null;
  node.addEventListener('touchstart', (event) => {
    const inner = event.touches.length === 1 ? liveInner(event.target, node, event) : null;
    const point = event.touches[0];
    touch = inner && point ? { inner, x: point.clientX, y: point.clientY, at: Date.now(), moved: false } : null;
  }, { passive: true });
  node.addEventListener('touchmove', (event) => {
    if (!touch) return;
    const point = event.touches[0];
    if (!point || Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > SLOP_PX) touch.moved = true;
  }, { passive: true });
  node.addEventListener('touchcancel', () => { touch = null; });
  node.addEventListener('touchend', (event) => {
    const started = touch;
    touch = null;
    if (!started || started.moved || !started.inner.isConnected) return;
    event.preventDefault();
    event.stopPropagation();
    run(started.inner, Date.now() - started.at >= HOLD_MS);
  });
  node.addEventListener('mousedown', (event) => {
    const active = node.ownerDocument.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active !== event.target) {
      active.blur();
    }
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
    if (liveInner(event.target, node, event)) event.preventDefault();
  });
  node.addEventListener('click', (event) => {
    const inner = liveInner(event.target, node, event);
    if (!inner) return;
    event.preventDefault();
    event.stopPropagation();
    run(inner, false);
  });
}

function bindTable(node, view, spec) {
  const startEdit = (cell) => {
    if (cell.querySelector('input') || view.state.readOnly) return;
    const input = cell.ownerDocument.createElement('input');
    input.className = 'table-cell-input';
    input.value = cell.textContent;
    input.setAttribute('aria-label', 'Table cell');
    cell.textContent = '';
    cell.append(input);
    input.focus();
    input.select();
    const commit = () => {
      if (!input.isConnected) return;
      const change = tableCellChange(spec.table, Number(cell.dataset.row), Number(cell.dataset.col), input.value);
      input.remove();
      if (!change || change.noop || view.state.readOnly) {
        cell.textContent = spec.table.rows[Number(cell.dataset.row)]?.cells[Number(cell.dataset.col)]?.text || '';
        return;
      }
      view.dispatch({ changes: { from: change.from, to: change.to, insert: change.insert }, userEvent: 'input.table' });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        input.value = spec.table.rows[Number(cell.dataset.row)]?.cells[Number(cell.dataset.col)]?.text || '';
        input.blur();
      }
    });
  };
  bindPointer(node, (inner, held) => {
    if (held) {
      try {
        const pos = view.posAtDOM(node);
        view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, pos + 1) } });
      } catch { /* redrawn */ }
      view.focus();
      return;
    }
    if (inner.dataset.live === 'table-cell') startEdit(inner);
  });
}

function bindProperties(node, view, spec) {
  const apply = (index, value) => {
    const field = spec.fields?.[index];
    const change = propertyChange(field, value);
    if (!change || change.noop || view.state.readOnly) return;
    view.dispatch({ changes: { from: change.from, to: change.to, insert: change.insert }, userEvent: 'input.frontmatter' });
  };
  const startEdit = (cell) => {
    if (cell.querySelector('input') || view.state.readOnly) return;
    const input = cell.ownerDocument.createElement('input');
    input.className = 'prop-input';
    input.value = cell.textContent;
    input.setAttribute('aria-label', spec.fields?.[Number(cell.dataset.prop)]?.key || 'Property');
    cell.textContent = '';
    cell.append(input);
    input.focus();
    input.select();
    const commit = () => {
      if (!input.isConnected) return;
      const value = input.value;
      input.remove();
      apply(Number(cell.dataset.prop), value);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        input.value = spec.fields?.[Number(cell.dataset.prop)]?.kind === 'list'
          ? (spec.fields[Number(cell.dataset.prop)].value || []).join(', ')
          : String(spec.fields?.[Number(cell.dataset.prop)]?.value ?? '');
        input.blur();
      }
    });
  };
  bindPointer(node, (inner, held) => {
    if (held) {
      try {
        const pos = view.posAtDOM(node);
        view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, pos + 1) } });
      } catch { /* redrawn */ }
      view.focus();
      return;
    }
    if (inner.dataset.live === 'prop-bool') {
      const field = spec.fields?.[Number(inner.dataset.prop)];
      apply(Number(inner.dataset.prop), !field?.value);
      return;
    }
    if (inner.dataset.live === 'prop-value') startEdit(inner);
  });
}

function bindCallout(node, view, spec) {
  bindPointer(node, (inner, held) => {
    if (held) {
      try {
        const pos = view.posAtDOM(node);
        view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, pos + 1) } });
      } catch { /* redrawn */ }
      view.focus();
      return;
    }
    if (inner.dataset.live !== 'callout-title' || !spec.callout?.fold || view.state.readOnly) return;
    const change = calloutFoldChange(spec.callout, spec.callout.fold === '-' ? '+' : '-');
    if (!change) return;
    view.dispatch({ changes: { from: change.from, to: change.to, insert: change.insert }, userEvent: 'input.callout' });
  });
}

function dataviewHeight(spec) {
  const result = spec.result;
  if (!result || result.supported === false) {
    const lines = String(spec.query || '').split('\n').length;
    return 52 + lines * 20;
  }
  const groups = result.groups || [];
  if (!groups.length) return 44;
  const tasks = groups.reduce((n, group) => n + (group.tasks || []).length, 0);
  return 12 + groups.length * 28 + tasks * 36;
}

class LiveWidget extends WidgetType {
  // `placement` is part of the key, so an image redraws (and retries a miss)
  // when the caret moves onto or off its line.
  constructor(spec, hooks, placement) {
    super();
    this.spec = spec;
    this.hooks = hooks;
    this.key = `${placement} ${JSON.stringify(spec)}`;
  }

  eq(other) {
    return other.key === this.key;
  }

  get estimatedHeight() {
    if (this.spec.kind === 'image') return 180;
    if (this.spec.kind === 'dataview') return dataviewHeight(this.spec);
    if (this.spec.kind === 'table') return tableHeight(this.spec.table);
    if (this.spec.kind === 'callout') return calloutHeight(this.spec.callout);
    if (this.spec.kind === 'note-embed') return 120;
    if (this.spec.kind === 'properties') return propertiesHeight(this.spec.fields);
    if (this.spec.kind === 'math' && this.spec.display) return 48;
    return -1;
  }

  toDOM(view) {
    const node = draw(this.spec, view, this.hooks);
    if (this.spec.kind === 'dataview') bindDataview(node, view, this.hooks);
    if (this.spec.kind === 'table') bindTable(node, view, this.spec);
    if (this.spec.kind === 'properties') bindProperties(node, view, this.spec);
    if (this.spec.kind === 'callout') bindCallout(node, view, this.spec);
    return node;
  }

  ignoreEvent() {
    return true;
  }
}

function runChange(view, spec, userEvent = 'input') {
  if (view.state.readOnly) return false;
  if (!spec) return false;
  if (spec.noop) return true;
  view.dispatch({
    changes: { from: spec.from, to: spec.to, insert: spec.insert },
    selection: { anchor: spec.selection.anchor, head: spec.selection.head ?? spec.selection.anchor },
    userEvent,
    scrollIntoView: true,
  });
  return true;
}

function enterCommand(view) {
  const { from, to } = view.state.selection.main;
  return runChange(view, continueEnter(view.state.doc.toString(), from, to));
}

function indentCommand(dir) {
  return (view) => {
    const { from, to } = view.state.selection.main;
    return runChange(view, indentChange(view.state.doc.toString(), from, to, dir));
  };
}

const hidden = Decoration.replace({});

function decorate(view, hooks, folds) {
  const ranges = view.hasFocus ? view.state.selection.ranges : [];
  const visible = view.visibleRanges;
  if (!visible.length) return Decoration.none;
  const from = visible[0].from;
  const to = visible[visible.length - 1].to;
  const out = [];
  for (const spec of liveSpecs(view.state, { ranges, from, to, folds })) {
    if (spec.type === 'line') {
      const opts = { class: spec.cls };
      if (spec.attrs) opts.attributes = spec.attrs;
      out.push(Decoration.line(opts).range(spec.at));
    }
    else if (spec.type === 'mark') out.push(Decoration.mark({ class: spec.cls }).range(spec.from, spec.to));
    else if (spec.type === 'hide') out.push(hidden.range(spec.from, spec.to));
    else if (spec.type === 'replace') {
      let widget = spec.widget;
      if (widget.kind === 'dataview') widget = { ...widget, result: hooks.dataview?.(widget.query, widget.lang) };
      if (widget.kind === 'note-embed') widget = { ...widget, result: hooks.noteEmbed?.(widget.target, widget.heading) };
      const block = spec.from !== spec.to && view.state.doc.sliceString(spec.from, spec.to).includes('\n');
      out.push(Decoration.replace({
        widget: new LiveWidget(widget, hooks, widget.kind === 'dataview' || widget.kind === 'table' || widget.kind === 'callout' || widget.kind === 'properties' || widget.kind === 'note-embed' ? 'block' : 'inline'),
        block,
      }).range(spec.from, spec.to));
    }
    else if (spec.type === 'widget') {
      let widget = spec.widget;
      if (widget.kind === 'note-embed') widget = { ...widget, result: hooks.noteEmbed?.(widget.target, widget.heading) };
      out.push(Decoration.widget({
        widget: new LiveWidget(widget, hooks, spec.side === -1 ? 'before' : 'after'),
        side: spec.side ?? 1,
      }).range(spec.at));
    }
  }
  return Decoration.set(out, true);
}

function livePlugin(hooks, live) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.tick = live.tick;
      this.decorations = decorate(view, hooks, live.folds);
    }

    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged
        || syntaxTree(update.startState) !== syntaxTree(update.state)
        || live.tick !== this.tick) {
        this.tick = live.tick;
        this.decorations = decorate(update.view, hooks, live.folds);
      }
    }
  }, { decorations: (plugin) => plugin.decorations });
}

// The smallest change from `before` to `after`, so a sync that rewrites the
// open note keeps the caret and scroll where the text did not change.
export function diffChange(before, after) {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}

// hooks: onChange(), onFocus(), onBlur(), onToggle(), onTap(plan, node, event), hydrate(node)
export function createLiveEditor(host, hooks = {}) {
  const editable = new Compartment();
  let quiet = false;
  const live = { tick: 0, folds: {} };

  const extensions = () => [
    EditorState.lineSeparator.of('\n'),
    markdownLanguage.extension,
    history(),
    keymap.of([
      { key: 'Enter', run: enterCommand },
      { key: 'Tab', run: indentCommand(1) },
      { key: 'Shift-Tab', run: indentCommand(-1) },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.lineWrapping,
    placeholder('Write in Markdown…'),
    EditorView.contentAttributes.of({
      'aria-label': 'Note',
      spellcheck: 'true',
      autocapitalize: 'sentences',
      autocorrect: 'on',
      autocomplete: 'off',
    }),
    editable.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
    livePlugin(hooks, live),
    EditorView.domEventHandlers({
      paste(event) {
        const list = event.clipboardData && event.clipboardData.files;
        if (!list || !list.length) return false;
        const images = [...list].filter((file) => file.type && file.type.startsWith('image/'));
        if (!images.length) return false;
        event.preventDefault();
        hooks.onPasteFiles?.(images);
        return true;
      },
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !quiet) hooks.onChange?.();
      if (update.focusChanged) {
        if (update.view.hasFocus) hooks.onFocus?.();
        else hooks.onBlur?.();
      }
    }),
  ];

  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: '', extensions: extensions() }),
  });
  let readOnly = false;

  function setText(text) {
    const change = diffChange(view.state.doc.toString(), String(text ?? ''));
    if (!change) return;
    quiet = true;
    try {
      view.dispatch({ changes: change });
    } finally {
      quiet = false;
    }
  }

  function load(text) {
    view.setState(EditorState.create({ doc: String(text ?? ''), extensions: extensions() }));
    if (readOnly) setReadOnly(true);
    view.scrollDOM.scrollTop = 0;
  }

  function setReadOnly(value) {
    readOnly = Boolean(value);
    view.dispatch({
      effects: editable.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }

  function select(anchor, head = anchor) {
    const max = view.state.doc.length;
    const clamp = (n) => Math.max(0, Math.min(max, Number(n) || 0));
    view.dispatch({ selection: { anchor: clamp(anchor), head: clamp(head) } });
  }

  function toggleTask(node) {
    if (view.state.readOnly) return;
    const change = taskToggle(view.state, view.posAtDOM(node));
    if (!change) return;
    view.dispatch({ changes: change, userEvent: 'input.toggle' });
    hooks.onToggle?.();
  }

  function editAt(node) {
    const pos = view.posAtDOM(node);
    select(Math.min(view.state.doc.length, pos + 1));
    view.focus();
  }

  function act(node, target, event, held) {
    if (held) {
      editAt(node);
      return;
    }
    if (node.dataset.live === 'task') {
      toggleTask(node);
      return;
    }
    if (node.dataset.live === 'dv-check') {
      const hint = taskHint(node);
      if (hint) hooks.onDataviewToggle?.(hint);
      return;
    }
    if (node.dataset.live === 'dv-open') {
      const hint = taskHint(node);
      if (hint) hooks.onDataviewOpen?.(hint);
      return;
    }
    if (node.dataset.live === 'dv-file') {
      hooks.onDataviewOpen?.({ path: node.dataset.dvPath || '', line: 0, text: '' });
      return;
    }
    if (node.dataset.live === 'fold') {
      hooks.onFold?.(node.dataset.foldKey || '');
      return;
    }
    if (node.dataset.live === 'math' || node.dataset.live === 'callout' || node.dataset.live === 'table' || node.dataset.live === 'properties') {
      editAt(node);
      return;
    }
    if (node.dataset.live === 'note-embed' || node.dataset.live === 'note-embed-open') {
      const embed = node.closest('[data-live="note-embed"]') || node;
      hooks.onTap?.(planPreviewClick(embed), embed, event);
      return;
    }
    hooks.onTap?.(planPreviewClick(target), node, event);
  }

  function island(target) {
    const origin = target?.nodeType === 1 ? target : target?.parentElement;
    const node = origin?.closest?.('[data-live]');
    return node && view.contentDOM.contains(node) ? node : null;
  }

  // A tap on a link, checkbox or image is handled on touchend with
  // preventDefault, so iOS neither moves the caret nor raises the keyboard.
  // A long press puts the caret inside it instead, to edit the syntax.
  let touch = null;
  let touchedAt = 0;
  const content = view.contentDOM;
  content.addEventListener('touchstart', (event) => {
    const node = event.touches.length === 1 ? island(event.target) : null;
    const point = event.touches[0];
    touch = node ? { node, target: event.target, x: point.clientX, y: point.clientY, at: Date.now(), moved: false } : null;
  }, { passive: true });
  content.addEventListener('touchmove', (event) => {
    if (!touch) return;
    const point = event.touches[0];
    if (!point || Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > SLOP_PX) touch.moved = true;
  }, { passive: true });
  content.addEventListener('touchcancel', () => { touch = null; });
  content.addEventListener('touchend', (event) => {
    const started = touch;
    touch = null;
    if (!started || started.moved || !started.node.isConnected) return;
    event.preventDefault();
    touchedAt = Date.now();
    act(started.node, started.target, event, Date.now() - started.at >= HOLD_MS);
  });
  content.addEventListener('mousedown', (event) => {
    const active = content.ownerDocument.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active !== event.target) {
      active.blur();
    }
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
    if (island(event.target)) event.preventDefault();
  });
  content.addEventListener('click', (event) => {
    const node = island(event.target);
    if (!node) return;
    event.preventDefault();
    if (Date.now() - touchedAt < 800) return;
    act(node, event.target, event, false);
  });

  return {
    view,
    load,
    get value() {
      return view.state.doc.toString();
    },
    set value(text) {
      setText(text);
    },
    get selectionStart() {
      return view.state.selection.main.from;
    },
    set selectionStart(n) {
      select(n, Math.max(n, view.state.selection.main.to));
    },
    get selectionEnd() {
      return view.state.selection.main.to;
    },
    set selectionEnd(n) {
      select(view.state.selection.main.from, n);
    },
    get scrollTop() {
      return view.scrollDOM.scrollTop;
    },
    set scrollTop(n) {
      view.scrollDOM.scrollTop = n;
    },
    get readOnly() {
      return readOnly;
    },
    set readOnly(value) {
      setReadOnly(value);
    },
    get scrollEl() {
      return view.scrollDOM;
    },
    focus() {
      view.focus();
    },
    blur() {
      view.contentDOM.blur();
    },
    hasFocus() {
      return view.hasFocus;
    },
    format(action) {
      if (action === 'undo') return undo(view);
      if (action === 'redo') return redo(view);
      const { from, to } = view.state.selection.main;
      return runChange(view, formatChange(view.state.doc.toString(), from, to, action), 'input.format');
    },
    insert(text) {
      if (view.state.readOnly) return false;
      const value = String(text ?? '');
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: value },
        selection: { anchor: from + value.length },
        userEvent: 'input.paste',
      });
      return true;
    },
    measure() {
      view.requestMeasure();
    },
    scrollToPos(pos) {
      view.dispatch({ effects: EditorView.scrollIntoView(Math.max(0, Math.min(view.state.doc.length, pos)), { y: 'start', yMargin: 12 }) });
    },
    scrollToLine(line) {
      const n = Number(line);
      if (!Number.isInteger(n) || n < 0) return;
      const number = Math.min(view.state.doc.lines, n + 1);
      const at = view.state.doc.line(number).from;
      view.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 12 }) });
    },
    replaceText(text) {
      const change = diffChange(view.state.doc.toString(), String(text ?? ''));
      if (!change) return false;
      view.dispatch({ changes: change, userEvent: 'input.toggle' });
      return true;
    },
    refreshDataview() {
      live.tick += 1;
      view.dispatch({});
    },
    setFolds(next) {
      live.folds = next && typeof next === 'object' ? next : {};
      live.tick += 1;
      view.dispatch({});
    },
    posOf(node) {
      try {
        return view.posAtDOM(node);
      } catch {
        return -1;
      }
    },
    // Every image in the note, drawn or not, in document order.
    images() {
      ensureSyntaxTree(view.state, view.state.doc.length, 200);
      return liveSpecs(view.state, { ranges: [] })
        .filter((spec) => spec.type === 'replace' && spec.widget.kind === 'image')
        .map((spec) => ({ from: spec.from, to: spec.to, image: spec.widget.image }));
    },
    embedNodes() {
      return [...view.contentDOM.querySelectorAll('.embed')];
    },
    contains(node) {
      return view.dom.contains(node);
    },
  };
}

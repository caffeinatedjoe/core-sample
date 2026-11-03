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
  syntaxTree,
} from '../vendor/codemirror.js';
import { basename } from './embeds.js';
import { liveSpecs, markdownLanguage, taskToggle } from './live-rules.js';
import { planPreviewClick } from './preview-tap.js';

const CHECK = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 6.2 4.6 9 10 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const HOLD_MS = 450;
const SLOP_PX = 10;

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
    if (!spec.href) return make(doc, 'span', 'cm-link-widget is-dead', spec.label);
    const node = make(doc, 'a', 'cm-link-widget', spec.label);
    node.setAttribute('href', spec.href);
    node.rel = 'noopener';
    node.dataset.live = 'link';
    return node;
  }
  if (spec.kind === 'wikilink') {
    const node = make(doc, 'span', 'wikilink', spec.label);
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
  return make(doc, 'span');
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
    return this.spec.kind === 'image' ? 180 : -1;
  }

  toDOM(view) {
    return draw(this.spec, view, this.hooks);
  }

  ignoreEvent() {
    return true;
  }
}

const hidden = Decoration.replace({});

function decorate(view, hooks) {
  const ranges = view.hasFocus ? view.state.selection.ranges : [];
  const visible = view.visibleRanges;
  if (!visible.length) return Decoration.none;
  const from = visible[0].from;
  const to = visible[visible.length - 1].to;
  const out = [];
  for (const spec of liveSpecs(view.state, { ranges, from, to })) {
    if (spec.type === 'line') {
      const opts = { class: spec.cls };
      if (spec.attrs) opts.attributes = spec.attrs;
      out.push(Decoration.line(opts).range(spec.at));
    }
    else if (spec.type === 'mark') out.push(Decoration.mark({ class: spec.cls }).range(spec.from, spec.to));
    else if (spec.type === 'hide') out.push(hidden.range(spec.from, spec.to));
    else if (spec.type === 'replace') out.push(Decoration.replace({ widget: new LiveWidget(spec.widget, hooks, 'inline') }).range(spec.from, spec.to));
    else if (spec.type === 'widget') out.push(Decoration.widget({ widget: new LiveWidget(spec.widget, hooks, 'after'), side: 1 }).range(spec.at));
  }
  return Decoration.set(out, true);
}

function livePlugin(hooks) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = decorate(view, hooks);
    }

    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged
        || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = decorate(update.view, hooks);
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

// hooks: onChange(), onBlur(), onToggle(), onTap(plan, node, event), hydrate(node)
export function createLiveEditor(host, hooks = {}) {
  const editable = new Compartment();
  let quiet = false;

  const extensions = () => [
    EditorState.lineSeparator.of('\n'),
    markdownLanguage.extension,
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
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
    livePlugin(hooks),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !quiet) hooks.onChange?.();
      if (update.focusChanged && !update.view.hasFocus) hooks.onBlur?.();
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
    measure() {
      view.requestMeasure();
    },
    scrollToPos(pos) {
      view.dispatch({ effects: EditorView.scrollIntoView(Math.max(0, Math.min(view.state.doc.length, pos)), { y: 'start', yMargin: 12 }) });
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

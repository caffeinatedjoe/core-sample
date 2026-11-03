import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, ensureSyntaxTree } from '../app/vendor/codemirror.js';
import { headingOffset, liveSpecs, markdownLanguage, taskToggle } from '../app/js/live-rules.js';

function stateOf(doc) {
  const state = EditorState.create({ doc, extensions: [EditorState.lineSeparator.of('\n'), markdownLanguage.extension] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

function widgetText(widget) {
  if (widget.kind === 'bullet') return '•';
  if (widget.kind === 'task') return widget.checked ? '☑' : '☐';
  if (widget.kind === 'rule') return '⎯';
  if (widget.kind === 'fence') return `⟨code ${widget.info}⟩`;
  if (widget.kind === 'link') return `⟨link ${widget.label}→${widget.href}⟩`;
  if (widget.kind === 'wikilink') return `⟨wiki ${widget.label}→${widget.target}${widget.heading ? `#${widget.heading}` : ''}⟩`;
  if (widget.kind === 'image') return `⟨img ${widget.image.kind} ${widget.image.embed || widget.image.src || widget.image.name}⟩`;
  return '?';
}

// What the reader sees: hidden syntax removed, widgets drawn as tokens.
function visible(doc, cursor = null) {
  const state = stateOf(doc);
  const ranges = cursor === null ? [] : [{ from: cursor, to: cursor }];
  const specs = liveSpecs(state, { ranges });
  let out = '';
  let at = 0;
  const covering = specs.filter((s) => s.type === 'hide' || s.type === 'replace' || s.type === 'widget')
    .sort((a, b) => (a.from ?? a.at) - (b.from ?? b.at));
  for (const spec of covering) {
    const start = spec.from ?? spec.at;
    out += doc.slice(at, start);
    if (spec.type === 'widget') {
      out += widgetText(spec.widget);
      at = start;
      continue;
    }
    if (spec.type === 'replace') out += widgetText(spec.widget);
    at = spec.to;
  }
  return out + doc.slice(at);
}

function specsOf(doc, cursor = null) {
  const state = stateOf(doc);
  return liveSpecs(state, { ranges: cursor === null ? [] : [{ from: cursor, to: cursor }] });
}

test('headings hide their marks off the line and show them on it, with the same line class', () => {
  const doc = 'intro\n## Plan ##\nbody';
  assert.equal(visible(doc), 'intro\nPlan\nbody');
  assert.equal(visible(doc, doc.indexOf('Plan')), doc);
  for (const cursor of [null, doc.indexOf('Plan')]) {
    const line = specsOf(doc, cursor).find((s) => s.type === 'line');
    assert.deepEqual(line, { type: 'line', at: 6, cls: 'cm-heading cm-h2' });
  }
});

test('bold, italic, strike and inline code reveal per span', () => {
  const doc = 'a **bold** b *it* c ~~gone~~ d `code`';
  assert.equal(visible(doc), 'a bold b it c gone d code');
  assert.equal(visible(doc, doc.indexOf('bold') + 1), 'a **bold** b it c gone d code');
  assert.equal(visible(doc, doc.indexOf('it*')), 'a bold b *it* c gone d code');
  assert.equal(visible(doc, doc.indexOf('code') + 2), 'a bold b it c gone d `code`');
  const styles = specsOf(doc).filter((s) => s.type === 'mark').map((s) => s.cls);
  assert.deepEqual(styles, ['cm-strong', 'cm-em', 'cm-strike', 'cm-inline-code']);
});

test('a cursor at the edge of a span still reveals it', () => {
  const doc = 'x **b** y';
  assert.equal(visible(doc, doc.indexOf('**')), doc);
  assert.equal(visible(doc, doc.indexOf(' y')), doc);
  assert.equal(visible(doc, doc.length), 'x b y');
});

test('links render as their label and reveal per span; unsafe URLs get no href', () => {
  const doc = 'see [the **site**](https://example.com) and [bad](javascript:alert(1)) end';
  assert.equal(visible(doc), 'see ⟨link the site→https://example.com⟩ and ⟨link bad→⟩ end');
  const inside = visible(doc, doc.indexOf('site'));
  assert.ok(inside.startsWith('see [the **site**](https://example.com) and'));
});

test('reference-style brackets without a URL stay as text', () => {
  assert.equal(visible('a [ref] b'), 'a [ref] b');
});

test('wiki-links render as their alias or target and reveal per span', () => {
  const doc = 'go [[Projects/Plan|the plan]] or [[Inbox#Today]] now';
  assert.equal(visible(doc), 'go ⟨wiki the plan→Projects/Plan⟩ or ⟨wiki Today→Inbox#Today⟩ now');
  assert.equal(visible(doc, doc.indexOf('plan]]')), 'go [[Projects/Plan|the plan]] or ⟨wiki Today→Inbox#Today⟩ now');
});

test('a note embed keeps the bang and shows a wiki-link chip, as the old preview did', () => {
  assert.equal(visible('![[Other note]]'), '!⟨wiki Other note→Other note⟩');
});

test('bullets become dots unless the cursor touches the marker; ordered numbers stay', () => {
  const doc = '- one\n  - two\n1. first';
  assert.equal(visible(doc), '• one\n  • two\n1. first');
  assert.equal(visible(doc, 0), '- one\n  • two\n1. first');
  assert.equal(visible(doc, doc.indexOf('one') + 2), '• one\n  • two\n1. first');
  assert.ok(specsOf(doc).some((s) => s.type === 'mark' && s.cls === 'cm-list-number'));
});

test('tasks become checkboxes; the marker shows when the selection touches it', () => {
  const doc = '- [ ] open\n\t- [x] done';
  assert.equal(visible(doc), '☐ open\n\t☑ done');
  assert.equal(visible(doc, 3), '- [ ] open\n\t☑ done');
  assert.equal(visible(doc, doc.indexOf('open') + 2), '☐ open\n\t☑ done');
  const done = specsOf(doc).find((s) => s.cls === 'cm-task-done');
  assert.equal(doc.slice(done.from, done.to), ' done');
});

test('list and task lines hang by their source indent', () => {
  const doc = '- one\n    - two\n- [ ] task\n\t- [x] done';
  const lines = specsOf(doc).filter((s) => s.type === 'line');
  const lists = lines.filter((s) => s.cls.includes('cm-list-line') && !s.cls.includes('cm-task-line'));
  const tasks = lines.filter((s) => s.cls.includes('cm-task-line'));
  assert.equal(lists[0].attrs.style, '--list-hang:0ch');
  assert.equal(lists[1].attrs.style, '--list-hang:4ch');
  assert.equal(tasks[0].attrs.style, '--list-hang:0ch');
  assert.equal(tasks[1].attrs.style, '--list-hang:4ch');
});

test('quotes hide the marker off the line', () => {
  const doc = '> quoted *it*\n> second';
  assert.equal(visible(doc), 'quoted it\nsecond');
  assert.equal(visible(doc, 2), '> quoted it\nsecond');
  assert.equal(visible(doc, doc.indexOf('it*')), '> quoted *it*\nsecond');
  assert.equal(specsOf(doc).filter((s) => s.type === 'line' && s.cls === 'cm-quote').length, 2);
});

test('rules draw a line off the line', () => {
  assert.equal(visible('a\n\n---\nb'), 'a\n\n⎯\nb');
  assert.equal(visible('a\n\n---\nb', 4), 'a\n\n---\nb');
});

test('code fences hide per block and nothing inside a fence renders', () => {
  const doc = 'top\n```js\n**not bold** [[not]] - [ ] no\n```\nend';
  assert.equal(visible(doc), 'top\n⟨code js⟩\n**not bold** [[not]] - [ ] no\n\nend');
  assert.equal(visible(doc, doc.indexOf('not bold')), doc);
  const lines = specsOf(doc).filter((s) => s.type === 'line').map((s) => s.cls);
  assert.deepEqual(lines, ['cm-code-block cm-code-first', 'cm-code-block', 'cm-code-block cm-code-last']);
});

test('inline code protects wiki-links and images inside it', () => {
  assert.equal(visible('`[[x]] ![[y.png]]` z'), '[[x]] ![[y.png]] z');
});

test('images render in place off the line and below their source on it', () => {
  const doc = 'text\n![[photo.png|300]]\n![alt](img/a.jpg) ![r](https://example.com/r.png)';
  assert.equal(visible(doc), 'text\n⟨img embed photo.png⟩\n⟨img embed img/a.jpg⟩ ⟨img remote https://example.com/r.png⟩');
  const on = visible(doc, doc.indexOf('photo'));
  assert.equal(on, 'text\n![[photo.png|300]]⟨img embed photo.png⟩\n⟨img embed img/a.jpg⟩ ⟨img remote https://example.com/r.png⟩');
  const image = specsOf(doc).find((s) => s.widget?.kind === 'image');
  assert.equal(image.widget.image.width, 300);
});

test('frontmatter is a muted block with no other rendering', () => {
  const doc = '---\ntitle: **x**\ntags: [a]\n---\n# Body';
  assert.equal(visible(doc), '---\ntitle: **x**\ntags: [a]\n---\nBody');
  const fm = specsOf(doc).filter((s) => s.cls === 'cm-frontmatter');
  assert.equal(fm.length, 4);
});

test('with no active ranges the whole note renders, so an unfocused editor reads like the old preview', () => {
  const doc = '# T\n- [ ] a **b** [[c]]';
  assert.equal(visible(doc), 'T\n☐ a b ⟨wiki c→c⟩');
});

test('specs never overlap where they hide or replace text', () => {
  const doc = '# **[x](https://a.b)** [[y]]\n- [ ] ![[p.png]] ~~[[z]]~~\n> - `a` *b*';
  for (const cursor of [null, 0, 5, doc.indexOf('p.png'), doc.length]) {
    const covering = specsOf(doc, cursor).filter((s) => s.type === 'hide' || s.type === 'replace');
    for (let i = 1; i < covering.length; i += 1) assert.ok(covering[i].from >= covering[i - 1].to, JSON.stringify(covering));
  }
});

test('taskToggle flips one mark character and ignores tasks inside code', () => {
  const state = stateOf('- [ ] a\n```\n- [ ] b\n```\n* [X] c');
  assert.deepEqual(taskToggle(state, 1), { from: 3, to: 4, insert: 'x' });
  assert.equal(taskToggle(state, state.doc.line(3).from), null);
  assert.deepEqual(taskToggle(state, state.doc.line(5).from), { from: state.doc.line(5).from + 3, to: state.doc.line(5).from + 4, insert: ' ' });
  assert.equal(taskToggle(state, state.doc.line(2).from), null);
});

test('headingOffset finds the heading line, skipping fences', () => {
  const text = '```\n# Fake\n```\n## Real one ##\n';
  assert.equal(headingOffset(text, 'real one'), text.indexOf('## Real'));
  assert.equal(headingOffset(text, 'fake'), -1);
});

test('CRLF notes render tasks and headings, and the text keeps every \\r', () => {
  const doc = '# Head\r\n- [ ] task\r\n- [x] done\r\nend';
  assert.equal(visible(doc), 'Head\r\n☐ task\r\n☑ done\r\nend');
  const state = stateOf(doc);
  const change = taskToggle(state, state.doc.line(2).from);
  assert.deepEqual(change, { from: 11, to: 12, insert: 'x' });
  assert.equal(headingOffset(doc, 'head'), 0);
});

test('edits round-trip byte for byte: CRLF, tabs, trailing spaces and unicode survive', () => {
  const original = '# Plan \t\r\n\r\n- [ ] one  \r\n\t- [x] two\t\r\n```js\r\n  x = 1;   \r\n```\r\n日本語 🌧️ [[Note|alias]] ![[a.png|200]]\n\nno newline at end   ';
  let state = EditorState.create({ doc: original, extensions: [EditorState.lineSeparator.of('\n'), markdownLanguage.extension] });
  assert.equal(state.doc.toString(), original);
  for (const cursor of [null, 0, 5, 20, original.length]) liveSpecs(stateOf(original), { ranges: cursor === null ? [] : [{ from: cursor, to: cursor }] });
  assert.equal(state.doc.toString(), original, 'drawing never edits the text');
  const at = original.indexOf('one') + 3;
  state = state.update({ changes: { from: at, insert: '!' } }).state;
  assert.equal(state.doc.toString(), `${original.slice(0, at)}!${original.slice(at)}`);
  const toggle = taskToggle(state, state.doc.lineAt(at).from);
  state = state.update({ changes: toggle }).state;
  const expected = `${original.slice(0, at)}!${original.slice(at)}`.replace('- [ ] one', '- [x] one');
  assert.equal(state.doc.toString(), expected);
  state = state.update({ changes: taskToggle(state, state.doc.lineAt(at).from) }).state;
  assert.equal(state.doc.toString(), `${original.slice(0, at)}!${original.slice(at)}`);
});

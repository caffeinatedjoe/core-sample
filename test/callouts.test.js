import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, ensureSyntaxTree } from '../app/vendor/codemirror.js';
import { calloutFoldChange, parseCallout, parseCalloutLine } from '../app/js/callouts.js';
import { liveSpecs, markdownLanguage } from '../app/js/live-rules.js';

function stateOf(doc) {
  const state = EditorState.create({ doc, extensions: [EditorState.lineSeparator.of('\n'), markdownLanguage.extension] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

test('parseCalloutLine reads type, fold mark, and title', () => {
  assert.deepEqual(parseCalloutLine('> [!warning] Watch the kiln'), {
    type: 'warning',
    kind: 'warning',
    fold: '',
    title: 'Watch the kiln',
    customTitle: true,
  });
  assert.equal(parseCalloutLine('> [!TIP]-').title, 'Tip');
  assert.equal(parseCalloutLine('> [!TIP]-').fold, '-');
  assert.equal(parseCalloutLine('> just a quote'), null);
});

test('parseCallout keeps body text without quote marks', () => {
  const source = '> [!note]\n> Keep **dry**\n> second';
  const parsed = parseCallout(source, 0);
  assert.equal(parsed.kind, 'note');
  assert.equal(parsed.body, 'Keep **dry**\nsecond');
});

test('calloutFoldChange flips only the + / - mark', () => {
  const source = '> [!note]- Title\n> body';
  const parsed = parseCallout(source, 0);
  const change = calloutFoldChange(parsed, '+');
  const next = source.slice(0, change.from) + change.insert + source.slice(change.to);
  assert.equal(next, '> [!note]+ Title\n> body');
});

test('Live Preview replaces a callout off the caret and shows source on it', () => {
  const doc = 'top\n> [!warning] Heat\n> gloves on\nend';
  const off = liveSpecs(stateOf(doc), { ranges: [] });
  const widget = off.find((spec) => spec.widget?.kind === 'callout');
  assert.equal(widget.widget.callout.kind, 'warning');
  assert.equal(widget.widget.callout.title, 'Heat');
  const on = liveSpecs(stateOf(doc), { ranges: [{ from: doc.indexOf('gloves'), to: doc.indexOf('gloves') }] });
  assert.equal(on.some((spec) => spec.widget?.kind === 'callout'), false);
});

test('drawing a callout never edits CRLF source', () => {
  const original = '> [!note]\r\n> line  \r\n';
  const state = stateOf(original);
  liveSpecs(state, { ranges: [] });
  assert.equal(state.doc.toString(), original);
});

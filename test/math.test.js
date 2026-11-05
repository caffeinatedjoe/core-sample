import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, ensureSyntaxTree } from '../app/vendor/codemirror.js';
import { liveSpecs, markdownLanguage } from '../app/js/live-rules.js';
import { findMath, texToMathML } from '../app/js/math.js';

function stateOf(doc) {
  const state = EditorState.create({ doc, extensions: [EditorState.lineSeparator.of('\n'), markdownLanguage.extension] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

test('findMath skips $10 and escaped dollars', () => {
  const found = findMath('costs $10 and \\$x$ and $a+b$');
  assert.equal(found.length, 1);
  assert.equal(found[0].tex, 'a+b');
  assert.equal(found[0].display, false);
});

test('findMath reads display math across lines', () => {
  const found = findMath('before\n$$\n\\frac{1}{2}\n$$\nafter');
  assert.equal(found.length, 1);
  assert.equal(found[0].display, true);
  assert.match(found[0].tex, /\\frac\{1\}\{2\}/);
});

test('texToMathML covers fractions, scripts, and greek', () => {
  const html = texToMathML('\\frac{a}{b} + x^2_i + \\alpha');
  assert.match(html, /<math /);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<msubsup>/);
  assert.match(html, /α/);
  assert.equal(html.includes('<script'), false);
});

test('unsupported TeX falls back instead of throwing', () => {
  assert.equal(texToMathML('\\frac{'), '');
});

test('Live Preview replaces math off the caret and shows source on it', () => {
  const doc = 'area $x^2$ done';
  const off = liveSpecs(stateOf(doc), { ranges: [] });
  const widget = off.find((spec) => spec.widget?.kind === 'math');
  assert.equal(widget.widget.tex, 'x^2');
  const on = liveSpecs(stateOf(doc), { ranges: [{ from: doc.indexOf('x^2'), to: doc.indexOf('x^2') }] });
  assert.ok(on.some((spec) => spec.cls === 'cm-math-source'));
  assert.equal(on.some((spec) => spec.widget?.kind === 'math'), false);
});

test('math inside a fence stays source', () => {
  const doc = '```\n$x$\n```';
  const specs = liveSpecs(stateOf(doc), { ranges: [] });
  assert.equal(specs.some((spec) => spec.widget?.kind === 'math'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, ensureSyntaxTree } from '../app/vendor/codemirror.js';
import { highlightCode, languageOf } from '../app/js/code-highlight.js';
import { liveSpecs, markdownLanguage } from '../app/js/live-rules.js';

function stateOf(doc) {
  const state = EditorState.create({ doc, extensions: [EditorState.lineSeparator.of('\n'), markdownLanguage.extension] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

test('language aliases collapse to a small set', () => {
  assert.equal(languageOf('JavaScript'), 'js');
  assert.equal(languageOf('python extra'), 'py');
  assert.equal(languageOf('nope'), '');
});

test('highlightCode marks keywords, strings, and comments', () => {
  const tokens = highlightCode('const x = "hi"; // z', 'js');
  const kinds = tokens.map((tok) => tok.cls);
  assert.ok(kinds.includes('cm-tok-keyword'));
  assert.ok(kinds.includes('cm-tok-string'));
  assert.ok(kinds.includes('cm-tok-comment'));
});

test('unknown languages stay plain', () => {
  assert.deepEqual(highlightCode('fun x = 1', 'elm'), []);
});

test('Live Preview paints token marks inside a js fence', () => {
  const doc = '```js\nconst x = 1;\n```';
  const marks = liveSpecs(stateOf(doc), { ranges: [] }).filter((spec) => spec.type === 'mark' && spec.cls.startsWith('cm-tok-'));
  assert.ok(marks.some((spec) => spec.cls === 'cm-tok-keyword'));
  assert.equal(stateOf(doc).doc.toString(), doc);
});

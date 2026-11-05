import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, ensureSyntaxTree } from '../app/vendor/codemirror.js';
import { foldedRanges, headingSections, rememberFolds, toggleFold } from '../app/js/fold.js';
import { liveSpecs, markdownLanguage } from '../app/js/live-rules.js';

function stateOf(doc) {
  const state = EditorState.create({ doc, extensions: [EditorState.lineSeparator.of('\n'), markdownLanguage.extension] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

test('headingSections ends a fold at the next same or higher heading', () => {
  const doc = '# A\nbody\n## B\nmore\n# C\nend';
  const sections = headingSections(stateOf(doc).doc);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].key, 'h1:a');
  assert.equal(doc.slice(sections[0].from, sections[0].to), '# A\nbody\n## B\nmore\n');
  assert.equal(doc.slice(sections[1].from, sections[1].to), '## B\nmore\n');
});

test('foldedRanges hide the body and leave the heading line', () => {
  const state = stateOf('# A\nsecret\n# B\n');
  const hidden = foldedRanges(headingSections(state.doc), { 'h1:a': true });
  assert.equal(hidden.length, 1);
  assert.equal(state.doc.sliceString(hidden[0].from, hidden[0].to).startsWith('\nsecret'), true);
});

test('Live Preview hides a folded body and keeps a fold control on the heading', () => {
  const doc = '# Plan\nsteps\n# Next\n';
  const specs = liveSpecs(stateOf(doc), { ranges: [], folds: { 'h1:plan': true } });
  assert.ok(specs.some((spec) => spec.widget?.kind === 'fold' && spec.widget.folded));
  assert.ok(specs.some((spec) => spec.type === 'hide' && spec.from === doc.indexOf('steps')));
  const open = liveSpecs(stateOf(doc), { ranges: [{ from: doc.indexOf('steps'), to: doc.indexOf('steps') }], folds: { 'h1:plan': true } });
  assert.equal(open.some((spec) => spec.type === 'hide' && spec.from === doc.indexOf('steps')), false);
});

test('fold maps persist per path and drop empty notes', () => {
  let folds = toggleFold({}, 'h2:lab');
  assert.equal(folds['h2:lab'], true);
  folds = toggleFold(folds, 'h2:lab');
  assert.equal(folds['h2:lab'], undefined);
  const all = rememberFolds({ 'Other.md': { 'h1:x': true } }, 'Lab.md', { 'h2:lab': true });
  assert.equal(all['Lab.md']['h2:lab'], true);
  assert.equal(rememberFolds(all, 'Lab.md', {}).hasOwnProperty('Lab.md'), false);
});

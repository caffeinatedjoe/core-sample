import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState, EditorView, history, undo } from '../app/vendor/codemirror.js';
import {
  MARKER_GUARD,
  parseComments,
  reply,
  setStatus,
} from '../app/js/comments.js';
import { commentEditor } from '../app/js/live-editor.js';
import { markdownLanguage } from '../app/js/live-rules.js';

const README = [
  'We should <!--c:k3f9-->ship on Friday<!--/c:k3f9--> regardless of the QA timeline.',
  '<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship on Friday"',
  'kyle (2026-06-17T10:00:00.000Z): I thought we agreed Thursday?',
  'sam (2026-06-17T10:05:00.000Z): Thursday is better for QA.',
  '-->',
].join('\n');

function stateOf(doc, { showResolved = false } = {}) {
  return EditorState.create({
    doc,
    extensions: [
      EditorState.lineSeparator.of('\n'),
      markdownLanguage.extension,
      history(),
      ...commentEditor({ tick: 0, folds: {}, showResolved }),
    ],
  });
}

function apply(state, spec) {
  return state.update(spec).state;
}

function deleteAt(state, from, to, userEvent) {
  return apply(state, { changes: { from, to, insert: '' }, userEvent });
}

test('Backspace and Delete at each marker edge keep the comment whole', () => {
  const comment = parseComments(README)[0];
  const points = [
    comment.open.from,
    comment.open.from + 1,
    comment.open.to - 1,
    comment.open.to,
    comment.close.from,
    comment.close.from + 1,
    comment.close.to - 1,
    comment.close.to,
    comment.body.from,
    comment.body.from + 1,
    comment.body.to - 1,
    comment.body.to,
  ];
  for (const at of points) {
    let state = stateOf(README);
    state = deleteAt(state, Math.max(0, at - 1), at, 'delete.backward');
    assert.equal(state.doc.toString().includes('<!--c:k3f9-->'), true, `backspace at ${at}`);
    assert.equal(state.doc.toString().includes('<!--co:k3f9'), true, `backspace body at ${at}`);
    state = stateOf(README);
    state = deleteAt(state, at, Math.min(README.length, at + 1), 'delete.forward');
    assert.equal(state.doc.toString().includes('<!--c:k3f9-->'), true, `delete at ${at}`);
    assert.equal(state.doc.toString().includes('<!--co:k3f9'), true, `delete body at ${at}`);
  }
});

test('forward-delete at the end of a commented line does not eat the block', () => {
  const lineEnd = README.indexOf('\n');
  const state = deleteAt(stateOf(README), lineEnd, lineEnd + 1, 'delete.forward');
  assert.equal(state.doc.toString().includes('<!--co:k3f9'), true);
  assert.equal(parseComments(state.doc.toString())[0].thread.length, 2);
});

test('typing at highlight edges stays outside the markers', () => {
  const comment = parseComments(README)[0];
  const before = apply(stateOf(README), {
    changes: { from: comment.open.to, insert: 'x' },
    userEvent: 'input.type',
  });
  assert.equal(before.doc.toString().includes('x<!--c:k3f9-->ship on Friday'), true);
  const after = apply(stateOf(README), {
    changes: { from: comment.close.from, insert: 'y' },
    userEvent: 'input.type',
  });
  assert.equal(after.doc.toString().includes('Fridayy<!--/c:k3f9-->'), false);
  assert.equal(after.doc.toString().includes('<!--/c:k3f9-->y'), true);
});

test('deleting the whole highlight leaves the body behind', () => {
  const range = parseComments(README)[0];
  const state = deleteAt(stateOf(README), range.open.to, range.close.from, 'delete.selection');
  const next = parseComments(state.doc.toString())[0];
  assert.ok(next.body);
  assert.equal(state.doc.toString().slice(next.open?.to || 0, next.close?.from || 0).includes('ship on Friday'), false);
  assert.equal(state.doc.toString().includes('<!--co:k3f9'), true);
});

test('copy strips comment markers', () => {
  const from = README.indexOf('We should');
  const to = README.indexOf('timeline.') + 'timeline.'.length;
  const state = apply(stateOf(README), { selection: { anchor: from, head: to } });
  const raw = state.sliceDoc(from, to);
  const copied = state.facet(EditorView.clipboardOutputFilter).reduce((text, filter) => filter(text, state), raw);
  assert.equal(copied.includes('<!--'), false);
  assert.equal(copied.includes('ship on Friday'), true);
  assert.equal(copied.includes('k3f9'), false);
});

test('undo restores a reply and a resolve', () => {
  const replied = reply(README, 'k3f9', {
    createdAt: '2026-06-17T12:00:00.000Z',
    author: 'me',
    text: 'ok',
  });
  let state = apply(stateOf(README), { changes: replied.changes, userEvent: 'input.comment' });
  assert.equal(parseComments(state.doc.toString())[0].thread.length, 3);
  const view = {
    state,
    dispatch(tr) { view.state = tr.state; },
  };
  assert.equal(undo(view), true);
  assert.equal(parseComments(view.state.doc.toString())[0].thread.length, 2);

  const resolved = setStatus(README, 'k3f9', 'resolved');
  state = apply(stateOf(README), { changes: resolved.changes, userEvent: 'input.comment' });
  view.state = state;
  assert.equal(parseComments(view.state.doc.toString())[0].status, 'resolved');
  assert.equal(undo(view), true);
  assert.equal(parseComments(view.state.doc.toString())[0].status, 'open');
});

test('a U+200B list comment still has a highlight and hidden markers', () => {
  const doc = [
    `- ${MARKER_GUARD}<!--c:g2fot-->**Onboarded fast:** Admin.<!--/c:g2fot-->`,
    '<!--co:g2fot by:me at:2026-11-16T18:45:04.103Z status:open quote:"**Onboarded fast:** Admin."',
    'me (2026-11-16T18:45:04.103Z): punchier',
    '-->',
  ].join('\n');
  const state = stateOf(doc);
  const copied = state.facet(EditorView.clipboardOutputFilter).reduce(
    (text, filter) => filter(text, state),
    state.doc.toString(),
  );
  assert.equal(copied.includes('<!--'), false);
  assert.equal(copied.includes('Onboarded fast'), true);
  assert.equal(doc.includes(MARKER_GUARD), true);
});

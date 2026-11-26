import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EditorState,
  history,
  moveLineDown,
  moveLineUp,
  undo,
} from '../app/vendor/codemirror.js';

function viewFor(doc, anchor, head = anchor) {
  let state = EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [history(), EditorState.lineSeparator.of('\n')],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(tr) {
      state = tr.state;
    },
  };
  return {
    view,
    get doc() {
      return state.doc.toString();
    },
    get anchor() {
      return state.selection.main.anchor;
    },
    get head() {
      return state.selection.main.head;
    },
  };
}

test('moveLineDown swaps one line with the line below', () => {
  const text = 'one\ntwo\nthree';
  const bag = viewFor(text, 5);
  assert.equal(moveLineUp(bag.view), true);
  assert.equal(bag.doc, 'two\none\nthree');
  assert.equal(moveLineDown(bag.view), true);
  assert.equal(bag.doc, text);
});

test('moveLineUp moves only the caret line when the selection is empty', () => {
  const text = 'alpha\nbeta\ngamma';
  const betaStart = text.indexOf('beta');
  const bag = viewFor(text, betaStart + 1);
  assert.equal(moveLineUp(bag.view), true);
  assert.equal(bag.doc, 'beta\nalpha\ngamma');
  assert.ok(bag.anchor >= 0 && bag.anchor <= 'beta'.length);
});

test('moveLineDown moves every line in a partial multi-line selection', () => {
  const text = 'a\nb\nc\nd\ne';
  const from = text.indexOf('b');
  const to = text.indexOf('d') + 1;
  const bag = viewFor(text, from, to);
  assert.equal(moveLineDown(bag.view), true);
  assert.equal(bag.doc, 'a\ne\nb\nc\nd');
});

test('a selection ending at column 0 of the next line excludes that line', () => {
  const text = 'one\ntwo\nthree\nfour';
  const from = text.indexOf('two');
  const to = text.indexOf('three');
  const bag = viewFor(text, from, to);
  assert.equal(moveLineUp(bag.view), true);
  assert.equal(bag.doc, 'two\none\nthree\nfour');
});

test('moveLineUp at the top of the document is a no-op', () => {
  const text = 'first\nsecond';
  const bag = viewFor(text, 0);
  assert.equal(moveLineUp(bag.view), false);
  assert.equal(bag.doc, text);
});

test('moveLineDown at the bottom of the document is a no-op', () => {
  const text = 'first\nsecond';
  const bag = viewFor(text, text.length);
  assert.equal(moveLineDown(bag.view), false);
  assert.equal(bag.doc, text);
});

test('undo restores bytes after a toolbar-style line move', () => {
  const text = 'keep\nmove\nstay';
  const bag = viewFor(text, text.indexOf('move'));
  assert.equal(moveLineDown(bag.view), true);
  assert.equal(bag.doc, 'keep\nstay\nmove');
  assert.equal(undo(bag.view), true);
  assert.equal(bag.doc, text);
});
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState, history, redo, undo } from '../app/vendor/codemirror.js';
import { FORMAT_ACTIONS, applyFormat, formatChange } from '../app/js/format.js';

function run(text, from, to, action) {
  const spec = formatChange(text, from, to, action);
  assert.ok(spec && !spec.noop, `${action} should edit ${JSON.stringify(text)}`);
  return { text: applyFormat(text, spec), caret: spec.selection.anchor, head: spec.selection.head, spec };
}

test('FORMAT_ACTIONS lists every toolbar edit in order', () => {
  assert.deepEqual(FORMAT_ACTIONS, [
    'task', 'bullet', 'numbered', 'bold', 'italic', 'link', 'heading',
    'indent', 'outdent', 'quote', 'code', 'strike', 'fence', 'highlight',
    'rule', 'undo', 'redo',
  ]);
});

test('bold, italic, strike, highlight and inline code wrap and toggle the selection', () => {
  assert.equal(run('say hi', 4, 6, 'bold').text, 'say **hi**');
  assert.equal(run('say **hi**', 4, 10, 'bold').text, 'say hi');
  assert.equal(run('say hi', 4, 6, 'italic').text, 'say *hi*');
  assert.equal(run('say *hi*', 4, 8, 'italic').text, 'say hi');
  assert.equal(run('say hi', 4, 6, 'strike').text, 'say ~~hi~~');
  assert.equal(run('say ~~hi~~', 4, 10, 'strike').text, 'say hi');
  assert.equal(run('say hi', 4, 6, 'highlight').text, 'say ==hi==');
  assert.equal(run('say ==hi==', 4, 10, 'highlight').text, 'say hi');
  assert.equal(run('say hi', 4, 6, 'code').text, 'say `hi`');
  assert.equal(run('say `hi`', 4, 8, 'code').text, 'say hi');
});

test('empty inline wraps put the caret between the markers', () => {
  const bold = run('ab', 1, 1, 'bold');
  assert.equal(bold.text, 'a****b');
  assert.equal(bold.caret, 3);
  const italic = run('', 0, 0, 'italic');
  assert.equal(italic.text, '**');
  assert.equal(italic.caret, 1);
});

test('link wraps a URL as [text](url) and other text as a wikilink', () => {
  const url = run('https://example.com', 0, 19, 'link');
  assert.equal(url.text, '[](https://example.com)');
  assert.equal(url.caret, 1);
  const wiki = run('Lab log', 0, 7, 'link');
  assert.equal(wiki.text, '[[Lab log]]');
  assert.equal(run('[[Lab log]]', 0, 11, 'link').text, 'Lab log');
  assert.equal(run('', 0, 0, 'link').text, '[[]]');
});

test('heading cycles none to H1, H2, H3, then off', () => {
  assert.equal(run('Title', 0, 0, 'heading').text, '# Title');
  assert.equal(run('# Title', 2, 2, 'heading').text, '## Title');
  assert.equal(run('## Title', 3, 3, 'heading').text, '### Title');
  assert.equal(run('### Title', 4, 4, 'heading').text, 'Title');
});

test('task, bullet, numbered and quote toggle the line marker', () => {
  assert.equal(run('item', 0, 0, 'task').text, '- [ ] item');
  assert.equal(run('- [ ] item', 6, 6, 'task').text, 'item');
  assert.equal(run('- item', 0, 0, 'task').text, '- [ ] item');
  assert.equal(run('item', 0, 0, 'bullet').text, '- item');
  assert.equal(run('- item', 0, 0, 'bullet').text, 'item');
  assert.equal(run('item', 0, 0, 'numbered').text, '1. item');
  assert.equal(run('1. item', 0, 0, 'numbered').text, 'item');
  assert.equal(run('note', 0, 0, 'quote').text, '> note');
  assert.equal(run('> note', 0, 0, 'quote').text, 'note');
});

test('indent and outdent nest lines by two spaces or a tab', () => {
  assert.equal(run('- a', 0, 0, 'indent').text, '  - a');
  assert.equal(run('  - a', 0, 0, 'outdent').text, '- a');
  assert.equal(run('\t- a', 0, 0, 'indent').text, '\t\t- a');
});

test('code fence wraps the selection and unwraps an existing fence', () => {
  const fenced = run('code', 0, 4, 'fence');
  assert.equal(fenced.text, '```\ncode\n```');
  assert.equal(run('```\ncode\n```', 0, 12, 'fence').text, 'code');
});

test('horizontal rule inserts --- on its own line', () => {
  assert.equal(run('', 0, 0, 'rule').text, '---');
  assert.equal(run('para', 4, 4, 'rule').text, 'para\n---');
  assert.equal(run('---', 0, 0, 'rule').text, '');
});

test('CRLF files keep \\r when a toolbar action inserts a line', () => {
  const doc = 'para\r';
  const next = run(doc, 4, 4, 'rule');
  assert.equal(next.text, 'para\r\n---\r');
  const task = run('item\r\nnext\r', 0, 0, 'task');
  assert.equal(task.text, '- [ ] item\r\nnext\r');
});

test('bytes outside the edited span stay identical', () => {
  const doc = 'aaa\nword\nzzz';
  const next = run(doc, 4, 8, 'bold');
  assert.equal(next.text, 'aaa\n**word**\nzzz');
  assert.equal(next.text.startsWith('aaa\n'), true);
  assert.equal(next.text.endsWith('\nzzz'), true);
});

test('every action either edits, is a history command, or is a no-op outdent', () => {
  for (const action of FORMAT_ACTIONS) {
    if (action === 'undo' || action === 'redo') {
      assert.equal(formatChange('text', 0, 4, action), null);
      continue;
    }
    const spec = formatChange('text', 0, 4, action);
    assert.ok(spec, `${action} should return a change`);
    if (!spec.noop) assert.equal(typeof spec.insert, 'string');
  }
});

test('toolbar edits are history transactions, so undo restores the bytes', () => {
  let state = EditorState.create({
    doc: 'hello',
    extensions: [history(), EditorState.lineSeparator.of('\n')],
  });
  const spec = formatChange(state.doc.toString(), 0, 5, 'bold');
  state = state.update({
    changes: { from: spec.from, to: spec.to, insert: spec.insert },
    selection: { anchor: spec.selection.anchor, head: spec.selection.head },
    userEvent: 'input.format',
  }).state;
  assert.equal(state.doc.toString(), '**hello**');
  const view = {
    state,
    dispatch(tr) {
      state = tr.state;
    },
  };
  assert.equal(undo(view), true);
  assert.equal(state.doc.toString(), 'hello');
  view.state = state;
  assert.equal(redo(view), true);
  assert.equal(state.doc.toString(), '**hello**');
});

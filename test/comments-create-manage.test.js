import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MARKER_GUARD,
  addComment,
  anchorOffBlockMarkup,
  applyChanges,
  canCreateComment,
  commentTargetRange,
  deleteComment,
  deleteEntry,
  editEntry,
  parseComments,
  reanchor,
  serializeBlock,
  toggleReaction,
} from '../app/js/comments.js';

test('line comment strips list markers and may add U+200B at line start', () => {
  const doc = '- Ship on Friday with QA.\n';
  const target = commentTargetRange(doc, 2, 2);
  assert.equal(target.error, undefined);
  const created = addComment(doc, target.from, target.to, {
    id: 'a1b2c',
    author: 'me',
    createdAt: '2026-11-16T12:00:00.000Z',
    text: 'needs a buffer',
    expected: target.expected,
  });
  const next = applyChanges(doc, created.changes);
  assert.match(next, new RegExp(`- ${MARKER_GUARD}<!--c:a1b2c-->`));
  const comment = parseComments(next)[0];
  assert.equal(comment.thread[0].text, 'needs a buffer');
});

test('mid-paragraph selection round-trips through serialize', () => {
  const doc = 'We should ship on Friday.\n';
  const from = doc.indexOf('ship');
  const to = from + 'ship on Friday'.length;
  const created = addComment(doc, from, to, {
    id: 'k3f9',
    author: 'kyle',
    createdAt: '2026-06-17T10:00:00.000Z',
    text: 'Thursday?',
  });
  const next = applyChanges(doc, created.changes);
  const comment = parseComments(next)[0];
  const body = next.slice(comment.body.from, comment.body.to);
  const again = serializeBlock('k3f9', {
    author: comment.author,
    createdAt: comment.createdAt,
    status: comment.status,
    quote: comment.quote,
    thread: comment.thread,
    reactions: comment.reactions,
  });
  assert.equal(again, body);
});

test('reactions on first entry and reply use plugin-shaped lines', () => {
  const doc = applyChanges('<!--c:t1-->x<!--/c:t1-->\n', addComment('anchor text\n', 0, 11, {
    id: 't1',
    author: 'me',
    createdAt: '2026-11-16T12:00:00.000Z',
    text: 'first',
  }).changes);
  const replied = applyChanges(doc, addComment(doc, 0, 0, {
    id: 't1',
    author: 'sam',
    createdAt: '2026-11-16T12:01:00.000Z',
    text: 'second',
    targetHighlightId: 't1',
  }).changes);
  const withFirst = applyChanges(replied, toggleReaction(replied, 't1', { entry: 0, emoji: '👍', author: 'me' }).changes);
  const withReply = applyChanges(withFirst, toggleReaction(withFirst, 't1', { entry: 1, emoji: '👀', author: 'sam' }).changes);
  const comment = parseComments(withReply)[0];
  const body = serializeBlock('t1', {
    author: comment.author,
    createdAt: comment.createdAt,
    status: comment.status,
    quote: comment.quote,
    thread: comment.thread,
    reactions: comment.reactions,
  });
  assert.match(body, /\+👍 me/);
  assert.match(body, /\+@1 👀 sam/);
});

test('edit and delete entry preserve unchanged thread bytes', () => {
  const seed = [
    'Text <!--c:zz1-->quote<!--/c:zz1-->',
    '<!--co:zz1 by:me status:open quote:"quote"',
    'me (2026-11-16T12:00:00.000Z): one',
    'sam (2026-11-16T12:01:00.000Z): two',
    '-->',
  ].join('\n');
  const edited = applyChanges(seed, editEntry(seed, 'zz1', 1, 'TWO').changes);
  assert.equal(parseComments(edited)[0].thread[1].text, 'TWO');
  const trimmed = applyChanges(edited, deleteEntry(edited, 'zz1', 1).changes);
  assert.equal(parseComments(trimmed)[0].thread.length, 1);
});

test('delete comment removes markers and block but keeps highlighted text', () => {
  const doc = 'A <!--c:del-->keep<!--/c:del--> B\n<!--co:del status:open\nme: hi\n-->';
  const next = applyChanges(doc, deleteComment(doc, 'del').changes);
  assert.match(next, /A keep B/);
  assert.equal(next.includes('del'), false);
});

test('re-anchor moves markers to a new span and updates quote', () => {
  const doc = [
    'We should <!--c:r1-->ship on Friday<!--/c:r1--> regardless.',
    '<!--co:r1 by:me status:open quote:"ship on Friday"',
    'me (2026-11-16T12:00:00.000Z): keep this',
    '-->',
    'Then launch next week.',
  ].join('\n');
  const start = doc.indexOf('launch');
  const end = start + 'launch next week'.length;
  const next = applyChanges(doc, reanchor(doc, 'r1', start, end).changes);
  const comment = parseComments(next)[0];
  assert.equal(comment.quote, 'launch next week');
  assert.equal(next.slice(comment.open.to, comment.close.from), 'launch next week');
});

test('targetHighlightId cancels an empty new comment', () => {
  const doc = applyChanges('Pick <!--c:n1-->one<!--/c:n1-->\n', addComment('one\n', 0, 3, {
    id: 'n1',
    author: 'me',
    createdAt: '2026-11-16T12:00:00.000Z',
    text: '',
  }).changes);
  const canceled = applyChanges(doc, addComment(doc, 0, 0, {
    id: 'n1',
    author: 'me',
    createdAt: '2026-11-16T12:00:00.000Z',
    text: '',
    targetHighlightId: 'n1',
  }).changes);
  assert.equal(canceled.includes('n1'), false);
});

test('canCreateComment is false in tables and fenced code', () => {
  const table = [
    '| h | h2 |',
    '| - | - |',
    '| a | b |',
  ].join('\n');
  const mid = table.indexOf('a');
  assert.equal(canCreateComment(table, mid, mid + 1), false);
  const fence = '```\ncode\n```\n';
  assert.equal(canCreateComment(fence, 4, 8), false);
  const prose = 'Hello world\n';
  assert.equal(canCreateComment(prose, 0, 5), true);
});

test('anchorOffBlockMarkup skips heading markers', () => {
  const doc = '## Heading text\n';
  const line = anchorOffBlockMarkup(doc, 0, doc.length - 1);
  assert.equal(doc.slice(line.from, line.to), 'Heading text');
});
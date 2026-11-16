import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MARKER_GUARD,
  addComment,
  applyChanges,
  applyProtectedEdit,
  anchorRange,
  clipboardTextForRange,
  closeMarker,
  commentHighlights,
  commentHideRanges,
  deleteComment,
  deleteEntry,
  editEntry,
  existingIds,
  isAnchored,
  isOrphan,
  openCommentCount,
  openMarker,
  parseComments,
  relativeTime,
  reply,
  serializeBlock,
  setStatus,
  stripCommentMarkup,
  toggleReaction,
  unescapeText,
  escapeText,
  splitReactionAuthors,
} from '../app/js/comments.js';

const README = [
  'We should <!--c:k3f9-->ship on Friday<!--/c:k3f9--> regardless of the QA timeline.',
  '<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship on Friday"',
  'kyle (2026-06-17T10:00:00.000Z): I thought we agreed Thursday?',
  'sam (2026-06-17T10:05:00.000Z): Thursday is better for QA.',
  '-->',
].join('\n');

const JOE = [
  `- ${MARKER_GUARD}<!--c:g2fot-->**Onboarded fast:** Admin dashboard.<!--/c:g2fot-->`,
  '<!--co:g2fot by:me at:2026-11-16T18:45:04.103Z status:open quote:"**Onboarded fast:** Admin dashboard."',
  'me (2026-11-16T18:45:04.103Z): @grok these bullet points need to be punchier',
  'more',
  'grok (2026-11-16T18:46:40.000Z): Reworked all five',
  '-->',
].join('\n');

test('parses the README canonical example', () => {
  const comments = parseComments(README);
  assert.equal(comments.length, 1);
  const comment = comments[0];
  assert.equal(comment.id, 'k3f9');
  assert.equal(comment.author, 'kyle');
  assert.equal(comment.createdAt, '2026-06-17T10:00:00.000Z');
  assert.equal(comment.status, 'open');
  assert.equal(comment.quote, 'ship on Friday');
  assert.equal(comment.thread.length, 2);
  assert.equal(comment.thread[0].author, 'kyle');
  assert.equal(comment.thread[0].text, 'I thought we agreed Thursday?');
  assert.equal(comment.thread[1].author, 'sam');
  assert.equal(comment.thread[1].text, 'Thursday is better for QA.');
  assert.equal(README.slice(anchorRange(comment).from, anchorRange(comment).to), 'ship on Friday');
  assert.equal(isAnchored(comment), true);
});

test('parses Joe vault-style list item with a U+200B guard and a continuation line', () => {
  const comment = parseComments(JOE)[0];
  assert.equal(comment.id, 'g2fot');
  assert.equal(comment.author, 'me');
  assert.equal(comment.status, 'open');
  assert.equal(comment.thread.length, 2);
  assert.equal(comment.thread[0].text, '@grok these bullet points need to be punchier\nmore');
  assert.equal(comment.thread[1].author, 'grok');
  assert.equal(JOE.slice(anchorRange(comment).from, anchorRange(comment).to), '**Onboarded fast:** Admin dashboard.');
  assert.equal(JOE[comment.open.from - 1], MARKER_GUARD);
});

test('parses escaped multi-line entries and reactions on replies', () => {
  const data = {
    author: 'kyle',
    createdAt: '2026-06-17T10:00:00.000Z',
    status: 'open',
    quote: 'ship on Friday',
    thread: [
      { author: 'kyle', timestamp: '2026-06-17T10:00:00.000Z', text: 'line one\nnote: this part matters' },
      { author: 'sam', timestamp: '2026-06-17T11:00:00.000Z', text: 'agreed\n+1 from me too' },
    ],
    reactions: [
      { emoji: '👍', authors: ['me'] },
      { emoji: '👀', authors: ['sam'], entry: 1 },
    ],
  };
  const doc = `${openMarker('t1')}anchor${closeMarker('t1')}\n${serializeBlock('t1', data)}`;
  const comment = parseComments(doc)[0];
  assert.deepEqual(comment.thread.map((entry) => entry.text), data.thread.map((entry) => entry.text));
  assert.deepEqual(comment.reactions, data.reactions);
  assert.match(serializeBlock('t1', data), /\+👍 me/);
  assert.match(serializeBlock('t1', data), /\+@1 👀 sam/);
});

test('breaks --> so it cannot end the block, then reads the thread back', () => {
  const data = {
    status: 'open',
    quote: 'state A --> state B',
    thread: [{ author: 'me', text: 'see A --> B' }],
    reactions: [],
  };
  const body = serializeBlock('t1', data);
  assert.equal((body.match(/-->/g) || []).length, 1);
  const doc = `${openMarker('t1')}x${closeMarker('t1')}\n${body}`;
  const comment = parseComments(doc)[0];
  assert.equal(comment.thread.length, 1);
  assert.equal(comment.thread[0].author, 'me');
  assert.equal(comment.thread[0].text.includes('see A --'), true);
  assert.equal(comment.thread[0].text.includes('B'), true);
});

test('U+200B in front of an open marker is not part of the anchor', () => {
  const doc = `${MARKER_GUARD}<!--c:ab1-->Hello<!--/c:ab1-->\n<!--co:ab1 status:open\nme: hi\n-->`;
  const comment = parseComments(doc)[0];
  assert.equal(doc.slice(anchorRange(comment).from, anchorRange(comment).to), 'Hello');
});

test('code-line comments keep the line range and exact quote', () => {
  const body = serializeBlock('p7k2', {
    author: 'agent',
    status: 'open',
    quote: '    validate(order)',
    codeLines: { from: 1, to: 1 },
    thread: [{ author: 'agent', text: 'before logging?' }],
    reactions: [],
  });
  const doc = [
    '<!--c:p7k2-->',
    '```python',
    'def process(order):',
    '    validate(order)',
    '```',
    '<!--/c:p7k2-->',
    body,
  ].join('\n');
  const comment = parseComments(doc)[0];
  assert.deepEqual(comment.codeLines, { from: 1, to: 1 });
  assert.equal(comment.quote, '    validate(order)');
});

test('markers inside fenced, inline, and indented code are not comments', () => {
  const doc = [
    'Here is documentation:',
    '',
    '```markdown',
    `${openMarker('ex01')}example span${closeMarker('ex01')}`,
    '<!--co:ex01 status:open\nme: not a real comment\n-->',
    '```',
    '',
    `Use the \`${openMarker('inl01')}\` marker syntax.`,
    '',
    '    indented',
    `    ${openMarker('ind01')}nope${closeMarker('ind01')}`,
    '',
    `But this ${openMarker('real1')}is real${closeMarker('real1')}.`,
    '<!--co:real1 status:open\nme: real\n-->',
  ].join('\n');
  assert.deepEqual(parseComments(doc).map((comment) => comment.id), ['real1']);
});

test('an orphan has a body and no ordered anchors', () => {
  const doc = 'Some text with no markers.\n<!--co:zz9 status:open\nme: dangling\n-->';
  const comment = parseComments(doc)[0];
  assert.equal(isAnchored(comment), false);
  assert.equal(isOrphan(comment), true);
});

test('duplicate ids keep the first open, close, and body', () => {
  const doc = [
    '<!--c:dup-->one<!--/c:dup-->',
    '<!--co:dup status:open quote:"one"',
    'me: first',
    '-->',
    '<!--c:dup-->two<!--/c:dup-->',
    '<!--co:dup status:resolved',
    'me: second',
    '-->',
  ].join('\n');
  const comments = parseComments(doc);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].status, 'open');
  assert.equal(comments[0].thread[0].text, 'first');
  assert.equal(doc.slice(anchorRange(comments[0]).from, anchorRange(comments[0]).to), 'one');
});

test('unchanged comments round-trip with no diff', () => {
  const comments = parseComments(README);
  const original = README.slice(comments[0].body.from, comments[0].body.to);
  const rewritten = serializeBlock(comments[0].id, {
    author: comments[0].author,
    createdAt: comments[0].createdAt,
    status: comments[0].status,
    quote: comments[0].quote,
    codeLines: comments[0].codeLines,
    thread: comments[0].thread,
    reactions: comments[0].reactions,
  });
  assert.equal(rewritten, original);
  for (const doc of [README, JOE]) {
    assert.equal(applyChanges(doc, []), doc);
    const parsed = parseComments(doc)[0];
    const again = parseComments(`${openMarker(parsed.id)}x${closeMarker(parsed.id)}\n${serializeBlock(parsed.id, {
      author: parsed.author,
      createdAt: parsed.createdAt,
      status: parsed.status,
      quote: parsed.quote,
      codeLines: parsed.codeLines,
      thread: parsed.thread,
      reactions: parsed.reactions,
    })}`)[0];
    assert.deepEqual(again.thread, parsed.thread);
  }
});

test('serialize then parse preserves thread, quote, and reactions', () => {
  const data = {
    author: 'kyle',
    createdAt: '2026-06-17T10:00:00.000Z',
    status: 'open',
    quote: 'ship on Friday',
    thread: [
      { author: 'kyle', text: 'I thought we agreed Thursday?' },
      { author: 'sam', timestamp: '2026-06-17T11:00:00.000Z', text: 'Thursday is better for QA.' },
    ],
    reactions: [{ emoji: '👍', authors: ['Doe, Jane', 'sam'] }],
  };
  const doc = `${openMarker('k3f9')}X${closeMarker('k3f9')}\n${serializeBlock('k3f9', data)}`;
  const comment = parseComments(doc)[0];
  assert.equal(comment.author, data.author);
  assert.equal(comment.quote, data.quote);
  assert.deepEqual(comment.thread, data.thread);
  assert.deepEqual(comment.reactions, data.reactions);
});

test('escapeText and unescapeText are inverses', () => {
  for (const value of ['plain', 'a\nb', 'a\\b', 'a\\nb', 'trailing  ', '\r\n', 'mix \\ and \n and \\n']) {
    assert.equal(unescapeText(escapeText(value)), value);
  }
  assert.deepEqual(splitReactionAuthors('Doe\\, Jane, sam'), ['Doe, Jane', 'sam']);
});

test('edit ops rewrite only the body and return CodeMirror changes', () => {
  const added = addComment('We should ship on Friday.\n', 10, 24, {
    id: 'k3f9',
    createdAt: '2026-06-17T10:00:00.000Z',
    author: 'kyle',
    text: 'I thought we agreed Thursday?',
  });
  assert.equal(added.error, undefined);
  const doc = applyChanges('We should ship on Friday.\n', added.changes);
  assert.match(doc, /<!--c:k3f9-->ship on Friday<!--\/c:k3f9-->/);

  const replied = reply(doc, 'k3f9', { createdAt: '2026-06-17T11:00:00.000Z', author: 'sam', text: 'Thursday is better' });
  const withReply = applyChanges(doc, replied.changes);
  assert.equal(parseComments(withReply)[0].thread.length, 2);
  assert.equal(withReply.startsWith(doc.slice(0, doc.indexOf('<!--co:'))), true);

  const resolved = applyChanges(withReply, setStatus(withReply, 'k3f9', 'resolved').changes);
  assert.equal(parseComments(resolved)[0].status, 'resolved');
  const opened = applyChanges(resolved, setStatus(resolved, 'k3f9', 'open').changes);
  assert.equal(parseComments(opened)[0].status, 'open');

  const edited = applyChanges(opened, editEntry(opened, 'k3f9', 1, 'new text').changes);
  assert.equal(parseComments(edited)[0].thread[1].text, 'new text');

  const reacted = applyChanges(edited, toggleReaction(edited, 'k3f9', { entry: 1, emoji: '👀', author: 'sam' }).changes);
  assert.deepEqual(parseComments(reacted)[0].reactions, [{ emoji: '👀', authors: ['sam'], entry: 1 }]);

  const trimmed = applyChanges(reacted, deleteEntry(reacted, 'k3f9', 1).changes);
  assert.equal(parseComments(trimmed)[0].thread.length, 1);
  assert.equal((parseComments(trimmed)[0].reactions || []).length, 0);

  const gone = applyChanges(trimmed, deleteComment(trimmed, 'k3f9').changes);
  assert.equal(gone.includes('k3f9'), false);
  assert.match(gone, /We should ship on Friday/);
});

test('deleting highlighted text keeps the body as an orphan', () => {
  const doc = README;
  const comment = parseComments(doc)[0];
  const range = anchorRange(comment);
  const next = applyProtectedEdit(doc, { from: range.from, to: range.to, insert: '' });
  const after = parseComments(next)[0];
  assert.equal(next.includes('<!--co:k3f9'), true);
  const remaining = after.open && after.close ? next.slice(after.open.to, after.close.from) : '';
  assert.equal(remaining.includes('ship on Friday'), false);
  assert.ok(after);
  assert.equal(after.thread[0].text.includes('Thursday'), true);
});

test('Backspace and Delete never remove half a marker', () => {
  const comment = parseComments(README)[0];
  const open = comment.open;
  const close = comment.close;
  const body = comment.body;
  const edges = [
    open.from,
    open.from + 1,
    open.to - 1,
    open.to,
    close.from,
    close.from + 1,
    close.to - 1,
    close.to,
    body.from,
    body.from + 1,
    body.to - 1,
    body.to,
  ];
  for (const at of edges) {
    const back = applyProtectedEdit(README, { from: Math.max(0, at - 1), to: at, insert: '' });
    assert.equal(back.includes('<!--c:k3f9-->'), true, `backspace at ${at} dropped open`);
    assert.equal(back.includes('<!--/c:k3f9-->'), true, `backspace at ${at} dropped close`);
    assert.equal(back.includes('<!--co:k3f9'), true, `backspace at ${at} dropped body`);
    const fwd = applyProtectedEdit(README, { from: at, to: Math.min(README.length, at + 1), insert: '' });
    assert.equal(fwd.includes('<!--c:k3f9-->'), true, `delete at ${at} dropped open`);
    assert.equal(fwd.includes('<!--/c:k3f9-->'), true, `delete at ${at} dropped close`);
    assert.equal(fwd.includes('<!--co:k3f9'), true, `delete at ${at} dropped body`);
  }
});

test('forward-delete at the end of a commented line does not eat the block', () => {
  const lineEnd = README.indexOf('\n');
  const next = applyProtectedEdit(README, { from: lineEnd, to: lineEnd + 1, insert: '' });
  assert.equal(next.includes('<!--co:k3f9'), true);
  assert.equal(parseComments(next)[0].thread.length, 2);
});

test('typing at highlight edges stays outside the markers', () => {
  const comment = parseComments(README)[0];
  const before = applyProtectedEdit(README, { from: comment.open.to, to: comment.open.to, insert: 'x' });
  assert.equal(before.includes('x<!--c:k3f9-->ship on Friday'), true);
  const after = applyProtectedEdit(README, { from: comment.close.from, to: comment.close.from, insert: 'y' });
  assert.equal(after.includes('Fridayy<!--/c:k3f9-->'), false);
  assert.equal(after.includes('<!--/c:k3f9-->y'), true);
});

test('copy strips markers and the body', () => {
  const from = README.indexOf('We should');
  const to = README.indexOf('timeline.') + 'timeline.'.length;
  const copied = clipboardTextForRange(README, from, to);
  assert.equal(copied.includes('<!--'), false);
  assert.equal(copied.includes('ship on Friday'), true);
  assert.equal(copied.includes('k3f9'), false);
});

test('hide ranges cover markers, the ZWSP guard, and a body on its own lines', () => {
  const hides = commentHideRanges(JOE);
  const hidden = (from, to) => hides.some((range) => range.from <= from && range.to >= to);
  const comment = parseComments(JOE)[0];
  assert.equal(hidden(comment.open.from - 1, comment.open.to), true);
  assert.equal(hidden(comment.close.from, comment.close.to), true);
  assert.equal(hidden(comment.body.from, comment.body.to), true);
  const highlights = commentHighlights(JOE);
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0].id, 'g2fot');
  assert.equal(commentHighlights(JOE.replace('status:open', 'status:resolved')).length, 0);
  assert.equal(commentHighlights(JOE.replace('status:open', 'status:resolved'), { showResolved: true }).length, 1);
});

test('stripCommentMarkup removes markers and bodies for preview', () => {
  const stripped = stripCommentMarkup(README, { wrap: true, showResolved: true });
  assert.equal(stripped.includes('<!--c:'), false);
  assert.equal(stripped.includes('<!--co:'), false);
  assert.equal(stripped.includes('ship on Friday'), true);
  assert.equal(stripped.includes('\u0001c:k3f9\u0002'), true);
  assert.equal(openCommentCount(README), 1);
  assert.equal(openCommentCount(README.replace('status:open', 'status:resolved')), 0);
  assert.ok([...existingIds(README)].includes('k3f9'));
});

test('relativeTime names recent stamps', () => {
  const now = Date.parse('2026-11-16T19:00:00.000Z');
  assert.equal(relativeTime('2026-11-16T18:59:30.000Z', now), 'just now');
  assert.equal(relativeTime('2026-11-16T18:10:00.000Z', now), '50m');
});

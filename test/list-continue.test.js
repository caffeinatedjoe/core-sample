import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  continueEnter,
  indentBody,
  indentChange,
  inFence,
  parseItem,
} from '../app/js/list-continue.js';

function apply(text, spec) {
  if (!spec || spec.noop) return String(text);
  return String(text).slice(0, spec.from) + spec.insert + String(text).slice(spec.to);
}

function enter(text, at, end = at) {
  const spec = continueEnter(text, at, end);
  assert.ok(spec, `expected a continuation at ${at} in ${JSON.stringify(text)}`);
  return { text: apply(text, spec), caret: spec.selection.anchor, spec };
}

test('parseItem reads bullets, tasks, numbers, quotes and CRLF', () => {
  assert.equal(parseItem('- item').kind, 'bullet');
  assert.equal(parseItem('* item').bullet, '*');
  assert.equal(parseItem('+ item').bullet, '+');
  assert.equal(parseItem('- [ ] task').kind, 'task');
  assert.equal(parseItem('- [x] done').taskMark, 'x');
  assert.equal(parseItem('1. one').kind, 'numbered');
  assert.equal(parseItem('2) two').numberDelim, ')');
  assert.equal(parseItem('> quoted').kind, 'quote');
  assert.equal(parseItem('  - [ ] nested\r').indent, '  ');
  assert.equal(parseItem('  - [ ] nested\r').cr, '\r');
  assert.equal(parseItem('plain').kind, 'none');
});

test('Enter continues a bullet with the same marker and indent', () => {
  const doc = '- alpha';
  const next = enter(doc, doc.length);
  assert.equal(next.text, '- alpha\n- ');
  assert.equal(next.text.endsWith('- '), true);
});

test('Enter continues *, + and indented bullets', () => {
  assert.equal(enter('* a', 3).text, '* a\n* ');
  assert.equal(enter('+ a', 3).text, '+ a\n+ ');
  assert.equal(enter('    - a', 7).text, '    - a\n    - ');
});

test('Enter on a checked or unchecked task always continues as - [ ]', () => {
  assert.equal(enter('- [ ] label', 12).text, '- [ ] label\n- [ ] ');
  assert.equal(enter('- [x] label', 12).text, '- [x] label\n- [ ] ');
  assert.equal(enter('* [X] label', 12).text, '* [X] label\n* [ ] ');
});

test('Enter increments a numbered item and a 1) paren marker', () => {
  assert.equal(enter('1. first', 8).text, '1. first\n2. ');
  assert.equal(enter('1) first', 8).text, '1) first\n2) ');
});

test('Enter continues a quote', () => {
  assert.equal(enter('> note', 6).text, '> note\n> ');
  assert.equal(enter('> - item', 8).text, '> - item\n> - ');
});

test('Enter on an empty top-level item removes the marker and ends the list', () => {
  assert.equal(enter('- ', 2).text, '');
  assert.equal(enter('- [ ] ', 6).text, '');
  assert.equal(enter('1. ', 3).text, '');
  assert.equal(enter('> ', 2).text, '');
});

test('Enter on an empty nested item outdents one level', () => {
  assert.equal(enter('  - ', 4).text, '- ');
  assert.equal(enter('    - [ ] ', 10).text, '  - [ ] ');
  assert.equal(enter('\t- ', 3).text, '- ');
});

test('Enter splits an item at the caret and keeps the rest on the new line', () => {
  const doc = '- foobar';
  const next = enter(doc, 5);
  assert.equal(next.text, '- foo\n- bar');
});

test('Enter inside a fence does not continue a list', () => {
  const doc = '```\n- item\n```';
  const at = doc.indexOf('item') + 4;
  assert.equal(inFence(doc, at), true);
  assert.equal(continueEnter(doc, at, at), null);
});

test('Enter on a plain line returns null so the default newline runs', () => {
  assert.equal(continueEnter('hello', 5, 5), null);
});

test('numbered follow-on items renumber only when they are a simple sequence', () => {
  const simple = '1. a\n2. b\n3. c';
  const at = simple.indexOf('a') + 1;
  assert.equal(enter(simple, at).text, '1. a\n2. \n3. b\n4. c');

  const irregular = '1. a\n5. b';
  assert.equal(enter(irregular, irregular.indexOf('a') + 1).text, '1. a\n2. \n5. b');
});

test('CRLF files keep \\r on every line and leave later bytes identical', () => {
  const doc = '- one\r\nplain stays\r\n';
  const at = doc.indexOf('one') + 3;
  const next = enter(doc, at);
  assert.equal(next.text, '- one\r\n- \r\nplain stays\r\n');
  assert.equal(next.text.endsWith('plain stays\r\n'), true);
  assert.equal(next.text.includes('\r\n'), true);
});

test('bytes before and after the touched lines stay identical', () => {
  const before = 'head\n';
  const after = '\ntail  \n\ttab\n';
  const mid = '- item';
  const doc = before + mid + after;
  const next = enter(doc, before.length + mid.length);
  assert.equal(next.text.startsWith(before), true);
  assert.equal(next.text.endsWith(after), true);
  assert.equal(next.text, `${before}- item\n- ${after}`);
});

test('Tab and Shift-Tab nest and unnest, matching the indent buttons', () => {
  assert.equal(indentBody('- a', 1), '  - a');
  assert.equal(indentBody('  - a', -1), '- a');
  assert.equal(indentBody('\t- a', 1), '\t\t- a');
  assert.equal(indentBody('\t- a', -1), '- a');
  const doc = '- a\n- b';
  const spec = indentChange(doc, 0, 3, 1);
  assert.equal(apply(doc, spec), '  - a\n- b');
  const both = indentChange(doc, 0, doc.length, 1);
  assert.equal(apply(doc, both), '  - a\n  - b');
  const out = indentChange('  - a', 4, 4, -1);
  assert.equal(apply('  - a', out), '- a');
  assert.equal(indentChange('plain', 0, 0, -1).noop, true);
});

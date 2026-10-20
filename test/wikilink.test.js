import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findWikilinks, parseWikilink } from '../app/js/markdown.js';
import { resolveWikilink } from '../app/js/notes.js';

test('parses target, alias, and heading forms', () => {
  assert.deepEqual(parseWikilink('Note'), {
    target: 'Note',
    heading: null,
    alias: null,
    label: 'Note',
  });
  assert.deepEqual(parseWikilink('Note|Alias'), {
    target: 'Note',
    heading: null,
    alias: 'Alias',
    label: 'Alias',
  });
  assert.deepEqual(parseWikilink('Note#My Heading'), {
    target: 'Note',
    heading: 'My Heading',
    alias: null,
    label: 'My Heading',
  });
  assert.deepEqual(parseWikilink('folder/note#Heading|Alias'), {
    target: 'folder/note',
    heading: 'Heading',
    alias: 'Alias',
    label: 'Alias',
  });
  assert.equal(parseWikilink(''), null);
  assert.equal(parseWikilink('|alias'), null);
});

test('finds wikilinks in prose and skips code', () => {
  const found = findWikilinks('See [[Note]], [[Other|Alias]], and [[Note#Heading]].\n`[[skip]]`\n```\n[[hidden]]\n```\n[[Last]]\n');
  assert.deepEqual(found.map((link) => link.target), ['Note', 'Other', 'Note', 'Last']);
  assert.equal(found[1].label, 'Alias');
  assert.equal(found[2].heading, 'Heading');
  assert.equal(found[2].label, 'Heading');
});

test('resolves a local note by path or unique filename', () => {
  const files = [
    { path: 'Welcome.md', kind: 'markdown' },
    { path: 'Field notes.md', kind: 'markdown' },
    { path: 'logs/Field notes.md', kind: 'markdown' },
    { path: 'solo/Only.md', kind: 'markdown' },
  ];
  assert.equal(resolveWikilink(files, 'Welcome').file.path, 'Welcome.md');
  assert.equal(resolveWikilink(files, 'welcome').file.path, 'Welcome.md');
  assert.equal(resolveWikilink(files, 'logs/Field notes').file.path, 'logs/Field notes.md');
  assert.equal(resolveWikilink(files, 'Only').file.path, 'solo/Only.md');
  assert.equal(resolveWikilink(files, 'Field notes').status, 'ambiguous');
  assert.equal(resolveWikilink(files, 'Missing').status, 'missing');
});

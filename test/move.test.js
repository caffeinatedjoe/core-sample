import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  planFileMove,
  planFileRename,
  planFolderRename,
  rewriteLinks,
} from '../app/js/organize.js';

function file(path, content) {
  return { path, content, kind: 'markdown', encoding: 'utf-8', createdAt: 1, updatedAt: 1 };
}

test('renaming a note updates wikilinks and markdown links that point at it', () => {
  const files = [
    file('Welcome.md', 'See [[Field notes]], [[Field notes|log]], and [[Field notes#Site|here]].\n[map](Field%20notes.md)\n'),
    file('Field notes.md', '# Field notes\n\nStay.\n'),
    file('other/Link.md', 'Path form [[Field notes]] still works by name.\n[rel](../Field%20notes.md#Site)\n'),
  ];
  const result = planFileRename(files, 'Field notes.md', 'Cores.md', 20);
  assert.deepEqual(result.remove, ['Field notes.md']);
  assert.equal(result.files.some((item) => item.path === 'Field notes.md'), false);
  const welcome = result.files.find((item) => item.path === 'Welcome.md');
  assert.match(welcome.content, /\[\[Cores\]\]/);
  assert.match(welcome.content, /\[\[Cores\|log\]\]/);
  assert.match(welcome.content, /\[\[Cores#Site\|here\]\]/);
  assert.match(welcome.content, /\[map\]\(Cores\.md\)/);
  const other = result.files.find((item) => item.path === 'other/Link.md');
  assert.match(other.content, /\[\[Cores\]\]/);
  assert.match(other.content, /\[rel\]\(\.\.\/Cores\.md#Site\)/);
  const cores = result.files.find((item) => item.path === 'Cores.md').content;
  assert.equal(cores, '# Field notes\n\nStay.\n');
});

test('moving a note keeps a unique bare wikilink and updates path links', () => {
  const files = [
    file('Welcome.md', '[[Only]] and [[solo/Only]] and [file](solo/Only.md)\n'),
    file('solo/Only.md', '# Only\n'),
  ];
  const result = planFileMove(files, 'solo/Only.md', 'archive', 30);
  const welcome = result.files.find((item) => item.path === 'Welcome.md').content;
  assert.match(welcome, /\[\[Only\]\]/);
  assert.equal(welcome.includes('[[solo/Only]]'), false);
  assert.match(welcome, /\[\[archive\/Only\]\]/);
  assert.match(welcome, /\[file\]\(archive\/Only\.md\)/);
  assert.equal(result.files.some((item) => item.path === 'archive/Only.md'), true);
});

test('renaming a folder rewrites the notes inside it and the links to them', () => {
  const files = [
    file('Work/Meet.md', 'See [peer](Notes.md) and [[Work/Notes]].\n'),
    file('Work/Notes.md', '# Notes\n'),
    file('Index.md', '[[Work/Meet]]\n'),
  ];
  const result = planFolderRename(files, ['Work'], 'Work', 'Lab', 40);
  assert.equal(result.files.some((item) => item.path === 'Lab/Meet.md'), true);
  assert.equal(result.files.some((item) => item.path === 'Work/Meet.md'), false);
  assert.deepEqual(result.folders, ['Lab']);
  const meet = result.files.find((item) => item.path === 'Lab/Meet.md').content;
  assert.match(meet, /\[peer\]\(Notes\.md\)/);
  assert.match(meet, /\[\[Lab\/Notes\]\]/);
  assert.match(result.files.find((item) => item.path === 'Index.md').content, /\[\[Lab\/Meet\]\]/);
});

test('ambiguous names and fenced links are left alone', () => {
  const files = [
    file('Field notes.md', '# One\n'),
    file('logs/Field notes.md', '# Two\n'),
    file('Index.md', '[[Field notes]]\n`[[Field notes]]`\n```\n[[Field notes]]\n```\n'),
  ];
  const result = planFileRename(files, 'Field notes.md', 'Cores.md', 50);
  const index = result.files.find((item) => item.path === 'Index.md').content;
  assert.match(index, /\[\[Field notes\]\]/);
  assert.match(index, /`\[\[Field notes\]\]`/);
  assert.match(index, /```\n\[\[Field notes\]\]\n```/);
  const moved = rewriteLinks('[[logs/Field notes]]', 'Index.md', new Map([['logs/Field notes.md', 'logs/Cores.md']]), files);
  assert.match(moved, /\[\[logs\/Cores\]\]/);
});

test('a rename refuses to overwrite another note', () => {
  const files = [file('A.md', 'a'), file('B.md', 'b')];
  assert.throws(() => planFileRename(files, 'A.md', 'B.md'), /already exists/);
  assert.equal(files[0].content, 'a');
  assert.equal(files[1].path, 'B.md');
});

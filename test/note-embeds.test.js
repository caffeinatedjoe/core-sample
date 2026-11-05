import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, ensureSyntaxTree } from '../app/vendor/codemirror.js';
import { liveSpecs, markdownLanguage } from '../app/js/live-rules.js';
import {
  describeNoteEmbed,
  extractBlock,
  extractHeadingSection,
  parseNoteEmbed,
  stripFrontmatter,
} from '../app/js/note-embeds.js';

function stateOf(doc) {
  const state = EditorState.create({ doc, extensions: [EditorState.lineSeparator.of('\n'), markdownLanguage.extension] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

const files = [
  { path: 'Lab.md', kind: 'markdown', content: '---\ntitle: Lab\n---\n# Setup\ngear\n# Results\nclay\n\nA block\n^core-7\n' },
  { path: 'Inbox.md', kind: 'markdown', content: 'hello' },
];

test('parseNoteEmbed leaves image targets to embeds.js', () => {
  assert.equal(parseNoteEmbed('photo.png'), null);
  assert.equal(parseNoteEmbed('Lab#Results').target, 'Lab');
  assert.equal(parseNoteEmbed('Lab#Results').heading, 'Results');
});

test('heading and block extracts skip frontmatter and later sections', () => {
  assert.match(stripFrontmatter(files[0].content), /^# Setup/);
  assert.match(extractHeadingSection(files[0].content, 'Results'), /^# Results/);
  assert.equal(extractHeadingSection(files[0].content, 'Results').includes('# Setup'), false);
  assert.equal(extractBlock(files[0].content, '^core-7'), 'A block');
  assert.equal(extractHeadingSection(files[0].content, 'Missing'), '');
});

test('describeNoteEmbed is explicit about missing, self, and heading misses', () => {
  assert.equal(describeNoteEmbed(files, 'Gone').status, 'missing');
  assert.equal(describeNoteEmbed(files, 'Lab', '', 'Lab.md').status, 'self');
  assert.equal(describeNoteEmbed(files, 'Lab', 'Missing').status, 'missing-target');
  const ok = describeNoteEmbed(files, 'Lab', 'Results');
  assert.equal(ok.status, 'ok');
  assert.match(ok.body, /clay/);
});

test('Live Preview draws a note embed, not a wiki chip, and keeps images as images', () => {
  const doc = '![[Lab]] and ![[photo.png]]';
  const specs = liveSpecs(stateOf(doc), { ranges: [] });
  assert.ok(specs.some((spec) => spec.widget?.kind === 'note-embed' && spec.widget.target === 'Lab'));
  assert.ok(specs.some((spec) => spec.widget?.kind === 'image'));
  assert.equal(specs.some((spec) => spec.widget?.kind === 'wikilink' && spec.widget.target === 'Lab'), false);
});

test('a nested task image is one image widget, not a note embed', () => {
  const doc = [
    '- [x] parent task',
    '\t- [x] nested task',
    '\t\t![[image-1710000000000.png]]',
    '\t- [x] sibling task',
  ].join('\n');
  const specs = liveSpecs(stateOf(doc), { ranges: [] });
  const widgets = specs.filter((spec) => spec.widget);
  assert.equal(widgets.filter((spec) => spec.widget.kind === 'task').length, 3);
  assert.equal(widgets.filter((spec) => spec.widget.kind === 'image').length, 1);
  assert.equal(widgets.filter((spec) => spec.widget.kind === 'note-embed').length, 0);
});

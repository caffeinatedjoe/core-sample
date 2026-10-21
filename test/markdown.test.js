import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listTasks } from '../app/js/checklist.js';
import { renderMarkdown } from '../app/js/markdown.js';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app/css/app.css'), 'utf8');

test('renders headings, emphasis, code, links, lists, quotes, rules, and tables', () => {
  const html = renderMarkdown(`# Title

A **bold** and *italic* and ***both*** word, plus \`code\`.

- one
- two

1. first
2. second

> quoted line

---

[Docs](https://example.com/docs)

| Rock | Depth |
| --- | --- |
| clay | 4m |

line one
line two
`);

  assert.match(html, /<h1 id="title" data-heading="Title">Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<strong><em>both<\/em><\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul class="md-list"><li class="bullet" style="--cols:0">[\s\S]*<span class="item-text">one<\/span>[\s\S]*<span class="item-text">two<\/span><\/div><\/li><\/ul>/);
  assert.match(html, /<ol class="md-list"><li class="ordered" value="1" style="--cols:0">[\s\S]*<span class="item-marker item-number">1\.<\/span><span class="item-text">first<\/span>[\s\S]*<span class="item-marker item-number">2\.<\/span><span class="item-text">second<\/span>/);
  assert.match(html, /<blockquote>quoted line<\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<a href="https:\/\/example\.com\/docs" rel="noopener">Docs<\/a>/);
  assert.equal(html.includes('target='), false);
  assert.match(html, /<th>Rock<\/th>/);
  assert.match(html, /<td>clay<\/td>/);
  assert.match(html, /line one<br>line two/);
});

test('escapes HTML and refuses javascript links', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n<img src=x onerror=alert(1)>');
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('javascript:'), false);
  assert.match(html, /click/);
});

test('keeps fenced code literal, including checkboxes and wikilinks', () => {
  const html = renderMarkdown('```\n- [ ] hidden\n[[Secret]]\n<script>\n```');
  assert.match(html, /<pre><code>- \[ \] hidden\n\[\[Secret\]\]\n&lt;script&gt;<\/code><\/pre>/);
  assert.equal(html.includes('data-task-index'), false);
  assert.equal(html.includes('data-wikilink'), false);
});

test('renders checklist buttons with the same indexes as listTasks', () => {
  const src = '- [ ] real\n```\n- [ ] fake\n```\n- [x] also\n';
  const html = renderMarkdown(src);
  assert.deepEqual(listTasks(src).map((task) => task.text), ['real', 'also']);
  assert.equal((html.match(/data-task-index="/g) || []).length, 2);
  assert.match(html, /data-task-index="0"[^>]*aria-pressed="false"/);
  assert.match(html, /data-task-index="1"[^>]*aria-pressed="true"/);
  assert.match(html, /class="task-text is-done">also/);
});

const TAB = '\t';

function fixture(text) {
  return text.replaceAll('<TAB>', TAB);
}

function taskIndexes(html) {
  return [...html.matchAll(/data-task-index="(\d+)"/g)].map((match) => match[1]);
}

const SAMPLES = {
  1: `
# Heading
- [ ] item text
<TAB>- [ ] item text
<TAB>- [ ] item text
<TAB>- [ ] item text
- [ ] item text
- [ ] item text
- [ ] item text


# Heading
 - item text
`,
  2: `
## Heading
- [ ] item text
<TAB>- item text
<TAB><TAB>- [ ] item text
<TAB><TAB><TAB>- [ ] item text
<TAB>- item text
<TAB><TAB>- [ ] item text
<TAB><TAB>- [ ] item text
<TAB><TAB><TAB>- item text
- [ ] item text
## Heading
- [ ] item text
    - item text
`,
  3: `
<TAB><TAB><TAB><TAB><TAB>- item text
<TAB><TAB><TAB>- item text
<TAB><TAB><TAB><TAB>- item text
<TAB><TAB><TAB><TAB><TAB>- [ ] item text
<TAB><TAB>- item text
<TAB><TAB><TAB>- item text
<TAB><TAB><TAB><TAB>- item text
<TAB><TAB><TAB><TAB>- item text
<TAB><TAB>- item text
<TAB><TAB><TAB>- item text
<TAB><TAB><TAB><TAB>- [ ] item text
<TAB><TAB><TAB><TAB><TAB>- item text
<TAB><TAB><TAB><TAB><TAB>- item text
`,
  4: `

- ## Heading
<TAB>- [x] item text
<TAB>- [x] item text
<TAB>- [x] item text
<TAB>- [x] item text
<TAB>- [x] item text
<TAB>- [x] item text
<TAB>- [x] item text
<TAB>- [x] item text
<TAB><TAB>- [ ] item text
<TAB>- [ ] item text
`,
  5: `
<TAB><TAB>- item text
<TAB><TAB>- item text
<TAB><TAB><TAB>- item text
<TAB><TAB><TAB><TAB>- [x] item text
<TAB><TAB><TAB><TAB>- [x] item text
<TAB><TAB><TAB><TAB><TAB>- item text
<TAB><TAB><TAB><TAB><TAB><TAB>- [x] item text
- item text
<TAB>- item text
<TAB><TAB>- item text
<TAB><TAB><TAB>- item text
<TAB><TAB><TAB><TAB>- item text
<TAB>- [x] item text
`,
  6: `
- [ ] item text
<TAB>- item text
- [ ] item text
<TAB>- [ ] item text
`,
  7: `
## Heading
- [x] item text
- [ ] item text
<TAB>- [ ] item text
- [x] item text
## Heading
- [ ] item text
- [ ] item text
- [ ] item text
- [x] item text
<TAB>- [x] item text
<TAB>- [x] item text
- [ ] item text
`,
  8: `
## Heading
- [ ] item text
<TAB>- [ ] item text
<TAB>- [ ] item text
<TAB><TAB>- [ ] item text
- [ ] item text
- [ ] item text
- [ ] 
## Heading
- [ ] item text
<TAB>- [ ] item text
<TAB>paragraph text
`,
  9: `
- [x] item text
- [x] item text
- [x] item text
<TAB>- [x] item text
- [x] item text
- [x] item text
- [x] item text
<TAB>- [x] item text
<TAB>- [x] item text
<TAB><TAB>- [x] item text
<TAB>- [x] item text
<TAB>- [x] item text
<TAB>- [x] item text
`,
  10: `
<TAB><TAB><TAB>- item text
<TAB><TAB><TAB><TAB>- item text
<TAB><TAB><TAB>- item text
<TAB><TAB><TAB>- [x] item text
<TAB><TAB><TAB><TAB>- item text
<TAB><TAB><TAB>- item text
<TAB><TAB>- item text
<TAB><TAB><TAB>- item text
<TAB><TAB>- item text
<TAB><TAB><TAB>- item text
<TAB><TAB><TAB>- item text
<TAB><TAB>- item text
<TAB><TAB>- item text
`,
  11: `
# Heading
- item text
<TAB>- [ ] item text
- item text
<TAB>- item text
<TAB>- item text
<TAB>- item text
<TAB><TAB>- item text
<TAB>- item text
<TAB>- item text
- item text
- item text
`,
  12: `
- item text
<TAB>- item text
- item text
<TAB>- [ ] item text

<TAB>
- item text

paragraph text
- item text
- item text
- item text

`,
  mixed: `
- item text
<TAB>- item text
<TAB>    - [ ] item text
<TAB>    - [ ] item text
<TAB>- [x] item text
`,
};

test('vault-shaped nested tasks render as checkboxes, not bracket text', () => {
  for (const [name, body] of Object.entries(SAMPLES)) {
    const src = fixture(body);
    const html = renderMarkdown(src);
    const tasks = listTasks(src);
    assert.deepEqual(taskIndexes(html), tasks.map((task) => String(task.index)), name);
    assert.equal(html.includes('[ ]'), false, name);
    assert.equal(html.includes('[x]'), false, name);
    assert.equal(html.includes('[X]'), false, name);
    assert.equal((html.match(/class="task-line"/g) || []).length, tasks.length, name);
    assert.equal(html.includes('<div class="task-line"><span class="item-marker"'), false, name);
  }
});

test('nests tasks under tasks, bullets, and numbers with spaces, tabs, and a mix', () => {
  const spaced = renderMarkdown([
    '- [ ] root',
    '  - [ ] two',
    '    - plain',
    '    1. numbered',
    '      - [x] under number',
  ].join('\n'));
  assert.match(spaced, /data-task-index="0"[\s\S]*<ul class="md-list">[\s\S]*data-task-index="1"[\s\S]*<ol class="md-list">[\s\S]*data-task-index="2"/);
  assert.match(spaced, /data-task-index="1"[\s\S]*?<ul class="md-list"><li class="bullet" style="--cols:2">/);
  const four = renderMarkdown('- [ ] root\n    - [ ] four\n\t- [ ] tab\n');
  assert.match(four, /style="--cols:0">[\s\S]*style="--cols:4">[\s\S]*style="--cols:4">/);
  assert.equal(spaced.includes('[ ]'), false);
  assert.equal(spaced.includes('[x]'), false);
  assert.equal(four.includes('[ ]'), false);

  const tabs = renderMarkdown(fixture(`
- [ ] root
<TAB>- bullet
<TAB><TAB>- [ ] deep
<TAB>    - [x] tab plus four
1. numbered
<TAB>- [ ] under number
`));
  assert.match(tabs, /data-task-index="0"[\s\S]*class="item-text">bullet<\/span>[\s\S]*data-task-index="1"[\s\S]*data-task-index="2"/);
  assert.match(tabs, /<li class="ordered"[\s\S]*data-task-index="3"/);
  assert.equal(tabs.includes('[ ]'), false);

  const mixed = renderMarkdown(fixture(SAMPLES.mixed));
  const deeper = mixed.indexOf('data-task-index="0"');
  const sibling = mixed.indexOf('data-task-index="2"');
  assert.ok(deeper !== -1 && sibling !== -1 && deeper < sibling);
  assert.match(mixed.slice(0, sibling), /<ul class="md-list">[\s\S]*data-task-index="0"[\s\S]*data-task-index="1"/);
  assert.equal(mixed.includes('[ ]'), false);
  assert.equal(mixed.includes('[x]'), false);
});

test('a two-tab embed under a nested task stays an inline image', () => {
  const html = renderMarkdown(fixture(`
- [x] parent task
<TAB>- [x] nested task
<TAB><TAB>![[image-1710000000000.png]]
<TAB>- [x] sibling task
`));
  assert.equal(html.includes('<pre'), false);
  assert.equal(html.includes('<code'), false);
  assert.equal(html.includes('![['), false);
  assert.equal((html.match(/data-task-index="/g) || []).length, 3);
  const nestedAt = html.indexOf('data-task-index="1"');
  const siblingAt = html.indexOf('data-task-index="2"');
  assert.ok(nestedAt !== -1 && siblingAt > nestedAt);
  const nested = html.slice(nestedAt, siblingAt);
  assert.match(nested, /class="item-body"[\s\S]*<span class="embed" data-embed="image-1710000000000.png">/);
  assert.match(nested, /class="embed-fallback">image-1710000000000\.png</);
  assert.equal(nested.includes('<pre'), false);
  assert.equal(nested.includes('item-marker'), false);
});

test('a task has no bullet, an empty box still renders, and a heading stays inside the item', () => {
  const tasks = renderMarkdown('- [ ] only\n\t- [x] child\n');
  assert.equal(tasks.includes('item-marker'), false);
  assert.match(tasks, /<li class="task" style="--cols:0">/);
  assert.match(tasks, /<li class="task" style="--cols:4">/);

  const empty = renderMarkdown('- [ ] \n');
  assert.match(empty, /<span class="task-text"><\/span>/);
  assert.equal(empty.includes('[ ]'), false);
  assert.equal((empty.match(/data-task-index="/g) || []).length, 1);

  const headed = renderMarkdown(fixture(SAMPLES[4]));
  assert.match(headed, /<li class="bullet" style="--cols:0"><div class="bullet-line"><span class="item-marker" aria-hidden="true"><\/span><h2 id="heading" data-heading="Heading">Heading<\/h2><\/div><div class="item-body">/);
  assert.match(headed, /data-task-index="7"[\s\S]*?<ul class="md-list"><li class="task" style="--cols:4"><div class="task-line"><button type="button" class="task-toggle" data-task-index="8"/);
  assert.equal(headed.includes('##'), false);
  assert.equal(listTasks(fixture(SAMPLES[4])).length, 10);

  const paragraph = renderMarkdown(fixture('- [ ] item text\n<TAB>- [ ] item text\n<TAB>paragraph text\n'));
  const paragraphAt = paragraph.indexOf('paragraph text');
  const listEnd = paragraph.lastIndexOf('</ul>');
  assert.ok(paragraphAt !== -1 && paragraphAt < listEnd);
});

test('task lines and wrapped text use a row so the box stays on the first line', () => {
  const html = renderMarkdown('- [ ] one two three four five six seven eight nine ten\n');
  assert.match(html, /<div class="task-line"><button type="button" class="task-toggle"[^>]*>[\s\S]*?<\/button><span class="task-text">/);
  assert.match(css, /\.task-line,\s*\n\.bullet-line \{\s*\n {2}display: flex;/);
  assert.match(css, /\.task-line > :last-child,\s*\n\.bullet-line > :last-child \{\s*\n {2}flex: 1;/);
  assert.match(css, /\.preview li\.task,\s*\n\.preview li\.bullet,\s*\n\.preview li\.ordered \{\s*\n {2}list-style: none;/);
});

test('renders a wikilink as a button, not a fragment anchor', () => {
  const html = renderMarkdown('See [[Field notes#Morning|dawn]].');
  assert.match(html, /<button type="button" class="wikilink" data-wikilink="Field notes" data-heading="Morning">dawn<\/button>/);
  assert.equal(html.includes('href="#'), false);
  assert.equal(html.includes('<a class="wikilink"'), false);
});

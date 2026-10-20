import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listTasks } from '../app/js/checklist.js';
import { renderMarkdown } from '../app/js/markdown.js';

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
  assert.match(html, /<ul><li[^>]*>one<\/li><li[^>]*>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote>quoted line<\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /href="https:\/\/example\.com\/docs"/);
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

test('renders a wikilink as a local control', () => {
  const html = renderMarkdown('See [[Field notes#Morning|dawn]].');
  assert.match(html, /class="wikilink"/);
  assert.match(html, /data-wikilink="Field notes"/);
  assert.match(html, /data-heading="Morning"/);
  assert.match(html, />dawn</);
});

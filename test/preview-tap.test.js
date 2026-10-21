import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planPreviewClick } from '../app/js/preview-tap.js';

function element(tag, { dataset = {}, attrs = {}, className = '', parent = null } = {}) {
  return {
    nodeType: 1,
    tag,
    className,
    dataset,
    parentElement: parent,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (matches(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
  };
}

function matches(node, selector) {
  if (selector === '[data-wikilink]') return Object.prototype.hasOwnProperty.call(node.dataset, 'wikilink');
  if (selector === '[data-task-index]') return Object.prototype.hasOwnProperty.call(node.dataset, 'taskIndex');
  if (selector === '.embed-image') return node.className === 'embed-image';
  if (selector === 'a[href]') return node.tag === 'a' && node.getAttribute('href');
  return false;
}

test('a wikilink tap is handled in the app and does not follow a URL', () => {
  const link = element('button', {
    dataset: { wikilink: 'Another note', heading: 'Start' },
  });
  assert.deepEqual(planPreviewClick(link), {
    type: 'wikilink',
    preventDefault: true,
    target: 'Another note',
    heading: 'Start',
  });
});

test('an image tap is a viewer, not a navigation', () => {
  const img = element('img', { className: 'embed-image', attrs: { src: 'blob:local', alt: 'img.png' } });
  assert.deepEqual(planPreviewClick(img), {
    type: 'image',
    preventDefault: true,
    src: 'blob:local',
    alt: 'img.png',
  });
});

test('a checklist tap is still a toggle', () => {
  const box = element('button', { dataset: { taskIndex: '0' } });
  assert.deepEqual(planPreviewClick(box), {
    type: 'task',
    preventDefault: true,
    index: 0,
  });
});

test('an external link is not preventDefaulted', () => {
  const anchor = element('a', { attrs: { href: 'https://example.com/docs' } });
  const text = { nodeType: 3, parentElement: anchor };
  assert.deepEqual(planPreviewClick(anchor), {
    type: 'external',
    preventDefault: false,
    href: 'https://example.com/docs',
  });
  assert.equal(planPreviewClick(text).preventDefault, false);
  assert.equal(planPreviewClick(element('a', { attrs: { href: 'mailto:joe@example.com' } })).preventDefault, false);
});

test('the preview handler returns before cancelling an external click', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const view = readFileSync(join(root, 'app/js/view.js'), 'utf8');
  const css = readFileSync(join(root, 'app/css/app.css'), 'utf8');
  const sw = readFileSync(join(root, 'app/sw.js'), 'utf8');
  assert.match(view, /if \(plan\.type === 'external' \|\| plan\.type === 'none'\) return;/);
  assert.match(view, /planPreviewClick\(event\.target\)/);
  assert.match(css, /\.wikilink \{[^}]*cursor: pointer;/s);
  assert.equal(css.includes('-webkit-overflow-scrolling'), false);
  assert.equal(sw.includes('preventDefault'), false);
});

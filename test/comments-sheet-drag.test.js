import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { note, openApp, swipe, withPhone } from './helpers/webkit-app.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTE = 'Drag perf.md';
const TEXT = [
  'We <!--c:k3f9-->ship<!--/c:k3f9--> Friday.',
  '<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship"',
  'kyle (2026-06-17T10:00:00.000Z): Can we wait?',
  '-->',
].join('\n');

async function blurEditor(page) {
  await page.evaluate(async () => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.contentDOM.blur();
  });
}

async function openThreadSheet(page) {
  await page.locator('.cm-comment[data-comment-id="k3f9"]').click();
  await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
}

async function handleCenter(page) {
  return page.evaluate(() => {
    const handle = document.querySelector('.comment-sheet-handle');
    const box = handle.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
}

test('onDragMove and scheduleDragPaint never read layout', () => {
  const src = readFileSync(join(root, 'app/js/comments-ui.js'), 'utf8');
  const start = src.indexOf('function onDragMove');
  const end = src.indexOf('function onDragUp');
  const block = src.slice(start, end);
  assert.equal(block.includes('getComputedStyle'), false);
  assert.equal(block.includes('getBoundingClientRect'), false);
  assert.equal(block.includes('sheetHeightLimits'), false);
  assert.equal(block.includes('sheetHeight'), false);
  const paintStart = src.indexOf('function scheduleDragPaint');
  const paintEnd = src.indexOf('function beginDragVisual');
  const paint = src.slice(paintStart, paintEnd);
  assert.equal(paint.includes('getComputedStyle'), false);
  assert.equal(paint.includes('getBoundingClientRect'), false);
});

test('webkit drag from full moves the card progressively and half drag settles at full', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await blurEditor(page);
    await openThreadSheet(page);

    let handle = await handleCenter(page);
    await swipe(page, handle, { x: handle.x, y: handle.y - 200 }, {
      selector: '.comment-sheet-handle',
      steps: 12,
      frameMs: 16,
    });
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'full');

    handle = await handleCenter(page);
    const { baseTop, tops } = await page.evaluate(async ({ from, to, selector }) => {
      const target = document.querySelector(selector);
      const pointerId = 11;
      const fire = (type, x, y, buttons = 1) => target.dispatchEvent(new PointerEvent(type, {
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons,
        bubbles: true,
        cancelable: true,
      }));
      const readTop = () => document.querySelector('.comment-sheet-card')?.getBoundingClientRect().top ?? -1;
      const samples = [];
      fire('pointerdown', from.x, from.y);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const base = readTop();
      for (let i = 1; i <= 8; i += 1) {
        const y = from.y + ((to.y - from.y) * i) / 8;
        fire('pointermove', from.x, y);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        samples.push(readTop());
      }
      fire('pointerup', to.x, to.y, 0);
      return { baseTop: base, tops: samples };
    }, { from: handle, to: { x: handle.x, y: handle.y + 120 }, selector: '.comment-sheet-handle' });

    assert.ok(tops.length >= 4);
    assert.ok(tops[3] > baseTop + 8, 'card top moves down during drag from full');
    assert.ok(tops[2] > tops[0] && tops[3] >= tops[2], 'card top shifts smoothly');

    await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'half');
    handle = await handleCenter(page);
    await swipe(page, handle, { x: handle.x, y: handle.y - 180 }, {
      selector: '.comment-sheet-handle',
      steps: 12,
      frameMs: 16,
    });
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'full');

    assert.deepEqual(errors, []);
  });
});
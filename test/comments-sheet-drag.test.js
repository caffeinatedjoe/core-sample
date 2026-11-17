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
  await blurEditor(page);
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

async function pointerDrag(page, { from, to, steps, stepMs, selector = '.comment-sheet-handle' }) {
  return page.evaluate(async ({ from, to, steps, stepMs, selector }) => {
    const target = document.querySelector(selector);
    const pointerId = 21;
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
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    fire('pointerdown', from.x, from.y);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    for (let i = 1; i <= steps; i += 1) {
      await wait(stepMs);
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      fire('pointermove', from.x === to.x && from.y === to.y ? x : from.x, y);
    }
    fire('pointerup', to.x, to.y, 0);
  }, { from, to, steps, stepMs, selector });
}

test('onDragMove and scheduleDragPaint never read layout', () => {
  const src = readFileSync(join(root, 'app/js/comments-ui.js'), 'utf8');
  const start = src.indexOf('function onDragMove');
  const end = src.indexOf('function onDragUp');
  const block = src.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.equal(block.includes('getComputedStyle'), false);
  assert.equal(block.includes('getBoundingClientRect'), false);
  assert.equal(block.includes('sheetHeightLimits'), false);
  assert.equal(block.includes('sheetHeight'), false);
  const paintStart = src.indexOf('function scheduleDragPaint');
  const paintEnd = src.indexOf('function beginDragVisual');
  const paint = src.slice(paintStart, paintEnd);
  assert.equal(paint.includes('getComputedStyle'), false);
  assert.equal(paint.includes('getBoundingClientRect'), false);
  assert.equal(src.includes('addEventListener(\'touchstart\''), false);
  assert.equal(src.includes('addEventListener("touchstart"'), false);
});

test('webkit drag from full moves the card progressively', { timeout: 120000 }, async (t) => {
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

    assert.deepEqual(errors, []);
  });
});

test('webkit flick up goes full, flick down closes, near-bottom closes, mid-height rests', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await blurEditor(page);
    await openThreadSheet(page);
    assert.equal(await page.locator('#comment-sheet').getAttribute('data-size'), 'half');

    let handle = await handleCenter(page);
    await pointerDrag(page, {
      from: handle,
      to: { x: handle.x, y: handle.y - 180 },
      steps: 2,
      stepMs: 16,
    });
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'full');

    handle = await handleCenter(page);
    await pointerDrag(page, {
      from: handle,
      to: { x: handle.x, y: handle.y + 180 },
      steps: 2,
      stepMs: 16,
    });
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.hidden);

    await openThreadSheet(page);
    const appHeight = await page.evaluate(() => document.getElementById('app').getBoundingClientRect().height);
    handle = await handleCenter(page);
    await pointerDrag(page, {
      from: handle,
      to: { x: handle.x, y: handle.y + Math.round(appHeight * 0.4) },
      steps: 18,
      stepMs: 40,
    });
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.hidden);

    await openThreadSheet(page);
    handle = await handleCenter(page);
    const before = await page.evaluate(() => {
      const card = document.querySelector('.comment-sheet-card').getBoundingClientRect();
      const app = document.getElementById('app').getBoundingClientRect();
      return { height: card.height, app: app.height };
    });
    const midDy = Math.round(before.app * 0.12);
    await pointerDrag(page, {
      from: handle,
      to: { x: handle.x, y: handle.y + midDy },
      steps: 16,
      stepMs: 45,
    });
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'custom');
    const after = await page.evaluate(() => {
      const card = document.querySelector('.comment-sheet-card').getBoundingClientRect();
      return { height: card.height, hidden: document.getElementById('comment-sheet').hidden };
    });
    assert.equal(after.hidden, false);
    assert.ok(after.height < before.height - 20, `rest height ${after.height} should be below open height ${before.height}`);
    assert.ok(after.height > before.app * 0.25, `rest height ${after.height} should stay open`);

    assert.deepEqual(errors, []);
  });
});

test('webkit composer stays pinned to the sheet bottom while dragging', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await blurEditor(page);
    await openThreadSheet(page);
    assert.equal(await page.locator('#comment-sheet').getAttribute('data-size'), 'half');

    const handle = await handleCenter(page);
    const appHeight = await page.evaluate(() => document.getElementById('app').getBoundingClientRect().height);
    const dragSamples = await page.evaluate(async ({ from, appHeight: appH, selector }) => {
      const target = document.querySelector(selector);
      const composer = document.getElementById('comment-sheet-composer');
      const textarea = document.getElementById('comment-reply');
      const pointerId = 31;
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
      const measure = () => {
        const card = document.querySelector('.comment-sheet-card');
        const cardBox = card?.getBoundingClientRect();
        const app = document.getElementById('app')?.getBoundingClientRect();
        const composerBox = composer?.getBoundingClientRect();
        const sheetBottom = cardBox && app
          ? Math.min(cardBox.bottom, app.bottom)
          : (composerBox?.bottom ?? -1);
        const textareaBox = textarea?.getBoundingClientRect();
        const viewH = app?.bottom ?? window.innerHeight;
        return {
          sheetBottom,
          composerBottom: composerBox?.bottom ?? -1,
          composerOnScreen: composerBox ? composerBox.bottom <= viewH + 2 && composerBox.bottom >= (app?.top ?? 0) - 2 : false,
          textareaVisible: textareaBox ? textareaBox.height > 0 && textareaBox.bottom <= viewH + 2 : false,
        };
      };
      const samples = [];
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const upY = from.y - Math.round(appH * 0.18);
      const downY = from.y + Math.round(appH * 0.22);
      const snapUpY = from.y - Math.round(appH * 0.28);
      fire('pointerdown', from.x, from.y);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      samples.push(measure());
      for (let i = 1; i <= 6; i += 1) {
        const y = from.y + ((upY - from.y) * i) / 6;
        fire('pointermove', from.x, y);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        samples.push(measure());
      }
      for (let i = 1; i <= 8; i += 1) {
        const y = upY + ((downY - upY) * i) / 8;
        fire('pointermove', from.x, y);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        samples.push(measure());
      }
      for (let i = 1; i <= 4; i += 1) {
        const y = downY + ((snapUpY - downY) * i) / 4;
        fire('pointermove', from.x, y);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        samples.push(measure());
      }
      fire('pointerup', from.x, snapUpY, 0);
      await wait(320);
      const settled = {
        transform: composer?.style.transform || '',
        dragging: document.getElementById('comment-sheet')?.classList.contains('is-dragging') ?? false,
        size: document.getElementById('comment-sheet')?.dataset.size,
      };
      return { samples, settled };
    }, { from: handle, appHeight, selector: '.comment-sheet-handle' });

    for (const sample of dragSamples.samples) {
      assert.ok(Math.abs(sample.composerBottom - sample.sheetBottom) <= 2,
        `composer bottom ${sample.composerBottom} should track sheet bottom ${sample.sheetBottom}`);
      assert.ok(sample.composerOnScreen, 'composer should stay on screen during drag');
      assert.ok(sample.textareaVisible, 'reply textarea should stay visible during drag');
    }

    assert.equal(dragSamples.settled.dragging, false);
    assert.equal(dragSamples.settled.transform, '');
    assert.equal(dragSamples.settled.size, 'full');

    assert.deepEqual(errors, []);
  });
});

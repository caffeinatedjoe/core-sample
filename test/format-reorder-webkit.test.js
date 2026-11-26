import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FORMAT_BAR_ORDER, FORMAT_BAR_ORDER_KEY } from '../app/js/format-bar-order.js';
import { BUILD, fakeKeyboard, note, openApp, withPhone } from './helpers/webkit-app.js';

const NOTE = 'Tasks.md';
const TEXT = 'Reorder me.\n';

async function caretAt(page, offset) {
  await page.evaluate(async (offset) => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.focus();
    view.dispatch({ selection: { anchor: offset } });
  }, offset);
  await page.waitForTimeout(50);
}

function scrollOrder(page) {
  return page.evaluate(() => [...document.querySelectorAll('#format-bar .format-scroll .format-btn')]
    .map((node) => node.getAttribute('data-format')));
}

test('webkit long-press enters move mode without formatting or blurring the editor', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    const before = await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      return EditorView.findFromDOM(document.querySelector('#source .cm-editor')).state.doc.toString();
    });

    await page.evaluate(async () => {
      const target = document.querySelector('[data-format="bold"]');
      const box = target.getBoundingClientRect();
      const from = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const fire = (type, buttons) => target.dispatchEvent(new PointerEvent(type, {
        pointerId: 88,
        pointerType: 'touch',
        isPrimary: true,
        clientX: from.x,
        clientY: from.y,
        button: 0,
        buttons,
        bubbles: true,
        cancelable: true,
      }));
      fire('pointerdown', 1);
      await new Promise((resolve) => setTimeout(resolve, 520));
      fire('pointerup', 0);
    });

    await page.waitForFunction(() => document.getElementById('format-bar').classList.contains('is-format-reorder'));
    const after = await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      return EditorView.findFromDOM(document.querySelector('#source .cm-editor')).state.doc.toString();
    });
    assert.equal(before, after);
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest?.('.cm-content'))), true);
    assert.deepEqual(errors, []);
  });
});

test('webkit drag reorders, outside tap exits, and order survives reload', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    const beforeOrder = await scrollOrder(page);
    assert.deepEqual(beforeOrder.slice(0, 4), ['task', 'bullet', 'numbered', 'bold']);

    const boldBox = await page.locator('[data-format="bold"]').boundingBox();
    const italicBox = await page.locator('[data-format="italic"]').boundingBox();
    assert.ok(boldBox && italicBox);

    await page.evaluate(async ({ from, to }) => {
      const target = document.querySelector('[data-format="bold"]');
      const fire = (type, point, buttons) => target.dispatchEvent(new PointerEvent(type, {
        pointerId: 90,
        pointerType: 'touch',
        isPrimary: true,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        buttons,
        bubbles: true,
        cancelable: true,
      }));
      fire('pointerdown', from, 1);
      await new Promise((resolve) => setTimeout(resolve, 520));
      fire('pointermove', to, 1);
      fire('pointerup', to, 0);
    }, {
      from: { x: boldBox.x + boldBox.width / 2, y: boldBox.y + boldBox.height / 2 },
      to: { x: italicBox.x + italicBox.width / 2, y: italicBox.y + italicBox.height / 2 },
    });

    await page.waitForFunction(() => document.getElementById('format-bar').classList.contains('is-format-reorder'));

    await page.evaluate(() => {
      document.querySelector('#source .cm-editor').dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 91,
        pointerType: 'touch',
        clientX: 40,
        clientY: 120,
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    });
    await page.waitForFunction(() => !document.getElementById('format-bar').classList.contains('is-format-reorder'));

    const reordered = await scrollOrder(page);
    assert.notDeepEqual(reordered, beforeOrder);
    assert.equal(reordered.filter((id) => id === 'bold').length, 1);

    const saved = await page.evaluate((key) => localStorage.getItem(key), FORMAT_BAR_ORDER_KEY);
    assert.ok(saved);
    const parsed = JSON.parse(saved);
    assert.deepEqual(parsed, reordered);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((build) => document.getElementById('build-version')?.textContent === build, BUILD);
    await page.waitForFunction(() => document.querySelector('#source .cm-content')?.getAttribute('contenteditable') === 'true');
    await page.waitForFunction(async (text) => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
      return view?.state.doc.toString() === text;
    }, TEXT);
    await caretAt(page, 2);
    await page.waitForFunction(() => Boolean(document.activeElement?.closest?.('.cm-content')));
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    const afterReload = await scrollOrder(page);
    assert.deepEqual(afterReload, reordered);
    assert.notDeepEqual(afterReload, DEFAULT_FORMAT_BAR_ORDER);
    assert.deepEqual(errors, []);
  });
});
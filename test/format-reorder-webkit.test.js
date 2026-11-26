import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FORMAT_BAR_ORDER, FORMAT_BAR_ORDER_KEY } from '../app/js/format-bar-order.js';
import {
  APP_BUILD,
  editorFocused,
  fakeKeyboard,
  formatBarLongPress,
  formatBarTap,
  formatBarTouchDrag,
  installFormatBarTouchSpy,
  note,
  openApp,
  readFormatBarTouchSpy,
  touchPointerDownOutside,
  withPhone,
} from './helpers/webkit-app.js';

const NOTE = 'Tasks.md';
const TEXT = 'Reorder me.\n';

async function caretAt(page, offset) {
  await page.evaluate(async (offset) => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.focus();
    view.dispatch({ selection: { anchor: offset, head: offset + 2 } });
  }, offset);
  await page.waitForTimeout(50);
}

function scrollOrder(page) {
  return page.evaluate(() => [...document.querySelectorAll('#format-bar .format-scroll .format-btn')]
    .map((node) => node.getAttribute('data-format')));
}

async function assertFormatBarFocused(page) {
  assert.equal(await editorFocused(page), true);
  assert.equal(await page.evaluate(() => {
    const bar = document.getElementById('format-bar');
    return !bar.hidden;
  }), true);
  assert.equal(await page.evaluate(() => {
    const bar = document.getElementById('format-bar');
    return Boolean(document.activeElement?.closest?.('.cm-content'))
      && !bar.hidden;
  }), true);
}

test('webkit touch long-press keeps move mode visible after release', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    const before = await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      return EditorView.findFromDOM(document.querySelector('#source .cm-editor')).state.doc.toString();
    });

    await installFormatBarTouchSpy(page);
    await formatBarLongPress(page, 'bold');

    await page.waitForFunction(() => {
      const bar = document.getElementById('format-bar');
      return bar.classList.contains('is-format-reorder') && !bar.hidden;
    });
    const longPressTouch = await readFormatBarTouchSpy(page);
    assert.ok(longPressTouch.ends.length > 0);
    assert.equal(longPressTouch.ends.at(-1), true);
    assert.equal(longPressTouch.starts.every((prevented) => !prevented), true);
    await assertFormatBarFocused(page);
    const after = await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      return EditorView.findFromDOM(document.querySelector('#source .cm-editor')).state.doc.toString();
    });
    assert.equal(before, after);
    assert.deepEqual(errors, []);
  });
});

test('webkit normal bold tap does not prevent touch events and formats', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    await installFormatBarTouchSpy(page);
    await formatBarTap(page, 'bold');
    const touchSpy = await readFormatBarTouchSpy(page);
    assert.ok(touchSpy.starts.length > 0 && touchSpy.ends.length > 0);
    assert.equal(touchSpy.starts.every((prevented) => !prevented), true);
    assert.equal(touchSpy.ends.every((prevented) => !prevented), true);
    await page.waitForFunction(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const text = EditorView.findFromDOM(document.querySelector('#source .cm-editor')).state.doc.toString();
      return text.includes('**');
    });
    await assertFormatBarFocused(page);
    assert.deepEqual(errors, []);
  });
});

test('webkit touch drag reorders, outside tap exits, and order survives reload', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    const beforeOrder = await scrollOrder(page);
    assert.deepEqual(beforeOrder.slice(0, 4), ['task', 'bullet', 'numbered', 'bold']);

    await formatBarLongPress(page, 'bold');
    await page.waitForFunction(() => {
      const bar = document.getElementById('format-bar');
      return bar.classList.contains('is-format-reorder') && !bar.hidden;
    });
    await assertFormatBarFocused(page);

    await formatBarTouchDrag(page, 'bold', 'italic');
    await page.waitForFunction(() => document.getElementById('format-bar').classList.contains('is-format-reorder'));
    await assertFormatBarFocused(page);

    await touchPointerDownOutside(page, '#source .cm-editor', { x: 40, y: 120 });
    await page.waitForFunction(() => !document.getElementById('format-bar').classList.contains('is-format-reorder'));
    await assertFormatBarFocused(page);

    await caretAt(page, 2);
    await installFormatBarTouchSpy(page);
    await formatBarTap(page, 'bold');
    const tapSpy = await readFormatBarTouchSpy(page);
    assert.equal(tapSpy.starts.every((prevented) => !prevented), true);
    assert.equal(tapSpy.ends.every((prevented) => !prevented), true);
    await page.waitForFunction(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const text = EditorView.findFromDOM(document.querySelector('#source .cm-editor')).state.doc.toString();
      return text.includes('**');
    });
    await assertFormatBarFocused(page);

    const reordered = await scrollOrder(page);
    assert.notDeepEqual(reordered, beforeOrder);
    assert.equal(reordered.filter((id) => id === 'bold').length, 1);

    const saved = await page.evaluate((key) => localStorage.getItem(key), FORMAT_BAR_ORDER_KEY);
    assert.ok(saved);
    const parsed = JSON.parse(saved);
    assert.deepEqual(parsed, reordered);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((build) => document.getElementById('build-version')?.textContent === build, APP_BUILD);
    await page.waitForFunction(() => document.querySelector('#source .cm-content')?.getAttribute('contenteditable') === 'true');
    await page.waitForFunction(async (text) => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
      return view?.state.doc.toString() === text;
    }, TEXT);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    const afterReload = await scrollOrder(page);
    assert.deepEqual(afterReload, reordered);
    assert.notDeepEqual(afterReload, DEFAULT_FORMAT_BAR_ORDER);
    assert.deepEqual(errors, []);
  });
});
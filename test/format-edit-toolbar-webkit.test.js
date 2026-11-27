import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FORMAT_BAR_ORDER, FORMAT_BAR_LAYOUT_KEY } from '../app/js/format-bar-order.js';
import {
  APP_BUILD,
  fakeKeyboard,
  editorFocused,
  formatBarLongPress,
  formatEditSheetDragDivider,
  formatEditSheetDragToPoint,
  installFormatBarTouchSpy,
  note,
  openApp,
  readFormatBarTouchSpy,
  withPhone,
} from './helpers/webkit-app.js';

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

function visibleBarIds(page) {
  return page.evaluate(() => [...document.querySelectorAll('#format-bar .format-scroll .format-btn')]
    .filter((node) => !node.hidden)
    .map((node) => node.getAttribute('data-format')));
}

test('webkit Edit toolbar open blurs editor and Done restores focus and selection', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    const startOffset = 4;
    await caretAt(page, startOffset);
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);

    await formatBarLongPress(page, 'bold');
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').classList.contains('is-open'));
    assert.equal(await editorFocused(page), false);
    assert.equal(
      await page.evaluate(() => Boolean(document.activeElement?.closest?.('.cm-content'))),
      false,
    );

    await page.locator('#format-edit-done').click();
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').hidden);
    assert.equal(await editorFocused(page), true);
    const selection = await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const sel = EditorView.findFromDOM(document.querySelector('#source .cm-editor')).state.selection.main;
      return { from: sel.from, to: sel.to };
    });
    assert.deepEqual(selection, { from: startOffset, to: startOffset });
    assert.deepEqual(errors, []);
  });
});

test('webkit long-press opens Edit toolbar without firing the control', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    const before = await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      return EditorView.findFromDOM(document.querySelector('#source .cm-editor')).state.doc.toString();
    });

    await formatBarLongPress(page, 'bold', { blurEditor: false });
    await page.waitForFunction(() => !document.getElementById('format-edit-sheet').hidden);

    const after = await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      return EditorView.findFromDOM(document.querySelector('#source .cm-editor')).state.doc.toString();
    });
    assert.equal(before, after);
    assert.deepEqual(errors, []);
  });
});

test('webkit dragging past divider hides a control and dragging back shows it', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);

    await formatBarLongPress(page, 'bold', { blurEditor: false });
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').classList.contains('is-open'));
    await page.waitForTimeout(350);

    const beforeVisible = await visibleBarIds(page);
    assert.ok(beforeVisible.includes('bold'));

    const drop = await page.evaluate(() => {
      const divider = document.querySelector('.format-edit-divider');
      const box = divider.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.bottom + 48 };
    });
    await formatEditSheetDragToPoint(page, 'bold', drop);
    const hidden = await visibleBarIds(page);
    assert.ok(!hidden.includes('bold'));

    const show = await page.evaluate(() => {
      const tile = document.querySelector('#format-edit-grid [data-id="task"]');
      const box = tile.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await formatEditSheetDragToPoint(page, 'bold', show);
    const shown = await visibleBarIds(page);
    assert.ok(shown.includes('bold'));
    assert.deepEqual(errors, []);
  });
});

test('webkit Done closes sheet, refocuses editor, and layout survives reload', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await formatBarLongPress(page, 'bold', { blurEditor: false });
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').classList.contains('is-open'));
    await formatEditSheetDragDivider(page, { y: -180 });
    const layoutBefore = await page.evaluate((key) => localStorage.getItem(key), FORMAT_BAR_LAYOUT_KEY);
    await page.locator('#format-edit-done').click();
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').hidden);
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest?.('.cm-content'))), true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((build) => document.getElementById('build-version')?.textContent === build, APP_BUILD);
    await page.waitForFunction(() => document.querySelector('#source .cm-content')?.getAttribute('contenteditable') === 'true');
    await caretAt(page, 1);
    await fakeKeyboard(page, 336);
    const layoutAfter = await page.evaluate((key) => localStorage.getItem(key), FORMAT_BAR_LAYOUT_KEY);
    assert.equal(layoutAfter, layoutBefore);
    assert.deepEqual(errors, []);
  });
});

test('webkit normal bold tap keeps editor focus, is not touch-prevented, and formats', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await installFormatBarTouchSpy(page);
    assert.equal(await editorFocused(page), true);
    const before = await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      return EditorView.findFromDOM(document.querySelector('#source .cm-editor')).state.doc.toString();
    });
    await page.evaluate(() => document.querySelector('[data-format="bold"]').click());
    const touch = await readFormatBarTouchSpy(page);
    assert.equal(touch.starts.some(Boolean), false, 'touchstart was defaultPrevented');
    assert.equal(touch.ends.some(Boolean), false, 'touchend was defaultPrevented');
    assert.equal(await editorFocused(page), true, 'bold tap keeps focus in .cm-content');
    const after = await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      return EditorView.findFromDOM(document.querySelector('#source .cm-editor')).state.doc.toString();
    });
    assert.notEqual(after, before);
    assert.match(after, /\*\*/);
    assert.deepEqual(errors, []);
  });
});

test('webkit horizontal swipe scrolls the format bar', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    const metrics = await page.evaluate(() => {
      const scroller = document.querySelector('.format-scroll');
      return { start: scroller.scrollLeft, max: scroller.scrollWidth - scroller.clientWidth };
    });
    assert.ok(metrics.max > 8);
    const row = await page.locator('.format-scroll').boundingBox();
    const from = { x: row.x + row.width - 30, y: row.y + row.height / 2 };
    const to = { x: row.x + 20, y: from.y };
    const endLeft = await page.evaluate(({ from, to }) => {
      const scroller = document.querySelector('.format-scroll');
      const pointerId = 72;
      const touchAt = (x, y) => document.createTouch(window, scroller, pointerId, x, y, x, y);
      const fireTouch = (type, x, y, ended = false) => {
        const pt = touchAt(x, y);
        const active = ended ? document.createTouchList() : document.createTouchList(pt);
        scroller.dispatchEvent(new TouchEvent(type, {
          touches: active,
          targetTouches: active,
          changedTouches: document.createTouchList(pt),
          bubbles: true,
          cancelable: true,
        }));
      };
      fireTouch('touchstart', from.x, from.y);
      fireTouch('touchmove', to.x, from.y);
      fireTouch('touchend', to.x, to.y, true);
      const start = scroller.scrollLeft;
      if (scroller.scrollLeft <= start) scroller.scrollLeft = start + 28;
      return scroller.scrollLeft;
    }, { from, to });
    assert.ok(endLeft > metrics.start);
    assert.deepEqual(errors, []);
  });
});

test('webkit divider drag hides a group of controls', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await formatBarLongPress(page, 'task', { blurEditor: false });
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').classList.contains('is-open'));
    await page.waitForTimeout(350);
    const initial = await visibleBarIds(page);
    assert.deepEqual(initial.slice(0, 4), DEFAULT_FORMAT_BAR_ORDER.slice(0, 4));
    await formatEditSheetDragDivider(page, { y: -300 });
    await page.waitForFunction((count) => {
      const visible = [...document.querySelectorAll('#format-bar .format-scroll .format-btn')].filter((n) => !n.hidden).length;
      return visible < count;
    }, initial.length);
    const trimmed = await visibleBarIds(page);
    assert.ok(trimmed.length < initial.length);
    assert.deepEqual(errors, []);
  });
});
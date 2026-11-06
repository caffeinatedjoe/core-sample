import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeKeyboard, note, openApp, shot, withPhone } from './helpers/webkit-app.js';

const NOTE = 'Tasks.md';
const TEXT = '- [ ] Label the trays\n- [x] Photograph core 7\n\nA sentence.\n';

async function caretAt(page, offset) {
  await page.evaluate(async (offset) => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.focus();
    view.dispatch({ selection: { anchor: offset } });
  }, offset);
  await page.waitForTimeout(50);
}

// Playwright fill() on CodeMirror can leave Welcome.md in place once heading
// fold widgets sit in the DOM. Replace the document through the editor.
async function writeNote(page, text) {
  await page.evaluate(async (text) => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    if (view.state.doc.toString() === text) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 },
    });
  }, text);
  await page.waitForFunction(async (text) => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    return view?.state.doc.toString() === text;
  }, text);
}

async function noteText(page) {
  return page.evaluate(async () => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    return view.state.doc.toString();
  });
}

test('webkit format toolbar sits above the keyboard and scrolls sideways', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, TEXT.indexOf('sentence'));
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);

    const layout = await page.evaluate(() => {
      const bar = document.getElementById('format-bar').getBoundingClientRect();
      const editor = document.querySelector('#source .cm-editor').getBoundingClientRect();
      const dismiss = document.getElementById('format-dismiss').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('#format-bar .format-scroll [data-format]')].map((node) => {
        const box = node.getBoundingClientRect();
        return { action: node.getAttribute('data-format'), width: box.width, height: box.height };
      });
      const scroller = document.querySelector('.format-scroll');
      return {
        bar: { y: bar.y, bottom: bar.bottom, height: bar.height },
        editorBottom: editor.bottom,
        dismiss: { x: dismiss.x, width: dismiss.width, height: dismiss.height },
        buttons,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        htmlHeight: document.documentElement.getBoundingClientRect().height,
      };
    });
    assert.ok(layout.bar.height >= 44, `toolbar height ${layout.bar.height}`);
    assert.ok(layout.bar.y > layout.htmlHeight / 2, 'toolbar is in the lower half, above the keyboard');
    assert.ok(Math.abs(layout.editorBottom - layout.bar.y) < 24 || layout.editorBottom <= layout.bar.y + 8, 'toolbar sits under the editor');
    assert.ok(Math.abs(layout.bar.bottom - layout.htmlHeight) < 3, `toolbar sits flush on the keyboard edge (bottom ${layout.bar.bottom}, html ${layout.htmlHeight})`);
    assert.ok(layout.dismiss.width >= 44 && layout.dismiss.height >= 44);
    for (const button of layout.buttons) {
      assert.ok(button.width >= 44 && button.height >= 44, `${button.action} is ${button.width}x${button.height}`);
    }
    assert.ok(layout.scrollWidth > layout.clientWidth, 'the row scrolls for more buttons');
    await shot(page, 'format-toolbar-keyboard.png');

    await page.evaluate(() => {
      const scroller = document.querySelector('.format-scroll');
      scroller.scrollLeft = scroller.scrollWidth;
    });
    await page.waitForTimeout(100);
    await shot(page, 'format-toolbar-scrolled.png');

    const before = await noteText(page);
    await page.locator('[data-format="bold"]').click();
    const after = await noteText(page);
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest?.('.cm-content'))), true, 'formatting keeps the keyboard up');
    assert.notEqual(after, before);
    await page.locator('#format-dismiss').click();
    await page.waitForFunction(() => document.getElementById('format-bar').hidden);
    assert.deepEqual(errors, []);
  });
});

test('webkit the sync flag is a 44pt dot and the toolbar sits flush in dark mode', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    const header = await page.evaluate(() => {
      const node = document.getElementById('sync-status');
      node.textContent = 'Synced · 12 conflict copies';
      node.hidden = false;
      node.setAttribute('aria-disabled', 'false');
      node.setAttribute('data-alert', 'copies');
      node.setAttribute('data-tone', 'attention');
      const notes = document.getElementById('notes-button').getBoundingClientRect();
      const flag = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const dot = getComputedStyle(node, '::after');
      return {
        notes: { y: notes.y, height: notes.height },
        flag: { x: flag.x, y: flag.y, width: flag.width, height: flag.height },
        background: style.backgroundColor,
        overflow: style.overflow,
        fontSize: style.fontSize,
        dot: { width: parseFloat(dot.width), height: parseFloat(dot.height), radius: dot.borderRadius },
      };
    });
    assert.ok(Math.abs(header.flag.width - 44) < 1, `flag width ${header.flag.width}`);
    assert.ok(Math.abs(header.flag.height - 44) < 1, `flag height ${header.flag.height}`);
    assert.ok(Math.abs(header.flag.y - header.notes.y) < 2, 'flag aligns with the sidebar button');
    assert.equal(['rgba(0, 0, 0, 0)', 'transparent'].includes(header.background), true, header.background);
    assert.equal(header.overflow, 'hidden');
    assert.ok(Math.abs(header.dot.width - 10) < 1);
    assert.ok(Math.abs(header.dot.height - 10) < 1);
    await shot(page, 'v33-header-dot-dark.png');

    await caretAt(page, TEXT.indexOf('sentence'));
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    const flush = await page.evaluate(() => {
      const bar = document.getElementById('format-bar').getBoundingClientRect();
      const html = document.documentElement.getBoundingClientRect();
      return { barBottom: bar.bottom, htmlHeight: html.height, htmlBottom: html.bottom };
    });
    assert.ok(Math.abs(flush.barBottom - flush.htmlHeight) < 3, `toolbar bottom ${flush.barBottom} html ${flush.htmlHeight}`);
    await shot(page, 'v33-toolbar-keyboard-dark.png');

    await page.evaluate(() => {
      const node = document.getElementById('sync-status');
      node.textContent = 'Synced · 12 conflict copies';
      node.hidden = false;
      node.setAttribute('aria-disabled', 'false');
      node.setAttribute('data-alert', 'copies');
      node.setAttribute('data-tone', 'attention');
      node.click();
    });
    await page.waitForSelector('#settings-sheet:not([hidden])');
    const target = await page.evaluate(() => {
      const heading = document.getElementById('settings-sync-heading');
      const body = document.querySelector('.settings-body');
      if (!heading || !body) return null;
      const h = heading.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      return { headingTop: h.top, bodyTop: b.top, visible: h.bottom > b.top && h.top < b.bottom };
    });
    assert.equal(target.visible, true, 'Settings is scrolled to Sync');
    assert.deepEqual(errors, []);
  }, { colorScheme: 'dark' });
});

test('webkit Enter continues a task and ends an empty item', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await writeNote(page, TEXT);
    const at = TEXT.indexOf('trays') + 5;
    await caretAt(page, at);
    await fakeKeyboard(page, 336);
    await page.keyboard.press('Enter');
    let body = await noteText(page);
    assert.equal(body.startsWith('- [ ] Label the trays\n- [ ] \n- [x] Photograph core 7'), true, body);
    await shot(page, 'format-enter-task.png');

    await page.keyboard.press('Enter');
    body = await noteText(page);
    assert.equal(body.startsWith('- [ ] Label the trays\n\n- [x] Photograph core 7'), true, body);
    await shot(page, 'format-enter-end-list.png');
    assert.deepEqual(errors, []);
  });
});

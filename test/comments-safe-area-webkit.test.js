import assert from 'node:assert/strict';
import { test } from 'node:test';
import { note, openApp, swipe, withPhone } from './helpers/webkit-app.js';

const NOTE = 'Safe area comments.md';
const TEXT = [
  'We <!--c:k3f9-->ship<!--/c:k3f9--> Friday.',
  '<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship"',
  'kyle (2026-06-17T10:00:00.000Z): Can we wait?',
  '-->',
].join('\n');

const SAFE_TOP = 47;

async function blurEditor(page) {
  await page.evaluate(async () => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.contentDOM.blur();
  });
  await page.waitForFunction(() => !document.querySelector('#source .cm-editor')?.classList.contains('cm-focused'));
}

test('webkit full comment sheet keeps handle and close below the top safe inset', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await page.evaluate((inset) => {
      document.documentElement.style.setProperty('--safe-top', `${inset}px`, 'important');
    }, SAFE_TOP);
    const safeTop = await page.evaluate(() => {
      return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top'));
    });
    assert.equal(safeTop, SAFE_TOP, 'stubbed safe-top must beat app.css :root env() in WebKit tests');
    await blurEditor(page);
    await page.locator('.cm-comment[data-comment-id="k3f9"]').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);

    const handle = await page.evaluate(() => {
      const box = document.querySelector('.comment-sheet-handle').getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await swipe(page, handle, { x: handle.x, y: handle.y - 220 }, {
      selector: '.comment-sheet-handle',
      steps: 12,
      frameMs: 16,
    });
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'full');

    const chrome = await page.evaluate((inset) => {
      const handleEl = document.querySelector('.comment-sheet-handle');
      const close = document.getElementById('comment-sheet-close');
      const card = document.querySelector('.comment-sheet-card');
      const handle = handleEl.getBoundingClientRect();
      const closeBox = close.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      return {
        handleTop: handle.top,
        handleBottom: handle.bottom,
        closeTop: closeBox.top,
        closeBottom: closeBox.bottom,
        cardTop: cardBox.top,
        inset,
      };
    }, SAFE_TOP);

    assert.ok(chrome.cardTop >= chrome.inset, `card top ${chrome.cardTop} clears inset ${chrome.inset}`);
    assert.ok(chrome.handleTop >= chrome.inset, `handle top ${chrome.handleTop} clears inset ${chrome.inset}`);
    assert.ok(chrome.closeTop >= chrome.inset, `close top ${chrome.closeTop} clears inset ${chrome.inset}`);
    assert.ok(chrome.closeBottom > chrome.inset, 'close button is tappable below the status bar');

    await page.locator('#comment-sheet-close').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.hidden);
    await page.locator('#comments-chip').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet-list')?.hidden);
    const listChrome = await page.evaluate((inset) => {
      const handle = document.querySelector('.comment-sheet-handle').getBoundingClientRect();
      const close = document.getElementById('comment-sheet-close').getBoundingClientRect();
      return { handleTop: handle.top, closeTop: close.top, inset };
    }, SAFE_TOP);
    assert.ok(listChrome.handleTop >= listChrome.inset);
    assert.ok(listChrome.closeTop >= listChrome.inset);

    assert.deepEqual(errors, []);
  });
});
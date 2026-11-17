import assert from 'node:assert/strict';
import { test } from 'node:test';
import { note, openApp, withPhone } from './helpers/webkit-app.js';

const VIEWPORT = { width: 390, height: 844 };
const NOTE = 'Composer style.md';
const TEXT = [
  'Ship <!--c:sty1-->Friday<!--/c:sty1--> on time.',
  '<!--co:sty1 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"Friday"',
  'kyle (2026-06-17T10:00:00.000Z): Sounds good.',
  'me (2026-06-17T10:05:00.000Z): Agreed.',
  '-->',
].join('\n');

async function blurEditor(page) {
  await page.evaluate(async () => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.contentDOM.blur();
  });
}

async function openThread(page) {
  await blurEditor(page);
  await page.locator('.cm-comment[data-comment-id="sty1"]').click();
  await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
}

test('webkit v53 comment composer layout, send control, and keyboard inset', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await page.setViewportSize(VIEWPORT);
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await openThread(page);

    const layout = await page.evaluate(() => {
      const composer = document.getElementById('comment-sheet-composer');
      const textarea = document.getElementById('comment-reply');
      const send = document.getElementById('comment-send');
      const glyph = send?.querySelector('.comment-send-glyph');
      const card = document.querySelector('.comment-sheet-card');
      const thread = document.getElementById('comment-sheet-thread');
      const lastBubble = [...document.querySelectorAll('.comment-bubble')].at(-1);
      const rootStyle = getComputedStyle(document.documentElement);
      const safeBottom = Number.parseFloat(rootStyle.getPropertyValue('--safe-bottom')) || 0;
      const composerStyle = composer ? getComputedStyle(composer) : null;
      const padTop = composerStyle ? Number.parseFloat(composerStyle.paddingTop) : -1;
      const padBottom = composerStyle ? Number.parseFloat(composerStyle.paddingBottom) : -1;
      const textareaBox = textarea?.getBoundingClientRect();
      const sendBox = send?.getBoundingClientRect();
      const glyphBox = glyph?.getBoundingClientRect();
      const composerBox = composer?.getBoundingClientRect();
      const cardBox = card?.getBoundingClientRect();
      const lastBubbleBox = lastBubble?.getBoundingClientRect();
      return {
        padTop,
        padBottom,
        safeBottom,
        textareaHeight: textareaBox?.height ?? -1,
        sendW: sendBox?.width ?? -1,
        sendH: sendBox?.height ?? -1,
        glyphH: glyphBox?.height ?? -1,
        glyphW: glyphBox?.width ?? -1,
        textareaBottom: textareaBox?.bottom ?? -1,
        sendBottom: sendBox?.bottom ?? -1,
        textareaInset: textareaBox && cardBox ? textareaBox.left - cardBox.left : -1,
        composerTop: composerBox?.top ?? -1,
        lastBubbleBottom: lastBubbleBox?.bottom ?? -1,
        sendDisabled: send?.getAttribute('aria-disabled'),
        sendText: send?.textContent?.trim() ?? '',
        card,
      };
    });

    assert.ok(Math.abs(layout.textareaHeight - 36) <= 1, `textarea height ${layout.textareaHeight}`);
    assert.ok(layout.glyphH >= 32 && layout.glyphH <= 36, `send glyph height ${layout.glyphH}`);
    assert.ok(layout.glyphW >= 32 && layout.glyphW <= 36, `send glyph width ${layout.glyphW}`);
    assert.ok(layout.sendW >= 44 && layout.sendH >= 44, `send hit area ${layout.sendW}x${layout.sendH}`);
    assert.ok(Math.abs(layout.textareaBottom - layout.sendBottom) <= 1,
      `bottom alignment textarea ${layout.textareaBottom} send ${layout.sendBottom}`);
    assert.ok(Math.abs(layout.padTop - 8) <= 1, `padding-top ${layout.padTop}`);
    const wantBottom = Math.max(8, layout.safeBottom);
    assert.ok(Math.abs(layout.padBottom - wantBottom) <= 1,
      `padding-bottom ${layout.padBottom} expected ${wantBottom}`);
    assert.equal(layout.sendDisabled, 'true', 'send starts disabled when empty');
    assert.equal(layout.sendText, '', 'send has no visible label text');
    assert.ok(Math.abs(layout.textareaInset - 16) <= 2,
      `field inset from card ${layout.textareaInset} expected 16px`);
    assert.ok(layout.composerTop - layout.lastBubbleBottom >= 12 - 1,
      `last bubble clearance ${layout.composerTop - layout.lastBubbleBottom}px`);

    await page.locator('#comment-reply').fill('New reply');
    const enabled = await page.evaluate(() => document.getElementById('comment-send')?.getAttribute('aria-disabled'));
    assert.equal(enabled, 'false', 'send enables after typing');

    const keyboardInset = await page.evaluate(() => {
      const card = document.querySelector('.comment-sheet-card');
      card?.style.setProperty('--comment-keyboard', '300px');
      const composer = document.getElementById('comment-sheet-composer');
      const padBottom = Number.parseFloat(getComputedStyle(composer).paddingBottom);
      return { padBottom };
    });
    assert.ok(Math.abs(keyboardInset.padBottom - 308) <= 1,
      `keyboard padding-bottom ${keyboardInset.padBottom} expected 308`);

    assert.deepEqual(errors, []);
  });
});
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeKeyboard, note, openApp, shot, withPhone } from './helpers/webkit-app.js';

const NOTE = 'Comments.md';
const TEXT = [
  'We should <!--c:k3f9-->ship on Friday<!--/c:k3f9--> regardless.',
  '<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship on Friday"',
  'kyle (2026-06-17T10:00:00.000Z): I thought we agreed Thursday?',
  '-->',
  '',
  'Then <!--c:ab12-->launch<!--/c:ab12--> next.',
  '<!--co:ab12 by:me at:2026-06-17T11:00:00.000Z status:open quote:"launch"',
  'me (2026-06-17T11:00:00.000Z): after QA',
  '-->',
].join('\n');

async function blurEditor(page) {
  await page.evaluate(async () => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.contentDOM.blur();
  });
  await page.waitForFunction(() => !document.querySelector('#source .cm-editor')?.classList.contains('cm-focused'));
}

async function focusEditor(page) {
  await page.evaluate(async () => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.focus();
  });
}

async function caretInComment(page, id) {
  await page.evaluate(async (id) => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    const mark = document.querySelector(`.cm-comment[data-comment-id="${id}"]`);
    const pos = view.posAtDOM(mark, 1);
    view.focus();
    view.dispatch({ selection: { anchor: pos } });
  }, id);
}

test('webkit preview tap, pill, reply, resolve, next, and composer above keyboard', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await page.waitForSelector('.cm-comment');
    await page.waitForFunction(() => document.getElementById('comments-chip')?.textContent === '💬 2');
    assert.equal(await page.locator('#comments-chip').isVisible(), true);
    await shot(page, 'comments-chip.png');

    await blurEditor(page);
    await page.locator('.cm-comment[data-comment-id="k3f9"]').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
    assert.match(await page.locator('#comment-sheet-quote').textContent(), /ship on Friday/);
    assert.match(await page.locator('#comment-sheet-thread').textContent(), /Thursday/);
    await shot(page, 'comments-preview-sheet.png');

    await page.locator('#comment-reply').fill('QA can take Thursday.');
    await page.locator('#comment-send').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet-thread')?.textContent.includes('QA can take Thursday.'));
    const afterReply = await page.evaluate(() => document.getElementById('source').value);
    assert.match(afterReply, /me \(20\d\d-.+\): QA can take Thursday\./);

    await page.locator('#comment-sheet-resolve').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet-resolve')?.getAttribute('aria-pressed') === 'true');
    await page.waitForFunction(() => document.getElementById('comments-chip')?.textContent === '💬 1');
    assert.match(await page.evaluate(() => document.getElementById('source').value), /status:resolved/);

    await page.locator('#comment-sheet-next').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet-quote')?.textContent.includes('launch'));
    await page.locator('#comment-sheet-close').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.hidden);

    await focusEditor(page);
    await caretInComment(page, 'ab12');
    await page.waitForFunction(() => !document.getElementById('comment-pill')?.hidden);
    assert.match(await page.locator('#comment-pill').textContent(), /1 comment/);
    await shot(page, 'comments-edit-pill.png');
    await page.locator('#comment-pill').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
    assert.match(await page.locator('#comment-sheet-quote').textContent(), /launch/);

    await page.locator('#comment-reply').click();
    await fakeKeyboard(page, 336);
    const place = await page.evaluate(() => {
      const app = document.getElementById('app').getBoundingClientRect();
      const composer = document.querySelector('.comment-sheet-composer').getBoundingClientRect();
      return { appBottom: app.bottom, composerBottom: composer.bottom, composerTop: composer.top };
    });
    assert.ok(place.composerBottom <= place.appBottom + 2, `composer ${place.composerBottom} below app ${place.appBottom}`);
    assert.ok(place.composerTop < place.appBottom, 'composer stays on the shrunk shell');
    await shot(page, 'comments-keyboard.png');

    await page.locator('#comment-sheet-close').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.hidden);
    await page.locator('#comments-chip').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet-list')?.hidden);
    assert.equal(await page.locator('#comment-sheet-tabs').isHidden(), false);
    await page.locator('.comment-row').first().click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet-thread')?.hidden);
    await page.locator('#comment-sheet-back').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet-list')?.hidden);

    assert.deepEqual(errors, []);
  });
});

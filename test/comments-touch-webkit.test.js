import assert from 'node:assert/strict';
import { test } from 'node:test';
import { note, openApp, readNote, swipe, withPhone } from './helpers/webkit-app.js';

const NOTE = 'Touch comments.md';
const TEXT = [
  'Line before.',
  'We should <!--c:k3f9-->ship on Friday<!--/c:k3f9--> regardless.',
  '<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship on Friday"',
  'kyle (2026-06-17T10:00:00.000Z): I thought we agreed Thursday?',
  '-->',
  ...Array.from({ length: 40 }, (_, i) => `Filler line ${i + 1}.`),
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

async function markCenter(page, id) {
  return page.evaluate((id) => {
    const mark = document.querySelector(`.cm-comment[data-comment-id="${id}"]`);
    const box = mark.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, id);
}

async function handleCenter(page) {
  return page.evaluate(() => {
    const handle = document.querySelector('.comment-sheet-handle');
    const box = handle.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
}

async function tapHighlight(page, id = 'k3f9') {
  const center = await markCenter(page, id);
  await swipe(page, center, center, {
    selector: `.cm-comment[data-comment-id="${id}"]`,
    steps: 1,
    frameMs: 5,
  });
  await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
}

test('webkit scroll on a comment highlight does not open the sheet or pill', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await page.waitForSelector('.cm-comment');

    await blurEditor(page);
    const center = await markCenter(page, 'k3f9');
    await swipe(page, center, { x: center.x, y: center.y + 120 }, {
      selector: '.cm-comment[data-comment-id="k3f9"]',
      steps: 10,
      frameMs: 16,
      scrollDelta: 80,
    });
    assert.equal(await page.locator('#comment-sheet').isHidden(), true);
    assert.equal(await page.locator('#comment-pill').isHidden(), true);

    await focusEditor(page);
    const editCenter = await markCenter(page, 'k3f9');
    await swipe(page, editCenter, { x: editCenter.x, y: editCenter.y + 100 }, {
      selector: '.cm-comment[data-comment-id="k3f9"]',
      steps: 10,
      frameMs: 16,
      scrollDelta: 60,
    });
    assert.equal(await page.locator('#comment-pill').isHidden(), true);
    assert.equal(await page.locator('#comment-sheet').isHidden(), true);

    await blurEditor(page);
    await tapHighlight(page);

    assert.deepEqual(errors, []);
  });
});

test('webkit comment sheet handle drag resizes and dismisses', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await blurEditor(page);
    await tapHighlight(page);
    assert.equal(await page.locator('#comment-sheet').getAttribute('data-size'), 'half');

    const handle = await handleCenter(page);
    await swipe(page, handle, { x: handle.x, y: handle.y - 200 }, {
      selector: '.comment-sheet-handle',
      steps: 12,
      frameMs: 16,
    });
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'full');
    assert.equal(await page.locator('#comment-sheet').getAttribute('data-size'), 'full');

    const handleFull = await handleCenter(page);
    await swipe(page, handleFull, { x: handleFull.x, y: handleFull.y + 200 }, {
      selector: '.comment-sheet-handle',
      steps: 12,
      frameMs: 16,
    });
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'half');

    await swipe(page, handleFull, { x: handleFull.x, y: handleFull.y + 240 }, {
      selector: '.comment-sheet-handle',
      steps: 14,
      frameMs: 16,
    });
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.hidden);

    await blurEditor(page);
    await tapHighlight(page);
    const tapHandle = await handleCenter(page);
    await swipe(page, tapHandle, tapHandle, { selector: '.comment-sheet-handle', steps: 1, frameMs: 5 });
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'full');

    assert.deepEqual(errors, []);
  });
});

const BUBBLE_NOTE = [
  'We <!--c:k3f9-->ship<!--/c:k3f9--> Friday.',
  '<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship"',
  'kyle (2026-06-17T10:00:00.000Z): Can we wait?',
  'me (2026-06-17T10:05:00.000Z): No, Friday works.',
  'me (2026-06-17T10:06:00.000Z): Already booked QA.',
  'grok (2026-06-17T11:00:00.000Z): I can review Thursday night.',
  '-->',
].join('\n');

test('webkit chat bubbles align by author and unread clears after opening', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    const path = 'Bubbles.md';
    await openApp(page, url, [note(path, BUBBLE_NOTE)], path, {
      commentName: 'me',
      commentLastSeen: { k3f9: '2026-06-17T10:02:00.000Z' },
    });
    const before = await readNote(page, path);
    await blurEditor(page);
    await page.locator('.cm-comment[data-comment-id="k3f9"]').click();
    await page.waitForSelector('.comment-bubble.is-other');
    await page.waitForSelector('.comment-bubble.is-unread');
    assert.ok(await page.locator('.comment-bubble.is-own').count() >= 1);
    const layout = await page.evaluate(() => {
      const app = document.getElementById('app').getBoundingClientRect();
      const mid = app.left + app.width / 2;
      const own = document.querySelector('.comment-bubble-row.is-own .comment-bubble');
      const other = document.querySelector('.comment-bubble-row.is-other .comment-bubble');
      return {
        ownRight: own?.getBoundingClientRect().right ?? 0,
        otherLeft: other?.getBoundingClientRect().left ?? 0,
        mid,
      };
    });
    assert.ok(layout.ownRight > layout.mid, 'own bubbles sit on the right');
    assert.ok(layout.otherLeft < layout.mid, 'other bubbles sit on the left');
    await page.waitForFunction(() => !document.querySelector('.comment-bubble.is-unread'));
    assert.equal((await readNote(page, path)).content, before.content);
    assert.deepEqual(errors, []);
  });
});
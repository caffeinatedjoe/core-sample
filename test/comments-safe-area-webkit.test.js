import assert from 'node:assert/strict';
import { test } from 'node:test';
import { note, openApp, swipe, withPhone } from './helpers/webkit-app.js';

const NOTE = 'Safe area comments.md';
const TEXT = [
  'We <!--c:k3f9-->ship<!--/c:k3f9--> Friday.',
  '<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship"',
  'kyle (2026-06-17T10:00:00.000Z): Can we wait?',
  '-->',
  'Then <!--c:ab12-->launch<!--/c:ab12--> next.',
  '<!--co:ab12 by:me at:2026-11-16T11:00:00.000Z status:open quote:"launch"',
  'me (2026-11-16T11:00:00.000Z): after QA',
  '-->',
].join('\n');

const VIEWPORT = { width: 390, height: 844 };
const SAFE_TOP = 47;

function assertChromeTops(chrome, inset, label) {
  for (const [name, top] of Object.entries(chrome)) {
    assert.ok(top >= inset, `${label} ${name} top ${top} must clear inset ${inset}`);
  }
}

async function readThreadChrome(page) {
  return page.evaluate(() => {
    const tops = { handle: visibleTop(document.querySelector('.comment-sheet-handle')) ?? -1 };
    for (const id of ['comment-sheet-prev', 'comment-sheet-next']) {
      const top = visibleTop(document.getElementById(id));
      if (top != null) tops[id] = top;
    }
    const card = document.querySelector('.comment-sheet-card')?.getBoundingClientRect();
    return { tops, cardTop: card?.top ?? -1 };

    function visibleTop(el) {
      if (!el || el.hidden) return null;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return null;
      return box.top;
    }
  });
}

async function readListChrome(page) {
  return page.evaluate(() => {
    const tops = { handle: visibleTop(document.querySelector('.comment-sheet-handle')) ?? -1 };
    const tab = visibleTop(document.querySelector('.comment-sheet-tabs button[aria-selected="true"]'));
    if (tab != null) tops.tab = tab;
    const card = document.querySelector('.comment-sheet-card')?.getBoundingClientRect();
    return { tops, cardTop: card?.top ?? -1 };

    function visibleTop(el) {
      if (!el || el.hidden) return null;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return null;
      return box.top;
    }
  });
}

async function blurEditor(page) {
  await page.evaluate(async () => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.contentDOM.blur();
  });
  await page.waitForFunction(() => !document.querySelector('#source .cm-editor')?.classList.contains('cm-focused'));
}

test('webkit full comment sheet keeps handle and header below the top safe inset', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await page.setViewportSize(VIEWPORT);

    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    assert.equal(
      await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.content.includes('viewport-fit=cover')),
      true,
      'viewport-fit=cover is required for env(safe-area-inset-*)',
    );
    // Headless WebKit reports env() as 0; inline --safe-top simulates Joe's iPhone inset.
    await page.evaluate((inset) => {
      document.documentElement.style.setProperty('--safe-top', `${inset}px`, 'important');
    }, SAFE_TOP);
    const probeTop = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('safe-probe')).paddingTop));
    assert.equal(probeTop, SAFE_TOP, 'test harness must drive the same --safe-top the app uses for layout');

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

    const thread = await readThreadChrome(page);
    assert.ok(thread.cardTop >= SAFE_TOP, `card top ${thread.cardTop} clears inset ${SAFE_TOP}`);
    assertChromeTops(thread.tops, SAFE_TOP, 'thread sheet');
    assert.ok(thread.tops['comment-sheet-next'] != null, 'next arrow is visible on the first of two comments');
    const hits = await page.evaluate(() => {
      const next = document.getElementById('comment-sheet-next').getBoundingClientRect();
      const chrome = document.querySelector('.comment-sheet-chrome').getBoundingClientRect();
      return { nextW: next.width, nextH: next.height, chromeH: chrome.height };
    });
    assert.ok(hits.nextW >= 44 && hits.nextH >= 44, `next hit ${hits.nextW}x${hits.nextH} must be at least 44pt`);
    assert.ok(Math.abs(hits.chromeH - 44) < 0.5, `drag chrome ${hits.chromeH} must be 44pt`);

    await page.evaluate(() => document.getElementById('comment-sheet-scrim')?.click());
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.hidden);
    await page.locator('#comments-chip').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet-list')?.hidden);
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'full');

    const list = await readListChrome(page);
    assert.ok(list.cardTop >= SAFE_TOP, `list card top ${list.cardTop} clears inset ${SAFE_TOP}`);
    assertChromeTops(list.tops, SAFE_TOP, 'list sheet');

    assert.deepEqual(errors, []);
  });
});

async function readThreadContentOffset(page) {
  return page.evaluate(() => {
    const chrome = document.querySelector('.comment-sheet-chrome').getBoundingClientRect();
    const first = document.querySelector('#comment-sheet-quote, .comment-thread-quote, .comment-bubble');
    const firstBox = first?.getBoundingClientRect();
    const prev = document.getElementById('comment-sheet-prev');
    const next = document.getElementById('comment-sheet-next');
    const prevBox = prev && !prev.hidden ? prev.getBoundingClientRect() : null;
    const nextBox = next && !next.hidden ? next.getBoundingClientRect() : null;
    return {
      chromeTop: chrome.top,
      chromeHeight: chrome.height,
      chromeBottom: chrome.bottom,
      firstTop: firstBox?.top ?? -1,
      gapBelowChrome: firstBox ? firstBox.top - chrome.top : -1,
      prevTop: prevBox?.top ?? null,
      nextTop: nextBox?.top ?? null,
      prevW: prevBox?.width ?? 0,
      nextW: nextBox?.width ?? 0,
    };
  });
}

async function openThreadFull(page, commentId) {
  await blurEditor(page);
  await page.locator(`.cm-comment[data-comment-id="${commentId}"]`).click();
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
}

test('webkit thread chrome is one 44pt row with stable content offset', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await page.setViewportSize(VIEWPORT);

    const multi = [
      'We <!--c:k3f9-->ship<!--/c:k3f9--> Friday.',
      '<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship"',
      'kyle (2026-06-17T10:00:00.000Z): Can we wait?',
      '-->',
      'Then <!--c:ab12-->launch<!--/c:ab12--> next.',
      '<!--co:ab12 by:me at:2026-11-16T11:00:00.000Z status:open quote:"launch"',
      'me (2026-11-16T11:00:00.000Z): after QA',
      '-->',
    ].join('\n');

    await openApp(page, url, [note(NOTE, multi)], NOTE);
    await page.evaluate((inset) => {
      document.documentElement.style.setProperty('--safe-top', `${inset}px`, 'important');
    }, SAFE_TOP);
    await openThreadFull(page, 'k3f9');
    const withArrows = await readThreadContentOffset(page);
    const cardTop = await page.evaluate(() => document.querySelector('.comment-sheet-card').getBoundingClientRect().top);
    assert.ok(cardTop >= SAFE_TOP, `full card top ${cardTop} clears inset ${SAFE_TOP}`);
    assert.ok(withArrows.chromeTop >= SAFE_TOP, `chrome top ${withArrows.chromeTop} clears inset ${SAFE_TOP}`);
    assert.ok(Math.abs(withArrows.chromeHeight - 44) < 0.5, `chrome ${withArrows.chromeHeight} must be 44pt with arrows`);
    assert.ok(withArrows.gapBelowChrome <= 45, `content gap ${withArrows.gapBelowChrome} must sit within 44pt + 1px of chrome top`);
    assert.ok(withArrows.firstTop >= withArrows.chromeBottom - 1, 'thread content starts at chrome bottom');
    assert.ok(withArrows.nextTop != null && withArrows.nextTop >= SAFE_TOP, 'next arrow clears safe top');
    assert.ok(withArrows.nextW >= 44, 'next control stays 44pt wide');

    await page.locator('#comment-sheet-next').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet-quote')?.textContent.includes('launch'));

    await page.evaluate(() => document.getElementById('comment-sheet-scrim')?.click());
    await page.waitForFunction(() => document.getElementById('comment-sheet')?.hidden);

    const single = [
      'Only <!--c:one1-->one<!--/c:one1--> here.',
      '<!--co:one1 by:me at:2026-11-16T12:00:00.000Z status:open quote:"one"',
      'me (2026-11-16T12:00:00.000Z): solo',
      '-->',
    ].join('\n');
    await openApp(page, url, [note('Single-chrome.md', single)], 'Single-chrome.md');
    await page.evaluate((inset) => {
      document.documentElement.style.setProperty('--safe-top', `${inset}px`, 'important');
    }, SAFE_TOP);
    await openThreadFull(page, 'one1');
    const noArrows = await readThreadContentOffset(page);
    assert.ok(Math.abs(noArrows.chromeHeight - 44) < 0.5, `chrome ${noArrows.chromeHeight} must be 44pt without arrows`);
    assert.ok(Math.abs(noArrows.chromeHeight - withArrows.chromeHeight) < 0.5, 'chrome height must not change when arrows hide');
    assert.ok(noArrows.gapBelowChrome <= 45, `content gap ${noArrows.gapBelowChrome} must sit within 44pt + 1px of chrome top`);
    assert.equal(noArrows.nextTop, null, 'next arrow hidden on a single comment');
    assert.equal(noArrows.prevTop, null, 'previous arrow hidden on a single comment');

    assert.deepEqual(errors, []);
  });
});

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
    assert.ok(hits.chromeH >= 48, `drag chrome ${hits.chromeH} must be at least 48pt`);

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

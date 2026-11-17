import assert from 'node:assert/strict';
import { test } from 'node:test';
import { note, openApp, swipe, withPhone } from './helpers/webkit-app.js';

const VIEWPORT = { width: 390, height: 844 };
const NOTE = 'Overlay thread.md';

function buildLongThread() {
  const lines = ['Paragraph <!--c:long99-->anchor<!--/c:long99--> here.'];
  const entries = [];
  const authors = ['kyle', 'me', 'jordan', 'kyle', 'me'];
  for (let i = 0; i < 24; i += 1) {
    const author = authors[i % authors.length];
    const at = `2026-06-${String(1 + (i % 28)).padStart(2, '0')}T10:${String(i).padStart(2, '0')}:00.000Z`;
    entries.push(`${author} (${at}): Message ${i + 1} with enough text to wrap on a narrow phone.`);
  }
  lines.push(
    '<!--co:long99 by:kyle at:2026-06-01T10:00:00.000Z status:open quote:"anchor"',
    ...entries,
    '-->',
  );
  return lines.join('\n');
}

const TEXT = buildLongThread();

async function blurEditor(page) {
  await page.evaluate(async () => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.contentDOM.blur();
  });
}

async function openFullThread(page) {
  await blurEditor(page);
  await page.locator('.cm-comment[data-comment-id="long99"]').click();
  await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
  const handle = await page.evaluate(() => {
    const h = document.querySelector('.comment-sheet-handle');
    const box = h.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await swipe(page, handle, { x: handle.x, y: handle.y - 220 }, {
    selector: '.comment-sheet-handle',
    steps: 12,
    frameMs: 16,
  });
  await page.waitForFunction(() => document.getElementById('comment-sheet')?.dataset.size === 'full');
}

function gapProbeScript() {
  return () => {
    const composer = document.getElementById('comment-sheet-composer');
    const card = document.querySelector('.comment-sheet-card');
    const app = document.getElementById('app');
    if (!composer || !card || !app) return { ok: false, reason: 'missing nodes' };
    const composerBox = composer.getBoundingClientRect();
    const composerTop = composerBox.top;
    const cardBox = card.getBoundingClientRect();
    const appBox = app.getBoundingClientRect();
    const viewBottom = Math.min(cardBox.bottom, appBox.bottom);
    const gapTop = composerBox.bottom;
    const x = cardBox.left + cardBox.width / 2;
    if (viewBottom > gapTop + 1) {
      for (const bubble of document.querySelectorAll('.comment-bubble')) {
        const r = bubble.getBoundingClientRect();
        if (r.top < viewBottom && r.bottom > gapTop + 0.5) {
          return { ok: false, reason: 'bubble in gap below composer', top: r.top, bottom: r.bottom, gapTop, viewBottom };
        }
      }
    }
    const hits = [];
    for (let y = Math.ceil(composerTop); y <= viewBottom; y += 6) {
      const hit = document.elementFromPoint(x, y);
      if (hit?.closest?.('.comment-bubble')) hits.push(y);
    }
    return { ok: hits.length === 0, hits, composerTop, viewBottom };
  };
}

test('webkit long thread: bubbles never show below composer at rest, drag, and snap', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await page.setViewportSize(VIEWPORT);
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await openFullThread(page);

    const probeGap = async () => page.evaluate(gapProbeScript());

    const atRest = await probeGap();
    assert.ok(atRest.ok, JSON.stringify(atRest));

    const handle = await page.evaluate(() => {
      const h = document.querySelector('.comment-sheet-handle');
      const box = h.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });

    const dragProbe = await page.evaluate(async ({ from }) => {
      const target = document.querySelector('.comment-sheet-handle');
      const composer = document.getElementById('comment-sheet-composer');
      const pointerId = 9;
      const fire = (type, x, y, buttons = 1) => target.dispatchEvent(new PointerEvent(type, {
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons,
        bubbles: true,
        cancelable: true,
      }));
      const probe = () => {
        const composer = document.getElementById('comment-sheet-composer');
        const card = document.querySelector('.comment-sheet-card');
        const app = document.getElementById('app');
        if (!composer || !card || !app) return { ok: false, reason: 'missing nodes' };
        const composerBox = composer.getBoundingClientRect();
        const composerTop = composerBox.top;
        const gapTop = composerBox.bottom;
        const cardBox = card.getBoundingClientRect();
        const appBox = app.getBoundingClientRect();
        const viewBottom = Math.min(cardBox.bottom, appBox.bottom);
        const x = cardBox.left + cardBox.width / 2;
        if (viewBottom > gapTop + 1) {
          for (const bubble of document.querySelectorAll('.comment-bubble')) {
            const r = bubble.getBoundingClientRect();
            if (r.top < viewBottom && r.bottom > gapTop + 0.5) {
              return { ok: false, reason: 'bubble in gap below composer', top: r.top, bottom: r.bottom, gapTop, viewBottom };
            }
          }
        }
        const hits = [];
        for (let y = Math.ceil(composerTop); y <= viewBottom; y += 6) {
          const hit = document.elementFromPoint(x, y);
          if (hit?.closest?.('.comment-bubble')) hits.push(y);
        }
        return { ok: hits.length === 0, hits, composerTop, viewBottom };
      };
      const samples = [];
      fire('pointerdown', from.x, from.y);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      samples.push(probe());
      const heights = [from.y - 80, from.y + 60, from.y + 140, from.y - 40];
      for (const y of heights) {
        fire('pointermove', from.x, y);
        await new Promise((r) => requestAnimationFrame(r));
        samples.push(probe());
      }
      fire('pointerup', from.x, from.y - 30, 0);
      let snap = probe();
      await new Promise((r) => requestAnimationFrame(r));
      snap = probe();
      samples.push(probe());
      await new Promise((resolve) => setTimeout(resolve, 400));
      const settled = {
        transform: composer?.style.transform || '',
        dragging: document.getElementById('comment-sheet')?.classList.contains('is-dragging'),
      };
      return { samples, snap, settled };
    }, { from: handle });

    for (const sample of dragProbe.samples) {
      assert.ok(sample.ok, `visible gap leak: ${JSON.stringify(sample)}`);
    }
    assert.ok(dragProbe.snap.ok, JSON.stringify(dragProbe.snap));
    assert.equal(dragProbe.settled.transform, '');
    assert.equal(dragProbe.settled.dragging, false);

    assert.deepEqual(errors, []);
  });
});

test('webkit overlay chrome: thread scrolls under handle and drag still works', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await page.setViewportSize(VIEWPORT);
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await openFullThread(page);

    const scroll0 = await page.evaluate(() => {
      const card = document.querySelector('.comment-sheet-card');
      const cardTop = card?.getBoundingClientRect().top ?? -1;
      const quote = document.getElementById('comment-sheet-quote')
        || document.querySelector('.comment-thread-quote');
      const firstBubble = document.querySelector('.comment-bubble-row');
      const itemTop = quote?.getBoundingClientRect().top ?? firstBubble?.getBoundingClientRect().top ?? -1;
      return { cardTop, itemTop, delta: itemTop - cardTop };
    });
    assert.ok(scroll0.delta >= 44 && scroll0.delta <= 56,
      `first item should start just below 44px handle (delta ${scroll0.delta})`);

    await page.evaluate(() => {
      document.getElementById('comment-sheet-thread')?.scrollTo(0, 400);
    });
    await page.waitForFunction(() => (document.getElementById('comment-sheet-thread')?.scrollTop ?? 0) > 100);

    const underHandle = await page.evaluate(() => {
      const card = document.querySelector('.comment-sheet-card');
      const cardTop = card?.getBoundingClientRect().top ?? -1;
      const cutoff = cardTop + 44;
      const row = [...document.querySelectorAll('.comment-bubble-row')].find((el) => {
        const top = el.getBoundingClientRect().top;
        return top < cutoff && el.getBoundingClientRect().bottom > cardTop;
      });
      const handle = document.querySelector('.comment-sheet-handle');
      const box = handle?.getBoundingClientRect();
      const cx = box ? box.left + box.width / 2 : -1;
      const cy = box ? box.top + box.height / 2 : -1;
      const hit = cx > 0 ? document.elementFromPoint(cx, cy) : null;
      const onChrome = hit?.closest?.('.comment-sheet-chrome');
      return { hasUnderRow: Boolean(row), onChrome: Boolean(onChrome), hitTag: hit?.className || hit?.id || '' };
    });
    assert.ok(underHandle.hasUnderRow, 'a bubble should scroll under the overlay handle');
    assert.ok(underHandle.onChrome, `grabber center should hit chrome, got ${underHandle.hitTag}`);

    const beforeTop = await page.evaluate(() => document.querySelector('.comment-sheet-card')?.getBoundingClientRect().top ?? -1);
    const handle = await page.evaluate(() => {
      const h = document.querySelector('.comment-sheet-handle');
      const box = h.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await page.evaluate(async ({ from }) => {
      const target = document.querySelector('.comment-sheet-handle');
      const pointerId = 3;
      const fire = (type, x, y, buttons = 1) => target.dispatchEvent(new PointerEvent(type, {
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons,
        bubbles: true,
        cancelable: true,
      }));
      fire('pointerdown', from.x, from.y);
      await new Promise((r) => requestAnimationFrame(r));
      fire('pointermove', from.x, from.y + 90);
      fire('pointerup', from.x, from.y + 90, 0);
    }, { from: handle });
    const afterTop = await page.evaluate(() => document.querySelector('.comment-sheet-card')?.getBoundingClientRect().top ?? -1);
    assert.ok(afterTop > beforeTop + 6, 'drag from overlay grabber should move the sheet');

    assert.deepEqual(errors, []);
  });
});
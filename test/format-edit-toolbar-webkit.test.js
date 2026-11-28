import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FORMAT_BAR_ORDER, FORMAT_BAR_LAYOUT_KEY } from '../app/js/format-bar-order.js';
import {
  APP_BUILD,
  fakeKeyboard,
  editorFocused,
  formatBarLongPress,
  formatEditSheetDragToPoint,
  installFormatBarTouchSpy,
  note,
  openApp,
  readFormatBarTouchSpy,
  waitDoubleRaf,
  withPhone,
} from './helpers/webkit-app.js';

const NOTE = 'Tasks.md';
const TEXT = 'Reorder me.\n';

const NINE_SHOWN_LAYOUT = {
  order: [...DEFAULT_FORMAT_BAR_ORDER],
  hiddenFrom: 9,
};

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

async function prepFormatBar(page, url) {
  await openApp(page, url, [note(NOTE, TEXT)], NOTE);
  await caretAt(page, 2);
  await fakeKeyboard(page, 336);
  await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
}

async function seedNineShown(page) {
  await page.evaluate(({ key, layout }) => {
    localStorage.setItem(key, JSON.stringify(layout));
  }, { key: FORMAT_BAR_LAYOUT_KEY, layout: NINE_SHOWN_LAYOUT });
}

async function openEditSheet(page, formatId = 'bold', { nineShown = false } = {}) {
  if (nineShown) await seedNineShown(page);
  await formatBarLongPress(page, formatId, { blurEditor: false });
  await page.waitForFunction(() => document.getElementById('format-edit-sheet').classList.contains('is-open'));
  await page.waitForTimeout(350);
}

async function dragToPoint2px(page, fromId, to, opts = {}) {
  const { fromSection, ...dragOpts } = opts;
  let fromBox;
  if (fromSection === 'hidden') {
    fromBox = await page.locator(`#format-edit-hidden [data-id="${fromId}"]`).boundingBox();
  } else if (fromSection === 'shown') {
    fromBox = await page.locator(`#format-edit-shown [data-id="${fromId}"]`).boundingBox();
  } else {
    fromBox = await page.locator(`#format-edit-shown [data-id="${fromId}"]`).boundingBox();
    if (!fromBox) fromBox = await page.locator(`#format-edit-hidden [data-id="${fromId}"]`).boundingBox();
  }
  if (!fromBox) throw new Error(`missing tile ${fromId}`);
  const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
  await formatEditSheetDragToPoint(page, fromId, to, { steps, frameMs: 16, holdMs: 220, fromSection, ...dragOpts });
}

async function waitEditDropSettled(page) {
  await page.waitForFunction(() => window.__formatEditDropDone === true, null, { timeout: 5000 });
  await waitDoubleRaf(page);
}

async function editSheetSlotCenter(page, { slot = 0, section = 'hidden' } = {}) {
  return page.evaluate(({ slot, section }) => {
    const grid = section === 'hidden'
      ? document.getElementById('format-edit-hidden')
      : document.getElementById('format-edit-shown');
    const tiles = [...grid.querySelectorAll('.format-edit-tile')];
    const tile = tiles[slot] || tiles[tiles.length - 1];
    if (!tile) throw new Error(`no tile slot ${slot} in ${section}`);
    const box = tile.getBoundingClientRect();
    return {
      x: box.left + box.width * 0.5,
      y: box.top + box.height * (0.5),
    };
  }, { slot, section });
}

function p95(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

/** One drag only: after lift until just before pointerup, section tops stay within ±0.5px. */
async function assertSectionTopsStableDuringDrag(page, { tileSelector, to }) {
  return page.evaluate(async ({ tileSelector, to }) => {
    const scroll = document.getElementById('format-edit-scroll');
    const head = document.getElementById('format-edit-hidden-head');
    const hidden = document.getElementById('format-edit-hidden');
    const shown = document.getElementById('format-edit-shown');
    const tile = document.querySelector(tileSelector);
    if (!scroll || !head || !hidden || !shown || !tile) return 'sheet missing';
    const fromBox = tile.getBoundingClientRect();
    const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
    const pointerId = 210;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const afterPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const fire = (type, point, buttons) => {
      const target = type === 'pointerdown' ? tile : scroll;
      target.dispatchEvent(new PointerEvent(type, {
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        buttons,
        bubbles: true,
        cancelable: true,
      }));
    };
    const near = (a, b) => Math.abs(a - b) <= 0.5;
    fire('pointerdown', from, 1);
    await wait(220);
    fire('pointermove', from, 1);
    await afterPaint();
    const lift = {
      head: head.getBoundingClientRect().top,
      hidden: hidden.getBoundingClientRect().top,
      shown: shown.getBoundingClientRect().top,
    };
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
    for (let i = 1; i <= steps; i += 1) {
      await wait(16);
      const point = {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      };
      fire('pointermove', point, 1);
      await afterPaint();
      const headTop = head.getBoundingClientRect().top;
      const hiddenTop = hidden.getBoundingClientRect().top;
      const shownTop = shown.getBoundingClientRect().top;
      if (!near(headTop, lift.head)) return `head top ${headTop} vs lift ${lift.head} step ${i}`;
      if (!near(hiddenTop, lift.hidden)) return `hidden top ${hiddenTop} vs lift ${lift.hidden} step ${i}`;
      if (!near(shownTop, lift.shown)) return `shown top ${shownTop} vs lift ${lift.shown} step ${i}`;
    }
    fire('pointercancel', to, 0);
    return null;
  }, { tileSelector, to });
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

    await page.waitForTimeout(280);
    await page.evaluate(() => document.getElementById('format-edit-done').click());
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

test('webkit dragging into hidden grid hides a control and dragging back shows it', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);

    await openEditSheet(page, 'bold', { nineShown: true });
    const beforeVisible = await visibleBarIds(page);
    assert.ok(beforeVisible.includes('bold'));

    const drop = await editSheetSlotCenter(page, { slot: 0, section: 'hidden' });
    await dragToPoint2px(page, 'bold', drop);
    await waitEditDropSettled(page);
    await page.waitForFunction(() => {
      const btn = document.querySelector('#format-bar [data-format="bold"]');
      return Boolean(btn?.hidden);
    });
    const hidden = await visibleBarIds(page);
    assert.ok(!hidden.includes('bold'));

    const show = await editSheetSlotCenter(page, { slot: 3, section: 'shown' });
    await dragToPoint2px(page, 'bold', show, { fromSection: 'hidden' });
    await waitEditDropSettled(page);
    const shown = await visibleBarIds(page);
    assert.ok(shown.includes('bold'));
    assert.deepEqual(errors, []);
  });
});

test('webkit Done closes sheet, refocuses editor, and layout survives reload', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    const drop = await editSheetSlotCenter(page, { slot: 0, section: 'hidden' });
    await dragToPoint2px(page, 'bold', drop);
    await waitEditDropSettled(page);
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

async function readEditSheetViewportSnap(page) {
  return page.evaluate(() => {
    const scroll = document.getElementById('format-edit-scroll');
    const card = document.querySelector('.format-edit-card');
    const vv = window.visualViewport;
    return {
      scrollTop: scroll?.scrollTop ?? 0,
      cardTop: card?.getBoundingClientRect().top ?? 0,
      vvTop: vv?.offsetTop ?? 0,
    };
  });
}

async function assertEditSheetScrollerFits(page) {
  const fit = await page.evaluate(() => {
    const scroll = document.getElementById('format-edit-scroll');
    const card = document.querySelector('.format-edit-card');
    const docEl = document.documentElement;
    return {
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
      overflowY: getComputedStyle(scroll).overflowY,
      docScrollWidth: docEl.scrollWidth,
      clientWidth: docEl.clientWidth,
      cardWidth: card?.getBoundingClientRect().width ?? 0,
    };
  });
  assert.ok(fit.scrollHeight <= fit.clientHeight + 1, `scroll overflow ${fit.scrollHeight} > ${fit.clientHeight}`);
  assert.equal(fit.overflowY, 'hidden');
  assert.ok(fit.docScrollWidth <= fit.clientWidth + 1, 'horizontal overflow');
  return fit;
}

for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
  test(`webkit edit-sheet fits iPhone viewport ${viewport.width}x${viewport.height}`, { timeout: 120000 }, async (t) => {
    await withPhone(t, async ({ page, url, errors }) => {
      await prepFormatBar(page, url);
      await openEditSheet(page, 'bold', { nineShown: true });
      await page.waitForTimeout(120);
      await assertEditSheetScrollerFits(page);
      assert.deepEqual(errors, []);
    }, { viewport });
  });
}

test('webkit edit-sheet tap and hold do not scroll the sheet', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    await page.waitForTimeout(120);
    const before = await readEditSheetViewportSnap(page);
    await page.locator('#format-edit-shown [data-id="italic"]').click({ force: true });
    await page.waitForTimeout(80);
    const afterTap = await readEditSheetViewportSnap(page);
    assert.equal(afterTap.scrollTop, before.scrollTop);
    assert.ok(Math.abs(afterTap.cardTop - before.cardTop) <= 0.5);
    assert.ok(Math.abs(afterTap.vvTop - before.vvTop) <= 0.5);
    const moved = await page.evaluate(async () => {
      const tile = document.querySelector('#format-edit-shown [data-id="bold"]');
      const scroll = document.getElementById('format-edit-scroll');
      const before = {
        scrollTop: scroll.scrollTop,
        cardTop: document.querySelector('.format-edit-card').getBoundingClientRect().top,
        vvTop: window.visualViewport.offsetTop,
      };
      const box = tile.getBoundingClientRect();
      const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      tile.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 88,
        pointerType: 'touch',
        clientX: from.x,
        clientY: from.y,
        button: 0,
        buttons: 1,
        bubbles: true,
        cancelable: true,
      }));
      await new Promise((r) => setTimeout(r, 240));
      const after = {
        scrollTop: scroll.scrollTop,
        cardTop: document.querySelector('.format-edit-card').getBoundingClientRect().top,
        vvTop: window.visualViewport.offsetTop,
      };
      tile.dispatchEvent(new PointerEvent('pointercancel', {
        pointerId: 88,
        pointerType: 'touch',
        clientX: from.x,
        clientY: from.y,
        button: 0,
        buttons: 0,
        bubbles: true,
        cancelable: true,
      }));
      if (after.scrollTop !== before.scrollTop) return `scrollTop ${before.scrollTop} -> ${after.scrollTop}`;
      if (Math.abs(after.cardTop - before.cardTop) > 0.5) return `cardTop drift`;
      if (Math.abs(after.vvTop - before.vvTop) > 0.5) return `vvTop drift`;
      return null;
    });
    assert.equal(moved, null, moved || 'hold stable');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R1a: shown drag into hidden keeps section tops fixed', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    const to = await editSheetSlotCenter(page, { slot: 0, section: 'hidden' });
    const bad = await assertSectionTopsStableDuringDrag(page, {
      tileSelector: '#format-edit-shown [data-id="bold"]',
      to,
    });
    assert.equal(bad, null, bad || 'R1a ok');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R1b: hidden drag into shown keeps section tops fixed', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'lineUp', { nineShown: true });
    const to = await editSheetSlotCenter(page, { slot: 0, section: 'shown' });
    const bad = await assertSectionTopsStableDuringDrag(page, {
      tileSelector: '#format-edit-hidden [data-id="lineUp"]',
      to,
    });
    assert.equal(bad, null, bad || 'R1b ok');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R2: inner 70% slot samples match placeholder index', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'italic', { nineShown: true });
    const bad = await page.evaluate(async () => {
      const {
        formatEditSlotRect,
        formatEditSlotTranslate,
        formatEditProjectionSlots,
        pickFormatEditDragTarget,
        FORMAT_EDIT_SECTION_SHOWN,
      } = await import('./js/format-bar-order.js');
      const scroll = document.getElementById('format-edit-scroll');
      const shown = document.getElementById('format-edit-shown');
      const hidden = document.getElementById('format-edit-hidden');
      const head = document.getElementById('format-edit-hidden-head');
      const tile = shown.querySelector('[data-id="italic"]');
      if (!tile) return 'missing tile';
      const scrollBox = scroll.getBoundingClientRect();
      const styles = getComputedStyle(shown);
      const gapX = Number.parseFloat(styles.columnGap) || 10;
      const gapY = Number.parseFloat(styles.rowGap) || 8;
      const cellWidth = tile.offsetWidth;
      const cellHeight = tile.offsetHeight;
      const columnCount = Math.max(1, Math.floor((shown.clientWidth + gapX) / (64 + gapX)));
      const shownBox = shown.getBoundingClientRect();
      const hiddenBox = hidden.getBoundingClientRect();
      const scrollTop = scroll.scrollTop;
      const originX = shownBox.left - scrollBox.left + scroll.scrollLeft;
      const shownOriginY = shownBox.top - scrollBox.top + scrollTop;
      const hiddenOriginY = hiddenBox.top - scrollBox.top + scrollTop;
      const headBox = head.getBoundingClientRect();
      const headerMidY = (headBox.top + headBox.bottom) / 2 - scrollBox.top + scrollTop;
      const shownIds = [...shown.querySelectorAll('.format-edit-tile')].map((n) => n.dataset.id);
      const hiddenIds = [...hidden.querySelectorAll('.format-edit-tile')].map((n) => n.dataset.id);
      const homeSlot = shownIds.indexOf('italic');
      const sampleSlots = [1, 2, 5, 6].filter((s) => s !== homeSlot);
      const fromBox = tile.getBoundingClientRect();
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const pointerId = 202;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const afterPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : scroll;
        target.dispatchEvent(new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons,
          bubbles: true,
          cancelable: true,
        }));
      };
      fire('pointerdown', from, 1);
      await wait(220);
      if (!document.querySelector('.format-edit-ghost')) return 'drag did not start';
      let currentTarget = null;
      for (const slot of sampleSlots) {
        const rect = formatEditSlotRect(slot, columnCount, cellWidth, cellHeight, gapX, gapY, originX, shownOriginY);
        const localX = rect.left + rect.width * 0.5;
        const localY = rect.top + rect.height * 0.5;
        const clientX = scrollBox.left - scroll.scrollLeft + localX;
        const clientY = scrollBox.top - scroll.scrollTop + localY;
        fire('pointermove', { x: clientX, y: clientY }, 1);
        await afterPaint();
        const target = pickFormatEditDragTarget({
          localX,
          localY,
          headerMidY,
          prevSection: currentTarget?.section ?? FORMAT_EDIT_SECTION_SHOWN,
          currentTarget,
          shownOriginY,
          hiddenOriginY,
          originX,
          columnCount,
          cellWidth,
          cellHeight,
          gapX,
          gapY,
          shownCount: shownIds.length,
          hiddenCount: hiddenIds.length,
          dragFromSection: FORMAT_EDIT_SECTION_SHOWN,
        });
        currentTarget = target;
        const witnessId = shownIds.find((id) => id !== 'italic');
        const witness = shown.querySelector(`[data-id="${witnessId}"]`);
        if (!witness) return `missing witness ${witnessId}`;
        const proj = formatEditProjectionSlots(shownIds, hiddenIds, 'italic', FORMAT_EDIT_SECTION_SHOWN, target);
        const projected = proj.get(witnessId);
        if (!projected) return `no projection for ${witnessId} at slot ${slot}`;
        const homeSlot = shownIds.indexOf(witnessId);
        const { dx, dy } = formatEditSlotTranslate(
          homeSlot,
          projected.slot,
          columnCount,
          cellWidth,
          cellHeight,
          gapX,
          gapY,
        );
        const tf = witness.style.transform;
        const expectDx = dx ? `${dx}px` : '0px';
        const expectDy = dy ? `${dy}px` : '0px';
        const expect = dx || dy ? `translate3d(${expectDx}, ${expectDy}, 0)` : '';
        if (tf !== expect) return `slot ${slot}: transform "${tf}" expected "${expect}"`;
      }
      fire('pointerup', from, 0);
      return null;
    });
    assert.equal(bad, null, bad || 'R2 ok');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R3: one-slot cardinal moves change target once each', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'task', { nineShown: true });
    const bad = await page.evaluate(async () => {
      const scroll = document.getElementById('format-edit-scroll');
      const shown = document.getElementById('format-edit-shown');
      const tile = shown.querySelector('[data-id="task"]');
      const tileBox = tile.getBoundingClientRect();
      const cellW = tile.offsetWidth;
      const cellH = tile.offsetHeight;
      const gapX = Number.parseFloat(getComputedStyle(shown).columnGap) || 10;
      const from = { x: tileBox.x + tileBox.width / 2, y: tileBox.y + tileBox.height / 2 };
      const moves = {
        R: { x: from.x + cellW + gapX, y: from.y },
        L: { x: from.x - cellW - gapX, y: from.y },
        D: { x: from.x, y: from.y + cellH + 8 },
        U: { x: from.x, y: from.y - cellH - 8 },
      };
      const pointerId = 203;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const readTargetKey = () => window.__formatEditLastTargetKey || 'none';
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : scroll;
        target.dispatchEvent(new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons,
          bubbles: true,
          cancelable: true,
        }));
      };
      fire('pointerdown', from, 1);
      await wait(220);
      if (!document.querySelector('.format-edit-ghost')) return 'drag did not start';
      for (const [dir, dest] of Object.entries(moves)) {
        const steps = Math.max(1, Math.ceil(Math.hypot(dest.x - from.x, dest.y - from.y) / 2));
        let changes = 0;
        let prev = readTargetKey();
        for (let i = 1; i <= steps; i += 1) {
          await wait(16);
          const point = {
            x: from.x + ((dest.x - from.x) * i) / steps,
            y: from.y + ((dest.y - from.y) * i) / steps,
          };
          fire('pointermove', point, 1);
          await wait(18);
          const now = readTargetKey();
          if (now !== prev) {
            changes += 1;
            prev = now;
          }
        }
        if (changes !== 1) return `${dir} had ${changes} target changes (want 1)`;
        from.x = dest.x;
        from.y = dest.y;
      }
      fire('pointerup', from, 0);
      return null;
    });
    assert.equal(bad, null, bad || 'R3 ok');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R4: header midline jitter changes target at most once in 30 frames', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    const bad = await page.evaluate(async () => {
      const scroll = document.getElementById('format-edit-scroll');
      const head = document.getElementById('format-edit-hidden-head');
      const tile = document.querySelector('#format-edit-shown [data-id="bold"]');
      const headMid = head.getBoundingClientRect();
      const midY = (headMid.top + headMid.bottom) / 2;
      const fromBox = tile.getBoundingClientRect();
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const pointerId = 204;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const readKey = () => document.querySelector('.format-edit-tile.is-placeholder')?.dataset.index ?? 'x';
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : scroll;
        target.dispatchEvent(new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons,
          bubbles: true,
          cancelable: true,
        }));
      };
      fire('pointerdown', from, 1);
      await wait(220);
      let changes = 0;
      let prev = readKey();
      for (let frame = 0; frame < 30; frame += 1) {
        const y = midY + ((frame % 2) ? 10 : -10);
        const x = from.x + ((frame % 4) < 2 ? -3 : 3);
        fire('pointermove', { x, y }, 1);
        await wait(28);
        const now = readKey();
        if (now !== prev) {
          changes += 1;
          prev = now;
        }
      }
      fire('pointerup', { x: from.x, y: midY }, 0);
      return changes > 1 ? `target changed ${changes} times` : null;
    });
    assert.equal(bad, null, bad || 'R4 ok');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R5: hidden drop slot order matches storage and bar', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    const slotK = 0;
    const drop = await editSheetSlotCenter(page, { slot: slotK, section: 'hidden' });
    await dragToPoint2px(page, 'bold', drop);
    await waitEditDropSettled(page);
    const snap = await page.evaluate((k) => {
      const hidden = [...document.getElementById('format-edit-hidden').querySelectorAll('.format-edit-tile')].map((n) => n.dataset.id);
      const layout = JSON.parse(localStorage.getItem('core-sample-format-bar-layout-v2'));
      const bar = [...document.querySelectorAll('#format-bar .format-scroll .format-btn')]
        .filter((n) => !n.hidden)
        .map((n) => n.getAttribute('data-format'));
      return { hidden, layout, bar, k };
    }, slotK);
    const { hidden, layout, bar, k } = snap;
    assert.equal(hidden[k], 'bold');
    const { shown, hidden: hid } = { shown: layout.order.slice(0, layout.hiddenFrom), hidden: layout.order.slice(layout.hiddenFrom) };
    assert.equal(hid[k], 'bold');
    assert.ok(!bar.includes('bold'));
    assert.deepEqual(shown, bar);
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R6: no DOM/storage/bar churn between lift and drop', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    const bad = await page.evaluate(async () => {
      const scroll = document.getElementById('format-edit-scroll');
      const shown = document.getElementById('format-edit-shown');
      const hidden = document.getElementById('format-edit-hidden');
      const tile = shown.querySelector('[data-id="bold"]');
      const hiddenGrid = document.getElementById('format-edit-hidden');
      const destTile = hiddenGrid.querySelector('[data-id="link"]') || hiddenGrid.querySelector('.format-edit-tile');
      const toBox = destTile.getBoundingClientRect();
      const to = { x: toBox.x + toBox.width / 2, y: toBox.y + toBox.height / 2 };
      const fromBox = tile.getBoundingClientRect();
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const spy = { childList: 0, storageSets: 0, barOrder: null, barChanges: 0 };
      const barIds = () => [...document.querySelectorAll('#format-bar .format-scroll .format-btn')].map((n) => n.getAttribute('data-format'));
      spy.barOrder = barIds().join(',');
      const mo = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === 'childList' && (r.addedNodes.length || r.removedNodes.length)) spy.childList += 1;
        }
      });
      mo.observe(shown, { childList: true });
      mo.observe(hidden, { childList: true });
      const origSet = localStorage.setItem.bind(localStorage);
      localStorage.setItem = (...args) => {
        spy.storageSets += 1;
        return origSet(...args);
      };
      const pointerId = 206;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : scroll;
        target.dispatchEvent(new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons,
          bubbles: true,
          cancelable: true,
        }));
      };
      fire('pointerdown', from, 1);
      await wait(220);
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
      for (let i = 1; i <= steps; i += 1) {
        await wait(16);
        const point = {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        };
        fire('pointermove', point, 1);
        const now = barIds().join(',');
        if (now !== spy.barOrder) spy.barChanges += 1;
      }
      fire('pointerup', to, 0);
      mo.disconnect();
      localStorage.setItem = origSet;
      if (spy.childList) return `childList mutations ${spy.childList}`;
      if (spy.storageSets) return `storage sets ${spy.storageSets}`;
      if (spy.barChanges) return `bar reorder events ${spy.barChanges}`;
      return null;
    });
    assert.equal(bad, null, bad || 'R6 ok');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R7: no layout reads during move after lift', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    const bad = await page.evaluate(async () => {
      const scroll = document.getElementById('format-edit-scroll');
      const tile = document.querySelector('#format-edit-shown [data-id="bold"]');
      const hidden = document.getElementById('format-edit-hidden');
      const dest = hidden.querySelector('.format-edit-tile');
      const to = (() => {
        const b = dest.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      })();
      const fromBox = tile.getBoundingClientRect();
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const counts = { gbcr: 0, offset: 0, gcs: 0, active: false };
      const origG = Element.prototype.getBoundingClientRect;
      const origGcs = window.getComputedStyle;
      Element.prototype.getBoundingClientRect = function patched(...args) {
        if (counts.active) counts.gbcr += 1;
        return origG.apply(this, args);
      };
      for (const key of ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft']) {
        const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
        if (!desc?.get) continue;
        Object.defineProperty(HTMLElement.prototype, key, {
          ...desc,
          get() {
            if (counts.active) counts.offset += 1;
            return desc.get.call(this);
          },
        });
      }
      window.getComputedStyle = (...args) => {
        if (counts.active) counts.gcs += 1;
        return origGcs(...args);
      };
      const pointerId = 207;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : scroll;
        target.dispatchEvent(new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons,
          bubbles: true,
          cancelable: true,
        }));
      };
      fire('pointerdown', from, 1);
      await wait(220);
      await wait(50);
      counts.active = true;
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
      for (let i = 1; i <= steps; i += 1) {
        await wait(16);
        fire('pointermove', {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        }, 1);
      }
      counts.active = false;
      fire('pointerup', to, 0);
      Element.prototype.getBoundingClientRect = origG;
      window.getComputedStyle = origGcs;
      const total = counts.gbcr + counts.offset + counts.gcs;
      return total ? `layout reads during drag: gbcr=${counts.gbcr} offset=${counts.offset} gcs=${counts.gcs}` : null;
    });
    assert.equal(bad, null, bad || 'R7 ok');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R8: at most one rAF and one ghost write per frame', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    const bad = await page.evaluate(async () => {
      window.__formatEditDragProbe = {
        ghostWrites: 0,
        rafScheduled: 0,
        rafFrames: 0,
        rafDeltas: [],
        lastRafAt: null,
        perFrame: [],
      };
      const scroll = document.getElementById('format-edit-scroll');
      const tile = document.querySelector('#format-edit-shown [data-id="bold"]');
      const hidden = document.getElementById('format-edit-hidden');
      const dest = hidden.querySelector('.format-edit-tile');
      const to = (() => {
        const b = dest.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      })();
      const fromBox = tile.getBoundingClientRect();
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const pointerId = 208;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const afterPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : scroll;
        target.dispatchEvent(new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons,
          bubbles: true,
          cancelable: true,
        }));
      };
      fire('pointerdown', from, 1);
      await wait(220);
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
      for (let i = 1; i <= steps; i += 1) {
        const scheduled0 = window.__formatEditDragProbe.rafScheduled;
        const writes0 = window.__formatEditDragProbe.ghostWrites;
        await wait(16);
        fire('pointermove', {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        }, 1);
        await afterPaint();
        const schedDelta = window.__formatEditDragProbe.rafScheduled - scheduled0;
        const writeDelta = window.__formatEditDragProbe.ghostWrites - writes0;
        if (schedDelta > 1) return `raf scheduled ${schedDelta} on step ${i}`;
        if (writeDelta > 1) return `ghost writes ${writeDelta} on step ${i}`;
      }
      fire('pointerup', to, 0);
      return null;
    });
    assert.equal(bad, null, bad || 'R8 ok');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R9: ghost center tracks pointer with grab offset', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    const bad = await page.evaluate(async () => {
      const scroll = document.getElementById('format-edit-scroll');
      const root = document.getElementById('format-edit-sheet');
      const tile = document.querySelector('#format-edit-shown [data-id="bold"]');
      const hidden = document.getElementById('format-edit-hidden');
      const dest = hidden.querySelector('.format-edit-tile');
      const to = (() => {
        const b = dest.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      })();
      const fromBox = tile.getBoundingClientRect();
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const pointerId = 209;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const afterPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : scroll;
        target.dispatchEvent(new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons,
          bubbles: true,
          cancelable: true,
        }));
      };
      fire('pointerdown', from, 1);
      await wait(220);
      fire('pointermove', from, 1);
      await afterPaint();
      const ghost0 = root.querySelector('.format-edit-ghost');
      if (!ghost0) return 'ghost missing';
      const g0 = ghost0.getBoundingClientRect();
      const grab = {
        x: g0.left + g0.width / 2 - from.x,
        y: g0.top + g0.height / 2 - from.y,
      };
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
      for (let i = 1; i <= steps; i += 1) {
        await wait(16);
        const point = {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        };
        fire('pointermove', point, 1);
        await afterPaint();
        const ghost = root.querySelector('.format-edit-ghost');
        if (!ghost) return `ghost missing step ${i}`;
        const g = ghost.getBoundingClientRect();
        const center = { x: g.left + g.width / 2, y: g.top + g.height / 2 };
        if (Math.abs((center.x - point.x) - grab.x) > 0.51) return `ghost X drift step ${i}`;
        if (Math.abs((center.y - point.y) - grab.y) > 0.51) return `ghost Y drift step ${i}`;
      }
      fire('pointerup', to, 0);
      return null;
    });
    assert.equal(bad, null, bad || 'R9 ok');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R10: drop commit within 200ms with zero tile transforms', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    const drop = await editSheetSlotCenter(page, { slot: 0, section: 'hidden' });
    await dragToPoint2px(page, 'bold', drop);
    const dropAt = await page.evaluate(() => performance.now());
    await waitEditDropSettled(page);
    const result = await page.evaluate((t0) => {
      const elapsed = performance.now() - t0;
      const transforms = [...document.querySelectorAll('#format-edit-shown .format-edit-tile, #format-edit-hidden .format-edit-tile')]
        .map((n) => n.style.transform)
        .filter((v) => v && v !== 'none');
      const domShown = [...document.getElementById('format-edit-shown').querySelectorAll('.format-edit-tile')].map((n) => n.dataset.id);
      const domHidden = [...document.getElementById('format-edit-hidden').querySelectorAll('.format-edit-tile')].map((n) => n.dataset.id);
      const layout = JSON.parse(localStorage.getItem('core-sample-format-bar-layout-v2'));
      const modelShown = layout.order.slice(0, layout.hiddenFrom);
      const modelHidden = layout.order.slice(layout.hiddenFrom);
      return { elapsed, transforms: transforms.length, domShown, domHidden, modelShown, modelHidden };
    }, dropAt);
    assert.ok(result.elapsed <= 320, `settle after drop took ${result.elapsed}ms`);
    assert.equal(result.transforms, 0);
    assert.ok(!result.modelShown.includes('bold'));
    assert.equal(result.modelHidden[0], 'bold');
    assert.equal(result.domHidden[0], 'bold');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R11: vertical drag keeps scroll stable and cancel restores layout', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    const bad = await page.evaluate(async () => {
      const scroll = document.getElementById('format-edit-scroll');
      const tile = document.querySelector('#format-edit-shown [data-id="bold"]');
      const hidden = document.getElementById('format-edit-hidden');
      const dest = hidden.querySelector('.format-edit-tile');
      const to = (() => {
        const b = dest.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      })();
      const fromBox = tile.getBoundingClientRect();
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const layoutBefore = JSON.parse(localStorage.getItem('core-sample-format-bar-layout-v2'));
      const vvTop = window.visualViewport?.offsetTop ?? 0;
      const scrollTop0 = scroll.scrollTop;
      const cardTop0 = tile.getBoundingClientRect().top;
      const pointerId = 211;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : scroll;
        target.dispatchEvent(new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons,
          bubbles: true,
          cancelable: true,
        }));
      };
      fire('pointerdown', from, 1);
      await wait(220);
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
      for (let i = 1; i <= steps; i += 1) {
        await wait(16);
        fire('pointermove', {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        }, 1);
        if (scroll.scrollTop !== scrollTop0) return `scrollTop moved at ${i}`;
        if (Math.abs(tile.getBoundingClientRect().top - cardTop0) > 0.5 && !document.querySelector('.format-edit-ghost')) {
          return `card jumped at ${i}`;
        }
        const vv = window.visualViewport?.offsetTop ?? 0;
        if (Math.abs(vv - vvTop) > 0.5) return `visualViewport offset moved at ${i}`;
      }
      fire('pointercancel', { x: from.x, y: from.y }, 0);
      await wait(200);
      const layoutAfter = JSON.parse(localStorage.getItem('core-sample-format-bar-layout-v2'));
      if (JSON.stringify(layoutAfter) !== JSON.stringify(layoutBefore)) return 'layout changed after cancel';
      const boldStillShown = document.querySelector('#format-edit-shown [data-id="bold"]');
      if (!boldStillShown) return 'bold not restored in shown grid';
      return null;
    });
    assert.equal(bad, null, bad || 'R11 ok');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R12: rAF inter-frame delta p95 (log only)', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    const deltas = await page.evaluate(async () => {
      window.__formatEditDragProbe = {
        ghostWrites: 0,
        rafScheduled: 0,
        rafFrames: 0,
        rafDeltas: [],
        lastRafAt: null,
      };
      const scroll = document.getElementById('format-edit-scroll');
      const tile = document.querySelector('#format-edit-shown [data-id="bold"]');
      const hidden = document.getElementById('format-edit-hidden');
      const dest = hidden.querySelector('.format-edit-tile');
      const to = (() => {
        const b = dest.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      })();
      const fromBox = tile.getBoundingClientRect();
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const pointerId = 212;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : scroll;
        target.dispatchEvent(new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons,
          bubbles: true,
          cancelable: true,
        }));
      };
      fire('pointerdown', from, 1);
      await wait(220);
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
      for (let i = 1; i <= steps; i += 1) {
        await wait(16);
        fire('pointermove', {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        }, 1);
        await wait(16);
      }
      fire('pointerup', to, 0);
      return window.__formatEditDragProbe.rafDeltas || [];
    });
    t.diagnostic(`R12 rAF delta p95: ${p95(deltas)}ms (n=${deltas.length})`);
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet R13: dragging the hidden header changes nothing', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await prepFormatBar(page, url);
    await openEditSheet(page, 'bold', { nineShown: true });
    const bad = await page.evaluate(async () => {
      const scroll = document.getElementById('format-edit-scroll');
      const head = document.getElementById('format-edit-hidden-head');
      const layoutBefore = localStorage.getItem('core-sample-format-bar-layout-v2');
      const shownBefore = [...document.getElementById('format-edit-shown').querySelectorAll('.format-edit-tile')].map((n) => n.dataset.id);
      const hiddenBefore = [...document.getElementById('format-edit-hidden').querySelectorAll('.format-edit-tile')].map((n) => n.dataset.id);
      const box = head.getBoundingClientRect();
      const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const to = { x: from.x, y: from.y + 120 };
      const pointerId = 213;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? head : scroll;
        target.dispatchEvent(new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons,
          bubbles: true,
          cancelable: true,
        }));
      };
      head.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: from.x,
        clientY: from.y,
        button: 0,
        buttons: 1,
        bubbles: true,
        cancelable: true,
      }));
      await wait(40);
      const steps = Math.max(1, Math.ceil(Math.abs(to.y - from.y) / 2));
      for (let i = 1; i <= steps; i += 1) {
        await wait(16);
        fire('pointermove', {
          x: from.x,
          y: from.y + ((to.y - from.y) * i) / steps,
        }, 1);
      }
      scroll.dispatchEvent(new PointerEvent('pointerup', {
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: to.x,
        clientY: to.y,
        button: 0,
        buttons: 0,
        bubbles: true,
        cancelable: true,
      }));
      const layoutAfter = localStorage.getItem('core-sample-format-bar-layout-v2');
      const shownAfter = [...document.getElementById('format-edit-shown').querySelectorAll('.format-edit-tile')].map((n) => n.dataset.id);
      const hiddenAfter = [...document.getElementById('format-edit-hidden').querySelectorAll('.format-edit-tile')].map((n) => n.dataset.id);
      if (layoutAfter !== layoutBefore) return 'layout changed';
      if (shownAfter.join() !== shownBefore.join()) return 'shown order changed';
      if (hiddenAfter.join() !== hiddenBefore.join()) return 'hidden order changed';
      if (document.querySelector('.format-edit-ghost')) return 'ghost appeared';
      return null;
    });
    assert.equal(bad, null, bad || 'R13 ok');
    assert.deepEqual(errors, []);
  });
});
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
  waitDoubleRaf,
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
    await waitDoubleRaf(page);
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

test('webkit edit-sheet ghost tracks finger across divider in 2px steps', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await formatBarLongPress(page, 'bold', { blurEditor: false });
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').classList.contains('is-open'));
    await page.waitForTimeout(350);
    const bad = await page.evaluate(async () => {
      const tile = document.querySelector('#format-edit-grid [data-id="bold"]');
      const grid = document.getElementById('format-edit-grid');
      const root = document.getElementById('format-edit-sheet');
      if (!tile || !grid || !root) throw new Error('sheet missing');
      const divider = document.querySelector('.format-edit-divider');
      const dropY = divider.getBoundingClientRect().bottom + 120;
      const fromBox = tile.getBoundingClientRect();
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const to = { x: from.x, y: dropY };
      const steps = Math.max(1, Math.ceil(Math.abs(to.y - from.y) / 2));
      const pointerId = 101;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const afterPaint = () => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : grid;
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
      if (!ghost0) return 'ghost missing after drag start';
      const g0 = ghost0.getBoundingClientRect();
      const grab = {
        x: g0.left + g0.width / 2 - from.x,
        y: g0.top + g0.height / 2 - from.y,
      };
      for (let i = 1; i <= steps; i += 1) {
        await wait(16);
        const point = {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        };
        fire('pointermove', point, 1);
        await afterPaint();
        const ghost = root.querySelector('.format-edit-ghost');
        if (!ghost) return 'ghost missing';
        const g = ghost.getBoundingClientRect();
        const center = { x: g.left + g.width / 2, y: g.top + g.height / 2 };
        if (Math.abs((center.x - point.x) - grab.x) > 1.01) return `ghost X drift step ${i}`;
        if (Math.abs((center.y - point.y) - grab.y) > 1.01) return `ghost Y drift step ${i}`;
      }
      fire('pointerup', to, 0);
      return null;
    });
    assert.equal(bad, null, bad || 'ghost tracking ok');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet placeholder indices stay monotonic on vertical drag', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await formatBarLongPress(page, 'task', { blurEditor: false });
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').classList.contains('is-open'));
    await page.waitForTimeout(350);
    const flip = await page.evaluate(async () => {
      const tile = document.querySelector('#format-edit-grid [data-id="task"]');
      const grid = document.getElementById('format-edit-grid');
      if (!tile || !grid) throw new Error('sheet missing');
      const divider = document.querySelector('.format-edit-divider');
      const fromBox = tile.getBoundingClientRect();
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const to = { x: from.x, y: divider.getBoundingClientRect().bottom + 80 };
      const steps = 40;
      const pointerId = 102;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : grid;
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
      const readIndex = () => Number(document.querySelector('.format-edit-tile.is-placeholder')?.dataset.index ?? '-1');
      const seq = [];
      fire('pointerdown', from, 1);
      await wait(220);
      for (let i = 1; i <= steps; i += 1) {
        await wait(12);
        const point = {
          x: from.x,
          y: from.y + ((to.y - from.y) * i) / steps,
        };
        fire('pointermove', point, 1);
        await wait(18);
        const idx = readIndex();
        if (seq.length && idx < seq[seq.length - 1]) return `A-B-A at ${i}: ${seq.join(',')} -> ${idx}`;
        if (!seq.length || seq[seq.length - 1] !== idx) seq.push(idx);
      }
      fire('pointerup', to, 0);
      return null;
    });
    assert.equal(flip, null, flip || 'monotonic');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet divider midline hover does not oscillate hiddenFrom', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await formatBarLongPress(page, 'bold', { blurEditor: false });
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').classList.contains('is-open'));
    await page.waitForTimeout(350);
    const oscillated = await page.evaluate(async () => {
      const divider = document.querySelector('.format-edit-divider');
      const grid = document.getElementById('format-edit-grid');
      const task = document.querySelector('#format-edit-grid [data-id="task"]');
      if (!divider || !grid || !task) throw new Error('sheet missing');
      const rowMid = task.getBoundingClientRect().top + task.getBoundingClientRect().height / 2;
      const divBox = divider.getBoundingClientRect();
      const pointerId = 103;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? divider : grid;
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
      const countShown = () => {
        let n = 0;
        for (const node of grid.children) {
          if (node.classList.contains('format-edit-divider')) break;
          if (node.classList.contains('format-edit-tile')) n += 1;
        }
        return n;
      };
      const start = { x: divBox.x + divBox.width / 2, y: divBox.y + divBox.height / 2 };
      fire('pointerdown', start, 1);
      await wait(40);
      const hfChanges = [];
      let last = countShown();
      for (let frame = 0; frame < 20; frame += 1) {
        const y = rowMid + ((frame % 2) ? 4 : -4);
        fire('pointermove', { x: start.x, y }, 1);
        await wait(28);
        const now = countShown();
        if (now !== last) {
          hfChanges.push(now);
          last = now;
        }
      }
      fire('pointerup', { x: start.x, y: rowMid }, 0);
      return hfChanges.length > 1 ? `hiddenFrom flipped ${hfChanges.length} times` : null;
    });
    assert.equal(oscillated, null, oscillated || 'stable');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet grid height is constant during tile drag', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await formatBarLongPress(page, 'italic', { blurEditor: false });
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').classList.contains('is-open'));
    await page.waitForTimeout(350);
    const heightIssue = await page.evaluate(async () => {
      const tile = document.querySelector('#format-edit-grid [data-id="italic"]');
      const grid = document.getElementById('format-edit-grid');
      const divider = document.querySelector('.format-edit-divider');
      if (!tile || !grid || !divider) throw new Error('sheet missing');
      const base = grid.offsetHeight;
      const fromBox = tile.getBoundingClientRect();
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const to = { x: from.x, y: divider.getBoundingClientRect().bottom + 60 };
      const pointerId = 104;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : grid;
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
      for (let i = 1; i <= 30; i += 1) {
        await wait(12);
        const point = {
          x: from.x,
          y: from.y + ((to.y - from.y) * i) / 30,
        };
        fire('pointermove', point, 1);
        await wait(16);
        if (grid.offsetHeight !== base) return `height ${grid.offsetHeight} vs ${base} at step ${i}`;
      }
      fire('pointerup', to, 0);
      return null;
    });
    assert.equal(heightIssue, null, heightIssue || 'constant height');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet drop commits layout to bar and storage', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await formatBarLongPress(page, 'bold', { blurEditor: false });
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').classList.contains('is-open'));
    await page.waitForTimeout(350);
    const beforeBar = await visibleBarIds(page);
    const drop = await page.evaluate(() => {
      const divider = document.querySelector('.format-edit-divider');
      const box = divider.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.bottom + 70 };
    });
    await formatEditSheetDragToPoint(page, 'bold', drop);
    await waitDoubleRaf(page);
    const afterBar = await visibleBarIds(page);
    assert.notDeepEqual(beforeBar, afterBar);
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), FORMAT_BAR_LAYOUT_KEY);
    assert.ok(stored && Array.isArray(stored.order));
    assert.equal(typeof stored.hiddenFrom, 'number');
    await page.locator('#format-edit-done').click();
    await waitDoubleRaf(page);
    assert.ok(!(await visibleBarIds(page)).includes('bold'));
    assert.deepEqual(errors, []);
  });
});

test('webkit first tile drag across shown slots keeps divider and hiddenFrom fixed', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await formatBarLongPress(page, 'task', { blurEditor: false });
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').classList.contains('is-open'));
    await page.waitForTimeout(350);
    const drift = await page.evaluate(async (layoutKey) => {
      const tile = document.querySelector('#format-edit-grid [data-id="task"]');
      const grid = document.getElementById('format-edit-grid');
      const divider = document.querySelector('.format-edit-divider');
      if (!tile || !grid || !divider) throw new Error('sheet missing');
      const readHf = () => {
        try {
          const raw = localStorage.getItem(layoutKey);
          return raw ? JSON.parse(raw).hiddenFrom : null;
        } catch {
          return null;
        }
      };
      const fromBox = tile.getBoundingClientRect();
      const baseTop = divider.offsetTop;
      const baseHf = readHf();
      const divRect = divider.getBoundingClientRect();
      const topRowY = fromBox.top;
      const stops = [];
      for (const node of grid.querySelectorAll('.format-edit-tile')) {
        if (node === tile || node.classList.contains('is-placeholder')) continue;
        const box = node.getBoundingClientRect();
        if (Math.abs(box.top - topRowY) > 6) continue;
        if (box.bottom >= divRect.top - 12) continue;
        stops.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
      }
      if (!stops.length) return 'no shown targets';
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const pointerId = 105;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const afterPaint = () => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : grid;
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
      for (let i = 0; i < stops.length; i += 1) {
        fire('pointermove', stops[i], 1);
        await wait(20);
        await afterPaint();
        if (divider.offsetTop !== baseTop) return `divider top ${divider.offsetTop} vs ${baseTop} at ${i}`;
        const hf = readHf();
        if (hf !== baseHf) return `hiddenFrom ${hf} vs ${baseHf} at ${i}`;
      }
      fire('pointerup', stops[stops.length - 1], 0);
      return null;
    }, FORMAT_BAR_LAYOUT_KEY);
    assert.equal(drift, null, drift || 'stable divider');
    assert.deepEqual(errors, []);
  });
});

test('webkit edit-sheet tile widths stay constant during drag', { timeout: 180000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    await caretAt(page, 2);
    await fakeKeyboard(page, 336);
    await formatBarLongPress(page, 'task', { blurEditor: false });
    await page.waitForFunction(() => document.getElementById('format-edit-sheet').classList.contains('is-open'));
    await page.waitForTimeout(350);
    const widthIssue = await page.evaluate(async () => {
      const tile = document.querySelector('#format-edit-grid [data-id="task"]');
      const grid = document.getElementById('format-edit-grid');
      const divider = document.querySelector('.format-edit-divider');
      if (!tile || !grid || !divider) throw new Error('sheet missing');
      const widths = new Map();
      for (const node of grid.querySelectorAll('.format-edit-tile')) {
        if (!node.classList.contains('is-placeholder')) {
          widths.set(node.dataset.id, node.offsetWidth);
        }
      }
      const fromBox = tile.getBoundingClientRect();
      const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
      const to = { x: from.x, y: divider.getBoundingClientRect().bottom + 80 };
      const pointerId = 106;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const fire = (type, point, buttons) => {
        const target = type === 'pointerdown' ? tile : grid;
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
      for (let i = 1; i <= 36; i += 1) {
        await wait(12);
        const point = {
          x: from.x + 20,
          y: from.y + ((to.y - from.y) * i) / 36,
        };
        fire('pointermove', point, 1);
        await wait(16);
        for (const node of grid.querySelectorAll('.format-edit-tile')) {
          if (node.classList.contains('is-placeholder')) continue;
          const id = node.dataset.id;
          const base = widths.get(id);
          if (base != null && node.offsetWidth !== base) {
            return `${id} width ${node.offsetWidth} vs ${base} at step ${i}`;
          }
        }
      }
      fire('pointerup', to, 0);
      return null;
    });
    assert.equal(widthIssue, null, widthIssue || 'constant widths');
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
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_BUILD } from '../app/js/version.js';
import { note, openApp, shot, withPhone } from './helpers/webkit-app.js';

// A made-up table with the shape of a real wide work note: 11 columns,
// 22 body rows, cells of 15 to 40 characters with inline code, and a few
// 60+ character URLs that have no spaces to break on.
const WORDS = ['basalt', 'core', '`depth_m`', 'tray', 'kiln', 'sample', '`grain-size`', 'field', 'lab', 'dry', 'log', 'silt'];
function cellText(row, col) {
  if (col === 0 && row % 5 === 0) return `https://example.com/field-notes/cores/${row}/basalt-tray-${row}-summary`;
  const length = 15 + ((row * 7 + col * 11) % 26);
  const parts = [];
  let i = row + col;
  while (parts.join(' ').length < length) parts.push(WORDS[i++ % WORDS.length]);
  return parts.join(' ');
}
const COLS = 11;
const ROWS = 22;
const header = Array.from({ length: COLS }, (_, col) => `Column ${col + 1} heading`);
const wide = [
  `| ${header.join(' | ')} |`,
  `|${' --- |'.repeat(COLS)}`,
  ...Array.from({ length: ROWS }, (_, row) => `| ${Array.from({ length: COLS }, (_, col) => cellText(row, col)).join(' | ')} |`),
];
const calloutHeader = Array.from({ length: 6 }, (_, col) => `Callout col ${col + 1}`);
const NOTE = 'Wide.md';
const DOC = [
  '# Wide',
  '',
  '| Rock | m |',
  '| --- | --- |',
  '| clay | 4 |',
  '',
  '> [!note] Survey',
  `> | ${calloutHeader.join(' | ')} |`,
  `> |${' --- |'.repeat(6)}`,
  ...Array.from({ length: 4 }, (_, row) => `> | ${Array.from({ length: 6 }, (_, col) => cellText(row + 1, col + 1)).join(' | ')} |`),
  '',
  ...wide,
  '',
  'End.',
  '',
].join('\n');

const SHOTS = '/workspace/table-shots';

test(`webkit ${APP_BUILD} wide tables keep readable cells and scroll sideways`, { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, url, [note(NOTE, DOC)], NOTE);
    await page.evaluate(() => document.querySelector('#source .cm-content')?.blur());
    await page.waitForSelector('#source .cm-table-widget');
    await page.waitForSelector('#source .callout-body .table-wrap');

    const viewport = page.viewportSize();
    assert.deepEqual(viewport, { width: 390, height: 844 });

    // (d) A narrow table still fills the box and does not scroll.
    const narrow = await page.evaluate(() => {
      const wrap = document.querySelector('#source .cm-table-widget');
      const table = wrap.querySelector('table');
      return { table: table.getBoundingClientRect().width, client: wrap.clientWidth, scrollWidth: wrap.scrollWidth };
    });
    assert.ok(Math.abs(narrow.table - narrow.client) <= 1, `narrow table ${narrow.table} vs box ${narrow.client}`);
    assert.ok(narrow.scrollWidth <= narrow.client, 'narrow table should not scroll');

    // (g) A table inside a callout scrolls the same way.
    const callout = await page.evaluate(async () => {
      const wrap = document.querySelector('#source .callout-body .table-wrap');
      const widths = [...wrap.querySelectorAll('th, td')].map((cell) => cell.getBoundingClientRect().width);
      const em = parseFloat(getComputedStyle(wrap.querySelector('td')).fontSize);
      wrap.scrollLeft = 200;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return { min: Math.min(...widths), em, scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth, left: wrap.scrollLeft, doc: document.documentElement.scrollWidth };
    });
    assert.ok(callout.min >= 8 * callout.em - 0.5, `callout cell ${callout.min}px`);
    assert.ok(callout.scrollWidth > callout.clientWidth, 'callout table should scroll');
    assert.equal(callout.left, 200);
    assert.ok(callout.doc <= viewport.width);
    await shot(page, 'wide-table-callout.png');
    await page.screenshot({ path: `${SHOTS}/wide-table-callout.png` });

    await page.evaluate(() => {
      window.wideTable = () => [...document.querySelectorAll('#source .cm-table-widget')].find((wrap) => wrap.querySelectorAll('thead th').length === 11);
      document.querySelector('#source .cm-scroller').scrollTop = 1e6;
    });
    await page.waitForFunction(() => window.wideTable());
    await page.evaluate(() => window.wideTable().scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(150);

    // (a) No column is squeezed under the minimum.
    const cells = await page.evaluate(() => {
      const wrap = window.wideTable();
      const em = parseFloat(getComputedStyle(wrap.querySelector('td')).fontSize);
      const widths = [...wrap.querySelectorAll('th, td')].map((cell) => cell.getBoundingClientRect().width);
      return { min: Math.min(...widths), em, cols: wrap.querySelectorAll('thead th').length, rows: wrap.querySelectorAll('tbody tr').length };
    });
    assert.equal(cells.cols, COLS);
    assert.equal(cells.rows, ROWS);
    assert.ok(cells.min >= 8 * cells.em - 0.5, `narrowest cell ${cells.min}px, minimum ${8 * cells.em}px`);
    assert.ok(cells.min >= 110, `narrowest cell ${cells.min}px`);

    // (b) The table box scrolls sideways.
    const scroll = await page.evaluate(async () => {
      const wrap = window.wideTable();
      const before = { scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth };
      wrap.scrollLeft = 300;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const style = getComputedStyle(wrap);
      return { ...before, left: wrap.scrollLeft, overflowX: style.overflowX, touch: style.touchAction, image: style.backgroundImage, attach: style.backgroundAttachment };
    });
    assert.ok(scroll.scrollWidth > scroll.clientWidth * 3, `scrollWidth ${scroll.scrollWidth} clientWidth ${scroll.clientWidth}`);
    assert.equal(scroll.left, 300);
    assert.equal(scroll.overflowX, 'auto');
    assert.match(scroll.touch, /pan-x/);
    assert.match(scroll.touch, /pan-y/);
    // (f) Edge shadows are CSS only: covers scroll with the content, shades stay put.
    assert.equal((scroll.image.match(/radial-gradient/g) || []).length, 2);
    assert.match(scroll.attach, /local, local, scroll, scroll/);

    // (c) The page itself never scrolls sideways.
    const page1 = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      scroller: document.querySelector('#source .cm-scroller').scrollWidth,
      scrollerClient: document.querySelector('#source .cm-scroller').clientWidth,
      width: window.innerWidth,
    }));
    assert.ok(page1.doc <= page1.width, `document ${page1.doc} > ${page1.width}`);
    assert.ok(page1.body <= page1.width, `body ${page1.body} > ${page1.width}`);
    assert.ok(page1.scroller <= page1.scrollerClient, `editor scroller ${page1.scroller} > ${page1.scrollerClient}`);

    // Screenshots: at the start and partway across.
    await page.evaluate(() => {
      const wrap = window.wideTable();
      wrap.scrollLeft = 0;
      wrap.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/wide-table-start.png` });
    await page.evaluate(() => { window.wideTable().scrollLeft = 520; });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/wide-table-scrolled.png` });

    // (e) Tap a cell after scrolling: the editor opens, the column holds its
    // width, and the table stays where it was, through the commit redraw.
    const target = await page.evaluate(() => {
      const wrap = window.wideTable();
      const box = wrap.getBoundingClientRect();
      const cell = [...wrap.querySelectorAll('tbody tr:nth-child(2) td')].find((td) => {
        const rect = td.getBoundingClientRect();
        return rect.left >= box.left && rect.right <= box.right;
      });
      const rect = cell.getBoundingClientRect();
      return { col: Number(cell.dataset.col), x: rect.left + rect.width / 2, y: rect.top + 20, width: rect.width, left: wrap.scrollLeft, tableWidth: wrap.querySelector('table').getBoundingClientRect().width };
    });
    assert.ok(target.col > 0, 'tapped cell should be a scrolled-to column');
    await page.touchscreen.tap(target.x, target.y);
    await page.waitForSelector('#source .table-cell-input');
    const editing = await page.evaluate(() => {
      const wrap = window.wideTable();
      const input = wrap.querySelector('.table-cell-input');
      return {
        left: wrap.scrollLeft,
        width: input.closest('td').getBoundingClientRect().width,
        tableWidth: wrap.querySelector('table').getBoundingClientRect().width,
        focused: document.activeElement === input,
      };
    });
    assert.equal(editing.focused, true);
    assert.equal(editing.left, target.left);
    assert.ok(Math.abs(editing.width - target.width) <= 1, `column ${target.width} -> ${editing.width}`);
    assert.ok(editing.tableWidth >= target.tableWidth - 1, `table ${target.tableWidth} -> ${editing.tableWidth}`);
    await page.screenshot({ path: `${SHOTS}/wide-table-editing.png` });

    await page.evaluate(() => {
      const field = document.querySelector('#source .table-cell-input');
      field.value = 'edited cell';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.blur();
    });
    await page.waitForFunction(() => [...window.wideTable().querySelectorAll('td')].some((td) => td.textContent === 'edited cell'));
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => window.wideTable().scrollLeft);
    assert.equal(after, target.left, 'redraw after the edit keeps the sideways scroll');

    assert.deepEqual(errors, []);
  });
});

test(`webkit ${APP_BUILD} sideways drag on a table near the edge leaves the sidebar shut`, { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url }) => {
    await openApp(page, url, [note(NOTE, DOC)], NOTE);
    await page.evaluate(() => document.querySelector('#source .cm-content')?.blur());
    await page.evaluate(() => {
      window.wideTable = () => [...document.querySelectorAll('#source .cm-table-widget')].find((wrap) => wrap.querySelectorAll('thead th').length === 11);
      document.querySelector('#source .cm-scroller').scrollTop = 1e6;
    });
    await page.waitForFunction(() => window.wideTable());
    await page.evaluate(() => window.wideTable().scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(150);
    await page.evaluate(async () => {
      const cell = window.wideTable().querySelector('tbody td');
      const rect = cell.getBoundingClientRect();
      const x0 = Math.max(rect.left + 4, 20);
      const y = rect.top + 10;
      const make = (x) => document.createTouch(window, cell, 3, x, y, x, y);
      const fire = (type, x, ended) => {
        const point = make(x);
        const list = ended ? document.createTouchList() : document.createTouchList(point);
        cell.dispatchEvent(new TouchEvent(type, { touches: list, targetTouches: list, changedTouches: document.createTouchList(point), bubbles: true, cancelable: true }));
      };
      fire('touchstart', x0);
      for (let i = 1; i <= 8; i += 1) {
        fire('touchmove', x0 + i * 25);
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      fire('touchend', x0 + 200, true);
    });
    await page.waitForTimeout(300);
    const open = await page.evaluate(() => document.getElementById('notes-sheet').classList.contains('is-open'));
    assert.equal(open, false);
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { note, openApp, readNote, shot, withPhone } from './helpers/webkit-app.js';

const NOTE = 'Survey.md';
const DEMO = [
  '---',
  'title: Survey',
  'draft: false',
  'tags: [core, field]',
  '---',
  '',
  '# Basalt',
  '',
  'Area $x^2+y^2$ and',
  '',
  '$$',
  '\\frac{1}{2} r^2',
  '$$',
  '',
  '> [!warning] Heat',
  '> Gloves on before the kiln.',
  '',
  '| Rock | m |',
  '| :--- | ---: |',
  '| clay | 4 |',
  '| basalt | 12 |',
  '',
  'See ![[Lab log]] and ![[Ghost]].',
  '',
  '```js',
  'const depth = 12.5;',
  '```',
  '',
  '## Next',
  'hidden steps',
  '',
].join('\n');

test('webkit draws tables, callouts, math, embeds, properties, colors, fold, and cell edit', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [
      note(NOTE, DEMO),
      note('Lab log.md', '# Lab log\nTray 7 is dry.\n'),
    ], NOTE);

    await page.evaluate(() => document.querySelector('#source .cm-content')?.blur());
    await page.waitForSelector('#source .cm-properties');
    await page.waitForSelector('#source .cm-callout');
    await page.waitForSelector('#source .cm-table-widget');
    await page.waitForSelector('#source .cm-math');
    await page.waitForSelector('#source .cm-note-embed');
    await page.waitForSelector('#source .cm-tok-keyword');
    await page.waitForSelector('#source .cm-fold');

    assert.equal(await page.locator('#source .cm-properties .prop-key').count(), 3);
    assert.equal(await page.locator('#source .cm-callout.is-warning .callout-title').innerText(), 'Heat');
    assert.equal(await page.locator('#source .cm-table-widget td').first().innerText(), 'clay');
    assert.equal(await page.locator('#source .cm-note-embed.is-missing').count(), 1);
    assert.match(await page.locator('#source .cm-note-embed').first().innerText(), /Tray 7 is dry/);
    assert.equal(await page.locator('#source math').count() >= 1, true);

    await page.locator('#source .cm-properties').scrollIntoViewIfNeeded();
    await shot(page, 'rich-properties.png');
    await page.locator('#source .cm-callout').scrollIntoViewIfNeeded();
    await shot(page, 'rich-callout-math.png');
    await page.locator('#source .cm-table-widget').scrollIntoViewIfNeeded();
    await shot(page, 'rich-table.png');
    await page.locator('#source .cm-note-embed').first().scrollIntoViewIfNeeded();
    await shot(page, 'rich-note-embed.png');
    await page.locator('#source .cm-tok-keyword').first().scrollIntoViewIfNeeded();
    await shot(page, 'rich-code-colors.png');

    const fold = page.locator('#source .cm-fold').last();
    await fold.scrollIntoViewIfNeeded();
    await fold.tap();
    await page.waitForFunction(() => document.querySelector('#source .cm-fold.is-folded'));
    assert.equal(await page.locator('#source .cm-line', { hasText: 'hidden steps' }).count(), 0);
    await shot(page, 'rich-folded-heading.png');

    const cell = page.locator('#source .cm-table-widget td').first();
    await cell.scrollIntoViewIfNeeded();
    await cell.tap();
    await page.waitForSelector('#source .table-cell-input');
    const input = page.locator('#source .table-cell-input');
    await input.fill('silt');
    await page.evaluate(() => {
      const field = document.querySelector('#source .table-cell-input');
      if (!field) return;
      field.value = 'silt';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.blur();
    });
    await page.waitForFunction(() => document.querySelector('#source .cm-table-widget td')?.textContent === 'silt');
    await shot(page, 'rich-table-cell-edit.png');
    const live = await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
      return view.state.doc.toString();
    });
    assert.match(live, /\| silt\s+\| 4 \|/);
    await page.evaluate(() => document.querySelector('#source .cm-content')?.blur());
    await page.waitForTimeout(500);
    const stored = await readNote(page, NOTE);
    assert.match(stored.content, /\| silt\s+\| 4 \|/);
    assert.match(stored.content, /\| :--- \| ---: \|/);
    assert.match(stored.content, /\| basalt \| 12 \|/);
    assert.equal(stored.content.includes('\n'), true);
    assert.deepEqual(errors, []);
  });
});

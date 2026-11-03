import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { note, openApp, readNote, shot, withPhone } from './helpers/webkit-app.js';

const ART = join(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');
const DASH = 'Board.md';
const QUERY = [
  '# Board',
  '',
  '```dataview',
  'TASK',
  'WHERE !completed',
  'WHERE contains(text, "#todo")',
  '```',
  '',
].join('\n');
const INBOX = '- [ ] Label the trays #todo\n- [x] Photograph core #todo\n- [ ] Skip this\n';
const PLAN = '- [ ] Write the summary #todo\n';
const UNSUPPORTED = '# Other\n\n```dataview\nLIST FROM #todo\n```\n';

async function artShot(page, name) {
  await mkdir(ART, { recursive: true });
  await page.screenshot({ path: join(ART, name), fullPage: true });
  await shot(page, name);
}

async function caretAt(page, offset) {
  await page.evaluate(async (offset) => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.focus();
    view.dispatch({ selection: { anchor: offset } });
  }, offset);
  await page.waitForTimeout(50);
}

test('webkit renders a TASK query, shows the raw block with the caret inside, and toggles the source note', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [
      note(DASH, QUERY),
      note('Inbox.md', INBOX),
      note('Projects/Plan.md', PLAN),
    ], DASH);
    await page.waitForSelector('#source .cm-dataview');
    const files = await page.locator('#source .dv-file').allTextContents();
    assert.deepEqual(files, ['Inbox', 'Plan']);
    const tasks = await page.locator('#source .dv-text').allTextContents();
    assert.deepEqual(tasks, ['Label the trays #todo', 'Write the summary #todo']);
    assert.equal(await page.locator('#source .cm-dataview .task-toggle').count(), 2);
    assert.equal((await readNote(page, DASH)).content, QUERY);
    await artShot(page, 'dataview-widget.png');

    await caretAt(page, QUERY.indexOf('TASK'));
    const raw = await page.evaluate(() => [...document.querySelectorAll('#source .cm-line')].map((line) => line.textContent).join('\n'));
    assert.match(raw, /```dataview/);
    assert.match(raw, /WHERE !completed/);
    assert.equal(await page.locator('#source .cm-dataview').count(), 0);
    await artShot(page, 'dataview-raw-query.png');

    await page.evaluate(() => document.querySelector('#source .cm-content')?.blur());
    await page.waitForSelector('#source .cm-dataview [data-live="dv-check"]');
    const box = page.locator('#source .cm-dataview [data-live="dv-check"]').first();
    assert.equal(await box.getAttribute('aria-checked'), 'false');
    await box.tap();
    await page.waitForFunction(async () => {
      const read = (path) => new Promise((resolve) => {
        const request = indexedDB.open('core-sample');
        request.onsuccess = () => {
          const get = request.result.transaction('files').objectStore('files').get(path);
          get.onsuccess = () => { request.result.close(); resolve(get.result?.content || ''); };
        };
      });
      return (await read('Inbox.md')).includes('- [x] Label the trays #todo');
    });
    const focused = await page.evaluate(() => Boolean(document.activeElement?.closest?.('.cm-content')));
    assert.equal(focused, false, 'the keyboard stays down');
    await page.waitForFunction(() => {
      const texts = [...document.querySelectorAll('#source .cm-dataview .dv-text')].map((node) => node.textContent);
      return texts.length === 1 && texts[0] === 'Write the summary #todo';
    });
    assert.equal((await readNote(page, 'Inbox.md')).content, INBOX.replace('- [ ] Label', '- [x] Label'));
    assert.equal((await readNote(page, DASH)).content, QUERY, 'rendering and toggle leave the query note untouched');
    await artShot(page, 'dataview-toggled.png');
    assert.deepEqual(errors, []);
  });
});

test('webkit unsupported queries show the raw block and a fallback note', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [note('Other.md', UNSUPPORTED)], 'Other.md');
    await page.waitForSelector('#source .cm-dataview.is-unsupported');
    assert.equal(await page.locator('#source .dv-note').textContent(), 'Not supported in Core Sample yet');
    assert.match(await page.locator('#source .dv-source').textContent(), /LIST FROM #todo/);
    assert.equal((await readNote(page, 'Other.md')).content, UNSUPPORTED);
    await artShot(page, 'dataview-unsupported.png');
    assert.deepEqual(errors, []);
  });
});

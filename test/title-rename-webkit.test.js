import assert from 'node:assert/strict';
import { test } from 'node:test';
import { note, openApp, readNote, shot, withPhone } from './helpers/webkit-app.js';

const LONG = ['# Draft', '', ...Array.from({ length: 60 }, (_, i) => `Layer ${i} of the core.`)].join('\n') + '\n';

function place(page) {
  return page.evaluate(async () => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    const main = view.state.selection.main;
    return { anchor: main.anchor, head: main.head, scroll: view.scrollDOM.scrollTop };
  });
}

test('webkit tapping the note title renames in place', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, [
      note('logs/Draft.md', LONG),
      note('Other.md', 'See [[logs/Draft]] and [[Untitled]].\n'),
    ], 'logs/Draft.md', { folders: ['logs'], expanded: ['logs'] });

    const buttonBefore = await page.locator('#notes-button').boundingBox();
    assert.equal(await page.locator('#sync-status').isVisible(), false);
    await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
      view.dispatch({ selection: { anchor: 20, head: 28 } });
      view.scrollDOM.scrollTop = 240;
    });
    const before = await place(page);
    assert.equal(before.anchor, 20);
    assert.equal(before.head, 28);
    assert.ok(before.scroll > 0, 'the long note scrolled');

    await page.locator('#note-title').click();
    await page.waitForSelector('#note-title-input');
    const editing = await page.locator('#note-title-input').evaluate((node) => ({
      value: node.value,
      start: node.selectionStart,
      end: node.selectionEnd,
      active: document.activeElement === node,
      size: parseFloat(getComputedStyle(node).fontSize),
    }));
    assert.equal(editing.value, 'Draft');
    assert.equal(editing.active, true);
    assert.equal(editing.start, 0);
    assert.equal(editing.end, 'Draft'.length);
    assert.ok(editing.size >= 16, `title field is ${editing.size}px`);
    assert.equal(await page.locator('#format-bar').isHidden(), true);
    const buttonDuring = await page.locator('#notes-button').boundingBox();
    const titleBox = await page.locator('#note-title').boundingBox();
    const inputBox = await page.locator('#note-title-input').boundingBox();
    assert.ok(Math.abs(buttonBefore.y - buttonDuring.y) <= 1, 'the header does not jump');
    assert.ok(titleBox.x >= buttonBefore.x + buttonBefore.width - 1);
    assert.ok(inputBox.x >= titleBox.x - 1 && inputBox.x + inputBox.width <= titleBox.x + titleBox.width + 1);
    assert.equal(await page.locator('#sync-status').isVisible(), false);
    await shot(page, 'title-rename-editing.png');

    await page.locator('#note-title-input').fill('Core log');
    await page.locator('#note-title-input').press('Enter');
    await page.waitForFunction(() => (
      document.getElementById('note-title').textContent === 'Core log'
      && !document.getElementById('note-title-input')
    ));
    assert.deepEqual(await place(page), before);
    const moved = await readNote(page, 'logs/Core log.md');
    assert.equal(moved.content, LONG);
    assert.equal(await readNote(page, 'logs/Draft.md'), null);
    assert.match((await readNote(page, 'Other.md')).content, /\[\[logs\/Core log\]\]/);
    await shot(page, 'title-rename-done.png');

    await page.locator('#source .cm-content').click();
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    assert.equal(await page.locator('#note-title').textContent(), 'Core log');

    await page.locator('#notes-button').click();
    await page.locator('#new-note-button').click();
    await page.waitForFunction(() => document.getElementById('note-title').textContent === 'Untitled');
    await page.waitForFunction(() => !document.getElementById('notes-sheet').classList.contains('is-open'));
    await page.locator('#note-title').click();
    await page.locator('#note-title-input').fill('Site');
    await page.locator('#note-title-input').evaluate((node) => node.blur());
    await page.waitForFunction(() => (
      document.getElementById('note-title').textContent === 'Site'
      && !document.getElementById('note-title-input')
    ));
    assert.equal((await readNote(page, 'Site.md')).content, '');
    assert.equal(await readNote(page, 'Untitled.md'), null);
    assert.match((await readNote(page, 'Other.md')).content, /\[\[Site\]\]/);

    await page.locator('#notes-button').click();
    await page.locator('#new-note-button').click();
    await page.waitForFunction(() => document.getElementById('note-title').textContent === 'Untitled');
    await page.locator('#note-title').click();
    await page.locator('#note-title-input').fill('Site');
    await page.locator('#note-title-input').evaluate((node) => node.blur());
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'A note with that name already exists.');
    assert.equal(await page.locator('#note-title-input').inputValue(), 'Site');
    assert.equal(await page.locator('#save-status.is-alert').isVisible(), true);
    assert.equal(await page.locator('#sync-status').isVisible(), false);
    assert.equal((await readNote(page, 'Untitled.md')).content, '');
    await page.locator('#note-title-input').focus();
    await page.locator('#note-title-input').press('Escape');
    await page.waitForFunction(() => (
      document.getElementById('note-title').textContent === 'Untitled'
      && !document.getElementById('note-title-input')
    ));
    assert.equal(await page.locator('#save-status').textContent(), 'Saved on this device');
    assert.deepEqual(errors, []);
  });
});

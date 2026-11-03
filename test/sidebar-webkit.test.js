import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILD, note, openApp, shot, swipe, withPhone } from './helpers/webkit-app.js';

const ROWS = [
  note('Welcome.md', '# Welcome\n\nStart here. Tap the panel button.\n'),
  note('Field/Basalt.md', '# Basalt\n\nquartz vein near the ridge\n'),
  note('Field/Deep/Core 7.md', '# Core 7\n\nclay\n'),
];
const META = { githubRepo: 'joe/zt_vault', folders: ['Field', 'Field/Deep'], expanded: ['Field'] };

function drawerState(page) {
  return page.evaluate(() => {
    const root = document.getElementById('notes-sheet');
    const panel = root.querySelector('.drawer-panel').getBoundingClientRect();
    return {
      open: root.classList.contains('is-open'),
      inert: root.inert,
      expanded: document.getElementById('notes-button').getAttribute('aria-expanded'),
      left: Math.round(panel.left),
      width: Math.round(panel.width),
      editorFocused: Boolean(document.activeElement?.closest?.('.cm-content')),
    };
  });
}

async function settled(page, open) {
  await page.waitForFunction((open) => {
    const root = document.getElementById('notes-sheet');
    const left = root.querySelector('.drawer-panel').getBoundingClientRect().left;
    return root.classList.contains('is-open') === open && (open ? Math.abs(left) < 1 : left < -100);
  }, open);
  await page.waitForTimeout(300);
}

test('webkit sidebar opens from the panel button and closes on the dimmed note or a picked note', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, ROWS, 'Welcome.md', META);
    assert.equal(await page.locator('#sync-status').isVisible(), false, 'no sync flag without a problem');
    const saved = await page.locator('#save-status').boundingBox();
    assert.ok(saved.width <= 1 && saved.height <= 1, 'routine save text is for VoiceOver only');
    assert.equal(await page.locator('#save-status').textContent(), 'Saved on this device');
    assert.equal(await page.locator('#build-version').isVisible(), false, 'the build id lives in Settings');
    await shot(page, 'sidebar-note-screen.png');

    const closed = await drawerState(page);
    assert.equal(closed.open, false);
    assert.equal(closed.inert, true);
    assert.equal(closed.expanded, 'false');

    await page.locator('#notes-button').click();
    await settled(page, true);
    const open = await drawerState(page);
    assert.equal(open.inert, false);
    assert.equal(open.expanded, 'true');
    assert.ok(Math.abs(open.width - 390 * 0.85) <= 2, `panel width ${open.width}`);
    assert.equal(await page.locator('#vault-name').textContent(), 'zt_vault');
    assert.equal(await page.locator('#vault-count').textContent(), '3 files, 2 folders');
    for (const id of ['#notes-button', '#search-case', '#search-options', '#new-note-button', '#new-folder-button', '#settings-button']) {
      const box = await page.locator(id).boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `${id} is ${box.width}x${box.height}`);
    }
    const pill = await page.locator('#search-button').boundingBox();
    assert.ok(pill.height >= 44 && pill.width > 200);
    await shot(page, 'sidebar-open.png');

    await page.locator('#notes-close').click();
    await settled(page, false);
    assert.equal((await drawerState(page)).inert, true);

    await page.locator('#notes-button').click();
    await settled(page, true);
    await page.locator('.note-link', { hasText: 'Basalt' }).first().click();
    await settled(page, false);
    assert.equal(await page.locator('#note-title').textContent(), 'Basalt');
    assert.deepEqual(errors, []);
  });
});

test('webkit edge swipe opens the sidebar and a left swipe closes it, without stealing other touches', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, ROWS, 'Welcome.md', META);
    await page.locator('#source .cm-content').click();
    assert.equal((await drawerState(page)).editorFocused, true);

    await swipe(page, { x: 6, y: 420 }, { x: 70, y: 424 }, { steps: 4, frameMs: 120 });
    await settled(page, false);

    await swipe(page, { x: 6, y: 420 }, { x: 260, y: 426 });
    await settled(page, true);
    assert.equal((await drawerState(page)).editorFocused, false, 'the keyboard goes down');
    await shot(page, 'sidebar-swiped-open.png');

    await swipe(page, { x: 300, y: 500 }, { x: 40, y: 504 }, { selector: '.drawer-panel' });
    await settled(page, false);

    await swipe(page, { x: 160, y: 420 }, { x: 380, y: 420 });
    await page.waitForTimeout(300);
    assert.equal((await drawerState(page)).open, false, 'a swipe that starts mid-note is not the edge swipe');

    await swipe(page, { x: 8, y: 300 }, { x: 30, y: 600 });
    await page.waitForTimeout(300);
    assert.equal((await drawerState(page)).open, false, 'a vertical scroll from the edge stays a scroll');

    await swipe(page, { x: 8, y: 300 }, { x: 260, y: 302 }, { holdMs: 600 });
    await page.waitForTimeout(300);
    assert.equal((await drawerState(page)).open, false, 'a long press then drag is a text selection');

    await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: 9 } });
    });
    await swipe(page, { x: 8, y: 160 }, { x: 260, y: 162 });
    await page.waitForTimeout(300);
    assert.equal((await drawerState(page)).open, false, 'dragging with text selected moves the selection');
    assert.deepEqual(errors, []);
  });
});

test('webkit sidebar search replaces the tree and says No matches found.', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, ROWS, 'Welcome.md', META);
    await page.locator('#notes-button').click();
    await settled(page, true);
    await page.locator('#search-button').click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'notes-search');

    await page.locator('#notes-search').fill('basanite');
    await page.waitForFunction(() => document.getElementById('notes-list').textContent.trim() === 'No matches found.');
    assert.equal(await page.locator('.browser-label').count(), 0, 'the tree is replaced while searching');
    await shot(page, 'sidebar-search-empty.png');

    await page.locator('#notes-search').fill('quartz');
    await page.waitForFunction(() => document.querySelectorAll('#notes-list .note-link').length === 1);
    assert.match(await page.locator('#notes-list').innerText(), /Basalt[\s\S]*quartz vein/);
    await shot(page, 'sidebar-search-hit.png');

    await page.locator('#notes-search').fill('QUARTZ');
    await page.waitForFunction(() => document.querySelectorAll('#notes-list .note-link').length === 1);
    await page.locator('#search-case').click();
    assert.equal(await page.locator('#search-case').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => document.getElementById('notes-list').textContent.trim() === 'No matches found.');
    await page.locator('#search-case').click();

    await page.locator('#search-options').click();
    await page.locator('#search-content').uncheck();
    await page.waitForFunction(() => document.getElementById('notes-list').textContent.trim() === 'No matches found.');
    await page.locator('#notes-search').fill('core');
    await page.waitForFunction(() => document.querySelectorAll('#notes-list .note-link').length === 1);

    await page.locator('#notes-search').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#notes-list .browser-label').length >= 2);
    assert.deepEqual(errors, []);
  });
});

test('webkit gear opens Settings with GitHub, sync, backup and the build id', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, ROWS, 'Welcome.md', META);
    await page.locator('#notes-button').click();
    await settled(page, true);
    await page.locator('#settings-button').click();
    await page.waitForSelector('#settings-sheet:not([hidden])');
    for (const heading of ['Sync', 'GitHub', 'Backup', 'About']) {
      assert.equal(await page.getByRole('heading', { name: heading, exact: true }).isVisible(), true, heading);
    }
    assert.equal(await page.locator('#build-version').textContent(), BUILD);
    assert.equal(await page.locator('#github-connect').isVisible(), true);
    assert.equal(await page.locator('#export-backup').isVisible(), true);
    assert.equal(await page.locator('#import-backup').isVisible(), true);
    await shot(page, 'settings.png');

    await page.locator('#build-version').click();
    assert.equal(await page.locator('#layout-debug').isVisible(), true);
    await page.locator('#build-version').click();

    await page.locator('#settings-close').click();
    await page.waitForSelector('#settings-sheet', { state: 'hidden' });
    assert.equal((await drawerState(page)).open, true, 'Done returns to the sidebar');

    await page.locator('#vault-button').click();
    await page.waitForSelector('#settings-sheet:not([hidden])');
    await page.locator('#settings-close').click();
    assert.deepEqual(errors, []);
  });
});

test('webkit sidebar and Settings follow the dark system setting', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, ROWS, 'Welcome.md', META);
    await page.locator('#notes-button').click();
    await settled(page, true);
    const colors = await page.evaluate(() => ({
      panel: getComputedStyle(document.querySelector('.drawer-panel')).backgroundColor,
      dim: Number(getComputedStyle(document.querySelector('.drawer-dim')).opacity),
    }));
    assert.equal(colors.panel, 'rgb(30, 30, 30)');
    assert.equal(colors.dim, 1);
    await shot(page, 'sidebar-open-dark.png');
    await page.locator('#settings-button').click();
    await page.waitForSelector('#settings-sheet:not([hidden])');
    await shot(page, 'settings-dark.png');
    assert.deepEqual(errors, []);
  }, { colorScheme: 'dark' });
});

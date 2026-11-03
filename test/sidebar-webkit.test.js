import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILD, fakeKeyboard, note, openApp, shot, swipe, withPhone } from './helpers/webkit-app.js';

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
    assert.equal(await page.locator('.row-more').count(), 0, 'no per-row Edit');
    assert.equal(await page.locator('#vault-button').count(), 0, 'the vault name is not a button');
    for (const id of ['#notes-button', '#new-note-button', '#new-folder-button', '#settings-button']) {
      const box = await page.locator(id).boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `${id} is ${box.width}x${box.height}`);
    }
    const pill = await page.locator('#search-bar').boundingBox();
    const tree = await page.locator('#notes-list').boundingBox();
    assert.ok(pill.height >= 44 && pill.width > 200);
    assert.ok(pill.y < tree.y, 'search sits at the top of the panel');
    const title = await page.locator('#note-title').boundingBox();
    assert.ok(title.width > 180, `title width ${title.width}`);
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
    await page.locator('#notes-search').click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'notes-search');
    assert.equal(await page.locator('.drawer-panel').evaluate((node) => node.classList.contains('is-searching')), true);
    assert.equal(await page.locator('.browser-label').count(), 0, 'the tree is replaced while searching');
    await fakeKeyboard(page, 336);
    const searchUp = await page.locator('#search-bar').boundingBox();
    const listUp = await page.locator('#notes-list').boundingBox();
    assert.ok(searchUp.y < listUp.y, 'search stays at the top with the keyboard up');
    assert.ok(searchUp.y < 120, `search y ${searchUp.y} stays in the upper panel`);
    await shot(page, 'sidebar-search-keyboard.png');

    await page.locator('#notes-search').fill('basanite');
    await page.waitForFunction(() => document.getElementById('notes-list').textContent.trim() === 'No matches found.');
    await shot(page, 'sidebar-search-empty.png');

    await page.locator('#notes-search').fill('quartz');
    await page.waitForFunction(() => document.querySelectorAll('#notes-list .note-link').length === 1);
    assert.match(await page.locator('#notes-list').innerText(), /Basalt/);
    assert.equal(await page.locator('.note-path').count(), 0, 'rows are name-only');
    const field = await page.locator('#search-bar').boundingBox();
    const results = await page.locator('#notes-list').boundingBox();
    assert.ok(field.y < results.y, 'the field stays at the top with results');
    await shot(page, 'sidebar-search-results.png');

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

    await page.locator('#search-cancel').click();
    await page.waitForFunction(() => document.querySelectorAll('#notes-list .browser-label').length >= 2);
    assert.equal(await page.locator('.drawer-panel').evaluate((node) => node.classList.contains('is-searching')), false);
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

    await page.waitForFunction(() => !document.getElementById('notes-sheet').classList.contains('is-open'));
    assert.equal(await page.locator('#github-export-backup').count(), 0, 'export lives in Backup only');
    await page.locator('#settings-close').click();
    await page.waitForSelector('#settings-sheet', { state: 'hidden' });
    assert.equal((await drawerState(page)).open, false, 'Done returns to the note');
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

test('webkit long-press on a sidebar row opens rename, move and delete', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await openApp(page, url, ROWS, 'Welcome.md', META);
    await page.locator('#notes-button').click();
    await settled(page, true);
    await page.locator('.browser-row', { hasText: 'Welcome' }).first().dispatchEvent('contextmenu');
    await page.waitForSelector('#action-panel:not([hidden])');
    for (const label of ['Rename', 'Move', 'Delete', 'Cancel']) {
      assert.equal(await page.getByRole('button', { name: label, exact: true }).isVisible(), true, label);
    }
    await shot(page, 'sidebar-row-menu.png');
    assert.deepEqual(errors, []);
  });
});

test('webkit signed-in Settings hides client id behind Advanced', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, context, url, errors }) => {
    await context.route('https://api.github.com/**', async (route) => {
      const href = route.request().url();
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, accept',
      };
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      if (href.endsWith('/user')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: cors,
          body: JSON.stringify({ login: 'joe' }),
        });
        return;
      }
      await route.fulfill({ status: 404, headers: cors, body: '' });
    });
    await openApp(page, url, ROWS, 'Welcome.md', {
      ...META,
      githubToken: 'gho_testtokenvalue123456',
      githubLogin: 'joe',
      githubClientId: 'Iv1.public',
      githubRelay: 'https://relay.example',
    });
    await page.locator('#notes-button').click();
    await settled(page, true);
    await page.locator('#settings-button').click();
    await page.waitForSelector('#settings-sheet:not([hidden])');
    await page.waitForFunction(() => !document.getElementById('notes-sheet').classList.contains('is-open'));
    assert.equal(await page.locator('#github-advanced').evaluate((node) => node.open), false);
    assert.equal(await page.locator('#github-client-id').isVisible(), false);
    assert.equal(await page.locator('#github-relay').isVisible(), false);
    assert.equal(await page.locator('#github-save-config').isVisible(), false);
    assert.equal(await page.locator('#export-backup').isVisible(), true);
    assert.equal(await page.locator('#github-export-backup').count(), 0);
    await shot(page, 'settings-signed-in.png');
    await page.locator('#github-advanced > summary').click();
    assert.equal(await page.locator('#github-client-id').isVisible(), true);
    assert.deepEqual(errors.filter((error) => !error.includes('api.github.com')), []);
  });
});

test('webkit wrapped task lines hang under the text', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    const wrap = '- [ ] A long field note about the ridge quartz that must wrap onto a second line on an iPhone so the hang indent is visible under the words and not the checkbox\n- [x] Another wrapped completed task with enough words about clay strata and basalt cores to wrap as well\n';
    await openApp(page, url, [note('Tasks.md', `# Tasks\n\n${wrap}`)], 'Tasks.md');
    await page.waitForFunction(() => document.querySelectorAll('#source .cm-task-line').length >= 2);
    const hang = await page.evaluate(() => {
      const line = document.querySelector('#source .cm-task-line');
      const style = getComputedStyle(line);
      return {
        hang: style.getPropertyValue('--list-hang').trim(),
        marker: style.getPropertyValue('--list-marker').trim(),
        indent: style.textIndent,
        height: line.getBoundingClientRect().height,
        title: document.getElementById('note-title').getBoundingClientRect().width,
      };
    });
    assert.ok(hang.height > 36, `wrapped height ${hang.height}`);
    assert.equal(hang.hang === '0ch' || hang.hang === '0', true, hang.hang);
    assert.ok(hang.title > 180, `title width ${hang.title}`);
    await shot(page, 'live-wrapped-task.png');
    assert.deepEqual(errors, []);
  });
});

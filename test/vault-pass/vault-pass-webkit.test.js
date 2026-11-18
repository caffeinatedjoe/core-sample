import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createFakeGithub } from '../helpers/fake-github.js';
import { FAKE_CLIENT_ID, FAKE_RELAY } from '../helpers/fake-github.js';
import { FIXTURE_DIR, FIXTURE_REPO } from '../helpers/fixture-vault.js';
import {
  BUILD,
  fakeKeyboard,
  shot,
  waitForStart,
  withPhone,
} from '../helpers/webkit-app.js';
import { vaultPassName } from '../helpers/vault-pass.js';

const FIXTURE_PNG = join(FIXTURE_DIR, 'assets/Site Log/image-20261029123530322.png');

async function emulateStandalone(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
    const orig = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (String(query).includes('display-mode: standalone')) {
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() { return false; },
        };
      }
      return orig(query);
    };
  });
}

async function settled(page, open) {
  await page.waitForFunction((open) => {
    const root = document.getElementById('notes-sheet');
    const left = root.querySelector('.drawer-panel').getBoundingClientRect().left;
    return root.classList.contains('is-open') === open && (open ? Math.abs(left) < 1 : left < -100);
  }, open);
}

async function withVaultPhone(t, github, run) {
  await withPhone(t, async (ctx) => {
    await emulateStandalone(ctx.page);
    await github.installRoutes(ctx.context);
    try {
      await run(ctx);
    } catch (error) {
      await shot(ctx.page, `vault-pass-fail-${Date.now()}.png`).catch(() => {});
      throw error;
    }
  });
}

// Boots the app already signed in to the fake GitHub so the first sync
// downloads the fixture. Used by the tap-throughs that skip the sign-in UI.
async function bootSignedIn(page, github) {
  await page.evaluate(async ({ token, repo }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('core-sample');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      const meta = tx.objectStore('meta');
      meta.put({ key: 'githubToken', value: token });
      meta.put({ key: 'githubRepo', value: repo });
      meta.put({ key: 'githubBranch', value: 'main' });
      meta.put({ key: 'githubRoot', value: '' });
      meta.put({ key: 'githubLogin', value: 'octocat' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { token: github.token, repo: github.repo });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((build) => document.getElementById('build-version')?.textContent === build, BUILD);
  await page.waitForFunction(() => document.querySelector('#source .cm-content')?.getAttribute('contenteditable') === 'true');
}

async function openFixtureNote(page, name) {
  await page.locator('#notes-button').click();
  await settled(page, true);
  await page.waitForFunction((name) => [...document.querySelectorAll('.note-name')].some((node) => node.textContent === name), name);
  await page.locator('.note-link .note-name').filter({ hasText: new RegExp(`^${name}$`) }).click();
  await settled(page, false);
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  await page.waitForFunction((name) => document.getElementById('note-title')?.textContent === name, name);
}

// Backgrounds the app, which pushes dirty notes, then polls the fake repo.
async function syncUntil(page, github, check, label) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (check()) return;
    await page.waitForTimeout(250);
  }
  const remote = [...github.git.snapshot().keys()].join(', ');
  assert.fail(`${label} never reached the fake GitHub; remote ${remote}`);
}

test(vaultPassName('WebKit iPhone standalone signs in, edits, adds an image, and syncs'), { timeout: 90000 }, async (t) => {
  const github = await createFakeGithub({ signedIn: false });
  const pngPath = FIXTURE_PNG;
  await withVaultPhone(t, github, async ({ page, url, errors }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForStart(page);
    const standalone = await page.evaluate(() => (
      navigator.standalone === true
      && window.matchMedia('(display-mode: standalone)').matches
    ));
    assert.equal(standalone, true);

    await page.locator('#notes-button').click();
    await settled(page, true);
    await page.locator('#settings-button').click();
    await page.waitForSelector('#settings-sheet:not([hidden])');
    await page.locator('#github-client-id').fill(FAKE_CLIENT_ID);
    await page.locator('#github-relay').fill(FAKE_RELAY);
    await page.locator('#github-connect').scrollIntoViewIfNeeded();
    await page.locator('#github-connect').click();
    await page.waitForFunction(() => document.getElementById('github-user-code')?.textContent?.includes('-'));
    assert.equal(await page.locator('#github-user-code').textContent(), github.device.userCode);
    github.approve();
    await page.locator('#github-check-now').click();
    await page.waitForSelector('#github-target:not([hidden])');
    await page.locator('#github-repo').fill(FIXTURE_REPO);
    await page.locator('#github-branch').fill('main');
    await page.locator('#github-save-repo').click();
    await page.waitForFunction(() => (document.getElementById('github-status')?.textContent || '').includes('Saved'));
    await page.locator('#github-download').click();
    await page.waitForSelector('#github-choice:not([hidden])');
    await page.locator('#github-alongside').click();
    await page.waitForFunction(() => (document.getElementById('github-status')?.textContent || '').includes('Downloaded'));
    await page.locator('#settings-close').click();

    await page.locator('#notes-button').click();
    await settled(page, true);
    await page.locator('.note-link .note-name').filter({ hasText: /^Site Log$/ }).click();
    await settled(page, false);
    await page.waitForFunction(() => document.getElementById('note-title')?.textContent === 'Site Log');

    await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
      const text = view.state.doc.toString();
      const at = text.indexOf('sample');
      view.focus();
      view.dispatch({ selection: { anchor: at, head: at + 'sample'.length } });
    });
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    await page.locator('[data-format="bold"]').click();
    await page.waitForFunction(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
      return view.state.doc.toString().includes('**sample**');
    });
    await page.evaluate(async () => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
      const end = view.state.doc.length;
      view.dispatch({ selection: { anchor: end } });
    });
    await page.locator('#image-file').setInputFiles(pngPath);

    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll('#source img.embed-image')];
      return imgs.some((img) => img.complete && img.naturalWidth > 0);
    }, null, { timeout: 20000 });

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const started = Date.now();
    let synced = false;
    while (Date.now() - started < 15000) {
      const site = github.git.textAt('Site Log.md');
      const images = [...github.git.entriesAt()].filter(([path]) => (
        path.startsWith('assets/Site Log/image-') && path.endsWith('.png') && path !== 'assets/Site Log/image-20261029123530322.png'
      ));
      if (site.includes('**sample**') && images.length) {
        synced = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    if (!synced) {
      const status = await page.locator('#settings-sync-status').textContent();
      const detail = await page.locator('#settings-sync-detail').textContent();
      const remote = [...github.git.snapshot().entries()].map(([path]) => path).join(', ');
      assert.equal(synced, true, `sync status ${status} ${detail}; remote ${remote}`);
    }
    assert.match(github.git.textAt('Site Log.md'), /\*\*sample\*\*/);
    assert.match(github.git.textAt('Site Log.md'), /!\[\[image-\d{17}\.png\]\]/);

    await page.locator('#notes-button').click();
    await settled(page, true);
    await page.locator('#settings-button').click();
    await page.waitForFunction(() => document.getElementById('settings-sync-status')?.textContent === 'Synced', null, { timeout: 10000 });
    await shot(page, 'vault-pass-webkit-synced.png');
    const leaked = errors.filter((error) => /gho_|fake-oauth-value-|device-code/.test(error));
    assert.deepEqual(leaked, []);
  });
});

test(vaultPassName('WebKit TASK rollup and sidebar assets from the fixture'), { timeout: 90000 }, async (t) => {
  const github = await createFakeGithub();
  await withVaultPhone(t, github, async ({ page, url }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForStart(page);
    await bootSignedIn(page, github);

    await page.locator('#notes-button').click();
    await settled(page, true);
    await page.waitForFunction(() => [...document.querySelectorAll('.note-name')].some((node) => node.textContent === 'Board'));
    await page.locator('.note-link .note-name').filter({ hasText: /^Board$/ }).click();
    await settled(page, false);
    await page.waitForSelector('#source .cm-dataview');
    const tasks = await page.locator('#source .dv-text').allTextContents();
    assert.deepEqual(tasks, ['Label the trays #todo']);
    await shot(page, 'vault-pass-webkit-dataview.png');

    await page.locator('#notes-button').click();
    await settled(page, true);
    const assetsRow = page.locator('.note-link').filter({ hasText: /assets/ }).first();
    if (await assetsRow.count()) {
      const label = await assetsRow.textContent();
      if (label.includes('▸')) await assetsRow.click();
    }
    const nested = page.locator('.note-link').filter({ hasText: /▸ Site Log|▾ Site Log/ });
    if (await nested.count()) {
      const label = await nested.first().textContent();
      if (label.includes('▸')) await nested.first().click();
    }
    await page.waitForFunction(() => [...document.querySelectorAll('.note-name')].some((node) => (
      node.textContent.endsWith('.png') || node.textContent.endsWith('.pdf')
    )));
    const names = await page.locator('.note-name').allTextContents();
    assert.equal(names.some((name) => name.endsWith('.png')), true);
    assert.equal(names.some((name) => name.endsWith('.pdf')), true);
  });
});

test(vaultPassName('WebKit new Untitled note renamed from its title syncs under the new path'), { timeout: 90000 }, async (t) => {
  const github = await createFakeGithub();
  await withVaultPhone(t, github, async ({ page, url, errors }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForStart(page);
    await bootSignedIn(page, github);
    await page.locator('#notes-button').click();
    await settled(page, true);
    await page.waitForFunction(() => [...document.querySelectorAll('.note-name')].some((node) => node.textContent === 'Daily'));

    await page.locator('#new-note-button').click();
    await page.waitForFunction(() => document.getElementById('note-title')?.textContent === 'Untitled');
    await settled(page, false);
    await page.locator('#note-title').click();
    await page.waitForSelector('#note-title-input');
    await page.locator('#note-title-input').fill('Field Notes');
    await page.locator('#note-title-input').press('Enter');
    await page.waitForFunction(() => (
      document.getElementById('note-title')?.textContent === 'Field Notes'
      && !document.getElementById('note-title-input')
    ));

    await syncUntil(page, github, () => github.git.entriesAt().has('Field Notes.md'), 'Field Notes.md');
    assert.equal(github.git.textAt('Field Notes.md'), '');
    assert.equal(github.git.entriesAt().has('Untitled.md'), false);
    await shot(page, 'vault-pass-webkit-untitled-rename.png');
    assert.deepEqual(errors, []);
  });
});

test(vaultPassName('WebKit comment and reply on a fixture note sync into the note'), { timeout: 90000 }, async (t) => {
  const github = await createFakeGithub();
  await withVaultPhone(t, github, async ({ page, url, errors }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForStart(page);
    await bootSignedIn(page, github);
    await openFixtureNote(page, 'Daily');

    const anchor = 'Sample vault daily note';
    await page.evaluate(async (anchor) => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
      const at = view.state.doc.toString().indexOf(anchor);
      view.focus();
      view.dispatch({ selection: { anchor: at, head: at + anchor.length } });
    }, anchor);
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    await page.waitForFunction(() => !document.querySelector('[data-format="comment"]').disabled);
    await page.locator('[data-format="comment"]').click();
    await page.waitForFunction(() => !document.getElementById('comment-sheet')?.hidden);
    await page.locator('#comment-reply').fill('Check the tray label.');
    await page.locator('#comment-send').click();
    await page.waitForFunction(() => document.getElementById('comments-chip')?.textContent === '💬 1');
    await page.waitForFunction(() => document.getElementById('comment-sheet-thread')?.textContent.includes('Check the tray label.'));
    await page.locator('#comment-reply').fill('Done, relabeled.');
    await page.locator('#comment-send').click();
    await page.waitForFunction(() => document.getElementById('comment-sheet-thread')?.textContent.includes('Done, relabeled.'));
    await shot(page, 'vault-pass-webkit-comment.png');

    // Comments live inside the note in the Document Comments format, so the
    // synced Markdown carries the anchor, the thread, and both entries.
    await syncUntil(page, github, () => github.git.textAt('Daily.md').includes('Done, relabeled.'), 'the reply');
    const remote = github.git.textAt('Daily.md');
    const id = remote.match(/<!--c:([A-Za-z0-9]+)-->/)?.[1];
    assert.ok(id, `no comment anchor in ${remote}`);
    assert.ok(remote.includes(`<!--c:${id}-->${anchor}<!--/c:${id}-->`), remote);
    assert.match(remote, new RegExp(`<!--co:${id}[\\s\\S]*Check the tray label\\.[\\s\\S]*Done, relabeled\\.[\\s\\S]*-->`));
    assert.match(remote, /^# Daily$/m);
    assert.deepEqual(errors, []);
  });
});

test(vaultPassName('WebKit Live Preview renders the fixture table and callout'), { timeout: 90000 }, async (t) => {
  const github = await createFakeGithub();
  await withVaultPhone(t, github, async ({ page, url, errors }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForStart(page);
    await bootSignedIn(page, github);
    await openFixtureNote(page, 'Core Table');
    await page.evaluate(() => document.querySelector('#source .cm-content')?.blur());
    await page.waitForSelector('#source .cm-table-widget');
    await page.waitForSelector('#source .cm-callout');
    const headers = await page.locator('#source .cm-table-widget th').allInnerTexts();
    assert.deepEqual(headers.map((text) => text.trim()), ['Depth', 'Layer']);
    const cells = await page.locator('#source .cm-table-widget td').allInnerTexts();
    assert.deepEqual(cells.map((text) => text.trim()), ['0 m', 'topsoil', '2 m', 'clay']);
    assert.equal((await page.locator('#source .cm-callout .callout-title').innerText()).trim(), 'Field check');
    assert.match(await page.locator('#source .cm-callout').innerText(), /Made-up sample text/);
    await shot(page, 'vault-pass-webkit-table-callout.png');
    assert.deepEqual(errors, []);
  });
});

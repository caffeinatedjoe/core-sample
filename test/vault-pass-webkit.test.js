import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createFakeGithub } from './helpers/fake-github.js';
import { FAKE_CLIENT_ID, FAKE_RELAY } from './helpers/fake-github.js';
import { FIXTURE_DIR, FIXTURE_REPO } from './helpers/fixture-vault.js';
import {
  BUILD,
  fakeKeyboard,
  shot,
  waitForStart,
  withPhone,
} from './helpers/webkit-app.js';
import { vaultPassName } from './helpers/vault-pass.js';

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

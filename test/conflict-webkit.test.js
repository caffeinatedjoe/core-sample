import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeUtf8Base64 } from '../app/js/github-api.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const appDir = join(here, '..', 'app');
const shots = '/opt/cursor/artifacts/conflict-ui';
const NOTE = 'Field Notes.md';

function serve() {
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const path = join(appDir, relative === '/' ? 'index.html' : relative);
    if (!path.startsWith(appDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, if-none-match, accept',
  'access-control-expose-headers': 'etag, retry-after, x-ratelimit-remaining, x-ratelimit-reset',
};

test('webkit conflict screen chooses blocks, previews, undoes, and resolves offline', { timeout: 90000 }, async (t) => {
  let webkit;
  let devices;
  try {
    ({ webkit, devices } = await import('playwright'));
  } catch {
    t.skip('playwright is not installed');
    return;
  }
  await mkdir(shots, { recursive: true });
  const server = await serve();
  const { port } = server.address();
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block',
    colorScheme: 'light',
    timezoneId: 'America/Los_Angeles',
  });
  const state = {
    head: 'commit-1',
    tree: 'tree-1',
    files: new Map([[NOTE, { sha: 'blob-remote', text: 'github\nkeep\n' }]]),
    blobs: new Map([['blob-base', 'old\nkeep\n'], ['blob-remote', 'github\nkeep\n']]),
  };
  let patches = 0;
  await context.route(/api\.github\.com/, async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    if (url.includes('gho_')) throw new Error('token leaked into the url');
    if (method === 'OPTIONS') {
      const requested = request.headers()['access-control-request-headers'];
      await route.fulfill({
        status: 204,
        headers: {
          ...CORS,
          'access-control-allow-headers': requested || CORS['access-control-allow-headers'],
        },
      });
      return;
    }
    const path = new URL(url).pathname;
    const json = (status, body) => route.fulfill({
      status,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify(body),
    });
    if (url.endsWith('/user') && method === 'GET') return json(200, { login: 'octocat' });
    if (path === '/repos/owner/repo/git/ref/heads/main' && method === 'GET') {
      return json(200, { ref: 'refs/heads/main', object: { sha: state.head, type: 'commit' } });
    }
    if (/^\/repos\/owner\/repo\/git\/commits\/[^/]+$/.test(path) && method === 'GET') {
      return json(200, {
        sha: state.head,
        tree: { sha: state.tree },
        committer: { date: '2026-10-21T19:05:00.000Z' },
      });
    }
    if (/^\/repos\/owner\/repo\/git\/trees\/[^/]+$/.test(path) && method === 'GET') {
      return json(200, {
        sha: state.tree,
        tree: [...state.files].map(([notePath, file]) => ({ path: notePath, mode: '100644', type: 'blob', sha: file.sha })),
      });
    }
    if (/^\/repos\/owner\/repo\/git\/blobs\/[^/]+$/.test(path) && method === 'GET') {
      const sha = decodeURIComponent(path.split('/').pop());
      const text = state.blobs.get(sha);
      if (text == null) return json(404, { message: 'Not Found' });
      return json(200, { sha, encoding: 'base64', content: encodeUtf8Base64(text) });
    }
    if (path === '/repos/owner/repo/git/refs/heads/main' && method === 'PATCH') {
      patches += 1;
      const body = request.postDataJSON();
      if (body.force !== false) throw new Error('ref update must not force');
      return json(200, { ref: 'refs/heads/main', object: { sha: body.sha } });
    }
    if (method === 'POST' && path === '/repos/owner/repo/git/blobs') return json(201, { sha: 'blob-new' });
    if (method === 'POST' && path === '/repos/owner/repo/git/trees') return json(201, { sha: 'tree-new' });
    if (method === 'POST' && path === '/repos/owner/repo/git/commits') return json(201, { sha: 'commit-new' });
    return json(404, { message: 'Not Found' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => {
    const text = String(error && error.stack ? error.stack : error);
    // WebKit reports an intercepted fetch as an access-control exception even
    // when the route fulfilled it and the promise was caught.
    if (text.includes('due to access control checks')) return;
    errors.push(text);
  });
  const shot = (name) => page.screenshot({ path: join(shots, name) });
  async function assertChoicesHittable() {
    const count = await page.locator('.hunk-choice').count();
    assert.equal(count >= 3, true);
    for (let i = 0; i < count; i += 1) {
      const choice = page.locator('.hunk-choice').nth(i);
      await choice.scrollIntoViewIfNeeded();
      const hit = await choice.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return target === node ? true : `${target?.id || ''}.${target?.className || ''} at ${Math.round(rect.top)}`;
      });
      assert.equal(hit, true, String(hit));
    }
  }
  try {
    await page.clock.install({ time: new Date('2026-10-21T22:30:00Z') });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('build-version')?.textContent === 'core-sample-shell-v26');
    await page.evaluate(async ({ note }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('core-sample');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['files', 'meta'], 'readwrite');
        const files = tx.objectStore('files');
        files.delete('Welcome.md');
        files.put({
          path: note,
          content: 'phone\nkeep\n',
          kind: 'markdown',
          encoding: 'utf-8',
          createdAt: 1,
          updatedAt: Date.parse('2026-10-21T19:10:00Z'),
          trashedAt: null,
          remoteSha: 'blob-base',
          baseSha: 'blob-base',
          dirty: true,
          conflict: true,
          conflictAt: Date.parse('2026-10-21T19:18:00Z'),
          conflictRemoteAt: Date.parse('2026-10-21T19:05:00Z'),
          conflictReason: 'both',
          conflictRemote: 'github\nkeep\n',
          conflictRemoteSha: 'blob-remote',
          conflictBase: 'old\nkeep\n',
        });
        const meta = tx.objectStore('meta');
        meta.put({ key: 'seeded', value: true });
        meta.put({ key: 'lastOpened', value: note });
        meta.put({ key: 'editorMode', value: 'source' });
        meta.put({ key: 'githubToken', value: 'gho_testtokenvalue123456' });
        meta.put({ key: 'githubRepo', value: 'owner/repo' });
        meta.put({ key: 'githubBranch', value: 'main' });
        meta.put({ key: 'githubRoot', value: '' });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, { note: NOTE });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Conflict');
    await page.locator('#sync-status').click();
    await page.waitForSelector('#conflict-list .conflict-open');
    await shot('conflict-list.png');
    const why = await page.locator('.conflict-why').first().textContent();
    assert.equal(why, 'Edited on this phone and on GitHub');
    await page.locator('.conflict-open').click();
    await page.waitForSelector('#conflict-resolve-button');
    assert.equal(await page.locator('#conflict-resolve-button').isDisabled(), true);
    const opened = await page.locator('#conflict-resolve-view').innerText();
    assert.equal(opened.includes('Today 12:10 PM'), true);
    assert.equal(opened.includes('Today 12:05 PM'), true);
    assert.equal(opened.includes('Today 12:18 PM'), false);
    await assertChoicesHittable();
    await shot('resolve-light.png');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot('resolve-dark.png');
    await page.emulateMedia({ colorScheme: 'light' });

    await page.locator('.hunk-choice[data-choice="phone"]').click();
    assert.equal(await page.locator('#conflict-resolve-button').isDisabled(), false);
    await page.locator('.hunk-choice[data-choice="both"]').click();
    assert.equal(await page.locator('#conflict-resolve-button').isDisabled(), true);
    await page.locator('.order-choice[data-order="github-first"]').click();
    assert.equal(await page.locator('#conflict-resolve-button').isDisabled(), false);
    const ordered = await page.locator('#merge-preview').textContent();
    assert.equal(ordered.includes('github'), true);
    assert.equal(ordered.indexOf('github') < ordered.indexOf('phone'), true);
    await page.locator('#merge-editor').fill('handwritten\nkeep\n');
    await page.waitForFunction(() => document.getElementById('merge-preview')?.textContent === 'handwritten\nkeep\n');
    await shot('merge-preview.png');
    const before = patches;
    await page.locator('#conflict-resolve-button').click();
    await page.waitForSelector('#undo-toast:not([hidden])');
    await shot('undo-toast.png');
    await page.locator('#undo-toast-action').click();
    await page.waitForFunction(() => document.getElementById('source')?.value === 'phone\nkeep\n');
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Conflict');
    assert.equal(patches, before);

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '28px';
    });
    await page.locator('.conflict-open').click();
    await assertChoicesHittable();
    const target = await page.locator('.hunk-choice').first().evaluate((node) => node.getBoundingClientRect().height);
    const resolveHeight = await page.locator('#conflict-resolve-button').evaluate((node) => node.getBoundingClientRect().height);
    assert.equal(target >= 44, true);
    assert.equal(resolveHeight >= 44, true);
    const resolveInView = await page.locator('#conflict-resolve-button').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
    assert.equal(resolveInView, true);
    for (const id of ['#conflict-prev', '#conflict-next']) {
      const size = await page.locator(id).evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return Math.min(rect.width, rect.height);
      });
      assert.equal(size >= 44, true);
    }
    await page.locator('.hunk-choice[data-choice="phone"]').click();
    assert.equal(await page.locator('#conflict-resolve-button').isDisabled(), false);

    await context.setOffline(true);
    await page.locator('#conflict-resolve-button').click();
    await page.waitForFunction(() => {
      const status = document.getElementById('sync-status')?.textContent || '';
      return status === 'Offline' || status === 'Changes pending';
    });
    const saved = await page.evaluate(async (note) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('core-sample');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const file = await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readonly');
        const request = tx.objectStore('files').get(note);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const ops = await new Promise((resolve, reject) => {
        const tx = db.transaction('ops', 'readonly');
        const request = tx.objectStore('ops').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return { content: file.content, conflict: file.conflict === true, dirty: file.dirty === true, ops: ops.length };
    }, NOTE);
    assert.equal(saved.conflict, false);
    assert.equal(saved.dirty, true);
    assert.equal(saved.content, 'phone\nkeep\n');
    assert.equal(saved.ops >= 1, true);
    assert.equal(patches, before);
    assert.equal(state.files.get(NOTE).text, 'github\nkeep\n');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeUtf8Base64 } from '../app/js/github-api.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const appDir = join(here, '..', 'app');
const NOTE = 'Field Notes.md';

function serve() {
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
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
      res.writeHead(200, {
        'content-type': types[extname(path)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
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

function json(route, status, body, headers = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { ...CORS, ...headers },
    body: status === 304 ? '' : JSON.stringify(body),
  });
}

test('webkit auto-sync pushes, pulls, queues offline, keeps a failed push, and keeps both sides of a conflict', { timeout: 90000 }, async (t) => {
  let webkit;
  let devices;
  try {
    ({ webkit, devices } = await import('playwright'));
  } catch {
    t.skip('playwright is not installed');
    return;
  }
  const server = await serve();
  const { port } = server.address();
  const browser = await webkit.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const state = {
    head: 'commit-1',
    tree: 'tree-1',
    failPatch: false,
    files: new Map([[NOTE, { sha: 'blob-1', text: 'Local line\n' }]]),
    blobs: new Map([['blob-1', 'Local line\n']]),
    pendingTree: null,
  };
  const urls = [];
  let commits = 0;
  let patches = 0;
  await context.route(/api\.github\.com/, async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    urls.push(`${method} ${url}`);
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
    if (url.endsWith('/user')) {
      await json(route, 200, { login: 'octocat' });
      return;
    }
    const path = new URL(url).pathname;
    if (path === '/repos/owner/repo/git/ref/heads/main' && method === 'GET') {
      const etag = `"${state.head}"`;
      await json(route, 200, { ref: 'refs/heads/main', object: { sha: state.head, type: 'commit' } }, { etag });
      return;
    }
    if (/^\/repos\/owner\/repo\/git\/commits\/[^/]+$/.test(path) && method === 'GET') {
      await json(route, 200, { sha: state.head, tree: { sha: state.tree } });
      return;
    }
    if (/^\/repos\/owner\/repo\/git\/trees\/[^/]+$/.test(path) && method === 'GET') {
      await json(route, 200, {
        sha: state.tree,
        truncated: false,
        tree: [...state.files].map(([path, file]) => ({ path, mode: '100644', type: 'blob', sha: file.sha })),
      });
      return;
    }
    if (/^\/repos\/owner\/repo\/git\/blobs\/[^/]+$/.test(path) && method === 'GET') {
      const sha = decodeURIComponent(path.split('/').pop());
      const text = state.blobs.get(sha);
      if (text == null) {
        await json(route, 404, { message: 'Not Found' });
        return;
      }
      await json(route, 200, { sha, encoding: 'base64', content: encodeUtf8Base64(text) });
      return;
    }
    if (path === '/repos/owner/repo/git/blobs' && method === 'POST') {
      const body = request.postDataJSON();
      const sha = `blob-new-${state.blobs.size + 1}`;
      state.blobs.set(sha, body.content);
      await json(route, 201, { sha });
      return;
    }
    if (path === '/repos/owner/repo/git/trees' && method === 'POST') {
      const body = request.postDataJSON();
      const tree = `tree-${state.blobs.size}`;
      state.pendingTree = {
        sha: tree,
        files: new Map(body.tree.map((entry) => [entry.path, { sha: entry.sha, text: state.blobs.get(entry.sha) || '' }])),
      };
      await json(route, 201, { sha: tree });
      return;
    }
    if (path === '/repos/owner/repo/git/commits' && method === 'POST') {
      const body = request.postDataJSON();
      if (body.force === true) throw new Error('force commit');
      state.commit = `commit-${commits + 2}`;
      await json(route, 201, { sha: state.commit });
      return;
    }
    if (path === '/repos/owner/repo/git/refs/heads/main' && method === 'PATCH') {
      patches += 1;
      const body = request.postDataJSON();
      if (body.force !== false) throw new Error('ref update must not force');
      if (state.failPatch) {
        await json(route, 500, { message: 'unavailable' });
        return;
      }
      state.head = body.sha;
      if (state.pendingTree) {
        state.tree = state.pendingTree.sha;
        state.files = state.pendingTree.files;
        state.pendingTree = null;
      }
      commits += 1;
      await json(route, 200, { ref: 'refs/heads/main', object: { sha: body.sha } });
      return;
    }
    await json(route, 404, { message: 'Not Found' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const status = document.getElementById('save-status')?.textContent || '';
      return status.includes('Saved') && document.getElementById('build-version')?.textContent === 'core-sample-shell-v24';
    });
    await page.evaluate(async ({ note }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('core-sample');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['files', 'meta'], 'readwrite');
        tx.objectStore('files').put({
          path: note,
          content: 'Local line\n',
          kind: 'markdown',
          encoding: 'utf-8',
          createdAt: 1,
          updatedAt: 2,
          remoteSha: 'blob-1',
          baseSha: 'blob-1',
          dirty: false,
        });
        const meta = tx.objectStore('meta');
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
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced');

    async function savedLocally() {
      await page.clock.fastForward(1000);
      await page.waitForFunction(() => {
        const status = document.getElementById('sync-status')?.textContent || '';
        return status === 'Changes pending' || status === 'Syncing';
      });
      await page.clock.fastForward(5000);
    }

    await page.locator('#source').fill('Local line\nfrom the phone\n');
    await savedLocally();
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced');
    assert.equal(commits, 1);
    assert.equal(state.files.get(NOTE).text, 'Local line\nfrom the phone\n');

    state.head = 'commit-remote';
    state.tree = 'tree-remote';
    state.files.set(NOTE, { sha: 'blob-remote', text: 'From GitHub\n' });
    state.blobs.set('blob-remote', 'From GitHub\n');
    await page.clock.fastForward(60_000);
    await page.waitForFunction(() => document.getElementById('source')?.value === 'From GitHub\n');
    assert.equal(commits, 1);

    await context.setOffline(true);
    await page.locator('#source').fill('From GitHub\nqueued\n');
    await savedLocally();
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Offline');
    assert.equal(commits, 1);
    assert.equal(state.files.get(NOTE).text, 'From GitHub\n');

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced');
    assert.equal(commits, 2);
    assert.equal(state.files.get(NOTE).text, 'From GitHub\nqueued\n');

    state.failPatch = true;
    const patchesBefore = patches;
    await page.locator('#source').fill('kept on the phone\n');
    await savedLocally();
    const patchStarted = Date.now();
    while (patches === patchesBefore && Date.now() - patchStarted < 15000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(patches > patchesBefore, true);
    await page.waitForFunction(() => {
      const status = document.getElementById('sync-status')?.textContent || '';
      return status === 'Changes pending' || status === 'Sync failed';
    });
    const kept = await page.evaluate(async (note) => {
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
      return { content: file.content, dirty: file.dirty, ops: ops.length };
    }, NOTE);
    assert.equal(kept.content, 'kept on the phone\n');
    assert.equal(kept.dirty, true);
    assert.equal(kept.ops >= 1, true);
    assert.equal(commits, 2);
    assert.notEqual(state.files.get(NOTE).text, 'kept on the phone\n');

    state.failPatch = false;
    state.head = 'commit-diverged';
    state.tree = 'tree-diverged';
    state.files.set(NOTE, { sha: 'blob-theirs', text: 'Theirs\n' });
    state.blobs.set('blob-theirs', 'Theirs\n');
    await page.clock.fastForward(60_000);
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Conflict');
    const both = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('core-sample');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readonly');
        const request = tx.objectStore('files').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return rows.map((row) => ({
        path: row.path,
        content: row.content,
        conflict: row.conflict === true,
        copy: row.conflictCopy === true,
      }));
    });
    const local = both.find((row) => row.path === NOTE);
    const sibling = both.find((row) => row.copy);
    assert.equal(local.content, 'kept on the phone\n');
    assert.equal(local.conflict, true);
    assert.ok(sibling);
    assert.equal(sibling.content, 'Theirs\n');
    assert.equal(commits, 2);
    assert.equal(urls.some((url) => url.includes('gho_')), false);
    assert.equal(urls.some((line) => line.startsWith('PATCH ') && line.includes('/git/refs/heads/main')), true);
    assert.equal(urls.some((line) => line.startsWith('PATCH ') && line.includes('/git/ref/heads/')), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

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
const COPY = 'Field Notes (conflict 2026-10-20 1718).md';
const TOKEN = 'gho_testtokenvalue123456';

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

function gitState(files) {
  const blobs = new Map();
  const tree = new Map();
  for (const [path, file] of files) {
    tree.set(path, file);
    blobs.set(file.sha, file.text);
  }
  return {
    head: 'commit-1',
    tree: 'tree-1',
    files: tree,
    blobs,
    pendingTree: null,
    writes: [],
    blobGets: [],
    commits: 0,
    patches: 0,
  };
}

async function mockGithub(context, state) {
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
    if (method === 'POST' || method === 'PATCH') state.writes.push(`${method} ${path}`);
    if (url.endsWith('/user')) return json(route, 200, { login: 'octocat' });
    if (path === '/repos/owner/repo/git/ref/heads/main' && method === 'GET') {
      return json(route, 200, { ref: 'refs/heads/main', object: { sha: state.head, type: 'commit' } }, { etag: `"${state.head}"` });
    }
    if (/^\/repos\/owner\/repo\/git\/commits\/[^/]+$/.test(path) && method === 'GET') {
      return json(route, 200, {
        sha: state.head,
        tree: { sha: state.tree },
        committer: { date: '2026-10-21T12:00:00.000Z' },
      });
    }
    if (/^\/repos\/owner\/repo\/git\/trees\/[^/]+$/.test(path) && method === 'GET') {
      return json(route, 200, {
        sha: state.tree,
        truncated: false,
        tree: [...state.files].map(([notePath, file]) => ({ path: notePath, mode: '100644', type: 'blob', sha: file.sha })),
      });
    }
    if (/^\/repos\/owner\/repo\/git\/blobs\/[^/]+$/.test(path) && method === 'GET') {
      const sha = decodeURIComponent(path.split('/').pop());
      state.blobGets.push(sha);
      const text = state.blobs.get(sha);
      if (text == null) return json(route, 404, { message: 'Not Found' });
      return json(route, 200, { sha, encoding: 'base64', content: encodeUtf8Base64(text) });
    }
    if (path === '/repos/owner/repo/git/blobs' && method === 'POST') {
      const body = request.postDataJSON();
      const sha = `blob-new-${state.blobs.size + 1}`;
      state.blobs.set(sha, body.content);
      return json(route, 201, { sha });
    }
    if (path === '/repos/owner/repo/git/trees' && method === 'POST') {
      const body = request.postDataJSON();
      const tree = `tree-${state.blobs.size}`;
      const files = new Map(state.files);
      for (const entry of body.tree) {
        if (entry.sha == null) files.delete(entry.path);
        else files.set(entry.path, { sha: entry.sha, text: state.blobs.get(entry.sha) || '' });
      }
      state.pendingTree = { sha: tree, files, body };
      return json(route, 201, { sha: tree });
    }
    if (path === '/repos/owner/repo/git/commits' && method === 'POST') {
      state.commit = `commit-${state.commits + 2}`;
      return json(route, 201, { sha: state.commit, committer: { date: '2026-10-21T12:05:00.000Z' } });
    }
    if (path === '/repos/owner/repo/git/refs/heads/main' && method === 'PATCH') {
      const body = request.postDataJSON();
      if (body.force !== false) throw new Error('ref update must not force');
      state.head = body.sha;
      state.patches += 1;
      state.commits += 1;
      if (state.pendingTree) {
        state.tree = state.pendingTree.sha;
        state.files = state.pendingTree.files;
        state.lastTree = state.pendingTree.body;
        state.pendingTree = null;
      }
      return json(route, 200, { ref: 'refs/heads/main', object: { sha: body.sha } });
    }
    return json(route, 404, { message: 'Not Found' });
  });
}

async function seed(page, rows, lastOpened) {
  await page.evaluate(async ({ rows, lastOpened, token }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('core-sample');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['files', 'meta'], 'readwrite');
      const files = tx.objectStore('files');
      files.clear();
      for (const row of rows) files.put(row);
      const meta = tx.objectStore('meta');
      meta.put({ key: 'seeded', value: true });
      meta.put({ key: 'lastOpened', value: lastOpened });
      meta.put({ key: 'editorMode', value: 'source' });
      meta.put({ key: 'githubToken', value: token });
      meta.put({ key: 'githubRepo', value: 'owner/repo' });
      meta.put({ key: 'githubBranch', value: 'main' });
      meta.put({ key: 'githubRoot', value: '' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { rows, lastOpened, token: TOKEN });
}

async function readFiles(page) {
  return page.evaluate(async () => {
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
    return rows;
  });
}

function markdown(path, content, extra = {}) {
  return {
    path,
    content,
    kind: 'markdown',
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 2,
    trashedAt: null,
    remoteSha: null,
    baseSha: null,
    dirty: false,
    conflict: false,
    ...extra,
  };
}

async function withBrowser(t, run) {
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
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block',
    timezoneId: 'America/Los_Angeles',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => {
    const text = String(error && error.stack ? error.stack : error);
    if (text.includes('due to access control checks')) return;
    errors.push(text);
  });
  try {
    await run({ page, context, port, errors });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
}

test('webkit v24 profile does not upload Welcome or copies until an explicit resolve', { timeout: 90000 }, async (t) => {
  await withBrowser(t, async ({ page, context, port }) => {
    const state = gitState([[NOTE, { sha: 'blob-9', text: 'theirs\n' }]]);
    await mockGithub(context, state);
    await page.clock.install({ time: new Date('2026-10-21T22:30:00Z') });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('build-version')?.textContent === 'core-sample-shell-v26');
    await seed(page, [
      markdown('Welcome.md', '# Welcome\n'),
      markdown(NOTE, 'mine\n', {
        dirty: true,
        conflict: true,
        conflictAt: Date.parse('2026-10-21T19:18:00Z'),
        conflictRemoteAt: Date.parse('2026-10-21T19:05:00Z'),
        conflictReason: 'both',
        conflictRemote: 'theirs\n',
        conflictRemoteSha: 'blob-9',
        conflictBase: 'old\n',
        baseSha: 'blob-1',
        remoteSha: 'blob-1',
      }),
      markdown(COPY, 'theirs\n', { conflictCopy: true }),
    ], NOTE);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Conflict');
    assert.deepEqual(state.writes, []);
    await page.locator('#sync-status').click();
    await page.locator('.conflict-open').first().click();
    await page.locator('#keep-phone').click();
    await page.locator('#conflict-resolve-button').click();
    await page.waitForSelector('#conflict-trash-copy');
    await page.waitForFunction(() => {
      const status = document.getElementById('sync-status')?.textContent || '';
      return status.startsWith('Synced') || status === 'Changes pending' || status === 'Syncing';
    });
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => (document.getElementById('sync-status')?.textContent || '').includes('conflict copy'));
    assert.equal(state.patches, 1);
    assert.equal(state.writes.filter((line) => line.startsWith('PATCH ')).length, 1);
    assert.equal(state.files.has('Welcome.md'), false);
    assert.equal(state.files.has(COPY), false);
    assert.equal(state.files.get(NOTE).text, 'mine\n');
    const rows = await readFiles(page);
    assert.equal(rows.find((row) => row.path === 'Welcome.md').remoteSha, null);
    assert.equal(rows.find((row) => row.path === COPY).trashedAt, null);
    await page.locator('#conflict-trash-copy').click();
    const after = await readFiles(page);
    assert.ok(after.find((row) => row.path === COPY).trashedAt);
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced');
  });
});

test('webkit restore after a synced delete uploads the note again', { timeout: 90000 }, async (t) => {
  await withBrowser(t, async ({ page, context, port }) => {
    const state = gitState([[NOTE, { sha: 'blob-1', text: 'Local line\n' }]]);
    await mockGithub(context, state);
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('build-version')?.textContent === 'core-sample-shell-v26');
    await seed(page, [
      markdown('Welcome.md', '# Welcome\n', { origin: 'app', localOnly: true }),
      markdown(NOTE, 'Local line\n', { baseSha: 'blob-1', remoteSha: 'blob-1', origin: 'user' }),
    ], NOTE);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced');
    await page.locator('#notes-button').click();
    await page.locator('.browser-row', { hasText: 'Field Notes' }).locator('.row-more').first().click();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Move to Trash' }).click();
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Changes pending');
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced');
    assert.equal(state.files.has(NOTE), false);
    await page.getByRole('button', { name: 'Restore' }).click();
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Changes pending');
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced');
    assert.equal(state.files.get(NOTE).text, 'Local line\n');
  });
});

test('webkit rename does not bring the old path back', { timeout: 90000 }, async (t) => {
  await withBrowser(t, async ({ page, context, port }) => {
    const state = gitState([['Logs.md', { sha: 'blob-1', text: 'See [[Field Notes]]\n' }]]);
    await mockGithub(context, state);
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('build-version')?.textContent === 'core-sample-shell-v26');
    await seed(page, [
      markdown('Welcome.md', '# Welcome\n', { origin: 'app', localOnly: true }),
      markdown('Logs.md', 'See [[Field Notes]]\n', { baseSha: 'blob-1', remoteSha: 'blob-1', origin: 'user' }),
    ], 'Logs.md');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced');
    await page.locator('#notes-button').click();
    await page.locator('.browser-row', { hasText: 'Logs' }).locator('.row-more').first().click();
    await page.getByRole('button', { name: 'Rename' }).click();
    await page.locator('#action-panel input').fill('Journal');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Changes pending');
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced');
    assert.equal(state.blobGets.includes('blob-1'), false);
    assert.equal(state.files.has('Logs.md'), false);
    assert.equal(state.files.has('Journal.md'), true);
    assert.ok(state.lastTree.tree.some((entry) => entry.path === 'Logs.md' && entry.sha === null));
    const rows = await readFiles(page);
    assert.equal(rows.some((row) => row.path === 'Logs.md'), false);
    assert.ok(rows.some((row) => row.path === 'Journal.md'));
  });
});

test('webkit leftover conflict copies stay tappable and dismiss to Trash', { timeout: 90000 }, async (t) => {
  await withBrowser(t, async ({ page, context, port }) => {
    const state = gitState([[NOTE, { sha: 'blob-1', text: 'Local line\n' }]]);
    await mockGithub(context, state);
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('build-version')?.textContent === 'core-sample-shell-v26');
    await seed(page, [
      markdown(NOTE, 'Local line\n', { baseSha: 'blob-1', remoteSha: 'blob-1', origin: 'user' }),
      markdown(COPY, 'theirs\n', { conflictCopy: true }),
    ], NOTE);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced · 1 conflict copy');
    assert.equal(await page.locator('#sync-status').getAttribute('aria-disabled'), 'false');
    await page.locator('#sync-status').click();
    await page.waitForSelector('#conflict-list .conflict-dismiss');
    await page.locator('.conflict-dismiss').click();
    const rows = await readFiles(page);
    const copy = rows.find((row) => row.path === COPY);
    assert.ok(copy);
    assert.ok(copy.trashedAt);
    assert.equal(rows.some((row) => row.path === COPY) && !rows.every((row) => row.path !== COPY), true);
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced');
    assert.equal(state.files.has(COPY), false);
    assert.equal(state.writes.length, 0);
  });
});

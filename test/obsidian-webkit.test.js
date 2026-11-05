import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isIgnoredPath } from '../app/js/vault-paths.js';
import { createFakeGit } from './helpers/fake-git.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const appDir = join(here, '..', 'app');
const TOKEN = 'gho_testtokenvalue123456';
const SHOTS = process.env.CONFLICT_SHOTS || '/tmp/core-sample-shots';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, if-none-match, accept, x-github-api-version',
  'access-control-expose-headers': 'etag, retry-after, x-ratelimit-remaining, x-ratelimit-reset',
};

function vault() {
  return {
    'Notes/A.md': 'alpha\n',
    'Notes/B.md': 'one\ntwo\nthree\n',
    'Daily/2026-10-21.md': 'day\n',
    '.obsidian/workspace.json': '{"active":"Notes/A.md"}\n',
    '.obsidian/app.json': '{"attachmentFolderPath":"assets"}\n',
    '.trash/Old.md': 'old trashed note\n',
    '.gitignore': '.obsidian/workspace.json\n',
    'assets/pic.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]),
  };
}

async function shot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, name) });
}

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

// Routes api.github.com to the shared fake. `gate.delay(method, path)` can
// hold a reply to make a slow network visible on screen.
async function routeGithub(context, git, gate = {}) {
  await context.route(/api\.github\.com/, async (route) => {
    const request = route.request();
    const method = request.method();
    if (request.url().includes('gho_')) throw new Error('token leaked into the url');
    if (method === 'OPTIONS') {
      const requested = request.headers()['access-control-request-headers'];
      await route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': requested || CORS['access-control-allow-headers'] } });
      return;
    }
    // Playwright cannot fulfill a 304, so the conditional ref read always gets the body.
    const { 'if-none-match': _etag, ...headers } = await request.allHeaders();
    const wait = gate.delay ? gate.delay(method, new URL(request.url()).pathname) : 0;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const result = await git.handle({ method, url: request.url(), headers, body: request.postData() });
    await route.fulfill({ status: result.status, headers: { ...CORS, ...result.headers }, body: result.body ?? '' });
  });
}

async function waitForStart(page) {
  await page.waitForFunction(() => document.getElementById('build-version')?.textContent === 'core-sample-shell-v36');
  await page.waitForFunction(() => new Promise((resolve) => {
    const request = indexedDB.open('core-sample');
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('meta').objectStore('meta').get('recent');
      get.onsuccess = () => { db.close(); resolve(Boolean(get.result)); };
      get.onerror = () => { db.close(); resolve(false); };
    };
  }));
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
      const request = db.transaction('files', 'readonly').objectStore('files').getAll();
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
    updatedAt: Date.parse('2026-10-21T19:10:00Z'),
    trashedAt: null,
    remoteSha: null,
    baseSha: null,
    dirty: false,
    conflict: false,
    ...extra,
  };
}

async function watchStatus(page) {
  await page.evaluate(() => {
    window.__statuses = [];
    const node = document.getElementById('sync-status');
    const record = () => window.__statuses.push(node.textContent);
    record();
    new MutationObserver(record).observe(node, { childList: true, characterData: true, subtree: true });
  });
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

test('webkit phone edits land while Obsidian pushes a backup and a merge commit mid-sync', { timeout: 120000 }, async (t) => {
  await withBrowser(t, async ({ page, context, port }) => {
    const git = createFakeGit({ token: TOKEN, files: vault() });
    await routeGithub(context, git);
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await waitForStart(page);
    await seed(page, [], 'Notes/A.md');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced', null, { timeout: 30000 });
    await page.evaluate(async () => {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open('core-sample');
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise((resolve) => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ key: 'lastOpened', value: 'Notes/A.md' });
        tx.oncomplete = () => resolve();
      });
      db.close();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('source')?.value === 'alpha\n');
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced', null, { timeout: 30000 });
    const pulled = (await readFiles(page)).map((row) => row.path).sort();
    assert.deepEqual(pulled, ['Daily/2026-10-21.md', 'Notes/A.md', 'Notes/B.md', 'assets/pic.png']);
    const pic = (await readFiles(page)).find((row) => row.path === 'assets/pic.png');
    assert.equal(pic.kind, 'binary');
    assert.equal(pic.content, '');

    const desktopBase = git.state.head;
    await watchStatus(page);
    await page.locator('#source .cm-content').fill('alpha\nfirst phone edit\n');
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced'
      && window.__statuses.includes('Syncing'), null, { timeout: 30000 });
    const phonePush = git.state.head;
    assert.notEqual(phonePush, desktopBase);

    // Obsidian committed on the head it last pulled, then pulls the phone's
    // push, merges, and pushes the merge while the phone is mid-sync.
    const desktop = git.commitOn(desktopBase, {
      'Daily/2026-10-21.md': 'day\nwritten on the computer\n',
      '.obsidian/workspace.json': '{"active":"Daily/2026-10-21.md"}\n',
      '.trash/Older.md': 'trashed on the computer\n',
    });
    let merge = '';
    git.state.hooks.beforePatch = () => {
      if (merge) return;
      merge = git.mergeFiles(desktop, phonePush);
      git.advance(git.commitOn(merge, { '.obsidian/workspace.json': '{"active":"Notes/B.md"}\n' }, 'vault backup'));
    };
    await page.evaluate(() => { window.__statuses = []; });
    await page.locator('#source .cm-content').fill('alpha\nfirst phone edit\nsecond phone edit\n');
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced'
      && window.__statuses.includes('Syncing'), null, { timeout: 30000 });
    const statuses = await page.evaluate(() => window.__statuses);
    assert.equal(statuses.includes('Conflict'), false, statuses.join(' | '));
    assert.equal(statuses.includes('Sync failed'), false, statuses.join(' | '));
    assert.equal(git.state.rejectedPatches, 1);
    assert.ok(merge);
    assert.equal(git.state.commits.get(merge).parents.length, 2);

    const head = git.state.head;
    const backup = git.state.commits.get(head).parents[0];
    assert.equal(git.state.commits.get(backup).parents[0], merge);
    const remote = git.snapshot(head);
    assert.equal(remote.get('Notes/A.md'), 'alpha\nfirst phone edit\nsecond phone edit\n');
    assert.equal(remote.get('Daily/2026-10-21.md'), 'day\nwritten on the computer\n');
    const dots = (sha) => [...git.entriesAt(sha)].filter(([path]) => isIgnoredPath(path)).map(([path, entry]) => `${path}@${entry.sha}`);
    assert.deepEqual(dots(head), dots(backup));
    assert.equal(git.blobShaAt('assets/pic.png', head), git.blobShaAt('assets/pic.png', desktopBase));
    for (const write of git.state.log.filter((item) => item.method === 'POST' && item.path.endsWith('/git/trees'))) {
      assert.equal(write.body.tree.some((entry) => isIgnoredPath(entry.path)), false);
    }
    assert.equal(git.state.log.every((item) => !item.url.includes(TOKEN) && item.auth === `Bearer ${TOKEN}`), true);

    await page.waitForFunction(() => document.getElementById('source')?.value === 'alpha\nfirst phone edit\nsecond phone edit\n');
    const rows = await readFiles(page);
    assert.equal(rows.some((row) => isIgnoredPath(row.path)), false);
    assert.equal(rows.find((row) => row.path === 'Daily/2026-10-21.md').content, 'day\nwritten on the computer\n');
    assert.equal(rows.some((row) => row.conflict || row.conflictCopy), false);
    await page.locator('#notes-button').click();
    await page.waitForSelector('#notes-list li');
    const listed = await page.locator('#notes-list').innerText();
    assert.equal(/\.obsidian|\.trash|Old(er)?\b/.test(listed), false, listed);
    await page.locator('#notes-close').click();
    await shot(page, 'obsidian-race-synced.png');
  });
});

test('webkit Keep GitHub shows Syncing… on the button while the resolve sync runs', { timeout: 90000 }, async (t) => {
  await withBrowser(t, async ({ page, context, port }) => {
    const git = createFakeGit({ token: TOKEN, files: vault() });
    const gate = { slow: false };
    gate.delay = (method, path) => (gate.slow && method === 'GET' && path.endsWith('/git/ref/heads/main') ? 2000 : 0);
    await routeGithub(context, git, gate);
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await waitForStart(page);
    const head = git.state.head;
    const sha = (path) => git.blobShaAt(path);
    const synced = (path, text) => markdown(path, text, { baseSha: sha(path), remoteSha: sha(path), syncedCommit: head, origin: 'user' });
    await seed(page, [
      synced('Notes/A.md', 'alpha\n'),
      synced('Daily/2026-10-21.md', 'day\n'),
      markdown('Notes/B.md', 'one\ntwo phone\nthree\n', {
        baseSha: sha('Notes/B.md'),
        remoteSha: sha('Notes/B.md'),
        syncedCommit: head,
        dirty: true,
        conflict: true,
        conflictAt: Date.parse('2026-10-21T19:18:00Z'),
        conflictReason: 'both',
        conflictRemote: 'one\ntwo\nthree\n',
        conflictRemoteSha: sha('Notes/B.md'),
        conflictRemoteKnown: true,
        conflictBase: '',
      }),
    ], 'Notes/A.md');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Conflict', null, { timeout: 30000 });
    await page.locator('#sync-status').click();
    await page.locator('.conflict-open', { hasText: 'Notes/B.md' }).click();
    await page.locator('#keep-github').click();
    gate.slow = true;
    await page.locator('#conflict-resolve-button').click();
    const busy = await page.evaluate(() => {
      const button = document.getElementById('conflict-resolve-button');
      return {
        text: button?.textContent,
        busy: button?.getAttribute('aria-busy'),
        disabled: button?.disabled,
        phone: document.getElementById('keep-phone')?.disabled,
      };
    });
    assert.deepEqual(busy, { text: 'Syncing…', busy: 'true', disabled: true, phone: true });
    await shot(page, 'keep-github-syncing.png');
    await page.locator('#conflict-resolve-button').click({ force: true, timeout: 1000 }).catch(() => {});
    await page.waitForSelector('#undo-toast:not([hidden])', { timeout: 20000 });
    gate.slow = false;
    const rows = await readFiles(page);
    const saved = rows.find((row) => row.path === 'Notes/B.md');
    assert.equal(saved.content, 'one\ntwo\nthree\n');
    assert.equal(saved.conflict, false);
    assert.equal(rows.filter((row) => row.path.startsWith('Notes/B') && !row.backup).length, 1);
    const backupNote = rows.find((row) => row.backup);
    assert.equal(backupNote.content, 'one\ntwo phone\nthree\n');
  });
});

test('webkit an offline legacy conflict with no copy says GitHub is unavailable instead of a fake diff', { timeout: 90000 }, async (t) => {
  await withBrowser(t, async ({ page, context, port }) => {
    const git = createFakeGit({ token: TOKEN, files: vault() });
    await routeGithub(context, git);
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await waitForStart(page);
    const head = git.state.head;
    const sha = (path) => git.blobShaAt(path);
    await seed(page, [
      markdown('Notes/A.md', 'alpha\n', { baseSha: sha('Notes/A.md'), remoteSha: sha('Notes/A.md'), syncedCommit: head, origin: 'user' }),
      markdown('Notes/B.md', 'one phone\ntwo phone\nthree phone\n', {
        baseSha: 'blob-old',
        remoteSha: 'blob-old',
        dirty: true,
        conflict: true,
      }),
    ], 'Notes/A.md');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Conflict', null, { timeout: 30000 });
    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    await page.locator('#sync-status').click();
    await page.locator('.conflict-open', { hasText: 'Notes/B.md' }).click();
    await page.waitForSelector('#conflict-remote-missing');
    const view = page.locator('#conflict-resolve-view');
    const text = await view.innerText();
    assert.match(text, /GitHub's version isn't available offline/);
    assert.match(text, /Try again/);
    assert.equal(await view.locator('.diff-add, .diff-del, .hunk-conflict').count(), 0);
    assert.equal(/Added|Removed/.test(text), false, text);
    assert.equal(await page.locator('#conflict-phone-text').textContent(), 'one phone\ntwo phone\nthree phone\n');
    assert.equal(await page.locator('#keep-github').isDisabled(), true);
    assert.equal(await page.locator('#keep-both').isDisabled(), true);
    assert.equal(await page.locator('#keep-phone').isDisabled(), false);
    assert.equal(await page.locator('#conflict-resolve-button').isDisabled(), true);
    await shot(page, 'offline-legacy-unavailable.png');

    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine === true);
    await page.locator('#conflict-retry-remote').click();
    await page.waitForSelector('#keep-github:not([disabled])', { timeout: 20000 });
    assert.equal(await page.locator('#conflict-remote-missing').count(), 0);
    assert.equal((await view.innerText()).includes('two'), true);
    assert.equal(await view.locator('.hunk-conflict').count() > 0, true);
    const rows = await readFiles(page);
    assert.equal(rows.find((row) => row.path === 'Notes/B.md').content, 'one phone\ntwo phone\nthree phone\n');
  });
});

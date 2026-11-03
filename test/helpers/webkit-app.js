// Serves app/ and drives it in Playwright WebKit with an iPhone 13 profile.
// Used by the Live Preview and sidebar tests. No network beyond 127.0.0.1.
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('../../app', import.meta.url));
export const SHOTS = process.env.CONFLICT_SHOTS || '/tmp/core-sample-shots';
export const BUILD = 'core-sample-shell-v30';

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

export function serve() {
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
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-cache' });
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

// The service worker is blocked by default. Its first activate navigates
// every window onto the new shell, which can land after openApp's reload
// and pull the page out from under a test. Blocking also lets
// context.route() see image loads, which WebKit otherwise sends past
// Playwright's router. The worker has its own tests.
export async function withPhone(t, run, { colorScheme = 'light', serviceWorkers = 'block' } = {}) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    t.skip('playwright is not installed');
    return;
  }
  const { webkit, devices } = playwright;
  const server = await serve();
  const browser = await webkit.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], colorScheme, serviceWorkers });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    const { port } = server.address();
    await run({ page, context, url: `http://127.0.0.1:${port}/`, errors });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function waitForStart(page) {
  await page.waitForFunction((build) => document.getElementById('build-version')?.textContent === build, BUILD);
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

export function note(path, content, extra = {}) {
  return {
    path,
    content,
    kind: 'markdown',
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1,
    trashedAt: null,
    remoteSha: null,
    baseSha: null,
    dirty: false,
    conflict: false,
    origin: 'user',
    ...extra,
  };
}

// Replaces the notes and opens `lastOpened` on the next load. `meta` adds
// extra meta rows, such as a fake GitHub repo name for the vault footer.
export async function seed(page, rows, lastOpened, meta = {}) {
  await page.evaluate(async ({ rows, lastOpened, meta }) => {
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
      const store = tx.objectStore('meta');
      store.put({ key: 'seeded', value: true });
      store.put({ key: 'lastOpened', value: lastOpened });
      store.put({ key: 'recent', value: [lastOpened] });
      for (const [key, value] of Object.entries(meta)) store.put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { rows, lastOpened, meta });
}

export async function readNote(page, path) {
  return page.evaluate((path) => new Promise((resolve, reject) => {
    const request = indexedDB.open('core-sample');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('files').objectStore('files').get(path);
      get.onsuccess = () => { db.close(); resolve(get.result || null); };
      get.onerror = () => { db.close(); reject(get.error); };
    };
  }), path);
}

export async function openApp(page, url, rows, lastOpened, meta) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForStart(page);
  await seed(page, rows, lastOpened, meta);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((build) => document.getElementById('build-version')?.textContent === build, BUILD);
  await page.waitForFunction(() => document.querySelector('#source .cm-content')?.getAttribute('contenteditable') === 'true');
}

export async function shot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, name) });
}

// Synthetic touches. Playwright WebKit has no touch-drag API and refuses
// `new Touch()`, but the legacy document.createTouch path still works.
export async function swipe(page, from, to, { steps = 8, frameMs = 16, holdMs = 0, selector = '#source' } = {}) {
  await page.evaluate(async ({ from, to, steps, frameMs, holdMs, selector }) => {
    const target = document.querySelector(selector) || document.body;
    const touch = (x, y) => document.createTouch(window, target, 7, x, y, x, y);
    const fire = (type, x, y, ended = false) => {
      const point = touch(x, y);
      const active = ended ? document.createTouchList() : document.createTouchList(point);
      target.dispatchEvent(new TouchEvent(type, {
        touches: active,
        targetTouches: active,
        changedTouches: document.createTouchList(point),
        bubbles: true,
        cancelable: true,
      }));
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    fire('touchstart', from.x, from.y);
    if (holdMs) await wait(holdMs);
    for (let i = 1; i <= steps; i += 1) {
      await wait(frameMs);
      fire('touchmove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    }
    fire('touchend', to.x, to.y, true);
  }, { from, to, steps, frameMs, holdMs, selector });
}

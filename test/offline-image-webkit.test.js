import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const appDir = join(here, '..', 'app');
const NOTE = 'Field Notes.md';
const LINK = 'plate.png';
const IMAGE = 'assets/Field Notes/plate.png';

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function solidPng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) raw.set(rgba, row + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = solidPng(48, 32, Buffer.from([20, 80, 140, 255]));

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

async function imageRows(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('core-sample');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction('images', 'readonly');
      const request = tx.objectStore('images').getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows.map((row) => ({
      path: row.path,
      blob: row.blob instanceof Blob,
      data: row.data instanceof ArrayBuffer ? row.data.byteLength : 0,
    }));
  });
}

function assertKept(rows, label) {
  assert.equal(rows.length, 1, label);
  assert.equal(rows[0].path, IMAGE, label);
  assert.ok(rows[0].data > 0, label);
}

test('webkit shows a stored image twice, then offline, without dropping the record', { timeout: 90000 }, async (t) => {
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
  // The installed shell is what an offline reload loads. Blocking the worker
  // makes that navigation fail inside WebKit. WebKit also does not hand a
  // service-worker-controlled page's fetch to context.route, so GitHub is
  // mocked inside the page.
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  await context.addInitScript((bytes) => {
    const original = window.fetch.bind(window);
    const pngBytes = new Uint8Array(bytes);
    const logKey = 'core-sample-test-fetches';
    const prior = JSON.parse(sessionStorage.getItem(logKey) || '[]');
    window.__imageFetches = prior;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!url.includes('api.github.com')) return original(input, init);
      if (url.includes('gho_')) throw new Error('token leaked into the url');
      prior.push(url);
      sessionStorage.setItem(logKey, JSON.stringify(prior));
      if (navigator.onLine === false) return Promise.reject(new TypeError('offline'));
      if (url.includes('/contents/') && url.includes('plate.png')) {
        return Promise.resolve(new Response(pngBytes, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }));
      }
      return Promise.resolve(new Response('missing', { status: 404 }));
    };
  }, [...png]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    const origin = `http://127.0.0.1:${port}/`;
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 30000 });
    // Activate navigates the open page once. Wait that out, then load again
    // so the seed is not torn down mid-write.
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const status = document.getElementById('save-status')?.textContent || '';
      return Boolean(navigator.serviceWorker?.controller)
        && status.includes('Saved')
        && document.getElementById('build-version')?.textContent === 'core-sample-shell-v24';
    });
    await page.evaluate(async ({ note, image, link, now }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('core-sample');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('open failed'));
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['files', 'meta'], 'readwrite');
        tx.objectStore('files').put({
          path: note,
          content: `![[${link}]]\n`,
          kind: 'markdown',
          encoding: 'utf-8',
          createdAt: 1,
          updatedAt: 2,
        });
        const meta = tx.objectStore('meta');
        meta.put({ key: 'lastOpened', value: note });
        meta.put({ key: 'editorMode', value: 'preview' });
        meta.put({ key: 'githubToken', value: 'gho_testtokenvalue123456' });
        meta.put({ key: 'githubRepo', value: 'owner/repo' });
        meta.put({ key: 'githubBranch', value: 'main' });
        meta.put({ key: 'githubRoot', value: '' });
        meta.put({
          key: 'githubVaultIndex',
          value: {
            ok: true,
            repo: 'owner/repo',
            branch: 'main',
            root: '',
            paths: [note, image],
            attachmentFolderPath: './assets/Field Notes',
            fetchedAt: now,
            treeSha: 'tree123',
            truncated: false,
            shas: { [image]: 'sha-plate' },
            status: 200,
            reason: '',
          },
        });
        meta.put({
          key: 'githubResolvedEmbeds',
          value: {
            repo: 'owner/repo',
            branch: 'main',
            root: '',
            links: {
              [`${note}\n${link}`]: image,
              [`path\n${image}`]: image,
            },
          },
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('seed failed'));
        tx.onabort = () => reject(tx.error || new Error('seed failed'));
      });
      db.close();
    }, { note: NOTE, image: IMAGE, link: LINK, now: Date.now() });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const img = document.querySelector('#preview img.embed-image');
      return Boolean(img && img.complete && img.naturalWidth > 0 && !document.querySelector('#preview .embed-fallback'));
    }, null, { timeout: 20000 });
    assertKept(await imageRows(page), 'first view');
    const firstFetches = await page.evaluate(() => JSON.parse(sessionStorage.getItem('core-sample-test-fetches') || '[]'));
    assert.equal(firstFetches.filter((url) => url.includes('/contents/') && url.includes('plate.png')).length, 1);

    await page.locator('#mode-source').click();
    await page.locator('#mode-preview').click();
    await page.waitForFunction(() => {
      const img = document.querySelector('#preview img.embed-image');
      return Boolean(img && img.complete && img.naturalWidth > 0 && !document.querySelector('#preview .embed-fallback'));
    }, null, { timeout: 20000 });
    assertKept(await imageRows(page), 'second view');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const img = document.querySelector('#preview img.embed-image');
      return Boolean(img && img.complete && img.naturalWidth > 0 && !document.querySelector('#preview .embed-fallback'));
    }, null, { timeout: 20000 });
    assertKept(await imageRows(page), 'reloaded');

    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const img = document.querySelector('#preview img.embed-image');
      const offline = navigator.onLine === false;
      return offline && Boolean(img && img.complete && img.naturalWidth > 0 && !document.querySelector('#preview .embed-fallback'));
    }, null, { timeout: 20000 });
    assertKept(await imageRows(page), 'offline');
    const fetches = await page.evaluate(() => JSON.parse(sessionStorage.getItem('core-sample-test-fetches') || '[]'));
    const imageFetches = fetches.filter((url) => url.includes('/contents/') && url.includes('plate.png'));
    assert.equal(imageFetches.length, 1);
    assert.equal(fetches.some((url) => url.includes('gho_')), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const appDir = join(repo, 'app');
const v15Dir = '/tmp/core-sample-v15';
const v16Dir = '/tmp/core-sample-v16';

const NOTE = [
  '- [x] parent task',
  '\t- [x] nested task',
  '\t\t![[image-1710000000000.png]]',
  '\t- [x] sibling task',
].join('\n');

const IMAGE_PATH = 'assets/Field Notes/image-1710000000000.png';
const INDEX = {
  repo: 'owner/repo',
  branch: 'main',
  root: '',
  paths: ['Field Notes.md', IMAGE_PATH, '.obsidian/app.json'],
  attachmentFolderPath: './assets/Field Notes',
  attachmentChecked: true,
  fetchedAt: Date.now(),
  treeSha: 'tree123',
  truncated: false,
};

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

const png = solidPng(320, 200, Buffer.from([30, 90, 160, 255]));

function serve(rootOf) {
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
    const root = rootOf();
    const url = new URL(req.url, 'http://127.0.0.1');
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const path = join(root, relative === '/' ? 'index.html' : relative);
    if (!path.startsWith(root)) {
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

async function extract(commit, dest) {
  await exec('bash', ['-lc', `rm -rf ${dest} && mkdir -p ${dest} && git -C ${repo} archive --format=tar ${commit} app | tar -x -C ${dest} --strip-components=1`]);
}

function mockGithub(context, sink) {
  return context.route(/api\.github\.com/, async (route) => {
    const url = route.request().url();
    sink.urls.push(url);
    if (url.includes('/contents/') && url.includes('Field%20Notes') && url.includes('image-1710000000000.png')) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: png,
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' });
  });
}

async function seedVault(page) {
  await page.evaluate(async (index) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('core-sample');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      store.put({ key: 'githubToken', value: 'gho_testtokenvalue123456' });
      store.put({ key: 'githubRepo', value: 'owner/repo' });
      store.put({ key: 'githubBranch', value: 'main' });
      store.put({ key: 'githubRoot', value: '' });
      store.put({ key: 'githubVaultIndex', value: index });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('meta write failed'));
    });
    db.close();
  }, INDEX);
}

async function showNote(page) {
  await page.locator('#source').fill(NOTE);
  await page.waitForFunction(() => document.getElementById('save-status')?.textContent === 'Saved on this device');
  await seedVault(page);
  await page.locator('#mode-preview').click();
}

async function previewState(page) {
  return page.evaluate(() => {
    const preview = document.getElementById('preview');
    const html = preview?.innerHTML || '';
    const img = preview?.querySelector('img.embed-image') || null;
    const style = img ? getComputedStyle(img) : null;
    let pixel = null;
    if (img && img.naturalWidth > 0) {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 1, 1);
      pixel = [...ctx.getImageData(0, 0, 1, 1).data];
    }
    return {
      build: document.getElementById('build-version')?.textContent || '',
      tasks: preview?.querySelectorAll('.task-toggle').length || 0,
      embed: html.includes('data-embed="image-1710000000000.png"'),
      code: html.includes('<pre') || html.includes('<code'),
      literal: html.includes('![['),
      fallback: Boolean(preview?.querySelector('.embed-fallback')),
      natural: img?.naturalWidth || 0,
      width: img ? img.getBoundingClientRect().width : 0,
      height: img ? img.getBoundingClientRect().height : 0,
      opacity: style?.opacity || '',
      visibility: style?.visibility || '',
      display: style?.display || '',
      src: img?.getAttribute('src') || '',
      inTask: Boolean(img?.closest('li.task .item-body')),
      modal: document.getElementById('image-viewer')?.getAttribute('aria-modal'),
      pixel,
      scale: window.visualViewport?.scale ?? 1,
      boot: document.getElementById('boot-error')?.hidden === false,
    };
  });
}

function assertPainted(state, label) {
  assert.equal(state.boot, false, label);
  assert.equal(state.embed, true, label);
  assert.equal(state.code, false, label);
  assert.equal(state.literal, false, label);
  assert.equal(state.tasks, 3, label);
  assert.equal(state.fallback, false, label);
  assert.ok(state.natural > 0, label);
  assert.ok(state.width > 20 && state.height > 20, `${label} ${state.width}x${state.height}`);
  assert.equal(state.opacity, '1', label);
  assert.equal(state.visibility, 'visible', label);
  assert.equal(state.display, 'block', label);
  assert.equal(state.inTask, true, label);
  assert.equal(state.modal, null, label);
  assert.equal(state.scale, 1, label);
  assert.ok(state.src.startsWith('blob:'), label);
  assert.deepEqual(state.pixel, [30, 90, 160, 255], label);
}

test('the hidden photo dialog does not cancel touches on the note', () => {
  const html = readFileSync(join(appDir, 'index.html'), 'utf8');
  const opener = html.slice(html.indexOf('id="image-viewer"'), html.indexOf('image-viewer-close'));
  assert.equal(opener.includes('aria-modal'), false);
  const js = readFileSync(join(appDir, 'js/image-viewer.js'), 'utf8');
  const arm = js.indexOf('function armBlocking');
  const disarm = js.indexOf('function disarmBlocking');
  const touch = js.indexOf("doc.addEventListener('touchmove', blockGesture");
  assert.ok(arm !== -1 && touch > arm && touch < disarm);
  assert.equal(js.split("doc.addEventListener('touchmove'").length, 2);
  assert.match(js, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(js, /removeAttribute\('aria-modal'\)/);
  const view = readFileSync(join(appDir, 'js/view.js'), 'utf8');
  assert.match(view, /embedBlobs\.set\(made\.img, result\.blob\)/);
  assert.match(view, /blob: img \? embedBlobs\.get\(img\)/);
});

test('webkit keeps a tab-indented task image after the viewer opens, closes, and the note re-renders', { timeout: 90000 }, async (t) => {
  let webkit;
  let devices;
  try {
    ({ webkit, devices } = await import('playwright'));
  } catch {
    t.skip('playwright is not installed');
    return;
  }
  const server = await serve(() => appDir);
  const { port } = server.address();
  const browser = await webkit.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const seen = { urls: [] };
  await mockGithub(context, seen);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const status = document.getElementById('save-status')?.textContent || '';
      return status.includes('Saved') && document.getElementById('build-version')?.textContent === 'core-sample-shell-v22';
    });
    await showNote(page);
    await page.waitForFunction(() => {
      const img = document.querySelector('#preview img.embed-image');
      return Boolean(img && img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width > 20);
    });
    const before = await previewState(page);
    assertPainted(before, 'before');
    assert.equal(seen.urls.some((url) => url.includes('gho_')), false);
    assert.ok(seen.urls.some((url) => url.includes('/contents/assets/Field%20Notes/image-1710000000000.png')));

    await page.evaluate(() => {
      document.querySelector('#preview img.embed-image').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    await page.waitForFunction(() => document.getElementById('image-viewer')?.dataset.state === 'open');
    await page.waitForFunction(() => {
      const photo = document.querySelector('.image-viewer-photo');
      return Boolean(photo && photo.complete && photo.naturalWidth > 0);
    });
    const open = await page.evaluate(() => {
      const img = document.querySelector('#preview img.embed-image');
      const photo = document.querySelector('.image-viewer-photo');
      const style = getComputedStyle(img);
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 1, 1);
      return {
        src: img.getAttribute('src'),
        natural: img.naturalWidth,
        width: img.getBoundingClientRect().width,
        opacity: style.opacity,
        visibility: style.visibility,
        display: style.display,
        pixel: [...ctx.getImageData(0, 0, 1, 1).data],
        photoSrc: photo.getAttribute('src'),
        photoNatural: photo.naturalWidth,
        modal: document.getElementById('image-viewer').getAttribute('aria-modal'),
        scale: window.visualViewport.scale,
      };
    });
    assert.equal(open.src, before.src);
    assert.ok(open.photoSrc.startsWith('blob:') && open.photoSrc !== open.src);
    assert.equal(open.natural, before.natural);
    assert.ok(open.width > 20);
    assert.equal(open.opacity, '1');
    assert.equal(open.visibility, 'visible');
    assert.equal(open.display, 'block');
    assert.deepEqual(open.pixel, [30, 90, 160, 255]);
    assert.ok(open.photoNatural > 0);
    assert.equal(open.modal, 'true');
    assert.equal(open.scale, 1);

    await page.locator('#image-viewer-close').click();
    await page.waitForFunction(() => document.getElementById('image-viewer')?.hidden);
    const closed = await previewState(page);
    assertPainted(closed, 'closed');
    assert.equal(closed.src, before.src);

    await page.locator('#mode-source').click();
    await page.locator('#mode-preview').click();
    await page.waitForFunction(() => {
      const img = document.querySelector('#preview img.embed-image');
      return Boolean(img && img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width > 20);
    });
    const again = await previewState(page);
    assertPainted(again, 'rerender');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

test('webkit fetches a bare filename from the attachment folder when the file list omits it', { timeout: 90000 }, async (t) => {
  let webkit;
  let devices;
  try {
    ({ webkit, devices } = await import('playwright'));
  } catch {
    t.skip('playwright is not installed');
    return;
  }
  const shots = process.env.CORE_SAMPLE_ARTIFACTS || '';
  if (shots) mkdirSync(shots, { recursive: true });
  const server = await serve(() => appDir);
  const { port } = server.address();
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'block',
  });
  const seen = { urls: [] };
  await context.route(/api\.github\.com/, async (route) => {
    const url = route.request().url();
    seen.urls.push(url);
    if (url.includes('/git/trees/')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          truncated: true,
          tree: [
            { path: 'Welcome.md', type: 'blob' },
            { path: '.obsidian/app.json', type: 'blob' },
          ],
        }),
      });
      return;
    }
    if (url.includes('app.json')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: '{"attachmentFolderPath":"./assets/Field Notes"}',
      });
      return;
    }
    if (url.includes('Field%20Notes') && url.includes('image-1710000000000.png')) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: png,
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const status = document.getElementById('save-status')?.textContent || '';
      return status.includes('Saved') && document.getElementById('build-version')?.textContent === 'core-sample-shell-v22';
    });
    await page.locator('#source').fill(NOTE);
    await page.waitForFunction(() => document.getElementById('save-status')?.textContent === 'Saved on this device');
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('core-sample');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('meta', 'readwrite');
        const store = tx.objectStore('meta');
        store.put({ key: 'githubToken', value: 'gho_testtokenvalue123456' });
        store.put({ key: 'githubRepo', value: 'owner/repo' });
        store.put({ key: 'githubBranch', value: 'main' });
        store.put({ key: 'githubRoot', value: '' });
        store.delete('githubVaultIndex');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('meta write failed'));
      });
      db.close();
    });
    await page.locator('#mode-preview').click();
    await page.waitForFunction(() => {
      const img = document.querySelector('#preview img.embed-image');
      return Boolean(img && img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width > 20);
    });
    const painted = await previewState(page);
    assertPainted(painted, 'unlisted');
    const imageUrl = seen.urls.find((url) => /\/contents\/assets\/Field%20Notes\/image-1710000000000\.png\?ref=main$/.test(url));
    assert.ok(imageUrl);
    assert.equal(imageUrl.includes('%2520'), false);
    assert.equal(seen.urls.some((url) => url.includes('gho_')), false);
    assert.ok(seen.urls.some((url) => url.includes('/git/trees/')));
    assert.ok(seen.urls.some((url) => url.includes('app.json')));
    if (shots) await page.screenshot({ path: join(shots, 'v18-nested-inline.png') });

    await page.evaluate(() => {
      document.querySelector('#preview img.embed-image').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    await page.waitForFunction(() => document.getElementById('image-viewer')?.dataset.state === 'open');
    await page.waitForFunction(() => {
      const photo = document.querySelector('.image-viewer-photo');
      return Boolean(photo && photo.complete && photo.naturalWidth > 0);
    });
    if (shots) await page.screenshot({ path: join(shots, 'v18-nested-viewer.png') });
    await page.locator('#image-viewer-close').click();
    await page.waitForFunction(() => document.getElementById('image-viewer')?.hidden);
    const closed = await previewState(page);
    assertPainted(closed, 'unlisted-closed');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

test('webkit keeps the task image through a cold v15 to v16 to v20 update', { timeout: 180000 }, async (t) => {
  let webkit;
  let devices;
  try {
    ({ webkit, devices } = await import('playwright'));
  } catch {
    t.skip('playwright is not installed');
    return;
  }
  try {
    await extract('34e5b7cdc3d4d5922aba066bf511161f63f16fd0', v15Dir);
    await extract('da2e6b1dafd2f03be0a761109a5623e12845d6c5', v16Dir);
  } catch (error) {
    t.skip(`could not unpack older shells: ${error.message}`);
    return;
  }
  let root = v15Dir;
  const server = await serve(() => root);
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}/`;
  const browser = await webkit.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const seen = { urls: [] };
  await mockGithub(context, seen);
  // WebKit does not hand a service-worker-controlled request to context.route.
  // The page fetch is still the app's fetch, so the mock lives there too.
  await context.addInitScript((bytes) => {
    const original = window.fetch.bind(window);
    window.__imageFetches = [];
    const pngBytes = new Uint8Array(bytes);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!url.includes('api.github.com')) return original(input, init);
      window.__imageFetches.push(url);
      if (localStorage.getItem('core-sample-offline') === '1') {
        return Promise.resolve(new Response('offline', { status: 500 }));
      }
      if (url.includes('/git/trees/')) {
        return Promise.resolve(new Response(JSON.stringify({
          truncated: true,
          tree: [
            { path: 'Welcome.md', type: 'blob' },
            { path: '.obsidian/app.json', type: 'blob' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (url.includes('app.json')) {
        return Promise.resolve(new Response('{"attachmentFolderPath":"./assets/Field Notes"}', {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }));
      }
      if (url.includes('Field%20Notes') && url.includes('image-1710000000000.png')) {
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

  async function ready(build) {
    await page.waitForFunction((want) => {
      const version = document.getElementById('build-version')?.textContent;
      const status = document.getElementById('save-status')?.textContent || '';
      return version === want && status.includes('Saved');
    }, build, { timeout: 40000 });
    await page.waitForTimeout(500);
  }

  async function advance(nextRoot, build) {
    root = nextRoot;
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) await registration.update();
    });
    await ready(build);
  }

  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 30000 });
    await ready('core-sample-shell-v15');
    await showNote(page);
    await page.waitForTimeout(1500);
    const on15 = await previewState(page);
    assert.equal(on15.build, 'core-sample-shell-v15');
    assert.equal(on15.embed, true);
    assert.equal(on15.code, false);
    assert.equal(on15.literal, false);
    assert.equal(on15.tasks, 3);

    await advance(v16Dir, 'core-sample-shell-v16');
    await page.waitForTimeout(1500);
    const on16 = await previewState(page);
    assert.equal(on16.build, 'core-sample-shell-v16');
    assert.equal(on16.embed, true);
    assert.equal(on16.code, false);
    assert.equal(on16.tasks, 3);
    if (on15.natural > 0) assert.ok(on16.natural > 0, 'v16 dropped a painted image');

    await advance(appDir, 'core-sample-shell-v22');
    await page.waitForFunction(() => {
      const img = document.querySelector('#preview img.embed-image');
      return Boolean(img && img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width > 20);
    }, null, { timeout: 20000 });
    const on17 = await previewState(page);
    assert.equal(on17.build, 'core-sample-shell-v22');
    assertPainted(on17, 'v18');

    const cached = await page.evaluate(async () => {
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
        size: row.blob instanceof Blob ? row.blob.size : 0,
      }));
    });
    const fetches = await page.evaluate(() => window.__imageFetches || []);
    assert.ok(fetches.some((url) => url.includes('/contents/assets/Field%20Notes/image-1710000000000.png')));
    assert.equal(fetches.some((url) => url.includes('gho_')), false);
    if (cached.some((row) => row.blob && row.size > 0)) {
      await page.evaluate(() => localStorage.setItem('core-sample-offline', '1'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready('core-sample-shell-v22');
      await page.waitForFunction(() => {
        const img = document.querySelector('#preview img.embed-image');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      });
      const offline = await previewState(page);
      assertPainted(offline, 'offline-after-upgrade');
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

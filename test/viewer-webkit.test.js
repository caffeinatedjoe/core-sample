import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { dirname, extname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../app');

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
  ]).toString('base64');
}

const red = `data:image/png;base64,${solidPng(120, 400, Buffer.from([180, 40, 40, 255]))}`;
const blue = `data:image/png;base64,${solidPng(120, 400, Buffer.from([30, 70, 160, 255]))}`;

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
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
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

async function gesture(page, steps) {
  await page.evaluate(async (frames) => {
    const stage = document.querySelector('.image-viewer-stage');
    const fire = (type, id, x, y) => {
      stage.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: id,
        pointerType: 'touch',
        isPrimary: id === 1,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      }));
    };
    for (const frame of frames) {
      for (const step of frame) fire(step.type, step.id, step.x, step.y);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, steps);
}

function poseOf(style) {
  const match = style.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0(?:px)?\)\s*scale\(([-\d.]+)\)/);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

test('webkit photo viewer pinches, pans, dismisses, and does not zoom the page', { timeout: 90000 }, async (t) => {
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
  const page = await browser.newPage({ ...devices['iPhone 13'] });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => navigator.serviceWorker?.controller);
    await page.waitForTimeout(800);
    await page.waitForFunction(() => {
      const status = document.getElementById('save-status')?.textContent || '';
      const source = document.getElementById('source');
      return status.includes('Saved') && source && !source.hidden;
    });
    await page.locator('#source').fill(`![red](${red})\n\n![blue](${blue})`);
    await page.waitForFunction(() => document.getElementById('save-status')?.textContent === 'Saved on this device');
    await page.locator('#mode-preview').click();
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('#preview img.embed-image')];
      return images.length === 2 && images.every((img) => img.complete && img.naturalWidth > 0);
    });
    const beforeScroll = await page.evaluate(() => {
      const preview = document.getElementById('preview');
      const img = preview.querySelector('img.embed-image');
      const max = Math.max(0, preview.scrollHeight - preview.clientHeight);
      const besideThumb = Math.max(0, img.offsetTop - 48);
      preview.scrollTop = besideThumb > 40 ? besideThumb : Math.min(max, 120);
      return { top: preview.scrollTop, height: preview.scrollHeight, client: preview.clientHeight };
    });
    assert.ok(beforeScroll.top > 40, JSON.stringify(beforeScroll));
    await page.evaluate(() => {
      document.querySelector('#preview img.embed-image').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    await page.waitForFunction(() => document.getElementById('image-viewer')?.dataset.state === 'open');

    const opened = await page.evaluate(() => {
      const viewer = document.getElementById('image-viewer');
      const photo = document.querySelector('.image-viewer-photo');
      const close = document.getElementById('image-viewer-close');
      const box = close.getBoundingClientRect();
      return {
        role: viewer.getAttribute('role'),
        modal: viewer.getAttribute('aria-modal'),
        label: viewer.getAttribute('aria-label'),
        alt: photo.alt,
        focused: document.activeElement?.id,
        close: { w: box.width, h: box.height, top: box.top },
        transform: photo.style.transform,
        opacity: document.querySelector('.image-viewer-backdrop').style.opacity,
        scale: window.visualViewport.scale,
        scroll: document.getElementById('preview').scrollTop,
      };
    });
    assert.equal(opened.role, 'dialog');
    assert.equal(opened.modal, 'true');
    assert.equal(opened.alt, 'red');
    assert.equal(opened.focused, 'image-viewer-close');
    assert.ok(opened.close.w >= 44 && opened.close.h >= 44);
    assert.ok(opened.close.top >= 0);
    const fitted = poseOf(opened.transform);
    assert.ok(fitted && fitted.scale > 0.5);
    assert.equal(opened.scale, 1);
    assert.equal(opened.scroll, beforeScroll.top);

    const center = await page.evaluate(() => {
      const box = document.querySelector('.image-viewer-stage').getBoundingClientRect();
      return { x: box.width / 2, y: box.height / 2 };
    });
    await gesture(page, [
      [
        { type: 'pointerdown', id: 1, x: center.x - 20, y: center.y },
        { type: 'pointerdown', id: 2, x: center.x + 20, y: center.y },
      ],
      [
        { type: 'pointermove', id: 1, x: center.x - 70, y: center.y },
        { type: 'pointermove', id: 2, x: center.x + 70, y: center.y },
      ],
    ]);
    const pinched = poseOf(await page.locator('.image-viewer-photo').first().evaluate((img) => img.style.transform));
    assert.ok(pinched.scale > fitted.scale * 1.5, `pinch scale ${pinched.scale} from ${fitted.scale}`);
    await gesture(page, [[
      { type: 'pointerup', id: 1, x: center.x - 70, y: center.y },
      { type: 'pointerup', id: 2, x: center.x + 70, y: center.y },
    ]]);
    await page.waitForFunction(() => document.getElementById('image-viewer').dataset.state === 'open');
    const held = poseOf(await page.locator('.image-viewer-photo').first().evaluate((img) => img.style.transform));
    assert.ok(held.scale > fitted.scale * 1.4);

    await gesture(page, [
      [{ type: 'pointerdown', id: 1, x: center.x, y: center.y }],
      [{ type: 'pointermove', id: 1, x: center.x - 36, y: center.y + 28 }],
    ]);
    const panned = poseOf(await page.locator('.image-viewer-photo').first().evaluate((img) => img.style.transform));
    assert.ok(Math.abs(panned.x - held.x) > 5 || Math.abs(panned.y - held.y) > 5);
    await gesture(page, [[{ type: 'pointerup', id: 1, x: center.x - 36, y: center.y + 28 }]]);
    await page.waitForFunction(() => document.getElementById('image-viewer').dataset.state === 'open');

    await gesture(page, [
      [
        { type: 'pointerdown', id: 1, x: center.x, y: center.y },
        { type: 'pointerup', id: 1, x: center.x, y: center.y },
      ],
      [
        { type: 'pointerdown', id: 1, x: center.x + 2, y: center.y },
        { type: 'pointerup', id: 1, x: center.x + 2, y: center.y },
      ],
    ]);
    await page.waitForFunction(() => document.getElementById('image-viewer').dataset.state === 'open');
    const back = poseOf(await page.locator('.image-viewer-photo').first().evaluate((img) => img.style.transform));
    assert.ok(Math.abs(back.scale - fitted.scale) < 0.05);

    await gesture(page, [
      [{ type: 'pointerdown', id: 1, x: center.x, y: center.y }],
      [{ type: 'pointermove', id: 1, x: center.x, y: center.y + 40 }],
    ]);
    const shortDrag = await page.evaluate(() => ({
      opacity: Number(document.querySelector('.image-viewer-backdrop').style.opacity),
      state: document.getElementById('image-viewer').dataset.state,
    }));
    assert.equal(shortDrag.state, 'dragging');
    assert.ok(shortDrag.opacity < 1 && shortDrag.opacity > 0.5);
    await page.waitForTimeout(120);
    await gesture(page, [
      [{ type: 'pointermove', id: 1, x: center.x, y: center.y + 40 }],
      [{ type: 'pointerup', id: 1, x: center.x, y: center.y + 40 }],
    ]);
    await page.waitForFunction(() => document.getElementById('image-viewer').dataset.state === 'open');
    const restored = await page.evaluate(() => Number(document.querySelector('.image-viewer-backdrop').style.opacity));
    assert.ok(restored > 0.95);

    await gesture(page, [
      [{ type: 'pointerdown', id: 1, x: center.x, y: 80 }],
      [{ type: 'pointermove', id: 1, x: center.x, y: 360 }],
      [{ type: 'pointerup', id: 1, x: center.x, y: 360 }],
    ]);
    await page.waitForFunction(() => document.getElementById('image-viewer').hidden);
    const closed = await page.evaluate(() => ({
      scale: window.visualViewport.scale,
      scroll: document.getElementById('preview').scrollTop,
      focus: document.activeElement?.className || '',
    }));
    assert.equal(closed.scale, 1);
    assert.equal(closed.scroll, beforeScroll.top);
    assert.match(closed.focus, /embed-image/);

    await page.locator('#preview img.embed-image').first().tap();
    await page.waitForFunction(() => document.getElementById('image-viewer').dataset.state === 'open');
    const width = center.x * 2;
    await gesture(page, [
      [{ type: 'pointerdown', id: 1, x: center.x, y: center.y }],
      [{ type: 'pointermove', id: 1, x: center.x - width * 0.7, y: center.y }],
      [{ type: 'pointerup', id: 1, x: center.x - width * 0.7, y: center.y }],
    ]);
    await page.waitForFunction(() => document.getElementById('image-viewer').dataset.state === 'open');
    const counter = await page.locator('#image-viewer-count').textContent();
    assert.equal(counter, '2 of 2');
    const secondAlt = await page.locator('.image-viewer-photo').last().getAttribute('alt');
    assert.equal(secondAlt, 'blue');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('image-viewer').hidden);
    const scale = await page.evaluate(() => window.visualViewport.scale);
    assert.equal(scale, 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

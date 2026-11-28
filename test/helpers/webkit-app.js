// Serves app/ and drives it in Playwright WebKit with an iPhone 13 profile.
// Used by the Live Preview and sidebar tests. No network beyond 127.0.0.1.
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_BUILD } from '../../app/js/version.js';

const appDir = fileURLToPath(new URL('../../app', import.meta.url));
export const SHOTS = process.env.CONFLICT_SHOTS || '/tmp/core-sample-shots';
export const BUILD = APP_BUILD;
export { APP_BUILD };

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
export async function withPhone(t, run, { colorScheme = 'light', serviceWorkers = 'block', viewport = null } = {}) {
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
  const base = { ...devices['iPhone 13'], colorScheme, serviceWorkers };
  const context = await browser.newContext(
    viewport
      ? { ...base, viewport: { width: viewport.width, height: viewport.height } }
      : base,
  );
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
  // Boot is still writing lastOpened until the editor becomes editable.
  // Seeding before that lets the first start() clobber the seeded note.
  await page.waitForFunction(() => document.querySelector('#source .cm-content')?.getAttribute('contenteditable') === 'true');
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

// Playwright WebKit does not raise the iOS keyboard. Shrink the shell the
// way visualViewport does on a phone so screenshots match that layout.
export async function fakeKeyboard(page, inset = 336) {
  await page.evaluate((inset) => {
    const root = document.documentElement;
    const height = Math.max(0, Math.round(root.getBoundingClientRect().height - inset));
    root.style.setProperty('--keyboard-inset', `${inset}px`);
    root.style.setProperty('--shell-h', `${height}px`);
    root.classList.add('is-keyboard');
  }, inset);
}

// Synthetic touches. Playwright WebKit has no touch-drag API and refuses
// `new Touch()`, but the legacy document.createTouch path still works.
// Long-press a format button with touch + pointer events (WebKit createTouch).
export async function formatBarLongPress(page, formatId, { holdMs = 520, blurEditor = false } = {}) {
  const box = await page.locator(`[data-format="${formatId}"]`).boundingBox();
  if (!box) throw new Error(`missing format button ${formatId}`);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(async ({ formatId, point, holdMs, blurEditor }) => {
    const target = document.querySelector(`[data-format="${formatId}"]`);
    const scroll = document.querySelector('#format-bar .format-scroll');
    if (!target || !scroll) throw new Error('format bar missing');
    const pointerId = 88;
    const touchAt = (x, y) => document.createTouch(window, target, pointerId, x, y, x, y);
    const fireTouch = (type, x, y, ended = false) => {
      const pt = touchAt(x, y);
      const active = ended ? document.createTouchList() : document.createTouchList(pt);
      target.dispatchEvent(new TouchEvent(type, {
        touches: active,
        targetTouches: active,
        changedTouches: document.createTouchList(pt),
        bubbles: true,
        cancelable: true,
      }));
    };
    const firePointer = (type, buttons) => {
      target.dispatchEvent(new PointerEvent(type, {
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        buttons,
        bubbles: true,
        cancelable: true,
      }));
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    fireTouch('touchstart', point.x, point.y);
    firePointer('pointerdown', 1);
    await wait(holdMs);
    if (blurEditor) document.querySelector('#source .cm-content')?.blur();
    fireTouch('touchend', point.x, point.y, true);
    firePointer('pointerup', 0);
  }, { formatId, point, holdMs, blurEditor });
}

export async function formatBarTap(page, formatId) {
  const box = await page.locator(`[data-format="${formatId}"]`).boundingBox();
  if (!box) throw new Error(`missing format button ${formatId}`);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(({ formatId, point }) => {
    const target = document.querySelector(`[data-format="${formatId}"]`);
    if (!target) throw new Error(`missing format button ${formatId}`);
    const pointerId = 92;
    const touchAt = (x, y) => document.createTouch(window, target, pointerId, x, y, x, y);
    const pt = touchAt(point.x, point.y);
    target.dispatchEvent(new TouchEvent('touchstart', {
      touches: document.createTouchList(pt),
      targetTouches: document.createTouchList(pt),
      changedTouches: document.createTouchList(pt),
      bubbles: true,
      cancelable: true,
    }));
    target.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons: 1,
      bubbles: true,
      cancelable: true,
    }));
    target.dispatchEvent(new TouchEvent('touchend', {
      touches: document.createTouchList(),
      targetTouches: document.createTouchList(),
      changedTouches: document.createTouchList(pt),
      bubbles: true,
      cancelable: true,
    }));
    target.dispatchEvent(new PointerEvent('pointerup', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons: 0,
      bubbles: true,
      cancelable: true,
    }));
    target.dispatchEvent(new MouseEvent('click', {
      clientX: point.x,
      clientY: point.y,
      button: 0,
      bubbles: true,
      cancelable: true,
    }));
  }, { formatId, point });
}

export async function formatEditSheetDragToPoint(page, fromId, to, { steps = 14, frameMs = 16, holdMs = 200, fromSection } = {}) {
  let fromLocator = `#format-edit-shown [data-id="${fromId}"], #format-edit-hidden [data-id="${fromId}"]`;
  if (fromSection === 'hidden') fromLocator = `#format-edit-hidden [data-id="${fromId}"]`;
  else if (fromSection === 'shown') fromLocator = `#format-edit-shown [data-id="${fromId}"]`;
  const fromBox = await page.locator(fromLocator).boundingBox();
  if (!fromBox) throw new Error(`missing edit sheet tile ${fromId}`);
  const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
  const tileSelector = fromSection === 'hidden'
    ? `#format-edit-hidden [data-id="${fromId}"]`
    : fromSection === 'shown'
      ? `#format-edit-shown [data-id="${fromId}"]`
      : `#format-edit-shown [data-id="${fromId}"], #format-edit-hidden [data-id="${fromId}"]`;
  await page.evaluate(async ({ fromId, from, to, steps, frameMs, holdMs, tileSelector }) => {
    const tile = document.querySelector(tileSelector);
    const grid = document.getElementById('format-edit-scroll');
    if (!tile || !grid) throw new Error('edit sheet missing');
    const pointerId = 96;
    const firePointer = (type, point, buttons) => {
      const target = type === 'pointerdown' ? tile : grid;
      target.dispatchEvent(new PointerEvent(type, {
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        buttons,
        bubbles: true,
        cancelable: true,
      }));
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    firePointer('pointerdown', from, 1);
    await wait(holdMs);
    for (let i = 1; i <= steps; i += 1) {
      await wait(frameMs);
      const point = {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      };
      firePointer('pointermove', point, 1);
    }
    await wait(frameMs);
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    firePointer('pointerup', to, 0);
  }, { fromId, from, to, steps, frameMs, holdMs, tileSelector });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

export async function waitDoubleRaf(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

export async function formatEditSheetDrag(page, fromId, toId, { steps = 12, frameMs = 16 } = {}) {
  const fromBox = await page.locator(`#format-edit-shown [data-id="${fromId}"], #format-edit-hidden [data-id="${fromId}"]`).boundingBox();
  const toBox = await page.locator(`#format-edit-shown [data-id="${toId}"], #format-edit-hidden [data-id="${toId}"]`).boundingBox();
  if (!fromBox || !toBox) throw new Error('missing edit sheet tiles');
  const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
  const to = { x: toBox.x + toBox.width / 2, y: toBox.y + toBox.height / 2 };
  await page.evaluate(async ({ fromId, from, to, steps, frameMs }) => {
    const tile = document.querySelector(`#format-edit-shown [data-id="${fromId}"], #format-edit-hidden [data-id="${fromId}"]`);
    const grid = document.getElementById('format-edit-scroll');
    if (!tile || !grid) throw new Error('edit sheet missing');
    const pointerId = 94;
    const firePointer = (type, point, buttons) => {
      const target = type === 'pointerdown' ? tile : grid;
      target.dispatchEvent(new PointerEvent(type, {
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        buttons,
        bubbles: true,
        cancelable: true,
      }));
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    firePointer('pointerdown', from, 1);
    await wait(200);
    for (let i = 1; i <= steps; i += 1) {
      await wait(frameMs);
      const point = {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      };
      firePointer('pointermove', point, 1);
    }
    firePointer('pointerup', to, 0);
  }, { fromId, from, to, steps, frameMs });
  await page.waitForTimeout(80);
}

export async function formatBarTouchDrag(page, fromId, toId, { steps = 10, frameMs = 16 } = {}) {
  const fromBox = await page.locator(`[data-format="${fromId}"]`).boundingBox();
  const toBox = await page.locator(`[data-format="${toId}"]`).boundingBox();
  if (!fromBox || !toBox) throw new Error('missing format buttons for drag');
  const from = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
  const to = { x: toBox.x + toBox.width / 2, y: toBox.y + toBox.height / 2 };
  await page.evaluate(async ({ fromId, from, to, steps, frameMs }) => {
    const scroll = document.querySelector('#format-bar .format-scroll');
    const btn = document.querySelector(`[data-format="${fromId}"]`);
    if (!scroll || !btn) throw new Error('format bar missing');
    const pointerId = 90;
    const touchAt = (x, y) => document.createTouch(window, btn, pointerId, x, y, x, y);
    const fireTouch = (type, x, y, ended = false) => {
      const pt = touchAt(x, y);
      const active = ended ? document.createTouchList() : document.createTouchList(pt);
      btn.dispatchEvent(new TouchEvent(type, {
        touches: active,
        targetTouches: active,
        changedTouches: document.createTouchList(pt),
        bubbles: true,
        cancelable: true,
      }));
    };
    const firePointer = (type, point, buttons) => {
      btn.dispatchEvent(new PointerEvent(type, {
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        buttons,
        bubbles: true,
        cancelable: true,
      }));
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    fireTouch('touchstart', from.x, from.y);
    firePointer('pointerdown', from, 1);
    for (let i = 1; i <= steps; i += 1) {
      await wait(frameMs);
      const point = {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      };
      fireTouch('touchmove', point.x, point.y);
      firePointer('pointermove', point, 1);
    }
    firePointer('pointerup', to, 0);
    fireTouch('touchend', to.x, to.y, true);
  }, { fromId, from, to, steps, frameMs });
}

export function editorFocused(page) {
  return page.evaluate(() => Boolean(document.activeElement?.closest?.('.cm-content')));
}

export async function installFormatBarTouchSpy(page) {
  await page.evaluate(() => {
    window.__formatBarTouch = { starts: [], ends: [] };
    const bar = document.getElementById('format-bar');
    bar.addEventListener('touchstart', (event) => {
      window.__formatBarTouch.starts.push(event.defaultPrevented);
    });
    bar.addEventListener('touchend', (event) => {
      window.__formatBarTouch.ends.push(event.defaultPrevented);
    });
  });
}

export function readFormatBarTouchSpy(page) {
  return page.evaluate(() => window.__formatBarTouch || { starts: [], ends: [] });
}

export async function touchPointerDownOutside(page, selector, point) {
  await page.evaluate(({ selector, point }) => {
    const target = document.querySelector(selector) || document.body;
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      changedTouches: document.createTouchList(
        document.createTouch(window, target, 91, point.x, point.y, point.x, point.y),
      ),
    }));
    document.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 91,
      pointerType: 'touch',
      isPrimary: true,
      clientX: point.x,
      clientY: point.y,
      button: 0,
      bubbles: true,
      cancelable: true,
    }));
  }, { selector, point });
}

export async function swipe(page, from, to, { steps = 8, frameMs = 16, holdMs = 0, selector = '#source', scrollDelta = 0 } = {}) {
  await page.evaluate(async ({ from, to, steps, frameMs, holdMs, selector, scrollDelta }) => {
    const target = document.querySelector(selector) || document.body;
    const scroller = document.querySelector('.cm-scroller');
    const pointerId = 7;
    const touch = (x, y) => document.createTouch(window, target, pointerId, x, y, x, y);
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
    const firePointer = (type, x, y) => {
      target.dispatchEvent(new PointerEvent(type, {
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        bubbles: true,
        cancelable: true,
      }));
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    fire('touchstart', from.x, from.y);
    firePointer('pointerdown', from.x, from.y);
    if (holdMs) await wait(holdMs);
    for (let i = 1; i <= steps; i += 1) {
      await wait(frameMs);
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      if (scrollDelta && scroller) scroller.scrollTop += scrollDelta / steps;
      fire('touchmove', x, y);
      firePointer('pointermove', x, y);
    }
    fire('touchend', to.x, to.y, true);
    firePointer('pointerup', to.x, to.y);
  }, { from, to, steps, frameMs, holdMs, selector, scrollDelta });
}

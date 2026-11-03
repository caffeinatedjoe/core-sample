import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import {
  BUILD,
  fakeKeyboard,
  note,
  seed,
  shot,
  waitForStart,
  withPhone,
} from './helpers/webkit-app.js';

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

function stripedPng(width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    const band = Math.floor(y / 16) % 2 ? [92, 84, 76, 255] : [168, 120, 84, 255];
    for (let x = 0; x < width; x += 1) raw.set(band, row + 1 + x * 4);
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

const PNG = stripedPng(320, 180);
const NOTE = 'Site Log.md';
const TEXT = 'A core photo.\n\n![[shot.png]]\n';
const IMAGE = 'assets/Site Log/shot.png';
const PDF = 'assets/Site Log/notes.pdf';

function binary(path, bytes) {
  return {
    path,
    content: '',
    kind: 'binary',
    encoding: 'binary',
    bytes,
    createdAt: 1,
    updatedAt: 1,
    trashedAt: null,
    remoteSha: null,
    baseSha: null,
    dirty: false,
    conflict: false,
    origin: 'user',
  };
}

async function putImages(page, images) {
  await page.evaluate(async (images) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('core-sample');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite');
      const store = tx.objectStore('images');
      for (const image of images) {
        const data = Uint8Array.from(image.bytes).buffer;
        store.put({
          key: `${image.repo}\n${image.path}`,
          repo: image.repo,
          path: image.path,
          data,
          bytes: data.byteLength,
          type: image.type,
          viewedAt: Date.now(),
          sha: '',
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, images);
}

async function settled(page, open) {
  await page.waitForFunction((open) => {
    const root = document.getElementById('notes-sheet');
    const left = root.querySelector('.drawer-panel').getBoundingClientRect().left;
    return root.classList.contains('is-open') === open && (open ? Math.abs(left) < 1 : left < -100);
  }, open);
  await page.waitForTimeout(300);
}

async function caretAt(page, offset) {
  await page.evaluate(async (offset) => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.focus();
    view.dispatch({ selection: { anchor: offset } });
  }, offset);
  await page.waitForTimeout(50);
}

test('webkit sidebar lists attachments, opens the image viewer, and renders embeds', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForStart(page);
    await seed(page, [
      note(NOTE, TEXT),
      binary(IMAGE, PNG.byteLength),
      binary(PDF, 1200),
    ], NOTE, {
      folders: ['assets', 'assets/Site Log'],
      expanded: ['assets', 'assets/Site Log'],
      githubRepo: 'owner/sample-vault',
    });
    await putImages(page, [{ repo: '', path: IMAGE, bytes: [...PNG], type: 'image/png' }]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((build) => document.getElementById('build-version')?.textContent === build, BUILD);
    await page.waitForFunction(() => document.querySelector('#source .cm-content')?.getAttribute('contenteditable') === 'true');

    await page.waitForFunction(() => {
      const img = document.querySelector('#source img.embed-image');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    });
    await shot(page, 'attachments-embed.png');

    await caretAt(page, TEXT.indexOf('core'));
    await fakeKeyboard(page, 336);
    await page.waitForFunction(() => !document.getElementById('format-bar').hidden);
    assert.equal(await page.locator('label.format-image[aria-label="Image"]').count(), 1);
    await shot(page, 'attachments-format-image.png');
    await page.locator('#format-dismiss').click();
    await page.waitForFunction(() => document.getElementById('format-bar').hidden);

    await page.locator('#notes-button').click();
    await settled(page, true);
    assert.equal(await page.locator('.note-name', { hasText: 'shot.png' }).count(), 1);
    assert.equal(await page.locator('.note-name', { hasText: 'notes.pdf' }).count(), 1);
    assert.equal(await page.locator('.file-icon').count() >= 2, true);
    await page.locator('.note-name', { hasText: 'shot.png' }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await shot(page, 'attachments-sidebar.png');

    await page.locator('.note-link', { hasText: 'shot.png' }).click();
    await page.waitForFunction(() => !document.getElementById('image-viewer').hidden);
    await page.waitForTimeout(400);
    await shot(page, 'attachments-viewer.png');
    await page.locator('#image-viewer-close').click();
    await page.waitForFunction(() => document.getElementById('image-viewer').hidden);

    await page.locator('#notes-button').click();
    await settled(page, true);
    await page.locator('.note-link', { hasText: 'notes.pdf' }).click();
    await page.waitForFunction(() => !document.getElementById('file-preview').hidden);
    assert.equal(await page.locator('#file-preview-name').textContent(), 'notes.pdf');
    assert.match(await page.locator('#file-preview-size').textContent(), /KB|bytes/);
    assert.equal(await page.locator('#file-preview-note').textContent(), "Can't preview this file type");
    await shot(page, 'attachments-file-preview.png');
    assert.deepEqual(errors, []);
  });
});

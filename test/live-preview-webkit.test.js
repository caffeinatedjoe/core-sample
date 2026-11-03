import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { note, openApp, readNote, shot, withPhone } from './helpers/webkit-app.js';

const NOTE = 'Field Notes.md';
const TEXT = [
  '# Basalt survey',
  '',
  'Cores from the **north** ridge, see [the map](https://example.com/map) and [[Lab log]].',
  '',
  '- [ ] Label the trays',
  '- [x] Photograph core 7',
  '',
  '> Keep samples out of the sun.',
  '',
  '![core](https://images.example.com/core.png)',
  '',
  '```',
  'depth 12.5 m',
  '```',
  '',
].join('\n');

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
    const band = Math.floor(y / 20) % 2 ? [92, 84, 76, 255] : [168, 120, 84, 255];
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

async function routeImage(context) {
  const png = stripedPng(320, 180);
  await context.route('https://images.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
}

// Puts the caret at `offset` the way a tap would, through CodeMirror's view.
async function caretAt(page, offset) {
  await page.evaluate(async (offset) => {
    const { EditorView } = await import('./vendor/codemirror.js');
    const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
    view.focus();
    view.dispatch({ selection: { anchor: offset } });
  }, offset);
  await page.waitForTimeout(50);
}

function lineText(page, n) {
  return page.evaluate((n) => document.querySelectorAll('#source .cm-line')[n]?.textContent ?? '', n);
}

test('webkit renders a note in place and shows raw Markdown only where the caret is', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, context, url, errors }) => {
    await routeImage(context);
    await openApp(page, url, [note(NOTE, TEXT), note('Lab log.md', '# Lab log\n')], NOTE);
    await page.waitForSelector('#source img.embed-image');
    await page.waitForFunction(() => document.querySelector('#source img.embed-image')?.naturalWidth > 0);

    assert.equal(await lineText(page, 0), 'Basalt survey');
    const body = await lineText(page, 2);
    assert.equal(body.includes('**'), false);
    assert.equal(body.includes('https://example.com/map'), false);
    assert.equal(body.includes('[['), false);
    assert.equal(await page.locator('#source .task-toggle').count(), 2);
    assert.equal(await page.locator('#source .mode-switch, #preview').count(), 0);
    const headingBox = await page.locator('#source .cm-line.cm-h1').boundingBox();
    await shot(page, 'live-rendered-note.png');

    await caretAt(page, 3);
    assert.equal(await lineText(page, 0), '# Basalt survey');
    const revealedBox = await page.locator('#source .cm-line.cm-h1').boundingBox();
    assert.equal(Math.round(revealedBox.height), Math.round(headingBox.height), 'the heading keeps its height when its # shows');
    assert.equal(Math.round(revealedBox.y), Math.round(headingBox.y));
    await shot(page, 'live-caret-heading.png');

    const link = TEXT.indexOf('the map') + 2;
    await caretAt(page, link);
    const raw = await lineText(page, 2);
    assert.match(raw, /\[the map\]\(https:\/\/example\.com\/map\)/);
    assert.equal(raw.includes('**north**'), false, 'only the span under the caret opens');
    assert.equal(await lineText(page, 0), 'Basalt survey');
    await shot(page, 'live-caret-link.png');

    const stored = await readNote(page, NOTE);
    assert.equal(stored.content, TEXT);
    assert.deepEqual(errors, []);
  });
});

test('webkit task toggle saves without focusing the editor', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, context, url, errors }) => {
    await routeImage(context);
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    const box = page.locator('#source .task-toggle').first();
    assert.equal(await box.getAttribute('aria-checked'), 'false');
    await box.tap();
    await page.waitForFunction(() => document.querySelector('#source .task-toggle')?.getAttribute('aria-checked') === 'true');
    const focused = await page.evaluate(() => Boolean(document.activeElement?.closest?.('.cm-content')));
    assert.equal(focused, false, 'the keyboard stays down');
    await page.waitForFunction(async () => {
      const read = () => new Promise((resolve) => {
        const request = indexedDB.open('core-sample');
        request.onsuccess = () => {
          const get = request.result.transaction('files').objectStore('files').get('Field Notes.md');
          get.onsuccess = () => { request.result.close(); resolve(get.result?.content || ''); };
        };
      });
      return (await read()).includes('- [x] Label the trays');
    });
    const stored = await readNote(page, NOTE);
    assert.equal(stored.content, TEXT.replace('- [ ] Label', '- [x] Label'));
    await shot(page, 'live-task-toggled.png');
    assert.deepEqual(errors, []);
  });
});

test('webkit inline image sits in the text and opens the viewer on tap', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, context, url, errors }) => {
    await routeImage(context);
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    const img = page.locator('#source img.embed-image');
    await page.waitForFunction(() => document.querySelector('#source img.embed-image')?.naturalWidth > 0, null, { timeout: 60000 });
    const rect = await img.boundingBox();
    assert.ok(rect.width > 200 && rect.width <= 390, `image width ${rect.width}`);
    await img.scrollIntoViewIfNeeded();
    await shot(page, 'live-inline-image.png');
    await img.tap();
    await page.waitForSelector('#image-viewer:not([hidden])');
    await page.locator('#image-viewer-close').click();
    await page.waitForSelector('#image-viewer', { state: 'hidden' });
    assert.deepEqual(errors, []);
  });
});

test('webkit scrolls a 3,000-line note smoothly and keeps the text', { timeout: 120000 }, async (t) => {
  await withPhone(t, async ({ page, url, errors }) => {
    const lines = [];
    for (let i = 1; i <= 3000; i += 1) {
      if (i % 100 === 1) lines.push(`## Section ${Math.ceil(i / 100)}`);
      else if (i % 7 === 0) lines.push(`- [ ] Sample ${i} with **bold** and [[Link ${i}]]`);
      else lines.push(`Line ${i} of the long core log.`);
    }
    const long = `${lines.join('\n')}\n`;
    await openApp(page, url, [note('Long.md', long)], 'Long.md');
    const drawn = await page.locator('#source .cm-line').count();
    assert.ok(drawn < 400, `only the viewport is drawn (${drawn} lines)`);

    const frames = await page.evaluate(async () => {
      const scroller = document.querySelector('#source .cm-scroller');
      const gaps = [];
      let last = performance.now();
      for (let i = 0; i < 60; i += 1) {
        scroller.scrollTop += 900;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        gaps.push(now - last);
        last = now;
      }
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      gaps.sort((a, b) => a - b);
      return { median: gaps[Math.floor(gaps.length / 2)], worst: gaps[gaps.length - 1] };
    });
    assert.ok(frames.median < 50, `median frame ${frames.median}ms`);
    await page.waitForFunction(() => [...document.querySelectorAll('#source .cm-line')].some((line) => line.textContent.includes('Line 3000 of')));
    await shot(page, 'live-long-note-end.png');
    assert.equal((await readNote(page, 'Long.md')).content, long);
    assert.equal(await page.evaluate(() => document.getElementById('source').value.length), long.length);
    assert.deepEqual(errors, []);
  });
});

test('webkit selection copies the Markdown source', { timeout: 90000 }, async (t) => {
  await withPhone(t, async ({ page, context, url, errors }) => {
    await routeImage(context);
    await openApp(page, url, [note(NOTE, TEXT)], NOTE);
    const from = TEXT.indexOf('Cores');
    const to = TEXT.indexOf(' ridge');
    const copied = await page.evaluate(async ({ from, to }) => {
      const { EditorView } = await import('./vendor/codemirror.js');
      const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
      view.focus();
      view.dispatch({ selection: { anchor: from, head: to } });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      let text = null;
      document.addEventListener('copy', (event) => {
        text = event.clipboardData.getData('text/plain');
      }, { once: true });
      document.execCommand('copy');
      return { text, selected: view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) };
    }, { from, to });
    assert.equal(copied.selected, 'Cores from the **north**');
    assert.equal(copied.text, 'Cores from the **north**');
    await shot(page, 'live-selection.png');
    assert.equal((await readNote(page, NOTE)).content, TEXT);
    assert.deepEqual(errors, []);
  });
});

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'app');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function shellList() {
  const sw = read('app/sw.js');
  const match = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(match, 'service worker lists a SHELL array');
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

function pngSize(relative) {
  const buf = readFileSync(join(appDir, relative));
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

test('the manifest and service worker are relative to the Pages subpath', () => {
  const html = read('app/index.html');
  const manifest = JSON.parse(read('app/manifest.json'));
  const sw = read('app/sw.js');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.match(html, /href="\.\/manifest\.json"/);
  assert.match(read('app/js/main.js'), /register\('\.\/sw\.js', \{ updateViaCache: 'none' \}\)/);
  assert.equal(sw.includes('api.github.com'), false);
  for (const file of ['app/index.html', 'app/manifest.json', 'app/sw.js', 'app/css/app.css']) {
    const text = read(file);
    assert.equal(text.includes('"/'), false, `${file} has a root-absolute URL`);
    assert.equal(text.includes("'/"), false, `${file} has a root-absolute URL`);
  }
});

test('the service worker caches every file the shell loads', () => {
  const shell = new Set(shellList());
  const html = read('app/index.html');
  const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((match) => match[1]);
  const manifest = JSON.parse(read('app/manifest.json'));
  for (const icon of manifest.icons) refs.push(icon.src);
  const queue = ['main.js'];
  const seen = new Set();
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const text = read(`app/js/${name}`);
    for (const match of text.matchAll(/from '\.\/([^']+)'/g)) queue.push(match[1]);
  }
  for (const name of seen) refs.push(`./js/${name}`);
  const sw = read('app/sw.js');
  for (const match of sw.matchAll(/importScripts\('(\.\/[^']+)'\)/g)) refs.push(match[1]);
  for (const ref of refs) {
    assert.equal(shell.has(ref), true, `${ref} is missing from the service worker shell`);
    assert.equal(existsSync(join(appDir, ref.slice(2))), true, `${ref} is not on disk`);
  }
  assert.equal(shell.has('./'), true);
  assert.equal(shell.has('./index.html'), true);
});

test('iOS icon PNGs exist at the sizes a home screen needs', () => {
  const expected = {
    'icons/icon-v9-180.png': 180,
    'icons/icon-v9-192.png': 192,
    'icons/icon-v9-512.png': 512,
    'icons/icon-v9-512-maskable.png': 512,
    'icons/icon-v9-32.png': 32,
    'icons/icon-v9-16.png': 16,
  };
  for (const [file, size] of Object.entries(expected)) {
    const png = pngSize(file);
    assert.equal(png.width, size, file);
    assert.equal(png.height, size, file);
    assert.equal(png.colorType, 2, `${file} is opaque RGB`);
  }
  const jpg = readFileSync(join(appDir, 'icons/source/core-sample-icon-source.jpg'));
  assert.equal(jpg.subarray(0, 2).toString('hex'), 'ffd8');
  assert.equal(existsSync(join(appDir, 'icons/favicon-v9.ico')), true);
});

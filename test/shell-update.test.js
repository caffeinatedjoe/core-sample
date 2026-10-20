import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { APP_BUILD } from '../app/js/version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function loadKind() {
  const source = read('app/js/shell-cache.js');
  const sandbox = {};
  vm.runInNewContext(`${source}\nthis.shellRequestKind = shellRequestKind;`, sandbox);
  return sandbox.shellRequestKind;
}

test('the footer build id is the service worker cache name', () => {
  const sw = read('app/sw.js');
  const main = read('app/js/main.js');
  const html = read('app/index.html');
  assert.equal(APP_BUILD, 'core-sample-shell-v9');
  assert.match(sw, new RegExp(`const CACHE = '${APP_BUILD}'`));
  assert.match(html, /id="build-version"/);
  assert.match(main, /import \{ APP_BUILD \} from '\.\/version\.js'/);
  assert.match(main, /getElementById\('build-version'\)/);
  assert.match(main, /build\.textContent = APP_BUILD/);
});

test('shell fetches revalidate the document and scripts and keep icons cached', () => {
  const kind = loadKind();
  assert.equal(kind('./'), 'network-first');
  assert.equal(kind('./index.html'), 'network-first');
  assert.equal(kind('./sw.js'), 'network-first');
  assert.equal(kind('./js/main.js'), 'network-first');
  assert.equal(kind('./js/version.js'), 'network-first');
  assert.equal(kind('./css/app.css'), 'network-first');
  assert.equal(kind('./manifest.json'), 'cache-first');
  assert.equal(kind('./icons/icon-v9-180.png'), 'cache-first');
  assert.equal(kind('./icons/icon-512.png'), 'cache-first');

  const sw = read('app/sw.js');
  const main = read('app/js/main.js');
  const networkFirst = sw.slice(sw.indexOf('async function networkFirst'), sw.indexOf('async function cacheFirst'));
  const fetchAt = networkFirst.indexOf('await fetch(');
  const matchAt = networkFirst.indexOf('cache.match');
  assert.match(sw, /importScripts\('\.\/js\/shell-cache\.js'\)/);
  assert.match(sw, /cache: 'no-cache'/);
  assert.ok(fetchAt !== -1 && matchAt !== -1 && fetchAt < matchAt);
  assert.match(sw, /request\.mode === 'navigate' \|\| shellRequestKind\(name\) === 'network-first'/);
  assert.match(sw, /self\.skipWaiting\(\)/);
  assert.match(sw, /self\.clients\.claim\(\)/);
  assert.match(sw, /client\.navigate\(client\.url\)/);
  assert.match(main, /updateViaCache: 'none'/);
  assert.match(main, /registration\.update\(\)/);
  assert.match(main, /document\.visibilityState === 'visible'/);
  assert.match(main, /window\.location\.reload\(\)/);
  assert.match(main, /searchParams\.has\('shell'\)/);
  assert.match(main, /history\.replaceState/);
});

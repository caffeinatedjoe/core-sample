import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, getFile, openDatabase, putFile } from '../app/js/db.js';
import { fetchRawBytes } from '../app/js/github-api.js';
import { embedImage, loadEmbedBlob, rememberImage } from '../app/js/images.js';

const TOKEN = 'gho_testtokenvalue123456';

function rawResponse(bytes, ok = true) {
  return {
    ok,
    status: ok ? 200 : 404,
    arrayBuffer: async () => bytes,
  };
}

test('a raw image request keeps the token out of the url', async () => {
  let seen = null;
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
  await fetchRawBytes(async (url, options) => {
    seen = { url, options };
    return rawResponse(bytes);
  }, {
    repo: 'owner/repo',
    path: 'assets/Note Name/img.png',
    branch: 'main',
    token: TOKEN,
  });
  assert.equal(seen.url.includes(TOKEN), false);
  assert.equal(seen.url.includes('access_token'), false);
  assert.match(seen.url, /\/contents\/assets\/Note%20Name\/img\.png\?ref=main$/);
  assert.equal(seen.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen.options.headers.Accept, 'application/vnd.github.raw');
  assert.equal(JSON.stringify(seen.options).includes(TOKEN), true);
  const header = seen.options.headers.Authorization;
  const withoutHeader = { ...seen.options, headers: { ...seen.options.headers, Authorization: '' } };
  assert.equal(JSON.stringify(withoutHeader).includes(TOKEN), false);
  assert.equal(header.startsWith('Bearer '), true);
});

test('a cached image loads offline and the src is an object url', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const blob = new Blob([Uint8Array.from([9, 8, 7])], { type: 'image/png' });
  await rememberImage(db, { repo: 'owner/repo', path: 'assets/Note Name/img.png', blob, type: 'image/png' }, 100);
  let called = false;
  const result = await loadEmbedBlob(db, {
    link: 'img.png',
    notePath: 'Weekly.md',
    paths: ['assets/Note Name/img.png', 'short/img.png'],
    attachmentFolderPath: './assets/Note Name',
    repo: 'owner/repo',
    branch: 'main',
    token: TOKEN,
    fetchImpl: async () => {
      called = true;
      throw new Error('offline');
    },
  });
  assert.equal(called, false);
  assert.equal(result.status, 'ready');
  assert.equal(result.path, 'assets/Note Name/img.png');
  const created = [];
  const made = embedImage(result.blob, {
    createObjectURL: (value) => {
      created.push(value);
      return 'blob:preview';
    },
    createElement: () => ({ style: {} }),
    name: result.name,
    type: result.type,
    width: '300',
  });
  assert.equal(made.url, 'blob:preview');
  assert.equal(made.img.src, 'blob:preview');
  assert.equal(made.img.src.includes(TOKEN), false);
  assert.equal(made.img.src.includes('api.github.com'), false);
  assert.equal(made.img.tagName, undefined);
  assert.equal(made.img.className, 'embed-image');
  db.close();
  await deleteDatabase(name);
});

test('svg is a blob image and a miss stays a placeholder without a request url', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const svg = new TextEncoder().encode('<svg><script>alert(1)</script></svg>');
  let requested = '';
  const result = await loadEmbedBlob(db, {
    link: 'diagram.svg',
    notePath: 'Weekly.md',
    paths: ['assets/diagram.svg'],
    repo: 'owner/repo',
    branch: 'main',
    root: '',
    token: TOKEN,
    fetchImpl: async (url) => {
      requested = url;
      return rawResponse(svg.buffer);
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.type, 'image/svg+xml');
  assert.equal(requested.includes(TOKEN), false);
  const made = embedImage(result.blob, {
    createObjectURL: () => 'blob:svg',
    createElement: () => ({ style: {} }),
    name: result.name,
    type: result.type,
  });
  assert.equal(made.img.src, 'blob:svg');
  assert.equal(String(made.img.innerHTML || '').includes('<script>'), false);

  let fetched = false;
  const missing = await loadEmbedBlob(db, {
    link: 'gone.png',
    notePath: 'Weekly.md',
    paths: ['assets/diagram.svg'],
    repo: 'owner/repo',
    token: TOKEN,
    fetchImpl: async () => {
      fetched = true;
      return rawResponse(new ArrayBuffer(0));
    },
  });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.name, 'gone.png');
  assert.equal(fetched, false);
  db.close();
  await deleteDatabase(name);
});

test('the image cache drops the least recently viewed blobs past the limit', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const make = (n) => new Blob([new Uint8Array(8)], { type: 'image/png' });
  await rememberImage(db, { repo: 'owner/repo', path: 'a.png', blob: make(), type: 'image/png', viewedAt: 1 }, 20);
  await rememberImage(db, { repo: 'owner/repo', path: 'b.png', blob: make(), type: 'image/png', viewedAt: 2 }, 20);
  await rememberImage(db, { repo: 'owner/repo', path: 'c.png', blob: make(), type: 'image/png', viewedAt: 3 }, 20);
  const { listImages } = await import('../app/js/db.js');
  const rows = await listImages(db);
  assert.deepEqual(rows.map((row) => row.path).sort(), ['b.png', 'c.png']);
  db.close();
  await deleteDatabase(name);
});

test('adding the image store keeps notes saved by the previous database', async () => {
  const name = `core-sample-${randomUUID()}`;
  await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('files', { keyPath: 'path' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ path: 'Note.md', content: 'keep', kind: 'markdown', updatedAt: 1 });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
  const db = await openDatabase(name);
  const file = await getFile(db, 'Note.md');
  assert.equal(file.content, 'keep');
  assert.equal(db.objectStoreNames.contains('images'), true);
  await putFile(db, file);
  db.close();
  await deleteDatabase(name);
});

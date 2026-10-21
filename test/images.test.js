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

test('a failed image-cache write still returns the downloaded bytes', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function rejectImages(record) {
    if (this.name === 'images') throw new Error('blob store rejected');
    return original.call(this, record);
  };
  try {
    let calls = 0;
    const result = await loadEmbedBlob(db, {
      link: 'image-1710000000000.png',
      notePath: 'Field Notes.md',
      paths: ['assets/Field Notes/image-1710000000000.png'],
      attachmentFolderPath: './assets/Field Notes',
      repo: 'owner/repo',
      branch: 'main',
      token: TOKEN,
      fetchImpl: async () => {
        calls += 1;
        return rawResponse(png.buffer);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'ready');
    assert.equal(result.path, 'assets/Field Notes/image-1710000000000.png');
    assert.equal(result.blob.size, png.byteLength);
  } finally {
    IDBObjectStore.prototype.put = original;
    db.close();
    await deleteDatabase(name);
  }
});

test('a failed viewed-at write still returns the cached image', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const bytes = Uint8Array.from([9, 8, 7, 6]);
  const blob = new Blob([bytes], { type: 'image/png' });
  await rememberImage(db, {
    repo: 'owner/repo',
    path: 'assets/Field Notes/image-1710000000000.png',
    blob,
    type: 'image/png',
  });
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function rejectImages(record) {
    if (this.name === 'images') throw new Error('viewedAt write failed');
    return original.call(this, record);
  };
  try {
    let calls = 0;
    const result = await loadEmbedBlob(db, {
      link: 'image-1710000000000.png',
      notePath: 'Field Notes.md',
      paths: ['assets/Field Notes/image-1710000000000.png'],
      attachmentFolderPath: './assets/Field Notes',
      repo: 'owner/repo',
      branch: 'main',
      token: TOKEN,
      fetchImpl: async () => {
        calls += 1;
        return rawResponse(bytes.buffer);
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.status, 'ready');
    assert.equal(result.blob.size, bytes.byteLength);
  } finally {
    IDBObjectStore.prototype.put = original;
    db.close();
    await deleteDatabase(name);
  }
});

test('an image stored at database version 2 survives a later open of the same database', async () => {
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
      tx.objectStore('files').put({ path: 'Field Notes.md', content: 'keep', kind: 'markdown', updatedAt: 1 });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
  const first = await openDatabase(name);
  const blob = new Blob([Uint8Array.from([4, 5, 6, 7])], { type: 'image/png' });
  await rememberImage(first, {
    repo: 'owner/repo',
    path: 'assets/Field Notes/image-1710000000000.png',
    blob,
    type: 'image/png',
  });
  first.close();
  const second = await openDatabase(name);
  const file = await getFile(second, 'Field Notes.md');
  assert.equal(file.content, 'keep');
  let calls = 0;
  const result = await loadEmbedBlob(second, {
    link: 'image-1710000000000.png',
    notePath: 'Field Notes.md',
    paths: ['assets/Field Notes/image-1710000000000.png'],
    attachmentFolderPath: './assets/Field Notes',
    repo: 'owner/repo',
    branch: 'main',
    token: TOKEN,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('offline');
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, 'ready');
  assert.equal(result.blob.size, blob.size);
  second.close();
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

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteDatabase, getFile, getMeta, listImages, openDatabase, putFile, setMeta } from '../app/js/db.js';
import { fetchRawBytes } from '../app/js/github-api.js';
import { dropStaleVaultIndex, embedImage, imagePayload, loadEmbedBlob, refreshVaultIndex, rememberImage } from '../app/js/images.js';

const TOKEN = 'gho_testtokenvalue123456';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NOTE = 'Field Notes.md';
const IMAGE = 'assets/Field Notes/image-1710000000000.png';
const FOLDER = './assets/Field Notes';

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
  const blob = new Blob([PNG], { type: 'image/png' });
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
  const bytes = PNG;
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
  const blob = new Blob([PNG], { type: 'image/png' });
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

function httpResponse({ status = 200, body = '' } = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(bytes)),
    arrayBuffer: async () => buffer,
  };
}

function vaultFetch({ tree = 'omit', app = true, image = 'png', failTree = false } = {}) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (String(url).includes(TOKEN)) throw new Error('token leaked into the url');
    if (url.includes('/git/trees/')) {
      if (failTree) throw new Error('tree unreachable');
      const files = [
        { path: NOTE, type: 'blob' },
        { path: '.obsidian/app.json', type: 'blob' },
      ];
      if (tree === 'include') files.push({ path: IMAGE, type: 'blob' });
      return httpResponse({
        body: JSON.stringify({
          truncated: tree === 'truncated',
          tree: files,
        }),
      });
    }
    if (url.includes('app.json')) {
      if (!app) return httpResponse({ status: 404, body: 'missing' });
      return httpResponse({ body: '{"attachmentFolderPath":"./assets/Field Notes"}' });
    }
    if (url.includes('image-1710000000000.png')) {
      if (!url.includes('Field%20Notes')) return httpResponse({ status: 404, body: 'missing' });
      if (image === 'missing') return httpResponse({ status: 404, body: 'missing' });
      if (image === 'offline') throw new Error('socket closed');
      if (image === 'html') return httpResponse({ body: '<html>nope</html>' });
      if (image === 'json') {
        return httpResponse({
          body: JSON.stringify({
            encoding: 'base64',
            content: Buffer.from(PNG).toString('base64'),
          }),
        });
      }
      return httpResponse({ body: PNG });
    }
    return httpResponse({ status: 404, body: 'missing' });
  };
  return { seen, fetchImpl };
}

async function loadFromIndex(db, index, fetchImpl, extra = {}) {
  return loadEmbedBlob(db, {
    link: 'image-1710000000000.png',
    notePath: NOTE,
    paths: index.paths,
    attachmentFolderPath: index.attachmentFolderPath,
    repo: 'owner/repo',
    branch: index.branch || 'main',
    root: '',
    token: TOKEN,
    fetchImpl,
    ...extra,
  });
}

function discover(db, fetchImpl, extra = {}) {
  return loadEmbedBlob(db, {
    link: 'image-1710000000000.png',
    notePath: NOTE,
    repo: 'owner/repo',
    branch: 'main',
    root: '',
    token: TOKEN,
    fetchImpl,
    ...extra,
  });
}

test('a root note downloads a bare filename from a spaced attachment folder the file list omitted', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const { seen, fetchImpl } = vaultFetch({ tree: 'truncated' });
  const result = await discover(db, fetchImpl);
  assert.equal(result.status, 'ready');
  assert.equal(result.path, IMAGE);
  assert.equal(result.blob.size, PNG.byteLength);
  const imageUrl = seen.find((url) => url.includes('Field%20Notes') && url.includes('image-1710000000000.png'));
  assert.match(imageUrl, /\/contents\/assets\/Field%20Notes\/image-1710000000000\.png\?ref=main$/);
  assert.equal(imageUrl.includes('%2520'), false);
  assert.equal(imageUrl.includes(TOKEN), false);
  const saved = await getMeta(db, 'githubVaultIndex');
  assert.equal(saved.paths.includes(IMAGE), false);
  assert.equal(saved.attachmentFolderPath, FOLDER);
  assert.equal(typeof saved.fetchedAt, 'number');
  assert.equal(saved.truncated, true);
  db.close();
  await deleteDatabase(name);
});

test('a failed tree does not save an empty index and a direct request can still find the image', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const { fetchImpl, seen } = vaultFetch({ failTree: true });
  const result = await discover(db, fetchImpl);
  assert.equal(result.status, 'ready');
  assert.equal(result.path, IMAGE);
  assert.equal(await getMeta(db, 'githubVaultIndex'), undefined);
  assert.ok(seen.some((url) => url.includes('/contents/assets/Field%20Notes/')));
  assert.equal(seen.some((url) => url.includes(TOKEN)), false);
  db.close();
  await deleteDatabase(name);
});

test('a failed download is not cached and the next attempt tries again', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  let calls = 0;
  const missing = vaultFetch({ tree: 'include', image: 'missing' });
  const index = await refreshVaultIndex(db, {
    repo: 'owner/repo',
    branch: 'main',
    root: '',
    token: TOKEN,
  }, missing.fetchImpl);
  const first = await loadFromIndex(db, index, async (url) => {
    if (url.includes('image-1710000000000.png')) calls += 1;
    return missing.fetchImpl(url);
  });
  assert.equal(first.status, 'error');
  assert.equal(first.reason, "Couldn't reach GitHub (HTTP 404)");
  assert.equal(first.reason.includes(TOKEN), false);
  assert.equal(first.reason.includes('api.github.com'), false);
  assert.equal((await listImages(db)).length, 0);
  const second = await loadFromIndex(db, index, async (url) => {
    if (url.includes('image-1710000000000.png')) calls += 1;
    return missing.fetchImpl(url);
  });
  assert.equal(second.reason, "Couldn't reach GitHub (HTTP 404)");
  assert.equal(calls, 2);

  const offline = await loadFromIndex(db, index, async () => {
    throw new Error('socket closed');
  });
  assert.equal(offline.reason, "Couldn't reach GitHub (offline)");
  assert.equal((await listImages(db)).length, 0);
  const again = await loadFromIndex(db, index, async () => httpResponse({ body: PNG }), { fresh: true });
  assert.equal(again.status, 'ready');
  assert.equal(again.blob.size, PNG.byteLength);
  db.close();
  await deleteDatabase(name);
});

test('an unsupported image is named and never requested', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  let called = false;
  const result = await loadEmbedBlob(db, {
    link: 'photo.heic',
    notePath: NOTE,
    paths: ['assets/Field Notes/photo.heic'],
    attachmentFolderPath: FOLDER,
    repo: 'owner/repo',
    branch: 'main',
    token: TOKEN,
    fetchImpl: async () => {
      called = true;
      return httpResponse({ body: PNG });
    },
  });
  assert.equal(called, false);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'Unsupported format');
  db.close();
  await deleteDatabase(name);
});

test('a json contents body is decoded once and a non-image is not stored', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const decoded = imagePayload(new TextEncoder().encode(JSON.stringify({
    encoding: 'base64',
    content: Buffer.from(PNG).toString('base64'),
  })));
  assert.equal(decoded.length, PNG.byteLength);
  const jsonVault = vaultFetch({ tree: 'include', image: 'json' });
  const index = await refreshVaultIndex(db, {
    repo: 'owner/repo',
    branch: 'main',
    root: '',
    token: TOKEN,
  }, jsonVault.fetchImpl);
  const ready = await loadFromIndex(db, index, jsonVault.fetchImpl);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.blob.size, PNG.byteLength);
  assert.equal(ready.blob.type, 'image/png');

  let junkCalls = 0;
  const junk = await loadFromIndex(db, index, async () => {
    junkCalls += 1;
    return httpResponse({ body: 'not an image' });
  }, { fresh: true });
  assert.equal(junk.reason, "Couldn't display");
  assert.equal(junk.reason.includes(TOKEN), false);
  const rows = await listImages(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, IMAGE);

  await rememberImage(db, {
    repo: 'owner/repo',
    path: IMAGE,
    blob: new Blob(['not an image'], { type: 'image/png' }),
    type: 'image/png',
  });
  let repaired = 0;
  const fixed = await loadFromIndex(db, index, async () => {
    repaired += 1;
    return httpResponse({ body: PNG });
  });
  assert.equal(repaired, 1);
  assert.equal(fixed.status, 'ready');
  assert.equal(fixed.blob.size, PNG.byteLength);
  assert.equal(junkCalls, 1);
  db.close();
  await deleteDatabase(name);
});

function accessFetch(mode) {
  const seen = [];
  const fetchImpl = async (url) => {
    const text = String(url);
    seen.push(text);
    if (text.includes(TOKEN)) throw new Error('token leaked into the url');
    if (mode() === 'denied') return httpResponse({ status: 404, body: '{"message":"Not Found"}' });
    if (mode() === 'unauthorized') return httpResponse({ status: 401, body: '{"message":"Bad credentials"}' });
    if (text.includes('/git/trees/')) {
      return httpResponse({
        body: JSON.stringify({
          sha: 'tree123',
          truncated: false,
          tree: [
            { path: NOTE, type: 'blob' },
            { path: '.obsidian/app.json', type: 'blob' },
            { path: IMAGE, type: 'blob' },
          ],
        }),
      });
    }
    if (text.includes('app.json')) return httpResponse({ body: '{"attachmentFolderPath":"./assets/Field Notes"}' });
    if (text.includes('Field%20Notes') && text.includes('image-1710000000000.png')) return httpResponse({ body: PNG });
    return httpResponse({ status: 404, body: 'missing' });
  };
  return { seen, fetchImpl };
}

test('a repo 404 does not stick, and the same note loads after the token can read the vault', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  let mode = 'denied';
  const { seen, fetchImpl } = accessFetch(() => mode);
  const first = await discover(db, fetchImpl);
  assert.equal(first.reason, 'No access to repo');
  assert.equal(first.reason.includes(TOKEN), false);
  assert.equal(await getMeta(db, 'githubVaultIndex'), undefined);
  assert.equal((await listImages(db)).length, 0);
  mode = 'ok';
  const second = await discover(db, fetchImpl);
  assert.equal(second.status, 'ready');
  assert.equal(second.path, IMAGE);
  const saved = await getMeta(db, 'githubVaultIndex');
  assert.equal(typeof saved.fetchedAt, 'number');
  assert.equal(saved.treeSha, 'tree123');
  assert.equal(saved.paths.includes(IMAGE), true);
  assert.equal(seen.some((url) => url.includes(TOKEN)), false);
  db.close();
  await deleteDatabase(name);
});

test('a 401 from the file list names the HTTP status and does not save a file list', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  const { fetchImpl } = accessFetch(() => 'unauthorized');
  const result = await discover(db, fetchImpl);
  assert.equal(result.reason, "Couldn't reach GitHub (HTTP 401)");
  assert.equal(result.reason.includes(TOKEN), false);
  assert.equal(await getMeta(db, 'githubVaultIndex'), undefined);
  assert.equal((await listImages(db)).length, 0);
  db.close();
  await deleteDatabase(name);
});

test('a leftover empty file list is deleted and the image cache stays', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await setMeta(db, 'githubVaultIndex', {
    repo: 'owner/repo',
    branch: 'main',
    root: '',
    paths: [],
    attachmentFolderPath: '',
    attachmentChecked: true,
  });
  await rememberImage(db, {
    repo: 'owner/repo',
    path: IMAGE,
    blob: new Blob([PNG], { type: 'image/png' }),
    type: 'image/png',
  });
  assert.equal(await dropStaleVaultIndex(db), true);
  assert.equal(await getMeta(db, 'githubVaultIndex'), undefined);
  assert.equal((await listImages(db)).length, 1);
  const { fetchImpl } = accessFetch(() => 'ok');
  const result = await discover(db, fetchImpl);
  assert.equal(result.status, 'ready');
  assert.equal(result.path, IMAGE);
  db.close();
  await deleteDatabase(name);
});

test('a v15 file list without a fetch time is rebuilt instead of trusted', async () => {
  const name = `core-sample-${randomUUID()}`;
  const db = await openDatabase(name);
  await setMeta(db, 'githubVaultIndex', {
    repo: 'owner/repo',
    branch: 'main',
    root: '',
    paths: [NOTE, '.obsidian/app.json'],
    attachmentFolderPath: FOLDER,
  });
  const { fetchImpl, seen } = accessFetch(() => 'ok');
  const result = await discover(db, fetchImpl);
  assert.equal(result.status, 'ready');
  assert.equal(result.path, IMAGE);
  const saved = await getMeta(db, 'githubVaultIndex');
  assert.equal(typeof saved.fetchedAt, 'number');
  assert.equal(saved.paths.includes(IMAGE), true);
  assert.ok(seen.some((url) => url.includes('/git/trees/')));
  assert.equal(await dropStaleVaultIndex(db), false);
  db.close();
  await deleteDatabase(name);
});

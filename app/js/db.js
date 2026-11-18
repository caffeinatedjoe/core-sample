const DB_VERSION = 3;

function run(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let request;
    try {
      request = fn(tx.objectStore(storeName));
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB request failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export function openDatabase(name = 'core-sample') {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('files')) {
        const files = db.createObjectStore('files', { keyPath: 'path' });
        files.createIndex('byUpdated', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('ops')) {
        db.createObjectStore('ops', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the notes database'));
  });
}

export function putFile(db, file) {
  if (!file || typeof file.path !== 'string' || !file.path) {
    return Promise.reject(new Error('A note needs a path.'));
  }
  return run(db, 'files', 'readwrite', (store) => store.put(file));
}

// Editor saves own the text. Sync owns SHAs and conflict fields. A snapshot
// taken before an acknowledgement must not restore the old base.
export function mergeLocalSave(stored, snapshot) {
  if (!stored) return { ...snapshot };
  return {
    ...stored,
    content: snapshot.content,
    dirty: snapshot.dirty === true,
    updatedAt: snapshot.updatedAt,
    kind: snapshot.kind || stored.kind,
    encoding: snapshot.encoding || stored.encoding,
  };
}

export function updateFile(db, path, decide) {
  if (typeof path !== 'string' || !path) {
    return Promise.reject(new Error('A note needs a path.'));
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    const request = store.get(path);
    let next;
    request.onsuccess = () => {
      try {
        next = decide(request.result);
        if (next) {
          if (typeof next.path !== 'string' || !next.path) {
            throw new Error('A note needs a path.');
          }
          store.put(next);
        }
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    tx.oncomplete = () => resolve(next);
    tx.onerror = () => reject(tx.error || new Error('Could not save notes'));
    tx.onabort = () => reject(tx.error || new Error('Could not save notes'));
  });
}

export function saveLocalFile(db, snapshot) {
  if (!snapshot || typeof snapshot.path !== 'string' || !snapshot.path) {
    return Promise.reject(new Error('A note needs a path.'));
  }
  return updateFile(db, snapshot.path, (stored) => mergeLocalSave(stored, snapshot));
}

export function getFile(db, path) {
  return run(db, 'files', 'readonly', (store) => store.get(path));
}

export function listFiles(db) {
  return run(db, 'files', 'readonly', (store) => store.getAll());
}

export function setMeta(db, key, value) {
  return run(db, 'meta', 'readwrite', (store) => store.put({ key, value }));
}

export function getMeta(db, key) {
  return run(db, 'meta', 'readonly', (store) => store.get(key)).then((row) => (row ? row.value : undefined));
}

export function deleteMeta(db, key) {
  return run(db, 'meta', 'readwrite', (store) => store.delete(key));
}

// Reads `keys` and writes what `decide` returns in one readwrite transaction,
// so no other tab or reload can write between the read and the write.
// `decide(values)` returns `{ key: value }` pairs to put, or null to write nothing.
export function updateMeta(db, keys, decide) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    const store = tx.objectStore('meta');
    const values = {};
    let writes = null;
    let left = keys.length;
    const apply = () => {
      try {
        writes = decide(values) || null;
        for (const [key, value] of Object.entries(writes || {})) store.put({ key, value });
      } catch (error) {
        writes = null;
        tx.abort();
        reject(error);
      }
    };
    try {
      if (!left) apply();
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => {
          values[key] = request.result ? request.result.value : undefined;
          left -= 1;
          if (!left) apply();
        };
      }
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(writes);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB request failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export function commitFiles(db, { put = [], remove = [] } = {}) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    try {
      for (const path of remove) store.delete(path);
      for (const file of put) {
        if (!file || typeof file.path !== 'string' || !file.path) {
          throw new Error('A note needs a path.');
        }
        store.put(file);
      }
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Could not save notes'));
    tx.onabort = () => reject(tx.error || new Error('Could not save notes'));
  });
}

export function getImage(db, key) {
  return run(db, 'images', 'readonly', (store) => store.get(key));
}

export function putImage(db, record) {
  return run(db, 'images', 'readwrite', (store) => store.put(record));
}

export function listImages(db) {
  return run(db, 'images', 'readonly', (store) => store.getAll());
}

export function putOp(db, op) {
  if (!op || typeof op.id !== 'string' || !op.id) {
    return Promise.reject(new Error('A sync operation needs an id.'));
  }
  return run(db, 'ops', 'readwrite', (store) => store.put(op));
}

export function listOps(db) {
  return run(db, 'ops', 'readonly', (store) => store.getAll());
}

export function deleteOps(db, ids) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('ops', 'readwrite');
    const store = tx.objectStore('ops');
    try {
      for (const id of ids) store.delete(id);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Could not update the sync queue'));
    tx.onabort = () => reject(tx.error || new Error('Could not update the sync queue'));
  });
}

export function deleteImages(db, keys) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images', 'readwrite');
    const store = tx.objectStore('images');
    try {
      for (const key of keys) store.delete(key);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Could not update the image cache'));
    tx.onabort = () => reject(tx.error || new Error('Could not update the image cache'));
  });
}

export function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

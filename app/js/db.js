const DB_VERSION = 1;

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

export function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

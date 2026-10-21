import { deleteImages, deleteMeta, getImage, getMeta, listFiles, listImages, putImage, setMeta } from './db.js';
import {
  basename,
  decodePath,
  embedCandidates,
  imageKind,
  listImageEmbeds,
  mimeFor,
  normalizeVaultPath,
  readAttachmentSetting,
  resolveEmbedPath,
} from './embeds.js';
import {
  fetchRawBytes,
  githubRequest,
  githubStatusReason,
  listVaultEntries,
  lookupRepository,
  repoPath,
  treeUrl,
} from './github-api.js';
import { loadGithubSettings, recordStoragePersistence } from './github-store.js';

export const OFFLINE_IMAGE_REASON = 'Not downloaded yet (offline)';
export const PREFETCH_CONCURRENCY = 3;
export const INDEX_TTL = 10 * 60 * 1000;
const INDEX_KEY = 'githubVaultIndex';
const RESOLVED_KEY = 'githubResolvedEmbeds';
const PREFETCH_KEY = 'imagePrefetch';
const treeFlights = new Map();
let prefetchChain = Promise.resolve();

function cacheKey(repo, path) {
  return `${repo}\n${path}`;
}

async function copyBytes(value) {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  if (typeof value.arrayBuffer === 'function') {
    const buffer = await value.arrayBuffer();
    return buffer.slice(0);
  }
  return null;
}

function hasStoredBytes(row) {
  if (!row) return false;
  if (row.data instanceof ArrayBuffer && row.data.byteLength > 0) return true;
  if (ArrayBuffer.isView(row.data) && row.data.byteLength > 0) return true;
  if (row.blob && Number(row.blob.size) > 0) return true;
  return false;
}

// Bytes only. A Blob read back from IndexedDB must never be written again:
// WebKit invalidates that handle for the rest of the session.
export async function rememberImage(db, { repo = '', path, blob, data, type, viewedAt = Date.now(), sha = '' } = {}) {
  const bytes = await copyBytes(data || blob);
  if (!bytes) throw new Error('An image needs bytes.');
  const record = {
    key: cacheKey(repo, path),
    repo,
    path,
    data: bytes,
    bytes: bytes.byteLength,
    type: type || (blob && blob.type) || '',
    viewedAt,
    sha: typeof sha === 'string' ? sha : '',
  };
  await putImage(db, record);
  return record;
}

// A blob named by a note stays. Only a blob no note still points at is removed.
export async function pruneUnreferencedImages(db, repo, referencedPaths) {
  const keep = new Set(referencedPaths || []);
  const rows = await listImages(db);
  const drop = [];
  for (const row of rows) {
    if (!row || row.repo !== repo) continue;
    if (keep.has(row.path)) continue;
    drop.push(row.key);
  }
  if (drop.length) await deleteImages(db, drop);
  return drop.length;
}

async function readStoredBytes(row) {
  if (!row) return null;
  if (row.data instanceof ArrayBuffer || ArrayBuffer.isView(row.data)) return copyBytes(row.data);
  if (row.blob) return copyBytes(row.blob);
  return null;
}

async function migrateImageBytes(db, row, bytes) {
  if (!row || !row.blob || row.data) return;
  try {
    await putImage(db, {
      key: row.key,
      repo: row.repo || '',
      path: row.path || '',
      data: bytes,
      bytes: bytes.byteLength,
      type: row.type || '',
      sha: typeof row.sha === 'string' ? row.sha : '',
      viewedAt: row.viewedAt || 0,
    });
  } catch {
    // The copied bytes can still be shown. The old record stays.
  }
}

// Read only. A view does not write the record. Last-viewed is not stored:
// a referenced image is never evicted, so there is no least-recently-viewed list.
export async function cachedImage(db, repo, path) {
  const key = cacheKey(repo, path);
  const load = async () => {
    const row = await getImage(db, key);
    if (!row || !hasStoredBytes(row)) return null;
    const bytes = await readStoredBytes(row);
    if (!bytes || !bytes.byteLength) return null;
    return { row, bytes };
  };
  let loaded = null;
  try {
    loaded = await load();
  } catch {
    try {
      loaded = await load();
    } catch {
      return { key, repo, path, unreadable: true };
    }
  }
  if (!loaded) return null;
  await migrateImageBytes(db, loaded.row, loaded.bytes);
  return {
    key,
    repo: loaded.row.repo || repo,
    path: loaded.row.path || path,
    data: loaded.bytes,
    bytes: loaded.bytes.byteLength,
    type: loaded.row.type || '',
    sha: typeof loaded.row.sha === 'string' ? loaded.row.sha : '',
  };
}

function blankIndex(settings, extra = {}) {
  return {
    ok: false,
    repo: settings.repo || '',
    branch: settings.branch || '',
    root: settings.root || '',
    paths: [],
    attachmentFolderPath: '',
    fetchedAt: 0,
    treeSha: '',
    truncated: false,
    shas: {},
    status: 0,
    reason: githubStatusReason(0),
    fromCache: false,
    ...extra,
  };
}

function samePlace(saved, settings) {
  return Boolean(saved)
    && saved.repo === settings.repo
    && (saved.root || '') === (settings.root || '')
    && (!settings.branch || saved.branch === settings.branch);
}

export function indexIsUsable(saved, settings, now = Date.now()) {
  if (!samePlace(saved, settings)) return false;
  if (typeof saved.fetchedAt !== 'number' || saved.fetchedAt <= 0) return false;
  if (!Array.isArray(saved.paths)) return false;
  if (now - saved.fetchedAt > INDEX_TTL) return false;
  return true;
}

// A v18 failure was stored as an empty list and then trusted forever.
// Drop that, and any older list that has no fetch time. Leave image blobs alone.
export async function dropStaleVaultIndex(db) {
  const saved = await getMeta(db, INDEX_KEY);
  if (!saved) return false;
  const empty = !Array.isArray(saved.paths) || saved.paths.length === 0;
  const unstamped = typeof saved.fetchedAt !== 'number' || saved.fetchedAt <= 0;
  if (!empty && !unstamped) return false;
  await deleteMeta(db, INDEX_KEY);
  return true;
}

async function readAttachmentFolder(fetchImpl, settings, branch) {
  try {
    const file = await fetchRawBytes(fetchImpl, {
      repo: settings.repo,
      path: repoPath(settings.root, '.obsidian/app.json'),
      branch,
      token: settings.token,
    });
    return { folder: readAttachmentSetting(new TextDecoder().decode(file.bytes)), status: 200 };
  } catch (error) {
    return { folder: '', status: Number(error && error.status) || 0 };
  }
}

export async function refreshVaultIndex(db, settings, fetchImpl, now = Date.now()) {
  let branch = settings.branch;
  if (!branch) {
    try {
      const repo = await lookupRepository(fetchImpl, { repo: settings.repo, token: settings.token });
      branch = repo.defaultBranch;
    } catch (error) {
      return blankIndex(settings, {
        status: Number(error && error.status) || 0,
        reason: githubStatusReason(Number(error && error.status) || 0, { missingRepo: true }),
      });
    }
  }
  let listed;
  try {
    listed = await githubRequest(fetchImpl, treeUrl(settings.repo, branch), {
      token: settings.token,
      secrets: [settings.token],
    });
  } catch {
    return blankIndex(settings, { branch, reason: githubStatusReason(0) });
  }
  if (!listed.ok) {
    return blankIndex(settings, {
      branch,
      status: listed.status || 0,
      reason: githubStatusReason(listed.status || 0, { missingRepo: true }),
    });
  }
  let entries = [];
  try {
    entries = listVaultEntries(listed.body, settings.root, { allowTruncated: true });
  } catch {
    return blankIndex(settings, { branch, reason: githubStatusReason(0) });
  }
  const paths = entries.map((entry) => entry.path);
  const shas = {};
  for (const entry of entries) {
    if (entry.sha) shas[entry.path] = entry.sha;
  }
  const folderRead = await readAttachmentFolder(fetchImpl, settings, branch);
  if (folderRead.status === 401) {
    return blankIndex(settings, { branch, status: 401, reason: githubStatusReason(401) });
  }
  const index = {
    ok: true,
    repo: settings.repo,
    branch,
    root: settings.root || '',
    paths,
    shas,
    attachmentFolderPath: folderRead.folder,
    fetchedAt: now,
    treeSha: listed.body && typeof listed.body.sha === 'string' ? listed.body.sha : '',
    truncated: Boolean(listed.body && listed.body.truncated),
    status: 200,
    reason: '',
    fromCache: false,
  };
  try {
    await setMeta(db, INDEX_KEY, index);
  } catch {
    // This view can still use the list when it will not store.
  }
  return index;
}

function flightKey(settings) {
  return `${settings.repo || ''}\n${settings.branch || ''}\n${settings.root || ''}`;
}

function sharedRefresh(db, settings, fetchImpl, now) {
  const key = flightKey(settings);
  const existing = treeFlights.get(key);
  if (existing) return existing;
  const promise = refreshVaultIndex(db, settings, fetchImpl, now).finally(() => {
    if (treeFlights.get(key) === promise) treeFlights.delete(key);
  });
  treeFlights.set(key, promise);
  return promise;
}

export async function vaultIndexFor(db, settings, fetchImpl, { fresh = false, now = Date.now() } = {}) {
  let saved = await getMeta(db, INDEX_KEY);
  if (saved && (typeof saved.fetchedAt !== 'number' || saved.fetchedAt <= 0)) {
    try {
      await deleteMeta(db, INDEX_KEY);
    } catch {
      // A failed delete still must not treat the old list as current.
    }
    saved = undefined;
  }
  if (!fresh && indexIsUsable(saved, settings, now)) return { ...saved, ok: true, fromCache: true, status: 200, reason: '' };
  if (!settings.token || !settings.repo || !fetchImpl) {
    return blankIndex(settings, { status: 401, reason: 'Sign in again' });
  }
  return sharedRefresh(db, settings, fetchImpl, now);
}

function resolvedLinkKey(notePath, link) {
  return `${notePath}\n${link}`;
}

function pathLinkKey(path) {
  return `path\n${path}`;
}

function offlineNow(options = {}) {
  if (options.offline === true) return true;
  const nav = globalThis.navigator;
  return Boolean(nav && nav.onLine === false);
}

function isTransportOffline(result) {
  if (!result || result.status === 'ready') return false;
  if (result.fileStatus === 0) return true;
  return result.reason === "Couldn't reach GitHub (offline)";
}

function present(result, name) {
  if (!result) return { status: 'missing', name, reason: OFFLINE_IMAGE_REASON };
  if (!isTransportOffline(result)) return result;
  return {
    status: 'missing',
    name: result.name || name,
    path: result.path,
    reason: OFFLINE_IMAGE_REASON,
  };
}

async function rememberedEmbedPath(db, settings, notePath, link) {
  const saved = await getMeta(db, RESOLVED_KEY);
  if (!saved || !samePlace(saved, settings)) return '';
  const path = saved.links && saved.links[resolvedLinkKey(notePath, link)];
  return typeof path === 'string' ? path : '';
}

async function rememberEmbedPath(db, settings, notePath, link, path) {
  if (!path) return;
  const saved = await getMeta(db, RESOLVED_KEY);
  const links = saved && samePlace(saved, settings) && saved.links ? { ...saved.links } : {};
  const noteKey = resolvedLinkKey(notePath, link);
  const vaultKey = pathLinkKey(path);
  if (links[noteKey] === path && links[vaultKey] === path) return;
  links[noteKey] = path;
  links[vaultKey] = path;
  try {
    await setMeta(db, RESOLVED_KEY, {
      repo: settings.repo,
      branch: settings.branch || '',
      root: settings.root || '',
      links,
    });
  } catch {
    // The next view can resolve this path again.
  }
}

async function forgetEmbedPath(db, settings, notePath, link) {
  const saved = await getMeta(db, RESOLVED_KEY);
  if (!saved || !saved.links) return;
  const key = resolvedLinkKey(notePath, link);
  const path = saved.links[key];
  if (!path) return;
  const links = { ...saved.links };
  delete links[key];
  if (links[pathLinkKey(path)] === path) delete links[pathLinkKey(path)];
  try {
    await setMeta(db, RESOLVED_KEY, { ...saved, links });
  } catch {
    // A stale remembered path is dropped again when it 404s.
  }
}

function decodeBase64Bytes(value) {
  const clean = String(value || '').replace(/\s/g, '');
  if (!clean) return null;
  let binary = '';
  try {
    binary = atob(clean);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function imageMagic(bytes) {
  if (!bytes || bytes.length < 3) return false;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return true;
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return true;
  const head = new TextDecoder().decode(bytes.slice(0, 256)).trimStart().toLowerCase();
  return head.startsWith('<svg') || head.startsWith('<?xml');
}

// The raw media type is the file itself. A JSON contents body is the same
// file in base64. Anything else is not an image and must not be cached.
export function imagePayload(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  if (imageMagic(bytes)) return bytes;
  if (bytes[0] !== 0x7b) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || body.encoding !== 'base64' || typeof body.content !== 'string') return null;
    const decoded = decodeBase64Bytes(body.content);
    if (decoded && imageMagic(decoded)) return decoded;
  } catch {
    return null;
  }
  return null;
}

function readyBlob(path, payload, typeHint, storedType) {
  const type = storedType || typeHint || mimeFor(path);
  return {
    status: 'ready',
    name: basename(path),
    path,
    blob: new Blob([payload], { type }),
    type,
  };
}

async function cachedReady(db, repo, path) {
  let hit = null;
  try {
    hit = await cachedImage(db, repo, path);
  } catch {
    hit = { unreadable: true };
  }
  if (!hit) return null;
  if (hit.unreadable) return null;
  let payload = null;
  try {
    payload = imagePayload(hit.data);
  } catch {
    payload = null;
  }
  // A read that fails, or bytes that are not an image, stays stored.
  // The only delete is the unreferenced prune. An online miss overwrites this key.
  if (payload) return readyBlob(path, payload, mimeFor(path), hit.type || '');
  return null;
}

// A file 404 means try another path. 401 and transport failures stop the search.
async function downloadEmbed(db, { repo, path, branch, root, token, fetchImpl, sha = '' }) {
  const type = mimeFor(path);
  let file;
  try {
    file = await fetchRawBytes(fetchImpl, {
      repo,
      path: repoPath(root, path),
      branch,
      token,
    });
  } catch (error) {
    const status = Number(error && error.status) || 0;
    if (status === 404) {
      return { status: 'error', fileStatus: 404, path, name: basename(path), reason: githubStatusReason(404) };
    }
    return {
      status: 'error',
      fileStatus: status,
      path,
      name: basename(path),
      reason: githubStatusReason(status),
    };
  }
  const payload = imagePayload(file.bytes);
  if (!payload) return { status: 'error', fileStatus: 200, path, name: basename(path), reason: "Couldn't display" };
  const ready = readyBlob(path, payload, type);
  try {
    await rememberImage(db, { repo, path, blob: ready.blob, type: ready.type, sha });
  } catch {
    // The download can still be shown when IndexedDB rejects the blob.
  }
  return ready;
}

async function loadListedEmbed(db, options) {
  const {
    link,
    notePath = '',
    paths = [],
    attachmentFolderPath = '',
    repo = '',
    branch = '',
    root = '',
    token = '',
    fetchImpl,
    fresh = false,
    name,
  } = options;
  const resolved = resolveEmbedPath(link, { notePath, paths, attachmentFolderPath });
  if (!resolved) return { status: 'missing', name, reason: 'Not found in vault' };
  if (!fresh) {
    const cached = await cachedReady(db, repo, resolved);
    if (cached) return cached;
  }
  if (!token || !repo || !fetchImpl) return { status: 'error', name, path: resolved, reason: 'Sign in again' };
  return downloadEmbed(db, { repo, path: resolved, branch, root, token, fetchImpl });
}

async function probeCandidates(db, options, folder, remembered) {
  const {
    link,
    notePath = '',
    repo = '',
    branch = '',
    root = '',
    token = '',
    fetchImpl,
    fresh = false,
    name,
  } = options;
  const settings = { repo, branch, root, token };
  let attachmentFolderPath = folder || '';
  if (!attachmentFolderPath) {
    const read = await readAttachmentFolder(fetchImpl, settings, branch);
    if (read.status === 401) return { status: 'error', name, reason: githubStatusReason(401) };
    attachmentFolderPath = read.folder;
  }
  const candidates = [];
  const add = (path) => {
    if (path && !candidates.includes(path)) candidates.push(path);
  };
  add(remembered);
  for (const path of embedCandidates(link, { notePath, attachmentFolderPath })) add(path);
  let transport = null;
  for (const path of candidates) {
    if (!fresh) {
      const cached = await cachedReady(db, repo, path);
      if (cached) {
        await rememberEmbedPath(db, settings, notePath, link, path);
        return cached;
      }
    }
    const downloaded = await downloadEmbed(db, { repo, path, branch, root, token, fetchImpl });
    if (downloaded.status === 'ready') {
      await rememberEmbedPath(db, settings, notePath, link, path);
      return downloaded;
    }
    if (downloaded.fileStatus === 404) {
      if (path === remembered) await forgetEmbedPath(db, settings, notePath, link);
      continue;
    }
    if (downloaded.reason === "Couldn't display") return downloaded;
    transport = downloaded;
    if (downloaded.fileStatus === 401) return downloaded;
  }
  return transport;
}

async function discoverEmbed(db, options) {
  const {
    link,
    notePath = '',
    repo = '',
    branch = '',
    root = '',
    token = '',
    fetchImpl,
    fresh = false,
    name,
  } = options;
  const settings = { repo, branch, root, token };
  if (!token || !repo || !fetchImpl) return { status: 'error', name, reason: 'Sign in again' };
  const remembered = fresh ? '' : await rememberedEmbedPath(db, settings, notePath, link);
  let index = await vaultIndexFor(db, settings, fetchImpl, { fresh });

  if (!index.ok) {
    if (index.status === 401 || index.status === 404) return { status: 'error', name, reason: index.reason };
    const probed = await probeCandidates(db, options, index.attachmentFolderPath || '', remembered);
    if (probed && (probed.status === 'ready' || probed.reason)) return probed;
    return { status: 'error', name, reason: index.reason || githubStatusReason(index.status) };
  }

  const useRemembered = async (path) => {
    if (!path) return null;
    if (!fresh) {
      const cached = await cachedReady(db, repo, path);
      if (cached) return cached;
    }
    const downloaded = await downloadEmbed(db, {
      repo,
      path,
      branch: index.branch || branch,
      root,
      token,
      fetchImpl,
      sha: (index.shas && index.shas[path]) || '',
    });
    if (downloaded.status === 'ready') {
      await rememberEmbedPath(db, settings, notePath, link, path);
      return downloaded;
    }
    if (downloaded.fileStatus === 404) {
      await forgetEmbedPath(db, settings, notePath, link);
      return null;
    }
    return downloaded;
  };

  const fromMemory = await useRemembered(remembered);
  if (fromMemory) return fromMemory;

  let resolved = resolveEmbedPath(link, {
    notePath,
    paths: index.paths,
    attachmentFolderPath: index.attachmentFolderPath || '',
  });
  if (!resolved && index.fromCache) {
    const again = await vaultIndexFor(db, settings, fetchImpl, { fresh: true });
    if (again.ok && (again.treeSha !== index.treeSha || again.truncated !== index.truncated)) {
      index = again;
      resolved = resolveEmbedPath(link, {
        notePath,
        paths: index.paths,
        attachmentFolderPath: index.attachmentFolderPath || '',
      });
    } else if (!again.ok) {
      return { status: 'error', name, reason: again.reason };
    }
  }
  if (resolved) {
    const loaded = await useRemembered(resolved);
    if (loaded) return loaded;
  }
  if (index.ok && !index.truncated) return { status: 'missing', name, reason: 'Not found in vault' };
  const probed = await probeCandidates(db, options, index.attachmentFolderPath || '', '');
  if (probed && (probed.status === 'ready' || probed.reason)) return probed;
  if (index.truncated) return { status: 'error', name, reason: 'The vault listing was cut off' };
  return { status: 'missing', name, reason: 'Not found in vault' };
}

async function linkMap(db, settings) {
  const saved = await getMeta(db, RESOLVED_KEY);
  if (!saved || !samePlace(saved, settings) || !saved.links) return {};
  return saved.links;
}

// Local only. The map is checked by note plus embed text, and by vault path.
// A saved file list is used even when it is older than the refresh window.
async function readLocalEmbed(db, options) {
  const {
    link,
    notePath = '',
    repo = '',
    branch = '',
    root = '',
    token = '',
    paths,
    attachmentFolderPath = '',
  } = options;
  const settings = { repo, branch, root, token };
  const links = await linkMap(db, settings);
  const candidates = [];
  const add = (path) => {
    const normal = typeof path === 'string' ? normalizeVaultPath(path) : '';
    if (!normal || candidates.includes(normal)) return;
    candidates.push(normal);
  };
  add(links[resolvedLinkKey(notePath, link)]);
  const written = normalizeVaultPath(decodePath(link));
  add(links[pathLinkKey(written)]);
  let folder = attachmentFolderPath || '';
  let list = Array.isArray(paths) ? paths : null;
  if (!list) {
    const index = await getMeta(db, INDEX_KEY);
    if (index && samePlace(index, settings) && Array.isArray(index.paths)) {
      list = index.paths;
      if (!folder) folder = index.attachmentFolderPath || '';
    }
  }
  if (list) add(resolveEmbedPath(link, { notePath, paths: list, attachmentFolderPath: folder }));
  add(written);
  for (const path of candidates) {
    const cached = await cachedReady(db, repo, path);
    if (!cached) continue;
    await rememberEmbedPath(db, settings, notePath, link, cached.path || path);
    return cached;
  }
  return null;
}

// Reads one image. A saved blob is returned before any network request.
// The returned blob is what an <img> may display; callers must not put the
// request URL in src. Passing `paths` resolves only against that list.
// Omitting it looks the file up: the saved map, then likely paths, then one tree.
export async function loadEmbedBlob(db, options = {}) {
  const name = basename(options.link);
  const kind = imageKind(options.link);
  if (kind === 'unsupported') return { status: 'unsupported', name, reason: 'Unsupported format' };
  if (!kind) return { status: 'missing', name, reason: 'Not found in vault' };
  let local = null;
  try {
    local = await readLocalEmbed(db, options);
  } catch {
    local = null;
  }
  if (local && (!options.fresh || offlineNow(options))) return local;
  if (offlineNow(options)) return { status: 'missing', name, reason: OFFLINE_IMAGE_REASON };
  let loaded;
  try {
    loaded = Array.isArray(options.paths)
      ? await loadListedEmbed(db, { ...options, name })
      : await discoverEmbed(db, { ...options, name });
  } catch {
    loaded = { status: 'missing', name, reason: OFFLINE_IMAGE_REASON };
  }
  if (local && isTransportOffline(loaded)) return local;
  return present(loaded, name);
}

async function keepStorage(db, storage) {
  const target = storage || (globalThis.navigator && globalThis.navigator.storage);
  if (!target || typeof target.persist !== 'function') return;
  try {
    await recordStoragePersistence(db, target);
  } catch {
    // A denied persistence request still leaves the blobs we can store.
  }
}

async function runPool(items, limit, worker) {
  if (!items.length) return;
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

// Walks every saved note, resolves image embeds, and stores the blobs.
// A blob whose git sha is already stored is skipped. Failures stay unstored
// so the next sync tries them again. Referenced blobs are never deleted.
export async function prefetchEmbeddedImages(db, fetchImpl, {
  concurrency = PREFETCH_CONCURRENCY,
  storage,
} = {}) {
  await keepStorage(db, storage);
  const empty = { embedded: 0, stored: 0, skipped: 0, failed: 0, pruned: 0 };
  const settings = await loadGithubSettings(db);
  if (!settings.token || !settings.repo || !fetchImpl) return empty;
  const notes = await listFiles(db);
  const index = await vaultIndexFor(db, settings, fetchImpl, { fresh: true });
  const place = {
    repo: settings.repo,
    branch: index.branch || settings.branch || '',
    root: settings.root || '',
    token: settings.token,
  };
  const referenced = new Set();
  const jobs = [];
  const seen = new Set();
  for (const note of notes) {
    if (!note || typeof note.path !== 'string' || typeof note.content !== 'string') continue;
    for (const embed of listImageEmbeds(note.content)) {
      let resolved = '';
      if (index.ok) {
        resolved = resolveEmbedPath(embed.link, {
          notePath: note.path,
          paths: index.paths,
          attachmentFolderPath: index.attachmentFolderPath || '',
        }) || '';
      }
      if (!resolved) resolved = await rememberedEmbedPath(db, place, note.path, embed.link);
      if (!resolved) resolved = await rememberedEmbedPath(db, place, note.path, embed.raw);
      if (!resolved) continue;
      referenced.add(resolved);
      await rememberEmbedPath(db, place, note.path, embed.link, resolved);
      if (embed.raw && embed.raw !== embed.link) {
        await rememberEmbedPath(db, place, note.path, embed.raw, resolved);
      }
      if (!index.ok || seen.has(resolved)) continue;
      seen.add(resolved);
      jobs.push({
        path: resolved,
        sha: (index.shas && index.shas[resolved]) || '',
      });
    }
  }
  let stored = 0;
  let skipped = 0;
  let failed = 0;
  if (index.ok) {
    await runPool(jobs, concurrency, async (job) => {
      let existing = null;
      try {
        existing = await getImage(db, cacheKey(settings.repo, job.path));
      } catch {
        existing = null;
      }
      if (hasStoredBytes(existing) && (!job.sha || existing.sha === job.sha)) {
        skipped += 1;
        return;
      }
      const downloaded = await downloadEmbed(db, {
        repo: settings.repo,
        path: job.path,
        branch: index.branch || settings.branch,
        root: settings.root,
        token: settings.token,
        fetchImpl,
        sha: job.sha,
      });
      if (downloaded.status === 'ready') stored += 1;
      else failed += 1;
    });
  } else {
    failed = jobs.length;
  }
  let pruned = 0;
  if (index.ok && !index.truncated) {
    try {
      pruned = await pruneUnreferencedImages(db, settings.repo, referenced);
    } catch {
      pruned = 0;
    }
  }
  const result = { embedded: referenced.size, stored, skipped, failed, pruned };
  try {
    await setMeta(db, PREFETCH_KEY, { ...result, at: Date.now() });
  } catch {
    // The blobs are already stored when this summary cannot be.
  }
  return result;
}

export function startImagePrefetch(db, fetchImpl = globalThis.fetch) {
  const run = prefetchChain.catch(() => {}).then(async () => {
    try {
      return await prefetchEmbeddedImages(db, fetchImpl);
    } catch {
      return { embedded: 0, stored: 0, skipped: 0, failed: 0, pruned: 0 };
    }
  });
  prefetchChain = run.then(() => {}, () => {});
  return run;
}

export function embedImage(blob, { createObjectURL, createElement, width, height, name, type }) {
  const typed = blob.type ? blob : new Blob([blob], { type: type || 'application/octet-stream' });
  const url = createObjectURL(typed);
  const img = createElement('img');
  img.className = 'embed-image';
  img.alt = name || '';
  img.src = url;
  if (width) img.style.width = `${width}px`;
  if (height) img.style.height = `${height}px`;
  return { url, img };
}

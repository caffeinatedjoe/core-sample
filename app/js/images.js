import { deleteImages, deleteMeta, getImage, getMeta, listImages, putImage, setMeta } from './db.js';
import {
  basename,
  embedCandidates,
  imageKind,
  mimeFor,
  readAttachmentSetting,
  resolveEmbedPath,
} from './embeds.js';
import {
  fetchRawBytes,
  githubRequest,
  githubStatusReason,
  listVaultFiles,
  lookupRepository,
  repoPath,
  treeUrl,
} from './github-api.js';

export const IMAGE_CACHE_LIMIT = 32 * 1024 * 1024;
export const INDEX_TTL = 10 * 60 * 1000;
const INDEX_KEY = 'githubVaultIndex';
const RESOLVED_KEY = 'githubResolvedEmbeds';
const treeFlights = new Map();

function cacheKey(repo, path) {
  return `${repo}\n${path}`;
}

export async function rememberImage(db, { repo = '', path, blob, type, viewedAt = Date.now() }, limit = IMAGE_CACHE_LIMIT) {
  const record = {
    key: cacheKey(repo, path),
    repo,
    path,
    blob,
    bytes: blob.size,
    type: type || blob.type || '',
    viewedAt,
  };
  await putImage(db, record);
  await trimImages(db, limit);
  return record;
}

async function trimImages(db, limit) {
  const rows = await listImages(db);
  rows.sort((a, b) => b.viewedAt - a.viewedAt || (a.key < b.key ? -1 : 1));
  let total = 0;
  const drop = [];
  for (const row of rows) {
    const size = Number(row.bytes) || 0;
    if (total === 0 || total + size <= limit) total += size;
    else drop.push(row.key);
  }
  if (drop.length) await deleteImages(db, drop);
}

export async function cachedImage(db, repo, path) {
  const row = await getImage(db, cacheKey(repo, path));
  if (!row || !row.blob) return null;
  row.viewedAt = Date.now();
  try {
    await putImage(db, row);
  } catch {
    // The bytes are already loaded. A failed timestamp write must not hide them.
  }
  return row;
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
  let paths = [];
  try {
    paths = listVaultFiles(listed.body, settings.root, { allowTruncated: true });
  } catch {
    return blankIndex(settings, { branch, reason: githubStatusReason(0) });
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
  links[resolvedLinkKey(notePath, link)] = path;
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
  if (!saved.links[key]) return;
  const links = { ...saved.links };
  delete links[key];
  try {
    await setMeta(db, RESOLVED_KEY, { ...saved, links });
  } catch {
    // A stale remembered path is dropped again when it 404s.
  }
}

export async function forgetImage(db, repo, path) {
  await deleteImages(db, [cacheKey(repo, path)]);
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
    hit = null;
  }
  if (!hit || !hit.blob) return null;
  let payload = null;
  try {
    payload = imagePayload(await hit.blob.arrayBuffer());
  } catch {
    payload = null;
  }
  if (payload) return readyBlob(path, payload, mimeFor(path), hit.type || '');
  try {
    await forgetImage(db, repo, path);
  } catch {
    // A bad cache entry must not block the download.
  }
  return null;
}

// A file 404 means try another path. 401 and transport failures stop the search.
async function downloadEmbed(db, { repo, path, branch, root, token, fetchImpl, limit }) {
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
    await rememberImage(db, { repo, path, blob: ready.blob, type: ready.type }, limit);
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
    limit = IMAGE_CACHE_LIMIT,
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
  return downloadEmbed(db, { repo, path: resolved, branch, root, token, fetchImpl, limit });
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
    limit = IMAGE_CACHE_LIMIT,
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
    const downloaded = await downloadEmbed(db, { repo, path, branch, root, token, fetchImpl, limit });
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
      limit: options.limit,
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

// Reads one image. A cache hit does not call the network. The returned blob
// is what an <img> may display; callers must not put the request URL in src.
// Passing `paths` resolves only against that list. Omitting it looks the file
// up: likely paths, then one shared tree.
export async function loadEmbedBlob(db, options = {}) {
  const name = basename(options.link);
  const kind = imageKind(options.link);
  if (kind === 'unsupported') return { status: 'unsupported', name, reason: 'Unsupported format' };
  if (!kind) return { status: 'missing', name, reason: 'Not found in vault' };
  if (Array.isArray(options.paths)) return loadListedEmbed(db, { ...options, name });
  return discoverEmbed(db, { ...options, name });
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

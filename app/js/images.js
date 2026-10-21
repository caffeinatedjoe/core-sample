import { deleteImages, getImage, getMeta, listImages, putImage, setMeta } from './db.js';
import {
  basename,
  imageKind,
  mimeFor,
  readAttachmentSetting,
  resolveEmbedPath,
} from './embeds.js';
import {
  fetchRawBytes,
  githubRequest,
  listVaultFiles,
  lookupRepository,
  repoPath,
  treeUrl,
} from './github-api.js';

export const IMAGE_CACHE_LIMIT = 32 * 1024 * 1024;
const INDEX_KEY = 'githubVaultIndex';

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

export async function refreshVaultIndex(db, settings, fetchImpl) {
  let branch = settings.branch;
  if (!branch) {
    const repo = await lookupRepository(fetchImpl, { repo: settings.repo, token: settings.token });
    branch = repo.defaultBranch;
  }
  let paths = [];
  try {
    const listed = await githubRequest(fetchImpl, treeUrl(settings.repo, branch), {
      token: settings.token,
      secrets: [settings.token],
    });
    if (!listed.ok) throw new Error(listed.message);
    paths = listVaultFiles(listed.body, settings.root, { allowTruncated: true });
  } catch {
    paths = [];
  }
  let attachmentFolderPath = '';
  let attachmentChecked = false;
  try {
    const file = await fetchRawBytes(fetchImpl, {
      repo: settings.repo,
      path: repoPath(settings.root, '.obsidian/app.json'),
      branch,
      token: settings.token,
    });
    attachmentFolderPath = readAttachmentSetting(new TextDecoder().decode(file.bytes));
    attachmentChecked = true;
  } catch (error) {
    if (error && error.status === 404) attachmentChecked = true;
  }
  const index = {
    repo: settings.repo,
    branch,
    root: settings.root || '',
    paths,
    attachmentFolderPath,
    attachmentChecked,
  };
  if (attachmentChecked) {
    try {
      await setMeta(db, INDEX_KEY, index);
    } catch {
      // This view can still use the folder when the list will not store.
    }
  }
  return index;
}

export async function vaultIndexFor(db, settings, fetchImpl) {
  const saved = await getMeta(db, INDEX_KEY);
  const sameRepo = saved && saved.repo === settings.repo && (saved.root || '') === (settings.root || '');
  const sameBranch = !settings.branch || (saved && saved.branch === settings.branch);
  if (sameRepo && sameBranch && Array.isArray(saved.paths) && saved.attachmentChecked === true) return saved;
  if (!settings.token || !settings.repo || !fetchImpl) {
    return { paths: [], attachmentFolderPath: '', attachmentChecked: false, repo: settings.repo || '', branch: '', root: settings.root || '' };
  }
  try {
    return await refreshVaultIndex(db, settings, fetchImpl);
  } catch {
    if (sameRepo && Array.isArray(saved.paths)) return saved;
    return { paths: [], attachmentFolderPath: '', attachmentChecked: false, repo: settings.repo || '', branch: '', root: settings.root || '' };
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

// Reads one image. A cache hit does not call the network. The returned blob
// is what an <img> may display; callers must not put the request URL in src.
export async function loadEmbedBlob(db, {
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
} = {}) {
  const name = basename(link);
  const kind = imageKind(link);
  if (kind === 'unsupported') return { status: 'unsupported', name, reason: 'Unsupported format' };
  if (!kind) return { status: 'missing', name, reason: 'Not found in vault' };
  const resolved = resolveEmbedPath(link, { notePath, paths, attachmentFolderPath });
  if (!resolved) return { status: 'missing', name, reason: 'Not found in vault' };
  const type = mimeFor(resolved);
  if (!fresh) {
    let hit = null;
    try {
      hit = await cachedImage(db, repo, resolved);
    } catch {
      hit = null;
    }
    if (hit && hit.blob) {
      let payload = null;
      try {
        payload = imagePayload(await hit.blob.arrayBuffer());
      } catch {
        payload = null;
      }
      if (payload) return { status: 'ready', name: basename(resolved), path: resolved, blob: new Blob([payload], { type: hit.type || type }), type: hit.type || type };
      try {
        await forgetImage(db, repo, resolved);
      } catch {
        // A bad cache entry must not block the download.
      }
    }
  }
  if (!token || !repo || !fetchImpl) return { status: 'missing', name: basename(resolved), path: resolved, reason: 'Not found in vault' };
  let file;
  try {
    file = await fetchRawBytes(fetchImpl, {
      repo,
      path: repoPath(root, resolved),
      branch,
      token,
    });
  } catch (error) {
    const status = Number(error && error.status) || 0;
    return {
      status: 'error',
      name: basename(resolved),
      path: resolved,
      reason: status ? `Couldn't download (HTTP ${status})` : "Couldn't download (offline)",
    };
  }
  const payload = imagePayload(file.bytes);
  if (!payload) return { status: 'error', name: basename(resolved), path: resolved, reason: "Couldn't display" };
  const blob = new Blob([payload], { type });
  try {
    await rememberImage(db, { repo, path: resolved, blob, type }, limit);
  } catch {
    // The download can still be shown when IndexedDB rejects the blob.
  }
  return { status: 'ready', name: basename(resolved), path: resolved, blob, type };
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

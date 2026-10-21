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
  await putImage(db, row);
  return row;
}

export async function refreshVaultIndex(db, settings, fetchImpl) {
  let branch = settings.branch;
  if (!branch) {
    const repo = await lookupRepository(fetchImpl, { repo: settings.repo, token: settings.token });
    branch = repo.defaultBranch;
  }
  const listed = await githubRequest(fetchImpl, treeUrl(settings.repo, branch), {
    token: settings.token,
    secrets: [settings.token],
  });
  if (!listed.ok) throw new Error(listed.message);
  const paths = listVaultFiles(listed.body, settings.root);
  let attachmentFolderPath = '';
  if (paths.includes('.obsidian/app.json')) {
    try {
      const file = await fetchRawBytes(fetchImpl, {
        repo: settings.repo,
        path: repoPath(settings.root, '.obsidian/app.json'),
        branch,
        token: settings.token,
      });
      attachmentFolderPath = readAttachmentSetting(new TextDecoder().decode(file.bytes));
    } catch {
      attachmentFolderPath = '';
    }
  }
  const index = {
    repo: settings.repo,
    branch,
    root: settings.root || '',
    paths,
    attachmentFolderPath,
  };
  await setMeta(db, INDEX_KEY, index);
  return index;
}

export async function vaultIndexFor(db, settings, fetchImpl) {
  const saved = await getMeta(db, INDEX_KEY);
  const sameRepo = saved && saved.repo === settings.repo && (saved.root || '') === (settings.root || '');
  const sameBranch = !settings.branch || (saved && saved.branch === settings.branch);
  if (sameRepo && sameBranch && Array.isArray(saved.paths)) return saved;
  if (!settings.token || !settings.repo || !fetchImpl) {
    return { paths: [], attachmentFolderPath: '', repo: settings.repo || '', branch: '', root: settings.root || '' };
  }
  try {
    return await refreshVaultIndex(db, settings, fetchImpl);
  } catch {
    if (sameRepo && Array.isArray(saved.paths)) return saved;
    return { paths: [], attachmentFolderPath: '', repo: settings.repo || '', branch: '', root: settings.root || '' };
  }
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
} = {}) {
  const name = basename(link);
  const kind = imageKind(link);
  if (!kind || kind === 'unsupported') return { status: 'missing', name };
  const resolved = resolveEmbedPath(link, { notePath, paths, attachmentFolderPath });
  if (!resolved) return { status: 'missing', name };
  const hit = await cachedImage(db, repo, resolved);
  if (hit) return { status: 'ready', name: basename(resolved), path: resolved, blob: hit.blob, type: hit.type || mimeFor(resolved) };
  if (!token || !repo || !fetchImpl) return { status: 'missing', name: basename(resolved) };
  const file = await fetchRawBytes(fetchImpl, {
    repo,
    path: repoPath(root, resolved),
    branch,
    token,
  });
  const type = mimeFor(resolved);
  const blob = new Blob([file.bytes], { type });
  await rememberImage(db, { repo, path: resolved, blob, type }, limit);
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

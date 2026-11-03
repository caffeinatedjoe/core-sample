// Custom Attachment Location v0.0.9 rules, plus Obsidian shortest wikilinks
// and collision names. No DOM. Core Sample does not write app.json.

import { attachmentFolderFor, basename, extensionOf, imageKind, mimeFor } from './embeds.js';
import { ancestorFolders, parentPath, planFolderRename } from './organize.js';
import { isIgnoredPath } from './vault-paths.js';

export const ATTACHMENT_FOLDER = './assets/${filename}';
export const PASTED_IMAGE_NAME = 'image-${date}';
export const DATE_FORMAT = 'YYYYMMDDHHmmssSSS';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'heif']);

export function isMarkdownPath(path) {
  return String(path || '').toLowerCase().endsWith('.md');
}

export function isAttachmentPath(path) {
  const value = String(path || '');
  return Boolean(value) && !isMarkdownPath(value) && !isIgnoredPath(value);
}

export function isImagePath(path) {
  const ext = extensionOf(path);
  return IMAGE_EXT.has(ext) && ext !== 'heic' && ext !== 'heif';
}

export function attachmentIcon(path) {
  const ext = extensionOf(path);
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'file';
}

export function formatAttachmentStamp(date = new Date()) {
  const when = date instanceof Date ? date : new Date(date);
  const pad = (n, width) => String(n).padStart(width, '0');
  return [
    when.getFullYear(),
    pad(when.getMonth() + 1, 2),
    pad(when.getDate(), 2),
    pad(when.getHours(), 2),
    pad(when.getMinutes(), 2),
    pad(when.getSeconds(), 2),
    pad(when.getMilliseconds(), 3),
  ].join('');
}

export function pastedImageFileName(date = new Date(), ext = 'png') {
  const safe = String(ext || 'png').replace(/^\./, '').toLowerCase() || 'png';
  return `image-${formatAttachmentStamp(date)}.${safe}`;
}

export function extensionForMime(mime, filename = '') {
  const type = String(mime || '').toLowerCase();
  if (type === 'image/png') return 'png';
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/gif') return 'gif';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/heic' || type === 'image/heif') return 'heic';
  const fromName = extensionOf(filename);
  if (fromName === 'jpeg') return 'jpg';
  if (fromName) return fromName;
  return 'png';
}

export function uniqueCollisionPath(path, existingPaths) {
  const taken = new Set(existingPaths || []);
  const normal = String(path || '');
  if (!normal) throw new Error('That file has no path.');
  if (!taken.has(normal)) return normal;
  const slash = normal.lastIndexOf('/');
  const dir = slash === -1 ? '' : normal.slice(0, slash + 1);
  const base = slash === -1 ? normal : normal.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let n = 1;
  let next = `${dir}${stem} ${n}${ext}`;
  while (taken.has(next)) {
    n += 1;
    next = `${dir}${stem} ${n}${ext}`;
  }
  return next;
}

export function noteAttachmentFolder(notePath, setting = ATTACHMENT_FOLDER) {
  return attachmentFolderFor(notePath, setting);
}

function withExt(name, ext) {
  const base = String(name || '').trim() || 'image';
  const want = String(ext || '').replace(/^\./, '');
  if (!want) return base;
  if (extensionOf(base) === want) return base;
  if (extensionOf(base) === 'jpeg' && want === 'jpg') return `${base.slice(0, -5)}.jpg`;
  if (base.toLowerCase().endsWith(`.${want}`)) return base;
  return `${base}.${want}`;
}

export function attachmentDestination(notePath, {
  mime = '',
  filename = '',
  existingPaths = [],
  pasted = true,
  now = new Date(),
  setting = ATTACHMENT_FOLDER,
} = {}) {
  const ext = extensionForMime(mime, filename);
  const rawName = pasted
    ? pastedImageFileName(now, ext)
    : withExt(basename(filename) || pastedImageFileName(now, ext), ext);
  const folder = noteAttachmentFolder(notePath, setting);
  const path = uniqueCollisionPath(folder ? `${folder}/${rawName}` : rawName, existingPaths);
  return {
    path,
    folder: parentPath(path),
    name: basename(path),
    ext,
  };
}

export function shortestWikilink(path, allPaths) {
  const target = String(path || '');
  if (!target) return '';
  const parts = target.split('/').filter(Boolean);
  const list = (allPaths || []).map((item) => String(item || '')).filter(Boolean);
  for (let start = parts.length - 1; start >= 0; start -= 1) {
    const candidate = parts.slice(start).join('/');
    const want = candidate.toLowerCase();
    const hits = list.filter((item) => {
      const segs = item.split('/').filter(Boolean);
      if (segs.length < parts.length - start) return false;
      return segs.slice(-(parts.length - start)).join('/').toLowerCase() === want;
    });
    if (hits.length === 1) return candidate;
  }
  return target;
}

export function embedLinkFor(path, allPaths) {
  return `![[${shortestWikilink(path, allPaths)}]]`;
}

export function pathDistance(fromNote, toFile) {
  const from = parentPath(fromNote).split('/').filter(Boolean);
  const to = parentPath(toFile).split('/').filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared].toLowerCase() === to[shared].toLowerCase()) {
    shared += 1;
  }
  return (from.length - shared) + (to.length - shared);
}

export function closestPath(notePath, matches, { attachmentFolderPath = '' } = {}) {
  const list = (matches || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const folder = attachmentFolderFor(notePath, attachmentFolderPath);
  const prefer = folder ? `${folder}/${basename(list[0])}`.toLowerCase() : '';
  const ranked = [...list].sort((a, b) => {
    const da = pathDistance(notePath, a);
    const db = pathDistance(notePath, b);
    if (da !== db) return da - db;
    if (prefer) {
      const aHit = a.toLowerCase() === prefer || parentPath(a).toLowerCase() === folder.toLowerCase();
      const bHit = b.toLowerCase() === prefer || parentPath(b).toLowerCase() === folder.toLowerCase();
      if (aHit !== bHit) return aHit ? -1 : 1;
    }
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return ranked[0];
}

export function formatByteSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  if (n < 1024 * 1024) {
    const kb = n / 1024;
    const text = kb < 10 ? kb.toFixed(1).replace(/\.0$/, '') : String(Math.round(kb));
    return `${text} KB`;
  }
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function makeBinaryFile(path, {
  bytes = 0,
  sha = '',
  dirty = true,
  origin = 'user',
  now = Date.now(),
} = {}) {
  return {
    path,
    content: '',
    kind: 'binary',
    encoding: 'binary',
    bytes: Number(bytes) || 0,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    remoteSha: sha || null,
    baseSha: sha || null,
    dirty: Boolean(dirty),
    conflict: false,
    origin,
  };
}

export function liveItems(files) {
  return (files || []).filter((file) => file && !file.trashedAt && !isIgnoredPath(file.path));
}

export function mergePlans(first, second) {
  if (!second) return first;
  if (!first) return second;
  const later = new Map((second.put || []).map((file) => [file.path, file]));
  const removed = new Set(second.remove || []);
  const put = [];
  for (const file of first.put || []) {
    if (removed.has(file.path) || later.has(file.path)) continue;
    const moved = second.pathMap && second.pathMap[file.path];
    if (moved && moved !== file.path) continue;
    put.push(file);
  }
  put.push(...(second.put || []));
  return {
    files: second.files,
    folders: second.folders || first.folders,
    put,
    remove: [...new Set([...(first.remove || []), ...(second.remove || [])])],
    pathMap: { ...(first.pathMap || {}), ...(second.pathMap || {}) },
  };
}

export function planRenameAttachmentFolder(files, folders, fromNote, toNote, now = Date.now()) {
  const fromFolder = noteAttachmentFolder(fromNote);
  const toFolder = noteAttachmentFolder(toNote);
  if (!fromFolder || !toFolder || fromFolder === toFolder) return null;
  const prefix = `${fromFolder}/`;
  const present = (files || []).some((file) => (
    file && !file.trashedAt && (file.path === fromFolder || file.path.startsWith(prefix))
  ));
  const listed = (folders || []).includes(fromFolder);
  if (!present && !listed) return null;
  return planFolderRename(files, folders, fromFolder, toFolder, now);
}

export function extraAttachmentFiles(files, extraPaths) {
  const have = new Set((files || []).map((file) => file && file.path).filter(Boolean));
  const extra = [];
  for (const path of extraPaths || []) {
    if (!isAttachmentPath(path) || have.has(path)) continue;
    extra.push({
      path,
      kind: 'binary',
      content: '',
      encoding: 'binary',
      bytes: 0,
      trashedAt: null,
    });
    have.add(path);
  }
  return extra;
}

export { ancestorFolders, imageKind, mimeFor };

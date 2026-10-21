// Obsidian embed resolution. Exact vault path, then relative to the note,
// then the attachment folder from .obsidian/app.json, then a filename match.
// Several filename matches use the shortest path.

const RASTER = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const SVG = new Set(['svg']);
const UNSUPPORTED = new Set(['heic', 'heif']);

export function basename(path) {
  const text = String(path || '').replace(/\\/g, '/');
  const slash = text.lastIndexOf('/');
  return slash === -1 ? text : text.slice(slash + 1);
}

export function extensionOf(path) {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function imageKind(path) {
  const ext = extensionOf(path);
  if (RASTER.has(ext)) return 'raster';
  if (SVG.has(ext)) return 'svg';
  if (UNSUPPORTED.has(ext)) return 'unsupported';
  return '';
}

export function mimeFor(path) {
  const ext = extensionOf(path);
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

export function decodePath(value) {
  const text = String(value || '').trim();
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

export function normalizeVaultPath(path) {
  const parts = [];
  for (const part of String(path || '').replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function parentDir(notePath) {
  const path = normalizeVaultPath(notePath);
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

// `./folder` is relative to the note. Anything else is from the vault root.
export function attachmentFolderFor(notePath, setting) {
  const raw = String(setting || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  if (raw.startsWith('./')) {
    const rest = raw.slice(2);
    const dir = parentDir(notePath);
    return normalizeVaultPath(dir ? `${dir}/${rest}` : rest);
  }
  return normalizeVaultPath(raw.replace(/^\/+/, ''));
}

export function parseSize(text) {
  const value = String(text || '').trim();
  let match = /^(\d{1,5})x(\d{1,5})$/.exec(value);
  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return null;
    return { width, height };
  }
  match = /^(\d{1,5})$/.exec(value);
  if (!match) return null;
  const width = Number(match[1]);
  if (!width) return null;
  return { width, height: null };
}

export function parseWikilinkImage(inner) {
  const raw = String(inner ?? '');
  let body = raw;
  let alt = '';
  let size = null;
  const lastPipe = raw.lastIndexOf('|');
  if (lastPipe !== -1) {
    const tail = raw.slice(lastPipe + 1).trim();
    const parsed = parseSize(tail);
    if (parsed) {
      size = parsed;
      body = raw.slice(0, lastPipe);
    } else {
      const first = raw.indexOf('|');
      body = raw.slice(0, first);
      alt = raw.slice(first + 1).trim();
    }
  }
  const hash = body.indexOf('#');
  if (hash !== -1) body = body.slice(0, hash);
  const target = normalizeVaultPath(decodePath(body));
  if (!target || !imageKind(target)) return null;
  return {
    target,
    alt,
    width: size ? size.width : null,
    height: size ? size.height : null,
    kind: imageKind(target),
  };
}

export function resolveEmbedPath(link, { notePath = '', paths = [], attachmentFolderPath = '' } = {}) {
  const target = normalizeVaultPath(decodePath(link));
  if (!target) return null;
  const list = [];
  const seen = new Set();
  for (const path of paths) {
    const normal = normalizeVaultPath(path);
    if (!normal || seen.has(normal)) continue;
    seen.add(normal);
    list.push(normal);
  }
  const find = (path) => (seen.has(path) ? path : null);

  const exact = find(target);
  if (exact) return exact;

  const dir = parentDir(notePath);
  if (dir) {
    const relative = find(normalizeVaultPath(`${dir}/${target}`));
    if (relative) return relative;
  }

  const folder = attachmentFolderFor(notePath, attachmentFolderPath);
  if (folder) {
    const joined = find(normalizeVaultPath(`${folder}/${target}`));
    if (joined) return joined;
    const named = find(normalizeVaultPath(`${folder}/${basename(target)}`));
    if (named) return named;
  }

  const name = basename(target);
  const matches = list.filter((path) => basename(path) === name);
  if (!matches.length) return null;
  matches.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return matches[0];
}

export function readAttachmentSetting(text) {
  try {
    const parsed = JSON.parse(String(text || ''));
    const value = parsed && parsed.attachmentFolderPath;
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

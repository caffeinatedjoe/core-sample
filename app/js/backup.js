export const BACKUP_FORMAT = 'core-sample-backup';
export const BACKUP_VERSION = 1;

function copyFile(file) {
  if (!file || typeof file.path !== 'string' || !file.path) {
    throw new Error('This backup has a note without a path.');
  }
  if (typeof file.content !== 'string') {
    throw new Error('This backup has a note without its text.');
  }
  return {
    path: file.path,
    content: file.content,
    kind: file.kind === 'markdown' ? 'markdown' : (file.kind || 'markdown'),
    encoding: file.encoding || 'utf-8',
    createdAt: file.createdAt ?? null,
    updatedAt: file.updatedAt ?? null,
    trashedAt: file.trashedAt || null,
  };
}

export function buildBackup(files, meta = {}, now = Date.now()) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now,
    files: (files || []).map(copyFile).sort((a, b) => a.path.localeCompare(b.path)),
    folders: [...(meta.folders || [])].filter((folder) => typeof folder === 'string').sort(),
    lastOpened: typeof meta.lastOpened === 'string' ? meta.lastOpened : null,
    editorMode: meta.editorMode === 'preview' ? 'preview' : 'source',
    recent: Array.isArray(meta.recent) ? meta.recent.filter((path) => typeof path === 'string') : [],
  };
}

export function parseBackup(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      throw new Error('This file is not a Core Sample backup.');
    }
  }
  if (!data || data.format !== BACKUP_FORMAT || data.version !== BACKUP_VERSION || !Array.isArray(data.files)) {
    throw new Error('This file is not a Core Sample backup.');
  }
  const seen = new Set();
  const files = data.files.map((file) => {
    const copy = copyFile(file);
    if (seen.has(copy.path)) throw new Error('This backup repeats a path.');
    seen.add(copy.path);
    return copy;
  });
  return {
    files,
    folders: Array.isArray(data.folders) ? data.folders.filter((folder) => typeof folder === 'string') : [],
    lastOpened: typeof data.lastOpened === 'string' ? data.lastOpened : null,
    editorMode: data.editorMode === 'preview' ? 'preview' : 'source',
    recent: Array.isArray(data.recent) ? data.recent.filter((path) => typeof path === 'string') : [],
  };
}

function siblingPath(path, taken, label) {
  const parent = path.split('/').slice(0, -1).join('/');
  const base = path.split('/').pop().replace(/\.md$/i, '');
  let n = 1;
  while (n < 1000) {
    const stem = n === 1 ? `${base} (${label})` : `${base} (${label} ${n})`;
    const candidate = parent ? `${parent}/${stem}.md` : `${stem}.md`;
    if (!taken.has(candidate)) return candidate;
    n += 1;
  }
  throw new Error('Could not keep every note from the backup.');
}

export function mergeBackup(localFiles, localFolders, backup) {
  const next = (localFiles || []).map((file) => ({ ...file }));
  const taken = new Set(next.map((file) => file.path));
  const put = [];
  const keptAside = [];
  for (const incoming of backup.files) {
    const local = next.find((file) => file.path === incoming.path);
    if (!local) {
      next.push(incoming);
      put.push(incoming);
      taken.add(incoming.path);
      continue;
    }
    const sameText = local.content === incoming.content;
    const sameTrash = (local.trashedAt || null) === (incoming.trashedAt || null);
    if (sameText && sameTrash) continue;
    const alt = siblingPath(incoming.path, taken, 'imported');
    const copy = { ...incoming, path: alt };
    next.push(copy);
    put.push(copy);
    taken.add(alt);
    keptAside.push({ from: incoming.path, path: alt });
  }
  const folders = [...new Set([...(localFolders || []), ...(backup.folders || [])])];
  return { files: next, folders, put, keptAside };
}

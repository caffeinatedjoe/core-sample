import { getMeta, listFiles, putFile, setMeta } from './db.js';

export const WELCOME_PATH = 'Welcome.md';

export const WELCOME_MD = `# Welcome

Core Sample keeps notes on this phone. They are saved as you type.

- [ ] Switch to Preview and tap this box
- [ ] Open Source and see the Markdown change
- [ ] Tap [[Another note]] in Preview to open it

This install is local only. GitHub sync is not connected yet.

Clearing Safari website data for this app deletes these notes.
`;

export function makeFile(path, content, now = Date.now()) {
  return {
    path,
    content,
    kind: 'markdown',
    encoding: 'utf-8',
    createdAt: now,
    updatedAt: now,
  };
}

export function noteTitle(file) {
  const lines = String(file?.content ?? '').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = /^(#{1,6})\s+(\S.*)$/.exec(line.trim());
    if (match) return match[2].replace(/\s+#+\s*$/, '').trim();
    break;
  }
  return String(file?.path ?? '').replace(/\.md$/i, '');
}

export function notePathFromName(name, existingPaths, folder = '') {
  const paths = existingPaths || [];
  const raw = String(name ?? '').trim().replace(/\.md$/i, '').trim();
  const base = folder ? `${folder}/Untitled` : 'Untitled';
  if (!raw) return uniquePath(base, paths);
  if (/[\\/\u0000-\u001f]/.test(raw) || raw === '.' || raw === '..') {
    throw new Error('Use a name without slashes.');
  }
  const path = folder ? `${folder}/${raw}.md` : `${raw}.md`;
  if (paths.includes(path)) {
    throw new Error('A note with that name already exists.');
  }
  return path;
}

function uniquePath(base, existing) {
  let path = `${base}.md`;
  let n = 2;
  while (existing.includes(path)) {
    path = `${base} ${n}.md`;
    n += 1;
  }
  return path;
}

function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\.md$/i, '')
    .toLowerCase();
}

export function notePathFromWikilink(target, existingPaths = []) {
  const raw = String(target ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\.md$/i, '')
    .trim();
  const parts = raw.split('/').filter((part) => part.length);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || /[\u0000-\u001f]/.test(part))) {
    throw new Error('Use a note name.');
  }
  const path = `${parts.join('/')}.md`;
  if (existingPaths.includes(path)) {
    throw new Error('A note with that name already exists.');
  }
  return path;
}

export function planWikilink(notes, target) {
  const list = notes || [];
  const live = list.filter((file) => !file.trashedAt);
  const match = resolveWikilink(live, target);
  if (match.status === 'ok') return { action: 'open', path: match.file.path };
  if (match.status === 'ambiguous') return { action: 'ambiguous', target };
  const trashed = resolveWikilink(list.filter((file) => file.trashedAt), target);
  if (trashed.status === 'ok') return { action: 'restore', path: trashed.file.path };
  if (trashed.status === 'ambiguous') return { action: 'ambiguous', target };
  try {
    const path = notePathFromWikilink(target, list.map((note) => note.path));
    return {
      action: 'create',
      path,
      title: path.split('/').pop().replace(/\.md$/i, ''),
    };
  } catch (error) {
    return { action: 'invalid', message: error.message };
  }
}

export function resolveWikilink(files, target) {
  const notes = (files || []).filter((file) => file && file.kind === 'markdown');
  const want = normalizePath(target);
  if (!want) return { status: 'missing' };
  if (want.includes('/')) {
    const exact = notes.filter((file) => normalizePath(file.path) === want);
    if (exact.length === 1) return { status: 'ok', file: exact[0] };
    if (exact.length > 1) return { status: 'ambiguous' };
    return { status: 'missing' };
  }
  const byName = notes.filter((file) => normalizePath(file.path).split('/').pop() === want);
  if (byName.length === 1) return { status: 'ok', file: byName[0] };
  if (byName.length > 1) return { status: 'ambiguous' };
  return { status: 'missing' };
}

export function pickCurrent(notes, lastPath) {
  if (!notes?.length) return null;
  if (lastPath) {
    const match = notes.find((note) => note.path === lastPath);
    if (match) return match;
  }
  return [...notes].sort((a, b) => (b.updatedAt - a.updatedAt) || a.path.localeCompare(b.path))[0];
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

export async function loadSession(db) {
  let files = await listFiles(db);
  if (files.length === 0) {
    const welcome = makeFile(WELCOME_PATH, WELCOME_MD);
    await putFile(db, welcome);
    await setMeta(db, 'lastOpened', WELCOME_PATH);
    files = [welcome];
  }
  const notes = files.filter((file) => file.kind === 'markdown' && !file.trashedAt);
  const lastOpened = await getMeta(db, 'lastOpened');
  const editorMode = await getMeta(db, 'editorMode');
  const expanded = await getMeta(db, 'expanded');
  return {
    files,
    notes,
    current: pickCurrent(notes, lastOpened),
    mode: editorMode === 'preview' ? 'preview' : 'source',
    folders: stringList(await getMeta(db, 'folders')),
    recent: stringList(await getMeta(db, 'recent')),
    expanded: Array.isArray(expanded) ? expanded.filter((item) => typeof item === 'string') : null,
  };
}

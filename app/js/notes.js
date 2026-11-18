import { getMeta, listFiles, putFile, setMeta } from './db.js';
import { isIgnoredPath } from './vault-paths.js';

export const WELCOME_PATH = 'Welcome.md';

export const DOT_NAME_ERROR = 'Names starting with a dot are kept for Obsidian and Git. Use another name.';

export const WELCOME_MD = `# Welcome

Core Sample keeps notes on this phone. They are saved as you type.

- [ ] Tap this box to tick it
- [ ] Tap a line to see its **Markdown**
- [ ] Tap [[Another note]] to open it

Notes → GitHub can sign in and download Markdown. Edits to the saved branch sync after a short pause.

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
  const base = String(file?.path ?? '').split('/').pop() || '';
  return base.replace(/\.md$/i, '');
}

export function noteSnippet(file) {
  const parts = [];
  for (const line of String(file?.content ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s+\S/.test(trimmed)) continue;
    parts.push(trimmed);
    if (parts.join(' ').length > 72) break;
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= 72) return text;
  return `${text.slice(0, 71).trimEnd()}…`;
}

// Obsidian-style: Untitled, then Untitled 1, Untitled 2, … filling gaps.
export function untitledPath(existingPaths, folder = '') {
  const occupied = new Set(existingPaths || []);
  const prefix = folder ? `${folder}/` : '';
  let n = 0;
  while (true) {
    const path = n === 0 ? `${prefix}Untitled.md` : `${prefix}Untitled ${n}.md`;
    if (!occupied.has(path)) return path;
    n += 1;
  }
}

export function notePathFromName(name, existingPaths, folder = '') {
  const paths = existingPaths || [];
  const raw = String(name ?? '').trim().replace(/\.md$/i, '').trim();
  if (!raw) return untitledPath(paths, folder);
  if (/[\\/\u0000-\u001f]/.test(raw) || raw === '.' || raw === '..') {
    throw new Error('Use a name without slashes.');
  }
  if (raw.startsWith('.')) throw new Error(DOT_NAME_ERROR);
  const path = folder ? `${folder}/${raw}.md` : `${raw}.md`;
  if (paths.includes(path)) {
    throw new Error('A note with that name already exists.');
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
  if (parts.some((part) => part.startsWith('.'))) throw new Error(DOT_NAME_ERROR);
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
  const notes = (files || []).filter((file) => file && file.kind === 'markdown' && !isIgnoredPath(file.path));
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
  const seeded = await getMeta(db, 'seeded');
  if (files.length === 0 && seeded !== true) {
    const welcome = { ...makeFile(WELCOME_PATH, WELCOME_MD), origin: 'app', localOnly: true };
    await putFile(db, welcome);
    await setMeta(db, 'lastOpened', WELCOME_PATH);
    await setMeta(db, 'seeded', true);
    files = [welcome];
  } else if (seeded !== true) {
    await setMeta(db, 'seeded', true);
  }
  const notes = files.filter((file) => file.kind === 'markdown' && !file.trashedAt && !isIgnoredPath(file.path));
  const lastOpened = await getMeta(db, 'lastOpened');
  const expanded = await getMeta(db, 'expanded');
  return {
    files,
    notes,
    current: pickCurrent(notes, lastOpened),
    folders: stringList(await getMeta(db, 'folders')),
    recent: stringList(await getMeta(db, 'recent')),
    expanded: Array.isArray(expanded) ? expanded.filter((item) => typeof item === 'string') : null,
  };
}

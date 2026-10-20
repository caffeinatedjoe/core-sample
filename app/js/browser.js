import { noteSnippet, noteTitle } from './notes.js';
import { ancestorFolders, liveNotes, parentPath } from './organize.js';

const SEARCH_LIMIT = 40;

function byName(a, b) {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function folderSet(files, folders) {
  const set = new Set(folders || []);
  for (const file of liveNotes(files)) {
    for (const folder of ancestorFolders(file.path)) set.add(folder);
  }
  return set;
}

function appendTree(rows, files, folders, open, dir, depth, currentPath) {
  const childFolders = [...folders]
    .filter((path) => parentPath(path) === dir)
    .sort(byName);
  for (const path of childFolders) {
    const isOpen = open.has(path);
    rows.push({
      type: 'folder',
      path,
      name: path.split('/').pop(),
      depth,
      open: isOpen,
    });
    if (isOpen) appendTree(rows, files, folders, open, path, depth + 1, currentPath);
  }
  const notes = liveNotes(files)
    .filter((file) => parentPath(file.path) === dir)
    .sort((a, b) => byName(noteTitle(a), noteTitle(b)) || byName(a.path, b.path));
  for (const file of notes) {
    rows.push({
      type: 'note',
      path: file.path,
      title: noteTitle(file),
      depth,
      current: file.path === currentPath,
      detail: noteSnippet(file),
    });
  }
}

export function snippetAround(content, query) {
  const hay = String(content ?? '');
  const at = hay.toLowerCase().indexOf(String(query).toLowerCase());
  if (at < 0) return '';
  const start = Math.max(0, at - 20);
  const end = Math.min(hay.length, at + query.length + 28);
  const slice = hay.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < hay.length ? '…' : ''}`;
}

export function searchNotes(files, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const file of liveNotes(files)) {
    const title = noteTitle(file);
    const nameHit = title.toLowerCase().includes(q) || file.path.toLowerCase().includes(q);
    if (nameHit) {
      hits.push({ path: file.path, title, kind: 'name', snippet: '' });
    } else if (String(file.content ?? '').toLowerCase().includes(q)) {
      hits.push({
        path: file.path,
        title,
        kind: 'content',
        snippet: snippetAround(file.content, q),
      });
    }
    if (hits.length >= SEARCH_LIMIT) break;
  }
  return hits;
}

export function rememberRecent(recent, path, limit = 8) {
  const next = [path, ...(recent || []).filter((item) => item !== path && typeof item === 'string')];
  return next.slice(0, limit);
}

export function moveTargets(files, folders, from, isFolder) {
  const targets = new Set(['']);
  for (const folder of folderSet(files, folders)) targets.add(folder);
  if (isFolder && from) {
    for (const path of [...targets]) {
      if (path === from || path.startsWith(`${from}/`)) targets.delete(path);
    }
  }
  return [...targets].sort(byName);
}

export function listBrowser({ files, folders, expanded, recent, query, currentPath }) {
  const q = String(query ?? '').trim();
  if (q) {
    const hits = searchNotes(files, q);
    if (!hits.length) return [{ type: 'empty', text: 'No matching notes' }];
    return hits.map((hit) => ({
      type: 'note',
      path: hit.path,
      title: hit.title,
      depth: 0,
      current: hit.path === currentPath,
      detail: hit.kind === 'content' ? hit.snippet : noteSnippet(files.find((file) => file.path === hit.path)),
    }));
  }

  const rows = [];
  const live = liveNotes(files);
  const recentPaths = (recent || []).filter((path) => live.some((file) => file.path === path)).slice(0, 8);
  if (recentPaths.length) {
    rows.push({ type: 'label', text: 'Recent' });
    for (const path of recentPaths) {
      const file = live.find((item) => item.path === path);
      rows.push({
        type: 'note',
        path,
        title: noteTitle(file),
        depth: 0,
        current: path === currentPath,
        detail: noteSnippet(file),
        recent: true,
      });
    }
  }
  rows.push({ type: 'label', text: 'Notes' });
  const open = new Set(expanded || []);
  appendTree(rows, files, folderSet(files, folders), open, '', 0, currentPath);
  const trash = (files || []).filter((file) => file.trashedAt);
  if (trash.length) {
    rows.push({ type: 'trash-label', text: 'Trash', count: trash.length });
    for (const file of [...trash].sort((a, b) => byName(a.path, b.path))) {
      rows.push({ type: 'trash', path: file.path, title: noteTitle(file), depth: 0 });
    }
  }
  if (!live.length && !(folders || []).length) {
    rows.push({ type: 'empty', text: 'No notes yet' });
  }
  return rows;
}

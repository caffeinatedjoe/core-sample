import { attachmentIcon, extraAttachmentFiles, isMarkdownPath, liveItems } from './attachments.js';
import { noteTitle } from './notes.js';
import { ancestorFolders, liveNotes, parentPath } from './organize.js';
import { isIgnoredPath } from './vault-paths.js';

const SEARCH_LIMIT = 40;

function byName(a, b) {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function folderSet(files, folders) {
  const set = new Set((folders || []).filter((folder) => !isIgnoredPath(folder)));
  for (const file of liveItems(files)) {
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
  const children = liveItems(files)
    .filter((file) => parentPath(file.path) === dir)
    .sort((a, b) => byName(rowTitle(a), rowTitle(b)) || byName(a.path, b.path));
  for (const file of children) {
    if (file.kind === 'binary' || (!isMarkdownPath(file.path) && file.kind !== 'markdown')) {
      rows.push({
        type: 'attachment',
        path: file.path,
        title: String(file.path).split('/').pop(),
        icon: attachmentIcon(file.path),
        depth,
        current: false,
      });
      continue;
    }
    rows.push({
      type: 'note',
      path: file.path,
      title: noteTitle(file),
      depth,
      current: file.path === currentPath,
    });
  }
}

function rowTitle(file) {
  if (file.kind === 'binary' || !isMarkdownPath(file.path)) return String(file.path).split('/').pop();
  return noteTitle(file);
}

function folded(text, matchCase) {
  const value = String(text ?? '');
  return matchCase ? value : value.toLowerCase();
}

export function snippetAround(content, query, { matchCase = false } = {}) {
  const hay = String(content ?? '');
  const at = folded(hay, matchCase).indexOf(folded(query, matchCase));
  if (at < 0) return '';
  const start = Math.max(0, at - 20);
  const end = Math.min(hay.length, at + query.length + 28);
  const slice = hay.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < hay.length ? '…' : ''}`;
}

export function searchNotes(files, query, { matchCase = false, content = true } = {}) {
  const q = folded(String(query ?? '').trim(), matchCase);
  if (!q) return [];
  const hits = [];
  for (const file of liveItems(files)) {
    const attachment = file.kind === 'binary' || !isMarkdownPath(file.path);
    const title = attachment ? String(file.path).split('/').pop() : noteTitle(file);
    const nameHit = folded(title, matchCase).includes(q) || folded(file.path, matchCase).includes(q);
    if (nameHit) {
      hits.push({ path: file.path, title, kind: attachment ? 'attachment' : 'name', snippet: '' });
    } else if (!attachment && content && folded(file.content, matchCase).includes(q)) {
      hits.push({
        path: file.path,
        title,
        kind: 'content',
        snippet: snippetAround(file.content, q, { matchCase }),
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

export const NO_MATCHES = 'No matches found.';

function isPhoneOnly(file) {
  if (!file || file.trashedAt || isIgnoredPath(file.path)) return true;
  if (file.conflictCopy || file.backup || file.localOnly === true || file.origin === 'app') return true;
  return / \((?:conflict|backup) \d{4}-\d{2}-\d{2} \d{4}(?:-\d+)?\)\.md$/i.test(file.path);
}

// What Obsidian shows under the vault name: every non-dot file on GitHub
// (notes and attachments) and the folders that hold them. Local-only Welcome,
// conflict copies and backup copies are left out. `vaultPaths` is the saved
// GitHub tree when we have it.
export function vaultSummary(files, folders, vaultPaths) {
  const paths = Array.isArray(vaultPaths)
    ? vaultPaths.filter((path) => path && !isIgnoredPath(path))
    : (files || []).filter((file) => !isPhoneOnly(file)).map((file) => file.path);
  const dirs = new Set();
  for (const path of paths) {
    for (const folder of ancestorFolders(path)) dirs.add(folder);
  }
  if (!Array.isArray(vaultPaths)) {
    for (const folder of folders || []) {
      if (folder && !isIgnoredPath(folder)) dirs.add(folder);
    }
  }
  const notes = paths.length;
  const count = dirs.size;
  return {
    files: notes,
    folders: count,
    text: `${notes} ${notes === 1 ? 'file' : 'files'}, ${count} ${count === 1 ? 'folder' : 'folders'}`,
  };
}

export function listBrowser({
  files,
  folders,
  expanded,
  recent,
  query,
  currentPath,
  matchCase = false,
  searchContent = true,
  extraPaths,
}) {
  const all = [...(files || []), ...extraAttachmentFiles(files, extraPaths)];
  const q = String(query ?? '').trim();
  if (q) {
    const hits = searchNotes(all, q, { matchCase, content: searchContent });
    if (!hits.length) return [{ type: 'empty', text: NO_MATCHES }];
    return hits.map((hit) => ({
      type: hit.kind === 'attachment' ? 'attachment' : 'note',
      path: hit.path,
      title: hit.title,
      icon: hit.kind === 'attachment' ? attachmentIcon(hit.path) : '',
      depth: 0,
      current: hit.path === currentPath,
    }));
  }

  const rows = [];
  const live = liveNotes(all);
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
        recent: true,
      });
    }
  }
  rows.push({ type: 'label', text: 'Notes' });
  const open = new Set(expanded || []);
  appendTree(rows, all, folderSet(all, folders), open, '', 0, currentPath);
  const trash = (files || []).filter((file) => file.trashedAt && !isIgnoredPath(file.path));
  if (trash.length) {
    rows.push({ type: 'trash-label', text: 'Trash', count: trash.length });
    for (const file of [...trash].sort((a, b) => byName(a.path, b.path))) {
      rows.push({ type: 'trash', path: file.path, title: noteTitle(file), depth: 0 });
    }
  }
  if (!liveItems(all).length && !(folders || []).some((folder) => !isIgnoredPath(folder))) {
    rows.push({ type: 'empty', text: 'No notes yet' });
  }
  return rows;
}

import { closesFence, parseFenceLine } from './checklist.js';
import { parseWikilink } from './markdown.js';
import { resolveWikilink } from './notes.js';

export function parentPath(path) {
  const parts = String(path ?? '').split('/');
  parts.pop();
  return parts.join('/');
}

export function ancestorFolders(path) {
  const parts = parentPath(path).split('/').filter(Boolean);
  const folders = [];
  for (let i = 0; i < parts.length; i += 1) folders.push(parts.slice(0, i + 1).join('/'));
  return folders;
}

export function cleanSegment(name) {
  const raw = String(name ?? '').trim();
  if (!raw || raw === '.' || raw === '..') throw new Error('Use a name.');
  if (/[\\/\u0000-\u001f]/.test(raw)) throw new Error('Use a name without slashes.');
  return raw;
}

export function noteDestination(folder, name, existingPaths) {
  const stem = cleanSegment(name).replace(/\.md$/i, '').trim();
  if (!stem) throw new Error('Use a name.');
  const path = folder ? `${folder}/${stem}.md` : `${stem}.md`;
  if ((existingPaths || []).includes(path)) throw new Error('A note with that name already exists.');
  return path;
}

export function folderDestination(parent, name, existingFolders) {
  const segment = cleanSegment(name);
  if (/\.md$/i.test(segment)) throw new Error('A folder name should not end in .md.');
  const path = parent ? `${parent}/${segment}` : segment;
  if ((existingFolders || []).includes(path)) throw new Error('That folder already exists.');
  return path;
}

export function relativeLink(fromFile, toFile) {
  const fromDir = String(fromFile).split('/').slice(0, -1);
  const toParts = String(toFile).split('/');
  let shared = 0;
  while (shared < fromDir.length && shared < toParts.length - 1 && fromDir[shared] === toParts[shared]) {
    shared += 1;
  }
  const up = fromDir.length - shared;
  const tail = toParts.slice(shared).join('/');
  if (!up) return tail;
  return `${'../'.repeat(up)}${tail}`;
}

function filesAfter(files, pathMap) {
  return files.map((file) => (
    pathMap.has(file.path) ? { ...file, path: pathMap.get(file.path) } : file
  ));
}

function wikilinkInner(target, parsed) {
  let body = target;
  if (parsed.heading) body += `#${parsed.heading}`;
  if (parsed.alias) body += `|${parsed.alias}`;
  return body;
}

function retargetWikilink(parsed, pathMap, files) {
  const match = resolveWikilink(files, parsed.target);
  if (match.status !== 'ok') return null;
  const nextPath = pathMap.get(match.file.path) || match.file.path;
  if (nextPath === match.file.path) return null;
  const after = filesAfter(files, pathMap);
  const stem = nextPath.replace(/\.md$/i, '');
  const base = stem.split('/').pop();
  let target = stem;
  if (!parsed.target.includes('/')) {
    const still = resolveWikilink(after, parsed.target);
    if (still.status === 'ok' && still.file.path === nextPath) return null;
    const sameName = after.filter((file) => (
      file.path.replace(/\.md$/i, '').split('/').pop().toLowerCase() === base.toLowerCase()
    ));
    target = sameName.length === 1 ? base : stem;
  }
  if (target === parsed.target) return null;
  return wikilinkInner(target, parsed);
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveLocalHref(fromFile, href) {
  const raw = String(href ?? '').trim();
  if (!raw || raw.startsWith('#')) return null;
  if (/^[a-zA-Z][a-zA-Z+.-]*:/.test(raw) || raw.startsWith('//')) return null;
  const hashAt = raw.indexOf('#');
  const beforeHash = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : raw.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  const pathPart = decodePart(queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt)).trim();
  if (!pathPart) return null;
  const fromDir = parentPath(fromFile).split('/').filter(Boolean);
  const stack = pathPart.startsWith('/') ? [] : [...fromDir];
  for (const part of pathPart.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  let path = stack.join('/');
  if (!/\.[A-Za-z0-9]+$/.test(path)) path = `${path}.md`;
  return { path, hash };
}

function sameHref(original, next) {
  const norm = (value) => String(value).trim().replace(/^\.\//, '');
  return norm(original) === norm(next);
}

function retargetHref(href, fromFile, pathMap, files) {
  const resolved = resolveLocalHref(fromFile, href);
  if (!resolved) return null;
  const target = files.find((file) => file.path === resolved.path);
  if (!target) return null;
  const nextTarget = pathMap.get(target.path) || target.path;
  const nextFrom = pathMap.get(fromFile) || fromFile;
  if (nextTarget === target.path && nextFrom === fromFile) return null;
  const next = `${relativeLink(nextFrom, nextTarget)}${resolved.hash}`;
  if (sameHref(href, next)) return null;
  return next;
}

function readMarkdownLink(text, index) {
  if (text[index] !== '[') return null;
  const labelEnd = text.indexOf(']', index + 1);
  if (labelEnd === -1 || text[labelEnd + 1] !== '(') return null;
  const hrefEnd = text.indexOf(')', labelEnd + 2);
  if (hrefEnd === -1) return null;
  const label = text.slice(index + 1, labelEnd);
  if (label.includes('[')) return null;
  return { label, href: text.slice(labelEnd + 2, hrefEnd), end: hrefEnd + 1 };
}

function rewriteLine(line, fromFile, pathMap, files) {
  let out = '';
  let index = 0;
  while (index < line.length) {
    if (line[index] === '`') {
      const end = line.indexOf('`', index + 1);
      if (end !== -1) {
        out += line.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }
    if (line.startsWith('[[', index)) {
      const end = line.indexOf(']]', index + 2);
      if (end !== -1) {
        const parsed = parseWikilink(line.slice(index + 2, end));
        const rebuilt = parsed ? retargetWikilink(parsed, pathMap, files) : null;
        if (rebuilt) out += `[[${rebuilt}]]`;
        else out += line.slice(index, end + 2);
        index = end + 2;
        continue;
      }
    }
    const image = line[index] === '!' && line[index + 1] === '[';
    const linkAt = image ? index + 1 : index;
    if (line[linkAt] === '[') {
      const link = readMarkdownLink(line, linkAt);
      if (link) {
        const href = retargetHref(link.href, fromFile, pathMap, files);
        if (href) {
          out += `${image ? '!' : ''}[${link.label}](${href})`;
          index = link.end;
          continue;
        }
      }
    }
    out += line[index];
    index += 1;
  }
  return out;
}

export function rewriteLinks(content, fromFile, pathMap, files) {
  const lines = String(content ?? '').split('\n');
  let open = null;
  const out = lines.map((line) => {
    const fence = parseFenceLine(line);
    if (!open && fence) {
      open = fence;
      return line;
    }
    if (open && closesFence(line, open)) {
      open = null;
      return line;
    }
    if (open) return line;
    return rewriteLine(line, fromFile, pathMap, files);
  });
  return out.join('\n');
}

function applyPathMap(files, pathMap, now) {
  const put = [];
  const remove = [];
  const next = files.map((file) => {
    const to = pathMap.get(file.path) || file.path;
    const content = file.kind === 'markdown'
      ? rewriteLinks(file.content, file.path, pathMap, files)
      : file.content;
    if (to === file.path && content === file.content) return file;
    const pathChanged = to !== file.path;
    const updated = {
      ...file,
      path: to,
      content,
      updatedAt: now,
      dirty: true,
      remoteSha: pathChanged ? null : (typeof file.remoteSha === 'string' ? file.remoteSha : null),
    };
    put.push(updated);
    if (to !== file.path) remove.push(file.path);
    return updated;
  });
  return { files: next, put, remove, pathMap: Object.fromEntries(pathMap), folders: null };
}

function assertFree(path, files, except = new Set()) {
  if (files.some((file) => file.path === path && !except.has(file.path))) {
    throw new Error('A note with that name already exists.');
  }
}

export function planFileRename(files, from, to, now = Date.now()) {
  if (!files.some((file) => file.path === from)) throw new Error('That note is not on this device.');
  if (from === to) return { files, put: [], remove: [], pathMap: {}, folders: null };
  assertFree(to, files);
  return applyPathMap(files, new Map([[from, to]]), now);
}

export function planFileMove(files, from, folder, now = Date.now()) {
  const name = String(from).split('/').pop();
  const to = folder ? `${folder}/${name}` : name;
  if (to === from) throw new Error('That note is already in this folder.');
  return planFileRename(files, from, to, now);
}

export function planFolderRename(files, folders, from, to, now = Date.now()) {
  if (!from || from === to) return { files, folders: folders || [], put: [], remove: [], pathMap: {} };
  const prefix = `${from}/`;
  const destPrefix = `${to}/`;
  if (to === from || to.startsWith(prefix)) throw new Error('A folder cannot move inside itself.');
  const moving = new Set(files.filter((file) => file.path.startsWith(prefix)).map((file) => file.path));
  const pathMap = new Map();
  for (const path of moving) pathMap.set(path, `${destPrefix}${path.slice(prefix.length)}`);
  for (const dest of pathMap.values()) assertFree(dest, files, moving);
  const nextFolders = (folders || []).map((folder) => {
    if (folder === from) return to;
    if (folder.startsWith(prefix)) return `${destPrefix}${folder.slice(prefix.length)}`;
    return folder;
  });
  if (!(folders || []).includes(from) && !nextFolders.includes(to)) nextFolders.push(to);
  const applied = applyPathMap(files, pathMap, now);
  applied.folders = [...new Set(nextFolders)];
  return applied;
}

export function planFolderMove(files, folders, from, destFolder, now = Date.now()) {
  const name = String(from).split('/').pop();
  const to = destFolder ? `${destFolder}/${name}` : name;
  if (to === from) throw new Error('That folder is already here.');
  return planFolderRename(files, folders, from, to, now);
}

export function planTrash(files, folders, target, now = Date.now()) {
  const prefix = `${target}/`;
  const paths = new Set();
  for (const file of files) {
    if (file.path === target || file.path.startsWith(prefix)) paths.add(file.path);
  }
  const folderHit = (folders || []).some((folder) => folder === target || folder.startsWith(prefix));
  if (!paths.size && !folderHit) throw new Error('That item is not on this device.');
  const put = [];
  const next = files.map((file) => {
    if (!paths.has(file.path) || file.trashedAt) return file;
    const updated = { ...file, trashedAt: now };
    put.push(updated);
    return updated;
  });
  const nextFolders = (folders || []).filter((folder) => folder !== target && !folder.startsWith(prefix));
  return { files: next, folders: nextFolders, put, remove: [], pathMap: {} };
}

export function planRestore(files, path, now = Date.now()) {
  const file = files.find((item) => item.path === path);
  if (!file?.trashedAt) throw new Error('That note is not in Trash.');
  if (files.some((item) => item.path === path && !item.trashedAt)) {
    throw new Error('A note with that name already exists.');
  }
  const restored = { ...file, trashedAt: null, updatedAt: now };
  return {
    files: files.map((item) => (item.path === path ? restored : item)),
    put: [restored],
    remove: [],
    pathMap: {},
    path: restored.path,
  };
}

export function planEmptyTrash(files) {
  const remove = files.filter((file) => file.trashedAt).map((file) => file.path);
  return {
    files: files.filter((file) => !file.trashedAt),
    put: [],
    remove,
    pathMap: {},
  };
}

export function liveNotes(files) {
  return (files || []).filter((file) => file && file.kind === 'markdown' && !file.trashedAt);
}

export function notesInFolder(files, folder) {
  const prefix = `${folder}/`;
  return liveNotes(files).filter((file) => file.path.startsWith(prefix));
}

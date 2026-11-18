// `![[Note]]` / `![[Note#Heading]]` / `![[Note#^block]]` resolution.
// Image embeds stay in embeds.js; this module never treats a raster path
// as a note.

import { imageKind } from './embeds.js';
import { parseWikilink } from './markdown.js';
import { resolveWikilink } from './notes.js';

const EMBED_CAP = 4000;

export function parseNoteEmbed(inner) {
  const parsed = parseWikilink(inner);
  if (!parsed) return null;
  if (imageKind(parsed.target)) return null;
  return parsed;
}

export function stripFrontmatter(markdown) {
  const source = String(markdown ?? '');
  if (!source.startsWith('---')) return source;
  const rest = source.slice(3);
  const end = rest.search(/\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (end < 0) return source;
  const after = rest.slice(end).replace(/^\n(?:---|\.\.\.)[ \t]*/, '');
  return after.replace(/^\r?\n/, '');
}

function headingLine(line) {
  const match = /^(#{1,6})[ \t]+(\S.*)$/.exec(String(line ?? '').replace(/\r$/, ''));
  if (!match) return null;
  return { level: match[1].length, title: match[2].replace(/[ \t]+#+\s*$/, '').trim() };
}

export function extractHeadingSection(markdown, heading) {
  const want = String(heading || '').trim().toLowerCase();
  if (!want) return stripFrontmatter(markdown);
  const lines = String(markdown ?? '').split('\n');
  let fence = null;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '');
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch && (!fence || fenceMatch[1][0] === fence[0])) fence = fence ? null : fenceMatch[1];
    if (fence) continue;
    const head = headingLine(line);
    if (!head) continue;
    if (start === -1 && head.title.toLowerCase() === want) {
      start = i;
      level = head.level;
      continue;
    }
    if (start !== -1 && head.level <= level) {
      return lines.slice(start, i).join('\n');
    }
  }
  if (start === -1) return '';
  return lines.slice(start).join('\n');
}

export function extractBlock(markdown, id) {
  const want = String(id || '').replace(/^\^/, '').trim().toLowerCase();
  if (!want) return '';
  const lines = String(markdown ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '');
    const match = /(^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(line);
    if (!match || match[2].toLowerCase() !== want) continue;
    const without = line.slice(0, match.index).trimEnd();
    if (without) return without;
    let end = i - 1;
    while (end >= 0 && !lines[end].replace(/\r$/, '').trim()) end -= 1;
    if (end < 0) return '';
    let start = end;
    while (start > 0) {
      const prev = lines[start - 1].replace(/\r$/, '');
      if (!prev.trim() || headingLine(prev)) break;
      start -= 1;
    }
    return lines.slice(start, end + 1).join('\n');
  }
  return '';
}

export function extractEmbedBody(markdown, heading) {
  const ref = String(heading || '').trim();
  if (!ref) return stripFrontmatter(markdown);
  if (ref.startsWith('^')) return extractBlock(markdown, ref);
  return extractHeadingSection(markdown, ref);
}

export function clipEmbed(text) {
  const source = String(text ?? '');
  if (source.length <= EMBED_CAP) return { text: source, clipped: false };
  let cut = source.slice(0, EMBED_CAP);
  const nl = cut.lastIndexOf('\n');
  if (nl > EMBED_CAP / 2) cut = cut.slice(0, nl);
  return { text: cut, clipped: true };
}

export function describeNoteEmbed(files, target, heading, fromPath = '') {
  const want = String(target || '').trim();
  if (!want) return { status: 'missing', message: 'Note not on this phone', target: '', heading: heading || '' };
  const match = resolveWikilink(files, want);
  if (match.status === 'missing') {
    return { status: 'missing', message: 'Note not on this phone', target: want, heading: heading || '' };
  }
  if (match.status === 'ambiguous') {
    return { status: 'ambiguous', message: 'More than one note matches', target: want, heading: heading || '' };
  }
  const file = match.file;
  const title = (file.path.split('/').pop() || '').replace(/\.md$/i, '');
  if (fromPath && file.path === fromPath) {
    return { status: 'self', message: 'This note', target: want, heading: heading || '', path: file.path, title };
  }
  const extracted = extractEmbedBody(file.content, heading);
  if (heading && !String(extracted).trim()) {
    return {
      status: 'missing-target',
      message: String(heading).startsWith('^') ? 'Block not found' : 'Heading not found',
      target: want,
      heading,
      path: file.path,
      title,
    };
  }
  const clipped = clipEmbed(extracted);
  const lines = clipped.text.split('\n');
  const lead = headingLine(lines[0] || '');
  const body = lead && lead.title.toLowerCase() === title.toLowerCase()
    ? lines.slice(1).join('\n').replace(/^\n+/, '')
    : clipped.text;
  return {
    status: 'ok',
    target: want,
    heading: heading || '',
    path: file.path,
    title,
    body,
    clipped: clipped.clipped,
  };
}

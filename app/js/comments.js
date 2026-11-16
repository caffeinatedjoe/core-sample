// Document Comments on-disk format and edits.
// Ported from Document Comments v0.1.19 (MIT),
// https://github.com/kylemcd/obsidian-document-comments
// (src/format/parse.ts, serialize.ts, escape.ts, ids.ts, code-anchor.ts,
//  line-start.ts MARKER_GUARD, and src/editor/edits.ts). Core Sample does not
// vendor that plugin's UI.

import { isTableRow, isTableSep } from './tables.js';

export const MARKER_GUARD = '\u200b';
export const COMMENT_REACTIONS = ['👍', '❤️', '😄', '🎉', '😮', '👀', '🙏'];
export const TERMINATOR_BREAK = '--\u200b>';

const OPEN_RE = /<!--c:([A-Za-z0-9]+)-->/g;
const CLOSE_RE = /<!--\/c:([A-Za-z0-9]+)-->/g;
const BODY_RE = /<!--co:([A-Za-z0-9]+)[ \t]*([^\n]*)\n?([\s\S]*?)-->/g;
const HEADER_ATTR_RE = /(\w+):(?:"([^"]*)"|(\S+))/g;
const THREAD_LINE_RE = /^(.*?)(?:\s\(([^)]*)\))?:\s?([\s\S]*)$/;
const REACTION_LINE_RE = /^\+\s*(?:@(\d+)\s+)?(\S+)\s+(.+)$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PREVIEW_OPEN = (id, resolved = false) => `\u0001${resolved ? 'cr' : 'c'}:${id}\u0002`;
const PREVIEW_CLOSE = (id) => `\u0001/c:${id}\u0002`;

function ok(changes) {
  return { changes };
}

function err(message) {
  return { changes: [], error: message };
}

export function escapeText(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function unescapeText(s) {
  return String(s ?? '').replace(/\\(.)/g, (match, c) => {
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === '\\') return '\\';
    return match;
  });
}

export function escapeReactionAuthor(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/,/g, '\\,');
}

export function splitReactionAuthors(s) {
  return String(s ?? '')
    .split(/(?<!\\),/)
    .map((author) => author.trim().replace(/\\(.)/g, (match, c) => (c === ',' ? ',' : c === '\\' ? '\\' : match)))
    .filter(Boolean);
}

export function encodeCodeQuote(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\q')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/-->/g, '--\\g>');
}

export function decodeCodeQuote(s) {
  return String(s ?? '').replace(/\\(.)/g, (match, c) => {
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === 'q') return '"';
    if (c === 'g') return '';
    if (c === '\\') return '\\';
    return match;
  });
}

function breakTerminator(s) {
  return String(s ?? '').replace(/-->/g, TERMINATOR_BREAK);
}

export function canonicalAuthorKey(author) {
  return breakTerminator(String(author ?? '').trim()).replace(/\s+/g, '_');
}

export function openMarker(id) {
  return `<!--c:${id}-->`;
}

export function closeMarker(id) {
  return `<!--/c:${id}-->`;
}

export function generateId(existing = []) {
  const taken = existing instanceof Set ? existing : new Set(existing);
  const randomId = (len) => Array.from({ length: len }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = randomId(5);
    if (!taken.has(id)) return id;
  }
  return randomId(8);
}

export function fencedRanges(doc) {
  const ranges = [];
  let offset = 0;
  let fenceStart = -1;
  let fenceChar = '';
  for (const line of String(doc ?? '').split('\n')) {
    const lineEnd = offset + line.length;
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceStart < 0 && marker) {
      fenceStart = offset;
      fenceChar = marker[0] ?? '';
    } else if (fenceStart >= 0 && marker && marker[0] === fenceChar) {
      ranges.push([fenceStart, lineEnd]);
      fenceStart = -1;
    }
    offset = lineEnd + 1;
  }
  if (fenceStart >= 0) ranges.push([fenceStart, String(doc ?? '').length]);
  return ranges;
}

function indentedCodeRanges(doc) {
  const source = String(doc ?? '');
  const ranges = [];
  let offset = 0;
  let start = -1;
  let lastEnd = 0;
  for (const line of source.split('\n')) {
    const lineEnd = offset + line.length;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
    const cols = indentColumns(indent);
    const blank = !line.trim();
    const list = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(line);
    const code = !blank && !list && cols >= 4;
    if (code) {
      if (start < 0) start = offset;
      lastEnd = lineEnd;
    } else if (blank && start >= 0) {
      lastEnd = lineEnd;
    } else if (start >= 0) {
      ranges.push([start, lastEnd]);
      start = -1;
    }
    offset = lineEnd + 1;
  }
  if (start >= 0) ranges.push([start, source.length]);
  return ranges;
}

function maskedRanges(doc) {
  const ranges = [...fencedRanges(doc), ...indentedCodeRanges(doc)];
  const inline = /`+[^`\n]*`+/g;
  let match;
  while ((match = inline.exec(doc))) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

function isInside(ranges, index) {
  return ranges.some(([from, to]) => index >= from && index < to);
}

export function isInFencedCode(doc, pos) {
  return isInside(fencedRanges(doc), pos);
}

export function hasClosingFence(doc, fenceStart) {
  const openEnd = String(doc ?? '').indexOf('\n', fenceStart);
  if (openEnd < 0) return false;
  const fenceChar = (line) => /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1]?.[0];
  const char = fenceChar(String(doc).slice(fenceStart, openEnd));
  return Boolean(char) && String(doc).slice(openEnd + 1).split('\n').some((line) => fenceChar(line) === char);
}

function parseHeader(header) {
  const attrs = {};
  HEADER_ATTR_RE.lastIndex = 0;
  let match;
  while ((match = HEADER_ATTR_RE.exec(header))) {
    const key = match[1];
    const value = match[2] ?? match[3];
    if (key !== undefined && value !== undefined) attrs[key] = value;
  }
  const status = attrs.status === 'resolved' ? 'resolved' : 'open';
  const codeLines = parseLineRange(attrs.line);
  const quote = attrs.quote === undefined ? undefined : (codeLines ? decodeCodeQuote(attrs.quote) : attrs.quote);
  return {
    author: attrs.by,
    createdAt: attrs.at,
    status,
    quote,
    codeLines,
  };
}

function parseLineRange(value) {
  if (!value) return undefined;
  const match = /^(\d+)(?:-(\d+))?$/.exec(value);
  if (!match || match[1] === undefined) return undefined;
  const from = Number(match[1]);
  const to = match[2] !== undefined ? Number(match[2]) : from;
  return to >= from ? { from, to } : undefined;
}

function parseBody(block) {
  const thread = [];
  const reactions = [];
  for (const raw of String(block ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const rx = REACTION_LINE_RE.exec(line);
    if (rx && rx[2] !== undefined && rx[3] !== undefined) {
      const entry = rx[1] === undefined ? undefined : Number(rx[1]);
      const reaction = { emoji: rx[2], authors: splitReactionAuthors(rx[3]) };
      reactions.push(entry === undefined ? reaction : { ...reaction, entry });
      continue;
    }
    const match = THREAD_LINE_RE.exec(line);
    const last = thread[thread.length - 1];
    if (match && match[1] !== undefined && match[3] !== undefined && match[1].trim() !== '') {
      const entry = { author: match[1].trim(), text: unescapeText(match[3]) };
      if (match[2]) entry.timestamp = match[2];
      thread.push(entry);
    } else if (last) {
      last.text += `\n${unescapeText(line)}`;
    } else {
      thread.push({ author: '', text: unescapeText(line) });
    }
  }
  return { thread, reactions };
}

export function parseComments(doc) {
  const source = String(doc ?? '');
  const masks = maskedRanges(source);
  const masked = (index) => isInside(masks, index);
  const opens = new Map();
  const closes = new Map();
  const bodies = new Map();
  const order = [];
  const seen = new Set();
  const track = (id) => {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  };
  let match;
  OPEN_RE.lastIndex = 0;
  while ((match = OPEN_RE.exec(source))) {
    const [full, id] = match;
    if (!id || !full || masked(match.index)) continue;
    if (!opens.has(id)) opens.set(id, { from: match.index, to: match.index + full.length });
    track(id);
  }
  CLOSE_RE.lastIndex = 0;
  while ((match = CLOSE_RE.exec(source))) {
    const [full, id] = match;
    if (!id || !full || masked(match.index)) continue;
    if (!closes.has(id)) closes.set(id, { from: match.index, to: match.index + full.length });
    track(id);
  }
  BODY_RE.lastIndex = 0;
  while ((match = BODY_RE.exec(source))) {
    const [full, id] = match;
    if (!id || !full || masked(match.index)) continue;
    if (!bodies.has(id)) {
      const parsed = parseBody(match[3] ?? '');
      bodies.set(id, {
        range: { from: match.index, to: match.index + full.length },
        data: { ...parseHeader(match[2] ?? ''), thread: parsed.thread, reactions: parsed.reactions },
      });
    }
    track(id);
  }
  return order.map((id) => {
    const body = bodies.get(id);
    const data = body ? body.data : { status: 'open', thread: [], reactions: [] };
    return {
      id,
      author: data.author,
      createdAt: data.createdAt,
      status: data.status,
      quote: data.quote,
      codeLines: data.codeLines,
      thread: data.thread,
      reactions: data.reactions,
      open: opens.get(id) ?? null,
      close: closes.get(id) ?? null,
      body: body ? body.range : null,
    };
  });
}

export function commentMarkup(doc) {
  const source = String(doc ?? '');
  const masks = maskedRanges(source);
  const scan = (pattern, kind) => [...source.matchAll(new RegExp(pattern.source, 'g'))]
    .filter((match) => !isInside(masks, match.index))
    .map((match) => ({ id: match[1] ?? '', kind, from: match.index, to: match.index + match[0].length }));
  return [...scan(OPEN_RE, 'open'), ...scan(CLOSE_RE, 'close'), ...scan(BODY_RE, 'body')]
    .sort((a, b) => a.from - b.from);
}

export function existingIds(doc) {
  return new Set(parseComments(doc).map((comment) => comment.id));
}

export function isAnchored(comment) {
  return Boolean(comment?.open && comment.close && comment.open.to <= comment.close.from);
}

export function isHighlight(comment) {
  return Boolean(comment?.body && comment.thread.length === 0);
}

export function isOrphan(comment) {
  return Boolean(comment?.body) && !isAnchored(comment);
}

export function commentsForList(comments, tab = 'open') {
  const items = (comments || []).filter((comment) => comment.body);
  const match = tab === 'resolved'
    ? items.filter((comment) => comment.status === 'resolved')
    : tab === 'all'
      ? items
      : items.filter((comment) => comment.status !== 'resolved');
  return {
    anchored: match.filter((comment) => !isOrphan(comment)),
    orphans: match.filter((comment) => isOrphan(comment)),
  };
}

export function commentQuote(comment, doc) {
  if (comment?.quote) return String(comment.quote).replace(/\s+/g, ' ').trim();
  const range = isCodeComment(comment) ? null : anchorRange(comment);
  if (!range) return '';
  return String(doc ?? '').slice(range.from, range.to).replace(/\s+/g, ' ').trim();
}

export function hasAnchorText(comment, doc) {
  const range = anchorRange(comment);
  if (!range || range.to <= range.from) return false;
  return String(doc ?? '').slice(range.from, range.to).length > 0;
}

export function anchorRange(comment) {
  if (!comment?.open || !comment.close || comment.open.to > comment.close.from) return null;
  return { from: comment.open.to, to: comment.close.from };
}

export function isCodeComment(comment) {
  return comment?.codeLines !== undefined;
}

function fenceStructure(doc, fenceStart, fenceEnd) {
  const openLineEnd = doc.indexOf('\n', fenceStart);
  if (openLineEnd < 0 || openLineEnd >= fenceEnd) return { fenceStart, fenceEnd, lines: [] };
  const contentStart = openLineEnd + 1;
  const closingLineStart = doc.lastIndexOf('\n', fenceEnd - 1) + 1;
  const contentEnd = closingLineStart - 1;
  if (contentEnd <= contentStart) return { fenceStart, fenceEnd, lines: [] };
  const lines = [];
  let cursor = contentStart;
  for (const text of doc.slice(contentStart, contentEnd).split('\n')) {
    lines.push({ text, from: cursor, to: cursor + text.length });
    cursor += text.length + 1;
  }
  return { fenceStart, fenceEnd, lines };
}

export function enclosingFence(doc, pos) {
  const range = fencedRanges(doc).find(([from, to]) => pos >= from && pos < to);
  return range ? fenceStructure(doc, range[0], range[1]) : null;
}

export function codeSelectionTarget(doc, from, to) {
  const fence = enclosingFence(doc, from);
  if (!fence || fence.lines.length === 0) return null;
  const lastChar = Math.max(from, to - 1);
  let first = -1;
  let last = -1;
  fence.lines.forEach((line, i) => {
    if (line.from <= lastChar && from <= line.to) {
      if (first < 0) first = i;
      last = i;
    }
  });
  if (first < 0) {
    first = 0;
    last = fence.lines.length - 1;
  }
  const selected = fence.lines.slice(first, last + 1);
  const firstLine = selected[0];
  const lastLine = selected[selected.length - 1];
  if (!firstLine || !lastLine) return null;
  return {
    fenceStart: fence.fenceStart,
    fenceEnd: fence.fenceEnd,
    range: { from: firstLine.from, to: lastLine.to },
    quote: selected.map((line) => line.text).join('\n'),
    codeLines: { from: first, to: last },
  };
}

export function resolveCodeAnchor(doc, comment) {
  if (!comment?.codeLines) return null;
  const anchor = anchorRange(comment);
  if (!anchor) return null;
  const range = fencedRanges(doc).find(([from, to]) => from >= anchor.from && to <= anchor.to);
  if (!range) return null;
  const { lines } = fenceStructure(doc, range[0], range[1]);
  if (!lines.length) return null;
  const rangeOf = (from, count) => {
    const firstLine = lines[from];
    const lastLine = lines[from + count - 1];
    if (!firstLine || !lastLine) return null;
    return {
      text: lines.slice(from, from + count).map((line) => line.text).join('\n'),
      range: { from: firstLine.from, to: lastLine.to },
    };
  };
  const quote = comment.quote;
  const span = comment.codeLines.to - comment.codeLines.from + 1;
  const fast = rangeOf(comment.codeLines.from, span);
  if (fast && (quote === undefined || fast.text === quote)) return fast.range;
  if (quote !== undefined) {
    const count = quote.split('\n').length;
    for (let i = 0; i + count <= lines.length; i += 1) {
      const candidate = rangeOf(i, count);
      if (candidate && candidate.text === quote) return candidate.range;
    }
  }
  return null;
}

function sanitizeToken(s) {
  return breakTerminator(s).replace(/\s+/g, '_');
}

function sanitizeQuote(s) {
  return breakTerminator(String(s).replace(/\s+/g, ' ').replace(/"/g, "'")).trim();
}

function serializeEntry(entry) {
  const who = entry.timestamp ? `${entry.author} (${entry.timestamp})` : entry.author;
  return `${breakTerminator(who)}: ${escapeText(breakTerminator(entry.text))}`;
}

export function serializeBlock(id, data) {
  const head = [`co:${id}`];
  if (data.author) head.push(`by:${canonicalAuthorKey(data.author)}`);
  if (data.createdAt) head.push(`at:${sanitizeToken(data.createdAt)}`);
  head.push(`status:${data.status || 'open'}`);
  if (data.quote) {
    const quote = data.codeLines ? encodeCodeQuote(data.quote) : sanitizeQuote(data.quote);
    head.push(`quote:"${quote}"`);
  }
  if (data.codeLines) {
    const { from, to } = data.codeLines;
    head.push(`line:${from === to ? from : `${from}-${to}`}`);
  }
  const lines = (data.thread || []).map(serializeEntry);
  const reactionLines = (data.reactions || [])
    .filter((reaction) => reaction.authors.length > 0)
    .map((reaction) => {
      const target = reaction.entry !== undefined && reaction.entry > 0 ? `@${reaction.entry} ` : '';
      return `+${target}${reaction.emoji} ${reaction.authors.map(escapeReactionAuthor).join(', ')}`;
    });
  const body = [...lines, ...reactionLines];
  const block = body.length ? `${body.join('\n')}\n` : '';
  return `<!--${head.join(' ')}\n${block}-->`;
}

export function toCommentData(comment) {
  return {
    author: comment.author,
    createdAt: comment.createdAt,
    status: comment.status || 'open',
    quote: comment.quote,
    codeLines: comment.codeLines,
    thread: comment.thread || [],
    reactions: comment.reactions || [],
  };
}

export function applyChanges(doc, changes) {
  const source = String(doc ?? '');
  const ordered = (changes || []).map((change, i) => ({ ...change, i }))
    .sort((a, b) => a.from - b.from || a.i - b.i);
  let out = '';
  let last = 0;
  for (const change of ordered) {
    out += source.slice(last, change.from) + (change.insert ?? '');
    last = Math.max(last, change.to);
  }
  return out + source.slice(last);
}

export function blockEnd(doc, pos) {
  const source = String(doc ?? '');
  const fences = fencedRanges(source);
  let lineEnd = source.indexOf('\n', pos);
  if (lineEnd === -1) return source.length;
  for (;;) {
    const nextStart = lineEnd + 1;
    const fence = fences.find(([fenceStart]) => fenceStart === nextStart);
    if (fence) {
      if (!hasClosingFence(source, fence[0])) return lineEnd;
      lineEnd = fence[1];
      if (lineEnd >= source.length) return source.length;
      continue;
    }
    let nextEnd = source.indexOf('\n', nextStart);
    if (nextEnd === -1) nextEnd = source.length;
    if (source.slice(nextStart, nextEnd).trim() === '') return lineEnd;
    lineEnd = nextEnd;
    if (nextEnd === source.length) return source.length;
  }
}

function indentColumns(text) {
  let columns = 0;
  for (const ch of String(text ?? '')) {
    if (ch === ' ') columns += 1;
    else if (ch === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

function lineAround(doc, pos) {
  const newline = doc.indexOf('\n', pos);
  const to = newline < 0 ? doc.length : newline;
  const from = pos > 0 ? doc.lastIndexOf('\n', pos - 1) + 1 : 0;
  return { from, to: to > from && pos < to && doc.charAt(to - 1) === '\r' ? to - 1 : to };
}

function peelContainers(line) {
  const quoteRe = /^[ \t]*>[ \t]?/;
  const listRe = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+(?:\[[^\]\n]\](?:[ \t]+|$))?|$)/;
  let end = 0;
  for (;;) {
    const rest = line.slice(end);
    const quote = quoteRe.exec(rest);
    const piece = quote ?? listRe.exec(rest);
    if (!piece) return end;
    end += piece[0].length;
  }
}

function leadingMarkup(line) {
  const end = peelContainers(line);
  const rest = line.slice(end);
  const heading = /^[ \t]*#{1,6}(?:[ \t]+|$)/.exec(rest);
  if (heading) return { end: end + heading[0].length, heading: true };
  const indent = /^[ \t]*/.exec(line.slice(end))?.[0].length ?? 0;
  return { end: end + indent, heading: false };
}

function showsText(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim() !== '';
}

export function needsMarkerGuard(doc, pos) {
  const line = lineAround(doc, pos);
  const markup = leadingMarkup(doc.slice(line.from, line.to));
  const rest = doc.slice(pos, line.to);
  if (pos !== line.from + markup.end || markup.heading || !showsText(rest) || rest.startsWith('<')) return false;
  return true;
}

function guardFor(doc, pos) {
  return needsMarkerGuard(doc, pos) ? MARKER_GUARD : '';
}

export function withGuard(doc, marker) {
  const source = typeof doc === 'string' ? doc : doc.sliceString(marker.from - 1, marker.from);
  const before = typeof doc === 'string' ? doc.charAt(marker.from - 1) : source;
  return marker.from > 0 && before === MARKER_GUARD ? { from: marker.from - 1, to: marker.to } : { from: marker.from, to: marker.to };
}

function isOwnLine(text, marker) {
  return (marker.from === 0 || text.charCodeAt(marker.from - 1) === 10)
    && (marker.to === text.length || text.charCodeAt(marker.to) === 10);
}

function isQuoteLine(line) {
  return /^[ \t]*>/.test(line) || /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+>/.test(line);
}

export function bodyHideRange(text, body) {
  let from = body.from;
  if (from > 0 && text.charCodeAt(from - 1) === 10) from -= 1;
  return { from, to: body.to };
}

export function commentHideRanges(doc) {
  const text = String(doc ?? '');
  const comments = parseComments(text);
  const ranges = [];
  const add = (from, to, kind, block = false) => {
    if (to > from) ranges.push({ from, to, kind, block });
  };
  for (const comment of comments) {
    const code = isCodeComment(comment);
    if (comment.open) {
      if (code && isOwnLine(text, comment.open)) add(comment.open.from, comment.open.to, 'open', true);
      else {
        const range = withGuard(text, comment.open);
        add(range.from, range.to, 'open');
      }
    }
    if (comment.close) {
      if (code && isOwnLine(text, comment.close)) add(comment.close.from, comment.close.to, 'close', true);
      else {
        const range = withGuard(text, comment.close);
        add(range.from, range.to, 'close');
      }
    }
    if (comment.body) {
      if (code && isOwnLine(text, comment.body)) add(comment.body.from, comment.body.to, 'body', true);
      else {
        const line = lineAround(text, comment.body.from);
        const quote = isQuoteLine(text.slice(line.from, line.to))
          || (comment.body.from > 0 && isQuoteLine(text.slice(lineAround(text, comment.body.from - 1).from, lineAround(text, comment.body.from - 1).to)));
        if (quote) add(comment.body.from, comment.body.to, 'body', isOwnLine(text, comment.body));
        else if (isOwnLine(text, comment.body) || text.slice(comment.body.from, comment.body.to).includes('\n')) {
          add(comment.body.from, comment.body.to, 'body', true);
        } else {
          add(comment.body.from, comment.body.to, 'body');
        }
      }
    }
  }
  return ranges.sort((a, b) => a.from - b.from || b.to - a.to);
}

export function commentHighlights(doc, { showResolved = false } = {}) {
  const text = String(doc ?? '');
  const out = [];
  for (const comment of parseComments(text)) {
    if (comment.status === 'resolved' && !showResolved) continue;
    const range = isCodeComment(comment) ? resolveCodeAnchor(text, comment) : anchorRange(comment);
    if (range && range.to > range.from) {
      out.push({
        from: range.from,
        to: range.to,
        id: comment.id,
        status: comment.status || 'open',
      });
    }
  }
  return out;
}

export function openCommentCount(doc) {
  return parseComments(doc).filter((comment) => comment.body && comment.status !== 'resolved').length;
}

function commentPieces(text, comments) {
  const pieces = [];
  for (const comment of comments) {
    if (comment.open) pieces.push({ ...withGuard(text, comment.open), kind: 'marker', id: comment.id, role: 'open' });
    if (comment.close) pieces.push({ ...withGuard(text, comment.close), kind: 'marker', id: comment.id, role: 'close' });
    if (comment.body) pieces.push({ ...bodyHideRange(text, comment.body), kind: 'body', id: comment.id, role: 'body' });
  }
  return pieces.sort((a, b) => a.from - b.from);
}

function overlaps(a, b) {
  return a.from < b.to && b.from < a.to;
}

function covers(edit, piece) {
  return edit.from <= piece.from && edit.to >= piece.to;
}

export function stripCommentMarkup(doc, { wrap = false, showResolved = false } = {}) {
  const source = String(doc ?? '');
  const comments = parseComments(source);
  const ops = [];
  for (const comment of comments) {
    const highlight = wrap && (comment.status !== 'resolved' || showResolved) && isAnchored(comment);
    if (comment.open) {
      const range = withGuard(source, comment.open);
      ops.push({
        from: range.from,
        to: comment.open.to,
        insert: highlight ? PREVIEW_OPEN(comment.id, comment.status === 'resolved') : '',
      });
    }
    if (comment.close) {
      ops.push({
        from: comment.close.from,
        to: withGuard(source, comment.close).to === comment.close.to
          ? comment.close.to
          : comment.close.to,
        insert: highlight ? PREVIEW_CLOSE(comment.id) : '',
      });
    }
    if (comment.body) {
      const range = bodyHideRange(source, comment.body);
      ops.push({ from: range.from, to: range.to, insert: '' });
    }
  }
  ops.sort((a, b) => b.from - a.from || a.to - b.to);
  let out = source;
  for (const op of ops) out = out.slice(0, op.from) + op.insert + out.slice(op.to);
  return out;
}

export function previewOpenSentinel(id) {
  return PREVIEW_OPEN(id);
}

export function previewCloseSentinel(id) {
  return PREVIEW_CLOSE(id);
}

export function clipboardTextForRange(doc, from, to) {
  const source = String(doc ?? '');
  const start = Math.max(0, from);
  const end = Math.max(start, to);
  const cuts = [];
  for (const mark of commentMarkup(source)) {
    if (mark.to <= start || mark.from >= end) continue;
    let cutFrom = Math.max(mark.from, start);
    if (mark.kind !== 'body' && cutFrom > start && source.charAt(cutFrom - 1) === MARKER_GUARD) cutFrom -= 1;
    cuts.push({ from: cutFrom, to: Math.min(mark.to, end) });
  }
  cuts.sort((a, b) => a.from - b.from);
  let out = '';
  let at = start;
  for (const cut of cuts) {
    if (cut.from > at) out += source.slice(at, cut.from);
    at = Math.max(at, cut.to);
  }
  return out + source.slice(at, end);
}

function scanAll(doc, re, fn) {
  let match;
  const pattern = new RegExp(re.source, 'g');
  while ((match = pattern.exec(doc))) fn(match.index, match.index + match[0].length);
}

function leadingTerm(doc, pos) {
  return doc.charCodeAt(pos - 1) === 10 ? (doc.charCodeAt(pos - 2) === 13 ? 2 : 1) : 0;
}

function trailingTerm(doc, pos) {
  return doc.charCodeAt(pos) === 13 && doc.charCodeAt(pos + 1) === 10 ? 2 : doc.charCodeAt(pos) === 10 ? 1 : 0;
}

function replaceBody(doc, id, mutate) {
  const comment = parseComments(doc).find((item) => item.id === id);
  if (!comment) return err('Comment not found.');
  if (!comment.body) return err('Comment has no body to update.');
  const data = mutate(comment);
  if (!data) return err('That reply no longer exists.');
  return ok([{ from: comment.body.from, to: comment.body.to, insert: serializeBlock(id, data) }]);
}

function toggleReactions(reactions, entry, emoji, author) {
  const out = (reactions || []).map((reaction) => ({ ...reaction, authors: [...reaction.authors] }));
  const existing = out.find((reaction) => (reaction.entry ?? 0) === entry && reaction.emoji === emoji);
  if (existing) {
    const idx = existing.authors.indexOf(author);
    if (idx >= 0) existing.authors.splice(idx, 1);
    else existing.authors.push(author);
  } else {
    out.push(entry === 0 ? { emoji, authors: [author] } : { emoji, authors: [author], entry });
  }
  return out.filter((reaction) => reaction.authors.length > 0);
}

function reactionsAfterEntryDelete(reactions, deletedEntry) {
  return (reactions || []).flatMap((reaction) => {
    const entry = reaction.entry ?? 0;
    if (entry === deletedEntry) return [];
    const nextEntry = entry > deletedEntry ? entry - 1 : entry;
    const copied = { emoji: reaction.emoji, authors: [...reaction.authors] };
    return [nextEntry === 0 ? copied : { ...copied, entry: nextEntry }];
  });
}

function sourceLines(doc) {
  const lines = [];
  let from = 0;
  for (const text of String(doc ?? '').split('\n')) {
    lines.push({ text, from, to: from + text.length });
    from += text.length + 1;
  }
  return lines;
}

function lineIndexAt(lines, pos) {
  return lines.findIndex((line) => pos >= line.from && pos <= line.to);
}

function unescapedPipes(line) {
  const pipes = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== '|') continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j -= 1) slashes += 1;
    if (slashes % 2 === 0) pipes.push(i);
  }
  return pipes;
}

function backtickRun(doc, from, limit) {
  let to = from;
  while (to < limit && doc.charAt(to) === '`') to += 1;
  return to - from;
}

function isEscapedAt(doc, position) {
  let slashes = 0;
  for (let cursor = position - 1; cursor >= 0 && doc.charAt(cursor) === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

export function expandInlineCodeSelection(doc, from, to) {
  const lineFrom = doc.lastIndexOf('\n', from - 1) + 1;
  const nextLine = doc.indexOf('\n', to);
  const lineTo = nextLine < 0 ? doc.length : nextLine;
  let start = from;
  let end = to;
  for (let open = lineFrom; open < lineTo; open += 1) {
    if (doc.charAt(open) !== '`' || isEscapedAt(doc, open)) continue;
    const ticks = backtickRun(doc, open, lineTo);
    const contentFrom = open + ticks;
    let cursor = contentFrom;
    while (cursor < lineTo) {
      const candidate = doc.indexOf('`', cursor);
      if (candidate < 0 || candidate >= lineTo) break;
      const closeTicks = backtickRun(doc, candidate, lineTo);
      if (closeTicks === ticks && !isEscapedAt(doc, candidate)) {
        const close = candidate + closeTicks;
        if (from > open && from < close) start = open;
        if (to > open && to < close) end = close;
        open = close - 1;
        break;
      }
      cursor = candidate + closeTicks;
    }
  }
  return { from: start, to: end };
}

function outOfWikilinks(doc, from, to) {
  const links = [...doc.matchAll(/!?\[\[[^\]\n]*\]\]/g)].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
  }));
  const holding = (pos) => (link) => pos > link.from && pos < link.to;
  return {
    from: links.find(holding(from))?.from ?? from,
    to: links.find(holding(to))?.to ?? to,
  };
}

function textStart(doc, from) {
  const line = lineAround(doc, from);
  const lineText = doc.slice(line.from, line.to);
  if (!lineText.trim()) return line.from;
  const markup = leadingMarkup(lineText);
  const text = line.from + markup.end;
  if (from > text) return from;
  return doc.charAt(text) === MARKER_GUARD ? text + 1 : text;
}

export function anchorOffBlockMarkup(doc, from, to) {
  const start = textStart(doc, from);
  if (start >= to) return { from: start, to: start };
  const line = lineAround(doc, to);
  const lineText = doc.slice(line.from, line.to);
  let end = to;
  const markup = leadingMarkup(lineText);
  const textCol = line.from + markup.end;
  if (!lineText.trim() || to <= textCol) {
    const trimmed = doc.slice(start, line.from).trimEnd();
    end = start + trimmed.length;
  }
  const code = expandInlineCodeSelection(doc, start, end);
  return outOfWikilinks(doc, code.from, code.to);
}

function cellBounds(line) {
  const pipes = unescapedPipes(line.text);
  const first = pipes[0];
  const last = pipes[pipes.length - 1];
  const start = first !== undefined && first === line.text.search(/\S/) ? first + 1 : 0;
  const end = last !== undefined && line.text.slice(last + 1).trim() === ''
    ? last
    : line.text.length;
  return { from: line.from + start, to: line.from + Math.max(start, end) };
}

function tableAt(lines, index) {
  for (let start = 0; start + 1 < lines.length; start += 1) {
    const head = lines[start];
    const delimiter = lines[start + 1];
    if (!head || !delimiter || !isTableRow(head.text) || !isTableSep(delimiter.text)) continue;
    let end = start + 2;
    while (end < lines.length && isTableRow(lines[end].text) && !isTableSep(lines[end].text)) end += 1;
    if (index >= start && index < end) return { start, end };
    start = end - 1;
  }
  return null;
}

function looksLikeTableRow(line) {
  return unescapedPipes(line).length >= 1 && /[^\s|]/.test(line);
}

export function clampToTableCells(doc, from, to) {
  if (to <= from) return { from, to };
  const lines = sourceLines(doc);
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    const table = tableAt(lines, i);
    if (table && !tables.some((item) => item.start === table.start)) tables.push(table);
  }
  if (!tables.length) return { from, to };
  const fromIndex = lineIndexAt(lines, from);
  const toIndex = lineIndexAt(lines, to);
  const head = tables.find((table) => fromIndex >= table.start && fromIndex < table.end);
  const tail = tables.find((table) => toIndex >= table.start && toIndex < table.end);
  if (!head && !tail) return { from, to };
  const start = head ? cellBounds(lines[fromIndex]).from : from;
  const endLine = tail ? lines[toIndex] : lines[fromIndex];
  const end = tail && endLine ? cellBounds(endLine).to : to;
  if (end <= start) return { from, to: from };
  return { from: start, to: end };
}

export function isInTableBody(doc, pos) {
  const lines = sourceLines(doc);
  const index = lineIndexAt(lines, pos);
  if (index < 0) return false;
  const table = tableAt(lines, index);
  if (table) return index !== table.start + 1;
  const text = lines[index].text;
  if (!looksLikeTableRow(text) || isTableSep(text)) return false;
  const prev = lines[index - 1]?.text;
  const next = lines[index + 1]?.text;
  if (prev && (isTableSep(prev) || (looksLikeTableRow(prev) && /-/.test(prev)))) return true;
  return false;
}

export function anchorSelection(doc, from, to) {
  return anchorOffBlockMarkup(doc, ...Object.values(clampToTableCells(doc, from, to)));
}

export function commentTargetRange(doc, from, to) {
  const source = String(doc ?? '');
  let start = from;
  let end = to;
  if (end < start) [start, end] = [end, start];
  if (end === start) {
    const line = lineAround(source, start);
    const range = anchorOffBlockMarkup(source, line.from, line.to);
    if (range.to <= range.from) return err('There is no text on this line to comment on.');
    start = range.from;
    end = range.to;
  }
  const anchored = anchorSelection(source, start, end);
  if (anchored.to <= anchored.from) return err('Select some text to comment on.');
  return { from: anchored.from, to: anchored.to, expected: source.slice(anchored.from, anchored.to) };
}

export function canCreateComment(doc, from, to) {
  const source = String(doc ?? '');
  const range = commentTargetRange(source, from, to);
  if (range.error) return false;
  if (isInFencedCode(source, range.from) || isInFencedCode(source, range.to - 1)) return false;
  if (isInside(indentedCodeRanges(source), range.from) || isInside(indentedCodeRanges(source), range.to - 1)) return false;
  if (isInTableBody(source, range.from) || isInTableBody(source, range.to - 1)) return false;
  return true;
}

export function findHighlightAtSelection(doc, from, to) {
  let start = from;
  let end = to;
  if (end < start) [start, end] = [end, start];
  if (end === start) return null;
  const comments = parseComments(doc).filter(isHighlight);
  const at = (a, b) => comments.find((comment) => {
    if (isCodeComment(comment)) return false;
    const range = anchorRange(comment);
    return range && range.from === a && range.to === b;
  });
  const exact = at(start, end);
  if (exact) return exact;
  const anchored = anchorSelection(doc, start, end);
  return at(anchored.from, anchored.to) ?? null;
}

export function reactionsForEntry(comment, index) {
  const grouped = new Map();
  for (const reaction of comment.reactions || []) {
    const entry = reaction.entry ?? 0;
    if (entry !== index) continue;
    const row = grouped.get(reaction.emoji) || { emoji: reaction.emoji, authors: [], count: 0 };
    row.authors = [...reaction.authors];
    row.count = row.authors.length;
    grouped.set(reaction.emoji, row);
  }
  return [...grouped.values()];
}

export function addComment(doc, from, to, input) {
  const source = String(doc ?? '');
  if (input.targetHighlightId) {
    const target = parseComments(source).find((item) => item.id === input.targetHighlightId);
    if (!target?.body || !isAnchored(target)) return err('The empty comment no longer exists.');
    if (input.text) {
      return reply(source, target.id, {
        author: input.author,
        createdAt: input.createdAt,
        text: input.text,
      });
    }
    if (target.thread.length > 0) return err('The empty comment now has text. Open the comment to make changes.');
    return deleteComment(source, target.id);
  }
  const target = commentTargetRange(source, from, to);
  if (target.error) return err(target.error);
  let start = target.from;
  let end = target.to;
  if (input.expected !== undefined && source.slice(start, end) !== input.expected) {
    return err('The selection moved — try adding the comment again.');
  }
  const highlight = findHighlightAtSelection(source, start, end);
  if (highlight) {
    return input.text
      ? reply(source, highlight.id, {
        author: input.author,
        createdAt: input.createdAt,
        text: input.text,
      })
      : deleteComment(source, highlight.id);
  }
  if (!input.text && input.allowEmpty === false) return ok([]);
  if (isInFencedCode(source, start) || isInFencedCode(source, end - 1)) {
    const target = codeSelectionTarget(source, start, end);
    if (!target) return err("Couldn't map that selection to code lines.");
    if (!hasClosingFence(source, target.fenceStart)) return err('Close the code block before commenting on it.');
    const data = {
      author: input.author,
      createdAt: input.createdAt,
      status: 'open',
      quote: target.quote,
      codeLines: target.codeLines,
      thread: input.text ? [{ author: input.author, timestamp: input.createdAt, text: input.text }] : [],
      reactions: [],
    };
    return ok([
      { from: target.fenceStart, to: target.fenceStart, insert: `${openMarker(input.id)}\n` },
      {
        from: target.fenceEnd,
        to: target.fenceEnd,
        insert: `\n${closeMarker(input.id)}\n${serializeBlock(input.id, data)}`,
      },
    ]);
  }
  const quote = source.slice(start, end);
  const data = {
    author: input.author,
    createdAt: input.createdAt,
    status: 'open',
    quote,
    thread: input.text ? [{ author: input.author, timestamp: input.createdAt, text: input.text }] : [],
    reactions: [],
  };
  const paraEnd = blockEnd(source, end);
  return ok([
    { from: start, to: start, insert: guardFor(source, start) + openMarker(input.id) },
    { from: end, to: end, insert: guardFor(source, end) + closeMarker(input.id) },
    { from: paraEnd, to: paraEnd, insert: `\n${serializeBlock(input.id, data)}` },
  ]);
}

export function reply(doc, id, entry) {
  return replaceBody(doc, id, (comment) => ({
    ...toCommentData(comment),
    thread: [...comment.thread, { author: entry.author, timestamp: entry.createdAt, text: entry.text }],
  }));
}

export function setStatus(doc, id, status) {
  const resolved = status === true || status === 'resolved';
  return replaceBody(doc, id, (comment) => ({ ...toCommentData(comment), status: resolved ? 'resolved' : 'open' }));
}

export function editEntry(doc, id, index, text) {
  return replaceBody(doc, id, (comment) => {
    if (index < 0 || index >= comment.thread.length) return null;
    return {
      ...toCommentData(comment),
      thread: comment.thread.map((entry, i) => (i === index ? { ...entry, text } : entry)),
    };
  });
}

export function deleteEntry(doc, id, index) {
  return replaceBody(doc, id, (comment) => {
    if (index < 0 || index >= comment.thread.length) return null;
    return {
      ...toCommentData(comment),
      thread: comment.thread.filter((_, i) => i !== index),
      reactions: reactionsAfterEntryDelete(comment.reactions, index),
    };
  });
}

export function toggleReaction(doc, id, { entry = 0, emoji, author }) {
  return replaceBody(doc, id, (comment) => {
    const entryCount = Math.max(1, comment.thread.length);
    if (!Number.isSafeInteger(entry) || entry < 0 || entry >= entryCount) return null;
    return { ...toCommentData(comment), reactions: toggleReactions(comment.reactions, entry, emoji, author) };
  });
}

export function deleteComment(doc, id) {
  const source = String(doc ?? '');
  const comment = parseComments(source).find((item) => item.id === id);
  if (!comment) return err('Comment not found.');
  const ranges = [];
  const ownLines = isCodeComment(comment);
  const aloneOnLine = (from, to) => ownLines && (from === 0 || leadingTerm(source, from) > 0)
    && (to === source.length || trailingTerm(source, to) > 0);
  scanAll(source, new RegExp(`<!--c:${id}-->`), (from, to) => {
    const end = aloneOnLine(from, to) ? to + trailingTerm(source, to) : to;
    ranges.push({ from, to: end, insert: '' });
  });
  scanAll(source, new RegExp(`<!--/c:${id}-->`), (from, to) => {
    const start = aloneOnLine(from, to) ? from - leadingTerm(source, from) : from;
    ranges.push({ from: start, to, insert: '' });
  });
  const markers = ranges.length;
  scanAll(source, new RegExp(`<!--co:${id}(?![A-Za-z0-9])[\\s\\S]*?-->`), (from, to) => {
    ranges.push({ from: from - leadingTerm(source, from), to, insert: '' });
  });
  if (!ranges.length) return err('Nothing to delete.');
  const pastRemoved = (pos) => {
    const next = ranges.find((range) => range.from === pos && range.to > pos);
    return next ? pastRemoved(next.to) : pos;
  };
  const guarded = ranges.map((range, index) => {
    if (index >= markers || source.charAt(range.from - 1) !== MARKER_GUARD) return range;
    const next = pastRemoved(range.to);
    return source.startsWith('<!--c:', next) || source.startsWith('<!--/c:', next)
      ? range
      : { ...range, from: range.from - 1 };
  });
  guarded.sort((a, b) => a.from - b.from);
  return ok(guarded);
}

export function reanchor(doc, id, from, to) {
  const source = String(doc ?? '');
  const comment = parseComments(source).find((item) => item.id === id);
  if (!comment) return err('Comment not found.');
  let start = from;
  let end = to;
  if (end < start) [start, end] = [end, start];
  if (end === start) return err('Select some text to comment on.');
  const removals = [];
  if (comment.open) {
    const range = withGuard(source, comment.open);
    removals.push({ from: range.from, to: comment.open.to, insert: '' });
  }
  if (comment.close) removals.push({ from: comment.close.from, to: comment.close.to, insert: '' });
  if (comment.body) removals.push({ from: comment.body.from, to: comment.body.to, insert: '' });
  const mapFromOrig = (pos) => pos - removals.reduce((gone, change) => gone + Math.max(0, Math.min(pos, change.to) - change.from), 0);
  const mapToOrig = (posStripped) => {
    const sorted = [...removals].sort((a, b) => a.from - b.from);
    let orig = 0;
    let stripped = 0;
    let cut = 0;
    while (stripped < posStripped) {
      while (cut < sorted.length && orig === sorted[cut].from) {
        orig = sorted[cut].to;
        cut += 1;
      }
      orig += 1;
      stripped += 1;
    }
    while (cut < sorted.length && orig === sorted[cut].from) {
      orig = sorted[cut].to;
      cut += 1;
    }
    return orig;
  };
  const stripped = applyChanges(source, removals);
  const nextFrom = mapFromOrig(start);
  const nextTo = mapFromOrig(end);
  const quote = stripped.slice(nextFrom, nextTo);
  const data = { ...toCommentData(comment), quote };
  const paraEnd = blockEnd(stripped, nextTo);
  const inserts = [
    { from: mapToOrig(nextFrom), to: mapToOrig(nextFrom), insert: guardFor(stripped, nextFrom) + openMarker(id) },
    { from: mapToOrig(nextTo), to: mapToOrig(nextTo), insert: guardFor(stripped, nextTo) + closeMarker(id) },
    { from: mapToOrig(paraEnd), to: mapToOrig(paraEnd), insert: `\n${serializeBlock(id, data)}` },
  ];
  return ok([...removals, ...inserts].sort((a, b) => a.from - b.from));
}

function remapInsertAtEdges(text, comments, from, insert) {
  for (const comment of comments) {
    const open = comment.open && withGuard(text, comment.open);
    const close = comment.close && withGuard(text, comment.close);
    if (open && from === open.to) return { from: open.from, insert };
    if (close && from === close.from) return { from: close.to, insert };
  }
  return null;
}

function shouldKeepPiece(edit, piece, comments, text) {
  if (!overlaps(edit, piece)) return false;
  if (covers(edit, piece) && piece.kind === 'marker') {
    const comment = comments.find((item) => item.id === piece.id);
    const range = comment && anchorRange(comment);
    const deletedAnchor = range && edit.from <= range.from && edit.to >= range.to;
    if (deletedAnchor) return false;
    return true;
  }
  if (covers(edit, piece) && piece.kind === 'body') {
    const comment = comments.find((item) => item.id === piece.id);
    const range = comment && anchorRange(comment);
    const deletedAnchor = range && edit.from <= withGuard(text, comment.open || range).from
      && edit.to >= (comment.close ? comment.close.to : range.to);
    if (deletedAnchor && edit.to - edit.from > piece.to - piece.from) return false;
    return true;
  }
  return true;
}

export function protectCommentChanges(doc, edits, comments = parseComments(doc)) {
  const text = String(doc ?? '');
  const pieces = commentPieces(text, comments);
  const corrections = [];
  for (const edit of edits) {
    if (edit.from === edit.to && edit.insert) {
      const moved = remapInsertAtEdges(text, comments, edit.from, edit.insert);
      if (moved && moved.from !== edit.from) {
        corrections.push({ from: edit.from, to: edit.to, insert: '' });
        corrections.push({ from: moved.from, to: moved.from, insert: moved.insert });
        continue;
      }
    }
    for (const piece of pieces) {
      if (!shouldKeepPiece(edit, piece, comments, text)) continue;
      const overlapFrom = Math.max(piece.from, edit.from);
      const overlapTo = Math.min(piece.to, edit.to);
      if (overlapTo <= overlapFrom) continue;
      const kept = text.slice(overlapFrom, overlapTo);
      const at = overlapFrom < edit.from ? edit.from : edit.from + (edit.insert ? edit.insert.length : 0);
      corrections.push({
        from: at,
        to: at,
        insert: kept,
        originalFrom: overlapFrom,
        originalTo: overlapTo,
      });
    }
  }
  return corrections;
}

export function applyProtectedEdit(doc, edit, comments) {
  const source = String(doc ?? '');
  const parsed = comments || parseComments(source);
  if (edit.from === edit.to && edit.insert) {
    const moved = remapInsertAtEdges(source, parsed, edit.from, edit.insert);
    if (moved) return applyChanges(source, [{ from: moved.from, to: moved.from, insert: moved.insert }]);
  }
  const next = applyChanges(source, [edit]);
  const mapPos = (pos) => {
    if (pos <= edit.from) return pos;
    if (pos >= edit.to) return pos - (edit.to - edit.from) + (edit.insert ? edit.insert.length : 0);
    return edit.from + (edit.insert ? edit.insert.length : 0);
  };
  const pieces = commentPieces(source, parsed);
  const reinserts = [];
  for (const piece of pieces) {
    if (!shouldKeepPiece(edit, piece, parsed, source)) continue;
    const overlapFrom = Math.max(piece.from, edit.from);
    const overlapTo = Math.min(piece.to, edit.to);
    if (overlapTo <= overlapFrom) continue;
    reinserts.push({ from: mapPos(overlapFrom), to: mapPos(overlapFrom), insert: source.slice(overlapFrom, overlapTo) });
  }
  return applyChanges(next, reinserts.sort((a, b) => a.from - b.from));
}

export function commentsAtPos(doc, pos) {
  const text = String(doc ?? '');
  return parseComments(text).filter((comment) => {
    const range = isCodeComment(comment) ? resolveCodeAnchor(text, comment) : anchorRange(comment);
    return range && pos >= range.from && pos <= range.to;
  });
}

export const AUTHOR_BUBBLE_HUES = [210, 265, 330, 28, 155, 52];

export function authorBubbleHue(author) {
  let hash = 0;
  const name = String(author ?? '').trim().toLowerCase();
  for (let i = 0; i < name.length; i += 1) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return AUTHOR_BUBBLE_HUES[Math.abs(hash) % AUTHOR_BUBBLE_HUES.length];
}

export function authorInitial(author) {
  const text = String(author ?? 'me').trim();
  return (text[0] || '?').toUpperCase();
}

export function authorsMatch(left, right) {
  return String(left ?? 'me').trim().toLowerCase() === String(right ?? 'me').trim().toLowerCase();
}

export function commentSeenStamp(comment) {
  let best = '';
  for (const entry of comment?.thread || []) {
    if (entry.timestamp && (!best || entry.timestamp > best)) best = entry.timestamp;
  }
  return best || new Date(0).toISOString();
}

export function entryIsUnread(entry, lastSeenIso) {
  const stamp = Date.parse(entry?.timestamp);
  const seen = Date.parse(lastSeenIso);
  if (!Number.isFinite(stamp)) return false;
  if (!Number.isFinite(seen)) return true;
  return stamp > seen;
}

export function commentHasUnread(comment, lastSeenIso) {
  return (comment?.thread || []).some((entry) => entryIsUnread(entry, lastSeenIso));
}

export function firstUnreadIndex(comment, lastSeenIso) {
  const entries = comment?.thread || [];
  for (let i = 0; i < entries.length; i += 1) {
    if (entryIsUnread(entries[i], lastSeenIso)) return i;
  }
  return -1;
}

export function relativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso || '';
  const delta = Math.max(0, now - then);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < 45 * 1000) return 'just now';
  if (delta < 60 * minute) return `${Math.max(1, Math.round(delta / minute))}m`;
  if (delta < 22 * hour) return `${Math.max(1, Math.round(delta / hour))}h`;
  if (delta < 36 * hour) return 'yesterday';
  const date = new Date(then);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

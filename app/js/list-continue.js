// Enter continues a list or quote, and Tab nests it. Pure text in, a
// CodeMirror-style change out. Bytes outside the touched lines stay the
// same, including a CRLF file's `\r` on every line.

import { closesFence, parseFenceLine } from './checklist.js';

const ITEM = /^([ \t]*)((?:>[ \t]*)*)(?:([-*+])([ \t]+)(?:\[([ xX])\]([ \t]*))?|(\d+)([.)])([ \t]+))?(.*)$/;

export function lineAt(text, pos) {
  const source = String(text ?? '');
  const start = source.lastIndexOf('\n', pos - 1) + 1;
  const nl = source.indexOf('\n', pos);
  const end = nl < 0 ? source.length : nl;
  return { start, end, text: source.slice(start, end) };
}

export function inFence(text, pos) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  let offset = 0;
  let open = null;
  for (const line of lines) {
    const end = offset + line.length;
    const fence = parseFenceLine(line);
    if (!open && fence) {
      if (pos >= offset && pos <= end) return true;
      open = fence;
    } else if (open && closesFence(line, open)) {
      if (pos >= offset && pos <= end) return true;
      open = null;
    } else if (open && pos >= offset && pos <= end) {
      return true;
    }
    offset = end + 1;
  }
  return false;
}

export function parseItem(line) {
  const raw = String(line ?? '');
  const cr = raw.endsWith('\r') ? '\r' : '';
  const body = cr ? raw.slice(0, -1) : raw;
  const match = ITEM.exec(body);
  const indent = match ? match[1] : '';
  const quote = match ? match[2] : '';
  const bullet = match && match[3] ? match[3] : '';
  const bulletGap = match && match[4] ? match[4] : '';
  const taskMark = match ? match[5] : undefined;
  const taskGap = match && match[6] != null ? match[6] : '';
  const number = match && match[7] ? match[7] : '';
  const numberDelim = match && match[8] ? match[8] : '';
  const numberGap = match && match[9] ? match[9] : '';
  const rest = match ? match[10] : body;
  let kind = 'none';
  if (taskMark != null) kind = 'task';
  else if (bullet) kind = 'bullet';
  else if (number) kind = 'numbered';
  else if (quote) kind = 'quote';
  const marker = markerText({
    kind, bullet, bulletGap, taskMark, taskGap, number, numberDelim, numberGap,
  });
  return {
    indent,
    quote,
    bullet,
    bulletGap,
    taskMark,
    taskGap,
    number,
    numberDelim,
    numberGap,
    rest,
    kind,
    cr,
    body,
    marker,
    markerEnd: indent.length + quote.length + marker.length,
    empty: rest.trim() === '',
    hasMarker: kind === 'task' || kind === 'bullet' || kind === 'numbered',
  };
}

function markerText(item) {
  if (item.kind === 'task') {
    const mark = item.taskMark == null ? ' ' : item.taskMark;
    return `${item.bullet}${item.bulletGap}[${mark}]${item.taskGap}`;
  }
  if (item.kind === 'bullet') return `${item.bullet}${item.bulletGap}`;
  if (item.kind === 'numbered') return `${item.number}${item.numberDelim}${item.numberGap}`;
  return '';
}

export function continuePrefix(item, { step = 0 } = {}) {
  const head = `${item.indent}${item.quote}`;
  if (item.kind === 'task') {
    const gap = item.taskGap || ' ';
    return `${head}${item.bullet}${item.bulletGap}[ ]${gap}`;
  }
  if (item.kind === 'bullet') return `${head}${item.bullet}${item.bulletGap}`;
  if (item.kind === 'numbered') {
    const n = String(Number(item.number) + step);
    return `${head}${n}${item.numberDelim}${item.numberGap}`;
  }
  if (item.quote) return head;
  return null;
}

export function indentBody(body, dir) {
  const text = String(body ?? '');
  if (dir > 0) {
    const lead = text.match(/^([ \t]*)/)[1];
    if (lead.includes('\t')) return `\t${text}`;
    return `  ${text}`;
  }
  if (text.startsWith('\t')) return text.slice(1);
  if (text.startsWith('  ')) return text.slice(2);
  if (text.startsWith(' ')) return text.slice(1);
  return text;
}

function dropQuoteLevel(quote) {
  return String(quote || '').replace(/>[ \t]*$/, '');
}

function change(from, to, insert, caret, head = caret) {
  return { from, to, insert, selection: { anchor: caret, head } };
}

function followingNumbered(text, afterEnd, item) {
  const source = String(text);
  let pos = afterEnd + (source[afterEnd] === '\n' ? 1 : 0);
  const rows = [];
  while (pos <= source.length) {
    if (pos > source.length) break;
    const line = lineAt(source, Math.min(pos, source.length));
    if (pos > line.start) break;
    const parsed = parseItem(line.text);
    if (parsed.kind !== 'numbered') break;
    if (parsed.indent !== item.indent || parsed.quote !== item.quote) break;
    if (parsed.numberDelim !== item.numberDelim) break;
    rows.push({ line, parsed });
    if (line.end >= source.length) break;
    pos = line.end + 1;
  }
  return rows;
}

function simpleRenumber(rows, expectedFirst) {
  if (!rows.length) return null;
  let expected = expectedFirst;
  for (const row of rows) {
    if (Number(row.parsed.number) !== expected) return null;
    expected += 1;
  }
  return rows.map((row, i) => {
    const parsed = row.parsed;
    const n = String(expectedFirst + 1 + i);
    return `${parsed.indent}${parsed.quote}${n}${parsed.numberDelim}${parsed.numberGap}${parsed.rest}${parsed.cr}`;
  });
}

function spliceRenumber(source, insert, lineEnd, rows, shifted) {
  const last = rows[rows.length - 1].line.end;
  const between = source.slice(lineEnd, rows[0].line.start);
  return { insert: `${insert}${between}${shifted.join('\n')}`, to: last };
}

// Enter on a list or quote line. Null means the default newline should run.
export function continueEnter(text, from, to) {
  const source = String(text ?? '');
  const a = Math.max(0, Math.min(from, to, source.length));
  const b = Math.max(a, Math.min(Math.max(from, to), source.length));
  if (a !== b && lineAt(source, a).start !== lineAt(source, b).start) return null;
  if (inFence(source, a)) return null;

  const line = lineAt(source, a);
  const item = parseItem(line.text);
  if (item.kind === 'none') return null;

  const contentEnd = line.end - (item.cr ? 1 : 0);
  const caret = Math.min(Math.max(a, line.start), contentEnd);
  const cut = Math.min(Math.max(b, caret), contentEnd);
  const offset = caret - line.start;
  const restAfter = item.body.slice(cut - line.start);
  const emptyItem = item.body.slice(item.markerEnd, offset).trim() === '' && restAfter.trim() === '' && offset >= item.markerEnd;

  if (emptyItem && item.hasMarker) {
    if (item.indent) {
      const indent = indentBody(item.indent, -1);
      const insert = `${indent}${item.quote}${item.marker}${item.cr}`;
      const at = line.start + indent.length + item.quote.length + item.marker.length;
      return change(line.start, line.end, insert, at);
    }
    const insert = `${item.indent}${item.quote}${item.cr}`;
    const at = line.start + item.indent.length + item.quote.length;
    return change(line.start, line.end, insert, at);
  }

  if (emptyItem && item.kind === 'quote') {
    const quote = dropQuoteLevel(item.quote);
    const insert = `${item.indent}${quote}${item.cr}`;
    const at = line.start + item.indent.length + quote.length;
    return change(line.start, line.end, insert, at);
  }

  const prefix = continuePrefix(item, { step: item.kind === 'numbered' ? 1 : 0 });
  if (prefix == null) return null;

  const kept = item.body.slice(0, offset);
  const newLine = `${prefix}${restAfter}${item.cr}`;
  let insert = `${kept}${item.cr}\n${newLine}`;
  let toPos = line.end;
  const caretAt = line.start + kept.length + item.cr.length + 1 + prefix.length;

  if (item.kind === 'numbered') {
    const rows = followingNumbered(source, line.end, item);
    const shifted = simpleRenumber(rows, Number(item.number) + 1);
    if (shifted) {
      const extra = spliceRenumber(source, insert, line.end, rows, shifted);
      insert = extra.insert;
      toPos = extra.to;
    }
  }

  return change(line.start, toPos, insert, caretAt);
}

export function indentChange(text, from, to, dir) {
  const source = String(text ?? '');
  const a = Math.max(0, Math.min(from, to, source.length));
  const b = Math.max(a, Math.min(Math.max(from, to), source.length));
  const first = lineAt(source, a);
  const last = lineAt(source, b > a && source[b - 1] === '\n' ? b - 1 : b);
  const start = first.start;
  const end = last.end;
  const lines = source.slice(start, end).split('\n');
  let caretFrom = a;
  let caretTo = b;
  let changed = false;
  let offset = start;
  const next = lines.map((line) => {
    const cr = line.endsWith('\r') ? '\r' : '';
    const body = cr ? line.slice(0, -1) : line;
    const nextBody = indentBody(body, dir);
    const delta = nextBody.length - body.length;
    if (delta) changed = true;
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const shift = (pos) => {
      if (pos < lineStart) return pos;
      if (pos > lineEnd) return pos + delta;
      if (dir < 0) return Math.max(lineStart, pos + delta);
      return pos + delta;
    };
    caretFrom = shift(caretFrom);
    caretTo = shift(caretTo);
    offset = lineEnd + 1;
    return nextBody + cr;
  }).join('\n');
  if (!changed) return { noop: true };
  return change(start, end, next, caretFrom, caretTo);
}

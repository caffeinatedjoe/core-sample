// Markdown wrap, toggle and insert for the format toolbar. Pure text plus a
// selection in, a CodeMirror-style change out. Undo and redo are CodeMirror
// history commands, not edits here.

import { indentChange, lineAt, parseItem } from './list-continue.js';

export const FORMAT_ACTIONS = [
  'task',
  'bullet',
  'numbered',
  'bold',
  'italic',
  'link',
  'heading',
  'indent',
  'outdent',
  'quote',
  'code',
  'strike',
  'fence',
  'highlight',
  'rule',
  'undo',
  'redo',
];

function change(from, to, insert, anchor, head = anchor) {
  return { from, to, insert, selection: { anchor, head } };
}

function applyLine(text, from, to, rewrite) {
  const source = String(text ?? '');
  const a = Math.max(0, Math.min(from, to, source.length));
  const first = lineAt(source, a);
  const last = lineAt(source, Math.max(from, to, a));
  const start = first.start;
  const end = last.end;
  const lines = source.slice(start, end).split('\n');
  let caret = a;
  let offset = start;
  const next = lines.map((line) => {
    const rewritten = rewrite(line, offset);
    const delta = rewritten.text.length - line.length;
    if (caret >= offset && caret <= offset + line.length) {
      caret = rewritten.caret != null ? rewritten.caret : Math.max(offset, caret + delta);
    } else if (caret > offset + line.length) {
      caret += delta;
    }
    offset += line.length + 1;
    return rewritten.text;
  });
  return change(start, end, next.join('\n'), caret);
}

function stripWrap(selected, open, close) {
  if (selected.length >= open.length + close.length && selected.startsWith(open) && selected.endsWith(close)) {
    return selected.slice(open.length, selected.length - close.length);
  }
  return null;
}

function isItalicMark(text, from, to) {
  const before = text.slice(Math.max(0, from - 2), from);
  const after = text.slice(to, to + 2);
  if (!before.endsWith('*') || !after.startsWith('*')) return false;
  if (before.endsWith('**') || after.startsWith('**')) return false;
  return true;
}

function wrapInline(text, from, to, open, close = open) {
  const source = String(text ?? '');
  const a = Math.max(0, Math.min(from, to, source.length));
  const b = Math.max(a, Math.min(Math.max(from, to), source.length));
  const selected = source.slice(a, b);
  const inner = stripWrap(selected, open, close);
  if (inner != null) {
    return change(a, b, inner, a, a + inner.length);
  }
  const around = open === '*'
    ? isItalicMark(source, a, b)
    : source.slice(a - open.length, a) === open && source.slice(b, b + close.length) === close;
  if (around) {
    return change(a - open.length, b + close.length, selected, a - open.length, a - open.length + selected.length);
  }
  const insert = `${open}${selected}${close}`;
  if (selected) return change(a, b, insert, a + open.length, a + open.length + selected.length);
  return change(a, b, insert, a + open.length);
}

function looksLikeUrl(value) {
  const text = String(value || '').trim();
  return /^(https?:\/\/\S+|www\.\S+)$/i.test(text);
}

function linkChange(text, from, to) {
  const source = String(text ?? '');
  const a = Math.max(0, Math.min(from, to, source.length));
  const b = Math.max(a, Math.min(Math.max(from, to), source.length));
  const selected = source.slice(a, b);
  const wikiInner = stripWrap(selected, '[[', ']]');
  if (wikiInner != null) return change(a, b, wikiInner, a, a + wikiInner.length);
  if (source.slice(a - 2, a) === '[[' && source.slice(b, b + 2) === ']]') {
    return change(a - 2, b + 2, selected, a - 2, a - 2 + selected.length);
  }
  const md = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(selected);
  if (md) return change(a, b, md[1], a, a + md[1].length);
  if (looksLikeUrl(selected)) {
    const url = selected.trim();
    const insert = `[](${url})`;
    return change(a, b, insert, a + 1);
  }
  const insert = `[[${selected}]]`;
  return change(a, b, insert, a + 2, a + 2 + selected.length);
}

function headingCycle(content) {
  const match = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(content);
  const level = match ? match[1].length : 0;
  const title = match ? (match[2] ?? '') : content;
  let next = 0;
  if (level === 0) next = 1;
  else if (level === 1) next = 2;
  else if (level === 2) next = 3;
  else next = 0;
  if (!next) return title;
  return title ? `${'#'.repeat(next)} ${title}` : `${'#'.repeat(next)} `;
}

function headingLine(line) {
  const item = parseItem(line);
  return `${item.indent}${item.quote}${item.marker}${headingCycle(item.rest)}${item.cr}`;
}

function setListKind(line, kind) {
  const item = parseItem(line);
  const rest = item.rest;
  if (kind === 'quote') {
    if (item.quote) {
      return `${item.indent}${dropQuote(item.quote)}${item.marker}${rest}${item.cr}`;
    }
    return `${item.indent}> ${item.marker}${rest}${item.cr}`;
  }
  if (item.kind === kind) {
    return `${item.indent}${item.quote}${rest}${item.cr}`;
  }
  let marker = '';
  if (kind === 'task') {
    const bullet = item.bullet || '-';
    const gap = item.bulletGap || ' ';
    marker = `${bullet}${gap}[ ] `;
  } else if (kind === 'bullet') {
    marker = `${item.bullet || '-'} `;
  } else if (kind === 'numbered') {
    marker = `${item.number || '1'}${item.numberDelim || '.'} `;
  }
  return `${item.indent}${item.quote}${marker}${rest}${item.cr}`;
}

function dropQuote(quote) {
  return String(quote || '').replace(/>[ \t]*$/, '');
}

function crFor(text, pos) {
  const line = lineAt(text, pos);
  if (line.text.endsWith('\r') || line.text.includes('\r')) return '\r';
  return String(text).includes('\r') ? '\r' : '';
}

function fenceChange(text, from, to) {
  const source = String(text ?? '');
  const a = Math.max(0, Math.min(from, to, source.length));
  const b = Math.max(a, Math.min(Math.max(from, to), source.length));
  const selected = source.slice(a, b);
  const cr = crFor(source, a);
  const unwrapped = selected.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (unwrapped) {
    const inner = unwrapped[1];
    return change(a, b, inner, a, a + inner.length);
  }
  if (/^```[\s\S]*```$/.test(selected.trim()) && selected.includes('\n')) {
    const inner = selected.replace(/^```[^\n]*\r?\n?/, '').replace(/\r?\n?```$/, '');
    return change(a, b, inner, a, a + inner.length);
  }
  const inner = selected;
  const open = `\`\`\`${cr}\n`;
  const close = `${inner && !inner.endsWith('\n') ? `${cr}\n` : ''}\`\`\``;
  const insert = `${open}${inner}${close}`;
  const caret = a + open.length;
  if (inner) return change(a, b, insert, caret, caret + inner.length);
  return change(a, b, insert, caret);
}

function ruleChange(text, from, to) {
  const source = String(text ?? '');
  const a = Math.max(0, Math.min(from, to, source.length));
  const line = lineAt(source, a);
  const item = parseItem(line.text);
  const body = item.body.trim();
  if (/^ {0,3}(-{3,}|\*{3,}|_{3,})$/.test(body)) {
    return change(line.start, line.end, item.cr, line.start);
  }
  if (!item.body.trim()) {
    return change(line.start, line.end, `---${item.cr}`, line.start + 3);
  }
  const cr = item.cr || crFor(source, a);
  return change(line.end, line.end, `\n---${cr}`, line.end + 1 + 3);
}

export function formatChange(text, from, to, action) {
  if (action === 'undo' || action === 'redo' || action === 'dismiss') return null;
  if (action === 'bold') return wrapInline(text, from, to, '**');
  if (action === 'italic') return wrapInline(text, from, to, '*');
  if (action === 'strike') return wrapInline(text, from, to, '~~');
  if (action === 'highlight') return wrapInline(text, from, to, '==');
  if (action === 'code') return wrapInline(text, from, to, '`');
  if (action === 'link') return linkChange(text, from, to);
  if (action === 'fence') return fenceChange(text, from, to);
  if (action === 'rule') return ruleChange(text, from, to);
  if (action === 'indent') return indentChange(text, from, to, 1);
  if (action === 'outdent') return indentChange(text, from, to, -1);
  if (action === 'heading') {
    return applyLine(text, from, to, (line, start) => {
      const next = headingLine(line);
      const item = parseItem(next);
      return { text: next, caret: start + item.markerEnd + item.rest.length };
    });
  }
  if (action === 'task' || action === 'bullet' || action === 'numbered' || action === 'quote') {
    return applyLine(text, from, to, (line, start) => {
      const next = setListKind(line, action);
      const item = parseItem(next);
      return { text: next, caret: start + item.markerEnd };
    });
  }
  return null;
}

export function applyFormat(text, changeSpec) {
  if (!changeSpec || changeSpec.noop) return String(text ?? '');
  return String(text ?? '').slice(0, changeSpec.from) + changeSpec.insert + String(text ?? '').slice(changeSpec.to);
}

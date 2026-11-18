// Obsidian callouts: a blockquote whose first line is `> [!type]` or
// `> [!type] Title`, with an optional `+` / `-` fold mark.

export const CALLOUT_TYPES = {
  note: 'Note',
  abstract: 'Abstract',
  summary: 'Abstract',
  tldr: 'Abstract',
  info: 'Info',
  todo: 'Todo',
  tip: 'Tip',
  hint: 'Tip',
  important: 'Tip',
  success: 'Success',
  check: 'Success',
  done: 'Success',
  question: 'Question',
  help: 'Question',
  faq: 'Question',
  warning: 'Warning',
  caution: 'Warning',
  attention: 'Warning',
  failure: 'Failure',
  fail: 'Failure',
  missing: 'Failure',
  danger: 'Danger',
  error: 'Danger',
  bug: 'Bug',
  example: 'Example',
  quote: 'Quote',
  cite: 'Quote',
};

const MARK = /^ {0,3}>\s*\[!([A-Za-z][\w-]*)\]([+-])?(?:[ \t]+(\S.*?)[ \t]*)?[ \t]*$/;

export function calloutKind(type) {
  const key = String(type || '').trim().toLowerCase();
  return CALLOUT_TYPES[key] ? key : 'note';
}

export function calloutTitle(type, title) {
  const custom = String(title || '').trim();
  if (custom) return custom;
  const key = String(type || '').trim().toLowerCase();
  return CALLOUT_TYPES[key] || type || 'Note';
}

export function parseCalloutLine(line) {
  const text = String(line ?? '').replace(/\r$/, '');
  const match = MARK.exec(text);
  if (!match) return null;
  return {
    type: match[1],
    kind: calloutKind(match[1]),
    fold: match[2] || '',
    title: calloutTitle(match[1], match[3]),
    customTitle: Boolean(match[3] && match[3].trim()),
  };
}

function quoteBody(line) {
  return String(line ?? '').replace(/\r$/, '').replace(/^ {0,3}>\s?/, '');
}

export function parseCallout(source, base = 0) {
  const text = String(source ?? '');
  if (!text) return null;
  const lines = [];
  let offset = 0;
  while (offset <= text.length) {
    const at = text.indexOf('\n', offset);
    const end = at === -1 ? text.length : at;
    lines.push({ from: base + offset, to: base + end, text: text.slice(offset, end) });
    if (end >= text.length) break;
    offset = end + 1;
  }
  const head = parseCalloutLine(lines[0]?.text);
  if (!head) return null;
  const bodyLines = [];
  for (let i = 1; i < lines.length; i += 1) {
    bodyLines.push(quoteBody(lines[i].text));
  }
  const marker = `[!${head.type}]`;
  const markAt = lines[0].text.replace(/\r$/, '').indexOf(marker);
  const foldAt = markAt === -1 ? -1 : markAt + marker.length;
  return {
    ...head,
    from: lines[0].from,
    to: lines[lines.length - 1].to,
    foldFrom: foldAt >= 0 ? lines[0].from + foldAt : -1,
    body: bodyLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
    lineCount: lines.length,
  };
}

export function calloutFoldChange(callout, nextFold) {
  if (!callout || callout.foldFrom < 0) return null;
  const mark = nextFold === '-' || nextFold === '+' ? nextFold : '';
  if (!callout.fold) {
    return { from: callout.foldFrom, to: callout.foldFrom, insert: mark };
  }
  if (!mark) return { from: callout.foldFrom, to: callout.foldFrom + 1, insert: '' };
  return { from: callout.foldFrom, to: callout.foldFrom + 1, insert: mark };
}

export function calloutHeight(callout) {
  if (!callout) return 48;
  if (callout.fold === '-') return 44;
  const lines = Math.max(1, String(callout.body || '').split('\n').length);
  return 48 + lines * 22;
}

// Vault task lines for Dataview. checklist.js still owns in-note
// `- [ ]` / `- [x]` toggles; this parser is broader (any list marker,
// any status character) and never writes the document by itself.
import { closesFence, parseFenceLine } from './checklist.js';

const TASK_LINE = /^([ \t>]*)([-*+]|\d+[.)])([ \t]+)\[(.)\](.*)$/;
const TAG_RE = /#[^\s,;.:!?'"`()[\]{}]+/gu;

export function fileName(path) {
  return String(path ?? '').split('/').pop().replace(/\.md$/i, '');
}

export function indentColumns(text) {
  let columns = 0;
  for (const ch of String(text ?? '')) {
    if (ch === ' ') columns += 1;
    else if (ch === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

export function extractTags(text) {
  const tags = [];
  const seen = new Set();
  for (const match of String(text ?? '').matchAll(TAG_RE)) {
    const tag = match[0];
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export function parseTaskLine(raw) {
  const line = String(raw ?? '').replace(/\r$/, '');
  const match = TASK_LINE.exec(line);
  if (!match) return null;
  const prefix = match[1];
  const indent = prefix.replace(/>[ \t]?/g, '');
  const markIndex = match[1].length + match[2].length + match[3].length + 1;
  const status = match[4];
  const rest = match[5];
  return {
    indent,
    indentCols: indentColumns(indent),
    bullet: match[2],
    gap: match[3],
    mark: status,
    markIndex,
    checked: status !== ' ',
    completed: status === 'x' || status === 'X',
    rest,
    text: rest.replace(/^\s/, ''),
  };
}

function frontmatterBody(markdown) {
  const source = String(markdown ?? '');
  if (!source.startsWith('---')) return '';
  const rest = source.slice(3);
  const end = rest.search(/\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (end < 0) return '';
  return rest.slice(0, end).replace(/^\r?\n/, '');
}

function yamlTags(frontmatter) {
  const tags = [];
  const lines = String(frontmatter ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(tags|tag)\s*:\s*(.*)$/i.exec(lines[i].replace(/\r$/, ''));
    if (!match) continue;
    const rest = match[2].trim();
    if (!rest) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const item = /^\s*-\s+(.+)$/.exec(lines[j].replace(/\r$/, ''));
        if (!item) break;
        const value = item[1].trim().replace(/^['"]|['"]$/g, '');
        if (value) tags.push(value.replace(/^#/, ''));
      }
      continue;
    }
    const inner = rest.startsWith('[') && rest.endsWith(']') ? rest.slice(1, -1) : rest;
    for (const part of inner.split(/[,\s]+/)) {
      const value = part.trim().replace(/^['"]|['"]$/g, '');
      if (value) tags.push(value.replace(/^#/, ''));
    }
  }
  return tags;
}

export function noteTags(markdown) {
  const tags = new Set();
  for (const tag of yamlTags(frontmatterBody(markdown))) tags.add(tag.startsWith('#') ? tag : `#${tag}`);
  const lines = String(markdown ?? '').split('\n');
  let open = null;
  for (const line of lines) {
    const fence = parseFenceLine(line);
    if (!open && fence) {
      open = fence;
      continue;
    }
    if (open && closesFence(line, open)) {
      open = null;
      continue;
    }
    if (open) continue;
    for (const tag of extractTags(line.replace(/\r$/, ''))) tags.add(tag);
  }
  return [...tags];
}

function applyFullyCompleted(tasks) {
  const byLine = new Map(tasks.map((task) => [task.line, task]));
  for (const task of tasks) task.fullyCompleted = task.completed;
  for (const task of tasks) {
    let curr = task;
    while (curr) {
      curr.fullyCompleted = curr.fullyCompleted && task.completed;
      curr = curr.parent == null ? null : byLine.get(curr.parent);
    }
  }
}

export function listNoteTasks(markdown, path = '') {
  const tasks = [];
  const stack = [];
  const lines = String(markdown ?? '').split('\n');
  let open = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = parseFenceLine(line);
    if (!open && fence) {
      open = fence;
      continue;
    }
    if (open && closesFence(line, open)) {
      open = null;
      continue;
    }
    if (open) continue;
    const parsed = parseTaskLine(line);
    if (!parsed) continue;
    while (stack.length && stack[stack.length - 1].cols >= parsed.indentCols) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].line : null;
    tasks.push({
      path,
      line: index,
      text: parsed.text,
      completed: parsed.completed,
      checked: parsed.checked,
      status: parsed.mark,
      tags: extractTags(parsed.text),
      indent: parsed.indentCols,
      parent,
      markIndex: parsed.markIndex,
      fullyCompleted: parsed.completed,
      file: { path, name: fileName(path) },
    });
    stack.push({ cols: parsed.indentCols, line: index });
  }
  applyFullyCompleted(tasks);
  return tasks;
}

export function indexNote(content, path) {
  return {
    path,
    name: fileName(path),
    tags: noteTags(content),
    tasks: listNoteTasks(content, path),
  };
}

function lineMatchesHint(raw, hint) {
  const parsed = parseTaskLine(raw);
  return Boolean(parsed && parsed.text === String(hint?.text ?? ''));
}

// Flip only the status character. CRLF, tabs, and trailing spaces stay.
// If the original line no longer matches, relocate by task text; refuse
// when that text is gone or appears more than once.
export function applyTaskToggle(content, hint) {
  const source = String(content ?? '');
  const lines = source.split('\n');
  const at = Number(hint?.line);
  let index = -1;
  if (Number.isInteger(at) && at >= 0 && at < lines.length && lineMatchesHint(lines[at], hint)) {
    index = at;
  } else {
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lineMatchesHint(lines[i], hint)) hits.push(i);
    }
    if (hits.length === 1) index = hits[0];
    else {
      return {
        content: source,
        error: hits.length === 0
          ? 'That task is gone from its note. Nothing was changed.'
          : 'That task moved. Nothing was changed.',
      };
    }
  }
  const parsed = parseTaskLine(lines[index]);
  const next = parsed.completed ? ' ' : 'x';
  const line = lines[index];
  lines[index] = line.slice(0, parsed.markIndex) + next + line.slice(parsed.markIndex + 1);
  return { content: lines.join('\n') };
}

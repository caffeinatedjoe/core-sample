// A small Dataview Query Language subset. Anything outside it is
// unsupported — never a guessed result. DOM-free so node --test can import it.
import { fileName } from './tasks.js';

export const UNSUPPORTED_NOTE = 'Not supported in Core Sample yet';

const GROUP_FIELDS = new Set(['file', 'file.link', 'file.path', 'file.name']);
const SORT_FIELDS = new Set(['file.name', 'file.path', 'text', 'completed']);
const WHERE_FIELDS = new Set([
  'completed', 'fullycompleted', 'text', 'tags', 'status', 'checked',
  'file', 'file.name', 'file.path', 'file.link',
]);

function tokenize(text) {
  const list = [];
  let i = 0;
  const source = String(text ?? '');
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let value = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < source.length) {
          value += source[i + 1];
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }
      if (i >= source.length) return null;
      i += 1;
      list.push({ type: 'string', value });
      continue;
    }
    if (ch === '#') {
      let j = i + 1;
      while (j < source.length && /[^\s,;.:!?'"`()[\]{}]/.test(source[j])) j += 1;
      if (j === i + 1) return null;
      list.push({ type: 'tag', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (source.startsWith('==', i)) { list.push({ type: 'op', value: '==' }); i += 2; continue; }
    if (source.startsWith('!=', i)) { list.push({ type: 'op', value: '!=' }); i += 2; continue; }
    if (source.startsWith('&&', i)) { list.push({ type: 'op', value: '&&' }); i += 2; continue; }
    if (source.startsWith('||', i)) { list.push({ type: 'op', value: '||' }); i += 2; continue; }
    if ('=!(),-.'.includes(ch)) { list.push({ type: 'op', value: ch }); i += 1; continue; }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      list.push({ type: 'number', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      list.push({ type: 'ident', value: source.slice(i, j) });
      i = j;
      continue;
    }
    return null;
  }
  return list;
}

function fail(reason) {
  const error = new Error(reason);
  error.reason = reason;
  throw error;
}

function peek(p) {
  return p.tokens[p.i] || null;
}

function identOf(tok) {
  return tok && tok.type === 'ident' ? tok.value.toLowerCase() : '';
}

function peekIdent(p, word) {
  return identOf(peek(p)) === word;
}

function peekOp(p, value) {
  const tok = peek(p);
  return Boolean(tok && tok.type === 'op' && tok.value === value);
}

function take(p) {
  const tok = peek(p);
  if (!tok) fail('parse');
  p.i += 1;
  return tok;
}

function parseField(p) {
  const first = take(p);
  if (first.type !== 'ident') fail('parse');
  const parts = [first.value.toLowerCase()];
  while (peekOp(p, '.')) {
    p.i += 1;
    const next = take(p);
    if (next.type !== 'ident') fail('parse');
    parts.push(next.value.toLowerCase());
  }
  const name = parts.join('.');
  return name === 'fully_completed' ? 'fullycompleted' : name;
}

function parseCall(p) {
  const name = take(p).value.toLowerCase();
  if (!peekOp(p, '(')) fail('parse');
  p.i += 1;
  if (name !== 'contains') fail('unsupported');
  const args = [];
  if (!peekOp(p, ')')) {
    args.push(parseExpr(p));
    while (peekOp(p, ',')) {
      p.i += 1;
      args.push(parseExpr(p));
    }
  }
  if (!peekOp(p, ')')) fail('parse');
  p.i += 1;
  if (args.length !== 2) fail('unsupported');
  return { type: 'call', name, args };
}

function parsePrimary(p) {
  if (peekOp(p, '(')) {
    p.i += 1;
    const inner = parseExpr(p);
    if (!peekOp(p, ')')) fail('parse');
    p.i += 1;
    return inner;
  }
  const tok = peek(p);
  if (!tok) fail('parse');
  if (tok.type === 'string') { p.i += 1; return { type: 'string', value: tok.value }; }
  if (tok.type === 'number') { p.i += 1; return { type: 'number', value: tok.value }; }
  if (tok.type === 'ident') {
    if (tok.value.toLowerCase() === 'true' || tok.value.toLowerCase() === 'false') {
      p.i += 1;
      return { type: 'bool', value: tok.value.toLowerCase() === 'true' };
    }
    const next = p.tokens[p.i + 1];
    if (next && next.type === 'op' && next.value === '(') return parseCall(p);
    const name = parseField(p);
    if (!WHERE_FIELDS.has(name)) fail('unsupported');
    return { type: 'field', name };
  }
  fail('unsupported');
  return null;
}

function parseCompare(p) {
  let left = parsePrimary(p);
  while (peekOp(p, '==') || peekOp(p, '=') || peekOp(p, '!=')) {
    const raw = take(p).value;
    left = { type: 'cmp', op: raw === '!=' ? '!=' : '==', left, right: parsePrimary(p) };
  }
  return left;
}

function parseNot(p) {
  if (peekOp(p, '!')) {
    p.i += 1;
    return { type: 'not', expr: parseNot(p) };
  }
  return parseCompare(p);
}

function parseAnd(p) {
  let left = parseNot(p);
  while (peekOp(p, '&&') || peekIdent(p, 'and')) {
    p.i += 1;
    left = { type: 'and', left, right: parseNot(p) };
  }
  return left;
}

function parseExpr(p) {
  let left = parseAnd(p);
  while (peekOp(p, '||') || peekIdent(p, 'or')) {
    p.i += 1;
    left = { type: 'or', left, right: parseAnd(p) };
  }
  return left;
}

function parseSourceAtom(p) {
  if (peekOp(p, '-') || peekOp(p, '!')) {
    p.i += 1;
    return { type: 'not', expr: parseSourceAtom(p) };
  }
  if (peekOp(p, '(')) {
    p.i += 1;
    const inner = parseSourceOr(p);
    if (!peekOp(p, ')')) fail('parse');
    p.i += 1;
    return inner;
  }
  const tok = peek(p);
  if (!tok) fail('parse');
  if (tok.type === 'tag') {
    p.i += 1;
    return { type: 'tag', value: tok.value };
  }
  if (tok.type === 'string') {
    p.i += 1;
    return { type: 'folder', value: tok.value };
  }
  fail('unsupported');
  return null;
}

function parseSourceAnd(p) {
  let left = parseSourceAtom(p);
  while (peekIdent(p, 'and')) {
    p.i += 1;
    left = { type: 'and', left, right: parseSourceAtom(p) };
  }
  return left;
}

function parseSourceOr(p) {
  let left = parseSourceAnd(p);
  while (peekIdent(p, 'or')) {
    p.i += 1;
    left = { type: 'or', left, right: parseSourceAnd(p) };
  }
  return left;
}

function parseSortKey(p) {
  const field = parseField(p);
  if (!SORT_FIELDS.has(field)) fail('unsupported');
  let dir = 'asc';
  if (peekIdent(p, 'asc') || peekIdent(p, 'ascending') || peekIdent(p, 'desc') || peekIdent(p, 'descending')) {
    const word = take(p).value.toLowerCase();
    dir = word.startsWith('desc') ? 'desc' : 'asc';
  }
  return { field, dir };
}

function parseSortKeys(p) {
  const keys = [parseSortKey(p)];
  while (peekOp(p, ',')) {
    p.i += 1;
    keys.push(parseSortKey(p));
  }
  return keys;
}

function parseQuery(p) {
  const typeTok = take(p);
  if (typeTok.type !== 'ident' || typeTok.value.toLowerCase() !== 'task') fail('unsupported');
  const query = { type: 'task', from: null, clauses: [] };
  if (peekIdent(p, 'from')) {
    p.i += 1;
    query.from = parseSourceOr(p);
  }
  while (p.i < p.tokens.length) {
    if (peekIdent(p, 'where')) {
      p.i += 1;
      query.clauses.push({ type: 'where', expr: parseExpr(p) });
      continue;
    }
    if (peekIdent(p, 'sort')) {
      p.i += 1;
      query.clauses.push({ type: 'sort', keys: parseSortKeys(p) });
      continue;
    }
    if (peekIdent(p, 'group')) {
      p.i += 1;
      if (!peekIdent(p, 'by')) fail('parse');
      p.i += 1;
      const field = parseField(p);
      if (!GROUP_FIELDS.has(field)) fail('unsupported');
      query.clauses.push({ type: 'group', field });
      continue;
    }
    if (peekIdent(p, 'limit')) {
      p.i += 1;
      const n = take(p);
      if (n.type !== 'number') fail('parse');
      query.clauses.push({ type: 'limit', n: n.value });
      continue;
    }
    fail('unsupported');
  }
  return query;
}

export function parseDql(source) {
  const text = String(source ?? '').replace(/\r/g, '');
  const tokens = tokenize(text);
  if (!tokens) return { ok: false, reason: 'parse', source: text };
  if (!tokens.length) return { ok: false, reason: 'parse', source: text };
  const p = { tokens, i: 0 };
  try {
    const query = parseQuery(p);
    if (p.i !== p.tokens.length) return { ok: false, reason: 'parse', source: text };
    return { ok: true, ...query, source: text };
  } catch (error) {
    return { ok: false, reason: error.reason || 'parse', source: text };
  }
}

function tagMatches(have, want) {
  const held = String(have ?? '').toLowerCase();
  const need = String(want ?? '').toLowerCase();
  return held === need || held.startsWith(`${need}/`);
}

function sourceMatches(src, note) {
  if (src.type === 'and') return sourceMatches(src.left, note) && sourceMatches(src.right, note);
  if (src.type === 'or') return sourceMatches(src.left, note) || sourceMatches(src.right, note);
  if (src.type === 'not') return !sourceMatches(src.expr, note);
  if (src.type === 'tag') return (note.tags || []).some((tag) => tagMatches(tag, src.value));
  if (src.type === 'folder') {
    const folder = String(src.value ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const path = String(note.path ?? '').replace(/\\/g, '/');
    const lowerP = path.toLowerCase();
    const lowerF = folder.toLowerCase();
    if (!lowerF) return true;
    if (lowerP === lowerF || lowerP === `${lowerF}.md`) return true;
    return lowerP.startsWith(`${lowerF}/`);
  }
  return false;
}

function truthy(value) {
  if (value == null || value === false) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (value === '') return false;
  return true;
}

function fieldValue(name, task) {
  switch (name) {
    case 'completed': return task.completed;
    case 'fullycompleted': return task.fullyCompleted;
    case 'checked': return task.checked;
    case 'text': return task.text;
    case 'tags': return task.tags;
    case 'status': return task.status;
    case 'file':
    case 'file.path':
    case 'file.link': return task.path;
    case 'file.name': return task.file?.name || fileName(task.path);
    default: return null;
  }
}

function valuesEqual(left, right) {
  if (typeof left === 'string' && typeof right === 'string') return left === right;
  if (Array.isArray(left) || Array.isArray(right)) return false;
  return left === right;
}

function evalContains(hay, needle) {
  if (Array.isArray(hay)) {
    return hay.some((item) => {
      if (typeof item === 'string' && typeof needle === 'string') {
        return item.toLowerCase() === needle.toLowerCase();
      }
      return valuesEqual(item, needle);
    });
  }
  if (typeof hay === 'string' && typeof needle === 'string') {
    return hay.toLowerCase().includes(needle.toLowerCase());
  }
  return valuesEqual(hay, needle);
}

function evalExpr(expr, task) {
  switch (expr.type) {
    case 'and': return truthy(evalExpr(expr.left, task)) && truthy(evalExpr(expr.right, task));
    case 'or': return truthy(evalExpr(expr.left, task)) || truthy(evalExpr(expr.right, task));
    case 'not': return !truthy(evalExpr(expr.expr, task));
    case 'cmp': {
      const left = evalExpr(expr.left, task);
      const right = evalExpr(expr.right, task);
      const eq = valuesEqual(left, right);
      return expr.op === '!=' ? !eq : eq;
    }
    case 'string': return expr.value;
    case 'number': return expr.value;
    case 'bool': return expr.value;
    case 'field': return fieldValue(expr.name, task);
    case 'call':
      if (expr.name === 'contains') {
        return evalContains(evalExpr(expr.args[0], task), evalExpr(expr.args[1], task));
      }
      return null;
    default: return null;
  }
}

function compareTasks(a, b, keys) {
  for (const key of keys) {
    const av = fieldValue(key.field, a);
    const bv = fieldValue(key.field, b);
    let cmp = 0;
    if (typeof av === 'boolean' && typeof bv === 'boolean') cmp = av === bv ? 0 : (av ? 1 : -1);
    else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
    if (cmp) return key.dir === 'desc' ? -cmp : cmp;
  }
  return a.path.localeCompare(b.path) || a.line - b.line;
}

function withDescendants(matched, fromTasks) {
  const wanted = new Set(matched.map((task) => `${task.path}:${task.line}`));
  const byPath = new Map();
  for (const task of fromTasks) {
    if (!byPath.has(task.path)) byPath.set(task.path, []);
    byPath.get(task.path).push(task);
  }
  const extra = [];
  for (const task of matched) {
    const stack = [task.line];
    const fileTasks = byPath.get(task.path) || [];
    while (stack.length) {
      const line = stack.pop();
      for (const child of fileTasks) {
        if (child.parent !== line) continue;
        const id = `${child.path}:${child.line}`;
        if (wanted.has(id)) continue;
        wanted.add(id);
        extra.push(child);
        stack.push(child.line);
      }
    }
  }
  return extra.length ? matched.concat(extra) : matched;
}

function nestGroup(tasks) {
  const byLine = new Map();
  for (const task of tasks) byLine.set(task.line, { task, children: [] });
  const roots = [];
  for (const task of tasks) {
    const node = byLine.get(task.line);
    const parent = task.parent == null ? null : byLine.get(task.parent);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const out = [];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      out.push({ ...node.task, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

function groupFieldName(field) {
  if (field === 'file' || field === 'file.link') return 'file.path';
  return field;
}

function groupTasks(tasks, field) {
  const groups = [];
  const map = new Map();
  for (const task of tasks) {
    const key = String(fieldValue(field, task) ?? '');
    let group = map.get(key);
    if (!group) {
      group = { key, path: task.path, name: fileName(task.path), tasks: [] };
      map.set(key, group);
      groups.push(group);
    }
    group.tasks.push(task);
  }
  for (const group of groups) group.tasks = nestGroup(group.tasks);
  return groups;
}

export function runDql(parsed, index) {
  if (!parsed?.ok) {
    return { supported: false, query: parsed?.source ?? '', message: UNSUPPORTED_NOTE };
  }
  const notes = index.notes();
  let allowed = null;
  if (parsed.from) {
    allowed = new Set(notes.filter((note) => sourceMatches(parsed.from, note)).map((note) => note.path));
  }
  const fromTasks = index.tasks().filter((task) => !allowed || allowed.has(task.path));
  let tasks = fromTasks;
  let groupBy = 'file.path';
  for (const clause of parsed.clauses) {
    if (clause.type === 'where') tasks = tasks.filter((task) => truthy(evalExpr(clause.expr, task)));
    else if (clause.type === 'sort') tasks = [...tasks].sort((a, b) => compareTasks(a, b, clause.keys));
    else if (clause.type === 'limit') tasks = tasks.slice(0, Math.max(0, clause.n));
    else if (clause.type === 'group') groupBy = groupFieldName(clause.field);
  }
  tasks = withDescendants(tasks, fromTasks);
  return {
    supported: true,
    query: parsed.source,
    groups: groupTasks(tasks, groupBy),
    count: tasks.length,
  };
}

export function dataviewResult(source, lang, index) {
  const query = String(source ?? '');
  const info = String(lang ?? 'dataview').trim().toLowerCase();
  if (info !== 'dataview') return { supported: false, query, message: UNSUPPORTED_NOTE };
  const parsed = parseDql(query);
  if (!parsed.ok) return { supported: false, query, message: UNSUPPORTED_NOTE };
  return runDql(parsed, index);
}

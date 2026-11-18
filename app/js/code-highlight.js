// Small fence highlighter. A handful of token classes, not a language
// pack: strings, comments, keywords, numbers, and a few builtins.

const LANG = {
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js',
  ts: 'js', typescript: 'js', jsx: 'js', tsx: 'js',
  json: 'json',
  py: 'py', python: 'py',
  css: 'css',
  html: 'html', xml: 'html', svg: 'html',
  sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh',
  yml: 'yaml', yaml: 'yaml',
  md: 'md', markdown: 'md',
  sql: 'sql',
};

const WORDS = {
  js: new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'async', 'await', 'of']),
  py: new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield']),
  sh: new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'in', 'function', 'return', 'export', 'local', 'readonly', 'true', 'false']),
  sql: new Set(['select', 'from', 'where', 'and', 'or', 'not', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'index', 'join', 'left', 'right', 'inner', 'on', 'as', 'order', 'by', 'group', 'limit', 'null', 'true', 'false']),
};

function cls(name) {
  return `cm-tok-${name}`;
}

function push(out, from, to, name) {
  if (to > from) out.push({ from, to, cls: cls(name) });
}

function readQuoted(text, i, quote) {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === quote) return j + 1;
    if (text[j] === '\n' && quote !== '`') return j;
    j += 1;
  }
  return j;
}

function tokenizeJs(text, json) {
  const out = [];
  let i = 0;
  const keys = WORDS.js;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/' && !json) {
      const end = text.indexOf('\n', i);
      push(out, i, end === -1 ? text.length : end, 'comment');
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*' && !json) {
      const end = text.indexOf('*/', i + 2);
      const to = end === -1 ? text.length : end + 2;
      push(out, i, to, 'comment');
      i = to;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const to = readQuoted(text, i, ch);
      push(out, i, to, 'string');
      i = to;
      continue;
    }
    if (ch === '#') { // ts / js pragma rarely; treat rest of word
      i += 1;
      continue;
    }
    if (/\d/.test(ch)) {
      let j = i;
      while (j < text.length && /[\d._xXa-fA-F]/.test(text[j])) j += 1;
      push(out, i, j, 'number');
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[\w$]/.test(text[j])) j += 1;
      const word = text.slice(i, j);
      if (!json && keys.has(word)) push(out, i, j, 'keyword');
      else if (json && text.slice(j).match(/^\s*:/)) push(out, i, j, 'property');
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

function tokenizeHash(text, words, hashComment) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (hashComment && ch === '#') {
      const end = text.indexOf('\n', i);
      push(out, i, end === -1 ? text.length : end, 'comment');
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const to = readQuoted(text, i, ch);
      push(out, i, to, 'string');
      i = to;
      continue;
    }
    if (/\d/.test(ch)) {
      let j = i;
      while (j < text.length && /[\d.]/.test(text[j])) j += 1;
      push(out, i, j, 'number');
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[\w-]/.test(text[j])) j += 1;
      if (words.has(text.slice(i, j))) push(out, i, j, 'keyword');
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

function tokenizeCss(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const to = end === -1 ? text.length : end + 2;
      push(out, i, to, 'comment');
      i = to;
      continue;
    }
    if (text[i] === '"' || text[i] === "'") {
      const to = readQuoted(text, i, text[i]);
      push(out, i, to, 'string');
      i = to;
      continue;
    }
    if (text[i] === '#') {
      let j = i + 1;
      while (j < text.length && /[0-9A-Fa-f]/.test(text[j])) j += 1;
      if (j - i === 4 || j - i === 7) push(out, i, j, 'number');
      i = j;
      continue;
    }
    if (/\d/.test(text[i])) {
      let j = i;
      while (j < text.length && /[\d.]/.test(text[j])) j += 1;
      push(out, i, j, 'number');
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

function tokenizeHtml(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      const to = end === -1 ? text.length : end + 3;
      push(out, i, to, 'comment');
      i = to;
      continue;
    }
    if (text[i] === '<' && text[i + 1] !== ' ') {
      const close = text.indexOf('>', i + 1);
      const to = close === -1 ? text.length : close + 1;
      push(out, i, to, 'keyword');
      const inner = text.slice(i, to);
      for (const match of inner.matchAll(/([A-Za-z:_][\w:.-]*)=/g)) {
        const at = i + match.index;
        push(out, at, at + match[1].length, 'property');
      }
      for (const match of inner.matchAll(/("[^"]*"|'[^']*')/g)) {
        const at = i + match.index;
        push(out, at, at + match[0].length, 'string');
      }
      i = to;
      continue;
    }
    i += 1;
  }
  return out;
}

function tokenizeMd(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\n') { i += 1; continue; }
    if (text[i] === '#' && (i === 0 || text[i - 1] === '\n')) {
      let j = i;
      while (text[j] === '#') j += 1;
      const end = text.indexOf('\n', i);
      push(out, i, end === -1 ? text.length : end, 'keyword');
      i = end === -1 ? text.length : end;
      continue;
    }
    if (text.startsWith('```', i)) {
      const end = text.indexOf('\n', i);
      push(out, i, end === -1 ? text.length : end, 'comment');
      i = end === -1 ? text.length : end;
      continue;
    }
    if (text[i] === '`') {
      const to = text.indexOf('`', i + 1);
      if (to !== -1) {
        push(out, i, to + 1, 'string');
        i = to + 1;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

export function languageOf(info) {
  const raw = String(info || '').trim().split(/\s+/)[0].toLowerCase();
  return LANG[raw] || '';
}

export function highlightCode(code, info) {
  const text = String(code ?? '');
  const lang = languageOf(info);
  if (!lang || !text) return [];
  if (lang === 'js') return tokenizeJs(text, false);
  if (lang === 'json') return tokenizeJs(text, true);
  if (lang === 'py') return tokenizeHash(text, WORDS.py, true);
  if (lang === 'sh') return tokenizeHash(text, WORDS.sh, true);
  if (lang === 'sql') return tokenizeHash(text, WORDS.sql, true);
  if (lang === 'yaml') return tokenizeHash(text, new Set(['true', 'false', 'null', 'yes', 'no']), true);
  if (lang === 'css') return tokenizeCss(text);
  if (lang === 'html') return tokenizeHtml(text);
  if (lang === 'md') return tokenizeMd(text);
  return [];
}

export const HIGHLIGHT_LANGS = [...new Set(Object.values(LANG))].sort();

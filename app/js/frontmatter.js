// YAML frontmatter as a small property list. Only the edited value is
// rewritten; key order, comments, and untouched lines stay byte for byte.

const KEY = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

function lineEnd(text, from) {
  const at = text.indexOf('\n', from);
  return at === -1 ? text.length : at;
}

function stripCR(line) {
  return String(line ?? '').replace(/\r$/, '');
}

function unquote(value) {
  const text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const q = text[0];
    return text.slice(1, -1).replace(q === '"' ? /\\"/g : /''/g, q);
  }
  return text;
}

function parseScalar(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { kind: 'text', value: '' };
  if (/^(true|false)$/i.test(text)) return { kind: 'bool', value: /^true$/i.test(text) };
  if (/^(yes|no)$/i.test(text)) return { kind: 'bool', value: /^yes$/i.test(text), yesNo: true };
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return { kind: 'number', value: Number(text) };
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    const items = inner ? inner.split(',').map((part) => unquote(part.trim())).filter(Boolean) : [];
    return { kind: 'list', value: items, flow: true };
  }
  if (text === '|' || text === '>' || text === '|-' || text === '>-') return { kind: 'raw', value: text };
  return { kind: 'text', value: unquote(text) };
}

function readBlockList(lines, start, baseIndent) {
  const items = [];
  let i = start;
  let to = start;
  while (i < lines.length) {
    const raw = stripCR(lines[i].text);
    if (!raw.trim()) break;
    const indent = /^[ \t]*/.exec(raw)[0];
    if (indent.length <= baseIndent) break;
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (!item) break;
    items.push(unquote(item[1].trim()));
    to = lines[i].to;
    i += 1;
  }
  return { items, next: i, to };
}

export function parseProperties(source, base = 0) {
  const text = String(source ?? '');
  const lines = [];
  let offset = 0;
  while (offset <= text.length) {
    const end = lineEnd(text, offset);
    lines.push({ from: base + offset, to: base + end, text: text.slice(offset, end) });
    if (end >= text.length) break;
    offset = end + 1;
  }
  const fields = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = stripCR(lines[i].text);
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const match = KEY.exec(raw);
    if (!match) continue;
    const keyFrom = lines[i].from + raw.indexOf(match[1]);
    const colon = raw.indexOf(':', raw.indexOf(match[1]));
    const valueFrom = lines[i].from + colon + 1;
    const rest = match[2];
    if (!rest && i + 1 < lines.length) {
      const next = stripCR(lines[i + 1].text);
      const indent = /^[ \t]*/.exec(next)[0];
      if (indent.length && /^\s*-\s+/.test(next)) {
        const list = readBlockList(lines, i + 1, 0);
        fields.push({
          key: match[1],
          kind: 'list',
          value: list.items,
          flow: false,
          from: lines[i].from,
          to: list.to,
          keyFrom,
          valueFrom,
          valueTo: list.to,
          raw: text.slice(valueFrom - base, list.to - base),
        });
        i = list.next - 1;
        continue;
      }
    }
    const parsed = parseScalar(rest);
    const valueTo = lines[i].to - (lines[i].text.endsWith('\r') ? 1 : 0);
    fields.push({
      key: match[1],
      kind: parsed.kind,
      value: parsed.value,
      flow: parsed.flow || false,
      yesNo: parsed.yesNo || false,
      from: lines[i].from,
      to: lines[i].to,
      keyFrom,
      valueFrom,
      valueTo,
      raw: rest,
    });
  }
  return { from: base, to: base + text.length, fields };
}

function quoteString(value, raw) {
  const text = String(value ?? '');
  const prev = String(raw ?? '').trim();
  const needs = /[:#\[\]{},&*!|>%@`]/.test(text) || /^\s/.test(text) || /\s$/.test(text) || text === '';
  const wasQuoted = /^['"]/.test(prev);
  if (!needs && !wasQuoted) return text;
  const q = prev[0] === "'" ? "'" : '"';
  const escaped = q === '"' ? text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : text.replace(/'/g, "''");
  return `${q}${escaped}${q}`;
}

function writeValue(field, next) {
  if (field.kind === 'bool') {
    const on = Boolean(next);
    if (field.yesNo) return on ? 'yes' : 'no';
    return on ? 'true' : 'false';
  }
  if (field.kind === 'number') {
    const n = Number(next);
    return Number.isFinite(n) ? String(n) : String(next ?? '');
  }
  if (field.kind === 'list') {
    const items = Array.isArray(next)
      ? next.map((item) => String(item).trim()).filter(Boolean)
      : String(next ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    if (field.flow) return `[${items.join(', ')}]`;
    if (!items.length) return '';
    return `\n${items.map((item) => `  - ${item}`).join('\n')}`;
  }
  return quoteString(next, field.raw);
}

function valuePrefix(field) {
  const raw = String(field.raw ?? '');
  const lead = /^[ \t]*/.exec(raw)[0];
  return lead || ' ';
}

export function propertyChange(field, next) {
  if (!field || field.kind === 'raw') return null;
  let insert = writeValue(field, next);
  if (field.kind !== 'list' || field.flow) insert = `${valuePrefix(field)}${insert.replace(/^[ \t]+/, '')}`;
  if (field.kind === 'list' && !field.flow) {
    insert = writeValue(field, next);
  }
  if (insert === field.raw) return { from: field.valueFrom, to: field.valueTo, insert, noop: true };
  return { from: field.valueFrom, to: field.valueTo, insert };
}

export function propertiesHeight(fields) {
  return 36 + Math.max(1, (fields?.length || 0)) * 40;
}

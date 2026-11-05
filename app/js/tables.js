// GFM pipe tables. Parsing and a one-cell write that leaves every other
// byte alone, including CRLF, tabs, and the delimiter row.

function lineEnd(text, from) {
  const at = text.indexOf('\n', from);
  return at === -1 ? text.length : at;
}

function rowText(line) {
  return String(line ?? '').replace(/\r$/, '');
}

function isSepCell(text) {
  return /^:?-{3,}:?$/.test(String(text ?? '').trim());
}

export function isTableSep(line) {
  const cells = splitRow(rowText(line)).cells;
  return cells.length >= 2 && cells.every((cell) => isSepCell(cell.text));
}

export function isTableRow(line) {
  const text = rowText(line);
  if (!text.includes('|')) return false;
  if (isTableSep(text)) return false;
  const cells = splitRow(text).cells;
  return cells.length >= 1;
}

function alignOf(text) {
  const value = String(text ?? '').trim();
  const left = value.startsWith(':');
  const right = value.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

// Split a row on unescaped `|`. Leading and trailing pipes are the usual
// Obsidian form; GFM also allows `a | b` without them.
export function splitRow(line) {
  const text = rowText(line);
  const cells = [];
  let i = 0;
  while (i < text.length && /[ \t]/.test(text[i])) i += 1;
  if (text[i] === '|') i += 1;
  let raw = '';
  let rawFrom = i;
  let escaped = false;
  const push = (to) => {
    cells.push({
      raw,
      text: raw.trim(),
      localFrom: rawFrom,
      localTo: to,
    });
    raw = '';
  };
  for (; i <= text.length; i += 1) {
    if (i === text.length) {
      if (raw.length || !cells.length) push(i);
      break;
    }
    const ch = text[i];
    if (escaped) {
      raw += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      raw += ch;
      escaped = true;
      continue;
    }
    if (ch === '|') {
      push(i);
      rawFrom = i + 1;
      raw = '';
      continue;
    }
    raw += ch;
  }
  if (cells.length && text.trimEnd().endsWith('|') && cells[cells.length - 1].raw === '' && cells.length > 1) {
    cells.pop();
  }
  return { text, cells };
}

function unescapeCell(text) {
  return String(text ?? '').replace(/\\([\\|])/g, '$1');
}

function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function parseTable(source, base = 0) {
  const text = String(source ?? '');
  if (!text) return null;
  const rows = [];
  let offset = 0;
  while (offset <= text.length) {
    const end = lineEnd(text, offset);
    const rawLine = text.slice(offset, end);
    if (rawLine.length || end < text.length) {
      rows.push({
        from: base + offset,
        to: base + end,
        text: rawLine,
      });
    }
    if (end >= text.length) break;
    offset = end + 1;
  }
  if (rows.length < 2 || !isTableRow(rows[0].text) || !isTableSep(rows[1].text)) return null;

  const header = splitRow(rows[0].text);
  const sep = splitRow(rows[1].text);
  const aligns = sep.cells.map((cell) => alignOf(cell.text));
  const width = Math.max(header.cells.length, sep.cells.length);

  const mapRow = (row, kind) => {
    const split = splitRow(row.text);
    const cells = [];
    for (let i = 0; i < width; i += 1) {
      const cell = split.cells[i];
      if (!cell) {
        cells.push({
          text: '',
          raw: '',
          from: row.to,
          to: row.to,
          align: aligns[i] || 'left',
        });
        continue;
      }
      cells.push({
        text: unescapeCell(cell.text),
        raw: cell.raw,
        from: row.from + cell.localFrom,
        to: row.from + cell.localTo,
        align: aligns[i] || 'left',
      });
    }
    return { kind, from: row.from, to: row.to, cells };
  };

  const out = [mapRow(rows[0], 'header')];
  for (let i = 2; i < rows.length; i += 1) {
    if (!isTableRow(rows[i].text) && !rows[i].text.trim()) break;
    if (!isTableRow(rows[i].text)) break;
    out.push(mapRow(rows[i], 'body'));
  }
  if (!out.length) return null;
  return {
    from: rows[0].from,
    to: out[out.length - 1].to,
    aligns,
    rows: out,
  };
}

// Pad a replacement so a shorter value does not shift later pipes on the
// same line. A longer value has to move the rest of that row only.
export function fitCell(raw, next) {
  const original = String(raw ?? '');
  const core = escapeCell(String(next ?? '').trim());
  const leadMatch = /^[ \t]*/.exec(original)[0];
  const lead = leadMatch || ' ';
  const trailHad = /[ \t]$/.test(original) || !original.length;
  let body = lead + core;
  if (trailHad && !/[ \t]$/.test(body)) body += original.endsWith('\t') && !core ? '\t' : ' ';
  if (body.length < original.length) body += ' '.repeat(original.length - body.length);
  return body;
}

export function tableCellChange(table, row, col, next) {
  if (!table || !table.rows[row] || !table.rows[row].cells[col]) return null;
  const cell = table.rows[row].cells[col];
  const insert = fitCell(cell.raw, next);
  if (insert === cell.raw) return { from: cell.from, to: cell.to, insert, noop: true };
  return { from: cell.from, to: cell.to, insert };
}

export function tableHeight(table) {
  const rows = table?.rows?.length || 0;
  return 16 + Math.max(1, rows) * 36;
}

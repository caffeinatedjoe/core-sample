import { closesFence, parseFenceLine, parseTask } from './checklist.js';

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

export function parseWikilink(inner) {
  const raw = String(inner ?? '');
  const pipe = raw.indexOf('|');
  let body = pipe === -1 ? raw : raw.slice(0, pipe);
  const alias = pipe === -1 ? null : raw.slice(pipe + 1).trim();
  const hash = body.indexOf('#');
  let heading = null;
  if (hash !== -1) {
    heading = body.slice(hash + 1).trim();
    body = body.slice(0, hash);
  }
  const target = body.trim();
  if (!target || target.includes(']') || target.includes('[')) return null;
  if (alias !== null && !alias) return null;
  let label = target;
  if (alias) label = alias;
  else if (heading) label = heading;
  return {
    target,
    heading: heading || null,
    alias,
    label,
  };
}

function isSafeUrl(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  if (/^javascript:/i.test(value) || /^data:/i.test(value)) return false;
  if (!/^[a-zA-Z][a-zA-Z+.-]*:/.test(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function nextSpecial(text, index) {
  const rest = text.slice(index);
  const found = rest.search(/[`[\*_]/);
  if (found === -1) return text.length;
  return index + found;
}

function renderInline(text) {
  let html = '';
  let index = 0;
  const source = String(text ?? '');
  while (index < source.length) {
    if (source[index] === '`') {
      const end = source.indexOf('`', index + 1);
      if (end > index + 1) {
        html += `<code>${escapeHtml(source.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (source.startsWith('[[', index)) {
      const end = source.indexOf(']]', index + 2);
      if (end !== -1) {
        const parsed = parseWikilink(source.slice(index + 2, end));
        if (parsed) {
          html += `<a class="wikilink" href="#${escapeHtml(parsed.target)}" data-wikilink="${escapeHtml(parsed.target)}" data-heading="${escapeHtml(parsed.heading || '')}">${escapeHtml(parsed.label)}</a>`;
          index = end + 2;
          continue;
        }
      }
    }

    if (source[index] === '[') {
      const link = matchLink(source, index);
      if (link) {
        html += link.html;
        index = link.next;
        continue;
      }
    }

    if (source.startsWith('***', index) || source.startsWith('___', index)) {
      const marker = source.slice(index, index + 3);
      const end = source.indexOf(marker, index + 3);
      if (end !== -1) {
        html += `<strong><em>${renderInline(source.slice(index + 3, end))}</em></strong>`;
        index = end + 3;
        continue;
      }
    }

    if (source.startsWith('**', index) || source.startsWith('__', index)) {
      const marker = source.slice(index, index + 2);
      const end = findCloser(source, index, marker);
      if (end !== -1) {
        html += `<strong>${renderInline(source.slice(index + 2, end))}</strong>`;
        index = end + 2;
        continue;
      }
    }

    if (source[index] === '*' || source[index] === '_') {
      const marker = source[index];
      const end = findCloser(source, index, marker);
      if (end !== -1 && end > index + 1) {
        html += `<em>${renderInline(source.slice(index + 1, end))}</em>`;
        index = end + 1;
        continue;
      }
    }

    const next = nextSpecial(source, index);
    const sliceEnd = next === index ? index + 1 : next;
    html += escapeHtml(source.slice(index, sliceEnd));
    index = sliceEnd;
  }
  return html;
}

function findCloser(text, index, marker) {
  if (marker === '_' || marker === '__') {
    const before = index > 0 ? text[index - 1] : '';
    if (before && /[\p{L}\p{N}]/u.test(before)) return -1;
  }
  const end = text.indexOf(marker, index + marker.length);
  if (end === -1) return -1;
  if (marker === '_' || marker === '__') {
    const after = text[end + marker.length] || '';
    if (after && /[\p{L}\p{N}]/u.test(after)) return -1;
  }
  if (marker.length === 1 && text[end - 1] === ' ') return -1;
  return end;
}

function matchLink(text, index) {
  if (text[index] !== '[') return null;
  const labelEnd = text.indexOf(']', index + 1);
  if (labelEnd === -1 || text[labelEnd + 1] !== '(') return null;
  const urlEnd = text.indexOf(')', labelEnd + 2);
  if (urlEnd === -1) return null;
  const label = text.slice(index + 1, labelEnd);
  const url = text.slice(labelEnd + 2, urlEnd).trim();
  if (!isSafeUrl(url)) {
    return { html: escapeHtml(label), next: urlEnd + 1 };
  }
  return {
    html: `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${renderInline(label)}</a>`,
    next: urlEnd + 1,
  };
}

const CHECK = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 6.2 4.6 9 10 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function slugify(text) {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
  return slug || 'section';
}

function headingId(text, used) {
  const base = slugify(text);
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function isBlank(line) {
  return line.trim() === '';
}

function parseHeading(line) {
  const match = /^(#{1,6})\s+(\S.*)$/.exec(line);
  if (!match) return null;
  const text = match[2].replace(/\s+#+\s*$/, '').trim();
  if (!text) return null;
  return { level: match[1].length, text };
}

function isHr(line) {
  return /^( {0,3})([-*_])(?:\s*\2){2,}\s*$/.test(line);
}

function isQuote(line) {
  return /^ {0,3}>\s?/.test(line);
}

function isTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|', 1);
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitCells(line) {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map((cell) => cell.trim());
}

function parseBullet(line) {
  if (parseTask(line)) return null;
  const match = /^( {0,3})([-*+])\s+(.*)$/.exec(line);
  if (!match) return null;
  if (isHr(line)) return null;
  return { indent: match[1].length, text: match[3] };
}

function parseOrdered(line) {
  const match = /^( {0,3})(\d{1,9})[.)]\s+(.*)$/.exec(line);
  if (!match) return null;
  return { indent: match[1].length, text: match[3] };
}

function startsBlock(line) {
  return Boolean(
    parseFenceLine(line)
    || parseHeading(line)
    || isHr(line)
    || isQuote(line)
    || parseTask(line)
    || parseBullet(line)
    || parseOrdered(line)
    || isTableRow(line),
  );
}

export function findWikilinks(markdown) {
  const found = [];
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
    scanWikilinks(line, found);
  }
  return found;
}

function scanWikilinks(text, found) {
  let index = 0;
  while (index < text.length) {
    if (text[index] === '`') {
      const end = text.indexOf('`', index + 1);
      if (end !== -1) {
        index = end + 1;
        continue;
      }
    }
    if (text.startsWith('[[', index)) {
      const end = text.indexOf(']]', index + 2);
      if (end !== -1) {
        const parsed = parseWikilink(text.slice(index + 2, end));
        if (parsed) found.push(parsed);
        index = end + 2;
        continue;
      }
    }
    index += 1;
  }
}

function renderTask(task, taskIndex) {
  const pressed = task.checked ? 'true' : 'false';
  const label = task.checked ? 'Mark not done' : 'Mark done';
  const done = task.checked ? ' is-done' : '';
  const mark = task.checked ? CHECK : '';
  return `<li class="task" style="--indent:${task.indent.length}"><button type="button" class="task-toggle" data-task-index="${taskIndex}" aria-pressed="${pressed}" aria-label="${label}"><span class="task-box" aria-hidden="true">${mark}</span></button><span class="task-text${done}">${renderInline(task.text)}</span></li>`;
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const html = [];
  const usedIds = new Set();
  const tasks = { n: 0 };
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const fence = parseFenceLine(line);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !closesFence(lines[index], fence)) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      const id = headingId(heading.text, usedIds);
      html.push(`<h${heading.level} id="${escapeHtml(id)}" data-heading="${escapeHtml(heading.text)}">${renderInline(heading.text)}</h${heading.level}>`);
      index += 1;
      continue;
    }

    if (isHr(line)) {
      html.push('<hr>');
      index += 1;
      continue;
    }

    if (isTableRow(line) && lines[index + 1] && isTableSep(lines[index + 1])) {
      const headers = splitCells(line);
      index += 2;
      const body = [];
      while (index < lines.length && isTableRow(lines[index])) {
        const cells = splitCells(lines[index]);
        body.push(`<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`);
        index += 1;
      }
      const head = `<tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr>`;
      html.push(`<div class="table-wrap"><table><thead>${head}</thead><tbody>${body.join('')}</tbody></table></div>`);
      continue;
    }

    if (isQuote(line)) {
      const parts = [];
      while (index < lines.length && isQuote(lines[index])) {
        parts.push(lines[index].replace(/^ {0,3}>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${parts.map((part) => renderInline(part)).join('<br>')}</blockquote>`);
      continue;
    }

    if (parseTask(line) || parseBullet(line)) {
      const items = [];
      while (index < lines.length) {
        const task = parseTask(lines[index]);
        if (task) {
          items.push(renderTask(task, tasks.n));
          tasks.n += 1;
          index += 1;
          continue;
        }
        const bullet = parseBullet(lines[index]);
        if (bullet) {
          items.push(`<li style="--indent:${bullet.indent}">${renderInline(bullet.text)}</li>`);
          index += 1;
          continue;
        }
        break;
      }
      html.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (parseOrdered(line)) {
      const items = [];
      while (index < lines.length) {
        const item = parseOrdered(lines[index]);
        if (!item) break;
        items.push(`<li>${renderInline(item.text)}</li>`);
        index += 1;
      }
      html.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && !isBlank(lines[index]) && !startsBlock(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) {
      html.push(`<p>${paragraph.map((part) => renderInline(part)).join('<br>')}</p>`);
    } else {
      html.push(`<p>${renderInline(line)}</p>`);
      index += 1;
    }
  }

  return html.join('\n');
}

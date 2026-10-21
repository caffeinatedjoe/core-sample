import { closesFence, parseFenceLine, parseTask } from './checklist.js';
import { basename, decodePath, imageKind, normalizeVaultPath, parseSize, parseWikilinkImage } from './embeds.js';

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
  const found = rest.search(/[`[!*_]/);
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

    if (source[index] === '!') {
      const image = matchImage(source, index);
      if (image) {
        html += image.html;
        index = image.next;
        continue;
      }
      html += '!';
      index += 1;
      continue;
    }

    if (source.startsWith('[[', index)) {
      const end = source.indexOf(']]', index + 2);
      if (end !== -1) {
        const parsed = parseWikilink(source.slice(index + 2, end));
        if (parsed) {
          html += `<button type="button" class="wikilink" data-wikilink="${escapeHtml(parsed.target)}" data-heading="${escapeHtml(parsed.heading || '')}">${escapeHtml(parsed.label)}</button>`;
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

function imageAttrs(width, height) {
  const parts = [];
  if (width) parts.push(`width:${Number(width)}px`);
  if (height) parts.push(`height:${Number(height)}px`);
  return parts.length ? ` style="${parts.join(';')}"` : '';
}

function fallbackEmbed(name, { width = null, height = null, embed = '' } = {}) {
  const label = escapeHtml(basename(name) || name || 'image');
  if (!embed) return `<span class="embed"><span class="embed-fallback">${label}</span></span>`;
  const widthAttr = width ? ` data-width="${width}"` : '';
  const heightAttr = height ? ` data-height="${height}"` : '';
  return `<span class="embed" data-embed="${escapeHtml(embed)}"${widthAttr}${heightAttr}><span class="embed-fallback">${label}</span></span>`;
}

function remoteImage(src, alt, width, height) {
  return `<span class="embed"><img class="embed-image" alt="${escapeHtml(alt)}" src="${escapeHtml(src)}"${imageAttrs(width, height)}></span>`;
}

function matchImage(text, index) {
  if (text[index] !== '!' || text[index + 1] !== '[') return null;
  if (text.startsWith('![[', index)) {
    const end = text.indexOf(']]', index + 3);
    if (end === -1) return null;
    const spec = parseWikilinkImage(text.slice(index + 3, end));
    if (!spec) return null;
    if (spec.kind === 'unsupported') return { html: fallbackEmbed(spec.target), next: end + 2 };
    return {
      html: fallbackEmbed(spec.target, { width: spec.width, height: spec.height, embed: spec.target }),
      next: end + 2,
    };
  }
  const parsed = readMarkdownImage(text, index);
  if (!parsed) return null;
  const size = parseSize(parsed.alt);
  const width = size ? size.width : null;
  const height = size ? size.height : null;
  const alt = size ? basename(parsed.dest) : parsed.alt;
  const dest = parsed.dest.trim();
  if (/^https:\/\//i.test(dest) && isSafeUrl(dest)) {
    return { html: remoteImage(dest, alt || basename(dest), width, height), next: parsed.next };
  }
  if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(dest)) {
    return { html: remoteImage(dest, alt || 'image', width, height), next: parsed.next };
  }
  if (/^[a-z][a-z+.-]*:/i.test(dest)) {
    return { html: fallbackEmbed(parsed.alt || 'image'), next: parsed.next };
  }
  const link = normalizeVaultPath(decodePath(dest.split(/\s+/)[0]));
  const kind = link ? imageKind(link) : '';
  if (kind === 'raster' || kind === 'svg') {
    return {
      html: fallbackEmbed(link, { width, height, embed: link }),
      next: parsed.next,
    };
  }
  if (link && imageKind(link) === 'unsupported') {
    return { html: fallbackEmbed(basename(link) || alt), next: parsed.next };
  }
  return { html: fallbackEmbed(alt || basename(dest) || 'image'), next: parsed.next };
}

function readMarkdownImage(text, index) {
  if (!text.startsWith('![', index)) return null;
  let cursor = index + 2;
  let depth = 1;
  while (cursor < text.length && depth > 0) {
    if (text[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (text[cursor] === '[') depth += 1;
    else if (text[cursor] === ']') depth -= 1;
    if (depth === 0) break;
    cursor += 1;
  }
  if (depth !== 0 || text[cursor + 1] !== '(') return null;
  const alt = text.slice(index + 2, cursor);
  let end = cursor + 2;
  let parens = 1;
  while (end < text.length && parens > 0) {
    if (text[end] === '(') parens += 1;
    else if (text[end] === ')') parens -= 1;
    if (parens === 0) break;
    end += 1;
  }
  if (parens !== 0) return null;
  return { alt, dest: text.slice(cursor + 2, end).trim(), next: end + 1 };
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
    html: `<a href="${escapeHtml(url)}" rel="noopener">${renderInline(label)}</a>`,
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

// A tab is one Obsidian indent (four columns). Two spaces is a shallower
// step, so 2 spaces, 4 spaces, and a tab each nest on their own.
function indentWidth(indent) {
  let width = 0;
  for (const ch of indent) {
    if (ch === '\t') width += 4 - (width % 4);
    else width += 1;
  }
  return width;
}

function leading(line) {
  const indent = /^[ \t]*/.exec(line)[0];
  return { indent, width: indentWidth(indent), rest: line.slice(indent.length) };
}

function parseItem(line) {
  if (isHr(line)) return null;
  const task = parseTask(line);
  if (task) {
    return {
      kind: 'task',
      width: indentWidth(task.indent),
      checked: task.checked,
      text: task.text,
      flow: [],
    };
  }
  const lead = leading(line);
  let match = /^([-*+])[ \t]+(.*)$/.exec(lead.rest);
  if (match) {
    return { kind: 'bullet', width: lead.width, text: match[2], flow: [] };
  }
  match = /^(\d{1,9})[.)][ \t]+(.*)$/.exec(lead.rest);
  if (match) {
    return {
      kind: 'ordered',
      width: lead.width,
      number: Number(match[1]),
      text: match[2],
      flow: [],
    };
  }
  return null;
}

function startsBlock(line) {
  return Boolean(
    parseFenceLine(line)
    || parseHeading(line)
    || isHr(line)
    || isQuote(line)
    || parseItem(line)
    || isTableRow(line),
  );
}

function stopsList(line) {
  return Boolean(
    parseFenceLine(line)
    || parseHeading(line)
    || isHr(line)
    || isQuote(line)
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

function addChild(parent, child) {
  const last = parent.flow[parent.flow.length - 1];
  if (last && last.type === 'list') last.items.push(child);
  else parent.flow.push({ type: 'list', items: [child] });
}

function addParagraph(parent, text) {
  const last = parent.flow[parent.flow.length - 1];
  if (last && last.type === 'p') last.lines.push(text);
  else parent.flow.push({ type: 'p', lines: [text] });
}

// One list continues across blank lines. A shallower item is a sibling of
// an earlier deeper one, not a reason to start over. Indented text that is
// not itself an item belongs to the nearest shallower item.
function readList(lines, start) {
  const roots = [];
  const stack = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      let look = index + 1;
      while (look < lines.length && isBlank(lines[look])) look += 1;
      if (look < lines.length && parseItem(lines[look])) {
        index = look;
        continue;
      }
      break;
    }
    if (stopsList(line)) break;
    const item = parseItem(line);
    if (item) {
      while (stack.length && stack[stack.length - 1].width >= item.width) stack.pop();
      if (stack.length === 0) roots.push(item);
      else addChild(stack[stack.length - 1], item);
      stack.push(item);
      index += 1;
      continue;
    }
    const lead = leading(line);
    let owner = null;
    for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
      if (stack[depth].width < lead.width) {
        owner = stack[depth];
        break;
      }
    }
    if (!owner) break;
    while (stack.length && stack[stack.length - 1] !== owner) stack.pop();
    addParagraph(owner, lead.rest);
    index += 1;
  }

  return { items: roots, next: index };
}

function renderItemContent(item, usedIds) {
  const heading = parseHeading(item.text);
  if (heading) {
    const id = headingId(heading.text, usedIds);
    return `<h${heading.level} id="${escapeHtml(id)}" data-heading="${escapeHtml(heading.text)}">${renderInline(heading.text)}</h${heading.level}>`;
  }
  if (item.kind === 'task') {
    const done = item.checked ? ' is-done' : '';
    return `<span class="task-text${done}">${renderInline(item.text)}</span>`;
  }
  return `<span class="item-text">${renderInline(item.text)}</span>`;
}

function renderItem(item, tasks, parentWidth, usedIds) {
  const cols = Math.max(0, item.width - parentWidth);
  const content = renderItemContent(item, usedIds);
  let line;
  if (item.kind === 'task') {
    const pressed = item.checked ? 'true' : 'false';
    const label = item.checked ? 'Mark not done' : 'Mark done';
    const mark = item.checked ? CHECK : '';
    const index = tasks.n;
    tasks.n += 1;
    line = `<div class="task-line"><button type="button" class="task-toggle" data-task-index="${index}" aria-pressed="${pressed}" aria-label="${label}"><span class="task-box" aria-hidden="true">${mark}</span></button>${content}</div>`;
  } else if (item.kind === 'ordered') {
    line = `<div class="bullet-line"><span class="item-marker item-number">${item.number}.</span>${content}</div>`;
  } else {
    line = `<div class="bullet-line"><span class="item-marker" aria-hidden="true"></span>${content}</div>`;
  }
  const flow = renderFlow(item.flow, tasks, item.width, usedIds);
  const body = flow ? `<div class="item-body">${flow}</div>` : '';
  const cls = item.kind === 'task' ? 'task' : item.kind === 'ordered' ? 'ordered' : 'bullet';
  const value = item.kind === 'ordered' ? ` value="${item.number}"` : '';
  return `<li class="${cls}"${value} style="--cols:${cols}">${line}${body}</li>`;
}

function renderItems(items, tasks, parentWidth, usedIds) {
  let html = '';
  let group = [];
  let kind = null;
  const flush = () => {
    if (!group.length) return;
    const tag = kind === 'ordered' ? 'ol' : 'ul';
    const start = kind === 'ordered' && group[0].number !== 1 ? ` start="${group[0].number}"` : '';
    html += `<${tag} class="md-list"${start}>${group.map((item) => renderItem(item, tasks, parentWidth, usedIds)).join('')}</${tag}>`;
    group = [];
  };
  for (const item of items) {
    const next = item.kind === 'ordered' ? 'ordered' : 'bullet';
    if (kind && next !== kind) flush();
    kind = next;
    group.push(item);
  }
  flush();
  return html;
}

function renderFlow(flow, tasks, parentWidth, usedIds) {
  let html = '';
  for (const part of flow) {
    if (part.type === 'p') {
      html += `<p>${part.lines.map((line) => renderInline(line)).join('<br>')}</p>`;
    } else {
      html += renderItems(part.items, tasks, parentWidth, usedIds);
    }
  }
  return html;
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

    if (parseItem(line)) {
      const list = readList(lines, index);
      html.push(renderItems(list.items, tasks, 0, usedIds));
      index = list.next;
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

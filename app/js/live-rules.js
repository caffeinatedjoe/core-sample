// Live Preview rules. Given an editor state and the selection ranges that
// count as active, lists what to draw: line classes, styled spans, hidden
// syntax and widgets. Nothing here edits the text or touches the DOM.
import { GFM, Language, defineLanguageFacet, markdownParser, syntaxTree } from '../vendor/codemirror.js';
import { parseTask } from './checklist.js';
import { describeImage, isSafeUrl, parseWikilink } from './markdown.js';

export const markdownLanguage = new Language(defineLanguageFacet(), markdownParser.configure([GFM]), [], 'markdown');

const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock']);
const SPAN_STYLES = { Emphasis: 'cm-em', StrongEmphasis: 'cm-strong', Strikethrough: 'cm-strike', InlineCode: 'cm-inline-code' };
const SPAN_MARKS = new Set(['EmphasisMark', 'StrikethroughMark']);
const LABEL_MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'Escape']);

function touches(ranges, from, to) {
  return ranges.some((range) => range.from <= to && range.to >= from);
}

// `---` on the first line opens frontmatter; the next `---` or `...` closes it.
export function frontmatterEnd(doc) {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== '---') return -1;
  const last = Math.min(doc.lines, 1000);
  for (let n = 2; n <= last; n += 1) {
    const text = doc.line(n).text.trimEnd();
    if (text === '---' || text === '...') return doc.line(n).to;
  }
  return -1;
}

function indentColumns(text) {
  let columns = 0;
  for (const ch of String(text ?? '')) {
    if (ch === ' ') columns += 1;
    else if (ch === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

function spaceAfter(doc, pos, limit) {
  let end = pos;
  while (end < limit && /[ \t]/.test(doc.sliceString(end, end + 1))) end += 1;
  return end;
}

function linkParts(state, node) {
  let open = null;
  let close = null;
  let url = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'LinkMark') {
      const text = state.doc.sliceString(child.from, child.to);
      if (text === '[' && !open) open = child;
      else if (text === ']' && open && !close) close = child;
    } else if (child.name === 'URL' && close) {
      url = child;
    }
  }
  if (!open || !close || !url) return null;
  if (state.doc.sliceString(close.to, close.to + 1) !== '(') return null;
  let label = '';
  let at = open.to;
  const skip = (inner) => {
    for (let child = inner.firstChild; child; child = child.nextSibling) {
      if (child.from >= close.from) break;
      if (LABEL_MARKS.has(child.name)) {
        label += state.doc.sliceString(at, child.from);
        at = child.name === 'Escape' ? child.from + 1 : child.to;
      } else {
        skip(child);
      }
    }
  };
  skip(node);
  label += state.doc.sliceString(at, close.from);
  return { labelFrom: open.to, labelTo: close.from, label, url: state.doc.sliceString(url.from, url.to) };
}

// Images and wiki-links follow the old preview's scanner, not the Lezer tree:
// Lezer reads `[[note]]` as a plain link and has no idea of vault embeds.
function scanLine(text, offset, inlineCode) {
  const found = [];
  let index = 0;
  while (index < text.length) {
    const code = inlineCode.find((range) => range.from === offset + index);
    if (code) {
      index = code.to - offset;
      continue;
    }
    if (text[index] === '!' && text[index + 1] === '[') {
      const image = describeImage(text, index);
      if (image) {
        found.push({ kind: 'image', from: offset + index, to: offset + image.next, image });
        index = image.next;
        continue;
      }
    }
    if (text.startsWith('[[', index)) {
      const end = text.indexOf(']]', index + 2);
      const parsed = end === -1 ? null : parseWikilink(text.slice(index + 2, end));
      if (parsed) {
        found.push({ kind: 'wikilink', from: offset + index, to: offset + end + 2, link: parsed });
        index = end + 2;
        continue;
      }
    }
    index += 1;
  }
  return found;
}

// `ranges` are the selection ranges to reveal raw syntax around. Pass none
// when the editor is not focused so the whole note renders.
export function liveSpecs(state, { ranges = [], from = 0, to = state.doc.length } = {}) {
  const { doc } = state;
  const tree = syntaxTree(state);
  const specs = [];
  const lineClasses = new Map();
  const lineAttrs = new Map();
  const addLine = (pos, cls, attrs) => {
    const at = doc.lineAt(pos).from;
    lineClasses.set(at, lineClasses.has(at) ? `${lineClasses.get(at)} ${cls}` : cls);
    if (attrs) lineAttrs.set(at, { ...lineAttrs.get(at), ...attrs });
  };
  const hang = (pos, indent) => {
    const at = doc.lineAt(pos).from;
    lineAttrs.set(at, { ...lineAttrs.get(at), style: `--list-hang:${indentColumns(indent)}ch` });
  };
  const mark = (a, b, cls) => { if (b > a) specs.push({ type: 'mark', from: a, to: b, cls }); };
  const hide = (a, b) => { if (b > a) specs.push({ type: 'hide', from: a, to: b }); };
  const replace = (a, b, widget) => specs.push({ type: 'replace', from: a, to: b, widget });
  const lineActive = (pos) => {
    const line = doc.lineAt(pos);
    return touches(ranges, line.from, line.to);
  };

  const fmEnd = frontmatterEnd(doc);
  if (fmEnd >= 0 && from <= fmEnd) {
    for (let pos = doc.lineAt(from).from; pos <= Math.min(fmEnd, to); pos = doc.lineAt(pos).to + 1) {
      addLine(pos, 'cm-frontmatter');
    }
  }

  const blocks = [];
  const inlineCode = [];
  tree.iterate({
    from,
    to,
    enter(node) {
      if (!CODE_NODES.has(node.name)) return undefined;
      (node.name === 'InlineCode' ? inlineCode : blocks).push({ from: node.from, to: node.to });
      return false;
    },
  });

  const claims = [];
  const first = doc.lineAt(Math.min(doc.length, Math.max(from, fmEnd + 1)));
  for (let n = first.number; n <= doc.lineAt(to).number; n += 1) {
    const line = doc.line(n);
    if (line.to <= fmEnd) continue;
    if (blocks.some((block) => block.from <= line.from && block.to >= line.to && line.length)) continue;
    const task = parseTask(line.text);
    if (task) {
      const a = line.from + task.indent.length;
      const b = line.from + task.markIndex + 2;
      claims.push({ from: a, to: b });
      if (touches(ranges, a, b)) mark(a, b, 'cm-task-source');
      else replace(a, b, { kind: 'task', checked: task.checked });
      if (task.checked) mark(b, line.to, 'cm-task-done');
      addLine(line.from, 'cm-task-line');
      hang(line.from, task.indent);
    }
    for (const item of scanLine(line.text, line.from, inlineCode)) {
      claims.push(item);
      if (item.kind === 'image') {
        if (touches(ranges, line.from, line.to)) {
          mark(item.from, item.to, 'cm-image-source');
          specs.push({ type: 'widget', at: item.to, widget: { kind: 'image', image: item.image } });
        } else {
          replace(item.from, item.to, { kind: 'image', image: item.image });
        }
      } else if (touches(ranges, item.from, item.to)) {
        mark(item.from, item.to, 'cm-wikilink-source');
      } else {
        const { target, heading, label } = item.link;
        replace(item.from, item.to, { kind: 'wikilink', target, heading: heading || '', label });
      }
    }
  }
  const inClaim = (a, b) => claims.some((claim) => claim.from <= a && claim.to >= b);
  const overlapsClaim = (a, b) => claims.some((claim) => claim.from < b && claim.to > a);

  tree.iterate({
    from,
    to,
    enter(node) {
      const { name } = node;
      if (node.to <= fmEnd) return false;
      if (inClaim(node.from, node.to) && name !== 'Document') return false;
      const parent = node.node.parent;
      const heading = /^ATXHeading(\d)$/.exec(name);
      if (heading) {
        addLine(node.from, `cm-heading cm-h${heading[1]}`);
        return undefined;
      }
      const setext = /^SetextHeading(\d)$/.exec(name);
      if (setext) {
        const markNode = node.node.getChild('HeaderMark');
        const end = markNode ? doc.lineAt(markNode.from).from : node.to;
        for (let pos = node.from; pos < end; pos = doc.lineAt(pos).to + 1) addLine(pos, `cm-heading cm-h${setext[1]}`);
        if (markNode) mark(markNode.from, markNode.to, 'cm-mark');
        return undefined;
      }
      if (name === 'HeaderMark' && parent && /^ATXHeading/.test(parent.name)) {
        if (lineActive(node.from)) mark(node.from, node.to, 'cm-mark');
        else if (node.from === parent.from) hide(node.from, spaceAfter(doc, node.to, parent.to));
        else {
          let start = node.from;
          while (start > parent.from && /[ \t]/.test(doc.sliceString(start - 1, start))) start -= 1;
          hide(start, node.to);
        }
        return undefined;
      }
      if (SPAN_STYLES[name]) {
        mark(node.from, node.to, SPAN_STYLES[name]);
        return undefined;
      }
      if (SPAN_MARKS.has(name) || (name === 'CodeMark' && parent?.name === 'InlineCode')) {
        if (parent && touches(ranges, parent.from, parent.to)) mark(node.from, node.to, 'cm-mark');
        else hide(node.from, node.to);
        return undefined;
      }
      if (name === 'Link') {
        if (overlapsClaim(node.from, node.to)) return false;
        const parts = linkParts(state, node.node);
        if (!parts) return undefined;
        if (touches(ranges, node.from, node.to)) {
          mark(parts.labelFrom, parts.labelTo, 'cm-link');
          mark(parts.labelTo, node.to, 'cm-url');
          return undefined;
        }
        replace(node.from, node.to, { kind: 'link', label: parts.label, href: isSafeUrl(parts.url) ? parts.url.trim() : '' });
        return false;
      }
      if (name === 'Image') return overlapsClaim(node.from, node.to) ? false : undefined;
      if (name === 'Blockquote') {
        for (let pos = Math.max(node.from, from); pos <= Math.min(node.to, to); pos = doc.lineAt(pos).to + 1) addLine(pos, 'cm-quote');
        return undefined;
      }
      if (name === 'QuoteMark') {
        if (lineActive(node.from)) mark(node.from, node.to, 'cm-mark');
        else hide(node.from, spaceAfter(doc, node.to, Math.min(node.to + 1, doc.lineAt(node.from).to)));
        return undefined;
      }
      if (name === 'ListMark' && parent?.parent) {
        const line = doc.lineAt(node.from);
        addLine(line.from, 'cm-list-line');
        hang(line.from, line.text.slice(0, node.from - line.from));
        if (parent.parent.name === 'OrderedList') mark(node.from, node.to, 'cm-list-number');
        else if (touches(ranges, node.from, node.to)) mark(node.from, node.to, 'cm-mark');
        else replace(node.from, node.to, { kind: 'bullet' });
        return undefined;
      }
      if (name === 'HorizontalRule') {
        addLine(node.from, 'cm-hr-line');
        if (lineActive(node.from)) mark(node.from, node.to, 'cm-mark');
        else replace(node.from, node.to, { kind: 'rule' });
        return false;
      }
      if (name === 'FencedCode') {
        const open = doc.lineAt(node.from);
        const close = doc.lineAt(node.to);
        const infoNode = node.node.getChild('CodeInfo');
        const info = infoNode ? doc.sliceString(infoNode.from, infoNode.to).trim() : '';
        const lang = info.toLowerCase();
        const marks = node.node.getChildren('CodeMark');
        const closed = marks.length > 1 && close.number > open.number;
        const dataview = (lang === 'dataview' || lang === 'dataviewjs') && closed && !touches(ranges, node.from, node.to);
        if (dataview) {
          const parts = [];
          for (let n = open.number + 1; n < close.number; n += 1) parts.push(doc.line(n).text);
          replace(open.from, open.to, { kind: 'dataview', lang, query: parts.join('\n') });
          for (let n = open.number + 1; n <= close.number; n += 1) {
            const line = doc.line(n);
            addLine(line.from, 'cm-dv-rest');
            hide(line.from, line.to);
          }
          return false;
        }
        for (let n = open.number; n <= close.number; n += 1) {
          const line = doc.line(n);
          if (line.to < from || line.from > to) continue;
          let cls = 'cm-code-block';
          if (n === open.number) cls += ' cm-code-first';
          if (n === close.number) cls += ' cm-code-last';
          addLine(line.from, cls);
        }
        if (touches(ranges, node.from, node.to)) {
          for (const item of marks) mark(item.from, item.to, 'cm-mark');
          if (infoNode) mark(infoNode.from, infoNode.to, 'cm-mark');
        } else {
          replace(open.from, open.to, { kind: 'fence', info });
          if (closed) hide(close.from, close.to);
        }
        return false;
      }
      if (name === 'CodeBlock') {
        for (let pos = Math.max(node.from, from); pos <= Math.min(node.to, to); pos = doc.lineAt(pos).to + 1) addLine(pos, 'cm-code-block');
        return false;
      }
      if (name === 'Table') {
        for (let pos = Math.max(node.from, from); pos <= Math.min(node.to, to); pos = doc.lineAt(pos).to + 1) addLine(pos, 'cm-table');
        return false;
      }
      return undefined;
    },
  });

  const out = [];
  for (const [at, cls] of lineClasses) {
    const spec = { type: 'line', at, cls };
    if (lineAttrs.has(at)) spec.attrs = lineAttrs.get(at);
    out.push(spec);
  }
  const covering = specs.filter((spec) => spec.type === 'replace' || spec.type === 'hide')
    .sort((a, b) => a.from - b.from || b.to - a.to);
  let reach = -1;
  for (const spec of covering) {
    if (spec.from < reach) continue;
    out.push(spec);
    reach = spec.to;
  }
  for (const spec of specs) if (spec.type === 'mark' || spec.type === 'widget') out.push(spec);
  return out.sort((a, b) => (a.at ?? a.from) - (b.at ?? b.from));
}

// The one-character change a checkbox tap makes, or null when the line at
// `pos` is not a task. Same characters as checklist.js toggleChecklist.
export function taskToggle(state, pos) {
  const line = state.doc.lineAt(pos);
  const task = parseTask(line.text);
  if (!task) return null;
  let inCode = false;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.from,
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') inCode = true;
    },
  });
  if (inCode) return null;
  const at = line.from + task.markIndex;
  return { from: at, to: at + 1, insert: task.checked ? ' ' : 'x' };
}

// Where a `#heading` link lands: the start of the first matching heading
// line, compared the way the old preview's data-heading was.
export function headingOffset(text, heading) {
  const want = String(heading || '').trim().toLowerCase();
  if (!want) return -1;
  let offset = 0;
  let fence = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch && (!fence || fenceMatch[1][0] === fence)) fence = fence ? null : fenceMatch[1][0];
    else if (!fence) {
      const match = /^(#{1,6})\s+(\S.*)$/.exec(line);
      if (match && match[2].replace(/\s+#+\s*$/, '').trim().toLowerCase() === want) return offset;
    }
    offset += raw.length + 1;
  }
  return -1;
}

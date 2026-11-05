// Heading sections for Live Preview fold. Keys are level + title so a
// later edit that only shifts offsets can still find the same heading.

function stripCR(line) {
  return String(line ?? '').replace(/\r$/, '');
}

export function headingTitle(line) {
  const text = stripCR(line);
  const atx = /^(#{1,6})[ \t]+(\S.*)$/.exec(text);
  if (atx) return { level: atx[1].length, title: atx[2].replace(/[ \t]+#+\s*$/, '').trim() };
  return null;
}

export function foldKey(level, title) {
  return `h${level}:${String(title || '').trim().toLowerCase()}`;
}

export function headingSections(doc) {
  const sections = [];
  if (!doc || !doc.lines) return sections;
  for (let n = 1; n <= doc.lines; n += 1) {
    const line = doc.line(n);
    const head = headingTitle(line.text);
    if (!head) continue;
    sections.push({
      level: head.level,
      title: head.title,
      key: foldKey(head.level, head.title),
      lineFrom: line.from,
      lineTo: line.to,
      from: line.from,
      to: doc.length,
    });
  }
  for (let i = 0; i < sections.length; i += 1) {
    const cur = sections[i];
    for (let j = i + 1; j < sections.length; j += 1) {
      if (sections[j].level <= cur.level) {
        cur.to = sections[j].lineFrom;
        break;
      }
    }
    cur.hasBody = cur.to > cur.lineTo + 1;
  }
  return sections;
}

export function foldedRanges(sections, folds) {
  const hidden = [];
  const set = folds && typeof folds === 'object' ? folds : {};
  for (const section of sections) {
    if (!section.hasBody || !set[section.key]) continue;
    hidden.push({
      from: section.lineTo,
      to: section.to,
      key: section.key,
      title: section.title,
    });
  }
  return hidden;
}

export function toggleFold(folds, key) {
  const next = { ...(folds || {}) };
  if (next[key]) delete next[key];
  else next[key] = true;
  return next;
}

export function rememberFolds(all, path, folds) {
  const map = { ...(all && typeof all === 'object' ? all : {}) };
  const note = String(path || '');
  if (!note) return map;
  const keys = Object.keys(folds || {}).filter((key) => folds[key]);
  if (!keys.length) delete map[note];
  else {
    const kept = {};
    for (const key of keys) kept[key] = true;
    map[note] = kept;
  }
  return map;
}

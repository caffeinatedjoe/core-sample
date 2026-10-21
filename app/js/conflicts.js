// Three-way merge and the resolve plans. No DOM, so node tests can import it.

export const GITHUB_DELETED_TEXT = 'GitHub no longer has this note. The copy on this device was kept.\n';

const REASONS = {
  both: 'Edited on this phone and on GitHub',
  deleted: 'Deleted on GitHub while this phone had edits',
  delete: 'Delete was not sent because GitHub had changed the note',
  rename: 'Rename was not sent because GitHub had changed the old note',
  stale: 'GitHub moved the branch while saving, after three tries',
  legacy: 'Recorded before this version',
  existing: 'Recorded before this version',
};

export function reasonText(reason) {
  return REASONS[reason] || REASONS.legacy;
}

export function splitLines(text) {
  const value = String(text ?? '');
  const trailing = value.endsWith('\n');
  const body = trailing ? value.slice(0, -1) : value;
  if (body === '') return { lines: [], trailing };
  return { lines: body.split('\n'), trailing };
}

export function joinLines(lines, trailing) {
  const list = lines || [];
  if (!list.length) return trailing ? '\n' : '';
  return list.join('\n') + (trailing ? '\n' : '');
}

export function diffOps(baseLines, otherLines) {
  const a = baseLines || [];
  const b = otherLines || [];
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', line: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', line: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'insert', line: b[j] });
      j += 1;
    }
  }
  while (i < n) ops.push({ type: 'delete', line: a[i++] });
  while (j < m) ops.push({ type: 'insert', line: b[j++] });
  return ops;
}

export function lineEdits(baseLines, otherLines) {
  const regions = [];
  let index = 0;
  let start = 0;
  let removed = 0;
  let inserted = [];
  let open = false;
  function flush() {
    if (!open) return;
    regions.push({ start, end: start + removed, lines: inserted });
    removed = 0;
    inserted = [];
    open = false;
  }
  for (const op of diffOps(baseLines, otherLines)) {
    if (op.type === 'equal') {
      flush();
      index += 1;
      start = index;
    } else if (op.type === 'delete') {
      if (!open) {
        open = true;
        start = index;
      }
      removed += 1;
      index += 1;
    } else if (!open) {
      open = true;
      start = index;
      inserted = [op.line];
    } else {
      inserted.push(op.line);
    }
  }
  flush();
  return regions;
}

function sameLines(left, right) {
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

function applyEdits(baseLines, edits, start, end) {
  if (start === end) {
    return edits.flatMap((edit) => edit.lines);
  }
  const sorted = edits.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let cursor = start;
  for (const edit of sorted) {
    const from = Math.max(edit.start, start);
    if (from > cursor) out.push(...baseLines.slice(cursor, from));
    out.push(...edit.lines);
    cursor = Math.max(cursor, edit.end);
  }
  if (cursor < end) out.push(...baseLines.slice(cursor, end));
  return out;
}

function pushSame(hunks, lines) {
  if (!lines.length) return;
  const prev = hunks[hunks.length - 1];
  if (prev && prev.kind === 'same') prev.lines.push(...lines);
  else hunks.push({ kind: 'same', lines: lines.slice() });
}

export function merge3(baseText, localText, remoteText) {
  const base = splitLines(baseText);
  const local = splitLines(localText);
  const remote = splitLines(remoteText);
  const trailing = base.trailing || local.trailing || remote.trailing;
  if (localText === remoteText) {
    return {
      auto: true,
      text: localText,
      trailing,
      hunks: local.lines.length ? [{ kind: 'same', lines: local.lines.slice() }] : [],
    };
  }
  const left = lineEdits(base.lines, local.lines);
  const right = lineEdits(base.lines, remote.lines);
  const hunks = [];
  let i = 0;
  const limit = base.lines.length;
  while (i <= limit) {
    const insertsL = left.filter((edit) => edit.start === i && edit.end === i);
    const insertsR = right.filter((edit) => edit.start === i && edit.end === i);
    if (insertsL.length || insertsR.length) {
      const phone = applyEdits(base.lines, insertsL, i, i);
      const github = applyEdits(base.lines, insertsR, i, i);
      if (!insertsR.length) pushSame(hunks, phone);
      else if (!insertsL.length) pushSame(hunks, github);
      else if (sameLines(phone, github)) pushSame(hunks, phone);
      else {
        hunks.push({
          kind: 'conflict',
          phone,
          github,
          base: [],
          decision: null,
          order: 'phone-first',
        });
      }
      for (const edit of insertsL) left.splice(left.indexOf(edit), 1);
      for (const edit of insertsR) right.splice(right.indexOf(edit), 1);
      continue;
    }
    const rangeL = left.filter((edit) => edit.start <= i && i < edit.end);
    const rangeR = right.filter((edit) => edit.start <= i && i < edit.end);
    if (!rangeL.length && !rangeR.length) {
      if (i < limit) pushSame(hunks, [base.lines[i]]);
      i += 1;
      continue;
    }
    let start = i;
    let end = i;
    const useL = [];
    const useR = [];
    let grew = true;
    while (grew) {
      grew = false;
      for (const edit of left) {
        if (useL.includes(edit)) continue;
        if (edit.start < Math.max(end, start + 1) && edit.end > start) {
          useL.push(edit);
          start = Math.min(start, edit.start);
          end = Math.max(end, edit.end);
          grew = true;
        }
      }
      for (const edit of right) {
        if (useR.includes(edit)) continue;
        if (edit.start < Math.max(end, start + 1) && edit.end > start) {
          useR.push(edit);
          start = Math.min(start, edit.start);
          end = Math.max(end, edit.end);
          grew = true;
        }
      }
    }
    const phone = applyEdits(base.lines, useL, start, end);
    const github = applyEdits(base.lines, useR, start, end);
    if (!useR.length) pushSame(hunks, phone);
    else if (!useL.length) pushSame(hunks, github);
    else if (sameLines(phone, github)) pushSame(hunks, phone);
    else {
      hunks.push({
        kind: 'conflict',
        phone,
        github,
        base: base.lines.slice(start, end),
        decision: null,
        order: 'phone-first',
      });
    }
    for (const edit of useL) left.splice(left.indexOf(edit), 1);
    for (const edit of useR) right.splice(right.indexOf(edit), 1);
    i = Math.max(end, start + 1);
  }
  hunks.forEach((hunk, index) => {
    hunk.id = index;
  });
  const conflicts = hunks.filter((hunk) => hunk.kind === 'conflict');
  const lines = [];
  if (!conflicts.length) {
    for (const hunk of hunks) lines.push(...hunk.lines);
  }
  return {
    auto: conflicts.length === 0,
    text: conflicts.length ? '' : joinLines(lines, trailing),
    trailing,
    hunks,
  };
}

export function merge2(localText, remoteText) {
  if (localText === remoteText) return merge3(localText, localText, remoteText);
  const local = splitLines(localText);
  const remote = splitLines(remoteText);
  return {
    auto: false,
    text: '',
    trailing: local.trailing || remote.trailing,
    hunks: [{
      kind: 'conflict',
      id: 0,
      phone: local.lines,
      github: remote.lines,
      base: [],
      decision: null,
      order: 'phone-first',
    }],
  };
}

export function hunksForConflict(file, sibling) {
  const local = String(file?.content ?? '');
  const remote = typeof file?.conflictRemote === 'string' && file.conflictRemote !== ''
    ? file.conflictRemote
    : String(sibling?.content ?? '');
  if (typeof file?.conflictBase === 'string') return merge3(file.conflictBase, local, remote);
  return merge2(local, remote);
}

export function sideMarks(baseLines, sideLines) {
  return diffOps(baseLines || [], sideLines || []).map((op) => ({
    mark: op.type === 'insert' ? '+' : op.type === 'delete' ? '−' : '',
    word: op.type === 'insert' ? 'Added' : op.type === 'delete' ? 'Removed' : '',
    text: op.line,
  }));
}

export function unresolvedCount(hunks) {
  return (hunks || []).filter((hunk) => hunk.kind === 'conflict' && !hunk.decision).length;
}

export function mergedText(hunks, trailing = true) {
  const lines = [];
  for (const hunk of hunks || []) {
    if (hunk.kind === 'same') {
      lines.push(...hunk.lines);
      continue;
    }
    if (hunk.decision === 'phone') lines.push(...hunk.phone);
    else if (hunk.decision === 'github') lines.push(...hunk.github);
    else if (hunk.decision === 'both') {
      const phoneFirst = hunk.order !== 'github-first';
      lines.push(...(phoneFirst ? hunk.phone : hunk.github));
      lines.push(...(phoneFirst ? hunk.github : hunk.phone));
    }
  }
  if (!lines.length) return '';
  return joinLines(lines, trailing);
}

export function decideAll(hunks, decision, order = 'phone-first') {
  return (hunks || []).map((hunk) => {
    if (hunk.kind !== 'conflict') return hunk;
    return { ...hunk, decision, order: decision === 'both' ? order : hunk.order };
  });
}

function dayKey(date) {
  return date.getFullYear() * 10000 + date.getMonth() * 100 + date.getDate();
}

function clockLabel(date) {
  const hour24 = date.getHours();
  const hour = hour24 % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${hour}:${minute} ${hour24 < 12 ? 'AM' : 'PM'}`;
}

export function formatWhen(ms, now = Date.now()) {
  const time = Number(ms);
  if (!time || Number.isNaN(time)) return '';
  const date = new Date(time);
  const today = new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(today.getTime())) return '';
  const clock = clockLabel(date);
  if (dayKey(date) === dayKey(today)) return `Today ${clock}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return `Yesterday ${clock}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const year = date.getFullYear() === today.getFullYear() ? '' : `, ${date.getFullYear()}`;
  return `${months[date.getMonth()]} ${date.getDate()}${year}, ${clock}`;
}

function stemOf(path) {
  const slash = String(path).lastIndexOf('/');
  const base = slash >= 0 ? path.slice(slash + 1) : String(path);
  return base.replace(/\.md$/i, '');
}

function dirOf(path) {
  const slash = String(path).lastIndexOf('/');
  return slash >= 0 ? path.slice(0, slash + 1) : '';
}

export function datedCopyPath(path, label, when, taken = new Set()) {
  const stamp = new Date(when);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
  const dir = dirOf(path);
  const stem = stemOf(path);
  let name = `${dir}${stem} (${label} ${date}).md`;
  let n = 2;
  while (taken.has(name)) {
    name = `${dir}${stem} (${label} ${date}-${n}).md`;
    n += 1;
  }
  return name;
}

function inferReason(file, sibling) {
  if (file?.conflictReason) return file.conflictReason;
  if (sibling && sibling.content === GITHUB_DELETED_TEXT) return 'deleted';
  if (file?.conflict) return 'legacy';
  return 'legacy';
}

export function listConflicts(files) {
  const live = (files || []).filter((file) => file && file.kind === 'markdown' && !file.trashedAt && !file.backup);
  const siblings = live.filter((file) => file.conflictCopy);
  const notes = live.filter((file) => file.conflict === true && !file.conflictCopy);
  const items = [];
  const claimed = new Set();
  for (const file of notes) {
    const stem = stemOf(file.path);
    const dir = dirOf(file.path);
    const sibling = siblings.find((copy) => !claimed.has(copy.path) && copy.path.startsWith(dir) && stemOf(copy.path).startsWith(stem) && copy.path.includes('(conflict '));
    if (sibling) claimed.add(sibling.path);
    items.push({
      path: file.path,
      role: 'note',
      reason: inferReason(file, sibling),
      why: reasonText(inferReason(file, sibling)),
      when: file.conflictAt || null,
      whenLabel: file.conflictAt ? formatWhen(file.conflictAt) : '',
      siblingPath: sibling ? sibling.path : '',
    });
  }
  for (const sibling of siblings) {
    const original = notes.find((file) => {
      const stem = stemOf(file.path);
      return sibling.path.startsWith(dirOf(file.path)) && stemOf(sibling.path).startsWith(stem);
    });
    items.push({
      path: sibling.path,
      role: 'sibling',
      reason: 'legacy',
      why: claimed.has(sibling.path) ? 'GitHub copy kept beside the note' : 'Conflict copy with no matching note',
      when: sibling.createdAt || null,
      whenLabel: sibling.createdAt ? formatWhen(sibling.createdAt) : '',
      originalPath: original ? original.path : '',
      linked: claimed.has(sibling.path),
    });
  }
  return items;
}

function cleared(file, extra) {
  return {
    ...file,
    ...extra,
    conflict: false,
    conflictCopy: false,
    conflictAt: null,
    conflictReason: '',
    conflictRemote: '',
    conflictRemoteSha: '',
    conflictBase: '',
  };
}

function backupFile(path, content, now) {
  return {
    path,
    content,
    kind: 'markdown',
    encoding: 'utf-8',
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    remoteSha: null,
    baseSha: null,
    dirty: false,
    conflict: false,
    conflictCopy: true,
    backup: true,
  };
}

export function planResolution({
  file,
  hunks,
  trailing = true,
  editedText = null,
  mode = 'merge',
  now = Date.now(),
  taken = new Set(),
} = {}) {
  if (!file) throw new Error('That note is not on this device.');
  const remoteText = typeof file.conflictRemote === 'string' ? file.conflictRemote : '';
  const remoteSha = file.conflictRemoteSha || '';
  const phoneText = String(file.content ?? '');
  const generated = mode === 'phone'
    ? phoneText
    : mode === 'github'
      ? remoteText
      : mergedText(hunks, trailing);
  const text = mode === 'separate' ? remoteText : (editedText == null ? generated : String(editedText));
  const names = new Set(taken);
  names.add(file.path);
  const discarded = [];
  if (mode !== 'separate') {
    if (text !== phoneText) discarded.push(phoneText);
    if (text !== remoteText && remoteText) discarded.push(remoteText);
  }
  const backup = discarded.length
    ? backupFile(datedCopyPath(file.path, 'backup', now, names), `${discarded.join(discarded.length > 1 ? '\n---\n' : '')}`, now)
    : null;
  if (backup) names.add(backup.path);

  if (mode === 'separate') {
    const phonePath = datedCopyPath(file.path, 'phone', now, names);
    const phone = cleared({
      ...file,
      path: phonePath,
      content: phoneText,
      remoteSha: null,
      baseSha: null,
      dirty: true,
      updatedAt: now,
      origin: 'user',
      localOnly: false,
    }, {});
    const original = cleared(file, {
      content: remoteText === GITHUB_DELETED_TEXT ? phoneText : remoteText,
      remoteSha: remoteText === GITHUB_DELETED_TEXT ? null : (remoteSha || file.remoteSha || null),
      baseSha: remoteText === GITHUB_DELETED_TEXT ? null : (remoteSha || file.baseSha || null),
      dirty: remoteText === GITHUB_DELETED_TEXT,
      updatedAt: now,
    });
    if (remoteText === GITHUB_DELETED_TEXT) {
      return {
        put: [phone],
        remove: [file.path],
        backup: null,
        summary: 'Kept both notes. GitHub no longer has the original.',
      };
    }
    return {
      put: [original, phone],
      remove: [],
      backup: null,
      summary: 'Kept both notes.',
    };
  }

  if (mode === 'github' && (file.conflictReason === 'deleted' || remoteText === GITHUB_DELETED_TEXT)) {
    return {
      put: backup ? [backup] : [],
      remove: [file.path],
      backup,
      summary: 'Kept the GitHub version. The phone copy is in a backup note.',
    };
  }

  const keepGithub = mode === 'github';
  const resolved = cleared(file, {
    content: text,
    remoteSha: keepGithub ? (remoteSha || file.remoteSha || null) : (file.remoteSha || null),
    baseSha: keepGithub ? (remoteSha || file.baseSha || null) : (remoteSha || file.baseSha || ''),
    dirty: !keepGithub,
    updatedAt: now,
  });
  return {
    put: backup ? [resolved, backup] : [resolved],
    remove: [],
    backup,
    summary: keepGithub
      ? 'Kept the GitHub version. The phone copy is in a backup note.'
      : 'Kept the merged note. The discarded side is in a backup note.',
  };
}

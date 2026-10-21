import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  decideAll,
  formatWhen,
  hunksForConflict,
  listConflicts,
  merge2,
  merge3,
  mergedText,
  planResolution,
  reasonText,
  sideMarks,
  unresolvedCount,
} from '../app/js/conflicts.js';

test('non-overlapping edits auto-merge and identical edits collapse', () => {
  const base = 'one\ntwo\nthree\n';
  const local = 'ONE\ntwo\nthree\n';
  const remote = 'one\ntwo\nTHREE\n';
  const merged = merge3(base, local, remote);
  assert.equal(merged.auto, true);
  assert.equal(merged.text, 'ONE\ntwo\nTHREE\n');
  assert.equal(merged.hunks.some((hunk) => hunk.kind === 'conflict'), false);

  const same = merge3(base, 'ONE\ntwo\nthree\n', 'ONE\ntwo\nthree\n');
  assert.equal(same.auto, true);
  assert.equal(same.text, 'ONE\ntwo\nthree\n');

  const overlap = merge3(base, 'ONE\ntwo\nthree\n', '1\ntwo\nthree\n');
  assert.equal(overlap.auto, false);
  const conflict = overlap.hunks.find((hunk) => hunk.kind === 'conflict');
  assert.deepEqual(conflict.phone, ['ONE']);
  assert.deepEqual(conflict.github, ['1']);
  assert.equal(unresolvedCount(overlap.hunks), 1);
});

test('insertions at the same point conflict, and apart they merge', () => {
  const together = merge3('a\n', 'a\nphone\n', 'a\ngithub\n');
  assert.equal(together.auto, false);
  const apart = merge3('a\n', 'phone\na\n', 'a\ngithub\n');
  assert.equal(apart.auto, true);
  assert.equal(apart.text, 'phone\na\ngithub\n');
});

test('a missing base is one conflict, and decisions build the text', () => {
  const two = merge2('phone\n', 'github\n');
  assert.equal(two.auto, false);
  assert.equal(mergedText(two.hunks, true), '');
  const phone = decideAll(two.hunks, 'phone');
  assert.equal(unresolvedCount(phone), 0);
  assert.equal(mergedText(phone, true), 'phone\n');
  const both = decideAll(two.hunks, 'both', 'github-first');
  assert.equal(mergedText(both, true), 'github\nphone\n');
});

test('side marks name additions and removals', () => {
  const marks = sideMarks(['old', 'keep'], ['keep', 'new']);
  assert.equal(marks.some((line) => line.mark === '−' && line.word === 'Removed' && line.text === 'old'), true);
  assert.equal(marks.some((line) => line.mark === '+' && line.word === 'Added' && line.text === 'new'), true);
});

test('the conflict list names legacy notes and sibling copies', () => {
  const when = Date.parse('2026-10-21T19:18:00Z');
  const whenDate = new Date(when);
  const hour24 = whenDate.getHours();
  const hour = hour24 % 12 || 12;
  const minute = String(whenDate.getMinutes()).padStart(2, '0');
  assert.equal(formatWhen(when, when), `Today ${hour}:${minute} ${hour24 < 12 ? 'AM' : 'PM'}`);
  const yesterday = new Date(whenDate.getFullYear(), whenDate.getMonth(), whenDate.getDate() - 1, 15, 4, 0, 0);
  const yesterdayHour = yesterday.getHours();
  assert.equal(
    formatWhen(yesterday.getTime(), when),
    `Yesterday ${yesterdayHour % 12 || 12}:${String(yesterday.getMinutes()).padStart(2, '0')} ${yesterdayHour < 12 ? 'AM' : 'PM'}`,
  );
  const older = new Date(whenDate.getFullYear() - 1, 0, 5, 9, 5, 0, 0);
  assert.equal(formatWhen(older.getTime(), when), `Jan 5, ${older.getFullYear()}, 9:05 AM`);
  assert.equal(reasonText('both'), 'Edited on this phone and on GitHub');
  const items = listConflicts([
    {
      path: 'Field Notes.md',
      kind: 'markdown',
      content: 'mine\n',
      conflict: true,
      conflictAt: when,
      conflictReason: 'both',
      trashedAt: null,
    },
    {
      path: 'Field Notes (conflict 2026-10-21 1918).md',
      kind: 'markdown',
      content: 'theirs\n',
      conflictCopy: true,
      createdAt: when,
      trashedAt: null,
    },
    {
      path: 'Field Notes (backup 2026-10-21 1918).md',
      kind: 'markdown',
      backup: true,
      conflictCopy: true,
      trashedAt: null,
    },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].role, 'note');
  assert.equal(items[0].why, 'Edited on this phone and on GitHub');
  assert.equal(items[0].siblingPath.includes('(conflict '), true);
  assert.equal(items[1].role, 'sibling');
});

test('resolve plans keep a backup of the discarded side', () => {
  const file = {
    path: 'Field Notes.md',
    content: 'phone\n',
    kind: 'markdown',
    conflict: true,
    conflictRemote: 'github\n',
    conflictRemoteSha: 'blob-9',
    conflictBase: 'base\n',
    baseSha: 'blob-1',
    remoteSha: 'blob-1',
    updatedAt: 5,
  };
  const merged = merge3(file.conflictBase, file.content, file.conflictRemote);
  const chosen = decideAll(merged.hunks, 'phone');
  const plan = planResolution({
    file,
    hunks: chosen,
    mode: 'merge',
    editedText: 'phone and a handwritten line\n',
    now: Date.parse('2026-10-21T19:18:00Z'),
    taken: new Set([file.path]),
  });
  const saved = plan.put.find((item) => item.path === file.path);
  assert.equal(saved.content, 'phone and a handwritten line\n');
  assert.equal(saved.conflict, false);
  assert.equal(saved.dirty, true);
  assert.equal(saved.baseSha, 'blob-9');
  const backup = plan.put.find((item) => item.backup);
  assert.ok(backup);
  assert.equal(backup.conflictCopy, true);
  assert.equal(backup.dirty, false);
  assert.equal(backup.content.includes('github'), true);

  const separate = planResolution({
    file,
    hunks: merged.hunks,
    mode: 'separate',
    now: Date.parse('2026-10-21T19:18:00Z'),
    taken: new Set([file.path]),
  });
  const phone = separate.put.find((item) => item.path.includes('(phone '));
  const original = separate.put.find((item) => item.path === file.path);
  assert.equal(phone.content, 'phone\n');
  assert.equal(phone.dirty, true);
  assert.equal(original.content, 'github\n');
  assert.equal(original.dirty, false);
  assert.equal(original.conflict, false);

  const legacy = hunksForConflict({ content: 'mine\n', conflict: true }, { content: 'theirs\n' });
  assert.equal(legacy.auto, false);
  assert.deepEqual(legacy.hunks[0].github, ['theirs']);
});

test('addition and deletion colors pass contrast in light and dark', () => {
  const css = readFileSync(new URL('../app/css/app.css', import.meta.url), 'utf8');
  const pairs = [
    ['#14532d', '#e7f6e9'],
    ['#7f1d1d', '#fde8e6'],
    ['#b7ebc6', '#143028'],
    ['#fecaca', '#3f2422'],
  ];
  for (const [ink, bg] of pairs) {
    assert.equal(css.includes(ink), true, ink);
    assert.equal(css.includes(bg), true, bg);
    assert.equal(contrast(ink, bg) >= 4.5, true, `${ink} on ${bg}`);
  }
});

function contrast(ink, bg) {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const channel = (value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const r = channel((n >> 16) & 255);
    const g = channel((n >> 8) & 255);
    const b = channel(n & 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const hi = Math.max(lum(ink), lum(bg));
  const lo = Math.min(lum(ink), lum(bg));
  return (hi + 0.05) / (lo + 0.05);
}

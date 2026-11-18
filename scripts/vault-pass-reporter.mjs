// Node test reporter for the scripted vault pass. Prints a pass/fail table
// and, in GitHub Actions, appends the same table to $GITHUB_STEP_SUMMARY.
import { appendFileSync } from 'node:fs';

function isSuite(event) {
  return event.data?.details?.type === 'suite';
}

function checkName(event) {
  return String(event.data?.name || '').trim() || '(unnamed)';
}

function failDetail(event) {
  const error = event.data?.details?.error;
  const message = error && error.message ? String(error.message).split('\n')[0] : 'failed';
  const file = event.data?.file ? String(event.data.file).split('/').slice(-2).join('/') : '';
  const line = event.data?.line ? `:${event.data.line}` : '';
  return `${message}${file ? ` (${file}${line})` : ''}`;
}

function markdownTable(rows, durationMs) {
  const lines = [
    '## Vault pass',
    '',
    '| Check | Result |',
    '| --- | --- |',
  ];
  for (const row of rows) {
    const result = row.ok ? 'pass' : `FAIL — ${row.detail.replace(/\|/g, '\\|')}`;
    lines.push(`| ${row.name.replace(/\|/g, '\\|')} | ${result} |`);
  }
  const failed = rows.filter((row) => !row.ok).length;
  const passed = rows.length - failed;
  const seconds = (durationMs / 1000).toFixed(1);
  lines.push('');
  lines.push(`**${passed} passed**, ${failed} failed. Runtime ${seconds}s.`);
  if (failed) {
    lines.push('');
    lines.push('On failure, screenshots are uploaded from `$CONFLICT_SHOTS` (default `/tmp/core-sample-shots`).');
  }
  lines.push('');
  return lines.join('\n');
}

export default async function* vaultPassReporter(source) {
  const rows = [];
  const started = Date.now();
  for await (const event of source) {
    if (event.type === 'test:pass' && !isSuite(event)) {
      rows.push({ name: checkName(event), ok: true, detail: '' });
      yield `ok ${checkName(event)}\n`;
    } else if (event.type === 'test:fail' && !isSuite(event)) {
      const detail = failDetail(event);
      rows.push({ name: checkName(event), ok: false, detail });
      yield `not ok ${checkName(event)}\n  ${detail}\n`;
    } else if (event.type === 'test:fail' && event.data?.details?.error) {
      const err = event.data.details.error;
      if (err && err.stack) yield `${err.stack}\n`;
    }
  }
  const table = markdownTable(rows, Date.now() - started);
  yield `\n${table}\n`;
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, table);
    } catch {
      yield 'Could not write GITHUB_STEP_SUMMARY.\n';
    }
  }
}

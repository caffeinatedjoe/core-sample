import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('every full-screen view uses one safe-area frame', () => {
  const html = read('app/index.html');
  const css = read('app/css/app.css');
  const main = read('app/js/main.js');
  assert.match(html, /viewport-fit=cover/);
  assert.match(css, /--safe-top:\s*env\(safe-area-inset-top/);
  assert.match(css, /--safe-right:\s*env\(safe-area-inset-right/);
  assert.match(css, /--safe-bottom:\s*env\(safe-area-inset-bottom/);
  assert.match(css, /--safe-left:\s*env\(safe-area-inset-left/);
  const frame = css.slice(css.indexOf('.safe-frame {'), css.indexOf('.safe-frame {') + 240);
  assert.match(frame, /top:\s*var\(--safe-top\)/);
  assert.match(frame, /right:\s*var\(--safe-right\)/);
  assert.match(frame, /bottom:\s*calc\(var\(--safe-bottom\)\s*\+\s*var\(--keyboard-inset\)\)/);
  assert.match(frame, /left:\s*var\(--safe-left\)/);
  assert.match(html, /id="app"[^>]*class="[^"]*\bsafe-frame\b/);
  assert.match(html, /id="notes-sheet"[^>]*class="[^"]*\bsafe-frame\b/);
  for (const block of ['.top {', '.sheet-head {', '.build-version {', '.source {', '.preview {', '.sheet-card {']) {
    const start = css.indexOf(block);
    assert.ok(start !== -1, block);
    const body = css.slice(start, css.indexOf('}', start));
    assert.equal(body.includes('env(safe-area-inset'), false, `${block} has its own inset`);
  }
  assert.equal(css.includes('--vv-top'), false);
  assert.equal(css.includes('100vh'), false);
  assert.equal(main.includes('--vv-top'), false);
  assert.match(main, /--keyboard-inset/);
  assert.match(main, /window\.scrollTo\(0,\s*0\)/);
});

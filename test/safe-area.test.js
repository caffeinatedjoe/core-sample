import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function rule(css, selector) {
  const token = `${selector} {`;
  const start = css.indexOf(token);
  assert.ok(start !== -1, selector);
  return css.slice(start, css.indexOf('}', start));
}

test('the app color fills the screen and safe-area padding stays inside it', () => {
  const html = read('app/index.html');
  const css = read('app/css/app.css');
  const main = read('app/js/main.js');
  const manifest = JSON.parse(read('app/manifest.json'));

  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  assert.match(html, /name="theme-color" content="#f3eee6" media="\(prefers-color-scheme: light\)"/);
  assert.match(html, /name="theme-color" content="#1b1815" media="\(prefers-color-scheme: dark\)"/);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#f3eee6');
  assert.equal(manifest.theme_color, '#f3eee6');
  assert.match(css, /--bg:\s*#f3eee6/);
  assert.match(css, /--bg:\s*#1b1815/);

  assert.match(css, /html,\s*body \{[^}]*background:\s*var\(--bg\)/);
  assert.match(css, /html,\s*body \{[^}]*color-scheme:\s*light/);
  assert.match(css, /@media \(prefers-color-scheme:\s*dark\) \{\s*html,\s*body \{[^}]*background:\s*var\(--bg\)[^}]*color-scheme:\s*dark/);
  assert.equal(css.includes('#000'), false);

  assert.match(css, /--safe-top:\s*env\(safe-area-inset-top/);
  assert.match(css, /--safe-right:\s*env\(safe-area-inset-right/);
  assert.match(css, /--safe-bottom:\s*env\(safe-area-inset-bottom/);
  assert.match(css, /--safe-left:\s*env\(safe-area-inset-left/);
  assert.match(css, /--home-clearance:\s*max\(0px,\s*calc\(var\(--safe-bottom\)\s*-\s*var\(--keyboard-inset\)\)\)/);

  const frame = rule(css, '.safe-frame');
  assert.match(frame, /top:\s*0/);
  assert.match(frame, /right:\s*0/);
  assert.match(frame, /bottom:\s*var\(--keyboard-inset\)/);
  assert.match(frame, /left:\s*0/);
  assert.equal(frame.includes('--safe-'), false);

  assert.match(html, /id="app"[^>]*class="[^"]*\bsafe-frame\b/);
  assert.match(html, /id="notes-sheet"[^>]*class="[^"]*\bsafe-frame\b/);

  const top = rule(css, '.top');
  assert.match(top, /padding:\s*calc\(var\(--safe-top\) \+ 4px\)/);
  assert.match(top, /background:\s*var\(--bg\)/);
  const head = rule(css, '.sheet-head');
  assert.match(head, /padding:\s*calc\(var\(--safe-top\) \+ 6px\)/);
  assert.match(head, /background:\s*var\(--surface\)/);
  const footer = rule(css, '.build-version');
  assert.match(footer, /calc\(4px \+ var\(--home-clearance\)\)/);
  assert.match(footer, /background:\s*var\(--bg\)/);
  const list = rule(css, '.notes-list');
  assert.match(list, /calc\(12px \+ var\(--home-clearance\)\)/);
  assert.match(rule(css, '.sheet-card'), /padding-left:\s*var\(--safe-left\)/);

  assert.equal(css.includes('--vv-top'), false);
  assert.equal(css.includes('--vv-height'), false);
  assert.equal(css.includes('100vh'), false);
  assert.equal(main.includes('--vv-top'), false);
  assert.equal(main.includes('--vv-height'), false);
  assert.match(main, /--keyboard-inset/);
  assert.match(main, /window\.scrollTo\(0,\s*0\)/);
});

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
  const frame = rule(css, '.safe-frame');
  assert.match(frame, /height:\s*100%/);
  assert.equal(frame.includes('position'), false);
  assert.equal(frame.includes('--app-h'), false);
  assert.equal(css.includes('--app-h'), false);
  assert.match(css, /html \{\s*height:\s*calc\(100% - var\(--keyboard-inset\)\)/);
  assert.match(css, /body,\s*#app \{\s*height:\s*100%/);
  assert.match(css, /@media \(display-mode:\s*standalone\) \{\s*html \{\s*height:\s*calc\(100lvh - var\(--keyboard-inset\)\)/);
  const rootBox = rule(css, 'html,\nbody');
  assert.equal(rootBox.includes('overflow'), false);
  assert.equal(rootBox.includes('position'), false);

  assert.match(html, /id="app"[^>]*class="[^"]*\bsafe-frame\b/);
  assert.match(html, /id="notes-sheet"[^>]*class="sheet"/);
  assert.equal(html.includes('notes-sheet" class="sheet safe-frame"'), false);
  const sheet = rule(css, '.sheet');
  assert.match(sheet, /position:\s*absolute/);
  assert.match(sheet, /inset:\s*0/);

  const top = rule(css, '.top');
  assert.match(top, /padding:\s*calc\(var\(--safe-top\) \+ 44px\)/);
  assert.match(top, /background:\s*var\(--bg\)/);
  const head = rule(css, '.sheet-head');
  assert.match(head, /padding:\s*calc\(var\(--safe-top\) \+ 44px\)/);
  assert.match(head, /background:\s*var\(--surface\)/);
  const build = rule(css, '.build-version');
  assert.match(build, /position:\s*fixed/);
  assert.match(build, /top:\s*var\(--safe-top\)/);
  assert.equal(build.includes('bottom'), false);
  assert.match(html, /<header class="top">\s*<button type="button" id="build-version"/);
  assert.match(rule(css, '.source'), /var\(--scroll-pad\)/);
  assert.match(css, /\.preview \{\s*padding:[^}]*var\(--scroll-pad\)/);
  assert.match(rule(css, '.notes-list'), /padding:\s*0 8px var\(--scroll-pad\)/);

  assert.match(html, /id="layout-debug"[^>]*hidden/);
  assert.match(html, /id="safe-probe"/);
  assert.match(html, /id="probe-lvh"/);
  assert.match(html, /id="probe-vh"/);
  assert.match(html, /id="probe-dvh"/);
  assert.match(html, /id="probe-svh"/);
  assert.match(css, /padding:\s*var\(--safe-top\)/);
  const viewport = read('app/js/viewport.js');
  assert.match(viewport, /KEYBOARD_THRESHOLD = 80/);
  assert.match(viewport, /overlap > KEYBOARD_THRESHOLD/);
  assert.match(viewport, /scrollPad/);
  assert.equal(viewport.includes('appH'), false);
  assert.equal(viewport.includes('outerHeight'), false);
  assert.match(main, /layoutFrame/);
  assert.match(main, /--scroll-pad/);
  assert.match(main, /--keyboard-inset/);
  assert.equal(main.includes('--app-h'), false);
  assert.match(main, /orientationchange/);
  assert.match(main, /innerHeight/);
  assert.match(main, /visualViewport\.height/);
  assert.match(main, /visualViewport\.offsetTop/);
  assert.match(main, /screen\.height/);
  assert.match(main, /devicePixelRatio/);
  assert.match(main, /display-mode: standalone/);
  assert.match(main, /build-version/);
  assert.match(main, /layout-debug/);
  assert.match(main, /probe-lvh/);
  assert.match(main, /probe-vh/);
  assert.match(main, /probe-dvh/);
  assert.match(main, /probe-svh/);
  assert.match(main, /clientHeight/);
  assert.match(rule(css, '.layout-debug'), /position:\s*fixed/);

  assert.equal(css.includes('--vv-top'), false);
  assert.equal(css.includes('--vv-height'), false);
  const withoutProbes = css
    .replace(/\.probe-lvh \{[^}]*\}/, '')
    .replace(/\.probe-vh \{[^}]*\}/, '')
    .replace(/\.probe-dvh \{[^}]*\}/, '')
    .replace(/\.probe-svh \{[^}]*\}/, '');
  assert.equal(withoutProbes.includes('100vh'), false);
  assert.equal(withoutProbes.includes('100dvh'), false);
  assert.equal(withoutProbes.includes('100svh'), false);
  assert.match(withoutProbes, /100lvh/);
  assert.equal(css.includes('home-clearance'), false);
  assert.equal(main.includes('--vv-top'), false);
  assert.equal(main.includes('--vv-height'), false);
  assert.match(main, /window\.scrollTo\(0,\s*0\)/);
});

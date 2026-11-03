import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { webkit, devices } from 'playwright';
const appDir = '/workspace/app';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rel = normalize(decodeURIComponent(url.pathname));
  const path = join(appDir, rel === '/' ? 'index.html' : rel);
  try { const body = await readFile(path); res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }); res.end(body); } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await webkit.launch();
const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('pageerror', String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => (document.getElementById('save-status')?.textContent || '').includes('Saved'));
const NOTE = ['- [x] parent task', '\t- [x] nested task', '\t\t![[image-1710000000000.png]]', '\t- [x] sibling task'].join('\n');
await page.locator('#source .cm-content').fill(NOTE);
console.log(JSON.stringify(await page.evaluate(() => document.getElementById('source').value)));
await page.waitForTimeout(300);
console.log(JSON.stringify(await page.evaluate(() => document.getElementById('source').value)));
console.log(await page.evaluate(async () => {
  const { EditorView } = await import('./vendor/codemirror.js');
  const view = EditorView.findFromDOM(document.querySelector('#source .cm-editor'));
  const a = view.hasFocus;
  view.contentDOM.blur();
  const b = view.hasFocus;
  view.focus();
  const c = view.hasFocus;
  return { a, b, c, docFocus: document.hasFocus(), active: document.activeElement?.className };
}));
await browser.close(); server.close();

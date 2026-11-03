// Builds app/vendor/codemirror.js from the pinned devDependencies. Run with
// `npm run editor` after changing scripts/codemirror-entry.js or a version,
// and commit the output. The app loads only the committed file.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const PACKAGES = [
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@codemirror/commands',
  '@lezer/markdown',
  '@lezer/common',
  '@lezer/highlight',
  'style-mod',
  'w3c-keyname',
  'crelt',
];

function version(name) {
  return JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url))).version;
}

const out = new URL('../app/vendor/codemirror.js', import.meta.url);
const result = await build({
  entryPoints: [new URL('./codemirror-entry.js', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['safari15'],
  legalComments: 'none',
  write: false,
});
const banner = [
  '// CodeMirror 6 and Lezer, bundled by scripts/build-editor.mjs. MIT licensed:',
  '// https://github.com/codemirror/dev/blob/main/LICENSE, https://github.com/lezer-parser/markdown/blob/main/LICENSE',
  `// ${PACKAGES.map((name) => `${name}@${version(name)}`).join(' ')}`,
  '',
].join('\n');
const code = banner + result.outputFiles[0].text;
writeFileSync(out, code);
console.log(`app/vendor/codemirror.js ${code.length} bytes, ${gzipSync(code).length} gzipped`);

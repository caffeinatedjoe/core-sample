import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const svgUrl = new URL('../app/icons/icon.svg', import.meta.url);
const svg = readFileSync(svgUrl);
const background = '#e4d5c0';

function png(source, size) {
  const resvg = new Resvg(source, {
    fitTo: { mode: 'width', value: size },
    background,
  });
  return resvg.render().asPng();
}

const outputs = [
  ['apple-touch-icon.png', 180],
  ['apple-touch-icon-167.png', 167],
  ['apple-touch-icon-152.png', 152],
  ['apple-touch-icon-120.png', 120],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['favicon-32.png', 32],
];

for (const [name, size] of outputs) {
  writeFileSync(new URL(`../app/icons/${name}`, import.meta.url), png(svg, size));
}

// Extra margin so a circular mask keeps the core inside the safe zone.
const maskable = String(svg).replace('viewBox="0 0 512 512"', 'viewBox="-90 -90 692 692"');
writeFileSync(new URL('../app/icons/icon-512-maskable.png', import.meta.url), png(maskable, 512));
writeFileSync(new URL('../app/icons/icon-192-maskable.png', import.meta.url), png(maskable, 192));

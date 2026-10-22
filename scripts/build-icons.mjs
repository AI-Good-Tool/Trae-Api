import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Resvg } from '@resvg/resvg-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'ui/icon.svg'), 'utf8');
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } }).render().asPng();
fs.writeFileSync(path.join(root, 'ui/icon.png'), png);
const iconset = path.join(root, 'build', 'TraeSwitch.iconset');
fs.mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2]) {
    fs.writeFileSync(
      path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
      new Resvg(svg, { fitTo: { mode: 'width', value: size * scale } }).render().asPng(),
    );
  }
const icoImages = [16, 32, 48, 64, 128, 256].map((size) => ({
  size,
  png: new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng(),
}));
const header = Buffer.alloc(6 + 16 * icoImages.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoImages.length, 4);
let offset = header.length;
icoImages.forEach(({ size, png }, i) => {
  const n = 6 + 16 * i;
  header[n] = size === 256 ? 0 : size;
  header[n + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, n + 4);
  header.writeUInt16LE(32, n + 6);
  header.writeUInt32LE(png.length, n + 8);
  header.writeUInt32LE(offset, n + 12);
  offset += png.length;
});
fs.writeFileSync(
  path.join(root, 'build/icon.ico'),
  Buffer.concat([header, ...icoImages.map((x) => x.png)]),
);
if (process.platform === 'darwin')
  execFileSync('/usr/bin/iconutil', [
    '-c',
    'icns',
    iconset,
    '-o',
    path.join(root, 'build/icon.icns'),
  ]);
console.log('已生成 PNG、Windows ICO' + (process.platform === 'darwin' ? ' 与 macOS ICNS' : ''));

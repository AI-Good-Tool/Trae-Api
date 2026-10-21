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
execFileSync('/usr/bin/iconutil', [
  '-c',
  'icns',
  iconset,
  '-o',
  path.join(root, 'build/icon.icns'),
]);
console.log('已生成 1024px 应用图标、完整 iconset 和 macOS ICNS');

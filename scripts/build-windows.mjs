import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { packager } from '@electron/packager';
import { stageApp } from './stage-app.mjs';
import { powershell, systemCommandEnv } from '../server/platform.mjs';
if (process.platform !== 'win32') throw new Error('Windows 打包需在 Windows 上执行');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
execFileSync(process.execPath, [path.join(root, 'scripts/build-icons.mjs')], { stdio: 'inherit' });
const version = manifest.version,
  arch = 'x64',
  out = path.join(root, 'dist', `windows-${version}`);
const [bundleDirectory] = await packager({
  dir: stageApp(root, manifest),
  out,
  name: 'Trae Switch',
  platform: 'win32',
  arch,
  appVersion: version,
  buildVersion: version,
  electronVersion: JSON.parse(
    fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8'),
  ).version,
  icon: path.join(root, 'build/icon.ico'),
  asar: true,
  prune: false,
  overwrite: false,
  win32metadata: {
    CompanyName: 'AI-Good-Tool',
    FileDescription: 'Trae Switch',
    ProductName: 'Trae Switch',
  },
});
const prefix = `Trae-Switch-${version}-Windows-${arch}`;
const zip = path.join(out, prefix + '.zip'),
  installer = path.join(out, prefix + '-Setup.exe');
execFileSync(
  powershell(),
  [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$ErrorActionPreference='Stop';Compress-Archive -LiteralPath $env:TRAE_BUILD_SOURCE -DestinationPath $env:TRAE_BUILD_ZIP -CompressionLevel Optimal",
  ],
  {
    env: { ...systemCommandEnv(), TRAE_BUILD_SOURCE: bundleDirectory, TRAE_BUILD_ZIP: zip },
    stdio: 'inherit',
  },
);
const nsis =
  process.env.NSIS_PATH ||
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'NSIS', 'makensis.exe');
if (!fs.existsSync(nsis)) throw new Error('缺少 NSIS；请安装 NSIS 或设置 NSIS_PATH');
execFileSync(
  nsis,
  [
    `/DSOURCE_DIR=${bundleDirectory}`,
    `/DOUT_FILE=${installer}`,
    `/DICON_FILE=${path.join(root, 'build/icon.ico')}`,
    `/DAPP_VERSION=${version}`,
    path.join(root, 'scripts/installer.nsi'),
  ],
  { stdio: 'inherit' },
);
for (const file of [zip, installer]) {
  const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(file + '.sha256', `${sum}  ${path.basename(file)}\n`);
}
console.log(
  `EXE: ${path.join(bundleDirectory, 'Trae Switch.exe')}\nZIP: ${zip}\nINSTALLER: ${installer}`,
);

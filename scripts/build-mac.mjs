import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { packager } from '@electron/packager';
import { stageApp } from './stage-app.mjs';

if (process.platform !== 'darwin') throw new Error('macOS 打包需在 macOS 上执行');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = manifest.version,
  arch = process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('不支持的 macOS 架构');
execFileSync(process.execPath, [path.join(root, 'scripts/build-icons.mjs')], { stdio: 'inherit' });
const staging = stageApp(root, manifest);
const out = path.join(root, 'dist', `mac-${version}`);
const [bundleDirectory] = await packager({
  dir: staging,
  out,
  name: 'Trae Switch',
  platform: 'darwin',
  arch,
  appBundleId: 'io.traeswitch.desktop',
  appVersion: version,
  buildVersion: version,
  electronVersion: JSON.parse(
    fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8'),
  ).version,
  icon: path.join(root, 'build/icon.icns'),
  asar: true,
  prune: false,
  overwrite: false,
  osxSign: {
    identity: '-',
    identityValidation: false,
    timestamp: 'none',
    preEmbedProvisioningProfile: false,
    hardenedRuntime: false,
    preAutoEntitlements: false,
    continueOnError: false,
  },
});
const app = path.join(bundleDirectory, 'Trae Switch.app');
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], {
  stdio: 'inherit',
});
const imageStaging = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-switch-dmg-'));
fs.cpSync(app, path.join(imageStaging, 'Trae Switch.app'), {
  recursive: true,
  verbatimSymlinks: true,
});
execFileSync(
  '/usr/bin/codesign',
  ['--verify', '--deep', '--strict', path.join(imageStaging, 'Trae Switch.app')],
  { stdio: 'inherit' },
);
fs.symlinkSync('/Applications', path.join(imageStaging, 'Applications'));
const dmg = path.join(out, `Trae-Switch-${version}-macOS-${arch}.dmg`);
if (fs.existsSync(dmg)) throw new Error('安装包已存在，请先保留旧包并指定新版本号');
execFileSync(
  '/usr/bin/hdiutil',
  [
    'create',
    '-volname',
    `Trae Switch ${version}`,
    '-srcfolder',
    imageStaging,
    '-ov',
    '-format',
    'UDZO',
    dmg,
  ],
  { stdio: 'inherit' },
);
execFileSync('/usr/bin/hdiutil', ['verify', dmg], { stdio: 'inherit' });
const sum = crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex');
fs.writeFileSync(dmg + '.sha256', `${sum}  ${path.basename(dmg)}\n`);
console.log(`APP: ${app}\nDMG: ${dmg}\nSHA256: ${sum}`);

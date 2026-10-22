import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemCommandEnv } from '../server/platform.mjs';
import { Store } from '../server/store.mjs';
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const base = path.resolve(
  'dist',
  process.platform === 'win32' ? `windows-${manifest.version}` : `mac-${manifest.version}`,
);
const executable =
  process.env.TRAE_SWITCH_SMOKE_EXECUTABLE ||
  (process.platform === 'win32'
    ? path.join(base, 'Trae Switch-win32-x64', 'Trae Switch.exe')
    : path.join(
        base,
        `Trae Switch-darwin-${process.arch}`,
        'Trae Switch.app/Contents/MacOS/Trae Switch',
      ));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-desktop-smoke-'));
const legacyStore = new Store(path.join(dir, 'vault'));
legacyStore.data.settings.gatewayCloudMode = false;
legacyStore.save();
const { stdout, stderr } = await promisify(execFile)(executable, [], {
  env: {
    ...systemCommandEnv(),
    TRAE_SWITCH_SMOKE_TEST: '1',
    TRAE_SWITCH_DATA: path.join(dir, 'vault'),
    TRAE_SWITCH_SMOKE_PROFILE: path.join(dir, 'profile'),
  },
  timeout: 45000,
  windowsHide: true,
});
if (!stdout.includes('TRAE_DESKTOP_SMOKE_OK'))
  throw new Error('桌面冒烟测试未完成：' + stderr.slice(-1000));
console.log(stdout.trim());

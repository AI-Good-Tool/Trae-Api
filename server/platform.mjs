import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const clientNames = { cn: 'Trae CN', intl: 'Trae' };
export function systemCommandEnv(env = process.env) {
  const clean = { ...env };
  delete clean.DYLD_INSERT_LIBRARIES;
  return clean;
}
export function clientDataDir(
  variant,
  { platform = process.platform, home = os.homedir(), env = process.env } = {},
) {
  const name = clientNames[variant];
  if (!name) throw new Error('未知客户端版本');
  if (platform === 'win32')
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), name);
  if (platform === 'darwin') return path.posix.join(home, 'Library/Application Support', name);
  throw new Error('目前仅支持 Windows 与 macOS');
}
export function clientCandidates(
  variant,
  { platform = process.platform, home = os.homedir(), env = process.env } = {},
) {
  const name = clientNames[variant];
  if (!name) throw new Error('未知客户端版本');
  const override = env[variant === 'cn' ? 'TRAE_CN_PATH' : 'TRAE_INTL_PATH'];
  if (platform === 'darwin')
    return [
      ...new Set(
        [
          override,
          `/Applications/${name}.app`,
          path.posix.join(home, 'Applications', name + '.app'),
        ].filter(Boolean),
      ),
    ].map((app) => ({
      app,
      root: path.posix.join(app, 'Contents/Resources/app'),
      executable: path.posix.join(app, 'Contents/MacOS', name),
      platform,
    }));
  if (platform !== 'win32') throw new Error('目前仅支持 Windows 与 macOS');
  const w = path.win32;
  const dirs = [
    override && (/\.exe$/i.test(override) ? w.dirname(override) : override),
    w.join(env.LOCALAPPDATA || w.join(home, 'AppData', 'Local'), 'Programs', name),
    env.ProgramFiles && w.join(env.ProgramFiles, name),
    env['ProgramFiles(x86)'] && w.join(env['ProgramFiles(x86)'], name),
  ].filter(Boolean);
  return [...new Set(dirs)].flatMap((app) =>
    [app, w.join(app, 'current')].map((folder) => ({
      app: folder,
      root: w.join(folder, 'resources', 'app'),
      executable:
        override && /\.exe$/i.test(override) && w.dirname(override) === folder
          ? override
          : w.join(folder, name + '.exe'),
      platform,
    })),
  );
}
export function discoverClient(variant, options = {}) {
  const read = options.readFile || ((file) => fs.readFileSync(file, 'utf8')),
    exists = options.exists || fs.existsSync;
  for (const candidate of clientCandidates(variant, options)) {
    const join = candidate.platform === 'win32' ? path.win32.join : path.posix.join;
    try {
      const product = JSON.parse(read(join(candidate.root, 'product.json')));
      const source = read(join(candidate.root, 'out', 'main.js'));
      const isCn = /\bcn\b/i.test(product.nameShort || '');
      if ((variant === 'cn') !== isCn) continue;
      const executable =
        candidate.platform === 'win32'
          ? [
              candidate.executable,
              join(candidate.app, (product.nameShort || clientNames[variant]) + '.exe'),
              join(candidate.app, (product.applicationName || 'trae') + '.exe'),
            ].find(exists)
          : candidate.executable;
      if (!executable) continue;
      return { ...candidate, executable, product, source, dir: clientDataDir(variant, options) };
    } catch {}
  }
  throw new Error(
    `未找到 ${clientNames[variant]}，请安装客户端或配置 ${variant === 'cn' ? 'TRAE_CN_PATH' : 'TRAE_INTL_PATH'}`,
  );
}
export function windowsTool(name, env = process.env) {
  return path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', name);
}
export function powershell(env = process.env) {
  return windowsTool('WindowsPowerShell\\v1.0\\powershell.exe', env);
}
export async function openExternal(target, { platform = process.platform } = {}) {
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 HTTP / HTTPS 链接');
  const env = systemCommandEnv();
  if (platform === 'darwin') await exec('/usr/bin/open', [url.href], { env, timeout: 10000 });
  else if (platform === 'win32')
    await exec(windowsTool('rundll32.exe'), ['url.dll,FileProtocolHandler', url.href], {
      env,
      windowsHide: true,
      timeout: 10000,
    });
  else throw new Error('目前仅支持 Windows 与 macOS');
}
export async function launchClient(p) {
  const env = systemCommandEnv();
  if (p.platform === 'darwin') await exec('/usr/bin/open', ['-a', p.app], { env, timeout: 10000 });
  else if (p.platform === 'win32')
    await new Promise((resolve, reject) => {
      const child = spawn(p.executable, [], {
        cwd: path.win32.dirname(p.executable),
        env,
        detached: true,
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  else throw new Error('目前仅支持 Windows 与 macOS');
}

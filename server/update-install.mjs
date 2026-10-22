import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { systemCommandEnv, powershell } from './platform.mjs';
const exec = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function bundlePath(executable) {
  const bundle = path.dirname(path.dirname(path.dirname(executable)));
  if (
    !bundle.endsWith('.app') ||
    path.basename(path.dirname(executable)) !== 'MacOS' ||
    path.basename(path.dirname(path.dirname(executable))) !== 'Contents' ||
    bundle.startsWith('/Volumes/') ||
    bundle.includes('/AppTranslocation/')
  )
    throw Error('请先将应用安装到可写的 Applications 目录，再使用应用内更新');
  return bundle;
}
async function run(command, args) {
  return exec(command, args, {
    env: systemCommandEnv(),
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}
async function plist(app, key) {
  return (
    await run('/usr/libexec/PlistBuddy', [
      '-c',
      'Print :' + key,
      path.join(app, 'Contents/Info.plist'),
    ])
  ).stdout.trim();
}
async function validateBundle(app, version, arch) {
  if (
    !fs.lstatSync(app).isDirectory() ||
    !fs
      .realpathSync(path.join(app, 'Contents/MacOS/Trae Switch'))
      .startsWith(fs.realpathSync(app) + path.sep)
  )
    throw Error('更新应用包含无效的可执行文件路径');
  if (
    (await plist(app, 'CFBundleIdentifier')) !== 'io.traeswitch.desktop' ||
    (await plist(app, 'CFBundleShortVersionString')) !== version ||
    (await plist(app, 'CFBundleExecutable')) !== 'Trae Switch'
  )
    throw Error('更新应用的标识或版本不匹配');
  await run('/usr/bin/lipo', [
    '-verify_arch',
    arch === 'arm64' ? 'arm64' : 'x86_64',
    path.join(app, 'Contents/MacOS/Trae Switch'),
  ]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}
async function launchHelper(command, args, work, extraEnv = {}) {
  const child = spawn(command, args, {
    env: { ...systemCommandEnv(), ...extraEnv },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  let failed;
  child.once('error', (e) => {
    failed = e;
  });
  child.once('exit', (code) => {
    if (code !== null) failed = Error('更新助手提前退出');
  });
  for (let i = 0; i < 100; i++) {
    if (failed) throw Error('无法启动更新助手，当前应用保持运行');
    if (fs.existsSync(path.join(work, 'ready'))) {
      child.unref();
      return child.pid;
    }
    await pause(50);
  }
  child.kill();
  throw Error('更新助手未就绪，请重试');
}
export async function prepareUpdate(
  { file, digest, info },
  {
    platform = process.platform,
    arch = process.arch,
    executable = process.execPath,
    directory,
    packaged = false,
  } = {},
) {
  if (!packaged) throw Error('应用内安装更新需要使用已打包的桌面应用');
  const exe = fs.realpathSync(executable);
  let work, helperPid;
  if (platform === 'darwin') {
    const target = bundlePath(exe);
    work = fs.mkdtempSync(path.join(path.dirname(target), '.trae-switch-update-'));
    const mount = fs.mkdtempSync(path.join(directory, 'mount-'));
    let mounted = false;
    try {
      await run('/usr/bin/hdiutil', [
        'attach',
        '-readonly',
        '-nobrowse',
        '-quiet',
        '-mountpoint',
        mount,
        file,
      ]);
      mounted = true;
      const source = path.join(mount, 'Trae Switch.app');
      await validateBundle(source, info.version, arch);
      await run('/usr/bin/ditto', [source, path.join(work, 'new.app')]);
      await validateBundle(path.join(work, 'new.app'), info.version, arch);
    } finally {
      if (mounted) await run('/usr/bin/hdiutil', ['detach', mount]);
    }
    fs.writeFileSync(
      path.join(work, 'plan.json'),
      JSON.stringify({ target, version: info.version }),
      { mode: 0o600 },
    );
    const helper = path.join(work, 'install.sh');
    fs.writeFileSync(helper, fs.readFileSync(new URL('./update-mac.sh', import.meta.url)), {
      mode: 0o700,
    });
    helperPid = await launchHelper('/bin/sh', [helper, String(process.pid), target, work], work);
  } else if (platform === 'win32') {
    const target = path.dirname(exe);
    if (
      path
        .resolve(directory)
        .toLowerCase()
        .startsWith(target.toLowerCase() + path.sep)
    )
      throw Error('当前安装目录不适合原位更新，请将应用移到独立目录');
    if (
      path.basename(exe) !== 'Trae Switch.exe' ||
      !fs.existsSync(path.join(target, 'resources', 'app.asar'))
    )
      throw Error('无法确定当前应用安装目录');
    work = fs.mkdtempSync(path.join(directory, 'install-'));
    fs.writeFileSync(
      path.join(work, 'plan.json'),
      JSON.stringify({ target, version: info.version, pid: process.pid, file, digest }),
      { mode: 0o600 },
    );
    const helper = path.join(work, 'install.ps1');
    fs.writeFileSync(helper, fs.readFileSync(new URL('./update-windows.ps1', import.meta.url)));
    helperPid = await launchHelper(
      powershell(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', fs.readFileSync(helper, 'utf8')],
      work,
      { TRAE_UPDATE_WORK: work },
    );
  } else throw Error('当前平台不支持应用内安装');
  return { work, helperPid };
}
export function confirmUpdateBoot(args, executable, version, directory) {
  const index = args.indexOf('--trae-update-stage');
  if (index < 0) return;
  const work = fs.realpathSync(args[index + 1]);
  const exe = fs.realpathSync(executable);
  const parent =
    process.platform === 'darwin' ? path.dirname(bundlePath(exe)) : fs.realpathSync(directory);
  const prefix = process.platform === 'darwin' ? '.trae-switch-update-' : 'install-';
  if (path.dirname(work) !== parent || !path.basename(work).startsWith(prefix))
    throw Error('更新启动确认路径无效');
  const plan = JSON.parse(fs.readFileSync(path.join(work, 'plan.json'), 'utf8'));
  const target = process.platform === 'darwin' ? bundlePath(exe) : path.dirname(exe);
  if (plan.target !== target || plan.version !== version) throw Error('更新启动版本或位置不匹配');
  fs.writeFileSync(path.join(work, 'launch-confirmed'), 'ok', { mode: 0o600 });
}

export function previousUpdateFailure(executable, directory, platform = process.platform) {
  try {
    const exe = fs.realpathSync(executable);
    const target = platform === 'darwin' ? bundlePath(exe) : path.dirname(exe);
    const root = platform === 'darwin' ? path.dirname(target) : directory;
    const prefix = platform === 'darwin' ? '.trae-switch-update-' : 'install-';
    const folders = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => path.join(root, e.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const work of folders.slice(0, 20)) {
      const planFile = path.join(work, 'plan.json');
      if (!fs.existsSync(planFile) || fs.statSync(planFile).size > 8192) continue;
      const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      if (plan.target !== target) continue;
      return fs.existsSync(path.join(work, 'error.txt'))
        ? '上次更新未完成，旧版备份和日志保留在：' + work
        : null;
    }
  } catch {}
  return null;
}

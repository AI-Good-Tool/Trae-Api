import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { systemCommandEnv, powershell, windowsTool } from './platform.mjs';
export { systemCommandEnv } from './platform.mjs';
const exec = promisify(execFile);
async function processList(platform = process.platform) {
  try {
    if (platform === 'win32') {
      const script =
        "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);@(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress";
      const { stdout } = await exec(
        powershell(),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          env: systemCommandEnv(),
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      return stdout;
    }
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      env: systemCommandEnv(),
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    throw new Error('无法确认客户端进程状态，未修改登录态');
  }
}
export function clientProcesses(output, app, { platform = 'darwin', executable } = {}) {
  if (platform === 'win32') {
    const raw = JSON.parse(
      String(output)
        .replace(/^\uFEFF/, '')
        .trim() || '[]',
    );
    const rows = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
    const root = path.win32.resolve(app).toLowerCase();
    const target = path.win32.resolve(executable || path.win32.join(app, 'Trae.exe')).toLowerCase();
    const names = new Set([path.win32.basename(target), 'trae.exe', 'trae cn.exe']);
    return rows.flatMap((row) => {
      if (!row.ExecutablePath) {
        if (names.has(String(row.Name || '').toLowerCase()))
          throw new Error('无法确认客户端可执行文件路径，未修改登录态');
        return [];
      }
      const exe = path.win32.resolve(row.ExecutablePath).toLowerCase();
      const pid = Number(row.ProcessId);
      if (!Number.isSafeInteger(pid) || pid <= 1 || !exe.startsWith(root + '\\')) return [];
      return [{ pid, command: exe, main: exe === target }];
    });
  }
  const prefix = app + '/Contents/';
  return String(output)
    .split('\n')
    .flatMap((line) => {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m || Number(m[1]) <= 1 || !m[2].startsWith(prefix)) return [];
      return [{ pid: Number(m[1]), command: m[2], main: m[2].startsWith(prefix + 'MacOS/') }];
    });
}
async function signalClient(pid, sig, platform) {
  if (platform !== 'win32') return process.kill(pid, sig);
  const env = { ...systemCommandEnv(), TRAE_SWITCH_TARGET_PID: String(pid) };
  if (sig === 'SIGTERM')
    await exec(
      powershell(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop';$clientProcessId=[int]$env:TRAE_SWITCH_TARGET_PID;$clientProcess=Get-Process -Id $clientProcessId -ErrorAction SilentlyContinue;if($clientProcess){[void]$clientProcess.CloseMainWindow()}",
      ],
      { env, windowsHide: true, timeout: 10000 },
    );
  else
    await exec(windowsTool('taskkill.exe'), ['/PID', String(pid), '/F'], {
      env,
      windowsHide: true,
      timeout: 10000,
    });
}
export async function stopClient(
  p,
  {
    list = () => processList(p.platform || process.platform),
    signal = (pid, sig) => signalClient(pid, sig, p.platform || process.platform),
    pause = sleep,
    now = Date.now,
    graceMs = 4000,
    killMs = 2500,
  } = {},
) {
  const scan = async () =>
    clientProcesses(await list(), p.app, {
      platform: p.platform || 'darwin',
      executable: p.executable,
    });
  let current = await scan();
  if (!current.length) return { wasRunning: false, forced: false };
  const send = async (rows, sig) => {
    for (const row of rows) {
      // Recheck ownership before signalling a PID which may have exited meanwhile.
      const fresh = await scan();
      if (!fresh.some((x) => x.pid === row.pid && x.command === row.command)) continue;
      try {
        await signal(row.pid, sig);
      } catch (e) {
        if (e.code !== 'ESRCH' && (await scan()).some((x) => x.pid === row.pid))
          throw new Error(`无法结束 ${p.name}，未修改登录态`);
      }
    }
  };
  const wait = async (ms) => {
    const end = now() + ms;
    while ((current = await scan()).length) {
      if (now() >= end) return false;
      await pause(Math.min(100, end - now()));
    }
    return true;
  };
  const mains = current.filter((x) => x.main);
  await send(mains.length ? mains : current, 'SIGTERM');
  if (await wait(graceMs)) return { wasRunning: true, forced: false };
  await send(current, 'SIGKILL');
  if (!(await wait(killMs))) throw new Error(`${p.name} 仍未完全退出，未修改登录态，请稍后重试`);
  return { wasRunning: true, forced: true };
}

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appInfo } from '../server/app-info.mjs';
import { openExternal } from '../server/platform.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const r = await fetch('http://127.0.0.1:19827', { signal: AbortSignal.timeout(1000) });
  if (r.headers.get('x-trae-switch') !== appInfo.version)
    throw new Error('端口被其他应用或旧版本占用');
} catch (e) {
  if (e.message === '端口被其他应用或旧版本占用') throw e;
  const child = spawn(process.execPath, [path.join(root, 'server/index.mjs')], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    try {
      await fetch('http://127.0.0.1:19827');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
await openExternal('http://127.0.0.1:19827');

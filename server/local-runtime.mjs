import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { profile, encode, AUTH_KEY } from './client.mjs';
import { systemCommandEnv } from './platform.mjs';
import { localBridge } from './local-bridge.mjs';

export function serializeLocalCreates(invoke) {
  let pending = Promise.resolve();
  return (operation, value) => {
    if (operation !== 'request' || value?.params?.method !== 'create_chat_session')
      return invoke(operation, value);
    // The native local-project/session setup uses SQLite write transactions.
    // Serialize creation only; inference and event polling remain concurrent.
    const result = pending.then(() => invoke(operation, value));
    pending = result.catch(() => {});
    return result;
  };
}

export class DebugPipe {
  constructor(child) {
    this.child = child;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', (chunk) => {
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) return this.close();
      let end;
      while ((end = this.buffer.indexOf('\0')) !== -1) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          continue;
        }
        this.pending.get(message.id)?.(message);
      }
    });
    child.stdio[3].on('error', () => this.close());
    child.stdio[4].on('error', () => this.close());
    child.once('error', () => this.close());
    child.once('exit', () => this.close());
  }

  call(method, params = {}, sessionId, timeout = 25000) {
    if (this.closed) return Promise.reject(new Error('local_runtime_closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('local_runtime_timeout'));
      }, timeout);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (message.error) {
          const error = new Error('local_debugger_error');
          error.debugMethod = method;
          error.debugCode = message.error.code;
          reject(error);
        } else resolve(message.result);
      });
      this.child.stdio[3].write(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
      );
    });
  }

  close() {
    this.closed = true;
    for (const complete of this.pending.values()) complete({ error: true });
    this.pending.clear();
  }
}

export class LocalRuntimes {
  constructor(dir) {
    this.dir = dir;
    this.entries = new Map();
  }

  async acquire(account) {
    const key = account.variant + ':' + account.user.userId;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { users: 0 };
      this.entries.set(key, entry);
      entry.ready = this.launch(account).catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    }
    clearTimeout(entry.timer);
    entry.users++;
    try {
      const runtime = await entry.ready;
      if (!runtime.isAlive()) {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw new Error('local_runtime_closed');
      }
      return {
        ...runtime,
        release: () => {
          entry.users--;
          if (!entry.users)
            entry.timer = setTimeout(
              () => {
                this.entries.delete(key);
                void runtime.close();
              },
              5 * 60 * 1000,
            ).unref();
        },
      };
    } catch (error) {
      entry.users--;
      throw error;
    }
  }

  async launch(account) {
    let p;
    try {
      p = profile(account.variant);
    } catch {
      throw new Error('local_client_missing');
    }
    const key = crypto
      .createHash('sha256')
      .update(account.variant + ':' + account.user.userId)
      .digest('hex')
      .slice(0, 24);
    const dir = path.join(this.dir, 'local-runtime', account.variant, key);
    const workspace = path.join(dir, 'workspace');
    fs.mkdirSync(path.join(dir, 'User/globalStorage'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    let storage = {};
    try {
      storage = JSON.parse(fs.readFileSync(p.storage, 'utf8'));
    } catch {}
    for (const key of Object.keys(storage))
      if (key.startsWith('iCubeAuthInfo://')) delete storage[key];
    storage[AUTH_KEY] = encode(account.user, p);
    if (account.cached)
      storage['iCubeServerData://icube.cloudide'] = JSON.stringify(account.cached);
    if (account.machineId) storage['telemetry.machineId'] = account.machineId;
    if (account.deviceId && account.deviceKeys)
      storage['iCubeAuthInfo://icube-dc:' + account.deviceId] = encode(account.deviceKeys, p);
    fs.writeFileSync(path.join(dir, 'User/globalStorage/storage.json'), JSON.stringify(storage), {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(dir, 'User/settings.json'),
      JSON.stringify({
        'window.restoreWindows': 'none',
        'update.mode': 'none',
        'extensions.autoUpdate': false,
      }),
      { mode: 0o600 },
    );
    const executable = fs.existsSync(p.executable)
      ? p.executable
      : process.platform === 'darwin'
        ? path.join(p.app, 'Contents/MacOS/Electron')
        : p.executable;
    const child = spawn(
      executable,
      [
        '--user-data-dir=' + dir,
        '--extensions-dir=' + path.join(dir, 'extensions'),
        '--remote-debugging-pipe',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-extensions',
        '--new-window',
        workspace,
      ],
      {
        env: systemCommandEnv(),
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const pipe = new DebugPipe(child);
    const close = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            child.off('exit', finish);
            resolve();
          };
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish();
          }, 3000);
          child.once('exit', finish);
          child.kill();
        });
      }
      pipe.close();
    };
    try {
      const deadline = Date.now() + 40000;
      let attached;
      while (Date.now() < deadline) {
        const { targetInfos = [] } = await pipe.call('Target.getTargets', {}, undefined, 5000);
        const target = targetInfos.find(
          (t) => t.type === 'page' && t.url.includes('/workbench/workbench.html'),
        );
        if (!target) {
          await delay(300);
          continue;
        }
        if (attached?.targetId !== target.targetId)
          attached = {
            targetId: target.targetId,
            ...(await pipe.call('Target.attachToTarget', {
              targetId: target.targetId,
              flatten: true,
            })),
          };
        const { sessionId } = attached;
        const evaluate = async (expression) => {
          const r = await pipe.call(
            'Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true },
            sessionId,
          );
          if (r.exceptionDetails) throw new Error('local_bridge_error');
          return r.result?.value;
        };
        // Trae can reload its first renderer while bootstrapping login and the
        // local project. Do not start inference in that disposable context.
        let ready = false;
        try {
          ready = await evaluate(`(() => {
            if (!globalThis.vscode?.ahaIpc || document.readyState !== 'complete') return false;
            globalThis.__traeSwitchReadySince ??= performance.now();
            return performance.now() - globalThis.__traeSwitchReadySince >= 10000;
          })()`);
        } catch (error) {
          if (pipe.closed) throw error;
        }
        if (!ready) {
          await delay(300);
          continue;
        }
        return {
          workspace,
          close,
          isAlive: () => !pipe.closed,
          invoke: serializeLocalCreates((operation, value) =>
            evaluate(
              `(${localBridge.toString()})(${JSON.stringify(operation)},${JSON.stringify(value)})`,
            ),
          ),
        };
      }
      throw new Error('local_runtime_timeout');
    } catch (error) {
      await close();
      throw error;
    }
  }

  async close() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        clearTimeout(entry.timer);
        const runtime = await entry.ready;
        await runtime.close();
      }),
    );
  }
}

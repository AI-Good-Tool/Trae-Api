import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { stopClient, clientProcesses, systemCommandEnv } from '../server/client-process.mjs';
import { switchAccount, readAuthSalt, encode, decode, AUTH_KEY } from '../server/client.mjs';
const p = { name: 'Trae', app: '/Applications/Trae.app' };
const listing = (rows) => rows.map(([pid, cmd]) => `${pid} ${cmd}`).join('\n');
const target = '/Applications/Trae.app/Contents/MacOS/Trae';
const helper =
  '/Applications/Trae.app/Contents/Frameworks/Trae Helper.app/Contents/MacOS/Trae Helper';
const cn = '/Applications/Trae CN.app/Contents/MacOS/Trae CN';
function controller(rows, handler = () => {}) {
  let tick = 0;
  const signals = [];
  return {
    signals,
    get rows() {
      return rows;
    },
    options: {
      list: async () => listing(rows),
      signal: async (pid, sig) => {
        signals.push([pid, sig]);
        rows = handler(rows, pid, sig);
      },
      pause: async (ms) => {
        tick += ms;
      },
      now: () => tick,
      graceMs: 200,
      killMs: 200,
    },
  };
}
test('只识别对应应用目录的主进程与 Helper，正常退出不强杀', async () => {
  const c = controller(
    [
      [10, target],
      [11, helper],
      [12, cn],
      [13, '/bin/zsh -c ' + target],
    ],
    (rows, pid) => rows.filter((x) => x[0] !== pid && x[0] !== 11),
  );
  assert.deepEqual(
    clientProcesses(listing(c.rows), p.app).map((x) => x.pid),
    [10, 11],
  );
  assert.deepEqual(await stopClient(p, c.options), { wasRunning: true, forced: false });
  assert.deepEqual(c.signals, [[10, 'SIGTERM']]);
  assert(c.rows.some((x) => x[0] === 12));
});
test('未退出时强杀该版本及其 Helper，确认停止后返回；停止失败不假报成功', async () => {
  const c = controller(
    [
      [10, target],
      [11, helper],
      [12, cn],
    ],
    (rows, pid, sig) => (sig === 'SIGKILL' ? rows.filter((x) => x[0] !== pid) : rows),
  );
  assert.deepEqual(await stopClient(p, c.options), { wasRunning: true, forced: true });
  assert.deepEqual(c.signals, [
    [10, 'SIGTERM'],
    [10, 'SIGKILL'],
    [11, 'SIGKILL'],
  ]);
  assert.equal(c.rows[0][0], 12);
  const stuck = controller([[10, target]], (rows) => rows);
  await assert.rejects(stopClient(p, stuck.options), /仍未完全退出/);
  const failed = controller([[10, target]]);
  failed.options.signal = async () => {
    throw Object.assign(Error(), { code: 'EPERM' });
  };
  await assert.rejects(stopClient(p, failed.options), /未修改登录态/);
  const empty = controller([], (rows) => rows);
  assert.equal((await stopClient(p, empty.options)).wasRunning, false);
  assert.equal(empty.signals.length, 0);
});
test('退出后重读最新登录文件，再备份、切换和启动；停止失败不写文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-switch-flow-'));
  const profile = { ...p, storage: path.join(dir, 'storage.json'), salt: crypto.randomBytes(64) };
  const old = { userId: 'old', token: 'old' },
    user = { userId: 'selected', token: 'new' };
  fs.writeFileSync(
    profile.storage,
    JSON.stringify({ [AUTH_KEY]: encode(old, profile), setting: 'initial' }),
  );
  const sequence = [];
  const backups = path.join(dir, 'backups');
  const r = await switchAccount({ variant: 'intl', user }, backups, {
    getProfile: () => profile,
    stop: async () => {
      sequence.push('stop');
      fs.writeFileSync(
        profile.storage,
        JSON.stringify({ [AUTH_KEY]: encode(old, profile), setting: 'flushed on quit' }),
      );
      return { wasRunning: true, forced: true };
    },
    start: async (variant) => {
      sequence.push('start');
      assert.equal(variant, 'intl');
      assert.deepEqual(
        decode(JSON.parse(fs.readFileSync(profile.storage))[AUTH_KEY], profile),
        user,
      );
    },
  });
  assert.deepEqual(sequence, ['stop', 'start']);
  assert.equal(r.forced, true);
  assert.equal(JSON.parse(fs.readFileSync(r.backup)).setting, 'flushed on quit');
  if (process.platform !== 'win32') assert.equal(fs.statSync(r.backup).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(profile.storage)).setting, 'flushed on quit');
  const before = fs.readFileSync(profile.storage);
  let started = false;
  await assert.rejects(
    switchAccount({ variant: 'intl', user }, backups, {
      getProfile: () => profile,
      stop: async () => {
        throw Error('stop failed');
      },
      start: () => {
        started = true;
      },
    }),
  );
  assert.deepEqual(fs.readFileSync(profile.storage), before);
  assert.equal(started, false);
  assert.equal(fs.readdirSync(backups).length, 1);
  let stopped = false;
  await assert.rejects(
    switchAccount({ variant: 'intl', user }, backups, {
      getProfile: () => ({
        ...profile,
        get salt() {
          throw Error('unsupported');
        },
      }),
      stop: () => {
        stopped = true;
      },
    }),
  );
  assert.equal(stopped, false);
});
test('加密参数按 AES 分支识别，兼容变量重命名且不执行客户端代码', () => {
  const a = Array(64).fill(2),
    b = Array(64).fill(7);
  const source = `else if(e===Mode.AES)for(let i=0;i<n;i++)out[i]=$saltA[i]^$saltB[i];$saltA=Uint8Array.from(${JSON.stringify(a)}),$saltB=new Uint8Array(${JSON.stringify(b)});throw new Error('never execute')`;
  assert.deepEqual(readAuthSalt(source), Buffer.alloc(64, 5));
  assert.throws(() => readAuthSalt('unknown'));
  const env = { PATH: '/bin', DYLD_INSERT_LIBRARIES: 'injected' };
  assert.deepEqual(systemCommandEnv(env), { PATH: '/bin' });
  assert.equal(env.DYLD_INSERT_LIBRARIES, 'injected');
});

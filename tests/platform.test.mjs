import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { clientDataDir, clientCandidates, discoverClient } from '../server/platform.mjs';
import { clientProcesses, stopClient } from '../server/client-process.mjs';
import { maskPhone } from '../server/client.mjs';
const options = {
  platform: 'win32',
  home: 'C:\\Users\\测试',
  env: {
    APPDATA: 'D:\\资料',
    LOCALAPPDATA: 'C:\\Users\\测试\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
  },
};
test('Windows 识别自定义用户数据、安装路径和对应版本，不混用客户端', () => {
  assert.equal(clientDataDir('cn', options), 'D:\\资料\\Trae CN');
  assert.equal(
    clientDataDir('intl', { platform: 'darwin', home: '/Users/test' }),
    '/Users/test/Library/Application Support/Trae',
  );
  const candidates = clientCandidates('cn', options);
  const target = candidates.find((c) => c.app === 'C:\\Program Files\\Trae CN');
  const files = new Map([
    [
      path.win32.join(target.root, 'product.json'),
      JSON.stringify({ nameShort: 'Trae CN', applicationName: 'trae' }),
    ],
    [path.win32.join(target.root, 'out/main.js'), 'encrypted source'],
  ]);
  const discoverOptions = {
    ...options,
    readFile: (f) => {
      if (!files.has(f)) throw Error('missing');
      return files.get(f);
    },
    exists: (f) => f === 'C:\\Program Files\\Trae CN\\trae.exe',
  };
  assert.equal(
    discoverClient('cn', discoverOptions).executable,
    'C:\\Program Files\\Trae CN\\trae.exe',
  );
  files.set(path.win32.join(target.root, 'product.json'), JSON.stringify({ nameShort: 'Trae' }));
  assert.throws(() => discoverClient('cn', discoverOptions), /未找到/);
  const overridden = clientCandidates('intl', {
    ...options,
    env: { ...options.env, TRAE_INTL_PATH: 'E:\\Custom\\Client.exe' },
  });
  assert.equal(overridden[0].executable, 'E:\\Custom\\Client.exe');
  assert.notEqual(overridden[2].executable, 'E:\\Custom\\Client.exe');
});
test('Windows 仅结束目标目录进程，大小写兼容且拒绝无权限识别的客户端', async () => {
  const app = 'C:\\Apps\\Trae';
  let rows = [
    { ProcessId: 10, Name: 'Trae.exe', ExecutablePath: 'c:\\APPS\\TRAE\\Trae.exe' },
    { ProcessId: 11, ExecutablePath: 'C:\\Apps\\Trae\\resources\\helper.exe' },
    { ProcessId: 12, ExecutablePath: 'C:\\Apps\\Trae CN\\Trae CN.exe' },
    { ProcessId: 13, ExecutablePath: 'C:\\Apps\\Trae-backup\\Trae.exe' },
  ];
  const config = { platform: 'win32', executable: app + '\\Trae.exe' };
  assert.deepEqual(
    clientProcesses('\uFEFF' + JSON.stringify(rows), app, config).map((p) => p.pid),
    [10, 11],
  );
  assert.equal(clientProcesses(JSON.stringify(rows[0]), app, config)[0].main, true);
  assert.deepEqual(clientProcesses('null', app, config), []);
  assert.throws(
    () => clientProcesses('[{"ProcessId":20,"Name":"Trae.exe"}]', app, config),
    /无法确认/,
  );
  let tick = 0;
  const signals = [];
  assert.deepEqual(
    await stopClient(
      { ...config, app, name: 'Trae' },
      {
        list: async () => JSON.stringify(rows),
        signal: async (pid, sig) => {
          signals.push([pid, sig]);
          if (sig === 'SIGKILL') rows = rows.filter((r) => r.ProcessId !== pid);
        },
        now: () => tick,
        pause: async (ms) => {
          tick += ms;
        },
        graceMs: 100,
        killMs: 100,
      },
    ),
    { wasRunning: true, forced: true },
  );
  assert.deepEqual(signals, [
    [10, 'SIGTERM'],
    [10, 'SIGKILL'],
    [11, 'SIGKILL'],
  ]);
  assert.deepEqual(
    rows.map((r) => r.ProcessId),
    [12, 13],
  );
});
test('账号手机只提供脱敏值', () => {
  assert.equal(maskPhone('13812345625'), '138******25');
  assert.equal(maskPhone('138****25'), '138****25');
  assert.equal(maskPhone('123'), '***');
});

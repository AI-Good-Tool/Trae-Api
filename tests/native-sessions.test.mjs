import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readNativeSessions } from '../server/native-sessions.mjs';
const sid = '111111111111111111111111',
  pid = '222222222222222222222222';
const event = (type, data, env = 'local', time = '2026-10-22T10:00:00+08:00') =>
  `${time} [info] [RealtimeInitService][${env}] Handle event: ${type} ${JSON.stringify(data)}`;
function write(home, client, run, lines) {
  const file = path.join(
    home,
    'Library/Application Support',
    client,
    'logs',
    run,
    'window1/renderer.log',
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}
test('从真实客户端事件形状关联原生 ID、项目、账号和重命名，不读取导入副本', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-native-index-'));
  const file = write(home, 'Trae CN', '20261022T100000', [
    event('project_created', { local_project_id: pid, user_id: 'user', name: 'sms-forwarding' }),
    `2026-10-22T10:00:01+08:00 [info] [ProjectService] Project synchronized: ${JSON.stringify({ code: 0, data: { project_id: pid, user_id: 'user', name: 'sms-forwarding', single_root_workspace_folder: '/project/sms-forwarding' } })}`,
    event('session_created', {
      chat_session_id: sid,
      user_id: 'user',
      project_id: pid,
      origin: 'lite',
      created_at: 1792634400000,
    }),
    `2026-10-22T10:00:02+08:00 [info] [trae-chat-core] [RealtimeEventService] Session fetched: ${JSON.stringify({ chat_session_id: sid, user_id: 'user', title: '', local_project_id: pid, source: { type: 'local', local_folder: '/project/sms-forwarding' }, context: { secret: 'must-not-store' } })}`,
    event(
      'session_updated',
      {
        chat_session_id: sid,
        user_id: 'user',
        title: '分析项目结构与内容',
        updated_at: 1792634403000,
      },
      'local',
      '2026-10-22T10:00:03+08:00',
    ),
    '2026-10-22T10:00:04+08:00 [info] unrelated {"title":"导入副本","source":"client-native"}',
  ]);
  const before = fs.readFileSync(file);
  write(home, 'Trae', '20261022T100000', [
    event('session_created', {
      chat_session_id: sid,
      user_id: 'intl-user',
      title: '国际会话',
      origin: 'lite',
    }),
  ]);
  const r = readNativeSessions({
    home,
    platform: 'darwin',
    accounts: [
      {
        id: 'cn-account',
        variant: 'cn',
        user: { userId: 'user', account: { username: '账号甲' } },
      },
    ],
  });
  assert.equal(r.items.length, 2);
  const cn = r.items.find((x) => x.variant === 'cn');
  assert.equal(cn.nativeSessionId, sid);
  assert.equal(cn.projectId, pid);
  assert.equal(cn.projectName, 'sms-forwarding');
  assert.equal(cn.workspace, '/project/sms-forwarding');
  assert.equal(cn.accountId, 'cn-account');
  assert.equal(cn.title, '分析项目结构与内容');
  assert.equal(cn.nativeMetadataOnly, true);
  assert.equal(cn.messageCount, null);
  assert.equal(cn.provenance.kind, 'client-event-log');
  assert(!JSON.stringify(r).includes('must-not-store'));
  assert.notEqual(cn.id, r.items.find((x) => x.variant === 'intl').id);
  assert.deepEqual(fs.readFileSync(file), before);
});
test('按客户端事件时间处理删除、置顶、默认分组，只收录客户端实际观察到的远端会话', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-native-delete-'));
  write(home, 'Trae CN', '20261022T100000', [
    event('session_created', { chat_session_id: sid, user_id: 'user', title: '已删除' }),
    event('session_deleted', { chat_session_id: sid }, 'local', '2026-10-22T10:00:04+08:00'),
    event(
      'session_updated',
      { chat_session_id: sid, user_id: 'user', title: '删除前的旧更新' },
      'local',
      '2026-10-22T10:00:02+08:00',
    ),
    event(
      'session_created',
      {
        chat_session_id: '333333333333333333333333',
        user_id: 'user',
        title: '客户端默认会话',
        origin: 'web',
      },
      'remote',
    ),
    event(
      'session_updated',
      { chat_session_id: '333333333333333333333333', is_pinned: true },
      'remote',
      '2026-10-22T10:00:05+08:00',
    ),
    event('session_created', {
      chat_session_id: 'manually-invented-id',
      user_id: 'user',
      title: '副本',
    }),
    '2026-10-22T10:00:00+08:00 [info] [RealtimeInitService][local] Handle event: session_created {bad-json}',
  ]);
  const r = readNativeSessions({ home, platform: 'darwin' });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].projectName, '默认');
  assert.equal(r.items[0].nativePinned, true);
  assert.equal(r.items[0].clientEnv, 'remote');
  assert.equal(r.sources.find((x) => x.variant === 'intl').status, 'unavailable');
});

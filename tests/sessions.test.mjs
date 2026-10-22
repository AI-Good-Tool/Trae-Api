import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sessions, messageText, localSessionSources } from '../server/sessions.mjs';
import { Store } from '../server/store.mjs';
import { start } from '../server/index.mjs';
function fixture(options = {}) {
  const store = {
    data: { accounts: [] },
    save() {
      this.saved = (this.saved || 0) + 1;
    },
    account(id) {
      return this.data.accounts.find((a) => a.id === id);
    },
  };
  return {
    store,
    sessions: new Sessions(store, { nativeReader: () => ({ items: [], sources: [] }), ...options }),
  };
}
test('官方内容解析保留数字文本、正文和 finish 回答', () => {
  assert.equal(messageText('1212'), '1212');
  assert.equal(messageText('[{"type":"text","text_content":"hello"}]'), 'hello');
  assert.equal(
    messageText(
      JSON.stringify({
        messages: [
          {
            type: 'plan_item',
            plan_item: {
              thought: 'reason',
              tool_call_info: { name: 'finish', params: { summary: 'answer' } },
            },
          },
        ],
      }),
    ),
    'answer',
  );
});
test('本地导入幂等、导出重导入、地区隔离、搜索与归档', async () => {
  const { sessions: s } = fixture();
  const body = {
    variant: 'intl',
    data: {
      title: '1212',
      messages: [
        { role: 'user', content: '1212' },
        { role: 'assistant', content: '<script>secret topic</script>' },
      ],
    },
  };
  const r = s.import(body);
  assert.equal(s.import(body).updated, 1);
  const id = r.ids[0];
  s.update(id, { title: '重命名', pinned: true, note: '备注' });
  assert.equal(s.import({ variant: 'intl', data: { sessions: [await s.detail(id)] } }).updated, 1);
  assert.equal(s.list({ query: 'secret topic' }).total, 0);
  assert.equal(s.find(id).title, '重命名');
  assert.equal(s.list().total, 0);
  assert.equal(s.import({ ...body, variant: 'cn' }).imported, 1);
  assert.equal(s.store.data.sessions.filter((x) => x.variant === 'cn').length, 1);
  assert.throws(() => s.update(id, { title: 'bad', pinned: 'bad' }));
  assert.equal(s.find(id).title, '重命名');
  s.update(id, { archived: true });
  assert.equal(s.list({ variant: 'intl' }).total, 0);
  assert.equal(s.list({ archived: true }).total, 0);
  const n = s.store.data.sessions.length;
  assert.throws(() => s.import({ variant: 'cn', data: [body.data, { messages: [] }] }));
  assert.equal(s.store.data.sessions.length, n);
});
test('云端分页、跨账号同 ID 隔离、内容加载与同步失败保留缓存', async () => {
  let fail = false,
    changed = false;
  const calls = [];
  const { store, sessions: s } = fixture({
    host: (a) => 'https://' + a.variant + '.example',
    fetcher: async (url, init) => {
      calls.push([url, init]);
      if (fail) return new Response('', { status: 401 });
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset'));
      return Response.json({
        code: 0,
        data: u.pathname.endsWith('/messages')
          ? {
              items: [{ message_id: 'm', role: 'user', content: '1212', message_index: 1 }],
              total: 1,
            }
          : {
              items: offset
                ? [{ chat_session_id: 'two', title: 'second' }]
                : [
                    {
                      chat_session_id: 'one',
                      title: 'first',
                      updated_at: changed ? '1792635537338' : '1792635527338',
                    },
                  ],
              total: 2,
            },
      });
    },
  });
  for (const variant of ['cn', 'intl'])
    store.data.accounts.push({
      id: variant,
      variant,
      user: { token: 'private', account: { username: 'u' } },
    });
  await s.sync(store.data.accounts[0]);
  await s.sync(store.data.accounts[1]);
  assert.equal(store.data.sessions.length, 4);
  assert.equal(
    store.data.sessions.find((x) => x.remoteId === 'one').updatedAt,
    '2026-10-22T02:18:47.338Z',
  );
  const id = store.data.sessions.find((x) => x.variant === 'intl' && x.remoteId === 'one').id;
  const d = await s.detail(id);
  assert.equal(d.messages[0].text, '1212');
  changed = true;
  await s.sync(store.data.accounts[1]);
  assert.equal(s.find(id).messages, undefined);
  assert(calls.some(([url]) => url.includes('offset=1')));
  assert.equal(calls[0][1].headers.Authorization, 'Cloud-IDE-JWT private');
  fail = true;
  await assert.rejects(s.sync(store.data.accounts[0]), /HTTP 401/);
  assert.equal(store.data.sessions.length, 4);
});
test('本机来源检测仅只读识别加密库', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-session-source-'));
  const db = path.join(dir, 'Library/Application Support/Trae/ModularData/ai-agent/database.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, Buffer.alloc(32, 123));
  const before = fs.readFileSync(db);
  const r = localSessionSources(dir, { platform: 'darwin' });
  assert.equal(r[1].encrypted, true);
  assert.equal(r[1].status, 'import-required');
  assert.equal(r[0].found, false);
  assert.deepEqual(fs.readFileSync(db), before);
});
test('会话管理 API 验证登录，支持会话 ID，数据加密持久化', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'trae-session-api-')));
  store.data.settings.gatewayEnabled = false;
  const app = await start(0, store);
  try {
    assert.equal((await fetch(app.url + '/api/sessions')).status, 401);
    const root = await fetch(app.url);
    const cookie = root.headers.get('set-cookie').split(';')[0];
    const post = async (route, body) =>
      fetch(app.url + '/api/sessions/' + route, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const r = await post('import', {
      variant: 'cn',
      data: { title: 'sample', messages: [{ role: 'user', content: 'sensitive body' }] },
    });
    assert.equal(r.status, 200);
    const id = (await r.json()).ids[0];
    assert.equal((await post('sync', {})).status, 410);
    assert.equal((await post('detail', { id })).status, 200);
    assert.equal((await post('update', { id, pinned: true })).status, 200);
    assert.equal((await new Store(store.dir)).data.sessions[0].messages[0].text, 'sensitive body');
    const state = await (await fetch(app.url + '/api/state', { headers: { cookie } })).text();
    assert(!state.includes('sensitive body'));
    const cross = await fetch(app.url + '/api/sessions', {
      headers: { cookie, origin: 'https://evil.example' },
    });
    assert.equal(cross.status, 403);
  } finally {
    await app.close();
  }
});

test('原生会话列表仅采用读取适配器结果，导入标签不作为原生来源证据', async () => {
  const native = {
    id: 'native-1',
    source: 'client-native',
    variant: 'cn',
    title: '分析项目结构与内容',
    projectName: 'sms-forwarding',
    nativeSessionId: '111111111111111111111111',
    nativeMetadataOnly: true,
  };
  const { store, sessions: s } = fixture({
    nativeReader: () => ({ items: [native], sources: [] }),
  });
  store.data.sessions.push({
    id: 'cloud',
    source: 'remote',
    variant: 'cn',
    title: '云端测试',
    pinned: true,
  });
  s.import({
    variant: 'intl',
    data: { title: '手动1212', messages: [{ role: 'user', content: '副本' }] },
  });
  assert.equal(s.list().total, 1);
  assert.equal(s.list().items[0].nativeSessionId, native.nativeSessionId);
  assert.equal(s.list({ query: 'sms-forwarding' }).total, 1);
  assert.equal(s.list({ query: '手动1212' }).total, 0);
  assert.equal(s.list({ variant: 'intl' }).total, 0);
  assert.equal(s.list({ offset: 1, limit: 1 }).items.length, 0);
  assert.equal((await s.detail(native.id)).nativeMetadataOnly, true);
  assert.throws(() => s.update(native.id, { title: '改名' }), /Trae/);
  assert.equal(store.data.sessions.length, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { encode, decode, publicAccount } from '../server/client.mjs';
import { Store } from '../server/store.mjs';
import { nativeBody, sseEvents, Gateway } from '../server/gateway.mjs';
import { start } from '../server/index.mjs';

const user = {
  userId: 'test-user',
  token: 'secret-token',
  refreshToken: 'secret-refresh',
  expiredAt: '2030-01-01T00:00:00Z',
  account: { username: 'test', storeRegion: 'CN' },
};
test('客户端登录态编解码与完整性校验', () => {
  const p = { salt: crypto.randomBytes(64) },
    encoded = encode(user, p);
  assert.deepEqual(decode(encoded, p), user);
  const raw = Buffer.from(encoded, 'base64');
  raw[45] ^= 1;
  assert.throws(() => decode(raw.toString('base64'), p));
});
test('账号库加密持久化，公开对象不含凭证', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-switch-test-')),
    s = new Store(dir);
  s.upsert({ variant: 'cn', user });
  assert.equal(fs.readFileSync(s.file).includes(Buffer.from(user.token)), false);
  assert.equal(new Store(dir).data.accounts[0].user.token, user.token);
  assert.equal(JSON.stringify(publicAccount(s.data.accounts[0])).includes(user.token), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  const raw = fs.readFileSync(s.file);
  raw[30] ^= 1;
  fs.writeFileSync(s.file, raw);
  assert.throws(() => new Store(dir));
});
test('SSE 处理跨块、中文和多事件', async () => {
  const b = Buffer.from('event: output\ndata: {"response":"你好"}\n\nevent: done\ndata: {}\n\n');
  async function* chunks() {
    yield b.subarray(0, 40);
    yield b.subarray(40, 42);
    yield b.subarray(42);
  }
  const out = [];
  for await (const e of sseEvents(chunks())) out.push(e);
  assert.deepEqual(out, [
    { event: 'output', data: { response: '你好' } },
    { event: 'done', data: {} },
  ]);
});
test('反代只接受已支持的文本消息，auto 不冒充原生模型名称', () => {
  const r = nativeBody({
    model: 'auto',
    messages: [
      { role: 'developer', content: 'a' },
      { role: 'user', content: 'b' },
    ],
  });
  assert.equal(r.model, undefined);
  assert.equal(r.messages[0].role, 'system');
  assert.deepEqual(r.messages[1].content, [{ type: 'text', text: 'b' }]);
  assert.throws(() => nativeBody({ messages: [{ role: 'user', content: [] }] }));
  assert.throws(() => nativeBody({ messages: [{ role: 'user', content: 'x' }], tools: [{}] }));
});
test('工作台拒绝未认证、跨站和 DNS rebinding 请求；网关校验密钥', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'trae-http-test-'))),
    app = await start(0, store);
  try {
    assert.equal((await fetch(app.url + '/api/state')).status, 401);
    const landing = await fetch(app.url),
      cookie = landing.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(app.url + '/api/state', { headers: { cookie } })).status, 200);
    assert.equal(
      (
        await fetch(app.url + '/api/key', {
          method: 'POST',
          headers: { cookie, Origin: 'https://example.com' },
          body: '{}',
        })
      ).status,
      403,
    );
    const rebound = await new Promise((resolve, reject) => {
      const req = http.get(app.url, { headers: { Host: 'attacker.test' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
    });
    assert.equal(rebound, 403);
    store.data.settings.gatewayPort = 0;
    await app.gateway.start();
    const gateway = 'http://127.0.0.1:' + app.gateway.server.address().port;
    assert.equal((await fetch(gateway + '/v1/models')).status, 401);
    assert.equal(
      (
        await fetch(gateway + '/v1/models', {
          headers: { Authorization: 'Bearer ' + store.data.settings.apiKey },
        })
      ).status,
      200,
    );
  } finally {
    await app.close();
  }
});
test('网关将原生 response 流转换为 Chat Completions，保留真实 usage 并记录上游错误', async () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'trae-gateway-test-')));
  s.data.settings.gatewayPort = 0;
  s.upsert({ variant: 'cn', user });
  let fail = false;
  const gateway = new Gateway(s, {
    headers: () => ({}),
    host: () => 'https://test.invalid',
    upstreamFetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, undefined);
      assert.equal(payload.messages[0].content[0].text, '你好');
      const events = fail
        ? 'event: error\ndata: {"code":4023,"message":"unknown model"}\n\n'
        : 'event: output\ndata: {"response":"你好"}\n\nevent: usage\ndata: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\nevent: done\ndata: {}\n\n';
      return new Response(events, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  await gateway.start();
  const url = 'http://127.0.0.1:' + gateway.server.address().port + '/v1/chat/completions';
  const send = (stream) =>
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + s.data.settings.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'auto',
        stream,
        messages: [{ role: 'user', content: '你好' }],
      }),
    });
  try {
    const r = await send(false),
      j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.choices[0].message.content, '你好');
    assert.equal(j.usage.total_tokens, 5);
    const stream = await send(true),
      text = await stream.text();
    assert.match(text, /chat.completion.chunk/);
    assert.match(text, /\[DONE\]/);
    fail = true;
    const error = await send(false);
    assert.equal(error.status, 502);
    assert.match((await error.json()).error.message, /4023/);
    assert.equal(s.data.requests[0].status, 'error');
    assert.equal(s.data.requests[1].inputTokens, 3);
    assert.equal(s.data.requests.length, 3);
  } finally {
    await gateway.stop();
  }
});

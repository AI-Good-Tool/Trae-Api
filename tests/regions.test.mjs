import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { Gateway } from '../server/gateway.mjs';
import { migrateSettings } from '../server/regions.mjs';
import { changeApiKey, updateGatewaySettings } from '../server/settings.mjs';

function fixture() {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'trae-region-test-')));
  store.data.settings.gatewayPort = 0;
  for (const [variant, name, models] of [
    ['cn', '国内账号', ['cn-only', 'shared']],
    ['intl', '国际账号', ['intl-only', 'shared']],
  ]) {
    store.upsert({
      variant,
      user: {
        userId: variant,
        token: `private-${variant}`,
        expiredAt: '2030-01-01T00:00:00Z',
        account: { username: name },
      },
      models: models.map((id) => ({ id })),
    });
  }
  return store;
}
function fakeGateway(store, calls = [], reply) {
  return new Gateway(store, {
    headers: (a) => ({ region: a.variant }),
    host: (a) => `https://${a.variant}.invalid`,
    upstreamFetch: async (url, options) => {
      calls.push({ url, region: options.headers.region, body: JSON.parse(options.body) });
      return new Response(
        reply || 'event: output\ndata: {"response":"ok"}\n\nevent: done\ndata: {}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  });
}
async function call(gateway, store, route, body, key = store.data.settings.apiKey) {
  return fetch(`http://127.0.0.1:${gateway.server.address().port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const message = (model) => ({
  model,
  messages: [{ role: 'user', content: 'PRIVATE PROMPT DO NOT LOG' }],
});

test('迁移旧版本账号选择，只归入原账号所属地区', () => {
  const data = {
    accounts: [{ id: 'old', variant: 'intl' }],
    settings: { gatewayAccountId: 'old' },
  };
  migrateSettings(data);
  assert.deepEqual(data.settings.gatewayAccountIds, { all: '', cn: '', intl: 'old' });
  assert.equal(data.settings.gatewayVariant, 'intl');
  assert.equal('gatewayAccountId' in data.settings, false);
});

test('重启后将未完成请求恢复为已取消，避免永久显示处理中', () => {
  const store = fixture();
  store.data.requests.push({ id: 'unfinished', status: 'pending', time: new Date().toISOString() });
  store.save();
  const restored = new Store(store.dir);
  assert.equal(restored.data.requests[0].status, 'cancelled');
  assert.equal(restored.data.requests[0].errorCode, 'app_restarted');
});
test('国内与国际模型、账号、同名模型调用完全隔离，默认路径跟随已保存地区', async () => {
  const store = fixture(),
    calls = [],
    gateway = fakeGateway(store, calls);
  await gateway.start();
  try {
    const cn = await (await call(gateway, store, '/cn/v1/models')).json(),
      intl = await (await call(gateway, store, '/intl/v1/models')).json();
    assert.deepEqual(
      cn.data.map((m) => m.id),
      ['auto', 'cn-only', 'shared'],
    );
    assert.deepEqual(
      intl.data.map((m) => m.id),
      ['auto', 'shared', 'intl-only'],
    );
    assert.equal(
      (await call(gateway, store, '/cn/v1/chat/completions', message('intl-only'))).status,
      400,
    );
    assert.equal(calls.length, 0);
    assert.equal(
      (await call(gateway, store, '/cn/v1/chat/completions', message('shared'))).status,
      200,
    );
    assert.equal(
      (await call(gateway, store, '/intl/v1/chat/completions', message('shared'))).status,
      200,
    );
    await updateGatewaySettings(store, gateway, { gatewayVariant: 'intl' });
    assert.equal((await call(gateway, store, '/v1/chat/completions', message('auto'))).status, 200);
    assert.deepEqual(
      calls.map((x) => x.region),
      ['cn', 'intl', 'intl'],
    );
    assert.equal(JSON.stringify(store.data.requests).includes('PRIVATE PROMPT'), false);
    assert.equal(store.data.requests[0].httpStatus, 200);
    assert.equal(store.data.requests[0].protocol, 'Chat Completions');
  } finally {
    await gateway.stop();
  }
});
test('指定账号限制同区模型列表与路由，某区缺少账号不会回退到其他地区', async () => {
  const store = fixture(),
    calls = [],
    gateway = fakeGateway(store, calls);
  const first = store.data.accounts.find((a) => a.variant === 'cn');
  const second = store.upsert({
    variant: 'cn',
    user: {
      userId: 'cn-2',
      token: 'secret',
      expiredAt: '2030-01-01T00:00:00Z',
      account: { username: '第二国内账号' },
    },
    models: [{ id: 'second-only' }],
  });
  store.data.settings.gatewayAccountIds.cn = second.id;
  await gateway.start();
  try {
    assert.deepEqual(
      (await (await call(gateway, store, '/cn/v1/models')).json()).data.map((m) => m.id),
      ['auto', 'second-only'],
    );
    assert.equal(
      (await call(gateway, store, '/cn/v1/chat/completions', message('cn-only'))).status,
      400,
    );
    second.user.expiredAt = '2000-01-01T00:00:00Z';
    first.user.expiredAt = '2000-01-01T00:00:00Z';
    assert.equal(
      (await call(gateway, store, '/cn/v1/chat/completions', message('auto'))).status,
      503,
    );
    assert.equal(calls.length, 0);
    assert.equal(
      (await call(gateway, store, '/intl/v1/chat/completions', message('auto'))).status,
      200,
    );
    assert.equal(calls[0].region, 'intl');
  } finally {
    await gateway.stop();
  }
});
test('编辑及随机 API Key 即时生效，旧密钥失效，非法编辑保持原值', async () => {
  const store = fixture(),
    gateway = fakeGateway(store);
  await gateway.start();
  const old = store.data.settings.apiKey;
  try {
    assert.throws(() => changeApiKey(store, { mode: 'edit', apiKey: 'bad key' }));
    assert.equal(store.data.settings.apiKey, old);
    changeApiKey(store, { mode: 'edit', apiKey: 'my-local-key-12345678' });
    assert.equal((await call(gateway, store, '/cn/v1/models', null, old)).status, 401);
    assert.equal((await call(gateway, store, '/cn/v1/models')).status, 200);
    const first = changeApiKey(store, { mode: 'random' }).apiKey,
      second = changeApiKey(store, { mode: 'random' }).apiKey;
    assert.notEqual(first, second);
    assert.match(second, /^tsk_[0-9a-f]{64}$/);
    assert.equal((await call(gateway, store, '/intl/v1/models', null, first)).status, 401);
    assert.equal((await call(gateway, store, '/intl/v1/models')).status, 200);
    assert.equal(JSON.stringify(store.data.events).includes(second), false);
  } finally {
    await gateway.stop();
  }
});
test('设置校验和启动失败保持原设置，不留下部分地区或账号变更', async () => {
  const store = fixture(),
    before = structuredClone(store.data.settings),
    gateway = {
      server: null,
      start: async () => {
        throw new Error('port in use');
      },
      stop: async () => {},
    };
  const foreign = store.data.accounts.find((a) => a.variant === 'intl').id;
  await assert.rejects(
    updateGatewaySettings(store, gateway, { gatewayVariant: 'cn', gatewayAccountId: foreign }),
  );
  assert.deepEqual(store.data.settings, before);
  await assert.rejects(
    updateGatewaySettings(store, gateway, { gatewayVariant: 'intl', gatewayPort: 1 }),
  );
  assert.deepEqual(store.data.settings, before);
  await assert.rejects(
    updateGatewaySettings(store, gateway, { gatewayVariant: 'intl', gatewayEnabled: true }),
  );
  assert.deepEqual(store.data.settings, before);
});
test('上游错误不落盘正文或 token；流中断记为失败，不能伪装成功', async () => {
  for (const reply of [
    'event: error\ndata: {"code":4023,"message":"PRIVATE PROMPT private-cn Bearer secret"}\n\n',
    'event: output\ndata: {"response":"PRIVATE OUTPUT"}\n\n',
  ]) {
    const store = fixture(),
      gateway = fakeGateway(store, [], reply);
    await gateway.start();
    try {
      const r = await call(gateway, store, '/cn/v1/chat/completions', message('auto'));
      assert.equal(r.status, 502);
      const records = JSON.stringify(store.data.requests);
      assert.equal(records.includes('PRIVATE'), false);
      assert.equal(records.includes('private-cn'), false);
      assert.equal(store.data.requests[0].status, 'error');
      assert.equal(store.data.requests[0].httpStatus, 502);
      assert.equal(store.data.requests[0].upstreamStatus, 200);
    } finally {
      await gateway.stop();
    }
  }
});
test('并发启动复用同一监听服务，缺少可用账号也记录真实失败请求', async () => {
  const store = fixture(),
    gateway = fakeGateway(store);
  await Promise.all([gateway.start(), gateway.start()]);
  try {
    store.data.accounts = [];
    assert.equal(
      (await call(gateway, store, '/intl/v1/chat/completions', message('auto'))).status,
      503,
    );
    assert.equal(store.data.requests[0].variant, 'intl');
    assert.equal(store.data.requests[0].accountId, null);
    assert.equal(store.data.requests[0].errorCode, 'no_account');
  } finally {
    await gateway.stop();
  }
});

test('双区共有模型按模型独立轮询，独有模型限定地区，别名映射真实配置并记录', async () => {
  const store = fixture(),
    calls = [],
    gateway = fakeGateway(store, calls);
  const { updateModelRule } = await import('../server/models.mjs');
  await updateGatewaySettings(store, gateway, { gatewayVariant: 'all' });
  updateModelRule(store, { modelId: 'shared', alias: 'my-shared', regions: ['cn', 'intl'] });
  await gateway.start();
  try {
    const models = (await (await call(gateway, store, '/v1/models')).json()).data.map((m) => m.id);
    assert(models.includes('my-shared'));
    assert(!models.includes('shared'));
    for (const model of ['my-shared', 'intl-only', 'my-shared', 'cn-only', 'my-shared']) {
      assert.equal(
        (await call(gateway, store, '/v1/chat/completions', message(model))).status,
        200,
      );
    }
    assert.deepEqual(
      calls.map((c) => c.region),
      ['cn', 'intl', 'intl', 'cn', 'cn'],
    );
    assert.equal(calls[0].body.model, 'shared');
    const r = store.data.requests[0];
    assert.equal(r.model, 'my-shared');
    assert.equal(r.realModel, 'shared');
    assert.equal(r.routingScope, 'all');
    updateModelRule(store, { modelId: 'shared', alias: 'new-shared', regions: ['intl'] });
    assert.equal(r.model, 'my-shared');
    assert.equal(
      (await call(gateway, store, '/cn/v1/chat/completions', message('new-shared'))).status,
      400,
    );
    assert.equal(
      (await call(gateway, store, '/v1/chat/completions', message('new-shared'))).status,
      200,
    );
    assert.equal(calls.at(-1).region, 'intl');
    assert.throws(() =>
      updateModelRule(store, { modelId: 'shared', alias: 'cn-only', regions: ['cn'] }),
    );
  } finally {
    await gateway.stop();
  }
});
test('同一真实模型的不同地区配置 ID 使用各账号原始 ID，顺序优先与指定账号不越界', async () => {
  const store = fixture(),
    calls = [],
    gateway = fakeGateway(store, calls);
  for (const a of store.data.accounts)
    a.models = [{ id: a.variant + '-config', model: 'same-real' }];
  await updateGatewaySettings(store, gateway, { gatewayVariant: 'all', gatewayMode: 'priority' });
  await gateway.start();
  try {
    for (let i = 0; i < 2; i++)
      await call(gateway, store, '/v1/chat/completions', message('same-real'));
    assert.deepEqual(
      calls.map((c) => c.body.model),
      ['cn-config', 'cn-config'],
    );
    const intl = store.data.accounts.find((a) => a.variant === 'intl');
    await updateGatewaySettings(store, gateway, {
      gatewayAccountId: intl.id,
      gatewayMode: 'random',
    });
    await call(gateway, store, '/v1/chat/completions', message('same-real'));
    assert.equal(calls.at(-1).body.model, 'intl-config');
    await assert.rejects(updateGatewaySettings(store, gateway, { gatewayAccountId: 'missing' }));
  } finally {
    await gateway.stop();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { Gateway } from '../server/gateway.mjs';
import { updateGatewaySettings } from '../server/settings.mjs';

const model = {
  id: 'deepseek-v4.1-flash',
  model: 'deepseek-v4.1-flash',
  catalogSource: 'remote-api',
  functions: ['solo_agent_remote'],
};
function fixture() {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'trae-catalog-migrate-')));
  Object.assign(store.data.settings, {
    gatewayCloudMode: false,
    gatewayVariant: 'cn',
    gatewayPort: 0,
  });
  store.data.accounts = ['cn', 'intl'].map((variant) => ({
    id: variant,
    variant,
    user: { userId: variant, expiredAt: '2030-01-01', account: { username: variant } },
    models: [structuredClone(model)],
  }));
  return store;
}
function makeGateway(store, catalogFetcher) {
  return new Gateway(store, {
    catalogFetcher,
    remoteTransport: async () => {
      throw new Error('should_never_use_cloud');
    },
    localTransport: async (_account, _body, _config, { onMetadata }) => {
      onMetadata({
        upstreamModel: model.id,
        localSession: true,
        cloudSessionCleanup: 'not_applicable',
      });
      return new Response('event: output\ndata: {"response":"ok"}\n\nevent: done\ndata: {}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
}
const upgraded = () => [{ ...model, functions: ['solo_agent_remote', 'solo_agent_lite'] }];
function call(gateway, store, route, body) {
  return fetch(`http://127.0.0.1:${gateway.server.address().port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + store.data.settings.apiKey,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const body = { model: model.id, messages: [{ role: 'user', content: 'PRIVATE' }] };

test('直接请求旧云端目录中的模型时先升级，再选择本地账号，不要求手动刷新', async () => {
  const store = fixture();
  const calls = [];
  const gateway = makeGateway(store, async (a) => {
    calls.push(a.id);
    return upgraded();
  });
  await gateway.start();
  try {
    const response = await call(gateway, store, '/v1/chat/completions', body);
    assert.equal(response.status, 200);
    await response.json();
    assert.deepEqual(calls, ['cn']);
    assert.equal(store.data.requests[0].accountId, 'cn');
    assert.equal(store.data.requests[0].transport, 'Local');
    const disk = new Store(store.dir);
    assert.equal(disk.data.accounts[0].modelCatalogVersion, 2);
    assert.deepEqual(disk.data.accounts[0].models[0].functions, [
      'solo_agent_remote',
      'solo_agent_lite',
    ]);
    assert.equal(disk.data.accounts[1].modelCatalogVersion, undefined);
    assert(!JSON.stringify(disk.data.requests).includes('PRIVATE'));
  } finally {
    await gateway.stop();
  }
});

test('本地模型列表先迁移目录；显式国际入口保持地区隔离，并发刷新合并', async () => {
  const store = fixture(),
    calls = [];
  const gateway = makeGateway(store, async (a) => {
    calls.push(a.id);
    await new Promise((r) => setTimeout(r, 10));
    return upgraded();
  });
  await gateway.start();
  try {
    const responses = await Promise.all([
      call(gateway, store, '/intl/v1/models'),
      call(gateway, store, '/intl/v1/models'),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert((await response.json()).data.some((m) => m.id === model.id));
    }
    assert.deepEqual(calls, ['intl']);
    assert.equal(store.data.accounts[0].modelCatalogVersion, undefined);
    await call(gateway, store, '/intl/v1/models');
    assert.equal(calls.length, 1);
  } finally {
    await gateway.stop();
  }
});

test('关闭开关时自动升级目录；失败保留云端设置与旧模型数据', async () => {
  for (const fail of [false, true]) {
    const store = fixture();
    store.data.settings.gatewayCloudMode = true;
    const oldModels = store.data.accounts[0].models;
    const gateway = makeGateway(store, async () => {
      if (fail) throw new Error('PRIVATE upstream error');
      return upgraded();
    });
    if (fail) {
      await assert.rejects(
        updateGatewaySettings(store, gateway, { gatewayCloudMode: false }),
        /目录刷新失败/,
      );
      assert.equal(store.data.settings.gatewayCloudMode, true);
      assert.equal(store.data.accounts[0].models, oldModels);
    } else {
      await updateGatewaySettings(store, gateway, { gatewayCloudMode: false });
      assert.equal(store.data.settings.gatewayCloudMode, false);
      assert.equal(store.data.accounts[0].modelCatalogVersion, 2);
    }
  }
});

test('刷新失败明确记录目录错误，不误报模型下线、不回退云端，未认证探测不刷新目录', async () => {
  const store = fixture();
  let calls = 0;
  const gateway = makeGateway(store, async () => {
    calls++;
    throw new Error('PRIVATE token');
  });
  await gateway.start();
  try {
    const probe = await fetch(`http://127.0.0.1:${gateway.server.address().port}/api/hello`);
    assert.equal(probe.status, 401);
    assert.equal(calls, 0);
    const response = await call(gateway, store, '/v1/chat/completions', body);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'local_catalog_refresh_failed');
    assert.equal(store.data.requests[0].transport, 'Local');
    assert(!JSON.stringify(store.data.requests).includes('PRIVATE'));
  } finally {
    await gateway.stop();
  }
});

test('已确认仅云端支持的模型仍被拒绝，不放宽本地能力检查', async () => {
  const store = fixture();
  store.data.accounts[0].modelCatalogVersion = 2;
  const gateway = makeGateway(store, async () => {
    throw new Error('should_not_refresh');
  });
  await gateway.start();
  try {
    const response = await call(gateway, store, '/v1/chat/completions', body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'model_not_available');
  } finally {
    await gateway.stop();
  }
});

test('目录刷新期间客户端取消后不会继续发起本地推理', async () => {
  const store = fixture();
  let startRefresh, finishRefresh;
  const started = new Promise((r) => {
    startRefresh = r;
  });
  const catalog = new Promise((r) => {
    finishRefresh = r;
  });
  const gateway = makeGateway(store, async () => {
    startRefresh();
    return await catalog;
  });
  let inferenceCalls = 0;
  gateway.localTransport = async () => {
    inferenceCalls++;
    throw new Error('should_not_run');
  };
  await gateway.start();
  const socketClosed = new Promise((resolve) =>
    gateway.server.once('connection', (socket) => socket.once('close', resolve)),
  );
  try {
    const controller = new AbortController();
    const response = fetch(
      `http://127.0.0.1:${gateway.server.address().port}/v1/chat/completions`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + store.data.settings.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    await started;
    controller.abort();
    await assert.rejects(response);
    await socketClosed;
    finishRefresh(upgraded());
    const deadline = Date.now() + 2000;
    while (store.data.requests[0].status === 'pending' && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(store.data.requests[0].status, 'cancelled');
    assert.equal(inferenceCalls, 0);
  } finally {
    finishRefresh(upgraded());
    await gateway.stop();
  }
});

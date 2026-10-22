import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Store } from '../server/store.mjs';
import { Gateway, sseEvents } from '../server/gateway.mjs';
import { localChat, localPacket } from '../server/local.mjs';
import { localBridge } from '../server/local-bridge.mjs';
import { DebugPipe, LocalRuntimes, serializeLocalCreates } from '../server/local-runtime.mjs';
import { migrateSettings } from '../server/regions.mjs';
import { updateGatewaySettings } from '../server/settings.mjs';
import { resolveModel, modelCatalogView, updateModelRule } from '../server/models.mjs';

const account = {
  id: 'a',
  variant: 'cn',
  user: {
    userId: 'u',
    token: 'PRIVATE_TOKEN',
    account: { username: 'test' },
    expiredAt: '2030-01-01',
  },
  models: [{ id: 'model', functions: ['solo_agent_lite', 'solo_agent_remote'] }],
};
const event = (event, payload) => ({ code: 0, data: { code: 0, data: { event, payload } } });
const success = [
  event('model_config', { config_name: 'model' }),
  event('plan_item', {
    id: 'p',
    tool_call_info: { name: 'finish', params: { summary: 'PRIVATE_OUTPUT' } },
  }),
  event('token_usage', { prompt_tokens: 5, completion_tokens: 2 }),
  event('done', { status: 'completed' }),
];

test('启动统一恢复云端清理（含旧关闭配置）；内部通道参数仍严格校验并支持失败回滚', async () => {
  for (const value of [undefined, false, true]) {
    const data = { accounts: [], settings: { gatewayCloudMode: value } };
    migrateSettings(data);
    assert.equal(data.settings.gatewayCloudMode, true);
  }
  const store = {
    data: { settings: { gatewayCloudMode: true, gatewayAccountIds: {} } },
    save() {},
  };
  const gateway = { server: null };
  await assert.rejects(updateGatewaySettings(store, gateway, { gatewayCloudMode: 'false' }));
  await updateGatewaySettings(store, gateway, { gatewayCloudMode: false });
  assert.equal(store.data.settings.gatewayCloudMode, false);
  store.save = () => {
    throw new Error('disk');
  };
  await assert.rejects(updateGatewaySettings(store, gateway, { gatewayCloudMode: true }));
  assert.equal(store.data.settings.gatewayCloudMode, false);
});

test('模型目录及账号池按云端/本地能力过滤，保留双区同名模型调度', () => {
  const data = {
    settings: { gatewayCloudMode: false },
    accounts: [
      account,
      {
        ...account,
        id: 'b',
        variant: 'intl',
        models: [{ id: 'remote', functions: ['solo_agent_remote'] }],
      },
    ],
  };
  assert.deepEqual(
    modelCatalogView(data).map((m) => m.id),
    ['model'],
  );
  assert.equal(resolveModel(data, 'all', 'remote').pool.length, 0);
  data.settings.gatewayCloudMode = true;
  assert.equal(resolveModel(data, 'all', 'remote').pool[0].variant, 'intl');
});

test('模型别名在两种通道之间保持唯一，切换后不产生名称冲突', () => {
  const store = {
    data: {
      settings: { gatewayCloudMode: false },
      accounts: [
        {
          ...account,
          models: [
            { id: 'local-only', functions: ['solo_agent_lite'] },
            { id: 'remote-only', functions: ['solo_agent_remote'] },
          ],
        },
      ],
    },
    save() {},
  };
  assert.throws(
    () => updateModelRule(store, { modelId: 'local-only', alias: 'remote-only', regions: ['cn'] }),
    /冲突/,
  );
});

test('本地通道仅查询模型目录；创建与回复走 IPC，不调用云端任务或删除接口', async () => {
  for (const ending of [
    'success',
    'tool',
    'truncated',
    'mismatch',
    'cancelled',
    'stopped',
    'lost',
  ]) {
    const calls = [],
      network = [],
      metadata = {};
    let released = false;
    const controller = new AbortController();
    const runtime = {
      workspace: '/isolated/workspace',
      release: () => {
        released = true;
      },
      invoke: async (op, value) => {
        calls.push({ op, value });
        if (op === 'request') {
          if (value.params.method === 'create_chat_session') {
            if (ending === 'cancelled') controller.abort();
            return {
              params: {
                code: 0,
                data: { code: 0, data: { chat_session_id: 'local', message_id: 'message' } },
              },
            };
          }
          return { params: { code: 0, data: { code: 0, data: {} } } };
        }
        if (op === 'request_stream') return { streamId: 'stream' };
        if (op === 'poll')
          return {
            done: true,
            ...(ending === 'lost' ? { error: 'local_stream_lost' } : {}),
            items:
              ending === 'stopped'
                ? [event('metadata', { status: 'canceled' })]
                : ending === 'tool'
                  ? [event('plan_item', { tool_call_info: { name: 'run_command' } })]
                  : ending === 'truncated'
                    ? []
                    : ending === 'mismatch'
                      ? [event('model_config', { config_name: 'other' })]
                      : success,
          };
        return true;
      },
    };
    const run = () =>
      localChat(account, { messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] }, 'model', {
        signal: controller.signal,
        runtimes: { acquire: async () => runtime },
        host: () => 'https://upstream.invalid',
        fetcher: async (url, options) => {
          network.push({ url, options });
          return Response.json({
            code: 0,
            data: { list: [{ function: 'solo_agent_lite', models: [{ name: 'model' }] }] },
          });
        },
        onMetadata: (m) => Object.assign(metadata, m),
      });
    if (ending === 'success') {
      const response = await run();
      const output = [];
      for await (const e of sseEvents(response.body)) output.push(e);
      assert.equal(output[0].data.response, 'PRIVATE_OUTPUT');
      assert.equal(output[0].data.usage.prompt_tokens, 5);
      assert.equal(metadata.localStage, 'completed');
      assert.equal(metadata.lastUpstreamEvent, 'done');
      assert.equal(metadata.outputTokens, 2);
    } else await assert.rejects(run());
    assert(released);
    assert.equal(network.length, 1);
    assert(network[0].url.includes('functions=solo_agent_lite'));
    assert(!network[0].options.method);
    const create = calls.find((c) => c.value?.params?.method === 'create_chat_session').value;
    assert.equal(create.params.client_info.permission_profile_id, 'manual_approval');
    assert.equal(create.params.data.output_storage_path, '/isolated/workspace');
    assert.equal(create.params.data.initial_message.custom_model.config_name, 'model');
    assert.equal(create.params.data.initial_message.custom_model.model_name, 'model');
    assert.equal(metadata.cloudSessionCleanup, 'not_applicable');
    assert.equal(metadata.transport, 'Local');
    assert(!JSON.stringify(metadata).includes('PRIVATE'));
    if (ending !== 'success')
      assert(calls.some((c) => c.value?.params?.method === 'stop_chat_session'));
  }
});

test('首帧前注册本地流，窗口重载后的未知流立即报错，保留抢先到达的事件', async () => {
  for (const early of [false, true]) {
    const ipc = new EventEmitter();
    ipc.send = (raw) => {
      const message = JSON.parse(raw);
      if (message.method !== 'request_stream') return;
      queueMicrotask(() => {
        if (early)
          ipc.emit(
            'message',
            JSON.stringify({
              method: 'rpc.stream.s',
              meta: { stream: true, streamId: 's' },
              params: {
                data: {
                  params: {
                    code: 0,
                    data: {
                      code: 0,
                      data: { event: 'metadata', payload: { status: 'in_progress' } },
                    },
                  },
                },
              },
            }),
          );
        ipc.emit('message', JSON.stringify({ id: message.id, result: { streamId: 's' } }));
      });
    };
    const context = vm.createContext({
      vscode: { ahaIpc: { connect: () => ipc } },
      crypto: crypto.webcrypto,
      setTimeout,
      clearTimeout,
    });
    const run = (op, value) =>
      vm.runInContext(
        `(${localBridge.toString()})(${JSON.stringify(op)},${JSON.stringify(value)})`,
        context,
      );
    await run('request_stream', localPacket(account, 'subscribe_events', {}, 'one', '/isolated'));
    const first = await run('poll', { streamId: 's', sessionId: 'one' });
    assert.equal(first.error, undefined);
    assert.equal(first.items.length, early ? 1 : 0);
    ipc.emit(
      'message',
      JSON.stringify({
        method: 'rpc.stream.s',
        meta: { stream: true, streamId: 's', done: true },
        params: { error: { code: 500 } },
      }),
    );
    const terminal = await run('poll', { streamId: 's', sessionId: 'one' });
    assert.equal(terminal.done, true);
    assert.equal(terminal.error, 'local_stream_error');
    vm.runInContext('delete globalThis.__traeSwitchLocalBridge', context);
    assert.equal(
      (await run('poll', { streamId: 's', sessionId: 'one' })).error,
      'local_stream_lost',
    );
  }
});

test('本地流持续无事件时停止原生任务并释放实例，保活不会掩盖停滞', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const calls = [];
  const runtime = {
    workspace: '/isolated',
    release: () => calls.push('release'),
    invoke: async (op, value) => {
      calls.push(value?.params?.method || op);
      if (op === 'request')
        return {
          params: { code: 0, data: { code: 0, data: { chat_session_id: 's', message_id: 'm' } } },
        };
      if (op === 'request_stream') return { streamId: 's' };
      if (op === 'poll') {
        t.mock.timers.setTime(121001);
        return { items: [], done: false };
      }
    },
  };
  await assert.rejects(
    localChat(account, { messages: [{ role: 'user', content: 'PRIVATE' }] }, 'model', {
      runtimes: { acquire: async () => runtime },
      host: () => '',
      fetcher: async () =>
        Response.json({
          code: 0,
          data: { list: [{ function: 'solo_agent_lite', models: [{ name: 'model' }] }] },
        }),
    }),
    /local_stream_idle/,
  );
  assert(calls.includes('stop_chat_session'));
  assert(calls.includes('cancel'));
  assert(calls.includes('release'));
});

test('等待本地生成时发送 Messages 保活；完成只发一个开始/结束，断流发标准错误并释放并发', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const fails of [false, true]) {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'trae-local-heartbeat-')));
    store.data.accounts = [account];
    Object.assign(store.data.settings, { gatewayCloudMode: false, gatewayPort: 0 });
    let start, finish;
    const started = new Promise((r) => {
      start = r;
    });
    const deferred = new Promise((r) => {
      finish = r;
    });
    const gateway = new Gateway(store, {
      localTransport: async (_a, _b, _c, { onMetadata }) => {
        onMetadata({ localStage: 'generating', lastUpstreamEvent: 'plan_item' });
        start();
        await deferred;
        if (fails) throw new Error('local_stream_lost');
        return new Response(
          'event: output\ndata: {"response":"PRIVATE_OUTPUT","usage":{"prompt_tokens":7,"completion_tokens":3}}\n\nevent: done\ndata: {}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    await gateway.start();
    try {
      const pending = fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': store.data.settings.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'model',
          max_tokens: 64,
          stream: true,
          messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }],
        }),
      });
      await started;
      t.mock.timers.tick(10000);
      const response = await pending;
      assert.equal(response.status, 200);
      const events = sseEvents(response.body);
      assert.equal((await events.next()).value.event, 'ping');
      assert.equal(store.data.requests[0].status, 'pending');
      assert.equal(store.data.requests[0].localStage, 'generating');
      finish();
      const rest = [];
      for await (const e of events) rest.push(e);
      if (fails) {
        assert.equal(rest.length, 1);
        assert.equal(rest[0].event, 'error');
        assert.equal(rest[0].data.type, 'error');
        assert.match(rest[0].data.error.message, /local_stream_lost/);
      } else {
        assert.equal(rest.filter((e) => e.event === 'message_start').length, 1);
        assert.equal(rest.at(-1).event, 'message_stop');
      }
      assert.equal(store.data.requests[0].status, fails ? 'error' : 'success');
      assert.equal(gateway.active.size, 0);
      assert(!JSON.stringify(new Store(store.dir).data.requests).includes('PRIVATE'));
    } finally {
      finish();
      await gateway.stop();
    }
  }
});

test('本地模式出错不回退云端，请求记录持久化通道且不包含正文', async () => {
  for (const fails of [false, true]) {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'trae-local-route-')));
    store.data.accounts = [account];
    Object.assign(store.data.settings, { gatewayCloudMode: false, gatewayPort: 0 });
    let remoteCalls = 0;
    const gateway = new Gateway(store, {
      remoteTransport: async () => {
        remoteCalls++;
        throw new Error('should_not_run');
      },
      localTransport: async (_account, _body, _config, { onMetadata }) => {
        if (fails) throw new Error('local_client_missing');
        onMetadata({
          upstreamModel: 'model',
          cloudSessionCleanup: 'not_applicable',
          localSession: true,
        });
        return new Response(
          'event: output\ndata: {"response":"PRIVATE output"}\n\nevent: done\ndata: {}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    await gateway.start();
    try {
      const r = await fetch(
        `http://127.0.0.1:${gateway.server.address().port}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + store.data.settings.apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'model',
            messages: [{ role: 'user', content: 'PRIVATE input' }],
          }),
        },
      );
      assert.equal(r.status, fails ? 502 : 200);
      await r.json();
      assert.equal(remoteCalls, 0);
      const record = new Store(store.dir).data.requests[0];
      assert.equal(record.transport, 'Local');
      assert.equal(record.status, fails ? 'error' : 'success');
      assert(!JSON.stringify(record).includes('PRIVATE'));
    } finally {
      await gateway.stop();
    }
  }
});

test('渲染器桥只提供空工作区元数据，拒绝执行任意客户端命令并隔离请求', async () => {
  const ipc = new EventEmitter();
  const sent = [];
  ipc.send = (raw) => {
    const message = JSON.parse(raw);
    sent.push(message);
    if (message.method === 'request')
      queueMicrotask(() =>
        ipc.emit('message', JSON.stringify({ id: message.id, result: { params: { code: 0 } } })),
      );
  };
  const context = vm.createContext({
    vscode: { ahaIpc: { connect: () => ipc } },
    crypto: crypto.webcrypto,
    setTimeout,
    clearTimeout,
  });
  const run = (op, value) =>
    vm.runInContext(
      `(${localBridge.toString()})(${JSON.stringify(op)},${JSON.stringify(value)})`,
      context,
    );
  await run('request', localPacket(account, 'list_chat_sessions', {}, 'one', '/isolated'));
  ipc.emit(
    'message',
    JSON.stringify({
      id: 0,
      method: 'execute_command',
      params: [
        { channel_id: 'c', session_id: 'one', params: { command_id: 'icube.runArbitraryCommand' } },
      ],
    }),
  );
  assert.equal(sent.at(-1).result.results.error, 'local_tool_execution');
  assert.equal(
    (await run('poll', { streamId: 'not-started', sessionId: 'one' })).error,
    'local_tool_execution',
  );
  ipc.emit(
    'message',
    JSON.stringify({
      method: 'rpc.stream.s',
      meta: { stream: true, streamId: 's' },
      params: { data: { params: { code: 0 } } },
    }),
  );
  assert.equal(
    (await run('poll', { streamId: 's', sessionId: 'one' })).error,
    'local_tool_execution',
  );
  assert.equal((await run('poll', { streamId: 's', sessionId: 'two' })).error, undefined);
});

test('私有调试管道处理分包与 UTF-8，退出时拒绝未完成调用', async () => {
  const child = new EventEmitter();
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  const pipe = new DebugPipe(child);
  const response = pipe.call('Runtime.evaluate', {}, 'session');
  const raw = Buffer.from(JSON.stringify({ id: 1, result: { text: '中文' } }) + '\0');
  const cut = raw.indexOf(Buffer.from('中文')) + 1;
  child.stdio[4].write(raw.subarray(0, cut));
  child.stdio[4].write(raw.subarray(cut));
  assert.deepEqual(await response, { text: '中文' });
  const pending = pipe.call('Target.getTargets');
  child.emit('exit');
  await assert.rejects(pending, /local_debugger_error/);
  await assert.rejects(pipe.call('Target.getTargets'), /local_runtime_closed/);
});

test('同账号并发复用实例，国内国际及不同账号隔离，停止时释放所有实例', async () => {
  const runtimes = new LocalRuntimes('/unused');
  let launches = 0,
    closes = 0;
  runtimes.launch = async () => {
    launches++;
    await new Promise((r) => setTimeout(r, 5));
    return {
      isAlive: () => true,
      close: async () => {
        closes++;
      },
    };
  };
  const [one, two, intl] = await Promise.all([
    runtimes.acquire(account),
    runtimes.acquire(account),
    runtimes.acquire({ ...account, variant: 'intl' }),
  ]);
  assert.equal(launches, 2);
  one.release();
  two.release();
  intl.release();
  await runtimes.close();
  assert.equal(closes, 2);
  assert.equal(runtimes.entries.size, 0);
});

test('同实例创建会话依次写入数据库，事件流不受阻，创建失败后队列仍可用', async () => {
  let release;
  const calls = [];
  const invoke = serializeLocalCreates(async (op, value) => {
    const id = value.params?.data?.id || op;
    calls.push(id);
    if (id === 'first')
      await new Promise((r) => {
        release = r;
      });
    if (id === 'failed') throw new Error('failed');
    return id;
  });
  const create = (id) =>
    invoke('request', { params: { method: 'create_chat_session', data: { id } } });
  const first = create('first'),
    second = create('second');
  await Promise.resolve();
  assert.deepEqual(calls, ['first']);
  assert.equal(await invoke('poll', {}), 'poll');
  release();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  const failed = create('failed'),
    next = create('next');
  await assert.rejects(failed, /failed/);
  assert.equal(await next, 'next');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { cleanupRemoteSession } from '../server/remote-cleanup.mjs';
import { remoteChat } from '../server/remote.mjs';
import { Gateway, sseEvents } from '../server/gateway.mjs';

const account = { id: 'a', variant: 'cn', user: { token: 'PRIVATE' } };
const host = () => 'https://upstream.invalid';

test('清理只使用指定会话；支持 204/404，业务错误不记成功，失败会重试', async () => {
  for (const status of [204, 404, 401, 500, 'business', 'network']) {
    const calls = [];
    const result = await cleanupRemoteSession(account, 'created/id', {
      host,
      fetcher: async (url, options) => {
        calls.push({ url, options });
        if (status === 'network') throw new Error('PRIVATE response');
        if (status === 'business') return Response.json({ code: 123, message: 'PRIVATE' });
        return new Response(null, { status });
      },
    });
    assert.equal(result.cloudSessionCleanup, [204, 404].includes(status) ? 'deleted' : 'failed');
    assert.equal(calls.length, [204, 404, 401].includes(status) ? 1 : 2);
    assert.equal(calls[0].options.method, 'DELETE');
    assert(calls[0].url.endsWith('/chat_sessions/created%2Fid'));
    assert(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('取消、会话响应缺字段、SSE 错误均清理本次任务；清理失败不覆盖推理结果', async () => {
  for (const ending of [
    'cancelled',
    'cancelled-create',
    'missing-message',
    'sse-error',
    'cleanup-failed',
  ]) {
    const controller = new AbortController();
    const calls = [];
    const metadata = {};
    const run = () =>
      remoteChat(account, { messages: [{ role: 'user', content: 'PRIVATE prompt' }] }, 'test', {
        host,
        signal: controller.signal,
        events: sseEvents,
        onMetadata: (m) => Object.assign(metadata, m),
        fetcher: async (url, options) => {
          calls.push({ url, options });
          if (url.includes('/models?'))
            return Response.json({
              data: { list: [{ function: 'solo_agent_remote', models: [{ name: 'test' }] }] },
            });
          if (url.endsWith('/chat_sessions')) {
            assert.notEqual(options.signal, controller.signal);
            if (ending === 'cancelled-create') controller.abort();
            return Response.json({
              data: {
                chat_session_id: 'created',
                ...(ending === 'missing-message' ? {} : { message_id: 'message' }),
              },
            });
          }
          if (url.includes('/events?')) {
            if (ending === 'cancelled') {
              controller.abort();
              throw new Error('cancelled');
            }
            return new Response(
              ending === 'sse-error'
                ? 'event: error\ndata: {"code":1}\n\n'
                : 'event: model_config\ndata: {"config_name":"test"}\n\nevent: plan_item\ndata: {"id":"p","thought":"ok"}\n\nevent: done\ndata: {"status":"completed"}\n\n',
            );
          }
          if (options.method === 'DELETE' && ending === 'cleanup-failed')
            return new Response(null, { status: 500 });
          return Response.json({ code: 0 });
        },
      });
    if (ending === 'cleanup-failed') assert.equal((await run()).status, 200);
    else await assert.rejects(run());
    assert.equal(metadata.upstreamSession, 'created');
    assert.equal(metadata.cloudSessionCleanup, ending === 'cleanup-failed' ? 'failed' : 'deleted');
    const deletes = calls.filter((c) => c.options.method === 'DELETE');
    assert(deletes.length > 0);
    assert(deletes.every((c) => !c.options.signal.aborted));
    if (ending === 'cancelled-create') assert(!calls.some((c) => c.url.includes('/events?')));
    assert(!JSON.stringify(metadata).includes('PRIVATE'));
  }
});

test('重启补清理跳过历史会话和活动请求，记录最终状态且避免重入', async () => {
  const requests = [
    { status: 'success', upstreamSession: 'legacy', accountId: 'a' },
    {
      status: 'pending',
      upstreamSession: 'active',
      accountId: 'a',
      cloudSessionCleanup: 'pending',
    },
    {
      status: 'cancelled',
      upstreamSession: 'owned',
      accountId: 'a',
      cloudSessionCleanup: 'pending',
    },
    { status: 'success', upstreamSession: 'retry', accountId: 'a', cloudSessionCleanup: 'failed' },
  ];
  const calls = [];
  let saved = 0;
  const store = { data: { requests, accounts: [account] }, save: () => saved++ };
  const gateway = new Gateway(store, {
    host,
    upstreamFetch: async (url) => {
      calls.push(url);
      await new Promise((r) => setTimeout(r, 5));
      return new Response(null, { status: 204 });
    },
  });
  await Promise.all([gateway.retryRemoteCleanup(), gateway.retryRemoteCleanup()]);
  assert.equal(calls.length, 2);
  assert(calls[0].endsWith('/owned'));
  assert(calls[1].endsWith('/retry'));
  assert.equal(saved, 2);
  assert.equal(requests[2].cloudSessionCleanup, 'deleted');
  assert.equal(requests[0].cloudSessionCleanup, undefined);
});

test('网关在推理前持久化任务归属，清理后保留真实模型及本地元数据', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'trae-cleanup-')));
  store.data.settings.gatewayPort = 0;
  store.data.accounts = [
    {
      ...account,
      user: { ...account.user, expiredAt: '2030-01-01', account: { username: 'test' } },
    },
  ];
  const gateway = new Gateway(store, {
    remoteTransport: async (_account, _body, _config, { onMetadata }) => {
      onMetadata({
        upstreamSession: 'owned',
        upstreamModel: 'actual',
        cloudSessionCleanup: 'pending',
      });
      const disk = new Store(store.dir);
      assert.equal(disk.data.requests[0].upstreamSession, 'owned');
      assert.equal(disk.data.requests[0].cloudSessionCleanup, 'pending');
      assert.equal(disk.data.requests[0].status, 'cancelled');
      onMetadata({ cloudSessionCleanup: 'deleted', cloudCleanupError: null });
      return new Response(
        'event: output\ndata: {"response":"PRIVATE output"}\n\nevent: done\ndata: {}\n\n',
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    },
  });
  await gateway.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${gateway.server.address().port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + store.data.settings.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'auto',
          messages: [{ role: 'user', content: 'PRIVATE prompt' }],
        }),
      },
    );
    assert.equal(response.status, 200);
    await response.json();
    const record = new Store(store.dir).data.requests[0];
    assert.equal(record.status, 'success');
    assert.equal(record.cloudSessionCleanup, 'deleted');
    assert.equal(record.realModel, 'actual');
    assert.equal(record.modelConfig, 'actual');
    assert(!JSON.stringify(record).includes('PRIVATE'));
  } finally {
    await gateway.stop();
  }
});

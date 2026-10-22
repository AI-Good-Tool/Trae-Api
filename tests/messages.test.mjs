import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { Gateway, sseEvents } from '../server/gateway.mjs';
import { anthropicRequest, parseToolReply } from '../server/anthropic.mjs';
import { remoteChat } from '../server/remote.mjs';
const tool = { name: 'local_echo', input_schema: { type: 'object' } };
test('Messages 转换文本、system、工具调用和结果，拒绝未支持图像及无效工具', () => {
  const body = anthropicRequest({
    model: 'test',
    max_tokens: 32,
    system: [{ type: 'text', text: 'system' }],
    tools: [tool],
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool1', name: 'local_echo', input: { value: 'a' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool1',
            content: [{ type: 'text', text: 'result' }],
          },
        ],
      },
    ],
  });
  assert.equal(body.messages[0].role, 'system');
  const midturn = anthropicRequest({
    max_tokens: 32,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'system', content: [{ type: 'text', text: 'runtime context' }] },
    ],
  });
  assert.equal(midturn.messages[1].role, 'system');
  assert(body.messages[2].content.includes('tool1'));
  assert.throws(() =>
    anthropicRequest({ max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'image' }] }] }),
  );
  assert.throws(() =>
    parseToolReply('<client_tool_call>{"name":"unknown","input":{}}</client_tool_call>', [tool]),
  );
  assert.throws(() => parseToolReply('normal text', [tool], { type: 'any' }));
  assert.equal(
    parseToolReply(
      '<client_tool_call>{"name":"local_echo","input":{"value":"a"}}</client_tool_call>',
      [tool],
    )[0].type,
    'tool_use',
  );
});
test('Messages x-api-key 与流式工具事件、错误和未知接口都记录且不保存正文', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'trae-messages-')));
  store.data.settings.gatewayPort = 0;
  store.data.accounts = [
    {
      id: 'account',
      variant: 'cn',
      user: { expiredAt: '2030-01-01', account: { username: 'test' } },
      models: [{ id: 'test' }],
    },
  ];
  const gateway = new Gateway(store, {
    headers: () => ({}),
    host: () => '',
    upstreamFetch: async () =>
      new Response(
        'event: output\ndata: ' +
          JSON.stringify({
            response: '<client_tool_call>{"name":"local_echo","input":{}}</client_tool_call>',
            usage: { prompt_tokens: 11, completion_tokens: 4 },
          }) +
          '\n\nevent: done\ndata: {}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  await gateway.start();
  const url = 'http://127.0.0.1:' + gateway.server.address().port;
  const headers = { 'x-api-key': store.data.settings.apiKey, 'content-type': 'application/json' };
  try {
    const r = await fetch(url + '/v1/v1/messages?beta=true', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'test',
        stream: true,
        max_tokens: 128,
        tools: [tool],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE-PROMPT' }] }],
      }),
    });
    assert.equal(r.status, 200);
    const events = [];
    for await (const event of sseEvents(r.body)) events.push(event);
    assert.equal(events[0].event, 'message_start');
    assert(events.some((e) => e.data.delta?.stop_reason === 'tool_use'));
    assert.equal(events.at(-1).event, 'message_stop');
    assert.equal(store.data.requests[0].protocol, 'Messages');
    assert.equal(store.data.requests[0].inputTokens, 11);
    const bad = await fetch(url + '/v1/unknown?key=PRIVATE-KEY', {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(bad.status, 404);
    assert.equal(store.data.requests[0].errorCode, 'route_not_found');
    assert.equal(
      (
        await fetch(url + '/v1/messages', {
          method: 'POST',
          headers: { ...headers, 'x-api-key': 'bad' },
          body: '{}',
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(url + '/v1/messages', { method: 'POST', headers, body: '{bad' })).status,
      400,
    );
    assert.equal(
      (await fetch(url + '/v1/messages/count_tokens', { method: 'POST', headers, body: '{}' }))
        .status,
      501,
    );
    assert(!JSON.stringify(store.data.requests).includes('PRIVATE'));
    const persisted = new Store(store.dir);
    assert.equal(persisted.data.requests[0].errorCode, 'token_count_unavailable');
  } finally {
    await gateway.stop();
  }
});
test('Remote 绑定真实模型、终态去重与官方 usage，失败或截断不能记为成功', async () => {
  for (const ending of ['completed', 'missing']) {
    const calls = [];
    const wire = [
      'event: model_config\ndata: {"config_name":"test"}\n\n',
      'event: plan_item\ndata: {"id":"p","thought":"hello"}\n\n',
      'event: plan_item\ndata: {"id":"p","thought":"hello"}\n\n',
      'event: plan_item\ndata: {"id":"p","tool_call_info":{"name":"finish","params":{"summary":"hello"}}}\n\n',
      'event: token_usage\ndata: {"prompt_tokens":12,"completion_tokens":3}\n\n',
      ...(ending === 'completed' ? ['event: done\ndata: {"status":"completed"}\n\n'] : []),
    ].join('');
    const fetcher = async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/models?'))
        return Response.json({
          code: 0,
          data: {
            list: [{ function: 'solo_agent_remote', models: [{ name: 'test', config_source: 1 }] }],
          },
        });
      if (url.endsWith('/chat_sessions'))
        return Response.json({ code: 0, data: { chat_session_id: 's', message_id: 'm' } });
      if (url.includes('/events?')) return new Response(wire);
      return Response.json({ code: 0 });
    };
    const run = () =>
      remoteChat(
        { variant: 'cn', user: { token: 'private' } },
        { messages: [{ role: 'user', content: 'private prompt' }] },
        'test',
        { fetcher, events: sseEvents, host: () => 'https://upstream.invalid' },
      );
    if (ending === 'completed') {
      const r = await run();
      const events = [];
      for await (const e of sseEvents(r.body)) events.push(e);
      assert.equal(events[0].data.response, 'hello');
      assert.equal(events[0].data.usage.prompt_tokens, 12);
    } else {
      await assert.rejects(run(), /truncated_stream/);
      assert(calls.at(-2).url.endsWith('/stop'));
    }
    const request = JSON.parse(calls.find((c) => c.url.endsWith('/chat_sessions')).options.body);
    assert.equal(request.initial_message.custom_model.name, 'test');
    assert.equal(calls.at(-1).options.method, 'DELETE');
    assert(calls.at(-1).url.endsWith('/chat_sessions/s'));
  }
});

import { anthropicRequest, anthropicReply, parseToolReply } from './anthropic.mjs';
import { remoteChat } from './remote.mjs';
import http from 'node:http';
import crypto from 'node:crypto';
import { hostFor, profile } from './client.mjs';
import { gatewayRegion } from './regions.mjs';
import { modelCatalogView, resolveModel, chooseAccount } from './models.mjs';

export function nativeHeaders(a) {
  const p = profile(a.variant);
  return {
    'Content-Type': 'application/json',
    Authorization: `Cloud-IDE-JWT ${a.user.token}`,
    'x-ide-token': a.user.token,
    'x-cloudide-token': a.user.token,
    'x-app-id': p.product.bootConfig.agent.appId,
    'x-uid': String(a.user.userId),
    'x-device-id': a.deviceId || '0',
    'x-machine-id': a.machineId || '',
    'x-ide-version': p.product.appVersion,
    'x-ide-version-code': String(p.product.traeVersionCode),
    'x-ide-version-type': 'stable',
    'x-request-id': crypto.randomUUID(),
    Accept: 'text/event-stream',
  };
}
export async function modelCatalog(a) {
  const response = await fetch(
    hostFor(a, 'agent') +
      '/api/remote/v1/models?functions=solo_agent_remote%2Csolo_work_remote&show_custom_model=true',
    {
      headers: {
        Authorization: 'Cloud-IDE-JWT ' + a.user.token,
        'X-Trae-Client-Type': 'web',
        'x-user-region': a.variant === 'cn' ? 'CN' : 'SG',
      },
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    },
  );
  const result = await response.json();
  if (!response.ok || result.code) throw new Error('官方 Remote 模型目录查询失败');
  if (!Array.isArray(result.data?.list)) throw new Error('官方 Remote 模型目录格式变化');
  const models = new Map();
  for (const group of result.data.list) {
    if (group.function !== 'solo_agent_remote') continue;
    for (const m of group.models || []) {
      if (typeof m.name !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(m.name)) continue;
      models.set(m.name, {
        id: m.name,
        name: m.display_name || m.name,
        model: m.name,
        source: m.config_source || 1,
        catalogSource: 'remote-api',
        remote: true,
        functions: [group.function],
      });
    }
  }
  if (!models.size) throw new Error('当前账号没有可用的 Remote Agent 模型');
  a.models = [...models.values()];
  return a.models;
}
export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求超过 2MB');
    chunks.push(c);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new Error('请求 JSON 格式无效');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('请求必须是 JSON 对象');
  return body;
}
export function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}
export async function* sseEvents(body) {
  let pending = '';
  const decoder = new TextDecoder();
  for await (const b of body) {
    pending = (pending + decoder.decode(b, { stream: true })).replace(/\r\n/g, '\n');
    let i;
    if (pending.length > 2 * 1024 * 1024) throw new Error('上游 SSE 事件过大');
    while ((i = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, i);
      pending = pending.slice(i + 2);
      const data = block
        .split('\n')
        .filter((x) => x.startsWith('data:'))
        .map((x) => x.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      if (data === '[DONE]') {
        yield { event: 'done', data: {} };
        continue;
      }
      let value;
      try {
        value = JSON.parse(data);
      } catch {
        throw new Error('上游 SSE 返回无效 JSON');
      }
      yield {
        event:
          block
            .split('\n')
            .find((x) => x.startsWith('event:'))
            ?.slice(6)
            .trim() || 'message',
        data: value,
      };
    }
  }
}
export function nativeBody(body) {
  if (!body || typeof body !== 'object') throw new Error('请求必须是 JSON 对象');
  if (
    body.model !== undefined &&
    (typeof body.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(body.model))
  )
    throw new Error('模型名称无效');
  if (body.stream !== undefined && typeof body.stream !== 'boolean')
    throw new Error('stream 必须是布尔值');
  if (
    body.max_tokens !== undefined &&
    (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 128000)
  )
    throw new Error('max_tokens 须为 1–128000 的整数');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new Error('messages 不能为空');
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length))
    throw new Error('当前反代仅验证文本对话，暂不支持工具调用');
  if (body.messages.some((m) => !m || typeof m !== 'object'))
    throw new Error('messages 中包含无效消息');
  if (body.messages.some((m) => !['system', 'developer', 'user', 'assistant'].includes(m.role)))
    throw new Error('当前只支持文本对话角色');
  if (body.messages.some((m) => typeof m.content !== 'string'))
    throw new Error('当前只支持纯文本 content');
  return {
    function: 'chat_v3',
    ...(body.model && body.model !== 'auto' ? { model: body.model } : {}),
    stream: true,
    messages: body.messages.map((m) => ({
      role: m.role === 'developer' ? 'system' : m.role,
      content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
    })),
    ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
  };
}
export class Gateway {
  constructor(
    store,
    {
      upstreamFetch = fetch,
      headers = nativeHeaders,
      host = hostFor,
      remoteTransport = upstreamFetch === fetch ? remoteChat : null,
    } = {},
  ) {
    this.store = store;
    this.server = null;
    this.cursor = { cn: 0, intl: 0 };
    this.active = new Map();
    this.upstreamFetch = upstreamFetch;
    this.remoteTransport = remoteTransport;
    this.headers = headers;
    this.host = host;
    this.starting = null;
  }

  async start() {
    if (this.starting) return this.starting;
    if (this.server?.listening) return;
    const server = http.createServer((req, res) =>
      this.handle(req, res).catch(() => {
        if (!res.headersSent)
          json(res, 500, { error: { message: '网关内部错误', type: 'internal_error' } });
        else res.end();
      }),
    );
    this.server = server;
    this.starting = new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.store.data.settings.gatewayPort, '127.0.0.1', resolve);
    });
    try {
      await this.starting;
    } catch (error) {
      this.server = null;
      throw error;
    } finally {
      this.starting = null;
    }
  }

  async stop() {
    if (this.starting)
      try {
        await this.starting;
      } catch {}
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    this.server = null;
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname.match(
      /^\/(?:(cn|intl)\/)?v1\/(?:v1\/)?(models|chat\/completions|messages|messages\/count_tokens)$/,
    );
    const region = gatewayRegion(this.store.data.settings, route?.[1]);
    const isMessages = route?.[2] === 'messages' || route?.[2] === 'messages/count_tokens';
    const isCount = route?.[2] === 'messages/count_tokens';
    const isChat = ['chat/completions', 'messages'].includes(route?.[2]) && req.method === 'POST';
    const started = Date.now();
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const record = !(route?.[2] === 'models' && req.method === 'GET')
      ? {
          id,
          time: new Date().toISOString(),
          method: req.method,
          path: url.pathname.slice(0, 256),
          variant: region,
          accountId: null,
          accountName: null,
          protocol: isMessages ? 'Messages' : 'HTTP',
          stream: false,
          model: null,
          status: 'pending',
          inputTokens: null,
          outputTokens: null,
          httpStatus: null,
          upstreamStatus: null,
        }
      : null;
    if (record) {
      this.store.data.requests.unshift(record);
      this.store.data.requests = this.store.data.requests.slice(0, 1000);
      this.store.save();
    }
    res.setHeader('X-Request-ID', id);
    const fail = (status, message, code) => {
      if (record)
        Object.assign(record, {
          status: 'error',
          error: message,
          errorCode: code,
          httpStatus: status,
        });
      json(res, status, {
        ...(isMessages ? { type: 'error', request_id: id } : {}),
        error: { message, type: status < 500 ? 'invalid_request_error' : 'api_error', code },
      });
    };
    let controller, timer, reservedAccount;
    try {
      const expected = Buffer.from(`Bearer ${this.store.data.settings.apiKey}`),
        actual = Buffer.from(
          req.headers.authorization ||
            (req.headers['x-api-key'] ? 'Bearer ' + req.headers['x-api-key'] : ''),
        );
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))
        return fail(401, 'API Key 无效', 'unauthorized');
      if (!route)
        return fail(
          404,
          '接口不存在：支持 /v1/messages、/v1/chat/completions 和 /v1/models',
          'route_not_found',
        );
      if (isCount)
        return fail(
          501,
          '上游没有可靠的 Token 计数接口，请关闭客户端预估计数',
          'token_count_unavailable',
        );
      if (route[2] === 'models' && req.method === 'GET')
        return json(res, 200, {
          object: 'list',
          data: [
            'auto',
            ...modelCatalogView(this.store.data)
              .filter((m) => resolveModel(this.store.data, region, m.alias).pool.length)
              .map((m) => m.alias),
          ].map((model) => ({
            id: model,
            object: 'model',
            owned_by: region === 'all' ? 'trae' : region === 'cn' ? 'trae-cn' : 'trae-intl',
          })),
        });
      if (!isChat) return fail(405, '请求方法不支持', 'method_not_allowed');
      let body, payload;
      try {
        body = await readBody(req);
        if (record) {
          record.model = typeof body.model === 'string' ? body.model.slice(0, 128) : null;
          record.stream = body.stream === true;
        }
        if (isMessages) body = anthropicRequest(body);
        payload = nativeBody(body);
      } catch (error) {
        const allowed = [
          '请求超过 2MB',
          '请求 JSON 格式无效',
          '模型名称无效',
          'stream 必须是布尔值',
          'max_tokens 须为 1–128000 的整数',
          'messages 不能为空',
          '当前反代仅验证文本对话，暂不支持工具调用',
          'messages 中包含无效消息',
          '当前只支持文本对话角色',
          '当前只支持纯文本 content',
          '消息内容无效',
          'messages 无效',
          'max_tokens 无效',
          '工具定义无效',
          'tool_choice 无效',
          '指定工具不存在',
          '当前 Messages 接口只支持文本及客户端工具块',
        ];
        const detail = allowed.includes(error.message)
          ? error.message
          : '请使用有效的模型名称、文本 messages 和布尔 stream';
        return fail(400, '请求参数无效：' + detail, 'invalid_request');
      }
      record.protocol = isMessages ? 'Messages' : 'Chat Completions';
      record.model = body.model || 'auto';
      record.stream = !!body.stream;
      const eligible = resolveModel(this.store.data, region, 'auto').pool;
      if (!eligible.length)
        return fail(503, '当前地区没有可用账号，请添加账号或刷新凭证', 'no_account');
      const { pool, row } = resolveModel(this.store.data, region, record.model);
      if (!pool.length)
        return fail(
          400,
          '所选地区或账号不提供此模型，请查询当前地区 /v1/models',
          'model_not_available',
        );
      const mode = this.store.data.settings.gatewayMode || 'round-robin';
      const available = pool.filter(
        (a) => (this.active.get(a.id) || 0) < (a.concurrencyLimit || 4),
      );
      if (!available.length) {
        res.setHeader('Retry-After', '1');
        return fail(429, '可用账号并发已满，请稍后重试', 'account_busy');
      }
      const account = chooseAccount(
        available,
        mode,
        this.cursor,
        region + ':' + (row?.id || 'auto'),
      );
      reservedAccount = account.id;
      this.active.set(account.id, (this.active.get(account.id) || 0) + 1);
      const config = row && account.models.find((m) => (m.model || m.id) === row.id);
      record.requestedModel = record.model;
      record.model = row?.alias || 'auto';
      record.realModel = row?.id || 'auto';
      record.modelConfig = config?.id || 'auto';
      record.routingScope = region;
      record.accountMode = mode;
      record.variant = account.variant;
      if (config) payload.model = config.id;
      record.accountId = account.id;
      record.accountName = account.note || account.user.account.username || '未命名账号';
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 90000);
      res.on('close', () => controller.abort());
      const response = this.remoteTransport
        ? await this.remoteTransport(account, body, config?.id || 'auto', {
            signal: controller.signal,
            events: sseEvents,
            onMetadata: (metadata) =>
              Object.assign(
                record,
                metadata,
                { transport: 'Remote' },
                config
                  ? {}
                  : { realModel: metadata.upstreamModel, modelConfig: metadata.upstreamModel },
              ),
          })
        : await this.upstreamFetch(this.host(account, 'agent') + '/api/agent/v3/llm_utils_chat', {
            method: 'POST',
            headers: this.headers(account),
            body: JSON.stringify(payload),
            signal: controller.signal,
            redirect: 'error',
          });
      record.upstreamStatus = response.status;
      if (!response.ok) return fail(502, `上游 HTTP ${response.status}`, 'upstream_http_error');
      if (!response.headers.get('content-type')?.includes('text/event-stream'))
        return fail(502, '上游未返回预期的 SSE 流', 'upstream_protocol_error');
      let text = '',
        gotOutput = false,
        done = false;
      const created = Math.floor(started / 1000);
      const emit = (delta, finish = null) => {
        if (!res.headersSent)
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: record.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      };
      for await (const { event, data } of sseEvents(response.body)) {
        if (!data || typeof data !== 'object') throw new Error('upstream_protocol_error');
        if (event === 'error' || data.code) {
          record.errorCode = Number.isSafeInteger(data.code) ? String(data.code) : 'upstream_error';
          throw new Error('upstream_business_error');
        }
        if (event === 'done' || data.choices?.[0]?.finish_reason) done = true;
        const delta =
          data.choices?.[0]?.delta?.content ??
          data.delta?.content ??
          (typeof data.delta === 'string' ? data.delta : undefined) ??
          data.response ??
          data.content ??
          data.text;
        if (typeof delta === 'string' && delta) {
          gotOutput = true;
          text += delta;
          if (text.length > 1024 * 1024) throw new Error('output_limit');
          if (text.length > 2048 && !text.slice(-2048).trim()) throw new Error('blank_output');
          if (body.stream && !isMessages) emit({ content: delta });
        }
        const usage = data.usage;
        if (usage) {
          const input = usage.prompt_tokens ?? usage.input_tokens,
            output = usage.completion_tokens ?? usage.output_tokens;
          if (Number.isSafeInteger(input) && input >= 0) record.inputTokens = input;
          if (Number.isSafeInteger(output) && output >= 0) record.outputTokens = output;
        }
      }
      if (!gotOutput) throw new Error('empty_output');
      if (!done) throw new Error('truncated_stream');
      if (isMessages) {
        const content = parseToolReply(text, body.clientTools || [], body.clientToolChoice);
        anthropicReply(res, record, content, body.stream);
      } else if (body.stream) {
        emit({}, 'stop');
        res.end('data: [DONE]\n\n');
      } else
        json(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model: record.model,
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          ...(record.inputTokens !== null && record.outputTokens !== null
            ? {
                usage: {
                  prompt_tokens: record.inputTokens,
                  completion_tokens: record.outputTokens,
                  total_tokens: record.inputTokens + record.outputTokens,
                },
              }
            : {}),
        });
      record.status = 'success';
    } catch (error) {
      const messages = {
        upstream_business_error: '上游拒绝请求',
        remote_model_unavailable:
          '当前账号的官方 Remote 模型目录不提供此模型，请刷新目录并选择当前可用名称',
        invalid_tool_output: '上游返回的客户端工具调用格式无效',
        remote_tool_execution: '上游尝试执行内置工具，已停止该请求',
        upstream_model_mismatch: '上游实际模型与请求模型不一致，已停止该请求',
        upstream_http_error: '上游 HTTP 请求失败',
        upstream_protocol_error: '上游协议格式异常',
        output_limit: '上游输出超过 1MB',
        blank_output: '上游连续返回空白',
        empty_output: '上游未返回文本',
        truncated_stream: '上游流意外中断',
      };
      const aborted = controller?.signal.aborted;
      const message = aborted ? '请求已取消或超时' : messages[error.message] || '上游请求失败';
      const code =
        record?.errorCode ||
        (aborted ? 'request_aborted' : messages[error.message] ? error.message : 'upstream_error');
      if (record)
        Object.assign(record, {
          status: aborted ? 'cancelled' : 'error',
          error: message,
          errorCode: code,
        });
      if (!res.destroyed) {
        if (!res.headersSent)
          json(res, 502, {
            ...(isMessages ? { type: 'error', request_id: id } : {}),
            error: { message: `${message} (${code})`, type: 'api_error', code },
          });
        else {
          res.write(`data: ${JSON.stringify({ error: { message, code } })}\n\n`);
          res.end();
        }
      }
    } finally {
      clearTimeout(timer);
      controller?.abort();
      if (reservedAccount) {
        const n = (this.active.get(reservedAccount) || 1) - 1;
        if (n) this.active.set(reservedAccount, n);
        else this.active.delete(reservedAccount);
      }
      if (record) {
        record.duration = Date.now() - started;
        record.httpStatus = res.headersSent ? res.statusCode : record.httpStatus;
        if (record.status === 'pending') record.status = 'error';
        this.store.save();
      }
    }
  }
}

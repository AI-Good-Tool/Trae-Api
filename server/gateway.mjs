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
  const r = await fetch(hostFor(a, 'agent') + '/api/ide/v1/get_detail_param', {
    method: 'POST',
    headers: nativeHeaders(a),
    body: JSON.stringify({ function: 'chat_v3', need_prompt: false, poly_prompt: true }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!r.ok || j.code) throw new Error(`模型目录请求失败：${r.status}/${j.code || ''}`);
  const models = (j.config_info_list || []).map((c) => ({
    id: c.config_name,
    name: c.display_config?.display_name || c.config_name,
    model: c.model_detail_list?.[0]?.model_name || c.config_name,
    source: c.config_source || 1,
    catalogSource: 'native-api',
  }));
  a.models = [...(a.models || []).filter((m) => !models.some((x) => x.id === m.id)), ...models];
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
  constructor(store, { upstreamFetch = fetch, headers = nativeHeaders, host = hostFor } = {}) {
    this.store = store;
    this.server = null;
    this.cursor = { cn: 0, intl: 0 };
    this.upstreamFetch = upstreamFetch;
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
    const route = url.pathname.match(/^\/(?:(cn|intl)\/)?v1\/(models|chat\/completions)$/);
    if (!route)
      return json(res, 404, { error: { message: '支持 /cn/v1、/intl/v1 和默认 /v1 接口' } });
    const region = gatewayRegion(this.store.data.settings, route[1]);
    const isChat = route[2] === 'chat/completions' && req.method === 'POST';
    const started = Date.now();
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const record = isChat
      ? {
          id,
          time: new Date().toISOString(),
          method: req.method,
          path: url.pathname,
          variant: region,
          accountId: null,
          accountName: null,
          protocol: 'Chat Completions',
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
        error: { message, type: status < 500 ? 'invalid_request_error' : 'upstream_error', code },
      });
    };
    let controller, timer;
    try {
      const expected = Buffer.from(`Bearer ${this.store.data.settings.apiKey}`),
        actual = Buffer.from(req.headers.authorization || '');
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))
        return fail(401, 'API Key 无效', 'unauthorized');
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
      if (!isChat) return json(res, 405, { error: { message: '请求方法不支持' } });
      let body, payload;
      try {
        body = await readBody(req);
        payload = nativeBody(body);
      } catch {
        return fail(
          400,
          '请求参数无效：请使用有效的模型名称、文本 messages 和布尔 stream',
          'invalid_request',
        );
      }
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
      const account = chooseAccount(pool, mode, this.cursor, region + ':' + (row?.id || 'auto'));
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
      const response = await this.upstreamFetch(
        this.host(account, 'agent') + '/api/agent/v3/llm_utils_chat',
        {
          method: 'POST',
          headers: this.headers(account),
          body: JSON.stringify(payload),
          signal: controller.signal,
          redirect: 'error',
        },
      );
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
          if (body.stream) emit({ content: delta });
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
      if (body.stream) {
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
            error: { message: `${message} (${code})`, type: 'upstream_error', code },
          });
        else {
          res.write(`data: ${JSON.stringify({ error: { message, code } })}\n\n`);
          res.end();
        }
      }
    } finally {
      clearTimeout(timer);
      controller?.abort();
      if (record) {
        record.duration = Date.now() - started;
        record.httpStatus = res.headersSent ? res.statusCode : record.httpStatus;
        if (record.status === 'pending') record.status = 'error';
        this.store.save();
      }
    }
  }
}

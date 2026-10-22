import { anthropicRequest, anthropicReply, parseToolReply } from './anthropic.mjs';
import { remoteChat } from './remote.mjs';
import { cleanupRemoteSession } from './remote-cleanup.mjs';
import { localChat } from './local.mjs';
import { LocalRuntimes } from './local-runtime.mjs';
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
      '/api/remote/v1/models?functions=solo_agent_remote%2Csolo_agent_lite&show_custom_model=true',
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
    if (!['solo_agent_remote', 'solo_agent_lite'].includes(group.function)) continue;
    for (const m of group.models || []) {
      if (typeof m.name !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(m.name)) continue;
      const previous = models.get(m.name);
      models.set(m.name, {
        id: m.name,
        name: m.display_name || m.name,
        model: m.name,
        source: m.config_source || 1,
        catalogSource: 'remote-api',
        remote: true,
        functions: [...new Set([...(previous?.functions || []), group.function])],
      });
    }
  }
  if (!models.size) throw new Error('当前账号没有可用的 Remote Agent 模型');
  a.models = [...models.values()];
  a.modelCatalogVersion = 2;
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
      localTransport = localChat,
      localRuntimes = new LocalRuntimes(store.dir),
      catalogFetcher = modelCatalog,
    } = {},
  ) {
    this.store = store;
    this.server = null;
    this.cursor = { cn: 0, intl: 0 };
    this.active = new Map();
    this.upstreamFetch = upstreamFetch;
    this.remoteTransport = remoteTransport;
    this.localTransport = localTransport;
    this.localRuntimes = localRuntimes;
    this.catalogFetcher = catalogFetcher;
    this.catalogRefreshes = new Map();
    this.headers = headers;
    this.host = host;
    this.starting = null;
  }

  async ensureModelCatalogs(
    settings = this.store.data.settings,
    scope = settings.gatewayVariant || 'all',
  ) {
    if (settings.gatewayCloudMode !== false) return;
    const accounts = this.store.data.accounts.filter((a) => {
      const pin = settings.gatewayAccountIds?.[scope === 'all' ? 'all' : a.variant];
      return (
        (scope === 'all' || a.variant === scope) &&
        (!pin || pin === a.id) &&
        a.enabled !== false &&
        Date.parse(a.user.expiredAt) > Date.now() &&
        a.modelCatalogVersion !== 2 &&
        a.models?.some((m) => m.catalogSource === 'remote-api')
      );
    });
    const results = await Promise.allSettled(
      accounts.map(async (a) => {
        let pending = this.catalogRefreshes.get(a.id);
        if (!pending) {
          // Refresh a copy so failures never replace a usable catalog with partial data.
          pending = this.catalogFetcher({ ...a }).finally(() => this.catalogRefreshes.delete(a.id));
          this.catalogRefreshes.set(a.id, pending);
        }
        return await pending;
      }),
    );
    if (results.some((r) => r.status === 'rejected'))
      throw new Error('local_catalog_refresh_failed');
    if (!accounts.length) return;
    const previous = accounts.map((a) => ({
      models: a.models,
      modelCatalogVersion: a.modelCatalogVersion,
    }));
    try {
      accounts.forEach((a, i) => {
        if (!this.store.data.accounts.includes(a)) return;
        a.models = results[i].value;
        a.modelCatalogVersion = 2;
      });
      this.store.save();
    } catch (error) {
      accounts.forEach((a, i) => Object.assign(a, previous[i]));
      throw error;
    }
  }

  async retryRemoteCleanup() {
    if (this.cleanupBusy) return;
    this.cleanupBusy = true;
    try {
      // Legacy cloud sessions have no cleanup marker and must never be touched.
      const records = this.store.data.requests.filter(
        (r) =>
          r.status !== 'pending' &&
          r.upstreamSession &&
          ['pending', 'failed'].includes(r.cloudSessionCleanup),
      );
      for (const record of records) {
        const account = this.store.data.accounts.find((a) => a.id === record.accountId);
        if (!account) continue;
        const result = await cleanupRemoteSession(account, record.upstreamSession, {
          fetcher: this.upstreamFetch,
          host: this.host,
        });
        Object.assign(record, result, { cloudCleanupAt: new Date().toISOString() });
        this.store.save();
      }
    } finally {
      this.cleanupBusy = false;
    }
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
    if (!server) {
      await this.localRuntimes.close();
      return;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    this.server = null;
    await this.localRuntimes.close();
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
    let controller, timer, heartbeat, reservedAccount;
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
      if (route[2] === 'models' && req.method === 'GET') {
        await this.ensureModelCatalogs(this.store.data.settings, region);
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
      }
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
      const isLocal = this.store.data.settings.gatewayCloudMode === false;
      record.transport = isLocal ? 'Local' : 'Remote';
      controller = new AbortController();
      timer = setTimeout(
        () => controller.abort(new Error('request_timeout')),
        isLocal ? 600000 : 90000,
      );
      res.on('close', () => controller.abort());
      await this.ensureModelCatalogs(this.store.data.settings, region);
      controller.signal.throwIfAborted();
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
      record.transport = isLocal ? 'Local' : 'Remote';
      const transport = isLocal ? this.localTransport : this.remoteTransport;
      if (isLocal && !transport) throw new Error('local_ipc_unavailable');
      if (isLocal && body.stream)
        heartbeat = setInterval(() => {
          if (res.destroyed || res.writableEnded) return;
          if (!res.headersSent)
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
          res.write(isMessages ? 'event: ping\ndata: {"type":"ping"}\n\n' : ': ping\n\n');
        }, 10000);
      const response = transport
        ? await transport(account, body, config?.id || 'auto', {
            runtimes: this.localRuntimes,
            fetcher: this.upstreamFetch,
            host: this.host,
            signal: controller.signal,
            events: sseEvents,
            onMetadata: (metadata) => {
              Object.assign(
                record,
                metadata,
                { transport: isLocal ? 'Local' : 'Remote' },
                config
                  ? {}
                  : metadata.upstreamModel
                    ? { realModel: metadata.upstreamModel, modelConfig: metadata.upstreamModel }
                    : {},
              );
              // Persist ownership before consuming SSE so restart recovery only deletes our tasks.
              this.store.save();
            },
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
        local_catalog_refresh_failed:
          '本地模型目录刷新失败，请检查网络或账号凭证后重试；未回退云端',
        local_client_missing: '本地模式需要安装对应地区的 Trae 客户端',
        local_ipc_unavailable: '当前 Trae 客户端不支持本地 IPC 通道',
        local_runtime_closed: 'Trae 本地运行实例已退出，请重试',
        local_runtime_timeout: 'Trae 本地运行实例启动或响应超时',
        local_request_timeout: 'Trae 本地请求超时',
        local_bridge_error: 'Trae 本地桥接调用失败，请确认客户端版本受支持',
        local_debugger_error: 'Trae 本地私有管道调用失败',
        local_rpc_error: 'Trae 本地服务拒绝请求',
        local_database_busy: 'Trae 本地会话数据库正忙，请稍后重试',
        local_business_error: 'Trae 本地会话创建失败',
        local_model_unavailable: '当前账号的本地 Agent 不支持此模型，请刷新模型目录',
        local_protocol_error: 'Trae 本地会话协议异常',
        local_stream_error: 'Trae 本地回复流异常',
        local_stream_lost: 'Trae 本地窗口重新初始化，回复通道已丢失，请重试本次请求',
        local_stream_idle: 'Trae 本地通道连续两分钟没有收到事件，已停止等待，请重试',
        local_session_stopped: 'Trae 本地任务已取消或失败，已停止等待，请重试',
        local_tool_execution: '本地 Agent 请求执行内置工具，已停止；反代工具由调用客户端执行',
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
      const timedOut = controller?.signal.reason?.message === 'request_timeout';
      const message = timedOut
        ? '请求超过最长处理时间'
        : aborted
          ? '请求已取消'
          : messages[error.message] || '上游请求失败';
      const code =
        record?.errorCode ||
        (timedOut
          ? 'request_timeout'
          : aborted
            ? 'request_aborted'
            : messages[error.message]
              ? error.message
              : 'upstream_error');
      if (record)
        Object.assign(record, {
          status: aborted && !timedOut ? 'cancelled' : 'error',
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
          res.write(
            isMessages
              ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `${message} (${code})` } })}\n\n`
              : `data: ${JSON.stringify({ error: { message, code } })}\n\n`,
          );
          res.end();
        }
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
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

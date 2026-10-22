import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostFor } from './client.mjs';
import { toolPrompt } from './anthropic.mjs';

export function localPacket(account, method, data, sessionId, workspace) {
  return {
    packet_type: 'request',
    channel_id: crypto.randomUUID(),
    session_id: sessionId,
    params: {
      service: 'lite',
      method,
      data,
      user_info: {
        name: account.user.account.username || '',
        token: account.user.token,
        user_id: account.user.userId,
        scope: account.user.account.scope,
        region: account.variant === 'cn' ? 'CN' : account.region || 'SG',
        is_internal: false,
      },
      common_params: {
        language: 'zh-cn',
        app_language: 'zh-CN',
        scope: account.variant === 'cn' ? 'marscode-cn' : 'marscode',
        tenant: 'marscode',
        region: account.variant === 'cn' ? 'cn' : 'sg',
        agent_type: data.initial_message?.agent_type || '',
      },
      streamlined_common_params: {},
      client_info: {
        connect_session_id: sessionId,
        device_id: account.deviceId,
        icube_language: 'zh-CN',
        is_solo_mode: true,
        client_type: 'ide',
        window_type: 'solo',
        workspace_folder: workspace,
        workspace_folders: [workspace],
        git_repos: [],
        local_git_repos: [],
        git_metadata_dirs: [],
        security_rules: [],
        permission_profile_id: 'manual_approval',
        user_timezone: 'Asia/Shanghai',
      },
    },
  };
}

export function localResult(reply) {
  const transport = reply?.params;
  if (!transport || transport.code !== 0)
    throw new Error(
      transport?.code === 600 && transport.message?.includes('database is locked')
        ? 'local_database_busy'
        : 'local_rpc_error',
    );
  const result = transport.data;
  if (!result || result.code !== 0) throw new Error('local_business_error');
  return result.data;
}

export async function localChat(
  account,
  body,
  config,
  { runtimes, fetcher = fetch, host = hostFor, signal, onMetadata = () => {} } = {},
) {
  signal?.throwIfAborted();
  onMetadata({ localStage: 'loading_models' });
  const response = await fetcher(
    host(account, 'agent') +
      '/api/remote/v1/models?functions=solo_agent_lite&show_custom_model=true',
    {
      headers: {
        Authorization: 'Cloud-IDE-JWT ' + account.user.token,
        'X-Trae-Client-Type': 'web',
        'x-user-region': account.variant === 'cn' ? 'CN' : account.region || 'SG',
      },
      signal,
      redirect: 'error',
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('local_model_unavailable');
  }
  const catalog = await response.json();
  if (catalog.code !== 0) throw new Error('local_model_unavailable');
  const group = catalog.data?.list?.find((g) => g.function === 'solo_agent_lite');
  const model =
    config === 'auto'
      ? group?.models?.find((m) => m.is_default) || group?.models?.[0]
      : group?.models?.find((m) => m.name === config);
  if (!model) throw new Error('local_model_unavailable');
  onMetadata({ localStage: 'starting_runtime' });
  const runtime = await runtimes.acquire(account);
  const connectId = 'trae-switch-' + crypto.randomUUID();
  const packet = (method, data) => localPacket(account, method, data, connectId, runtime.workspace);
  const request = async (method, data) =>
    localResult(await runtime.invoke('request', packet(method, data)));
  let session;
  let streamId;
  let finished = false;
  try {
    signal?.throwIfAborted();
    const context =
      body.messages.map((m) => '[' + m.role + ']\n' + m.content).join('\n\n') +
      toolPrompt(body.clientTools || [], body.clientToolChoice);
    session = await request('create_chat_session', {
      mode: 'code',
      auto_create_project: false,
      output_storage_path: runtime.workspace,
      origin: 'web',
      initial_message: {
        chat_session_id: '',
        message_id: crypto.randomUUID(),
        content: [],
        query: JSON.stringify([{ type: 'text', data: { content: context } }]),
        model_name: model.name,
        custom_model: {
          provider: model.provider || '',
          is_preset: model.is_preset !== false,
          config_name: model.name,
          config_source: model.config_source || 1,
          model_name: model.name,
          display_model_name: model.display_name || model.name,
          use_remote_service: true,
          multimodal: !!model.multimodal,
        },
        model_config_source: model.config_source || 1,
        model_is_preset: model.is_preset !== false,
        agent_type: 'solo_agent_lite',
        agent_id: 'solo_agent_lite',
        model_selection_strategy: 'manual',
        common_params: JSON.stringify({
          ...packet('', {}).params.common_params,
          quality: 'stable',
          solo_chat_mode: 'code',
          biz_session_id: connectId,
        }),
      },
    });
    if (typeof session?.chat_session_id !== 'string') throw new Error('local_protocol_error');
    onMetadata({
      upstreamSession: session.chat_session_id,
      upstreamModel: model.name,
      transport: 'Local',
      cloudSessionCleanup: 'not_applicable',
      localSession: true,
      localStage: 'waiting_model',
    });
    if (!session.message_id) throw new Error('local_protocol_error');
    signal?.throwIfAborted();
    const stream = await runtime.invoke(
      'request_stream',
      packet('subscribe_events', {
        chat_session_id: session.chat_session_id,
        reply_to_message_id: session.message_id,
      }),
    );
    streamId = stream?.streamId;
    if (typeof streamId !== 'string' || !streamId) throw new Error('local_protocol_error');
    const plans = new Map();
    let summary = '',
      usage,
      confirmed = false;
    let stage = 'waiting_model';
    let lastEventAt = Date.now(),
      lastPublishedAt = 0;
    while (!finished) {
      signal?.throwIfAborted();
      const batch = await runtime.invoke('poll', { streamId, sessionId: connectId });
      if (batch.error) {
        const error = new Error(batch.error);
        error.localCommand = batch.blockedCommand;
        throw error;
      }
      for (const item of batch.items) {
        if (!item || item.code !== 0 || item.data?.code !== 0)
          throw new Error('local_stream_error');
        const { event, payload: data } = item.data.data || {};
        if (event === 'error' || !data || typeof data !== 'object')
          throw new Error('local_stream_error');
        lastEventAt = Date.now();
        if (['canceled', 'cancelled', 'failed', 'error'].includes(data.status))
          throw new Error('local_session_stopped');
        if (event === 'model_config') {
          if (data.config_name !== model.name) throw new Error('upstream_model_mismatch');
          confirmed = true;
        }
        if (event === 'plan_item') {
          stage = 'generating';
          const tool = data.tool_call_info;
          if (tool?.name === 'finish' && typeof tool.params?.summary === 'string')
            summary = tool.params.summary;
          else if (tool?.name) throw new Error('local_tool_execution');
          if (data.id && typeof data.thought === 'string' && data.thought)
            plans.set(data.id, data.thought);
        }
        if (
          event === 'token_usage' &&
          Number.isSafeInteger(data.prompt_tokens) &&
          Number.isSafeInteger(data.completion_tokens) &&
          data.prompt_tokens >= 0 &&
          data.completion_tokens >= 0
        )
          usage = { prompt_tokens: data.prompt_tokens, completion_tokens: data.completion_tokens };
        if (lastEventAt - lastPublishedAt >= 1000 || event === 'token_usage' || event === 'done') {
          lastPublishedAt = lastEventAt;
          onMetadata({
            localStage: event === 'done' ? 'completed' : stage,
            lastUpstreamEvent: String(event).slice(0, 64),
            lastProgressAt: new Date(lastEventAt).toISOString(),
            ...(usage
              ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
              : {}),
          });
        }
        if (event === 'done') {
          if (data.status !== 'completed') throw new Error('truncated_stream');
          finished = true;
          break;
        }
      }
      if (batch.done && !finished) throw new Error('truncated_stream');
      if (Date.now() - lastEventAt >= 120000) throw new Error('local_stream_idle');
      if (!finished) await delay(100, undefined, { signal });
    }
    const text = summary || [...plans.values()].join('\n');
    if (!confirmed) throw new Error('local_protocol_error');
    if (!text) throw new Error('empty_output');
    if (text.length > 1024 * 1024) throw new Error('output_limit');
    return new Response(
      'event: output\ndata: ' +
        JSON.stringify({ response: text, ...(usage ? { usage } : {}) }) +
        '\n\nevent: done\ndata: {}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  } finally {
    if (session?.chat_session_id && !finished) {
      try {
        await request('stop_chat_session', {
          chat_session_id: session.chat_session_id,
          user_message_id: session.message_id,
        });
      } catch {}
    }
    if (streamId) {
      try {
        await runtime.invoke('cancel', { streamId, sessionId: connectId });
      } catch {}
    }
    runtime.release();
  }
}

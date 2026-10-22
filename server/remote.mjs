import crypto from 'node:crypto';
import { hostFor } from './client.mjs';
import { toolPrompt } from './anthropic.mjs';
export async function remoteChat(
  account,
  body,
  config,
  { fetcher = fetch, signal, events, host = hostFor, onMetadata = () => {} } = {},
) {
  const base = host(account, 'agent') + '/api/remote/v1';
  const headers = {
    Authorization: 'Cloud-IDE-JWT ' + account.user.token,
    'Content-Type': 'application/json',
    'X-Trae-Client-Type': 'web',
    'x-user-region': account.variant === 'cn' ? 'CN' : account.region || 'SG',
  };
  const checked = async (response) => {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_http_error');
    }
    const data = await response.json();
    if (data.code && data.code !== 0) throw new Error('upstream_business_error');
    return data.data || data;
  };
  const catalog = await checked(
    await fetcher(
      base + '/models?functions=solo_agent_remote%2Csolo_work_remote&show_custom_model=true',
      { headers, signal },
    ),
  );
  const group = (catalog.list || []).find(
    (g) =>
      g.function === 'solo_agent_remote' &&
      g.models?.some((m) => config === 'auto' || m.name === config),
  );
  const model =
    config === 'auto'
      ? group?.models.find((m) => m.is_default) || group?.models[0]
      : group?.models.find((m) => m.name === config);
  if (!model) throw new Error('remote_model_unavailable');
  const context =
    body.messages.map((m) => '[' + m.role + ']\n' + m.content).join('\n\n') +
    toolPrompt(body.clientTools || [], body.clientToolChoice);
  const sid = crypto.randomUUID(),
    agent = group.function;
  const session = await checked(
    await fetcher(base + '/chat_sessions', {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        mode: 'code',
        environment_id: 'default',
        env: 'remote',
        auto_create_project: false,
        origin: 'web',
        initial_message: {
          chat_session_id: '',
          content: [],
          query: JSON.stringify([{ type: 'text', data: { content: context } }]),
          model_name: model.name,
          custom_model: model,
          model_config_source: model.config_source || 1,
          model_is_preset: model.is_preset !== false,
          agent_type: agent,
          agent_id: agent,
          model_selection_strategy: 'manual',
          common_params: JSON.stringify({
            language: 'zh-cn',
            app_language: 'zh-CN',
            quality: 'stable',
            scope: account.variant === 'cn' ? 'marscode-cn' : 'marscode',
            tenant: 'marscode',
            region: account.variant === 'cn' ? 'cn' : 'sg',
            solo_chat_mode: 'code',
            biz_session_id: sid,
          }),
        },
      }),
    }),
  );
  if (!session.chat_session_id || !session.message_id) throw new Error('upstream_protocol_error');
  onMetadata({ upstreamSession: session.chat_session_id, upstreamModel: model.name });
  const url =
    base +
    '/chat_sessions/' +
    encodeURIComponent(session.chat_session_id) +
    '/events?reply_to_message_id=' +
    encodeURIComponent(session.message_id);
  let finished = false;
  const stop = async () => {
    try {
      await fetcher(
        base + '/chat_sessions/' + encodeURIComponent(session.chat_session_id) + '/stop',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            chat_session_id: session.chat_session_id,
            user_message_id: session.message_id,
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {}
  };
  try {
    const response = await fetcher(url, { headers, signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_http_error');
    }
    let summary = '',
      usage = null,
      confirmed = false;
    const plans = new Map();
    for await (const { event, data } of events(response.body)) {
      if (event === 'error' || data.code) throw new Error('upstream_business_error');
      if (event === 'model_config') {
        if (data.config_name && data.config_name !== model.name)
          throw new Error('upstream_model_mismatch');
        confirmed = true;
      }
      if (event === 'plan_item') {
        const tool = data.tool_call_info;
        if (tool?.name === 'finish' && typeof tool.params?.summary === 'string')
          summary = tool.params.summary;
        else if (tool?.name) throw new Error('remote_tool_execution');
        if (data.id && typeof data.thought === 'string' && data.thought)
          plans.set(data.id, data.thought);
      }
      if (
        event === 'token_usage' &&
        Number.isSafeInteger(data.prompt_tokens) &&
        Number.isSafeInteger(data.completion_tokens)
      )
        usage = { prompt_tokens: data.prompt_tokens, completion_tokens: data.completion_tokens };
      if (event === 'done') {
        if (data.status !== 'completed') throw new Error('truncated_stream');
        finished = true;
        break;
      }
    }
    if (!finished || !confirmed) throw new Error('truncated_stream');
    const text = summary || [...plans.values()].join('\n');
    if (!text) throw new Error('empty_output');
    if (text.length > 1024 * 1024) throw new Error('output_limit');
    return new Response(
      'event: output\ndata: ' +
        JSON.stringify({ response: text, ...(usage ? { usage } : {}) }) +
        '\n\nevent: done\ndata: {}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  } finally {
    if (!finished) await stop();
  }
}

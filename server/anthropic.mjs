import crypto from 'node:crypto';
function contentText(content, role) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error('消息内容无效');
  return content
    .map((b) => {
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'tool_use' && role === 'assistant')
        return '[Client tool call] ' + JSON.stringify({ id: b.id, name: b.name, input: b.input });
      if (b.type === 'tool_result' && role === 'user')
        return (
          '[Client tool result] ' +
          JSON.stringify({
            id: b.tool_use_id,
            error: !!b.is_error,
            content: contentText(b.content || '', 'user'),
          })
        );
      if (['thinking', 'redacted_thinking'].includes(b.type) && role === 'assistant') return '';
      throw new Error('当前 Messages 接口只支持文本及客户端工具块');
    })
    .join('\n');
}
export function anthropicRequest(body) {
  if (
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.some((m) => !m || !['user', 'assistant', 'system', 'developer'].includes(m.role))
  )
    throw new Error('messages 无效');
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 128000)
    throw new Error('max_tokens 无效');
  const messages = body.messages.map((m) => ({
    role: m.role,
    content: contentText(m.content, m.role),
  }));
  if (body.system !== undefined)
    messages.unshift({ role: 'system', content: contentText(body.system, 'system') });
  const tools = body.tools || [];
  if (
    !Array.isArray(tools) ||
    tools.some(
      (t) =>
        !t ||
        typeof t.name !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(t.name) ||
        !t.input_schema ||
        typeof t.input_schema !== 'object',
    )
  )
    throw new Error('工具定义无效');
  const choice = body.tool_choice;
  if (choice && !['auto', 'none', 'any', 'tool'].includes(choice.type))
    throw new Error('tool_choice 无效');
  if (choice?.type === 'tool' && !tools.some((t) => t.name === choice.name))
    throw new Error('指定工具不存在');
  return {
    model: body.model,
    stream: body.stream,
    max_tokens: body.max_tokens,
    messages,
    clientTools: tools,
    clientToolChoice: choice || { type: 'auto' },
  };
}
export function toolPrompt(tools, choice) {
  if (!tools.length || choice?.type === 'none') return '';
  return (
    '\nCLIENT TOOL BRIDGE: You are answering an external API caller. NEVER execute any built-in or remote tools on behalf of this caller. To request a client tool, output exactly <client_tool_call>{"name":"tool name","input":{}}</client_tool_call> then finish. Do not use markdown fences. Only use tools from the JSON catalog below. The caller executes them locally and returns their results in a later request. For a normal final answer output ordinary text, without this tag. Tool policy: ' +
    JSON.stringify(choice) +
    '\nTools: ' +
    JSON.stringify(tools)
  );
}
export function parseToolReply(text, tools, choice) {
  const calls = [];
  const clean = text
    .replace(/<client_tool_call>([\s\S]*?)<\/client_tool_call>/g, (_all, json) => {
      const value = JSON.parse(json);
      if (
        !tools.some((t) => t.name === value.name) ||
        !value.input ||
        typeof value.input !== 'object' ||
        Array.isArray(value.input) ||
        choice?.type === 'none' ||
        (choice?.type === 'tool' && choice.name !== value.name)
      )
        throw new Error('invalid_tool_output');
      calls.push({
        type: 'tool_use',
        id: 'toolu_' + crypto.randomUUID().replaceAll('-', ''),
        name: value.name,
        input: value.input,
      });
      return '';
    })
    .trim();
  if (
    clean.includes('<client_tool_call>') ||
    (['any', 'tool'].includes(choice?.type) && !calls.length)
  )
    throw new Error('invalid_tool_output');
  return [...(clean ? [{ type: 'text', text: clean }] : []), ...calls];
}
export function anthropicReply(res, record, content, stream) {
  const reason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const usage = { input_tokens: record.inputTokens ?? 0, output_tokens: record.outputTokens ?? 0 };
  const message = {
    id: record.id.replace('chatcmpl-', 'msg_'),
    type: 'message',
    role: 'assistant',
    model: record.model,
    content,
    stop_reason: reason,
    stop_sequence: null,
    usage,
  };
  if (!stream) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(message));
    return;
  }
  if (!res.headersSent)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  const emit = (type, data = {}) =>
    res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
  emit('message_start', {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
    },
  });
  content.forEach((block, index) => {
    emit('content_block_start', {
      index,
      content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} },
    });
    emit('content_block_delta', {
      index,
      delta:
        block.type === 'text'
          ? { type: 'text_delta', text: block.text }
          : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
    });
    emit('content_block_stop', { index });
  });
  emit('message_delta', {
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  emit('message_stop');
  res.end();
}

// Runs inside our isolated Trae renderer, over a private debugger pipe.
// Keep this function self-contained: it is serialized, not imported by Trae.
export async function localBridge(operation, value) {
  let state = globalThis.__traeSwitchLocalBridge;
  if (!state) {
    if (!globalThis.vscode?.ahaIpc) throw new Error('local_ipc_unavailable');
    const ipc = globalThis.vscode.ahaIpc.connect('ai-agent');
    state = { ipc, pending: new Map(), streams: new Map(), blocked: new Map() };
    globalThis.__traeSwitchLocalBridge = state;
    ipc.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (message.method === 'execute_command' && message.id !== undefined) {
        const packet = message.params?.[0];
        const command = packet?.params?.command_id;
        let result = null;
        let error;
        // Supply an empty workspace context, never invoke arbitrary Trae commands.
        if (
          ['getRulesDetails', 'getPreComputedFileDiff', 'getAllAgentExtensions'].some((c) =>
            command?.endsWith('.' + c),
          )
        )
          result = [];
        else if (
          ['getConfigurationValue', 'filePathSensitiveOrNot'].some((c) =>
            command?.endsWith('.' + c),
          ) ||
          command === 'icube.ai.agent.sql.log.enable'
        )
          result = false;
        else if (command === 'icube.common.getDynamicConfig') result = {};
        else if (command?.endsWith('.listFolder')) result = { files: [], folders: [] };
        else {
          error = 'local_tool_execution';
          state.blocked.set(packet?.session_id, command);
        }
        ipc.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              results: {
                stream_id: packet?.channel_id,
                msg_type: 'execute_command_result',
                payload: JSON.stringify(result),
                ...(error ? { error } : {}),
              },
              base_resp: { status_message: 'ok', status_code: 0, extra: null },
            },
          }),
        );
        return;
      }
      if (state.pending.has(message.id)) {
        state.pending.get(message.id)(message);
        return;
      }
      if (message.method?.startsWith('rpc.stream.') && message.meta?.stream) {
        const id = message.meta.streamId;
        const stream = state.streams.get(id) || { items: [], bytes: 0, done: false };
        state.streams.set(id, stream);
        if (message.params?.error) stream.error = 'local_stream_error';
        if (message.meta.done) stream.done = true;
        else if (!stream.error) {
          stream.bytes += raw.length;
          if (stream.bytes > 4 * 1024 * 1024) stream.error = 'output_limit';
          else stream.items.push(message.params?.data?.params);
        }
      }
    });
  }
  if (operation === 'poll') {
    const stream = state.streams.get(value.streamId);
    if (!stream)
      return {
        items: [],
        done: false,
        error: state.blocked.has(value.sessionId) ? 'local_tool_execution' : 'local_stream_lost',
        blockedCommand: state.blocked.get(value.sessionId),
      };
    const items = stream.items.splice(0, 100);
    stream.bytes = Math.max(0, stream.bytes - JSON.stringify(items).length);
    return {
      items,
      done: stream.done && !stream.items.length,
      error: state.blocked.has(value.sessionId) ? 'local_tool_execution' : stream.error,
      blockedCommand: state.blocked.get(value.sessionId),
    };
  }
  if (operation === 'cancel') {
    state.ipc.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'rpc.stream.cancel.' + value.streamId,
        params: [{ streamId: value.streamId, reason: 'request_finished' }],
      }),
    );
    state.streams.delete(value.streamId);
    state.blocked.delete(value.sessionId);
    return true;
  }
  return await new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error('local_request_timeout'));
    }, 20000);
    state.pending.set(id, (message) => {
      clearTimeout(timer);
      state.pending.delete(id);
      if (message.error) reject(new Error('local_rpc_error'));
      else {
        // Register before the first event. A missing stream during polling then
        // means the renderer/IPC context was reset, rather than a slow model.
        const streamId = message.result?.streamId;
        if (operation === 'request_stream' && typeof streamId === 'string')
          if (!state.streams.has(streamId))
            state.streams.set(streamId, { items: [], bytes: 0, done: false });
        resolve(message.result);
      }
    });
    state.ipc.send(JSON.stringify({ jsonrpc: '2.0', id, method: operation, params: [value] }));
  });
}

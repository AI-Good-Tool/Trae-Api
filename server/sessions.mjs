import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { hostFor } from './client.mjs';
import { readNativeSessions } from './native-sessions.mjs';
import { clientDataDir } from './platform.mjs';

const REGIONS = ['cn', 'intl'];
const keyFor = (variant, accountId, remoteId) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([variant, accountId, remoteId]))
    .digest('hex');
const iso = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const numeric = typeof value === 'string' && /^\d{10,13}$/.test(value) ? Number(value) : value;
  const time = typeof numeric === 'number' ? (numeric < 1e12 ? numeric * 1000 : numeric) : numeric;
  const d = new Date(time);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
function parsed(value) {
  if (typeof value !== 'string') return value;
  try {
    const result = JSON.parse(value);
    return result && typeof result === 'object' ? result : value;
  } catch {
    return value;
  }
}
export function messageText(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return '';
  const obj = parsed(value);
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj))
    return obj
      .map((v) => messageText(v, depth + 1))
      .filter(Boolean)
      .join('\n\n');
  if (typeof obj !== 'object') return '';
  if (
    obj.tool_call_info?.name === 'finish' &&
    typeof obj.tool_call_info.params?.summary === 'string'
  )
    return obj.tool_call_info.params.summary;
  for (const k of ['text_content', 'text', 'thought', 'summary'])
    if (typeof obj[k] === 'string') return obj[k];
  for (const k of ['messages', 'plan_item', 'content', 'data'])
    if (obj[k] !== undefined) {
      const text = messageText(obj[k], depth + 1);
      if (text) return text;
    }
  return '';
}
export function normalizeMessage(m, i = 0) {
  if (!m || typeof m !== 'object') throw new Error('会话消息格式无效');
  const role = m.role === 'human' ? 'user' : m.role === 'ai' ? 'assistant' : m.role;
  if (!['user', 'assistant', 'system', 'developer', 'tool', 'transcript'].includes(role))
    throw new Error('不支持的消息角色');
  const raw = m.content ?? m.text ?? '';
  const text = messageText(raw).slice(0, 1024 * 1024);
  return {
    id: String(m.message_id || m.id || i).slice(0, 160),
    role,
    text,
    time: iso(m.created_at || m.time),
    model: typeof m.model === 'string' ? m.model.slice(0, 128) : '',
    ...(m.tool_calls || m.toolCalls ? { toolCalls: m.tool_calls || m.toolCalls } : {}),
  };
}
export function summarize(s) {
  const { messages, ...rest } = s;
  return {
    ...rest,
    messageCount: messages?.length ?? s.messageCount ?? null,
    contentLoaded: Array.isArray(messages),
    preview: messages?.find((m) => m.text)?.text.slice(0, 120) || '',
  };
}
export function localSessionSources(home = os.homedir(), options = {}) {
  return REGIONS.map((variant) => {
    const file = path.join(
      clientDataDir(variant, { home, ...options }),
      'ModularData/ai-agent/database.db',
    );
    try {
      const fd = fs.openSync(file, 'r'),
        head = Buffer.alloc(16);
      try {
        fs.readSync(fd, head, 0, 16, 0);
      } finally {
        fs.closeSync(fd);
      }
      return {
        variant,
        found: true,
        encrypted: head.toString() !== 'SQLite format 3\0',
        status: 'import-required',
        message: '本机历史库已发现；请从客户端复制或导出会话后导入，当前不自动解密原库。',
      };
    } catch {
      return {
        variant,
        found: false,
        status: 'missing',
        message: '未发现本机会话数据库，可导入客户端导出的文件或复制内容。',
      };
    }
  });
}
export class Sessions {
  constructor(store, { fetcher = fetch, host = hostFor, nativeReader = readNativeSessions } = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.host = host;
    this.nativeReader = nativeReader;
    this.nativeSnapshot = null;
    store.data.sessions ||= [];
    store.data.sessionSync ||= {};
  }
  list({ variant = 'all', query = '', archived = false, offset = 0, limit = 30 } = {}) {
    if (!['all', ...REGIONS].includes(variant)) throw new Error('地区无效');
    const q = String(query).toLowerCase().slice(0, 200);
    this.nativeSnapshot = this.nativeReader({ accounts: this.store.data.accounts });
    const rows = this.nativeSnapshot.items
      .filter(
        (s) =>
          s.source === 'client-native' &&
          (variant === 'all' || s.variant === variant) &&
          !!s.archived === !!archived &&
          (!q ||
            [
              s.title,
              s.projectName,
              s.nativeSessionId,
              s.note,
              s.accountName,
              s.workspace,
              ...(s.messages || []).map((m) => m.text),
            ].some((v) =>
              String(v || '')
                .toLowerCase()
                .includes(q),
            )),
      )
      .sort(
        (a, b) =>
          Number(!!(b.nativePinned || b.pinned)) - Number(!!(a.nativePinned || a.pinned)) ||
          String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
      );
    return {
      items: rows
        .slice(Math.max(0, offset), Math.max(0, offset) + Math.min(100, Math.max(1, limit)))
        .map(summarize),
      total: rows.length,
      sources: this.nativeSnapshot.sources,
    };
  }
  find(id) {
    const row =
      this.nativeSnapshot?.items.find((s) => s.id === id) ||
      this.store.data.sessions.find((s) => s.id === id);
    if (!row) throw new Error('会话不存在');
    return row;
  }
  async request(account, suffix) {
    const response = await this.fetcher(this.host(account, 'remote') + '/api/remote/v1' + suffix, {
      headers: {
        Authorization: 'Cloud-IDE-JWT ' + account.user.token,
        'X-Trae-Client-Type': 'web',
        'x-user-region':
          account.variant === 'cn' ? 'CN' : account.user.account?.storeRegion || 'SG',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('官方会话接口请求失败（HTTP ' + response.status + '）');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new Error('会话响应超过 8MB，请缩小查询范围');
      chunks.push(chunk);
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new Error('官方会话接口未返回有效 JSON');
    }
    if (data.code && data.code !== 0) throw new Error('官方会话接口拒绝请求，请刷新账号凭证');
    return data.data || data;
  }
  async sync(account) {
    const items = new Map();
    let offset = 0,
      total = Infinity;
    while (offset < total && offset < 1000) {
      const data = await this.request(account, '/chat_sessions?limit=100&offset=' + offset);
      if (!Array.isArray(data.items)) throw new Error('官方会话列表格式变化');
      let added = 0;
      for (const s of data.items) {
        if (typeof s.chat_session_id !== 'string') continue;
        if (!items.has(s.chat_session_id)) {
          items.set(s.chat_session_id, s);
          added++;
        }
      }
      total = Number.isSafeInteger(data.total) ? data.total : items.size;
      offset += data.items.length;
      if (!data.items.length || !added) break;
    }
    const now = new Date().toISOString();
    for (const row of items.values()) {
      const id = keyFor(account.variant, account.id, row.chat_session_id),
        old = this.store.data.sessions.find((s) => s.id === id);
      const patch = {
        id,
        remoteId: row.chat_session_id,
        accountId: account.id,
        accountName: account.note || account.user.account?.username || account.id,
        variant: account.variant,
        source: 'remote',
        title: old?.customTitle || String(row.title || '未命名会话').slice(0, 240),
        serverTitle: String(row.title || '未命名会话').slice(0, 240),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at) || now,
        status: row.status,
        mode: row.mode || '',
        syncedAt: now,
      };
      if (old) {
        if (old.updatedAt !== patch.updatedAt) {
          delete old.messages;
          delete old.contentLoadedAt;
        }
        Object.assign(old, patch);
      } else this.store.data.sessions.push(patch);
    }
    this.store.data.sessionSync[account.id] = {
      time: now,
      count: items.size,
      remoteTotal: Number.isFinite(total) ? total : items.size,
      partial: items.size < total,
    };
    this.store.save();
    return this.store.data.sessionSync[account.id];
  }
  async detail(id, { refresh = false } = {}) {
    if (!this.nativeSnapshot) this.list();
    const row = this.find(id);
    if (row.source !== 'remote' || (row.messages && !refresh)) return row;
    const a = this.store.account(row.accountId),
      items = new Map();
    let offset = 0,
      total = Infinity;
    while (offset < total && offset < 2000) {
      const data = await this.request(
        a,
        '/chat_sessions/' +
          encodeURIComponent(row.remoteId) +
          '/messages?limit=100&offset=' +
          offset,
      );
      if (!Array.isArray(data.items)) throw new Error('官方消息列表格式变化');
      let added = 0;
      for (const m of data.items) {
        const key = String(m.message_id || m.id || '');
        if (key && !items.has(key)) {
          items.set(key, m);
          added++;
        }
      }
      total = Number.isSafeInteger(data.total) ? data.total : items.size;
      offset += data.items.length;
      if (!data.items.length || !added) break;
    }
    const raw = [...items.values()].sort((a, b) => (a.message_index ?? 0) - (b.message_index ?? 0));
    const messages = raw.map(normalizeMessage);
    row.messages = messages;
    row.messageCount = messages.length;
    row.contentLoadedAt = new Date().toISOString();
    row.contentPartial = messages.length < total;
    this.store.save();
    return row;
  }
  import(body) {
    if (!REGIONS.includes(body.variant)) throw new Error('请选择国内版或国际版');
    let input = body.data;
    if (typeof input === 'string') input = parsed(input);
    const records =
      typeof input === 'string'
        ? [
            {
              title: body.title || '导入的会话',
              messages: [{ role: 'transcript', content: input }],
            },
          ]
        : Array.isArray(input)
          ? input
          : input?.sessions || [input];
    if (!records.length || records.length > 100) throw new Error('每次可导入 1–100 个会话');
    const prepared = records.map((raw) => {
      if (
        !raw ||
        typeof raw !== 'object' ||
        !Array.isArray(raw.messages) ||
        !raw.messages.length ||
        raw.messages.length > 2000
      )
        throw new Error('导入文件须包含会话 messages 数组，或使用 Markdown / 文本导入');
      if (raw.source === 'remote') throw new Error('仅支持导入客户端会话，请勿导入云端反代会话');
      const messages = raw.messages.map(normalizeMessage);
      const id = keyFor(
        body.variant,
        'import',
        String(
          raw.importId ||
            raw.session_id ||
            (raw.source !== 'client-import' ? raw.id : undefined) ||
            crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
        ),
      );
      return {
        id,
        importId: String(
          raw.importId ||
            raw.session_id ||
            (raw.source !== 'client-import' ? raw.id : undefined) ||
            crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
        ),
        variant: body.variant,
        source: 'client-import',
        title: String(raw.title || body.title || '导入的会话').slice(0, 240),
        workspace: String(raw.workspace || '').slice(0, 1000),
        messages,
        createdAt: iso(raw.createdAt || raw.created_at),
        updatedAt: iso(raw.updatedAt || raw.updated_at) || new Date().toISOString(),
        importedAt: new Date().toISOString(),
        note: '',
        messageCount: messages.length,
        contentPartial: !!raw.contentPartial,
      };
    });
    let imported = 0;
    for (const row of prepared) {
      const old = this.store.data.sessions.find((s) => s.id === row.id);
      if (old)
        Object.assign(old, row, {
          title: old.customTitle || row.title,
          note: old.note || '',
          pinned: old.pinned,
          archived: old.archived,
        });
      else {
        this.store.data.sessions.push(row);
        imported++;
      }
    }
    this.store.save();
    return { imported, updated: prepared.length - imported, ids: prepared.map((s) => s.id) };
  }
  update(id, body) {
    const existing = this.find(id);
    if (existing.source === 'client-native') throw new Error('请在 Trae 客户端中管理原生会话');
    const row = { ...existing };
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim()) throw new Error('标题不能为空');
      row.customTitle = body.title.trim().slice(0, 240);
      row.title = row.customTitle;
    }
    if (body.note !== undefined) {
      if (typeof body.note !== 'string') throw new Error('备注格式无效');
      row.note = body.note.slice(0, 1000);
    }
    for (const k of ['pinned', 'archived'])
      if (body[k] !== undefined) {
        if (typeof body[k] !== 'boolean') throw new Error('会话设置无效');
        row[k] = body[k];
      }
    Object.assign(existing, row);
    this.store.save();
    return summarize(row);
  }
}

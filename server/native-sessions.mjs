import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { clientDataDir } from './platform.mjs';

const idPattern = /^(?:[a-f\d]{24}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i;
const text = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const stamp = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  const d = new Date(typeof n === 'number' && n < 1e12 ? n * 1000 : n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
function tail(file, max, budget) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || budget <= 0) return { text: '', partial: true, bytes: 0 };
  const size = Math.min(stat.size, max, budget),
    offset = stat.size - size,
    data = Buffer.alloc(size);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, data, 0, size, offset);
  } finally {
    fs.closeSync(fd);
  }
  const result = data.toString('utf8');
  return {
    text: offset ? result.slice(result.indexOf('\n') + 1) : result,
    partial: offset > 0,
    bytes: size,
  };
}
// Only parse client-emitted structured events. Never infer a native session from imported text.
export function readNativeSessions({
  home = os.homedir(),
  accounts = [],
  platform = process.platform,
  env = process.env,
} = {}) {
  const items = [],
    sources = [];
  for (const [variant, name] of [
    ['cn', 'Trae CN'],
    ['intl', 'Trae'],
  ]) {
    const dataDir = clientDataDir(variant, { home, platform, env });
    const root = path.join(dataDir, 'logs');
    const events = [],
      projects = new Map(),
      sessions = new Map();
    let files = 0,
      partial = false,
      budget = 64 * 1024 * 1024;
    let runs = [];
    try {
      runs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((x) => x.isDirectory() && /^\d{8}T\d{6}$/.test(x.name))
        .map((x) => x.name)
        .sort();
    } catch {}
    if (runs.length > 40) {
      partial = true;
      runs = runs.slice(-40);
    }
    for (const run of [...runs].reverse()) {
      const folder = path.join(root, run);
      let windows = [];
      try {
        windows = fs
          .readdirSync(folder, { withFileTypes: true })
          .filter((x) => x.isDirectory() && /^window\d+$/.test(x.name));
      } catch {
        partial = true;
        continue;
      }
      for (const window of windows) {
        const dir = path.join(folder, window.name);
        let logs = [];
        try {
          logs = fs.readdirSync(dir).filter((x) => /^renderer(?:\.\d+)?\.log$/.test(x));
        } catch {
          partial = true;
          continue;
        }
        for (const log of logs) {
          const file = path.join(dir, log);
          let read;
          try {
            read = tail(file, 16 * 1024 * 1024, budget);
          } catch {
            partial = true;
            continue;
          }
          budget -= read.bytes;
          partial ||= read.partial;
          files++;
          for (const line of read.text.split('\n')) {
            const event = line.match(
              /\[RealtimeInitService\]\[(local|remote)\] Handle event: (session_(?:created|updated|deleted)|project_(?:created|updated|deleted)) (\{.*\})\s*$/,
            );
            const fetched =
              !event && line.match(/\[RealtimeEventService\] Session fetched: (\{.*\})\s*$/);
            const project =
              !event &&
              !fetched &&
              line.match(/\[ProjectService\] Project synchronized: (\{.*\})\s*$/);
            if (!event && !fetched && !project) continue;
            let raw;
            try {
              raw = JSON.parse(event?.[3] || fetched?.[1] || project?.[1]);
            } catch {
              continue;
            }
            if (!raw || typeof raw !== 'object') continue;
            if (project) {
              if (raw.code !== 0 || !raw.data) continue;
              raw = raw.data;
            }
            events.push({
              kind: event?.[2] || (fetched ? 'session_fetched' : 'project_updated'),
              env: event?.[1] || null,
              raw,
              time: stamp(line.split(' ')[0]) || '',
              file: path.relative(dataDir, file),
            });
          }
        }
      }
    }
    events.sort((a, b) => a.time.localeCompare(b.time));
    for (const e of events) {
      const r = e.raw;
      if (e.kind.startsWith('project_')) {
        const id = text(r.local_project_id || r.project_id, 160);
        if (!id) continue;
        if (e.kind === 'project_deleted') {
          projects.delete(id);
          continue;
        }
        const old = projects.get(id) || {};
        projects.set(id, {
          ...old,
          ...(r.user_id ? { userId: String(r.user_id) } : {}),
          ...(typeof r.name === 'string' ? { name: text(r.name) } : {}),
          ...(typeof r.single_root_workspace_folder === 'string'
            ? { workspace: text(r.single_root_workspace_folder, 1000) }
            : {}),
          ...(r.is_default !== undefined ? { isDefault: r.is_default === true } : {}),
        });
        continue;
      }
      const nativeId = text(r.chat_session_id, 160);
      if (!idPattern.test(nativeId)) continue;
      const old = sessions.get(nativeId) || {};
      if (e.kind === 'session_deleted') {
        sessions.delete(nativeId);
        continue;
      }
      const patch = { nativeSessionId: nativeId, observedAt: e.time, logFile: e.file };
      for (const [from, to] of [
        ['user_id', 'userId'],
        ['title', 'title'],
        ['local_project_id', 'projectId'],
        ['project_id', 'projectId'],
        ['origin', 'origin'],
        ['workspace_path', 'workspace'],
        ['main_folder', 'workspace'],
        ['session_type', 'sessionType'],
      ]) {
        if (r[from] !== undefined && r[from] !== null)
          patch[to] = text(
            String(r[from]),
            from.includes('folder') || from === 'workspace_path' ? 1000 : 500,
          );
      }
      if (r.source?.type === 'local' && typeof r.source.local_folder === 'string')
        patch.workspace = text(r.source.local_folder, 1000);
      if (e.env) patch.clientEnv = e.env;
      else if (r.source?.type === 'local') patch.clientEnv = 'local';
      if (r.created_at !== undefined) patch.createdAt = stamp(r.created_at);
      if (r.updated_at !== undefined) patch.updatedAt = stamp(r.updated_at);
      if (typeof r.is_pinned === 'boolean') patch.nativePinned = r.is_pinned;
      if (typeof r.is_unread === 'boolean') patch.unread = r.is_unread;
      if (r.status !== undefined) patch.status = r.status;
      sessions.set(nativeId, { ...old, ...patch });
    }
    for (const s of sessions.values()) {
      if (!s.userId) continue;
      const p = projects.get(s.projectId);
      const account = accounts.find((a) => a.variant === variant && a.user?.userId === s.userId);
      const grouped =
        p &&
        (!p.userId || p.userId === s.userId) &&
        !p.isDefault &&
        p.name &&
        !['Assistant', 'ungrouped', '默认项目', '默认'].includes(p.name);
      const id = crypto
        .createHash('sha256')
        .update(JSON.stringify([variant, s.userId, s.nativeSessionId]))
        .digest('hex');
      items.push({
        id,
        variant,
        source: 'client-native',
        nativeSessionId: s.nativeSessionId,
        nativeUserId: s.userId,
        accountId: account?.id || null,
        accountName: account?.note || account?.user.account?.username || '本机客户端账号',
        title: s.title || '新会话',
        projectId: s.projectId || '',
        projectName: grouped ? p.name : '默认',
        workspace: s.workspace || p?.workspace || '',
        createdAt: s.createdAt || null,
        updatedAt: s.updatedAt || s.createdAt || s.observedAt,
        origin: s.origin || '',
        clientEnv: s.clientEnv || '',
        nativePinned: s.nativePinned || false,
        unread: s.unread || false,
        status: s.status ?? null,
        nativeMetadataOnly: true,
        messageCount: null,
        provenance: { kind: 'client-event-log', file: s.logFile, observedAt: s.observedAt },
        detailNotice:
          '已读取客户端真实会话标识和项目关联。消息正文仍在客户端加密存储中，当前仅展示会话索引，请在 Trae 中查看正文。',
      });
    }
    sources.push({
      variant,
      status: files ? 'indexed' : 'unavailable',
      files,
      count: items.filter((s) => s.variant === variant).length,
      partial,
      coverage: '客户端保留的事件日志；不保证覆盖未记录或已清理的历史',
      message: files
        ? '已从客户端事件日志读取真实会话索引；原始文件只读。'
        : '未发现可读取的客户端会话事件日志，请启动对应客户端并打开历史会话。',
    });
  }
  return { items, sources };
}

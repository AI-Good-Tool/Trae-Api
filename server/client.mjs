import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { creditPacks } from './credits.mjs';
import { stopClient } from './client-process.mjs';
import { discoverClient, launchClient } from './platform.mjs';

export const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
export const variants = { intl: 'Trae', cn: 'Trae CN' };
const sha = (b) => crypto.createHash('sha512').update(b).digest();
const profiles = new Map();
export function profile(variant) {
  if (!variants[variant]) throw new Error('未知客户端版本');
  if (profiles.has(variant)) return profiles.get(variant);
  const found = discoverClient(variant);
  const { product, source, dir } = found;
  const p = {
    variant,
    ...found,
    name: variants[variant],
    // Network routing and app discovery must not depend on login-state encryption internals.
    get salt() {
      return readAuthSalt(source);
    },
    storage: path.join(dir, 'User/globalStorage/storage.json'),
  };
  profiles.set(variant, p);
  return p;
}
// Locate the AES branch semantically; minified variable names change between releases.
export function readAuthSalt(source) {
  const pair = source.match(
    /else\s+if\([\w$]+===[\w$]+\.AES\)[\s\S]{0,160}?=([\w$]+)\[[^\]]+\]\^([\w$]+)\[[^\]]+\]/,
  );
  if (!pair) throw new Error('客户端加密格式已变化，请重新分析版本');
  const arrays = pair.slice(1).map((key) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = source.match(
      new RegExp(escaped + '=(?:Uint8Array.from|new Uint8Array)\\((\\[[^\\]]+\\])\\)'),
    );
    if (!m) throw new Error('客户端加密参数缺失');
    const values = JSON.parse(m[1]);
    if (
      !Array.isArray(values) ||
      values.length !== 64 ||
      values.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
    )
      throw new Error('客户端加密参数无效');
    return values;
  });
  return Buffer.from(arrays[0].map((v, i) => v ^ arrays[1][i]));
}
export function decode(value, p) {
  const raw = Buffer.from(value, 'base64');
  if (!raw.subarray(0, 6).equals(Buffer.from([116, 99, 5, 16, 0, 0])))
    throw new Error('未知登录态加密版本');
  const key = sha(Buffer.concat([sha(raw.subarray(6, 38)), p.salt]));
  const cipher = crypto.createDecipheriv('aes-128-cbc', key.subarray(0, 16), key.subarray(16, 32));
  const data = Buffer.concat([cipher.update(raw.subarray(38)), cipher.final()]);
  if (!crypto.timingSafeEqual(sha(data.subarray(64)), data.subarray(0, 64)))
    throw new Error('登录态完整性校验失败');
  return JSON.parse(data.subarray(64).toString());
}
export function encode(value, p) {
  const data = Buffer.from(JSON.stringify(value)),
    seed = crypto.randomBytes(32);
  const key = sha(Buffer.concat([sha(seed), p.salt]));
  const cipher = crypto.createCipheriv('aes-128-cbc', key.subarray(0, 16), key.subarray(16, 32));
  return Buffer.concat([
    Buffer.from([116, 99, 5, 16, 0, 0]),
    seed,
    cipher.update(Buffer.concat([sha(data), data])),
    cipher.final(),
  ]).toString('base64');
}
export function readLocal(variant) {
  const p = profile(variant),
    storage = JSON.parse(fs.readFileSync(p.storage, 'utf8'));
  if (!storage[AUTH_KEY]) throw new Error(`请先登录 ${p.name}`);
  const user = decode(storage[AUTH_KEY], p);
  const pairEntry = Object.entries(storage).find(([k]) =>
    k.startsWith('iCubeAuthInfo://icube-dc:'),
  );
  let cached = {};
  try {
    cached = JSON.parse(storage['iCubeServerData://icube.cloudide'] || '{}');
  } catch {}
  const models = readCachedModels(p, user.userId);
  return {
    variant,
    user,
    models,
    deviceId: pairEntry?.[0].split(':').at(-1),
    deviceKeys: pairEntry ? decode(pairEntry[1], p) : null,
    machineId: storage['telemetry.machineId'] || '',
    cached,
    capturedAt: new Date().toISOString(),
  };
}
export function readCachedModels(p, userId) {
  let db;
  try {
    db = new DatabaseSync(path.join(p.dir, 'User/globalStorage/state.vscdb'), { readOnly: true });
    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get(`${userId}:AI.agent.model.model_list_map`);
    if (!row) return [];
    const groups = JSON.parse(row.value),
      models = new Map();
    for (const [group, list] of Object.entries(groups))
      for (const m of Array.isArray(list) ? list : []) {
        if (!m.name || m.status === false) continue;
        const found = models.get(m.name);
        if (found) {
          if (!found.functions.includes(group)) found.functions.push(group);
          continue;
        }
        models.set(m.name, {
          id: m.config_name || m.name,
          name: m.display_name || m.name,
          model: m.name,
          source: m.config_source || 1,
          catalogSource: 'client-cache',
          functions: [group],
          remote: !!m.use_remote_service,
        });
      }
    return [...models.values()];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
export function hostFor(account, category = 'ug') {
  const p = profile(account.variant),
    boot = p.product.bootConfig;
  const hosts = category === 'account' ? boot.account.trae : boot[category].trae;
  const region = account.user.account.storeRegion;
  const host = hosts[region] || hosts.normal;
  const url = new URL(host);
  if (url.protocol !== 'https:') throw new Error('客户端服务地址必须是 HTTPS');
  return url.origin;
}
export function maskPhone(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.includes('*')) return v;
  return v.length > 5 ? v.slice(0, 3) + '******' + v.slice(-2) : '***';
}
export function publicAccount(a) {
  return {
    id: a.id,
    variant: a.variant,
    username: a.user.account.username,
    email: a.user.account.email,
    note: a.note || '',
    userId: a.user.userId,
    region: a.user.account.storeRegion,
    expiredAt: a.user.expiredAt,
    refreshExpiredAt: a.user.refreshExpiredAt,
    capturedAt: a.capturedAt,
    plan: a.cached?.entitlementInfo?.identityStr || '未知',
    tokenPresent: !!a.user.token,
    refreshPresent: !!a.user.refreshToken,
    tokenExpired: Date.parse(a.user.expiredAt) <= Date.now(),
    snapshot: a.snapshot || null,
    creditPacks: creditPacks(a),
    autoCheckin: !!a.autoCheckin,
    enabled: a.enabled !== false,
    concurrencyLimit: a.concurrencyLimit || 4,
    phone: maskPhone(a.user.account.phone || a.user.account.mobile || a.user.account.phoneNumber),
    checkin: a.checkin || null,
    models: a.models || [],
  };
}
export async function launch(variant) {
  await launchClient(profile(variant));
}
export async function switchAccount(
  account,
  backupDir,
  { getProfile = profile, stop = stopClient, start = launch } = {},
) {
  const p = getProfile(account.variant);
  // Validate encryption before stopping the editor; reread storage after it has stopped.
  const auth = encode(account.user, p);
  const device = account.deviceKeys && account.deviceId ? encode(account.deviceKeys, p) : null;
  JSON.parse(fs.readFileSync(p.storage, 'utf8'));
  const stopped = await stop(p);
  const original = fs.readFileSync(p.storage, 'utf8'),
    data = JSON.parse(original);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = path.join(
    backupDir,
    `${account.variant}-${Date.now()}-${crypto.randomUUID()}.json`,
  );
  fs.writeFileSync(backup, original, { mode: 0o600, flag: 'wx' });
  data[AUTH_KEY] = auth;
  // Cached entitlement and device credentials must follow the selected identity.
  delete data['iCubeServerData://icube.cloudide'];
  for (const k of Object.keys(data)) if (k.startsWith('iCubeAuthInfo://icube-dc:')) delete data[k];
  if (account.deviceKeys && account.deviceId)
    data[`iCubeAuthInfo://icube-dc:${account.deviceId}`] = device;
  if (account.cached) data['iCubeServerData://icube.cloudide'] = JSON.stringify(account.cached);
  const tmp = p.storage + '.trae-switch.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, '\t'), { mode: 0o600 });
  fs.renameSync(tmp, p.storage);
  await start(account.variant);
  return { backup, ...stopped };
}

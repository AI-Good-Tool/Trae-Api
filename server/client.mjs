import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { creditPacks } from './credits.mjs';

export const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
export const variants = { intl: 'Trae', cn: 'Trae CN' };
const sha = (b) => crypto.createHash('sha512').update(b).digest();
const profiles = new Map();
export function profile(variant) {
  if (!variants[variant]) throw new Error('未知客户端版本');
  if (profiles.has(variant)) return profiles.get(variant);
  const name = variants[variant];
  const app = `/Applications/${name}.app`;
  const root = `${app}/Contents/Resources/app`;
  const product = JSON.parse(fs.readFileSync(`${root}/product.json`, 'utf8'));
  const source = fs.readFileSync(`${root}/out/main.js`, 'utf8');
  // Read constants as JSON only. Never evaluate installed application code.
  const array = (key) => {
    const match = source.match(
      new RegExp(key + '=(?:Uint8Array.from|new Uint8Array)\\((\\[[^\\]]+\\])\\)'),
    );
    if (!match) throw new Error('客户端加密格式已变化，请重新分析版本');
    return JSON.parse(match[1]);
  };
  const a = array('Gle'),
    b = array('zle');
  const dir = path.join(os.homedir(), 'Library/Application Support', name);
  const p = {
    variant,
    name,
    app,
    root,
    dir,
    product,
    salt: Buffer.from(a.map((v, i) => v ^ b[i])),
    storage: path.join(dir, 'User/globalStorage/storage.json'),
  };
  profiles.set(variant, p);
  return p;
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
    checkin: a.checkin || null,
    models: a.models || [],
  };
}
export function launch(variant) {
  execFileSync('/usr/bin/open', ['-a', profile(variant).app]);
}
export function isRunning(variant) {
  try {
    return execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' })
      .split('\n')
      .some((s) => s.startsWith(`${profile(variant).app}/Contents/MacOS/`));
  } catch {
    return true;
  }
}
export function switchAccount(account, backupDir) {
  const p = profile(account.variant);
  if (isRunning(account.variant))
    throw new Error(`请先退出 ${p.name} 再切换，避免运行中的客户端覆盖登录态`);
  const original = fs.readFileSync(p.storage, 'utf8'),
    data = JSON.parse(original);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = path.join(backupDir, `${account.variant}-${Date.now()}.json`);
  fs.writeFileSync(backup, original, { mode: 0o600 });
  data[AUTH_KEY] = encode(account.user, p);
  // Cached entitlement and device credentials must follow the selected identity.
  delete data['iCubeServerData://icube.cloudide'];
  for (const k of Object.keys(data)) if (k.startsWith('iCubeAuthInfo://icube-dc:')) delete data[k];
  if (account.deviceKeys && account.deviceId)
    data[`iCubeAuthInfo://icube-dc:${account.deviceId}`] = encode(account.deviceKeys, p);
  if (account.cached) data['iCubeServerData://icube.cloudide'] = JSON.stringify(account.cached);
  const tmp = p.storage + '.trae-switch.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, '\t'), { mode: 0o600 });
  fs.renameSync(tmp, p.storage);
  launch(account.variant);
  return { backup };
}

import crypto from 'node:crypto';
import os from 'node:os';
import { profile, hostFor } from './client.mjs';

export async function request(a, route, body = {}, category = 'ug', extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(category === 'account'
      ? { 'x-cloudide-token': a.user.token }
      : { Authorization: `Cloud-IDE-JWT ${a.user.token}` }),
    ...extra,
  };
  const r = await fetch(hostFor(a, category) + route, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${r.status}：返回内容不是 JSON`);
  }
  if (!r.ok)
    throw new Error(
      `HTTP ${r.status}：${data.message || data.ResponseMetadata?.Error?.Code || '服务拒绝请求'}`,
    );
  if (data.code || data.ResponseMetadata?.Error)
    throw new Error(`接口错误：${data.code || data.ResponseMetadata.Error.Code}`);
  return data;
}
export async function refreshSnapshot(a) {
  const version = a.variant === 'cn' ? 'v2' : 'v1';
  const tasks = [
    ['pay', `/trae/api/${version}/pay/ide_user_pay_status`, { req_source: 1 }],
    [
      'usage',
      `/trae/api/${version}/pay/ide_user_ent_usage`,
      { require_usage: true, req_source: 1 },
    ],
  ];
  if (a.variant === 'cn')
    tasks.push(['checkin', '/trae/api/v2/ug/checkin_credits/status', { req_source: 1 }]);
  const results = await Promise.allSettled(
    tasks.map(async ([key, url, body]) => [
      key,
      await request(a, url, body, 'ug', { 'x-device-id': a.deviceId || '0' }),
    ]),
  );
  const snapshot = { time: new Date().toISOString(), source: 'official-api', errors: {} };
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') snapshot[r.value[0]] = r.value[1];
    else snapshot.errors[tasks[i][0]] = r.reason.message;
  });
  a.snapshot = snapshot;
  if (snapshot.checkin) a.checkin = { ...snapshot.checkin, time: snapshot.time };
  return snapshot;
}
export async function checkin(a, send = request) {
  if (a.variant !== 'cn') throw new Error('国际版客户端未提供此签到接口');
  const headers = {
    'x-device-id': a.deviceId || '0',
    'x-device-type': 'macOS',
    'x-device-brand': os.arch(),
  };
  const status = await send(
    a,
    '/trae/api/v2/ug/checkin_credits/status',
    { req_source: 1 },
    'ug',
    headers,
  );
  if (typeof status.enable !== 'boolean' || typeof status.checked_in !== 'boolean')
    throw new Error('签到状态格式变化，已停止领取');
  if (!status.enable) throw new Error('此账号当前未开放签到');
  if (status.checked_in) {
    a.checkin = { ...status, time: new Date().toISOString() };
    return { already: true, ...status };
  }
  const result = await send(
    a,
    '/trae/api/v2/ug/checkin_credits/claim',
    { req_source: 1 },
    'ug',
    headers,
  );
  // Re-read status instead of assuming a successful transport means a successful claim.
  a.checkin = {
    ...(await send(a, '/trae/api/v2/ug/checkin_credits/status', { req_source: 1 }, 'ug', headers)),
    time: new Date().toISOString(),
  };
  if (a.checkin.checked_in !== true) throw new Error('领取请求已完成，但服务端尚未确认签到');
  return result;
}
export async function refreshToken(a) {
  if (!a.deviceKeys?.privateKeyPEM || !a.user.refreshToken)
    throw new Error('缺少设备密钥或 refreshToken，请重新采集客户端账号');
  const p = profile(a.variant),
    clientId = p.product.iCubeApp?.authConfig?.TRAE?.stable || 'ono9krqynydwx5';
  const route = '/trae/api/v3/oauth/ExchangeToken',
    timestamp = Math.floor(Date.now() / 1000),
    nonce = crypto.randomBytes(16).toString('hex');
  const canonical = ['POST', route, clientId, a.user.refreshToken, String(timestamp), nonce].join(
    '\n',
  );
  const signature = crypto
    .sign('sha256', Buffer.from(canonical), a.deviceKeys.privateKeyPEM)
    .toString('base64');
  const data = await request(
    a,
    route,
    {
      ClientID: clientId,
      ClientSecret: '',
      RefreshToken: a.user.refreshToken,
      DeviceInfo: {
        DeviceID: a.deviceId,
        MachineID: a.machineId,
        PlatformCode: 'IDE_PC',
        DeviceType: 'PC',
        DeviceName: os.hostname(),
        ClientVersion: p.product.appVersion,
        DevicePublicKey: a.deviceKeys.publicKeyPEM,
      },
      DeviceProof: { Signature: signature, Timestamp: timestamp, Nonce: nonce },
      IDEVersion: p.product.appVersion,
    },
    'account',
  );
  const r = data.Result;
  if (!r?.Token || !r.RefreshToken) throw new Error('刷新接口未返回有效凭证');
  Object.assign(a.user, {
    token: r.Token,
    refreshToken: r.RefreshToken,
    expiredAt: new Date(r.TokenExpireAt).toISOString(),
    refreshExpiredAt: new Date(r.RefreshExpireAt).toISOString(),
    tokenReleaseAt: new Date().toISOString(),
  });
  return { expiredAt: a.user.expiredAt };
}

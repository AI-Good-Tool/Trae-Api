import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { openExternal } from './platform.mjs';
import { profile, readLocal, hostFor } from './client.mjs';
import { request } from './api.mjs';

export class Login {
  constructor(store) {
    this.store = store;
    this.pending = new Map();
  }
  async start(variant) {
    if (this.pending.has(variant)) throw new Error('此版本已有登录窗口，请完成或等待五分钟后重试');
    const p = profile(variant),
      verifier = crypto.randomBytes(48).toString('base64url'),
      challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    let local;
    try {
      local = readLocal(variant);
    } catch {}
    const deviceId = local?.deviceId || crypto.randomBytes(16).toString('hex'),
      machineId = local?.machineId || crypto.randomUUID();
    const clientId = p.product.iCubeApp?.authConfig?.TRAE?.stable || 'ono9krqynydwx5';
    const record = { status: 'waiting', variant, startedAt: new Date().toISOString() };
    let handling = false;
    const server = http.createServer(async (req, res) => {
      let u;
      try {
        u = new URL(req.url, 'http://127.0.0.1');
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (u.pathname !== '/authorize' || req.method !== 'GET') {
        res.writeHead(404);
        res.end();
        return;
      }
      if (handling) {
        res.writeHead(409);
        res.end();
        return;
      }
      let authCode;
      try {
        authCode = JSON.parse(u.searchParams.get('authCodeInfo') || '{}').AuthCode;
      } catch {}
      if (!authCode) {
        res.writeHead(400);
        res.end('Missing authCodeInfo');
        return;
      }
      handling = true;
      try {
        const a = {
          variant,
          user: { token: '', account: { storeRegion: variant === 'cn' ? 'CN' : 'SG' } },
        };
        const data = await request(
          a,
          '/trae/api/v3/oauth/ExchangeToken',
          {
            ClientID: clientId,
            AuthCode: authCode,
            CodeVerifier: verifier,
            DeviceInfo: {
              DeviceID: deviceId,
              MachineID: machineId,
              PlatformCode: 'IDE_PC',
              DeviceType: 'PC',
              DeviceName: os.hostname(),
              DevicePublicKey: publicKey,
              ClientVersion: p.product.appVersion,
            },
            IDEVersion: p.product.appVersion,
          },
          'account',
        );
        const t = data.Result;
        if (!t?.Token || !t.RefreshToken) throw new Error('未收到登录凭证');
        a.user.token = t.Token;
        const info = (
          await request(
            a,
            '/cloudide/api/v3/trae/GetUserInfo',
            { ReqSource: 'IDE', IDEVersion: p.product.appVersion },
            'account',
          )
        ).Result;
        if (!info?.UserID) throw new Error('无法取得账号资料');
        const user = {
          token: t.Token,
          refreshToken: t.RefreshToken,
          expiredAt: new Date(t.TokenExpireAt).toISOString(),
          refreshExpiredAt: new Date(t.RefreshExpireAt).toISOString(),
          tokenReleaseAt: new Date().toISOString(),
          userId: info.UserID,
          host: hostFor(a, 'account'),
          userRegion: { region: info.AIRegion, _aiRegion: info.AIRegion },
          account: {
            username: info.ScreenName,
            email: info.NonPlainTextEmail || '',
            avatar_url: info.AvatarUrl,
            scope: 'marscode',
            loginScope: 'trae',
            storeRegion: variant === 'cn' ? 'CN' : info.AIRegion || 'SG',
            userTag: 'row',
          },
        };
        this.store.upsert({
          variant,
          user,
          deviceId,
          machineId,
          deviceKeys: { publicKeyPEM: publicKey, privateKeyPEM: privateKey },
          capturedAt: new Date().toISOString(),
        });
        record.status = 'success';
        this.store.event('login', `${p.name} 浏览器账号已添加`);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'",
        });
        res.end('<h2>账号已添加，可以关闭此窗口并返回 Trae Switch。</h2>');
      } catch (e) {
        record.status = 'error';
        record.error = e.message;
        this.store.event('error', `${p.name} 浏览器登录失败：${e.message}`);
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('登录失败，请返回 Trae Switch 查看诊断。');
      } finally {
        server.close();
        clearTimeout(timer);
        this.pending.delete(variant);
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const timer = setTimeout(() => {
      server.close();
      record.status = 'expired';
      this.pending.delete(variant);
    }, 300000);
    timer.unref();
    this.pending.set(variant, { server, record });
    const u = new URL('/authorization', p.product.bootConfig.consoleHost);
    for (const [k, v] of Object.entries({
      login_version: 1,
      auth_from: 'trae',
      login_channel: 'native_ide',
      auth_type: 'local',
      client_id: clientId,
      redirect: 0,
      login_trace_id: crypto.randomUUID(),
      auth_callback_url: `http://127.0.0.1:${server.address().port}/authorize`,
      machine_id: machineId,
      device_id: deviceId,
      x_device_id: deviceId,
      x_machine_id: machineId,
      x_app_version: p.product.appVersion,
      x_app_type: 'stable',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }))
      u.searchParams.set(k, v);
    try {
      await openExternal(u.href);
    } catch {
      clearTimeout(timer);
      server.close();
      this.pending.delete(variant);
      throw new Error('无法打开浏览器，请检查默认浏览器配置后重试');
    }
    return { status: 'waiting', expiresIn: 300 };
  }
  close() {
    for (const x of this.pending.values()) x.server.close();
    this.pending.clear();
  }
}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { variants, readLocal, publicAccount, profile, switchAccount, launch } from './client.mjs';
import { refreshSnapshot, refreshToken } from './api.mjs';
import { Gateway, json, readBody, modelCatalog } from './gateway.mjs';
import { Login } from './oauth.mjs';
import { changeApiKey, updateGatewaySettings } from './settings.mjs';

import { modelCatalogView, updateModelRule } from './models.mjs';
import { Checkins, checkedToday } from './checkin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function start(port = Number(process.env.PORT || 19827), store = new Store()) {
  const gateway = new Gateway(store),
    login = new Login(store),
    session = crypto.randomBytes(32).toString('hex');
  const busy = new Set();
  const checkins = new Checkins(store);
  async function exclusive(id, fn) {
    if (busy.has(id)) throw new Error('该账号正在操作，请稍后重试');
    busy.add(id);
    try {
      return await fn();
    } finally {
      busy.delete(id);
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const allowedHost = `127.0.0.1:${server.address().port}`;
      if (
        req.headers.host !== allowedHost &&
        req.headers.host !== `localhost:${server.address().port}`
      )
        return json(res, 403, { error: 'Host 不允许' });
      const url = new URL(req.url, `http://${allowedHost}`);
      if (url.pathname.startsWith('/api/')) {
        if (!req.headers.cookie?.split(';').some((x) => x.trim() === `trae_session=${session}`))
          return json(res, 401, { error: '请先打开工作台' });
        if (
          req.headers.origin &&
          !['http://' + allowedHost, `http://localhost:${server.address().port}`].includes(
            req.headers.origin,
          )
        )
          return json(res, 403, { error: '来源不允许' });
        const body = req.method === 'POST' ? await readBody(req) : {};
        let result;
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const clients = Object.keys(variants).map((variant) => {
            try {
              const p = profile(variant);
              return { variant, name: p.name, installed: true, version: p.product.appVersion };
            } catch {
              return { variant, name: variants[variant], installed: false };
            }
          });
          const { apiKey, ...settings } = store.data.settings;
          result = {
            accounts: store.data.accounts.map(publicAccount),
            events: store.data.events,
            requests: store.data.requests,
            modelCatalog: modelCatalogView(store.data),
            checkinHistory: store.data.checkinHistory || [],
            settings: {
              ...settings,
              gatewayRunning: !!gateway.server,
              keyHint: apiKey.slice(0, 6) + '…' + apiKey.slice(-4),
            },
            clients,
            logins: [...login.pending.values()].map((x) => x.record),
            busy: [...busy],
          };
        } else if (req.method === 'POST') {
          const id = body.id,
            a = id ? store.account(id) : null;
          switch (url.pathname) {
            case '/api/capture': {
              const v = body.variant;
              if (!variants[v]) throw new Error('请选择客户端版本');
              const account = store.upsert(readLocal(v));
              store.event('capture', `${variants[v]} 当前账号已采集`);
              result = publicAccount(account);
              break;
            }
            case '/api/login':
              result = await login.start(body.variant);
              break;
            case '/api/launch':
              launch(body.variant);
              result = { ok: true };
              break;
            case '/api/refresh':
              result = await exclusive(id, async () => {
                const r = await refreshSnapshot(a);
                store.save();
                store.event('refresh', `${variants[a.variant]} 用量刷新完成`);
                return r;
              });
              break;
            case '/api/token':
              result = await exclusive(id, async () => {
                const r = await refreshToken(a);
                store.save();
                store.event('token', `${variants[a.variant]} 登录凭证已刷新`);
                return r;
              });
              break;
            case '/api/checkin':
              result = await exclusive(id, async () => {
                const r = await checkins.execute(a);
                store.save();
                store.event('checkin', `${variants[a.variant]} 签到状态已确认`);
                return r;
              });
              break;
            case '/api/account':
              if (typeof body.note === 'string') a.note = body.note.slice(0, 120);
              if (typeof body.autoCheckin === 'boolean')
                a.autoCheckin = a.variant === 'cn' && body.autoCheckin;
              store.save();
              result = publicAccount(a);
              break;
            case '/api/switch':
              result = await exclusive(id, () => switchAccount(a, path.join(store.dir, 'backups')));
              store.event('switch', `${variants[a.variant]} 账号已切换，原始存储已备份`);
              break;
            case '/api/models':
              result = await exclusive(id, async () => {
                const r = await modelCatalog(a);
                store.save();
                return r;
              });
              break;
            case '/api/import': {
              if (!variants[body.variant]) throw new Error('请选择版本');
              const imported = body.account;
              if (!imported || typeof imported !== 'object') throw new Error('请输入完整账号 JSON');
              result = publicAccount(
                store.upsert({
                  variant: body.variant,
                  user: imported.user || imported,
                  capturedAt: new Date().toISOString(),
                }),
              );
              break;
            }
            case '/api/model-rule':
              result = updateModelRule(store, body);
              break;
            case '/api/settings':
              result = await exclusive('gateway-settings', () =>
                updateGatewaySettings(store, gateway, body),
              );
              break;
            case '/api/key/update':
              result = await exclusive('gateway-settings', () => changeApiKey(store, body));
              break;
            case '/api/key':
              result = { apiKey: store.data.settings.apiKey };
              break;
            default:
              return json(res, 404, { error: '接口不存在' });
          }
        } else return json(res, 405, { error: '方法不允许' });
        return json(res, 200, result);
      }
      if (req.method !== 'GET') return json(res, 405, { error: '方法不允许' });
      const files = {
        '/': 'index.html',
        '/app.js': 'app.js',
        '/style.css': 'style.css',
        '/icon.svg': 'icon.svg',
      };
      const file = files[url.pathname];
      if (!file) return json(res, 404, { error: '页面不存在' });
      res.writeHead(200, {
        'Content-Type': file.endsWith('.svg')
          ? 'image/svg+xml'
          : file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'text/html; charset=utf-8',
        'X-Trae-Switch': '0.3.2',
        'Set-Cookie': `trae_session=${session}; HttpOnly; SameSite=Strict; Path=/`,
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      res.end(fs.readFileSync(path.join(root, 'ui', file)));
    } catch (e) {
      json(res, 400, { error: e.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  if (store.data.settings.gatewayEnabled)
    try {
      await gateway.start();
    } catch (e) {
      store.event('error', `反代启动失败：${e.message}`);
    }
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const a of store.data.accounts.filter((a) => a.autoCheckin && a.variant === 'cn')) {
        if (busy.has(a.id) || checkedToday(a)) continue;
        try {
          await exclusive(a.id, async () => {
            const result = await checkins.execute(a, 'auto');
            if (!result.already) await refreshSnapshot(a);
            store.save();
            if (!result.already) store.event('checkin', '自动签到成功');
          });
        } catch (e) {
          store.event('error', `自动签到：${e.message}`);
        }
      }
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(tick, 10 * 60 * 1000);
  void tick();
  timer.unref();
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    store,
    server,
    gateway,
    async close() {
      clearInterval(timer);
      login.close();
      await gateway.stop();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await start();
  console.log(`Trae Switch 已启动：${app.url}`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => app.close().then(() => process.exit()));
}

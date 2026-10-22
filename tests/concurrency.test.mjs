import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { Gateway } from '../server/gateway.mjs';
test('并发满时改用兼容账号，全部忙返回 429，失败释放额度且禁用账号不参与', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'trae-capacity-')));
  store.data.settings.gatewayPort = 0;
  store.data.settings.gatewayVariant = 'all';
  store.data.settings.gatewayMode = 'priority';
  store.data.accounts = ['cn', 'intl'].map((variant, i) => ({
    id: 'a' + i,
    variant,
    concurrencyLimit: 1,
    user: { expiredAt: '2035-01-01', account: { username: 'test' } },
    models: [{ id: 'shared' }],
  }));
  const releases = [];
  const gateway = new Gateway(store, {
    headers: () => ({}),
    host: () => '',
    upstreamFetch: async () =>
      new Promise((resolve) =>
        releases.push(() => resolve(new Response('error', { status: 500 }))),
      ),
  });
  await gateway.start();
  const url = 'http://127.0.0.1:' + gateway.server.address().port + '/v1/chat/completions';
  const request = () =>
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + store.data.settings.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'shared', messages: [{ role: 'user', content: 'test' }] }),
    });
  const until = async (count) => {
    for (let i = 0; i < 100 && releases.length < count; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(releases.length, count);
  };
  try {
    const first = request();
    await until(1);
    const second = request();
    await until(2);
    assert.equal(gateway.active.get('a0'), 1);
    assert.equal(gateway.active.get('a1'), 1);
    const busy = await request();
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get('retry-after'), '1');
    await busy.text();
    releases[0]();
    releases[1]();
    assert.equal((await first).status, 502);
    assert.equal((await second).status, 502);
    assert.equal(gateway.active.size, 0);
    store.data.accounts[0].enabled = false;
    const third = request();
    await until(3);
    assert.equal(gateway.active.has('a0'), false);
    assert.equal(gateway.active.get('a1'), 1);
    releases[2]();
    await third;
    assert.equal(gateway.active.size, 0);
  } finally {
    releases.forEach((r) => r());
    await gateway.stop();
  }
});

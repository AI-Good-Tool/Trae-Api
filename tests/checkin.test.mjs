import test from 'node:test';
import assert from 'node:assert/strict';
import { checkin } from '../server/api.mjs';
import { Checkins, checkedToday } from '../server/checkin.mjs';
test('签到先查询、领取后确认；已签不重复领取，国际版不调用接口', async () => {
  const a = { variant: 'cn' },
    calls = [];
  const send = async (_a, route) => {
    calls.push(route);
    return route.endsWith('claim')
      ? {}
      : { enable: true, checked_in: calls.length > 1, credits: 100 };
  };
  await checkin(a, send);
  assert.deepEqual(
    calls.map((s) => s.split('/').at(-1)),
    ['status', 'claim', 'status'],
  );
  assert(checkedToday(a));
  const already = await checkin(a, async () => ({ enable: true, checked_in: true }));
  assert(already.already);
  await assert.rejects(
    checkin({ variant: 'intl' }, () => {
      throw new Error('must not call');
    }),
  );
  await assert.rejects(checkin(a, async () => ({ enable: true })));
  a.checkin.time = '2000-01-01T00:00:00Z';
  assert(!checkedToday(a));
});
test('并发签到合并执行，历史持久化但错误不保存上游敏感正文', async () => {
  const store = { data: {}, save() {} },
    a = { id: 'test', variant: 'cn', user: { account: { username: 'test' } } };
  let count = 0;
  const service = new Checkins(store, async () => {
    count++;
    await new Promise((r) => setTimeout(r, 10));
    return { already: true };
  });
  await Promise.all([service.execute(a), service.execute(a)]);
  assert.equal(count, 1);
  assert.equal(store.data.checkinHistory.length, 1);
  assert.equal(store.data.checkinHistory[0].status, 'already');
  const bad = new Checkins(store, async () => {
    throw new Error('SECRET provider token');
  });
  await assert.rejects(bad.execute(a));
  assert(!JSON.stringify(store.data).includes('SECRET'));
});

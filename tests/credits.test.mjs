import test from 'node:test';
import assert from 'node:assert/strict';
import { creditPacks } from '../server/credits.mjs';
test('积分包按到期排序，排除非积分与隐藏包，已过期或耗尽不计可用包', () => {
  const pack = (total, used, expiry, extra = {}) => ({
    entitlement_base_info: { quota: { credits_limit: total }, end_time: expiry },
    usage: { credits_amount: used },
    ...extra,
  });
  const a = {
    variant: 'cn',
    snapshot: {
      usage: {
        user_entitlement_pack_list: [
          pack(100, 25.35, 2000, { display_desc: '签到奖励' }),
          pack(500, 0, 1500),
          pack(100, 100, 1600),
          pack(10, 0, 900),
          pack(undefined, 0, 2000),
          pack(30, 0, 2000, { is_hide: true }),
        ],
      },
    },
  };
  const rows = creditPacks(a, 1000 * 1000);
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((p) => p.active).length, 2);
  assert.deepEqual(
    rows.map((p) => p.total),
    [10, 500, 100, 100],
  );
  assert.equal(rows.at(-1).remaining, 74.65);
  assert.equal(rows.at(-1).name, '签到奖励');
  assert.deepEqual(creditPacks({ ...a, variant: 'intl' }), []);
});
test('积分包 expire_time 为零时回退 end_time，空 usage 表示尚未消耗', () => {
  const rows = creditPacks(
    {
      variant: 'cn',
      snapshot: {
        usage: {
          user_entitlement_pack_list: [
            {
              expire_time: 0,
              entitlement_base_info: { quota: { credits_limit: 100 }, end_time: 2000 },
            },
          ],
        },
      },
    },
    1000,
  );
  assert.equal(rows[0].remaining, 100);
  assert.equal(rows[0].expiresAt, '1970-01-01T00:33:20.000Z');
});

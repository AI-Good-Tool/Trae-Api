import test from 'node:test';
import assert from 'node:assert/strict';
import { requestTrend, renderRequestChart } from '../ui/request-chart.js';

test('趋势图按北京时间聚合最近七天，不混入旧年份、失败及未来请求', () => {
  const records = [
    { status: 'success', time: '2026-10-21T15:59:59Z' },
    { status: 'success', time: '2026-10-21T16:00:00Z' },
    { status: 'success', time: '2025-10-22T00:00:00Z' },
    { status: 'error', time: '2026-10-21T17:00:00Z' },
    { status: 'success', time: '2026-10-23T17:00:00Z' },
    { status: 'success', time: 'invalid' },
  ];
  const days = requestTrend(records, Date.parse('2026-10-22T00:00:00Z'));
  assert.equal(days.length, 7);
  assert.equal(days[5].label, '10/21');
  assert.equal(days[5].count, 1);
  assert.equal(days[6].count, 1);
  assert.equal(
    days.reduce((sum, day) => sum + day.count, 0),
    2,
  );
  const chart = renderRequestChart(records, Date.parse('2026-10-22T00:00:00Z'));
  assert(chart.includes('共 2 次成功请求'));
  assert(!chart.includes('<progress'));
  assert.equal((chart.match(/<rect /g) || []).length, 2);
  assert(renderRequestChart([]).includes('最近七天暂无成功请求'));
});

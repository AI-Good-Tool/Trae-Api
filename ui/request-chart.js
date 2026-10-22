const DAY = 86400000;
const OFFSET = 8 * 3600000;

export function requestTrend(records, now = Date.now()) {
  const today = Math.floor((Number(now) + OFFSET) / DAY);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = today - 6 + index;
    const iso = new Date(day * DAY).toISOString().slice(0, 10);
    return { day, label: iso.slice(5).replace('-', '/'), count: 0 };
  });
  for (const record of records) {
    if (record.status !== 'success') continue;
    const day = Math.floor((Date.parse(record.time) + OFFSET) / DAY);
    const index = day - days[0].day;
    if (index >= 0 && index < days.length) days[index].count++;
  }
  return days;
}

export function renderRequestChart(records, now = Date.now()) {
  const days = requestTrend(records, now);
  const maximum = Math.max(2, ...days.map((day) => day.count));
  const top = Math.ceil(maximum / 2) * 2;
  const left = 36,
    width = 504,
    baseline = 152,
    height = 124,
    step = width / 7;
  const grid = [0, top / 2, top]
    .map((value) => {
      const y = baseline - (value / top) * height;
      return `<line x1="${left}" y1="${y}" x2="540" y2="${y}" class="trend-grid"/><text x="26" y="${y + 4}" text-anchor="end" class="trend-tick">${value}</text>`;
    })
    .join('');
  const bars = days
    .map((day, index) => {
      const x = left + step * index + step / 2;
      const h = (day.count / top) * height;
      return `<g><title>${day.label}：${day.count} 次成功请求</title>${day.count ? `<rect x="${x - 15}" y="${baseline - h}" width="30" height="${h}" rx="4" class="trend-column"/><text x="${x}" y="${baseline - h - 7}" text-anchor="middle" class="trend-value">${day.count}</text>` : ''}<text x="${x}" y="177" text-anchor="middle" class="trend-tick">${day.label}</text></g>`;
    })
    .join('');
  const total = days.reduce((sum, day) => sum + day.count, 0);
  return `<figure class="request-trend"><svg viewBox="0 0 560 190" role="img" aria-label="最近七天共 ${total} 次成功请求，按北京时间统计" xmlns="http://www.w3.org/2000/svg">${grid}${bars}</svg>${total ? '' : '<p class="trend-empty">最近七天暂无成功请求</p>'}</figure>`;
}

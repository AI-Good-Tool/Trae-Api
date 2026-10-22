import { renderRequestChart } from './request-chart.js';

const icons = {
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9Z"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 5h4m-3 14h2"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  coin: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v6c0 4 16 4 16 0"/>',
  chart: '<path d="M4 3v17h17M8 15V9m5 6V5m5 10v-5"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-13 5 3 3 5-5"/>',
  proxy: '<path d="M3 7h15m-4-4 4 4-4 4M21 17H6m4-4-4 4 4 4"/>',
  pulse: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="m10 3-1 3-3 1-3-1-1 3 2 3-2 3 1 3 3-1 3 1 1 3h4l1-3 3-1 3 1 1-3-2-3 2-3-1-3-3 1-3-1-1-3Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  leaf: '<path d="M20 3C8 2 2 7 4 15c2 7 15 6 16-12Z M5 19 16 8"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-5"/>',
  terminal: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m6 9 3 3-3 3m6 0h5"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-3-3 3-3m-6 0 3-3"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
};
const icon = (n) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[n] || icons.grid}</svg>`;
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const fmt = (n, digits = 5) =>
  n === null || n === undefined
    ? '—'
    : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: digits });
const date = (v) =>
  v
    ? new Date(v).toLocaleDateString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
      })
    : '—';
const clock = (v) =>
  v
    ? new Date(v).toLocaleTimeString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const pages = [
  ['overview', 'grid', '总览'],
  ['accounts', 'users', '账号管理'],
  ['credits', 'coin', '积分统计'],
  ['tokens', 'chart', 'Token 用量'],
  ['checkin', 'calendar', '每日签到'],
  ['gateway', 'proxy', '模型反代'],
  ['requests', 'pulse', '请求记录'],
  ['diagnostics', 'pulse', '运行诊断'],
];
let state = null,
  page = location.hash.slice(1) || 'overview',
  filter = 'all',
  toastTimer,
  loading = false;
let requestView = { region: 'all', status: 'all', query: '', page: 1 };
const app = document.querySelector('#app'),
  modal = document.querySelector('#modal');
async function api(route, body) {
  const r = await fetch('/api/' + route, {
    ...(body !== undefined
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || '操作失败');
  return j;
}
function toast(s) {
  const el = document.querySelector('#toast');
  el.textContent = s;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 5000);
}
async function sync() {
  state = await api('state');
  render();
  if (page === 'sessions' && !sessionData) await loadSessions();
}
let sessionData = null;
let sessionView = { variant: 'cn', query: '', archived: false, page: 1 };
async function loadSessions() {
  sessionData = await api(
    'sessions?' +
      new URLSearchParams({
        variant: sessionView.variant,
        query: sessionView.query,
        archived: String(sessionView.archived),
        offset: String((sessionView.page - 1) * 30),
      }),
  );
  if (page === 'sessions') render();
}
let nativeSelectedId = null;
function sessionsPage() {
  const d = sessionData || { items: [], total: 0, sources: [] };
  const selected =
    d.items.find((s) => s.id === nativeSelectedId) ||
    d.items.find((s) => s.projectName !== '默认') ||
    d.items[0];
  const groups = new Map();
  for (const s of d.items) {
    const key = JSON.stringify([s.variant, s.nativeUserId, s.projectId, s.projectName]);
    if (!groups.has(key))
      groups.set(key, {
        name: s.projectName,
        variant: s.variant,
        account: s.accountName,
        items: [],
      });
    groups.get(key).items.push(s);
  }
  return (
    heading(
      'TRAE CLIENT SESSIONS',
      '会话管理',
      '按 Trae 客户端的项目分组展示真实会话。',
      '<button class="primary" data-action="refresh-sessions">' +
        icon('refresh') +
        '读取客户端会话</button>',
    ) +
    `<section class="panel native-session-panel"><div class="request-filters"><select id="session-region" aria-label="会话地区">${[
      ['cn', 'Trae CN 国内版'],
      ['intl', 'Trae 国际版'],
      ['all', '两个客户端'],
    ]
      .map(
        ([v, t]) =>
          `<option value="${v}" ${sessionView.variant === v ? 'selected' : ''}>${t}</option>`,
      )
      .join(
        '',
      )}</select><input id="session-search" aria-label="搜索会话" placeholder="搜索项目、会话标题" value="${esc(sessionView.query)}"><button data-action="filter-sessions">搜索</button><span class="subtle">${d.total} 个客户端会话</span></div><div class="native-session-browser"><div class="native-session-list">${
      [...groups.values()]
        .sort((a, b) => Number(a.name === '默认') - Number(b.name === '默认'))
        .map(
          (g) =>
            `<section class="native-project"><h3>${icon(g.name === '默认' ? 'grid' : 'terminal')}${esc(g.name)}<small>${sessionView.variant === 'all' ? (g.variant === 'cn' ? '国内版' : '国际版') + ' · ' : ''}${esc(g.account)}</small></h3>${g.items.map((s) => `<button class="native-session-row ${selected?.id === s.id ? 'selected' : ''}" data-action="native-session-select" data-id="${esc(s.id)}"><span>${s.nativePinned ? '置顶 · ' : ''}${esc(s.title)}</span><small>${date(s.updatedAt)} ${clock(s.updatedAt)}${s.unread ? ' · 未读' : ''}</small></button>`).join('')}</section>`,
        )
        .join('') ||
      '<div class="empty"><h3>暂无可读取的客户端会话</h3><p>在 Trae 中打开历史会话后，再读取客户端列表。</p></div>'
    }</div><div class="native-session-detail">${selected ? `<div class="eyebrow">${selected.variant === 'cn' ? 'TRAE CN' : 'TRAE'} / ${esc(selected.projectName)}</div><h2>${esc(selected.title)}</h2><p class="subtle">${esc(selected.accountName)} · ${date(selected.updatedAt)} ${clock(selected.updatedAt)}</p><div class="notice">${esc(selected.detailNotice)}</div><dl class="native-session-facts"><dt>项目</dt><dd>${esc(selected.projectName)}</dd><dt>项目目录</dt><dd>${esc(selected.workspace || '默认分组')}</dd><dt>原生会话 ID</dt><dd><code>${esc(selected.nativeSessionId)}</code></dd><dt>读取来源</dt><dd>Trae 客户端事件日志 · 原生会话索引</dd></dl><button data-action="launch" data-variant="${selected.variant}">${icon('arrow')}打开 ${selected.variant === 'cn' ? 'Trae CN' : 'Trae'} 查看正文</button>` : '<p class="subtle">选择一个客户端会话。</p>'}</div></div><div class="session-pagination native-pagination"><span>第 ${sessionView.page} 页 · 共 ${d.total} 个会话</span><div class="actions"><button data-action="sessions-prev" ${sessionView.page <= 1 ? 'disabled' : ''}>上一页</button><button data-action="sessions-next" ${sessionView.page * 30 >= d.total ? 'disabled' : ''}>下一页</button></div></div></section><p class="subtle native-coverage">列表来自客户端保留的结构化事件日志，可能不覆盖已清理或未记录的历史；手动导入副本和未在客户端观察到的 API 会话不列入。</p>${d.sources
      .filter((s) => sessionView.variant === 'all' || s.variant === sessionView.variant)
      .map(
        (s) =>
          `<p class="subtle native-coverage">${s.variant === 'cn' ? 'Trae CN' : 'Trae'}：${esc(s.message)}${s.partial ? ' 当前读取达到上限，结果可能不完整。' : ''}</p>`,
      )
      .join('')}`
  );
}
async function sessionAction(action, id) {
  if (action === 'native-session-select') {
    nativeSelectedId = id;
    render();
  } else if (action === 'refresh-sessions') {
    sessionView.page = 1;
    sessionData = await api('sessions/refresh', {
      variant: sessionView.variant,
      query: sessionView.query,
    });
    render();
    toast('已重新读取客户端会话索引');
  } else if (action === 'filter-sessions') {
    sessionView = {
      variant: document.querySelector('#session-region').value,
      query: document.querySelector('#session-search').value,
      archived: false,
      page: 1,
    };
    await loadSessions();
  } else if (action === 'sessions-prev' || action === 'sessions-next') {
    sessionView.page += action === 'sessions-prev' ? -1 : 1;
    await loadSessions();
  }
}
function metric(label, value, unit, foot, ico = 'chart', accent = '') {
  return `<div class="metric"><div class="metric-label">${label}${icon(ico)}</div><div class="metric-value">${value}<small>${unit}</small></div><div class="metric-foot">${accent ? `<em>${accent}</em>` : ''}${foot}</div></div>`;
}
function filtered() {
  return state.accounts.filter((a) => filter === 'all' || a.variant === filter);
}
function credits(a) {
  const u = a.snapshot?.usage;
  if (u?.usage_summary) {
    const total = u.usage_summary.total_amount,
      used = u.usage_summary.consumed_amount;
    return { remaining: total - used, total, used, unit: '积分' };
  }
  if (u?.is_dollar_usage_billing) {
    const packs = u.user_entitlement_pack_list || [];
    const total = packs.reduce(
        (s, p) => s + (p.entitlement_base_info?.quota?.basic_usage_limit || 0),
        0,
      ),
      used = packs.reduce((s, p) => s + (p.usage?.basic_usage_amount || 0), 0);
    return { remaining: total - used, total, used, unit: 'USD' };
  }
  return { remaining: null, total: null, used: null, unit: a.variant === 'cn' ? '积分' : 'USD' };
}
function heading(english, title, desc, buttons = '') {
  return `<div class="page-title"><div><div class="eyebrow">${english}</div><h1>${title}</h1><p>${desc}</p></div><div class="actions">${buttons}</div></div>`;
}
const addButton = `<button class="primary" data-action="add">${icon('plus')}添加账号</button>`;
const refreshButton = `<button data-action="refresh-all">${icon('refresh')}刷新数据</button>`;
function tabs() {
  return `<div class="tabs">${[
    ['all', '全部'],
    ['cn', '国内版'],
    ['intl', '国际版'],
  ]
    .map(
      ([v, t]) =>
        `<button data-filter="${v}" class="${filter === v ? 'selected' : ''}">${t}</button>`,
    )
    .join('')}</div>`;
}
function empty(title, desc, button = '') {
  return `<div class="empty">${icon('leaf')}<h3>${title}</h3><p>${desc}</p>${button}</div>`;
}
function packExpiry(p) {
  return p.expiresAt
    ? new Date(p.expiresAt).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '未提供到期时间';
}
function packRows(packs) {
  return packs
    .map(
      (p) =>
        `<div class="credit-pack"><div class="pack-line"><strong>${fmt(p.remaining, 2)} 积分</strong><span>${esc(p.name)}</span><time>${packExpiry(p)}</time></div><progress class="native-progress" max="100" value="${Math.max(0, Math.min(100, (p.remaining / p.total) * 100))}" aria-label="${esc(p.name)}剩余比例"></progress></div>`,
    )
    .join('');
}
function accountCard(a) {
  const c = credits(a),
    packs = (a.creditPacks || []).filter((p) => p.active),
    checked = checkedToday(a);
  return `<article class="account account-v2"><header class="account-top"><div class="account-avatar ${a.variant}">${esc((a.note || a.username || 'T').slice(0, 1).toUpperCase())}</div><div class="account-meta"><h3>${esc(a.note || a.username)}</h3><small>${esc(a.email || '本地采集账号')} · ${esc(a.snapshot?.pay?.user_pay_identity_str || a.plan)}</small>${a.phone ? `<small class="account-phone">${icon('phone')}${esc(a.phone)}</small>` : ''}<div class="account-tags"><span class="pill">${a.variant === 'cn' ? '国内版' : '国际版'}</span><span class="badge ${a.tokenExpired ? 'warning' : ''}">${a.tokenExpired ? '凭证过期' : '凭证有效'}</span><span class="pill">${a.models.length} 个模型</span>${a.variant === 'cn' ? `<span class="checkin-indicator ${checked ? 'checked' : ''}" title="${checked ? '今日已签到' : '今日未签到'}">${icon('calendar')}</span>` : ''}</div></div><button class="quiet account-menu" data-action="account-menu" data-id="${a.id}" aria-label="${esc(a.note || a.username)}账号设置">${icon('dots')}</button></header><section class="account-body"><div class="account-balance"><div class="balance-main">${icon('star')}<strong>${c.unit === 'USD' && c.remaining !== null ? '$' : ''}${fmt(c.remaining, c.unit === 'USD' ? 5 : 2)}</strong><small>剩余${c.unit === 'USD' ? '额度' : '积分'}${c.total !== null ? ' / ' + fmt(c.total) : ''}${c.unit === 'USD' ? ' USD' : ''}</small></div><time>${icon('clock')}${a.snapshot ? clock(a.snapshot.time) + ' 更新' : '尚未刷新'}</time></div>${a.variant === 'cn' ? `<section class="account-packs"><div class="pack-heading"><span>近期到期 · ${packs.length} 个积分包</span><button class="quiet" data-action="credit-packs" data-id="${a.id}">查看全部积分包 →</button></div>${packs.length ? packRows(packs.slice(0, 2)) : '<p class="subtle">' + (a.snapshot?.usage ? '暂无可用积分包' : '刷新账号后显示积分包') + '</p>'}</section>` : `<div class="account-international"><progress class="native-progress" max="100" value="${c.total ? Math.max(0, Math.min(100, (c.remaining / c.total) * 100)) : 0}" aria-label="剩余额度"></progress><p>国际版额度独立统计 · ${date(a.expiredAt)} 凭证到期</p></div>`}</section><footer class="account-footer"><div class="account-buttons"><button data-action="switch" data-id="${a.id}"><span class="button-icon dark">${icon('proxy')}</span>切换</button><button data-action="refresh" data-id="${a.id}"><span class="button-icon gray">${icon('refresh')}</span>刷新</button>${a.variant === 'cn' ? `<button class="${checked ? 'checkin-done' : ''}" data-action="checkin" data-id="${a.id}"><span class="button-icon amber">${icon('calendar')}</span>${checked ? '今日已签到' : '签到'}</button>` : ''}</div><div class="account-controls"><label>反代<button class="toggle ${a.enabled ? 'on' : ''}" data-action="toggle-proxy" data-id="${a.id}" aria-label="${esc(a.note || a.username)}参与反代" aria-pressed="${a.enabled}"></button></label>${a.variant === 'cn' ? `<label>签到<button class="toggle ${a.autoCheckin ? 'on' : ''}" data-action="toggle-checkin" data-id="${a.id}" aria-label="${esc(a.note || a.username)}自动签到" aria-pressed="${a.autoCheckin}"></button></label>` : '<span class="subtle">国际版暂不提供签到</span>'}<small>${a.activeRequests || 0} / ${a.concurrencyLimit} 并发</small></div></footer></article>`;
}
function activityList() {
  return (
    state.events
      .slice(0, 4)
      .map(
        (e) =>
          `<div class="activity"><div class="activity-icon">${icon(e.type === 'error' ? 'pulse' : 'check')}</div><div class="activity-text"><p>${esc(e.message)}</p><small>${esc(e.type.toUpperCase())} · 本地事件</small></div><time>${clock(e.time)}</time></div>`,
      )
      .join('') || empty('还没有活动', '采集账号、刷新用量后，操作记录会显示在这里')
  );
}
function requestChart() {
  return renderRequestChart(state.requests);
}

function overview() {
  const cn = state.accounts
      .filter((a) => a.variant === 'cn')
      .map(credits)
      .filter((c) => c.remaining !== null),
    req = state.requests,
    known = req.filter((r) => r.inputTokens !== null),
    sum = known.reduce((s, r) => s + r.inputTokens + (r.outputTokens || 0), 0);
  return (
    heading(
      'WORKSPACE OVERVIEW',
      '一切就绪，开始创造。',
      '你的 Trae 账号、用量与模型服务，尽在一个工作台。',
      refreshButton + addButton,
    ) +
    `<section class="hero"><div><div class="tag">YOUR LOCAL AI COMPANION</div><h2>让每个账号，都井井有条。</h2><p>连接 Trae 与 Trae CN，专注工作，其他交给 Switch。</p></div><div class="hero-art" aria-hidden="true">⟋⟋</div></section><div class="metrics">${metric('已添加账号', state.accounts.length, '个', '国内版 / 国际版独立管理', 'users', state.accounts.filter((a) => !a.tokenExpired).length + ' 个有效')}${metric('国内版剩余积分', cn.length ? fmt(cn.reduce((s, c) => s + c.remaining, 0)) : '—', 'Credits', cn.length ? '来自官方用量接口' : '刷新账号后获取官方数据', 'coin')}${metric('网关 Token', known.length ? fmt(sum) : '—', 'Tokens', known.length ? '仅汇总上游明确返回的 usage' : '暂无上游返回的 Token 数据', 'chart')}${metric('模型反代', state.settings.gatewayRunning ? '运行中' : '未启动', '', `127.0.0.1:${state.settings.gatewayPort}`, 'proxy')}</div><div class="section-heading"><h2>我的账号<span>${state.accounts.length} 个连接</span></h2>${tabs()}</div><div class="accounts-grid">${filtered().map(accountCard).join('') || `<div class="panel">${empty('连接第一个 Trae 账号', '从本机采集，或通过浏览器添加新账号', addButton)}</div>`}</div><div class="split"><section class="panel"><div class="panel-header"><h2>请求趋势</h2><small>最近 7 天 · 真实反代请求</small></div>${requestChart()}</section><section class="panel"><div class="panel-header"><h2>最近活动</h2><button class="quiet subtle" data-page="diagnostics">全部记录 ${icon('arrow')}</button></div>${activityList()}</section></div>`
  );
}
function accountsPage() {
  return (
    heading(
      'ACCOUNT MANAGEMENT',
      '账号管理',
      '一处管理，两种版本。凭证仅保存在本机加密账号库中。',
      `<button data-action="capture-choice">${icon('download')}采集本机账号</button>` + addButton,
    ) +
    `<div class="section-heading"><h2>全部账号<span>${state.accounts.length} 个账号</span></h2>${tabs()}</div><div class="accounts-grid">${filtered().map(accountCard).join('')}</div>${!filtered().length ? `<div class="panel">${empty('还没有账号', '从本机采集已登录账号，或使用浏览器独立登录', addButton)}</div>` : ''}<div class="notice green">${icon('shield')} 切换时自动退出对应 Trae 客户端；超时未退出会强制结束。确认退出后备份并切换登录态，再重新启动客户端。</div><section class="panel"><div class="panel-header"><h2>本机客户端</h2><small>自动发现本机安装目录</small></div>${state.clients.map((c) => `<div class="settings-row"><div><h3>${esc(c.name)} <span class="pill">${c.installed ? '已安装' : '未安装'}</span></h3><p>${c.installed ? '版本 ' + esc(c.version) : '请先安装客户端'}</p></div><div class="actions"><button data-action="launch" data-variant="${c.variant}">打开客户端 ${icon('arrow')}</button><button data-action="capture" data-variant="${c.variant}">${icon('download')}采集账号</button></div></div>`).join('')}</section>`
  );
}
function creditsPage() {
  const list = filtered(),
    cn = list
      .filter((a) => a.variant === 'cn')
      .map(credits)
      .filter((c) => c.total !== null);
  return (
    heading(
      'CREDITS & BILLING',
      '积分统计',
      '保留国内版积分与国际版美元额度的独立口径。',
      refreshButton,
    ) +
    `<div class="section-heading"><h2>官方用量</h2>${tabs()}</div><div class="metrics">${metric('国内版总额度', cn.length ? fmt(cn.reduce((s, c) => s + c.total, 0)) : '—', 'Credits', '官方 usage_summary', 'coin')}${metric('国内版已消耗', cn.length ? fmt(cn.reduce((s, c) => s + c.used, 0)) : '—', 'Credits', '当前官方账期', 'chart')}${metric('国内版剩余', cn.length ? fmt(cn.reduce((s, c) => s + c.remaining, 0)) : '—', 'Credits', '官方总额减已消耗', 'coin')}${metric('已同步账号', list.filter((a) => a.snapshot?.usage).length, '个', '每个账号独立刷新', 'refresh')}</div>${
      list
        .map((a) => {
          const c = credits(a),
            packs = a.snapshot?.usage?.user_entitlement_pack_list || [];
          return `<section class="panel"><div class="panel-header"><h2>${esc(a.note || a.username)} <span class="pill">${a.variant === 'cn' ? '国内版' : '国际版'}</span></h2><small>${a.snapshot ? date(a.snapshot.time) + ' ' + clock(a.snapshot.time) : '待刷新'}</small></div><div class="account-detail"><div><div class="caption">剩余额度</div><div class="number">${c.unit === 'USD' ? '$' : ''}${fmt(c.remaining)} <small>${c.unit}</small></div></div><small>已使用 ${fmt(c.used)} / 总额 ${fmt(c.total)}</small></div>${packs.map((p) => `<div class="pkg"><div>${esc(p.display_desc || p.group_name || '额度包')}<small>${p.expire_time ? '有效期至 ' + new Date(p.expire_time * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '跟随官方账期'}</small></div><strong>${fmt(c.unit === 'USD' ? (p.entitlement_base_info?.quota?.basic_usage_limit ?? null) : (p.entitlement_base_info?.quota?.credits_limit ?? null))} <small>${c.unit}</small></strong></div>`).join('')}${a.snapshot?.errors?.usage ? `<p class="error-text">${esc(a.snapshot.errors.usage)}</p>` : ''}</section>`;
        })
        .join('') ||
      `<div class="panel">${empty('暂无用量数据', '先添加账号，再刷新获取积分和额度。')}</div>`
    }`
  );
}
function tokensPage() {
  const req = state.requests,
    known = req.filter((r) => r.inputTokens !== null),
    input = known.reduce((s, r) => s + r.inputTokens, 0),
    output = known.reduce((s, r) => s + (r.outputTokens || 0), 0);
  return (
    heading(
      'TOKEN ANALYTICS',
      'Token 用量',
      '记录通过本地网关发出的请求，仅统计上游明确返回的真实用量。',
    ) +
    `<div class="metrics">${metric('输入 Token', known.length ? fmt(input) : '—', 'Tokens', '上游 prompt_tokens', 'download')}${metric('输出 Token', known.length ? fmt(output) : '—', 'Tokens', '上游 completion_tokens', 'arrow')}${metric('总请求数', req.length, '次', '含成功与失败请求', 'chart')}${metric('成功请求', req.filter((r) => r.status === 'success').length, '次', `${req.filter((r) => r.status === 'error').length} 次失败`, 'check')}</div><div class="notice">本地 Trae 会话库使用 SQLCipher 加密，目前未解密，客户端历史 Token 尚未接入。未返回 usage 的反代请求显示「未提供」，不会用估算值替代。</div><section class="panel"><div class="panel-header"><h2>逐条请求明细</h2><small>最近 ${req.length} 条 / 最多保留 1,000 条</small></div>${requestsTable()}</section>`
  );
}
function requestsTable() {
  return state.requests.length
    ? `<div class="table-wrap"><table><thead><tr><th>请求时间</th><th>模型 / 版本</th><th>输入</th><th>输出</th><th>耗时</th><th>状态</th></tr></thead><tbody>${state.requests
        .slice(0, 100)
        .map(
          (r) =>
            `<tr><td>${date(r.time)} ${clock(r.time)}</td><td>${esc(r.model)}<small>真实：${esc(r.realModel || r.model)}</small> <span class="pill">${r.variant === 'cn' ? 'CN' : 'INTL'}</span></td><td>${r.inputTokens === null ? '未提供' : fmt(r.inputTokens)}</td><td>${r.outputTokens === null ? '未提供' : fmt(r.outputTokens)}</td><td>${fmt(r.duration)} ms</td><td><span class="badge ${r.status === 'error' ? 'warning' : ''}">${r.status === 'success' ? '成功' : '失败'}</span>${r.error ? `<p class="error-text">${esc(r.error)}</p>` : ''}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : empty('等待第一条请求', '启动模型反代后，请求与用量将在这里显示');
}
function checkedToday(a) {
  return a.checkin?.checked_in && a.checkin.time && date(a.checkin.time) === date(new Date());
}
function checkinPage() {
  const cn = state.accounts.filter((a) => a.variant === 'cn');
  return (
    heading(
      'DAILY REWARDS',
      '每日签到',
      '每一天的小积累。国内版签到状态由官方服务端确认。',
      `<button class="primary" data-action="checkin-all">${icon('calendar')}签到全部国内账号</button>`,
    ) +
    `<div class="notice green">国际版当前没有相同签到入口；启动时补签，此后每 10 分钟检查一次；按北京时间判断签到日，需要保持工作台运行。</div>${cn.map((a) => `<section class="panel"><div class="panel-header"><h2>${esc(a.note || a.username)} <span class="pill">国内版</span></h2><span class="badge ${checkedToday(a) ? '' : 'warning'}">${checkedToday(a) ? '今日已签到' : a.checkin ? '待签到' : '等待查询'}</span></div><div class="checkin-card"><div class="checkin-day"><strong>${a.checkin?.credits ?? '—'}</strong><small>CREDITS</small></div><div class="flex-grow"><h3>${checkedToday(a) ? '今日奖励已领取' : '领取每日积分奖励'}</h3><p>${a.checkin ? '最后查询于 ' + date(a.checkin.time) + ' ' + clock(a.checkin.time) : '点击签到将先检查服务端状态，已领取时不会重复请求。'}</p></div><button class="primary" data-action="checkin" data-id="${a.id}">${icon('calendar')}检查并签到</button></div><div class="settings-row"><div><h3>自动签到</h3><p>工作台运行期间定期检查，不参加抽奖。</p></div><button class="toggle ${a.autoCheckin ? 'on' : ''}" data-action="toggle-checkin" data-id="${a.id}" aria-label="自动签到" aria-pressed="${a.autoCheckin}"></button></div></section>`).join('') || `<section class="panel">${empty('添加一个国内版账号', '签到功能适用于 Trae CN', addButton)}</section>`}` +
    `<section class="panel"><div class="panel-header"><h2>签到记录</h2></div><div class="table-wrap"><table><thead><tr><th>时间</th><th>账号</th><th>触发方式</th><th>结果</th></tr></thead><tbody>${
      (state.checkinHistory || [])
        .slice(0, 50)
        .map(
          (r) =>
            `<tr><td>${date(r.time)} ${clock(r.time)}</td><td>${esc(r.accountName)}</td><td>${r.source === 'auto' ? '自动' : '手动'}</td><td>${r.status === 'already' ? '已领取' : r.status === 'success' ? '签到成功' : esc(r.error)}</td></tr>`,
        )
        .join('') || '<tr><td colspan="4">暂无签到记录</td></tr>'
    }</tbody></table></div></section>`
  );
}
function gatewayPage() {
  const settings = state.settings,
    region = settings.gatewayVariant || 'all',
    accounts = state.accounts.filter((a) => region === 'all' || a.variant === region);
  const selected = settings.gatewayAccountIds?.[region] || '';
  const base = `http://127.0.0.1:${settings.gatewayPort}/${region === 'all' ? '' : region + '/'}v1`;
  return (
    heading(
      'LOCAL MODEL GATEWAY',
      '模型反代',
      '按真实模型匹配国内与国际账号，共有模型跨区调度，独有模型自动限定账号池。',
      `<button class="${settings.gatewayRunning ? '' : 'primary'}" data-action="toggle-gateway">${icon('proxy')}${settings.gatewayRunning ? '停止服务' : '启动服务'}</button>`,
    ) +
    `<div class="notice">通过官方 Remote Agent 调用，每次请求结束后自动清理本次创建的临时云端任务；清理失败自动重试，不处理已有云端会话。请求记录保留在本机。支持 Chat Completions 与 Claude Code Messages，工具由调用客户端执行，目前仅支持文本。Responses 尚未接入。</div>
 <div class="split"><section class="panel"><div class="panel-header"><h2>服务连接</h2><span class="badge ${settings.gatewayRunning ? '' : 'warning'}">${settings.gatewayRunning ? '运行中' : '已停止'}</span></div>
 <div class="field"><label for="gateway-region">使用地区</label><select id="gateway-region"><option value="all" ${region === 'all' ? 'selected' : ''}>双区联合 · 国内 + 国际</option><option value="cn" ${region === 'cn' ? 'selected' : ''}>国内版 · Trae CN</option><option value="intl" ${region === 'intl' ? 'selected' : ''}>国际版 · Trae</option></select><p>统一 /v1 跟随此配置；/cn/v1 与 /intl/v1 始终限定对应地区。</p></div>
 <div class="field"><label>Base URL · ${region === 'all' ? '双区联合' : region === 'cn' ? '国内版' : '国际版'}</label><div class="key-line"><code>${base}</code><button data-action="copy-url">${icon('copy')}复制</button></div></div>
 <div class="field"><label>API Key</label><div class="key-line key-controls"><code>${esc(settings.keyHint)}</code><button data-action="copy-key">${icon('copy')}复制</button><button data-action="edit-key">编辑</button><button data-action="random-key">${icon('refresh')}随机生成</button></div><p>两地区共享本地认证密钥。保存或随机生成后，旧密钥立即失效。</p></div>
 <div class="field"><label for="gateway-account">${region === 'all' ? '双区联合' : region === 'cn' ? '国内版' : '国际版'}账号池</label><select id="gateway-account"><option value="">所有匹配模型的有效账号</option>${accounts.map((a) => `<option value="${esc(a.id)}" ${selected === a.id ? 'selected' : ''}>${esc(a.note || a.username)}${a.tokenExpired ? ' · 已过期' : ''}</option>`).join('')}</select><p>指定账号时仅使用该账号；所有账号模式按模型目录和地区设置筛选。</p></div>
 <div class="field"><label for="gateway-mode">账号调度模式</label><select id="gateway-mode"><option value="round-robin" ${!settings.gatewayMode || settings.gatewayMode === 'round-robin' ? 'selected' : ''}>顺序轮询 · 每次请求使用下一个匹配账号</option><option value="priority" ${settings.gatewayMode === 'priority' ? 'selected' : ''}>顺序优先 · 使用第一个匹配账号</option><option value="random" ${settings.gatewayMode === 'random' ? 'selected' : ''}>随机 · 随机选择匹配账号</option></select><p>一次请求调用一个账号；不自动重放已经发送的上游请求。</p></div>
 <div class="field"><label for="gateway-port">监听端口</label><input id="gateway-port" type="number" min="1024" max="65535" value="${settings.gatewayPort}" ${settings.gatewayRunning ? 'disabled' : ''}></div><button data-action="save-gateway">保存配置</button></section>
 <section class="panel"><div class="panel-header"><h2>快速接入</h2><small>${region === 'all' ? '双区联合' : region === 'cn' ? '国内版' : '国际版'} · Chat Completions</small></div><pre>curl ${base}/chat/completions &#92;
  -H 'Authorization: Bearer YOUR_API_KEY' &#92;
  -H 'Content-Type: application/json' &#92;
  -d '{
    "model": "auto",
    "stream": true,
    "messages": [
      {"role":"user","content":"你好"}
    ]
  }'</pre><p>GET ${base}/models 返回所选账号池模型；Claude Code 的 ANTHROPIC_BASE_URL 请使用不带 /v1 的地址：${base.replace(/\/v1$/, '')}；SDK 自动追加 /v1/messages。升级后请查询当前地区目录，清理已下线的缓存模型。</p><div class="notice green">国内：/${'cn'}/v1<br>国际：/intl/v1<br>双区联合：/v1（选择上方双区联合模式）</div></section></div>
 <section class="panel"><div class="panel-header"><h2>${region === 'all' ? '双区联合' : region === 'cn' ? '国内版' : '国际版'}模型目录</h2><button data-action="models-all">${icon('refresh')}查询当前地区目录</button></div><div id="model-results">${routingCatalogHtml()}</div></section>`
  );
}
function requestRows() {
  const query = requestView.query.trim().toLowerCase();
  return state.requests.filter(
    (r) =>
      (requestView.region === 'all' || r.variant === requestView.region) &&
      (requestView.status === 'all' || r.status === requestView.status) &&
      (!query ||
        [
          r.id,
          r.model,
          r.realModel,
          r.accountName,
          state.accounts.find((a) => a.id === r.accountId)?.note,
          state.accounts.find((a) => a.id === r.accountId)?.username,
        ].some((x) =>
          String(x || '')
            .toLowerCase()
            .includes(query),
        )),
  );
}
function requestsPage() {
  const rows = requestRows(),
    size = 25,
    pages = Math.max(1, Math.ceil(rows.length / size));
  requestView.page = Math.min(requestView.page, pages);
  const visible = rows.slice((requestView.page - 1) * size, requestView.page * size);
  const statuses = { success: '成功', error: '失败', cancelled: '已取消', pending: '处理中' };
  const table = visible.length
    ? `<div class="table-wrap"><table class="requests-table"><thead><tr><th>时间</th><th>模型</th><th>调用账号</th><th>Token 消耗</th><th>协议</th><th>状态</th><th>耗时</th><th>结果</th><th>操作</th></tr></thead><tbody>${visible
        .map((r) => {
          const account = state.accounts.find((a) => a.id === r.accountId),
            name = account?.note || r.accountName || account?.username || '未选择账号';
          const complete =
            r.inputTokens !== null &&
            r.inputTokens !== undefined &&
            r.outputTokens !== null &&
            r.outputTokens !== undefined;
          return `<tr><td class="request-time">${new Date(r.time).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}<small>${date(r.time)}</small></td><td class="request-model">${esc(r.model || '—')}<small>真实：${esc(r.realModel || r.model || '—')}</small></td><td>${esc(name)}<small>${r.variant === 'cn' ? '国内版' : '国际版'}</small></td><td><strong class="token-total">${complete ? fmt(r.inputTokens + r.outputTokens) : '未提供'}</strong><small>入 ${fmt(r.inputTokens)} / 出 ${fmt(r.outputTokens)}</small></td><td>${esc(r.protocol || 'Chat Completions')}${r.stream ? '<small>SSE 流式</small>' : ''}</td><td><span class="status-code ${r.status === 'success' ? 'ok' : r.status === 'pending' ? 'pending' : 'failed'}">${r.httpStatus ?? '—'}</span></td><td class="request-time">${r.duration === undefined ? (r.status === 'pending' ? Math.max(0, Math.floor((Date.now() - Date.parse(r.time)) / 1000)) + ' s' : '—') : fmt(r.duration) + ' ms'}</td><td>${statuses[r.status] || '未知'}${r.status === 'pending' && r.transport === 'Local' ? '<small>' + esc(localStageLabel(r.localStage)) + '</small>' : ''}</td><td><button class="quiet request-detail" data-action="request-detail" data-id="${esc(r.id)}">详情</button></td></tr>`;
        })
        .join('')}</tbody></table></div>`
    : empty('暂无匹配的请求记录', '通过当前网关发起请求后，会在这里记录真实运行元数据。');
  return (
    heading(
      'WORKSPACE / REQUESTS',
      '请求记录',
      '定位每一次请求的去向，国内与国际分别追踪。',
      `<button data-action="refresh-records">${icon('refresh')}刷新记录</button>`,
    ) +
    `<div class="notice green">${icon('shield')} 不保存请求正文、生成内容或认证令牌。仅保留最近 1,000 条运行元数据，随账号库加密保存在本机。</div>
 <section class="panel requests-panel"><div class="request-toolbar"><div class="request-filters"><select id="request-region" aria-label="请求地区">${[
   ['all', '全部地区'],
   ['cn', '国内版'],
   ['intl', '国际版'],
 ]
   .map(
     ([v, t]) => `<option value="${v}" ${requestView.region === v ? 'selected' : ''}>${t}</option>`,
   )
   .join('')}</select><select id="request-status" aria-label="请求结果">${[
   ['all', '全部结果'],
   ['success', '成功'],
   ['error', '失败'],
   ['cancelled', '已取消'],
   ['pending', '处理中'],
 ]
   .map(
     ([v, t]) => `<option value="${v}" ${requestView.status === v ? 'selected' : ''}>${t}</option>`,
   )
   .join(
     '',
   )}</select><input id="request-search" value="${esc(requestView.query)}" placeholder="搜索模型、账号或请求 ID" aria-label="搜索请求记录"><button data-action="filter-records">${icon('search')}筛选</button></div><span class="subtle">${rows.length} 条记录</span></div>${table}<div class="pagination"><span>第 ${requestView.page} / ${pages} 页 · 每页 ${size} 条</span><div class="actions"><button data-action="requests-prev" ${requestView.page === 1 ? 'disabled' : ''}>上一页</button><button data-action="requests-next" ${requestView.page === pages ? 'disabled' : ''}>下一页</button></div></div></section>`
  );
}
function localStageLabel(stage) {
  return (
    {
      loading_models: '读取模型目录',
      starting_runtime: '启动本地通道',
      waiting_model: '等待模型响应',
      generating: '模型生成中',
      completed: '生成完成',
    }[stage] || '—'
  );
}
function requestDetail(id) {
  const r = state.requests.find((x) => x.id === id);
  if (!r) {
    toast('请求记录已不在保留范围');
    return;
  }
  const account = state.accounts.find((a) => a.id === r.accountId);
  const fields = [
    ['请求 ID', r.id],
    [
      '时间',
      new Date(r.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    ],
    ['地区', r.variant === 'cn' ? '国内版' : '国际版'],
    ['调用账号', account?.note || r.accountName || account?.username || '未选择账号'],
    ['对外模型 / 别名', r.model || '—'],
    ['真实模型', r.realModel || r.model || '—'],
    ['上游配置 ID', r.modelConfig || '—'],
    ['客户端请求名称', r.requestedModel || r.model || '—'],
    ['调度模式', r.accountMode || '—'],
    ['请求范围', r.routingScope || r.variant],
    ['协议', r.protocol || 'Chat Completions'],
    ['方法 / 路径', `${r.method || 'POST'} ${r.path || '/v1/chat/completions'}`],
    ['HTTP 状态', r.httpStatus ?? '未提供'],
    ['上游 HTTP', r.upstreamStatus ?? '未请求'],
    [
      '反代通道',
      r.transport === 'Local' ? '本地会话' : r.transport === 'Remote' ? '云端任务' : '—',
    ],
    ['本地处理阶段', localStageLabel(r.localStage)],
    ['最后上游事件', r.lastUpstreamEvent || '—'],
    [
      '最近进展',
      r.lastProgressAt
        ? new Date(r.lastProgressAt).toLocaleTimeString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false,
          })
        : '—',
    ],
    [
      '临时云端任务',
      {
        pending: '等待清理',
        deleted: '已清理',
        failed: '清理失败，将自动重试',
        not_applicable: '本地会话，无云端任务',
      }[r.cloudSessionCleanup] || '历史记录，未自动清理',
    ],
    ['清理错误', r.cloudCleanupError || '—'],
    ['输入 Token', fmt(r.inputTokens)],
    ['输出 Token', fmt(r.outputTokens)],
    ['耗时', r.duration === undefined ? '—' : r.duration + ' ms'],
    [
      '结果',
      { success: '成功', error: '失败', pending: '处理中', cancelled: '已取消' }[r.status] ||
        r.status,
    ],
    ['错误代码', r.errorCode || '—'],
    ['错误说明', r.error || '—'],
  ];
  showDialog(
    '请求详情',
    `<dl class="request-fields">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><p>详情仅包含运行元数据，不包含输入与输出正文。</p>`,
  );
}
function routingCatalogHtml() {
  return `<div class="table-wrap"><table><thead><tr><th>对外别名</th><th>真实模型</th><th>可用地区 / 账号</th><th>允许路由</th><th>操作</th></tr></thead><tbody>${(state.modelCatalog || []).map((m) => `<tr><td><strong>${esc(m.alias)}</strong></td><td><code>${esc(m.id)}</code></td><td>${m.regions.map((r) => (r === 'cn' ? '国内' : '国际')).join(' / ')} · ${m.accountIds.length} 个账号</td><td>${m.allowedRegions.map((r) => (r === 'cn' ? '国内' : '国际')).join(' / ')}</td><td><button data-action="edit-model" data-id="${esc(m.id)}">编辑别名 / 地区</button></td></tr>`).join('') || '<tr><td colspan="5">请先采集账号或刷新目录</td></tr>'}</tbody></table></div><p>目录记录每个账号的真实模型和配置 ID；别名用于对外 /models 和响应，旧名称仍可请求。允许地区只筛选已提供该模型的账号。</p>`;
}
function diagnosticsPage() {
  return (
    heading(
      'RUNTIME DIAGNOSTICS',
      '运行诊断',
      '客户端兼容性、接口错误与本地操作记录。',
      refreshButton,
    ) +
    `<div class="token-grid"><section class="panel"><div class="panel-header"><h2>接入状态</h2></div>${[
      ['账号解码', '两版已实测'],
      ['积分 / 额度', '官方接口已实测'],
      ['国内版签到', '状态接口已实测'],
      ['本地历史 Token', 'SQLCipher 加密，待接入'],
      ['模型反代', '原生协议适配中'],
    ]
      .map(
        ([k, v]) =>
          `<div class="settings-row"><span>${k}</span><span class="subtle">${v}</span></div>`,
      )
      .join('')}</section><section class="panel"><div class="panel-header"><h2>接口诊断</h2></div>${
      state.accounts
        .map(
          (a) =>
            `<h3>${esc(a.note || a.username)}</h3>${
              Object.entries(a.snapshot?.errors || {})
                .map(([k, v]) => `<p class="error-text">${esc(k)} · ${esc(v)}</p>`)
                .join('') || `<p>${a.snapshot ? '最近一次官方用量刷新无错误' : '尚未刷新接口'}</p>`
            }<div class="spacer"></div>`,
        )
        .join('') || empty('暂无诊断', '采集账号后可检查接口状态')
    }</section></div><section class="panel"><div class="panel-header"><h2>操作日志</h2><small>最近 200 条 · 不记录凭证明文</small></div>${state.events.map((e) => `<div class="activity"><div class="activity-icon">${icon(e.type === 'error' ? 'pulse' : 'check')}</div><div class="activity-text"><p>${esc(e.message)}</p><small>${esc(e.type)}</small></div><time>${date(e.time)} ${clock(e.time)}</time></div>`).join('') || empty('暂无日志', '操作记录会显示在这里。')}</section>`
  );
}
let updateState = { status: 'idle', downloaded: 0, total: 0, info: null };
const desktopUpdates = window.desktopUpdates;
const updateLabels = {
  idle: '随时检查新版本',
  checking: '正在检查更新…',
  unpublished: '尚未发布正式版本',
  latest: '当前已是最新版本',
  available: '发现新版本',
  downloading: '正在下载更新…',
  ready: '更新已下载并校验',
  installing: '正在安装，应用即将重启…',
  cancelled: '下载已取消',
  error: '更新操作失败',
};
function aboutPage() {
  const info = state.app;
  const update = updateState;
  const release = update.info;
  const busy = ['checking', 'downloading', 'installing'].includes(update.status);
  const tile = (ico, title, desc, href) =>
    `<a class="about-tile" href="${esc(href)}" target="_blank" rel="noreferrer"><span class="about-tile-icon">${icon(ico)}</span><span><strong>${title}</strong><small>${desc}</small></span>${icon('arrow')}</a>`;
  return `<section class="about-page"><div class="about-hero"><img src="/icon.svg" alt="Trae Switch"><span class="eyebrow">你的本地 AI 账号工作台</span><h1>${esc(info.name)}</h1><div class="about-badges"><strong>v${esc(info.version)}</strong><a href="${esc(info.repository)}" target="_blank" rel="noreferrer">${icon('code')} GitHub</a></div><p>把账号切换、积分签到、用量统计和模型服务，收进一个清爽的桌面工作台。</p></div><div class="about-grid">${tile('users', '作者主页', '访问 vs2pk0 的 GitHub 主页', info.author)}${tile('code', '开源仓库', '查看源码、版本和发布记录', info.repository)}${tile('leaf', '赞助支持', '了解作者的项目支持方式', 'https://github.com/vs2pk0/codex-switcher/blob/main/doc/sponsor.md')}${tile('pulse', '问题反馈', '提交 Issue 或改进建议', info.feedback)}</div><section class="panel update-panel" aria-live="polite"><div class="panel-header"><div><h2>${icon('refresh')} 检查更新</h2><p>${esc(updateLabels[update.status] || '检查更新')}${release?.hasUpdate ? ' · v' + esc(release.version) : ''}</p></div><button data-action="check-update" ${busy ? 'disabled' : ''}>${icon('refresh')}重新检查</button></div>${release?.hasUpdate ? `<p>当前 v${esc(info.version)} → 最新 v${esc(release.version)} · ${esc(update.target || release.target)}</p>${release.notes ? `<details><summary>查看更新说明</summary><pre class="release-notes">${esc(release.notes)}</pre></details>` : ''}` : ''}${update.status === 'unpublished' ? '<p class="subtle">正式版本发布到 GitHub Releases 后，就可以在这里获取更新。</p>' : ''}${update.previousFailure ? `<p class="update-error">${esc(update.previousFailure)}</p>` : ''}${update.error ? `<p class="update-error">${esc(update.error)}</p>` : ''}${['downloading', 'ready', 'installing'].includes(update.status) ? `<progress max="${update.total || 1}" value="${update.downloaded}" aria-label="更新下载进度"></progress><p class="subtle">${fmt(update.downloaded / 1048576, 1)} / ${fmt(update.total / 1048576, 1)} MB${update.total ? ' · ' + Math.floor((update.downloaded / update.total) * 100) + '%' : ''}</p>` : ''}<div class="actions">${release?.hasUpdate && desktopUpdates && update.canInstall && release.canDownload && ['available', 'cancelled', 'error'].includes(update.status) ? '<button class="primary" data-action="download-update">下载更新</button>' : ''}${update.status === 'downloading' ? '<button data-action="cancel-update">取消下载</button>' : ''}${update.status === 'ready' ? '<button class="primary" data-action="install-update">安装并重新启动</button>' : ''}<a class="about-release-link" href="${esc(release?.releaseUrl || info.releases)}" target="_blank" rel="noreferrer">查看发布页面 →</a></div>${!desktopUpdates || !update.canInstall ? '<p class="subtle">' + esc(update.installUnavailableReason || '当前为浏览器或开发模式，可检查版本；应用内安装请使用打包后的桌面版。') + '</p>' : '<p class="subtle">启动时自动检查版本；下载与安装由你手动确认。更新保留本机账号和设置。</p>'}</section></section>`;
}
async function updateAction(action) {
  if (action === 'install-update') {
    showDialog(
      '安装更新',
      '<p>应用将退出，安装已校验的新版并重新启动。请先完成正在进行的请求并保存工作。</p>',
      '<button class="primary" data-action="confirm-install-update">安装并重启</button>',
    );
    return;
  }
  if (action === 'confirm-install-update') modal.close();
  try {
    if (action === 'check-update') {
      updateState = { ...updateState, status: 'checking', error: null };
      render();
    }
    if (action === 'check-update')
      updateState = desktopUpdates ? await desktopUpdates.check() : await api('update/check', {});
    if (action === 'download-update') updateState = await desktopUpdates.download();
    if (action === 'cancel-update') updateState = await desktopUpdates.cancel();
    if (action === 'confirm-install-update') updateState = await desktopUpdates.install();
  } catch (error) {
    toast(error.message);
  }
  if (page === 'about') render();
}
if (desktopUpdates) {
  desktopUpdates
    .state()
    .then((value) => {
      updateState = value;
      if (state && page === 'about') render();
    })
    .catch(() => {});
  desktopUpdates.onChange((value) => {
    const previous = updateState.status;
    updateState = value;
    if (state && page === 'about') render();
    else if (value.status === 'available' && previous !== 'available')
      toast('发现新版 v' + value.info.version + '，可在“关于应用”中更新');
  });
}

function settingsPage() {
  return (
    heading('PREFERENCES', '偏好设置', '本地优先，保持简单。') +
    `<section class="panel"><div class="settings-row"><div><h3>数据存储</h3><p>账号库使用 AES-256-GCM 加密，文件保存在 ~/.trae-switch/，密钥文件权限为 0600。</p></div>${icon('shield')}</div><div class="settings-row"><div><h3>时区</h3><p>Asia/Shanghai · 中国标准时间（UTC+8）</p></div><span class="pill">北京时间</span></div><div class="settings-row"><div><h3>数据口径</h3><p>官方积分与美元额度分开展示；Token 缺失时不估算。</p></div>${icon('chart')}</div><div class="settings-row"><div><h3>Trae Switch</h3><p>${esc(state.app.version)} · 本地账号与用量工作台</p></div><span class="pill">LOCAL FIRST</span></div></section>`
  );
}
function render() {
  if (page === 'sessions') {
    page = 'overview';
    history.replaceState(null, '', '#overview');
  }
  if (!state) return;
  const current =
    pages.find((x) => x[0] === page) ||
    (page === 'about' ? ['about', 'leaf', '关于应用'] : ['settings', 'settings', '偏好设置']);
  const renderers = {
    overview,
    accounts: accountsPage,
    credits: creditsPage,
    tokens: tokensPage,
    checkin: checkinPage,
    gateway: gatewayPage,
    requests: requestsPage,
    diagnostics: diagnosticsPage,
    settings: settingsPage,
    about: aboutPage,
  };
  app.innerHTML = `<div class="shell"><aside><div class="brand"><img class="brand-icon" src="/icon.svg" alt="Trae Switch 图标"><div>Trae Switch<small>ACCOUNT WORKSPACE</small></div></div><div class="navlabel">工作空间</div><nav class="nav">${pages.map(([id, i, title]) => `<button class="${page === id ? 'active' : ''}" data-page="${id}">${icon(i)}<span class="navtext">${title}</span>${id === 'accounts' ? `<span class="count">${state.accounts.length}</span>` : ''}</button>`).join('')}</nav><div class="sidebar-bottom"><nav class="nav"><button data-page="about" class="${page === 'about' ? 'active' : ''}">${icon('leaf')}<span>关于应用</span></button><button data-page="settings" class="${page === 'settings' ? 'active' : ''}">${icon('settings')}<span>偏好设置</span></button></nav><div class="local-status"><strong><span class="dot"></span>本地服务已连接</strong><br>数据保存在你的设备上<br><span class="subtle">Trae Switch v${esc(state.app.version)}</span></div></div></aside><div class="workspace"><header class="topbar"><div class="crumb">${icon('grid')}<span>工作空间</span><span>/</span><b>${current[2]}</b></div><div class="top-right"><span class="subtle">${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })}</span><span class="dot"></span><div class="avatar">T</div></div></header><main class="content">${(renderers[page] || overview)()}<footer class="bottom-note"><span><span class="dot"></span>本地连接 · 凭证加密存储</span><span>为专注而设计。 SWITCH / 01</span></footer></main></div></div>`;
}
function showDialog(title, body, buttons = '') {
  modal.innerHTML = `<h2>${title}</h2><div class="dialog-body">${body}</div><div class="modal-actions"><button data-action="close-modal">关闭</button>${buttons}</div>`;
  modal.showModal();
}
function versionChoices(action) {
  return ['cn', 'intl']
    .map(
      (v) =>
        `<button class="choice" data-action="${action}" data-variant="${v}">${icon(v === 'cn' ? 'leaf' : 'globe')}<div><strong>${v === 'cn' ? 'Trae CN 国内版' : 'Trae 国际版'}</strong><small>${action === 'capture' ? '读取本机客户端当前登录态' : '打开官方登录页，账号独立保存'}</small></div>${icon('arrow')}</button>`,
    )
    .join('');
}
async function batch(action) {
  if (!state.accounts.length) throw new Error('请先添加账号');
  let ok = 0,
    failed = 0;
  for (const a of state.accounts) {
    if (action === 'checkin' && a.variant !== 'cn') continue;
    try {
      await api(action, { id: a.id });
      ok++;
    } catch {
      failed++;
    }
  }
  await sync();
  toast(`完成 ${ok} 个账号${failed ? `，${failed} 个失败，请查看诊断` : ''}`);
}
document.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-page]');
  if (nav) {
    page = nav.dataset.page;
    location.hash = page;
    filter = 'all';
    render();
    return;
  }
  const tab = e.target.closest('[data-filter]');
  if (tab) {
    filter = tab.dataset.filter;
    render();
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const { action, id, variant } = el.dataset;
  const a = state?.accounts.find((x) => x.id === id);
  if (
    [
      'check-update',
      'download-update',
      'cancel-update',
      'install-update',
      'confirm-install-update',
    ].includes(action)
  ) {
    await updateAction(action);
    return;
  }
  if (action === 'request-detail') {
    requestDetail(id);
    return;
  }
  if (action === 'credit-packs') {
    const packs = a.creditPacks || [];
    showDialog(
      '全部积分包 · ' + (a.note || a.username),
      `<p>北京时间 · 显示官方积分包剩余余额，含已用完或到期的包。</p>${packs.length ? packRows(packs) : '<p>暂无积分包数据，请刷新用量。</p>'}`,
    );
    return;
  }
  if (action === 'edit-model') {
    const m = state.modelCatalog.find((m) => m.id === id);
    showDialog(
      '模型别名与路由',
      `<p>真实模型：${esc(m.id)}</p><div class="field"><label>对外别名</label><input id="model-alias" value="${esc(m.alias)}" maxlength="128"></div><div class="field"><label>允许地区</label><select id="model-regions"><option value="cn,intl" ${m.allowedRegions.length === 2 ? 'selected' : ''}>国内 + 国际（按实际目录匹配）</option><option value="cn" ${m.allowedRegions.join() === 'cn' ? 'selected' : ''}>仅国内</option><option value="intl" ${m.allowedRegions.join() === 'intl' ? 'selected' : ''}>仅国际</option></select></div><button class="primary" data-action="save-model" data-id="${esc(id)}">保存</button>`,
    );
    return;
  }
  if (action === 'edit-key') {
    showDialog(
      '编辑 API Key',
      `<div class="field"><label for="edit-api-key">新 API Key</label><input id="edit-api-key" type="password" autocomplete="off" spellcheck="false" minlength="16" maxlength="128" placeholder="16–128 位字母、数字或 . _ ~ -"></div><p>保存后旧密钥立即失效。正在执行的请求不受影响，客户端下次请求须更新密钥。</p>`,
      `<button class="primary" data-action="save-key">保存密钥</button>`,
    );
    return;
  }
  if (action === 'filter-records') {
    requestView = {
      region: document.querySelector('#request-region').value,
      status: document.querySelector('#request-status').value,
      query: document.querySelector('#request-search').value,
      page: 1,
    };
    render();
    return;
  }
  if (action === 'requests-prev' || action === 'requests-next') {
    requestView.page += action === 'requests-prev' ? -1 : 1;
    render();
    return;
  }
  if (action === 'close-modal') {
    modal.close();
    return;
  }
  if (action === 'add') {
    showDialog(
      '添加一个账号',
      `<p>通过官方浏览器登录添加，或从本机已登录客户端采集。</p><div class="spacer"></div>${versionChoices('login')}<button class="choice" data-action="capture-choice">${icon('download')}采集本机账号</button><button class="quiet subtle" data-action="import-dialog">导入已有账号 JSON</button>`,
    );
    return;
  }
  if (action === 'capture-choice') {
    if (modal.open) modal.close();
    showDialog(
      '采集本机账号',
      `<p>读取所选版本当前的登录态，仅写入本工具账号库。</p><div class="spacer"></div>${versionChoices('capture')}`,
    );
    return;
  }
  if (action === 'account-menu') {
    showDialog(
      '账号设置',
      `<div class="field"><label>备注名称</label><input id="account-note" maxlength="120" value="${esc(a.note)}" placeholder="为账号设置容易辨认的名称"></div><div class="field"><label>账号最大并发</label><input id="account-concurrency" type="number" min="1" max="32" value="${a.concurrencyLimit}"></div><p>登录凭证到期：${esc(a.expiredAt)}</p><p>刷新凭证到期：${esc(a.refreshExpiredAt)}</p><div class="spacer"></div><button data-action="token" data-id="${id}">${icon('key')}刷新登录凭证</button>`,
      `<button class="primary" data-action="save-note" data-id="${id}">保存设置</button>`,
    );
    return;
  }
  if (action === 'import-dialog') {
    modal.close();
    showDialog(
      '导入账号 JSON',
      `<div class="field"><label>客户端版本</label><select id="import-variant"><option value="cn">国内版</option><option value="intl">国际版</option></select></div><div class="field"><label>完整登录态 JSON（userId / token / account）</label><textarea id="import-json" spellcheck="false" placeholder="粘贴账号 JSON"></textarea></div>`,
      `<button class="primary" data-action="import">导入账号</button>`,
    );
    return;
  }
  el.disabled = true;
  try {
    if (
      action.startsWith('session-') ||
      [
        'refresh-sessions',
        'native-session-select',
        'filter-sessions',
        'sessions-prev',
        'sessions-next',
      ].includes(action)
    ) {
      await sessionAction(action, id);
      return;
    }
    if (action === 'capture') {
      await api('capture', { variant });
      if (modal.open) modal.close();
      await sync();
      toast('账号已采集，可刷新官方用量');
    } else if (action === 'login') {
      await api('login', { variant });
      modal.close();
      toast('已打开官方登录页，请在浏览器中完成登录');
    } else if (action === 'launch') {
      await api('launch', { variant });
      toast('客户端已打开');
    } else if (action === 'refresh-all') await batch('refresh');
    else if (action === 'checkin-all') await batch('checkin');
    else if (action === 'refresh') {
      const s = await api('refresh', { id });
      await sync();
      toast(Object.keys(s.errors).length ? '部分接口失败，请查看运行诊断' : '官方用量已刷新');
    } else if (action === 'token') {
      await api('token', { id });
      modal.close();
      await sync();
      toast('登录凭证已刷新并保存');
    } else if (action === 'checkin') {
      const r = await api('checkin', { id });
      let refreshed = true;
      try {
        await api('refresh', { id });
      } catch {
        refreshed = false;
      }
      await sync();
      toast(
        (r.already ? '服务端确认今日已签到' : '签到成功') +
          (refreshed ? '，已刷新积分' : '，积分刷新失败，可稍后手动刷新'),
      );
    } else if (action === 'switch') {
      const result = await api('switch', { id });
      await sync();
      toast(
        '账号已切换，原登录态已备份，客户端已启动' +
          (result.forced ? '（旧客户端已强制退出）' : ''),
      );
    } else if (action === 'save-note') {
      await api('account', {
        id,
        note: document.querySelector('#account-note').value,
        concurrencyLimit: Number(document.querySelector('#account-concurrency').value),
      });
      modal.close();
      await sync();
      toast('账号设置已保存');
    } else if (action === 'toggle-proxy') {
      await api('account', { id, enabled: !a.enabled });
      await sync();
      toast(a.enabled ? '该账号已暂停参与反代' : '该账号已启用反代');
    } else if (action === 'toggle-checkin') {
      await api('account', { id, autoCheckin: !a.autoCheckin });
      await sync();
      toast(a.autoCheckin ? '自动签到已关闭' : '自动签到已开启，工作台运行时自动检查');
    } else if (action === 'import') {
      await api('import', {
        variant: document.querySelector('#import-variant').value,
        account: JSON.parse(document.querySelector('#import-json').value),
      });
      modal.close();
      await sync();
      toast('账号已导入');
    } else if (action === 'toggle-gateway') {
      await api('settings', { gatewayEnabled: !state.settings.gatewayRunning });
      await sync();
      toast(state.settings.gatewayRunning ? '反代服务已启动' : '反代服务已停止');
    } else if (action === 'save-model') {
      await api('model-rule', {
        modelId: id,
        alias: document.querySelector('#model-alias').value,
        regions: document.querySelector('#model-regions').value.split(','),
      });
      modal.close();
      await sync();
      toast('模型别名和路由已保存');
    } else if (action === 'save-gateway') {
      await api('settings', {
        gatewayVariant: state.settings.gatewayVariant,
        gatewayMode: document.querySelector('#gateway-mode').value,
        gatewayCloudMode: true,
        gatewayAccountId: document.querySelector('#gateway-account').value,
        ...(!state.settings.gatewayRunning
          ? { gatewayPort: Number(document.querySelector('#gateway-port').value) }
          : {}),
      });
      await sync();
      toast('反代配置已保存');
    } else if (action === 'copy-url') {
      await navigator.clipboard.writeText(
        `http://127.0.0.1:${state.settings.gatewayPort}/${state.settings.gatewayVariant === 'all' ? '' : state.settings.gatewayVariant + '/'}v1`,
      );
      toast('Base URL 已复制');
    } else if (action === 'save-key') {
      await api('key/update', {
        mode: 'edit',
        apiKey: document.querySelector('#edit-api-key').value,
      });
      modal.close();
      await sync();
      toast('API Key 已更新，旧密钥已失效');
    } else if (action === 'random-key') {
      await api('key/update', { mode: 'random' });
      await sync();
      toast('已随机生成新 API Key，旧密钥已失效；可点击复制');
    } else if (action === 'refresh-records') {
      await sync();
      toast('请求记录已刷新');
    } else if (action === 'copy-key') {
      const r = await api('key', {});
      await navigator.clipboard.writeText(r.apiKey);
      toast('API Key 已复制');
    } else if (action === 'models-all') {
      let failed = 0;
      const region = state.settings.gatewayVariant,
        selected = state.settings.gatewayAccountIds?.[region];
      for (const account of state.accounts.filter(
        (a) => (region === 'all' || a.variant === region) && (!selected || a.id === selected),
      )) {
        try {
          await api('models', { id: account.id });
        } catch {
          failed++;
        }
      }
      await sync();
      toast(failed ? '部分目录查询失败，保留已有缓存' : '当前地区目录已更新');
    }
  } catch (e) {
    toast(e.message);
  } finally {
    el.disabled = false;
  }
});
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'gateway-region') return;
  try {
    await api('settings', { gatewayVariant: e.target.value });
    await sync();
    toast('使用地区已切换，默认 /v1 已更新');
  } catch (error) {
    toast(error.message);
    render();
  }
});
window.addEventListener('hashchange', () => {
  page = location.hash.slice(1) || 'overview';
  render();
  if (page === 'sessions') loadSessions().catch((e) => toast(e.message));
});
app.innerHTML = '<div class="loading">正在连接本地工作台…</div>';
sync().catch((e) => {
  app.innerHTML = `<div class="loading">连接失败：${esc(e.message)}</div>`;
});
setInterval(async () => {
  if (
    loading ||
    modal.open ||
    ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)
  )
    return;
  loading = true;
  try {
    const next = await api('state');
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      state = next;
      render();
    }
  } catch {
  } finally {
    loading = false;
  }
}, 15000);

import crypto from 'node:crypto';
export function modelCatalogView(data) {
  const rows = new Map();
  for (const a of data.accounts)
    for (const m of a.models || []) {
      const real = m.model || m.id;
      if (!real) continue;
      if (!rows.has(real))
        rows.set(real, {
          id: real,
          name: m.name || real,
          regions: [],
          accountIds: [],
          configs: [],
        });
      const row = rows.get(real);
      if (!row.regions.includes(a.variant)) row.regions.push(a.variant);
      if (!row.accountIds.includes(a.id)) row.accountIds.push(a.id);
      if (!row.configs.includes(m.id)) row.configs.push(m.id);
    }
  return [...rows.values()].map((row) => {
    const rule = data.settings.modelRules?.[row.id] || {};
    return { ...row, alias: rule.alias || row.id, allowedRegions: rule.regions || ['cn', 'intl'] };
  });
}
export function updateModelRule(store, body) {
  const rows = modelCatalogView(store.data),
    row = rows.find((m) => m.id === body.modelId);
  if (!row) throw new Error('模型不存在，请刷新目录');
  const alias = String(body.alias || '').trim() || row.id;
  if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(alias) || alias === 'auto')
    throw new Error('别名须为 1–128 位字母、数字或 . _ : / -，不能为 auto');
  if (
    rows.some(
      (m) => m.id !== row.id && (m.alias === alias || m.id === alias || m.configs.includes(alias)),
    )
  )
    throw new Error('别名与其他模型名称冲突');
  if (
    !Array.isArray(body.regions) ||
    !body.regions.length ||
    body.regions.some((r) => !['cn', 'intl'].includes(r))
  )
    throw new Error('至少选择一个可用地区');
  const before = store.data.settings.modelRules;
  store.data.settings.modelRules = {
    ...before,
    [row.id]: { alias, regions: [...new Set(body.regions)] },
  };
  try {
    store.save();
  } catch (e) {
    store.data.settings.modelRules = before;
    throw e;
  }
  return { ok: true };
}
export function resolveModel(data, scope, requested) {
  const rows = modelCatalogView(data);
  const exact = rows.filter((m) => m.alias === requested || m.id === requested);
  const configs = rows.filter((m) => m.configs.includes(requested));
  const matches = exact.length ? exact : configs;
  // Fail closed if refreshed catalogs introduce a conflicting name.
  const row = requested !== 'auto' && matches.length === 1 ? matches[0] : null;
  const pool = data.accounts.filter((a) => {
    const pin = data.settings.gatewayAccountIds?.[scope === 'all' ? 'all' : a.variant];
    return (
      (scope === 'all' || a.variant === scope) &&
      a.enabled !== false &&
      Date.parse(a.user.expiredAt) > Date.now() &&
      (!pin || pin === a.id) &&
      (requested === 'auto' ||
        (row &&
          row.allowedRegions.includes(a.variant) &&
          (a.models || []).some((m) => (m.model || m.id) === row.id)))
    );
  });
  return { row, pool };
}
export function chooseAccount(pool, mode, cursor, key) {
  if (mode === 'random') return pool[crypto.randomInt(pool.length)];
  if (mode === 'priority') return pool[0];
  const n = cursor[key] || 0;
  cursor[key] = n + 1;
  return pool[n % pool.length];
}

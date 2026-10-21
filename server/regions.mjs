export const REGIONS = ['cn', 'intl'];

export function gatewayRegion(settings, explicit) {
  const value = explicit ?? settings.gatewayVariant ?? 'all';
  if (!['all', ...REGIONS].includes(value)) throw new Error('地区必须是双区、国内版或国际版');
  return value;
}

export function regionPool(data, region, model = 'auto') {
  const selected = data.settings.gatewayAccountIds?.[region] || '';
  return data.accounts.filter(
    (a) =>
      a.variant === region &&
      a.enabled !== false &&
      Date.parse(a.user.expiredAt) > Date.now() &&
      (!selected || a.id === selected) &&
      (model === 'auto' || (a.models || []).some((m) => m.id === model)),
  );
}

export function regionModels(data, region) {
  return [...new Set(regionPool(data, region).flatMap((a) => (a.models || []).map((m) => m.id)))];
}

export function migrateSettings(data) {
  const settings = data.settings;
  const legacy = data.accounts.find((a) => a.id === settings.gatewayAccountId);
  settings.gatewayVariant = ['all', ...REGIONS].includes(settings.gatewayVariant)
    ? settings.gatewayVariant
    : legacy?.variant || 'all';
  settings.gatewayAccountIds = { all: '', cn: '', intl: '', ...settings.gatewayAccountIds };
  if (legacy && !settings.gatewayAccountIds[legacy.variant])
    settings.gatewayAccountIds[legacy.variant] = legacy.id;
  delete settings.gatewayAccountId;
}

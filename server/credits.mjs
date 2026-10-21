// Normalize official entitlement packs without mixing credit and dollar balances.
export function creditPacks(a, now = Date.now()) {
  if (a.variant !== 'cn') return [];
  return (a.snapshot?.usage?.user_entitlement_pack_list || [])
    .flatMap((p) => {
      const base = p.entitlement_base_info || {};
      const total = base.quota?.credits_limit;
      if (p.is_hide || !Number.isFinite(total) || total <= 0) return [];
      const used = p.usage?.credits_amount ?? 0;
      if (!Number.isFinite(used) || used < 0) return [];
      const seconds = p.expire_time || base.end_time;
      const expiresAt =
        Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
      const remaining = Math.max(0, total - used);
      return [
        {
          name:
            p.display_desc ||
            p.group_name ||
            base.product_extra?.package_extra?.package_name ||
            '积分包',
          total,
          used,
          remaining,
          expiresAt,
          active: remaining > 0 && (!expiresAt || Date.parse(expiresAt) > now),
        },
      ];
    })
    .sort(
      (a, b) =>
        (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) -
        (b.expiresAt ? Date.parse(b.expiresAt) : Infinity),
    );
}

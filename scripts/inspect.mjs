import fs from 'node:fs';
import path from 'node:path';
import { profile, readLocal, hostFor, publicAccount } from '../server/client.mjs';
import { refreshSnapshot } from '../server/api.mjs';
const live = process.argv.includes('--live');
for (const variant of ['cn', 'intl']) {
  try {
    const p = profile(variant),
      a = readLocal(variant);
    const report = {
      variant,
      version: p.product.appVersion,
      loginStateReadable: !!a.user.token,
      hasRefreshToken: !!a.user.refreshToken,
      deviceProofAvailable: !!a.deviceKeys?.privateKeyPEM,
      expiredAt: a.user.expiredAt,
      hosts: { account: hostFor(a, 'account'), usage: hostFor(a), agent: hostFor(a, 'agent') },
      historyDatabase: {
        exists: fs.existsSync(path.join(p.dir, 'ModularData/ai-agent/database.db')),
        format: 'SQLCipher，尚未解密',
      },
    };
    if (live) {
      const s = await refreshSnapshot(a);
      report.live = {
        time: s.time,
        errors: s.errors,
        usageSummary: s.usage?.usage_summary || null,
        checkin: s.checkin
          ? {
              enable: s.checkin.enable,
              checked_in: s.checkin.checked_in,
              credits: s.checkin.credits,
            }
          : null,
      };
    }
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ variant, error: e.message }));
  }
}

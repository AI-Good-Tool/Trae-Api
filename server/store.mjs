import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { migrateSettings } from './regions.mjs';

export class Store {
  constructor(dir = process.env.TRAE_SWITCH_DATA || path.join(os.homedir(), '.trae-switch')) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'vault.enc');
    const keyFile = path.join(dir, 'vault.key');
    if (!fs.existsSync(keyFile))
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = fs.readFileSync(keyFile);
    this.data = {
      accounts: [],
      requests: [],
      events: [],
      settings: {
        gatewayEnabled: false,
        gatewayPort: 19828,
        apiKey: crypto.randomBytes(24).toString('hex'),
      },
    };
    if (fs.existsSync(this.file)) {
      const b = fs.readFileSync(this.file),
        d = crypto.createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      this.data = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]));
    }
    migrateSettings(this.data);
    for (const record of this.data.requests) {
      if (record.status === 'pending') {
        Object.assign(record, {
          status: 'cancelled',
          error: '应用退出时请求尚未完成',
          errorCode: 'app_restarted',
        });
      }
    }
  }
  save() {
    const iv = crypto.randomBytes(12),
      c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const b = Buffer.concat([c.update(JSON.stringify(this.data)), c.final()]);
    fs.writeFileSync(this.file + '.tmp', Buffer.concat([iv, c.getAuthTag(), b]), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  event(type, message) {
    this.data.events.unshift({
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      type,
      message,
    });
    this.data.events = this.data.events.slice(0, 200);
    this.save();
  }
  account(id) {
    const a = this.data.accounts.find((a) => a.id === id);
    if (!a) throw new Error('账号不存在');
    return a;
  }
  upsert(a) {
    if (
      typeof a.user?.userId !== 'string' ||
      !a.user.userId ||
      typeof a.user?.token !== 'string' ||
      !a.user.token ||
      !a.user?.account ||
      typeof a.user.account !== 'object'
    )
      throw new Error('账号数据缺少有效 userId、token 或 account');
    if (!Number.isFinite(Date.parse(a.user.expiredAt)))
      throw new Error('账号缺少有效的 expiredAt 到期时间');
    const old = this.data.accounts.find(
      (x) => x.variant === a.variant && x.user.userId === a.user.userId,
    );
    if (old) Object.assign(old, a, { id: old.id });
    else {
      a.id = crypto.randomUUID();
      this.data.accounts.push(a);
    }
    this.save();
    return old || a;
  }
}

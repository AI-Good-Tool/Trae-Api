import { checkin } from './api.mjs';
export const checkinDay = (time = new Date()) =>
  new Date(time).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
export function checkedToday(a) {
  return !!(a.checkin?.checked_in && a.checkin.time && checkinDay(a.checkin.time) === checkinDay());
}
export class Checkins {
  constructor(store, run = checkin) {
    this.store = store;
    this.run = run;
    this.pending = new Map();
  }
  async execute(a, source = 'manual') {
    if (a.variant !== 'cn') throw new Error('国际版未提供签到接口');
    if (this.pending.has(a.id)) return this.pending.get(a.id);
    const task = (async () => {
      const record = {
        accountId: a.id,
        accountName: a.note || a.user.account.username,
        time: new Date().toISOString(),
        source,
      };
      try {
        const result = await this.run(a);
        Object.assign(record, {
          status: result.already ? 'already' : 'success',
          credits: a.checkin?.credits ?? null,
        });
        return result;
      } catch (e) {
        record.status = 'error';
        record.error = '签到未完成，请检查凭证或官方签到开放状态';
        throw new Error(record.error, { cause: e });
      } finally {
        this.store.data.checkinHistory = [record, ...(this.store.data.checkinHistory || [])].slice(
          0,
          300,
        );
        this.store.save();
      }
    })();
    this.pending.set(a.id, task);
    try {
      return await task;
    } finally {
      this.pending.delete(a.id);
    }
  }
}

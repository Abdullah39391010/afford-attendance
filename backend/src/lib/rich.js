// Snapchat-style alerts with a safety backup.
//  - New apps say "I can draw alerts myself" (rich) when they register their push token.
//  - Rich phones get a data message: the app draws the alert with the person's photo,
//    grouped by person, with Approve / Decline buttons, and tells the server it arrived (ack).
//  - If no ack comes within ACK_WAIT (battery savers can stop the app), the next 5-minute tick
//    sends the same alert as a plain alert that Android shows by itself. Same tag, so never twice.
//  - A phone that misses twice in a row gets plain alerts only, until it acks again.
import { bad, str } from './util.js';

export const ACK_WAIT = 3 * 60 * 1000;
const MISS_LIMIT = 2;

export function installRich(Store) {
  const P = Store.prototype;

  P.richRoutes = function richRoutes(add) {
    add('POST', '/api/push-ack', this.pushAck, { auth: 'none' });
  };

  P.richState = function richState() {
    return this.db.kvGet('richTokens', {}); // token -> { misses }
  };
  P.isRich = function isRich(token) {
    const r = this.richState()[token];
    return !!r && (r.misses || 0) < MISS_LIMIT;
  };
  P.setRich = function setRich(token, on) {
    const st = this.richState();
    if (on) st[token] = { misses: st[token]?.misses || 0 };
    else delete st[token];
    this.db.kvSet('richTokens', st);
  };

  /** Remember rich alerts that were sent, so a missing ack can be covered by a plain alert. */
  P.rememberRich = function rememberRich(msgs) {
    const rich = msgs.filter((m) => m.rich);
    if (!rich.length) return;
    const acks = this.db.kvGet('pushAcks', {});
    const now = this.now();
    for (const m of rich) acks[`${m.token}|${m.id}`] = { ts: now, token: m.token, id: m.id, title: m.title, body: m.body };
    for (const [k, v] of Object.entries(acks)) if (now - v.ts > 24 * 3600 * 1000) delete acks[k];
    this.db.kvSet('pushAcks', acks);
  };

  P.pushAck = function pushAck({ body }) {
    const token = str(body.token, 400);
    const id = str(body.id, 200);
    if (!token || !id) throw bad('BAD_ACK', 'token and id are needed');
    const acks = this.db.kvGet('pushAcks', {});
    if (acks[`${token}|${id}`]) {
      delete acks[`${token}|${id}`];
      this.db.kvSet('pushAcks', acks);
    }
    const st = this.richState();
    if (st[token] && st[token].misses) { st[token].misses = 0; this.db.kvSet('richTokens', st); }
    return { ok: true };
  };

  /** Called from the 5-minute tick: plain alert for every rich alert that was not acked in time. */
  P.pushFallback = function pushFallback() {
    const acks = this.db.kvGet('pushAcks', {});
    const now = this.now();
    const late = Object.entries(acks).filter(([, v]) => now - v.ts >= ACK_WAIT);
    if (!late.length) return 0;
    const st = this.richState();
    for (const [k, v] of late) {
      delete acks[k];
      this.outbox.push({ token: v.token, id: v.id, title: v.title, body: v.body, rich: false, fallback: true });
      if (st[v.token]) st[v.token].misses = (st[v.token].misses || 0) + 1;
    }
    this.db.kvSet('pushAcks', acks);
    this.db.kvSet('richTokens', st);
    return late.length;
  };
}

// ---------------------------------------------------------------- "Action card" contents
// The app draws: photo with red ring, name, role · code, a coloured label, a details box, buttons.
const KIND_COLOR = {
  leave: 'amber', short_leave: 'amber', field_duty: 'amber', advance: 'green', forgot_in: 'blue', forgot_out: 'blue', past_day: 'blue',
  recheckin: 'blue', undo_checkout: 'blue', break: 'amber', swap: 'amber', pin_reset: 'red',
};
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_UR = ['جنوری', 'فروری', 'مارچ', 'اپریل', 'مئی', 'جون', 'جولائی', 'اگست', 'ستمبر', 'اکتوبر', 'نومبر', 'دسمبر'];
const dayTxt = (d, ur) => `${Number(d.slice(8))} ${(ur ? MONTHS_UR : MONTHS_EN)[Number(d.slice(5, 7)) - 1]}`;
const ndays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;

export function installCards(Store) {
  const P = Store.prototype;

  P.empCardHead = function empCardHead(empId, ur) {
    const row = this.db.get('SELECT code, data FROM employees WHERE id = ?', empId);
    if (!row) return { name: '?', sub: '' };
    const d = JSON.parse(row.data);
    const role = this.settings.roles.find((x) => x.id === d.roleId);
    const roleName = role ? ((ur && role.nameUr) || role.name) : '';
    return { name: (ur && d.nameUr) || d.name || '?', sub: [roleName, row.code].filter(Boolean).join(' · ') };
  };

  /** Details rows for a request, e.g. Dates / Reason / Leave left. */
  P.requestRows = function requestRows(r, ur, withReason = true) {
    let data = {};
    try { data = typeof r.data === 'string' ? JSON.parse(r.data || '{}') : r.data || {}; } catch { /* ignore */ }
    const L = ur
      ? { dates: 'تاریخیں', date: 'تاریخ', time: 'وقت', amount: 'رقم', min: 'منٹ', reason: 'وجہ', left: 'باقی چھٹی', days: 'دن' }
      : { dates: 'Dates', date: 'Date', time: 'Time', amount: 'Amount', min: 'Minutes', reason: 'Reason', left: 'Leave left', days: 'days' };
    const rows = [];
    if (data.date) {
      const to = data.toDate && data.toDate !== data.date ? data.toDate : null;
      rows.push(to ? [L.dates, `${dayTxt(data.date, ur)} – ${dayTxt(to, ur)} (${ndays(data.date, to)} ${L.days})`] : [L.date, dayTxt(data.date, ur)]);
    }
    if (data.time) rows.push([L.time, data.time]);
    if (data.inTime || data.outTime) rows.push([L.time, `${data.inTime || '?'} – ${data.outTime || '?'}`]);
    if (data.amount) rows.push([L.amount, `${this.settings.currency} ${Number(data.amount).toLocaleString('en-US')}`]);
    if (data.minutes) rows.push([L.min, String(data.minutes)]);
    if (withReason && data.reason) rows.push([L.reason, String(data.reason).slice(0, 80)]);
    if (r.type === 'short_leave') {
      const rr = this.settings.rules;
      const cut = rr.shortLeaveCutDays === 1 ? (ur ? 'پورا دن' : 'full day') : rr.shortLeaveCutDays === 0.5 ? (ur ? 'آدھا دن' : 'half day') : `${rr.shortLeaveCutDays} ${ur ? 'دن' : 'day'}`;
      rows.splice(Math.min(rows.length, 2), 0, [ur ? 'اصول' : 'Rule', ur ? `${rr.shortLeaveFreeMin} منٹ میں واپسی مفت، ورنہ ${cut} کٹے گا` : `Back within ${rr.shortLeaveFreeMin} min free, else ${cut} cut`]);
    }
    if (r.type === 'leave' && data.date) {
      try {
        const st = this.statement(this.empRow(r.emp, { withDeleted: true }), data.date.slice(0, 7));
        rows.push([L.left, ur ? `${st.leave.left} / ${st.leave.quota} اس مہینے` : `${st.leave.left} of ${st.leave.quota} this month`]);
      } catch { /* leave count is extra */ }
    }
    return rows.slice(0, 4);
  };

  P.requestCard = function requestCard(r, label, ur) {
    return { ...this.empCardHead(r.emp, ur), label, color: KIND_COLOR[r.type] || 'blue', rows: this.requestRows(r, ur) };
  };
}

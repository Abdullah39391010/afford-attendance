// Day-to-day operations, added onto Store:
//  - reminders to staff (shift starts soon, forgot to check out) and the nightly summary to the owner
//  - salary paid records (cash / bank)
//  - advances cut in installments
//  - final settlement when someone leaves
import { bad, notFound, uid, isMonth, isDate, str, clampInt, local, hm, toTs, addDays, MIN, commas } from './util.js';
import { daySummary, empShift } from './attendance.js';
import { shiftMins } from './settings.js';

const fmtClock = (min) => {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const ap = h < 12 ? 'AM' : 'PM';
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${ap}`;
};
export const addMonths = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export function installOps(Store) {
  const P = Store.prototype;

  P.opsRoutes = function opsRoutes(add, A) {
    add('POST', '/api/admin/payments', this.addPayment, A('money.edit'));
    add('POST', '/api/admin/payments/:id/void', this.voidPayment, A('money.edit'));
    add('GET', '/api/admin/employees/:id/settlement', this.settlement, A('payroll.view'));
    add('POST', '/api/admin/employees/:id/settle', this.settle, A(null, { owner: true }));
  };

  // ---------------------------------------------------------------- reminders + summary (every 5 minutes)
  P.tick = async function tick() {
    if (!this.db.get('SELECT 1 AS x FROM admins LIMIT 1')) return;
    try {
      const r = this.settings.rules;
      if (r.remindersOn) this.reminders();
      if (r.dailySummaryOn) this.dailySummary();
      if (r.greetingsOn) this.greetings();
      this.driveReminder();
      await this.ownerPageCodeHash(); // a changed code logs out open owner pages
    } catch (e) {
      this.logError('reminders', e);
    }
    try { this.pushFallback(); } catch (e) { this.logError('push-fallback', e); }
    if (this.outbox.length) await this.flushPush();
  };

  P.reminderOnce = function reminderOnce(key) {
    const st = this.db.kvGet('reminders', {});
    if (st[key]) return false;
    st[key] = this.now();
    // forget keys older than 3 days
    for (const [k, ts] of Object.entries(st)) if (this.now() - ts > 3 * 24 * 3600 * 1000) delete st[k];
    this.db.kvSet('reminders', st);
    return true;
  };

  P.reminders = function reminders() {
    const s = this.settings;
    const now = this.now();
    const today = this.today();
    const yday = addDays(today, -1);
    const withPhones = new Set(this.db.all("SELECT DISTINCT sub FROM push_tokens WHERE kind = 'emp'").map((x) => x.sub));
    if (!withPhones.size) return;
    const emps = this.employees({ activeOnly: true }).filter((e) => withPhones.has(e.id));
    const get = this.loadDays(emps.map((e) => e.id), yday, today);
    for (const e of emps) {
      const before = (this.empRulesOf(e).remindBeforeMin || s.rules.remindBeforeMin || 15) * MIN;
      // 1) shift starts soon and not checked in (the duty roster can change the shift)
      const d = daySummary(e, s, today, get(e.id, today), now);
      const sm = shiftMins(this.shiftOn(e, today));
      if (!d.punches.length && !d.mark && !d.holiday && !d.weeklyOff && d.status !== 'notjoined' && d.status !== 'left'
        && now >= d.shiftStart - before && now < d.shiftStart && this.reminderOnce(`start:${e.id}:${today}`)) {
        const at = fmtClock(sm.start);
        this.queuePush('emp', [e.id], `rem-start-${e.id}-${today}`, (ur) => ({
          card: { name: ur ? 'شفٹ جلد شروع ہو رہی ہے' : 'Your shift starts soon', sub: this.settings.storeName, label: ur ? '⏰ یاد دہانی' : '⏰ Reminder', color: 'red',
            rows: [[ur ? 'شروع' : 'Starts at', at], [ur ? 'کیا کریں' : 'To do', ur ? 'اسٹور پہنچ کر چیک اِن کریں' : 'Check in when you reach the store']] },
          title: ur ? 'شفٹ جلد شروع ہو رہی ہے' : 'Your shift starts soon',
          body: ur ? `آپ کی شفٹ ${at} پر شروع ہے۔ وقت پر چیک اِن کریں۔` : `Your shift starts at ${at}. Check in on time.`,
        }));
      }
      // 2) still checked in long after the shift ended
      const open = this.openSession(e.id);
      if (open) {
        const endTs = toTs(open.day, shiftMins(this.shiftOn(e, open.day)).end, s.tzOffsetMin);
        if (now > endTs + 30 * MIN && this.reminderOnce(`out:${e.id}:${open.day}`)) {
          this.queuePush('emp', [e.id], `rem-out-${e.id}-${open.day}`, (ur) => ({
            card: { name: ur ? 'چیک آؤٹ بھول گئے؟' : 'Forgot to check out?', sub: this.settings.storeName, label: ur ? '⏰ یاد دہانی' : '⏰ Reminder', color: 'red',
              rows: [[ur ? 'کیا کریں' : 'To do', ur ? 'اگر جا چکے ہیں تو ابھی چیک آؤٹ کریں' : 'If you have left, check out now']] },
            title: ur ? 'چیک آؤٹ بھول گئے؟' : 'Forgot to check out?',
            body: ur ? 'آپ کی شفٹ ختم ہو چکی ہے۔ اگر آپ جا چکے ہیں تو ابھی چیک آؤٹ کریں۔' : 'Your shift has ended. If you have left, check out now.',
          }));
        }
      }
    }
  };
  P.empRulesOf = function empRulesOf(e) {
    const role = this.settings.roles.find((x) => x.id === e.roleId);
    return role?.rules ? { ...this.settings.rules, ...role.rules } : this.settings.rules;
  };

  P.dailySummary = function dailySummary(force) {
    const s = this.settings;
    const l = local(this.now(), s.tzOffsetMin);
    if (!force && (l.min < hm(s.rules.dailySummaryAt || '22:00') || this.db.kvGet('summaryDate', '') === l.date)) return null;
    this.db.kvSet('summaryDate', l.date);
    const b = this.board({ q: new URLSearchParams(`date=${l.date}`) });
    const c = b.counts;
    const present = c.in + c.break + c.out;
    const noOut = b.rows.filter((r) => r.isOpen && r.shiftEnd && this.now() > r.shiftEnd + 30 * MIN).length;
    const parts = {
      en: [`Present ${present}`, `Late ${c.late}`, `Absent ${c.absent}`, c.leave && `Leave ${c.leave}`, c.duty && `Duty ${c.duty}`, noOut && `Not checked out ${noOut}`],
      ur: [`حاضر ${present}`, `لیٹ ${c.late}`, `غیر حاضر ${c.absent}`, c.leave && `چھٹی ${c.leave}`, c.duty && `ڈیوٹی ${c.duty}`, noOut && `چیک آؤٹ نہیں ${noOut}`],
    };
    const pending = b.pending;
    this.queuePush('admin', this.ownerIds(), `sum-${l.date}`, (ur) => ({
      title: ur ? `آج کی حاضری · ${c.total} اسٹاف` : `Today's attendance · ${c.total} staff`,
      body: (ur ? parts.ur : parts.en).filter(Boolean).join(' · ') + (pending ? (ur ? ` · ${pending} درخواستیں باقی` : ` · ${pending} requests waiting`) : ''),
    }));
    return { date: l.date, counts: c, present, noOut };
  };

  // ---------------------------------------------------------------- salary payments
  P.paymentsFor = function paymentsFor(empId, month) {
    return this.db.all('SELECT * FROM payments WHERE emp = ? AND month = ? AND voided = 0 ORDER BY ts', empId, month);
  };
  P.addPayment = function addPayment({ actor, body }) {
    const emp = this.empRow(str(body.employeeId, 40), { withDeleted: true });
    const month = isMonth(body.month) ? body.month : null;
    if (!month) throw bad('BAD_MONTH', 'Pick the salary month');
    const method = ['cash', 'bank', 'other'].includes(body.method) ? body.method : 'cash';
    const st = this.statement(emp, month);
    const paid = this.paymentsFor(emp.id, month).reduce((a, p) => a + p.amount, 0);
    const amount = body.amount == null || body.amount === '' ? Math.max(0, st.net - paid) : clampInt(body.amount, 1, 100_000_000, 0);
    if (!amount) throw bad('BAD_AMOUNT', 'Nothing left to pay for this month');
    // employee's hand signature (PNG drawn on the admin's phone)
    const sig = body.signature ? String(body.signature) : null;
    if (sig && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length > 200_000)) throw bad('BAD_SIGNATURE', 'The signature could not be saved. Clear it and sign again.');
    const id = uid();
    this.db.run('INSERT INTO payments (id, emp, month, amount, method, note, ts, by_admin, voided) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
      id, emp.id, month, amount, method, str(body.note, 200), this.now(), actor.id);
    if (sig) this.db.run('INSERT INTO signatures (payment, emp, data, ts) VALUES (?, ?, ?, ?)', id, emp.id, sig, this.now());
    this.audit(actor, 'payroll.salary_paid', emp.id, { name: emp.name, month, amount, method, note: str(body.note, 200), signed: sig ? true : undefined });
    this.queuePush('emp', [emp.id], `paid-${id}`, (ur) => ({
      actions: 'payslip',
      card: {
        name: ur ? 'تنخواہ ادا ہو گئی' : 'Salary paid', sub: ur ? month : monthName(month),
        label: `${this.settings.currency} ${commas(amount)}`, color: 'green',
        rows: [[ur ? 'طریقہ' : 'Paid by', ur ? ({ cash: 'نقد', bank: 'بینک', other: 'دیگر' }[method] || method) : ({ cash: 'Cash', bank: 'Bank transfer', other: 'Other' }[method] || method)],
          [ur ? 'پے سلپ' : 'Payslip', ur ? 'ایپ میں تیار ہے' : 'Ready in the app']],
      },
      title: ur ? `تنخواہ ادا ہو گئی · ${month}` : `Salary paid · ${monthName(month)}`,
      body: ur
        ? `${this.settings.currency} ${commas(amount)} ${method === 'bank' ? 'بینک میں' : method === 'cash' ? 'نقد' : ''} ادا کر دیے گئے۔ پے سلپ ایپ میں دیکھیں۔`
        : `${this.settings.currency} ${commas(amount)} paid${method === 'bank' ? ' by bank transfer' : method === 'cash' ? ' in cash' : ''}. Your payslip is in the app.`,
    }));
    return { ok: true, id, amount };
  };
  P.voidPayment = function voidPayment({ actor, params }) {
    const p = this.db.get('SELECT * FROM payments WHERE id = ?', params.id);
    if (!p) throw notFound('Payment');
    this.db.run('UPDATE payments SET voided = 1 WHERE id = ?', p.id);
    this.audit(actor, 'payroll.payment_removed', p.emp, { month: p.month, amount: p.amount, method: p.method });
    return { ok: true };
  };

  // ---------------------------------------------------------------- advances in installments
  /** Inserts an advance split over n months. Returns the money row ids. */
  P.insertAdvance = function insertAdvance(actor, emp, amount, month, note, n, voided) {
    n = clampInt(n, 1, 12, 1);
    for (let i = 0; i < n; i++) this.assertMonthOpen(addMonths(month, i));
    const each = Math.floor(amount / n);
    const ids = [];
    for (let i = 0; i < n; i++) {
      const part = i === n - 1 ? amount - each * (n - 1) : each;
      const id = uid();
      const label = n > 1 ? `${note || 'Advance'} (${i + 1}/${n})` : note;
      this.db.run('INSERT INTO money (id, emp, kind, amount, month, note, ts, by_admin, voided) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, emp.id, 'advance', part, addMonths(month, i), label, this.now(), actor.id, voided);
      ids.push(id);
    }
    return ids;
  };

  // ---------------------------------------------------------------- final settlement
  P.settlementData = function settlementData(emp, lastDay) {
    const month = lastDay.slice(0, 7);
    const st = this.statement({ ...emp, leaveDate: lastDay }, month, null, { live: true });
    const later = this.db.all("SELECT * FROM money WHERE emp = ? AND voided = 0 AND kind = 'advance' AND month > ? ORDER BY month", emp.id, month);
    const laterAdvances = later.reduce((a, m) => a + m.amount, 0);
    const deposit = this.depositBalance(emp.id);
    const paid = this.paymentsFor(emp.id, month).reduce((a, p) => a + p.amount, 0);
    const total = Math.round(st.net - laterAdvances + deposit - paid);
    return { lastDay, month, statement: st, laterAdvances, laterAdvanceRows: later, depositBalance: deposit, alreadyPaid: paid, total };
  };
  P.settlement = function settlement({ params, q }) {
    const emp = this.empRow(params.id, { withDeleted: true });
    const lastDay = isDate(q.get('lastDay')) ? q.get('lastDay') : emp.leaveDate || this.today();
    const x = this.settlementData(emp, lastDay);
    this.withSigs(x.statement);
    return x;
  };
  P.settle = function settle({ actor, params, body }) {
    const emp = this.empRow(params.id);
    const lastDay = isDate(body.lastDay) ? body.lastDay : this.today();
    if (lastDay > this.today()) throw bad('BAD_DATE', 'The last day cannot be in the future');
    const month = lastDay.slice(0, 7);
    this.assertMonthOpen(month);
    const before = this.settlementData(emp, lastDay);
    // remaining advance installments are cut in the last month
    for (const m of before.laterAdvanceRows) this.db.run('UPDATE money SET month = ? WHERE id = ?', month, m.id);
    if (before.depositBalance > 0) {
      this.db.run("INSERT INTO money (id, emp, kind, amount, month, note, ts, by_admin, voided) VALUES (?, ?, 'deposit_return', ?, ?, ?, ?, ?, 0)",
        uid(), emp.id, before.depositBalance, month, 'Returned at final settlement', this.now(), actor.id);
    }
    const row = this.db.get('SELECT data FROM employees WHERE id = ?', emp.id);
    const data = JSON.parse(row.data);
    data.leaveDate = lastDay;
    data.leaveNote = str(body.note, 300);
    this.db.run('UPDATE employees SET data = ?, active = 0, updated = ? WHERE id = ?', JSON.stringify(data), this.now(), emp.id);
    this.db.run("DELETE FROM sessions WHERE kind = 'emp' AND sub = ?", emp.id);
    this.audit(actor, 'employee.settled', emp.id, { name: emp.name, lastDay, total: before.total, deposit: before.depositBalance, laterAdvances: before.laterAdvances, note: str(body.note, 300) });
    return { ok: true, settlement: before };
  };
}


const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthName(m) { return `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`; }

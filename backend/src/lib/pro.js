// Business safety features, added onto Store:
//  - daily cloud backup into a separate storage (the "vault"), kept 30 days
//  - staff rules agreement, accepted in the staff app
//  - owner approval for money and salary changes made by managers
//  - locked (paid) months with a frozen salary statement
//  - server error log + alert to the owner
import { HttpError, bad, forbidden, notFound, uid, isMonth, str, local, commas } from './util.js';
import { makeBackup, checkBackup } from './backup.js';

const DAY = 24 * 3600 * 1000;
export const VAULT_KEEP_DAYS = 30;

/** In-memory vault for tests and local runs without the second Durable Object. */
export function memoryVault() {
  const m = new Map();
  return {
    async put(name, text) { m.set(name, { name, created: Date.now(), size: text.length, text }); },
    async list() { return [...m.values()].map(({ text, ...x }) => x).sort((a, b) => b.name.localeCompare(a.name)); },
    async get(name) { return m.get(name)?.text ?? null; },
    async remove(name) { m.delete(name); },
  };
}

// ---------------------------------------------------------------- policy text
export function policyLines(s, ur) {
  const r = s.rules;
  const cur = s.currency;
  const L = [];
  if (ur) {
    L.push('حاضری صرف ایپ، کیوسک یا مینیجر کے ذریعے لگے گی۔');
    L.push('چیک اِن اور چیک آؤٹ کے وقت آپ کی لوکیشن (GPS) چیک اور محفوظ کی جاتی ہے۔ جعلی GPS کی اجازت نہیں۔');
    L.push(`شفٹ شروع ہونے کے ${r.lateGraceMin} منٹ بعد آنا لیٹ ہے۔${r.lateCutOn ? ' لیٹ منٹ تنخواہ سے کٹتے ہیں۔' : ''}`);
    if (r.earlyLeaveCutOn) L.push('شفٹ ختم ہونے سے پہلے جانے کے منٹ تنخواہ سے کٹتے ہیں۔');
    L.push(`روزانہ ${r.breakAllowanceMin} منٹ کا وقفہ ہے۔${r.breakLateCutOn ? ' وقفے سے دیر سے واپسی تنخواہ سے کٹتی ہے۔' : ''}`);
    if (r.absentCutOn) L.push('غیر حاضری کے دن کی تنخواہ کٹتی ہے۔');
    L.push(`ہر مہینے ${r.paidLeavePerMonth} چھٹی تنخواہ کے ساتھ ہے، اس سے زیادہ کی تنخواہ کٹے گی۔`);
    L.push('چیک آؤٹ کے بعد اسی دن دوبارہ چیک اِن کے لیے اجازت ضروری ہے، اور باہر کا وقت لیٹ میں گنا جائے گا۔');
    L.push(`ایڈوانس اور سیکیورٹی ڈپازٹ (${cur}) کا حساب تنخواہ کی پرچی میں ہوتا ہے۔`);
    L.push('اپنا پن کسی کو نہ بتائیں۔ کسی اور کی حاضری لگانا سخت منع ہے۔');
  } else {
    L.push('Attendance is marked only through the app, the store kiosk or a manager.');
    L.push('Your location (GPS) is checked and saved when you check in and out. Fake GPS apps are not allowed.');
    L.push(`Arriving more than ${r.lateGraceMin} minutes after your shift starts is late.${r.lateCutOn ? ' Late minutes are cut from salary.' : ''}`);
    if (r.earlyLeaveCutOn) L.push('Leaving before your shift ends is cut from salary by the minute.');
    L.push(`You get ${r.breakAllowanceMin} minutes of break a day.${r.breakLateCutOn ? ' Coming back late from a break is cut from salary.' : ''}`);
    if (r.absentCutOn) L.push('An absent day is cut from salary.');
    L.push(`You get ${r.paidLeavePerMonth} paid leave a month. Extra leave is unpaid.`);
    L.push('After you check out, checking in again the same day needs approval, and the time away counts as late.');
    L.push(`Advances and the security deposit (${cur}) are settled in your salary slip.`);
    L.push('Never share your PIN. Checking in for someone else is strictly not allowed.');
  }
  const extra = str(ur ? s.policy?.extraUr || s.policy?.extraEn : s.policy?.extraEn, 3000);
  for (const line of extra.split('\n').map((x) => x.trim()).filter(Boolean)) L.push(line);
  return L;
}

export function installPro(Store) {
  const P = Store.prototype;

  P.proRoutes = function proRoutes(add, A) {
    add('GET', '/api/admin/cloud-backups', this.cloudList, A(null, { owner: true }));
    add('POST', '/api/admin/cloud-backups', this.cloudBackupNow, A(null, { owner: true }));
    add('GET', '/api/admin/cloud-backups/:name', this.cloudGet, A(null, { owner: true }));
    add('POST', '/api/admin/cloud-backups/:name/restore', this.cloudRestore, A(null, { owner: true }));
    add('GET', '/api/admin/health', this.health, A(null, { owner: true }));
    add('GET', '/api/admin/policy', this.adminPolicy, A('employees.view'));
    add('PUT', '/api/admin/policy', this.putPolicy, A(null, { owner: true }));
    add('POST', '/api/emp/policy/accept', this.empAcceptPolicy, { auth: 'emp' });
    add('GET', '/api/admin/approvals', this.listApprovals, A(null, { owner: true }));
    add('POST', '/api/admin/approvals/:id/decide', this.decideApproval, A(null, { owner: true }));
    add('GET', '/api/admin/months', this.listLocks, A('payroll.view'));
    add('POST', '/api/admin/months/:month/lock', this.lockMonth, A(null, { owner: true }));
  };

  P.isOwner = function isOwner(actor) { return actor?.role === 'owner'; };
  P.ownerIds = function ownerIds() {
    return this.db.all("SELECT id FROM admins WHERE active = 1 AND role = 'owner'").map((a) => a.id);
  };

  // ---------------------------------------------------------------- cloud backup
  P.vaultOrFail = function vaultOrFail() {
    if (!this.vault) throw new HttpError(503, 'NO_CLOUD', 'Cloud backup is not available on this server');
    return this.vault;
  };
  P.backupName = function backupName() {
    const l = local(this.now(), this.off);
    const hh = String(Math.floor(l.min / 60)).padStart(2, '0');
    const mm = String(l.min % 60).padStart(2, '0');
    return `afford-backup-${l.date}-${hh}${mm}`;
  };
  /** Writes one backup to the vault and removes ones older than 30 days. */
  P.runCloudBackup = async function runCloudBackup(by) {
    const vault = this.vaultOrFail();
    const s = this.settings;
    const b = makeBackup(this.db, { created: this.now(), storeName: s.storeName, by: by || 'Daily automatic backup' });
    const name = this.backupName();
    const text = JSON.stringify(b);
    await vault.put(name, text);
    const cutoff = this.now() - VAULT_KEEP_DAYS * DAY;
    for (const x of await vault.list()) if (x.created < cutoff) await vault.remove(x.name);
    this.db.kvSet('cloudBackup', { last: this.now(), date: this.today(), name, size: text.length });
    return { name, size: text.length, created: this.now() };
  };
  /** Called from the hourly alarm: one automatic backup a day. */
  P.dailyCloudBackup = async function dailyCloudBackup() {
    if (!this.vault || !this.db.get('SELECT 1 AS x FROM admins LIMIT 1')) return null;
    const st = this.db.kvGet('cloudBackup', {});
    if (st.date === this.today()) return null;
    try {
      return await this.runCloudBackup();
    } catch (e) {
      this.logError('cloud-backup', e);
      await this.flushPush();
      return null;
    }
  };
  P.cloudList = async function cloudList() {
    const vault = this.vaultOrFail();
    return { backups: await vault.list(), keepDays: VAULT_KEEP_DAYS, last: this.db.kvGet('cloudBackup', null) };
  };
  P.cloudBackupNow = async function cloudBackupNow({ actor }) {
    const r = await this.runCloudBackup(actor.name);
    this.audit(actor, 'data.cloud_backup', null, { name: r.name });
    return { ok: true, backup: r };
  };
  P.cloudGet = async function cloudGet({ params }) {
    const text = await this.vaultOrFail().get(params.name);
    if (!text) throw notFound('Backup');
    return new Response(text, {
      headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${params.name}.json"`, 'cache-control': 'no-store' },
    });
  };
  P.cloudRestore = async function cloudRestore(c) {
    const text = await this.vaultOrFail().get(c.params.name);
    if (!text) throw notFound('Backup');
    let b;
    try { b = JSON.parse(text); checkBackup(b); } catch (e) { throw bad('BAD_BACKUP', e.message); }
    return this.restore({ ...c, body: { pin: c.body.pin, check: c.body.check, backup: b } });
  };

  // ---------------------------------------------------------------- errors / health
  P.logError = function logError(where, e) {
    try {
      const list = this.db.kvGet('errors', []);
      list.unshift({ ts: this.now(), where: String(where).slice(0, 80), msg: String(e?.message || e).slice(0, 300) });
      this.db.kvSet('errors', list.slice(0, 50));
      const last = this.db.kvGet('errorAlertAt', 0);
      if (this.now() - last > 3600 * 1000) {
        this.db.kvSet('errorAlertAt', this.now());
        this.queuePush('admin', this.ownerIds(), `err-${this.now()}`, (ur) => ({
          title: ur ? 'سرور میں مسئلہ' : 'Server problem',
          body: ur ? `ایک کام میں خرابی ہوئی (${where})۔ تفصیل بیک اپ والے صفحے پر۔` : `Something failed (${where}). See More › Backup › Server health.`,
        }));
      }
    } catch { /* never let logging break a request */ }
  };
  P.health = async function health() {
    let cloud = null;
    if (this.vault) {
      try { cloud = { ok: true, count: (await this.vault.list()).length }; } catch (e) { cloud = { ok: false, error: String(e?.message || e) }; }
    }
    return {
      serverTime: this.now(),
      errors: this.db.kvGet('errors', []),
      cloudBackup: this.db.kvGet('cloudBackup', null),
      cloud,
      push: !!this.env.FIREBASE_SERVICE_ACCOUNT,
    };
  };

  // ---------------------------------------------------------------- rules agreement
  P.policyVer = function policyVer() { return this.settings.policy?.ver || 1; };
  P.policyFor = function policyFor(emp) {
    const acc = this.db.kvGet('policyAccept', {})[emp.id] || null;
    const ver = this.policyVer();
    return {
      ver,
      accepted: acc,
      needed: !acc || acc.ver !== ver,
      en: policyLines(this.settings, false),
      ur: policyLines(this.settings, true),
    };
  };
  P.empAcceptPolicy = function empAcceptPolicy({ actor, body }) {
    const ver = this.policyVer();
    if (Number(body.ver) !== ver) throw bad('POLICY_CHANGED', 'The rules were updated. Please read them again.');
    const all = this.db.kvGet('policyAccept', {});
    all[actor.id] = { ver, ts: this.now() };
    this.db.kvSet('policyAccept', all);
    this.audit({ id: actor.id, name: actor.name }, 'employee.rules_accepted', actor.id, { name: actor.name, ver });
    return { ok: true, accepted: all[actor.id] };
  };
  P.adminPolicy = function adminPolicy() {
    const s = this.settings;
    const acc = this.db.kvGet('policyAccept', {});
    const ver = this.policyVer();
    const emps = this.employees({ activeOnly: true });
    return {
      ver,
      extraEn: s.policy?.extraEn || '',
      extraUr: s.policy?.extraUr || '',
      en: policyLines(s, false),
      ur: policyLines(s, true),
      staff: emps.map((e) => ({ id: e.id, code: e.code, name: e.name, nameUr: e.nameUr, accepted: acc[e.id] || null, current: acc[e.id]?.ver === ver })),
    };
  };
  P.putPolicy = function putPolicy({ actor, body }) {
    const s = structuredClone(this.settings);
    const old = s.policy || { ver: 1, extraEn: '', extraUr: '' };
    const extraEn = 'extraEn' in body ? str(body.extraEn, 3000) : old.extraEn || '';
    const extraUr = 'extraUr' in body ? str(body.extraUr, 3000) : old.extraUr || '';
    const changed = extraEn !== (old.extraEn || '') || extraUr !== (old.extraUr || '');
    const ver = (old.ver || 1) + (changed || body.askAgain ? 1 : 0);
    s.policy = { ver, extraEn, extraUr };
    this.saveSettings(s);
    this.audit(actor, 'settings.rules_agreement', null, { ver, askAgain: !!body.askAgain });
    return this.adminPolicy();
  };

  // ---------------------------------------------------------------- owner approvals
  /** A manager's change waits for the owner. Returns the approval id. */
  P.askOwner = function askOwner(actor, kind, emp, data) {
    const id = uid();
    this.db.run("INSERT INTO approvals (id, kind, emp, data, status, created, by_admin, by_name) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
      id, kind, emp.id, JSON.stringify(data), this.now(), actor.id, actor.name);
    const what = {
      money_add: [`${MONEY_EN[data.kind] || data.kind} ${this.settings.currency} ${commas(data.amount)}`, `${MONEY_UR[data.kind] || data.kind} ${this.settings.currency} ${commas(data.amount)}`],
      money_void: [`Remove ${MONEY_EN[data.kind] || data.kind} ${this.settings.currency} ${commas(data.amount)}`, `${MONEY_UR[data.kind] || data.kind} ${this.settings.currency} ${commas(data.amount)} ہٹانا`],
      salary: [`Salary ${data.from} → ${data.to}`, `تنخواہ ${data.from} → ${data.to}`],
    }[kind];
    this.queuePush('admin', this.ownerIds(), `appr-${id}`, (ur) => ({
      title: ur ? 'آپ کی منظوری چاہیے' : 'Needs your approval',
      body: ur ? `${actor.name}: ${emp.nameUr || emp.name} · ${what[1]}` : `${actor.name}: ${emp.name} · ${what[0]}`,
    }));
    this.audit(actor, 'approval.asked', emp.id, { name: emp.name, kind, ...data });
    return id;
  };
  P.pendingApprovals = function pendingApprovals() {
    return this.db.get("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").n;
  };
  P.listApprovals = function listApprovals({ q }) {
    const status = q.get('status') || 'pending';
    const rows = this.db.all(`SELECT * FROM approvals ${status === 'all' ? '' : 'WHERE status = ?'} ORDER BY created DESC LIMIT 200`, ...(status === 'all' ? [] : [status]));
    const names = {};
    for (const e of this.db.all('SELECT id, code, data FROM employees')) names[e.id] = { code: e.code, name: JSON.parse(e.data).name, nameUr: JSON.parse(e.data).nameUr };
    return { approvals: rows.map((r) => ({ ...r, data: JSON.parse(r.data), employee: names[r.emp] || null })) };
  };
  P.decideApproval = function decideApproval({ actor, params, body }) {
    const a = this.db.get('SELECT * FROM approvals WHERE id = ?', params.id);
    if (!a) throw notFound('Approval');
    if (a.status !== 'pending') throw bad('ALREADY_DECIDED', 'This was already decided');
    const d = JSON.parse(a.data);
    const ok = !!body.approve;
    const emp = this.empRow(a.emp, { withDeleted: true });
    if (a.kind === 'money_add' || a.kind === 'money_void') {
      const rows = (d.moneyIds || [d.moneyId]).map((mid) => this.db.get('SELECT * FROM money WHERE id = ?', mid)).filter(Boolean);
      if (!rows.length) throw notFound('Entry');
      for (const m of rows) this.assertMonthOpen(m.month);
      for (const m of rows) {
        if (a.kind === 'money_add') this.db.run('UPDATE money SET voided = ? WHERE id = ?', ok ? 0 : 1, m.id);
        else if (ok) this.db.run('UPDATE money SET voided = 1 WHERE id = ?', m.id);
      }
    } else if (a.kind === 'salary') {
      if (ok) {
        const row = this.db.get('SELECT data FROM employees WHERE id = ?', a.emp);
        const data = JSON.parse(row.data);
        data.salary = d.to;
        this.db.run('UPDATE employees SET data = ?, updated = ? WHERE id = ?', JSON.stringify(data), this.now(), a.emp);
      }
    }
    const status = ok ? 'approved' : 'declined';
    this.db.run('UPDATE approvals SET status = ?, decided = ?, note = ? WHERE id = ?', status, this.now(), str(body.note, 200), a.id);
    this.audit(actor, `approval.${status}`, a.emp, { name: emp.name, kind: a.kind, ...d, by: a.by_name });
    if (a.by_admin) {
      this.queuePush('admin', [a.by_admin], `appr-${a.id}-d`, (ur) => ({
        title: ur ? (ok ? 'مالک نے منظور کر دیا' : 'مالک نے رد کر دیا') : (ok ? 'Owner approved' : 'Owner declined'),
        body: ur ? `${emp.nameUr || emp.name}` : `${emp.name}: ${a.kind === 'salary' ? `salary ${d.from} → ${d.to}` : `${MONEY_EN[d.kind] || d.kind} ${d.amount}`}`,
      }));
    }
    return { ok: true, status };
  };

  // ---------------------------------------------------------------- locked months
  P.locks = function locks() { return this.db.kvGet('lockedMonths', {}); };
  P.assertMonthOpen = function assertMonthOpen(monthOrDate) {
    const m = String(monthOrDate || '').slice(0, 7);
    if (m && this.locks()[m]) throw forbidden('MONTH_LOCKED', `${m} is locked because its salary is final. Only the owner can unlock it.`);
  };
  P.assertDatesOpen = function assertDatesOpen(dates) {
    const seen = new Set();
    for (const d of dates) {
      const m = String(d).slice(0, 7);
      if (seen.has(m)) continue;
      seen.add(m);
      this.assertMonthOpen(m);
    }
  };
  P.listLocks = function listLocks() {
    const l = this.locks();
    return { months: Object.entries(l).map(([month, x]) => ({ month, ts: x.ts, by: x.byName })).sort((a, b) => b.month.localeCompare(a.month)) };
  };
  P.lockMonth = function lockMonth({ actor, params, body }) {
    const month = params.month;
    if (!isMonth(month)) throw bad('BAD_MONTH', 'Bad month');
    const l = this.locks();
    if (body.lock === false) {
      if (!l[month]) return { ok: true, locked: false };
      delete l[month];
      this.db.kvSet('lockedMonths', l);
      this.db.run('DELETE FROM kv WHERE k = ?', `lock:${month}`);
      this.audit(actor, 'payroll.month_unlocked', null, { month, reason: str(body.reason, 200) });
      return { ok: true, locked: false };
    }
    if (month >= this.month()) throw bad('MONTH_NOT_OVER', 'Only a finished month can be locked');
    if (l[month]) return { ok: true, locked: true };
    // freeze every employee's statement as it is now
    const snap = {};
    const all = this.db.all('SELECT * FROM employees').map((r) => this.empFromRow(r));
    for (const e of all) {
      if (e.joinDate && e.joinDate > `${month}-31`) continue;
      const st = this.statement(e, month);
      if (e.deleted && !st.net && !st.counts.present) continue;
      snap[e.id] = st;
    }
    this.db.kvSet(`lock:${month}`, snap);
    l[month] = { ts: this.now(), by: actor.id, byName: actor.name };
    this.db.kvSet('lockedMonths', l);
    this.audit(actor, 'payroll.month_locked', null, { month, employees: Object.keys(snap).length });
    return { ok: true, locked: true };
  };
  /** Frozen statement of a locked month, or null. */
  P.lockedStatement = function lockedStatement(empId, month) {
    if (!this.locks()[month]) return null;
    const snap = this.db.kvGet(`lock:${month}`, {});
    return snap[empId] ? { ...snap[empId], locked: true } : null;
  };
}

export const MONEY_EN = { advance: 'Advance', deposit: 'Security deposit', deposit_cut: 'Deposit cut', deposit_return: 'Deposit returned', bonus: 'Bonus' };
export const MONEY_UR = { advance: 'ایڈوانس', deposit: 'سیکیورٹی ڈپازٹ', deposit_cut: 'ڈپازٹ کٹوتی', deposit_return: 'ڈپازٹ واپسی', bonus: 'بونس' };


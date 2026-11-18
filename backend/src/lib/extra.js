// More store features, added onto Store:
//  - holidays: push to staff when new holidays are added
//  - bonus / commission / fines: push, and the same amount to many staff at once
//  - weekly duty roster and shift swap requests
//  - staff file: documents (CNIC, contract) and warnings / good-work notes
//  - birthday and work anniversary wishes
//  - branches: an employee belongs to one store location; a manager can be limited to one branch
import { bad, forbidden, notFound, uid, isDate, isMonth, str, clampInt, local, hm, addDays, dateRange } from './util.js';
import { shiftFor, empShift, empWeeklyOff } from './attendance.js';
import { hashPin, validPin, sha256, checkPin } from './crypto.js';
import { HttpError, commas } from './util.js';

const DOC_KINDS = ['cnic_front', 'cnic_back', 'contract', 'photo', 'other'];
const NOTE_KINDS = ['warning', 'praise', 'note'];
const DOC_MAX = 950_000; // characters of the data URL (about 700 KB file)
const MONEY_EN = { bonus: 'Bonus', commission: 'Commission', fine: 'Fine' };
const MONEY_UR = { bonus: 'بونس', commission: 'کمیشن', fine: 'جرمانہ' };
const NOTE_EN = { warning: 'Warning', praise: 'Good work', note: 'Note' };
const NOTE_UR = { warning: 'وارننگ', praise: 'شاباش', note: 'نوٹ' };

export function installExtra(Store) {
  const P = Store.prototype;

  P.extraRoutes = function extraRoutes(add, A) {
    add('POST', '/api/admin/money/bulk', this.bulkMoney, A('money.edit'));
    add('GET', '/api/admin/roster', this.getRoster, A('employees.view'));
    add('PUT', '/api/admin/roster', this.putRoster, A('attendance.punch'));
    add('POST', '/api/admin/roster/copy', this.copyRoster, A('attendance.punch'));
    add('GET', '/api/admin/employees/:id/notes', this.listNotes, A('employees.view'));
    add('POST', '/api/admin/employees/:id/notes', this.addNote, A('employees.edit'));
    add('POST', '/api/admin/notes/:id/void', this.voidNote, A('employees.edit'));
    add('GET', '/api/admin/employees/:id/docs', this.listDocs, A('employees.edit'));
    add('POST', '/api/admin/employees/:id/docs', this.addDoc, A('employees.edit', { maxBody: 1_000_000 }));
    add('GET', '/api/admin/docs/:id', this.getDoc, A('employees.edit'));
    add('DELETE', '/api/admin/docs/:id', this.deleteDoc, A('employees.edit'));
    add('POST', '/api/emp/forgot-pin', this.forgotPin);
    add('POST', '/api/owner-page/login', this.ownerPageLogin);
    add('POST', '/api/admin/employees/:id/erase', this.eraseEmployee, A(null, { owner: true }));
    add('GET', '/api/emp/roster', this.empRoster, { auth: 'emp' });
    add('GET', '/api/emp/notes', this.empNotes, { auth: 'emp' });
    add('POST', '/api/emp/notes/:id/seen', this.empNoteSeen, { auth: 'emp' });
  };

  // ---------------------------------------------------------------- owner web page
  // Its own code, kept only as the Worker secret OWNER_PAGE_CODE (set from GitHub, never in the admin app).
  /** Hash of the current code; when the secret changes, every open owner page is logged out. */
  P.ownerPageCodeHash = async function ownerPageCodeHash() {
    const code = String(this.env.OWNER_PAGE_CODE || '').trim();
    const h = code ? await sha256(`${this.pepper}|owner-page|${code}`) : '';
    if (this.db.kvGet('ownerPageHash', '') !== h) {
      this.db.run("DELETE FROM sessions WHERE kind = 'admin' AND device = 'web-ownerpage'");
      this.db.kvSet('ownerPageHash', h);
    }
    return h;
  };
  P.ownerPageLogin = async function ownerPageLogin({ body, ip }) {
    const keys = ['op:all', `ip:${ip}`];
    this.lockCheck(keys);
    const want = await this.ownerPageCodeHash();
    if (!want) throw bad('OWNER_PAGE_OFF', 'The owner page is not turned on');
    const got = await sha256(`${this.pepper}|owner-page|${String(body.code || '').trim()}`);
    if (got !== want) {
      this.lockFail(keys);
      throw new HttpError(401, 'WRONG_CODE', 'Wrong code');
    }
    this.lockClear('op:all');
    const a = this.db.get("SELECT * FROM admins WHERE role = 'owner' AND active = 1 ORDER BY rowid LIMIT 1");
    if (!a) throw bad('NO_OWNER', 'No owner account');
    const token = await this.issueToken('admin', a.id, 'web-ownerpage', 12 * 3600 * 1000);
    return { token, me: { id: a.id, name: a.name, login: a.login, role: a.role, perms: JSON.parse(a.perms) }, serverTime: this.now() };
  };

  // ---------------------------------------------------------------- erase an employee's records (owner only, PIN or fingerprint)
  P.eraseEmployee = async function eraseEmployee({ actor, params, body, ip }) {
    const a = this.db.get('SELECT * FROM admins WHERE id = ?', actor.id);
    const keys = [`a:${a.login}`, `ip:${ip}`];
    this.lockCheck(keys);
    // fingerprint is checked on the owner's own phone; a browser must always type the PIN
    const fingerOk = body.fingerprint === true && !String(actor.device || '').startsWith('web-');
    if (!fingerOk) {
      if (!(await checkPin(String(body.pin || ''), a.pin, this.pepper))) {
        this.lockFail(keys);
        throw new HttpError(401, 'WRONG_PIN', 'Wrong PIN');
      }
      this.lockClear(keys[0]);
    }
    const mode = body.mode === 'all' ? 'all' : 'records';
    const e = this.db.get('SELECT id, code, data FROM employees WHERE id = ?', params.id);
    if (!e) throw notFound('Employee');
    const name = JSON.parse(e.data).name;
    const id = e.id;
    const counts = {
      punches: this.db.get('SELECT COUNT(*) AS n FROM punches WHERE emp = ?', id).n,
      money: this.db.get('SELECT COUNT(*) AS n FROM money WHERE emp = ?', id).n,
      requests: this.db.get('SELECT COUNT(*) AS n FROM requests WHERE emp = ?', id).n,
    };
    if (body.check) return { ok: true, checked: true, counts }; // PIN is right; nothing deleted yet
    // attendance, requests and salary records
    this.db.run('DELETE FROM photos WHERE punch IN (SELECT id FROM punches WHERE emp = ?)', id);
    for (const tb of ['punches', 'breaks', 'day_marks', 'requests', 'money', 'payments', 'signatures', 'approvals', 'roster']) this.db.run(`DELETE FROM ${tb} WHERE emp = ?`, id);
    for (const m of Object.keys(this.locks())) {
      const snap = this.db.kvGet(`lock:${m}`, {});
      if (snap[id]) { delete snap[id]; this.db.kvSet(`lock:${m}`, snap); }
    }
    if (mode === 'all') {
      for (const tb of ['staff_notes', 'docs']) this.db.run(`DELETE FROM ${tb} WHERE emp = ?`, id);
      this.db.run("DELETE FROM sessions WHERE kind = 'emp' AND sub = ?", id);
      this.db.run("DELETE FROM push_tokens WHERE kind = 'emp' AND sub = ?", id);
      this.db.run('DELETE FROM employees WHERE id = ?', id);
      this.forgetPin(id);
      const acc = this.db.kvGet('policyAccept', null);
      if (acc && acc[id]) { delete acc[id]; this.db.kvSet('policyAccept', acc); }
    }
    this.audit(actor, mode === 'all' ? 'employee.erased' : 'employee.records_cleared', id, { name, code: e.code, ...counts, by: fingerOk ? 'fingerprint' : 'pin' });
    return { ok: true, mode, counts };
  };

  // ---------------------------------------------------------------- branches
  /** Employees the actor may see, optionally narrowed by ?branch= */
  P.inBranch = function inBranch(actor, q, emps) {
    const forced = actor?.branchId || '';
    const want = forced || (q && q.get('branch')) || '';
    if (!want) return emps;
    return emps.filter((e) => (e.branchId || '') === want);
  };
  P.assertBranch = function assertBranch(actor, emp) {
    if (actor?.branchId && (emp.branchId || '') !== actor.branchId) throw forbidden('OTHER_BRANCH', 'This employee belongs to another branch');
  };

  // ---------------------------------------------------------------- roster
  P.rosterRow = function rosterRow(empId, date) {
    return this.db.get('SELECT * FROM roster WHERE emp = ? AND day = ?', empId, date);
  };
  /** Shift that applies to the employee on one date (roster first, then their normal shift). */
  P.shiftOn = function shiftOn(emp, date) {
    return shiftFor(emp, this.settings, this.rosterRow(emp.id, date));
  };
  /** What the employee normally does on a date, without the roster. */
  P.normalDuty = function normalDuty(emp, date) {
    const off = empWeeklyOff(emp, this.settings).includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    return { shiftId: empShift(emp, this.settings).id, off };
  };
  P.dutyOn = function dutyOn(emp, date, row) {
    const r = row === undefined ? this.rosterRow(emp.id, date) : row;
    if (!r) return { ...this.normalDuty(emp, date), rostered: false };
    return { shiftId: shiftFor(emp, this.settings, r).id, off: !!r.off, rostered: true, note: r.note || '' };
  };
  P.setDuty = function setDuty(actor, emp, date, shiftId, off, note) {
    const n = this.normalDuty(emp, date);
    if (!this.settings.shifts.some((x) => x.id === shiftId)) shiftId = n.shiftId;
    if (shiftId === n.shiftId && !!off === n.off && !note) {
      this.db.run('DELETE FROM roster WHERE emp = ? AND day = ?', emp.id, date);
      return;
    }
    this.db.run(`INSERT INTO roster (emp, day, shift_id, off, note, by_admin, ts) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(emp, day) DO UPDATE SET shift_id = excluded.shift_id, off = excluded.off, note = excluded.note, by_admin = excluded.by_admin, ts = excluded.ts`,
    emp.id, date, shiftId, off ? 1 : 0, note || null, actor?.id || null, this.now());
  };
  P.rosterDates = function rosterDates(q) {
    const from = isDate(q.get('from')) ? q.get('from') : this.today();
    const n = clampInt(q.get('days'), 1, 31, 7);
    return dateRange(from, addDays(from, n - 1));
  };
  P.getRoster = function getRoster({ actor, q }) {
    const dates = this.rosterDates(q);
    const emps = this.inBranch(actor, q, this.employees({ activeOnly: true }));
    const ids = emps.map((e) => e.id);
    const rows = {};
    const marks = {};
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      for (const r of this.db.all(`SELECT * FROM roster WHERE day BETWEEN ? AND ? AND emp IN (${ph})`, dates[0], dates[dates.length - 1], ...ids)) rows[`${r.emp}|${r.day}`] = r;
      for (const m of this.db.all(`SELECT emp, day, status FROM day_marks WHERE day BETWEEN ? AND ? AND emp IN (${ph})`, dates[0], dates[dates.length - 1], ...ids)) marks[`${m.emp}|${m.day}`] = m.status;
    }
    const hol = Object.fromEntries((this.settings.holidays || []).map((h) => [h.date, h.name]));
    return {
      dates,
      holidays: dates.filter((d) => hol[d]).map((d) => ({ date: d, name: hol[d] })),
      employees: emps.map((e) => ({
        id: e.id, code: e.code, name: e.name, nameUr: e.nameUr, shiftId: e.shiftId, branchId: e.branchId || '',
        cells: dates.map((d) => ({ date: d, ...this.dutyOn(e, d, rows[`${e.id}|${d}`] || null), mark: marks[`${e.id}|${d}`] || null })),
      })),
    };
  };
  P.putRoster = function putRoster({ actor, body }) {
    const cells = Array.isArray(body.cells) ? body.cells.slice(0, 2000) : [];
    if (!cells.length) throw bad('NOTHING', 'Nothing to save');
    this.assertDatesOpen([...new Set(cells.map((c) => c.date).filter(isDate))]);
    const changed = new Map();
    for (const c of cells) {
      if (!isDate(c.date)) throw bad('BAD_DATE', 'Bad date');
      const emp = this.empRow(str(c.employeeId, 40));
      this.assertBranch(actor, emp);
      const before = this.dutyOn(emp, c.date);
      this.setDuty(actor, emp, c.date, str(c.shiftId, 40), !!c.off, str(c.note, 100));
      const after = this.dutyOn(emp, c.date);
      if (before.shiftId !== after.shiftId || before.off !== after.off) {
        if (!changed.has(emp.id)) changed.set(emp.id, []);
        changed.get(emp.id).push(c.date);
      }
    }
    this.audit(actor, 'roster.updated', null, { cells: cells.length, employees: changed.size });
    for (const [id, ds] of changed) this.pushRoster(id, ds);
    return { ok: true, changed: [...changed.values()].reduce((a, d) => a + d.length, 0) };
  };
  P.copyRoster = function copyRoster({ actor, body }) {
    if (!isDate(body.from) || !isDate(body.to)) throw bad('BAD_DATE', 'Pick both weeks');
    const days = clampInt(body.days, 1, 31, 7);
    const target = dateRange(body.to, addDays(body.to, days - 1));
    this.assertDatesOpen(target);
    const emps = this.inBranch(actor, null, this.employees({ activeOnly: true }));
    let n = 0;
    for (const e of emps) {
      for (let i = 0; i < days; i++) {
        const src = this.dutyOn(e, addDays(body.from, i));
        const dst = addDays(body.to, i);
        const before = this.dutyOn(e, dst);
        this.setDuty(actor, e, dst, src.shiftId, src.off, src.note);
        const after = this.dutyOn(e, dst);
        if (before.shiftId !== after.shiftId || before.off !== after.off) n++;
      }
    }
    this.audit(actor, 'roster.copied', null, { from: body.from, to: body.to, days, changed: n });
    return { ok: true, changed: n };
  };
  P.pushRoster = function pushRoster(empId, dates) {
    const first = dates.sort()[0];
    this.queuePush('emp', [empId], `roster-${empId}-${first}-${this.now()}`, (ur) => ({
      title: ur ? 'ڈیوٹی روسٹر بدل گیا' : 'Your duty roster changed',
      body: ur ? `${dates.length} دن بدلے گئے، ${first} سے۔ ایپ میں روسٹر دیکھیں۔` : `${dates.length} day(s) changed from ${first}. Open the app to see your roster.`,
    }));
  };
  P.empRoster = function empRoster({ actor, q }) {
    const from = isDate(q.get('from')) ? q.get('from') : this.today();
    const dates = dateRange(from, addDays(from, clampInt(q.get('days'), 1, 31, 14) - 1));
    const s = this.settings;
    const hol = Object.fromEntries((s.holidays || []).map((h) => [h.date, h]));
    const mates = this.employees({ activeOnly: true })
      .filter((e) => e.id !== actor.id && (e.branchId || '') === (actor.branchId || ''))
      .map((e) => ({ id: e.id, code: e.code, name: e.name, nameUr: e.nameUr }));
    return {
      shifts: s.shifts,
      days: dates.map((d) => {
        const duty = this.dutyOn(actor, d);
        const sh = s.shifts.find((x) => x.id === duty.shiftId);
        return { date: d, ...duty, shift: sh ? { id: sh.id, name: sh.name, nameUr: sh.nameUr, start: sh.start, end: sh.end } : null,
          holiday: hol[d] ? (hol[d].name || 'Holiday') : null, holidayUr: hol[d]?.nameUr || null };
      }),
      colleagues: mates,
      swaps: this.db.all("SELECT * FROM requests WHERE emp = ? AND type = 'swap' AND status = 'pending'", actor.id).map((r) => ({ id: r.id, ...JSON.parse(r.data) })),
    };
  };
  P.validateSwap = function validateSwap(emp, body) {
    const date = body.date;
    const today = this.today();
    if (!isDate(date)) throw bad('BAD_DATE', 'Pick a date');
    if (date < today || date > addDays(today, 30)) throw bad('BAD_DATE', 'Pick a date in the next 30 days');
    const withId = str(body.withId, 40);
    if (!withId || withId === emp.id) throw bad('PICK_COLLEAGUE', 'Pick the colleague to swap with');
    const other = this.empRow(withId);
    if (!other.active) throw bad('PICK_COLLEAGUE', 'That colleague is not active');
    if ((other.branchId || '') !== (emp.branchId || '')) throw bad('OTHER_BRANCH', 'That colleague works at another branch');
    const mine = this.dutyOn(emp, date);
    const theirs = this.dutyOn(other, date);
    if (mine.shiftId === theirs.shiftId && mine.off === theirs.off) throw bad('SAME_DUTY', 'You both have the same duty that day');
    return { date, withId, withName: other.name, withNameUr: other.nameUr, mine: { shiftId: mine.shiftId, off: mine.off }, theirs: { shiftId: theirs.shiftId, off: theirs.off } };
  };
  P.applySwap = function applySwap(actor, emp, data) {
    this.assertDatesOpen([data.date]);
    const other = this.empRow(data.withId);
    const mine = this.dutyOn(emp, data.date);
    const theirs = this.dutyOn(other, data.date);
    this.setDuty(actor, emp, data.date, theirs.shiftId, theirs.off, `Swap with ${other.name}`);
    this.setDuty(actor, other, data.date, mine.shiftId, mine.off, `Swap with ${emp.name}`);
    this.queuePush('emp', [other.id], `swap-${data.date}-${other.id}-${this.now()}`, (ur) => ({
      title: ur ? 'شفٹ بدل دی گئی' : 'Shift swapped',
      body: ur ? `${data.date} کو آپ کی شفٹ ${emp.nameUr || emp.name} سے بدل دی گئی ہے۔` : `Your duty on ${data.date} was swapped with ${emp.name}.`,
    }));
  };

  // ---------------------------------------------------------------- forgot PIN (from the login screen, no login needed)
  P.forgotPin = function forgotPin({ body, ip }) {
    const key = `fp:${ip}`;
    this.lockCheck([key]);
    this.lockFail([key]); // at most 5 asks in a row from one place, then a pause
    const code = str(body.code, 40);
    const r = code && this.db.get(
      `SELECT id, code, data, active FROM employees WHERE deleted = 0 AND (lower(code) = lower(?) OR json_extract(data, '$.phone') = ?)`, code, code);
    // same answer whether or not the code exists, so nobody can probe for codes
    if (!r || !r.active) return { ok: true };
    if (this.db.get("SELECT id FROM requests WHERE emp = ? AND type = 'pin_reset' AND status = 'pending'", r.id)) return { ok: true };
    const id = uid();
    this.db.run("INSERT INTO requests (id, emp, type, data, status, created) VALUES (?, ?, 'pin_reset', ?, 'pending', ?)",
      id, r.id, JSON.stringify({ date: this.today(), source: 'login', reason: str(body.note, 200) }), this.now());
    this.pushNewRequest({ id, emp: r.id, type: 'pin_reset' });
    return { ok: true };
  };
  /** Approving a forgot-PIN request sets a new PIN; the admin tells it to the employee. */
  P.applyPinReset = async function applyPinReset(actor, emp, body, data, result) {
    let pin = String(body.pin || '');
    if (!pin) pin = String(Math.floor(1000 + Math.random() * 9000));
    if (!validPin(pin)) throw bad('BAD_PIN', 'PIN must be 4 to 6 digits');
    this.db.run('UPDATE employees SET pin = ?, updated = ? WHERE id = ?', await hashPin(pin, this.pepper), this.now(), emp.id);
    await this.rememberPin(emp.id, pin);
    this.lockClear(`e:${emp.code.toLowerCase()}`);
    data.pinSet = true;
    result.newPin = pin;
  };

  // ---------------------------------------------------------------- holidays
  P.pushNewHolidays = function pushNewHolidays(before, after) {
    const old = new Set(before.map((h) => h.date));
    const today = this.today();
    const fresh = after.filter((h) => !old.has(h.date) && h.date >= today);
    if (!fresh.length) return;
    const ids = this.employees({ activeOnly: true }).map((e) => e.id);
    const first = fresh[0];
    const en = fresh.length === 1 ? `${first.name || 'Holiday'} on ${first.date}` : `${fresh.length} new holidays, first on ${first.date}`;
    const ur = fresh.length === 1 ? `${first.nameUr || first.name || 'چھٹی'} · ${first.date}` : `${fresh.length} نئی چھٹیاں، پہلی ${first.date} کو`;
    this.queuePush('emp', ids, `hol-${first.date}-${this.now()}`, (u) => ({ title: u ? 'عام تعطیل' : 'Holiday', body: u ? ur : en }));
  };

  // ---------------------------------------------------------------- bonus / commission / fines
  P.pushMoney = function pushMoney(emp, kind, amount, note, id) {
    if (!MONEY_EN[kind]) return;
    const cur = this.settings.currency;
    this.queuePush('emp', [emp.id], `money-${id}`, (ur) => ({
      title: ur ? MONEY_UR[kind] : MONEY_EN[kind],
      body: `${kind === 'fine' ? '−' : '+'} ${cur} ${commas(amount)}${note ? ` · ${note}` : ''}`,
    }));
  };
  P.bulkMoney = function bulkMoney({ actor, body }) {
    const kind = body.kind;
    if (!['bonus', 'commission', 'fine'].includes(kind)) throw bad('BAD_KIND', 'Pick bonus, commission or fine');
    const month = isMonth(body.month) ? body.month : this.month();
    const percent = body.percent != null && body.percent !== '' ? Math.min(500, Math.max(0, Number(body.percent))) : null;
    const fixed = percent == null ? clampInt(body.amount, 1, 10_000_000, 0) : 0;
    if (percent == null && !fixed) throw bad('BAD_AMOUNT', 'Enter an amount');
    if (percent != null && !(percent > 0)) throw bad('BAD_AMOUNT', 'Enter a percent');
    if (kind === 'fine' && !str(body.note, 200)) throw bad('NEED_REASON', 'Write the reason for the fine');
    let emps = this.inBranch(actor, null, this.employees({ activeOnly: true }));
    if (Array.isArray(body.employeeIds)) {
      const want = new Set(body.employeeIds.map((x) => str(x, 40)));
      emps = emps.filter((e) => want.has(e.id));
    }
    if (!emps.length) throw bad('NOTHING', 'No staff picked');
    let total = 0;
    let n = 0;
    let waiting = false;
    for (const e of emps) {
      const amount = percent != null ? Math.round(((Number(e.salary) || 0) * percent) / 100) : fixed;
      if (!amount) continue;
      const res = this.addMoney({ actor, body: { employeeId: e.id, kind, amount, month, note: str(body.note, 200) } });
      waiting = waiting || res.pendingOwner;
      total += amount;
      n++;
    }
    return { ok: true, count: n, total, pendingOwner: waiting };
  };

  // ---------------------------------------------------------------- warnings and good-work notes
  P.noteOut = function noteOut(n) {
    return { id: n.id, kind: n.kind, text: n.text, ts: n.ts, byName: n.by_name, seen: n.seen, voided: !!n.voided };
  };
  P.listNotes = function listNotes({ actor, params }) {
    const emp = this.empRow(params.id, { withDeleted: true });
    this.assertBranch(actor, emp);
    const rows = this.db.all('SELECT * FROM staff_notes WHERE emp = ? AND voided = 0 ORDER BY ts DESC LIMIT 200', emp.id);
    return { notes: rows.map((n) => this.noteOut(n)), warnings: rows.filter((n) => n.kind === 'warning').length };
  };
  P.addNote = function addNote({ actor, params, body }) {
    const emp = this.empRow(params.id);
    this.assertBranch(actor, emp);
    const kind = NOTE_KINDS.includes(body.kind) ? body.kind : 'note';
    const text = str(body.text, 500);
    if (!text) throw bad('MISSING', 'Write the note');
    const id = uid();
    this.db.run('INSERT INTO staff_notes (id, emp, kind, text, ts, by_admin, by_name, seen, voided) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)',
      id, emp.id, kind, text, this.now(), actor.id, actor.name);
    this.audit(actor, `note.${kind}`, emp.id, { name: emp.name, text });
    this.queuePush('emp', [emp.id], `note-${id}`, (ur) => ({ title: ur ? NOTE_UR[kind] : NOTE_EN[kind], body: text.slice(0, 140) }));
    return { ok: true, id };
  };
  P.voidNote = function voidNote({ actor, params }) {
    const n = this.db.get('SELECT * FROM staff_notes WHERE id = ?', params.id);
    if (!n) throw notFound('Note');
    this.assertBranch(actor, this.empRow(n.emp, { withDeleted: true }));
    this.db.run('UPDATE staff_notes SET voided = 1 WHERE id = ?', n.id);
    this.audit(actor, 'note.removed', n.emp, { kind: n.kind, text: n.text });
    return { ok: true };
  };
  P.empNotes = function empNotes({ actor }) {
    return { notes: this.db.all('SELECT * FROM staff_notes WHERE emp = ? AND voided = 0 ORDER BY ts DESC LIMIT 100', actor.id).map((n) => this.noteOut(n)) };
  };
  P.empNoteSeen = function empNoteSeen({ actor, params }) {
    const n = this.db.get('SELECT * FROM staff_notes WHERE id = ? AND emp = ?', params.id, actor.id);
    if (!n) throw notFound('Note');
    if (!n.seen) this.db.run('UPDATE staff_notes SET seen = ? WHERE id = ?', this.now(), n.id);
    return { ok: true };
  };

  // ---------------------------------------------------------------- staff documents
  P.listDocs = function listDocs({ actor, params }) {
    const emp = this.empRow(params.id, { withDeleted: true });
    this.assertBranch(actor, emp);
    return { docs: this.db.all('SELECT id, kind, name, mime, size, ts FROM docs WHERE emp = ? ORDER BY ts', emp.id) };
  };
  P.addDoc = function addDoc({ actor, params, body }) {
    const emp = this.empRow(params.id);
    this.assertBranch(actor, emp);
    const kind = DOC_KINDS.includes(body.kind) ? body.kind : 'other';
    const d = String(body.dataUrl || '');
    const m = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,[A-Za-z0-9+/=]+$/.exec(d);
    if (!m) throw bad('BAD_FILE', 'File must be a photo (JPEG / PNG) or a PDF');
    if (d.length > DOC_MAX) throw bad('TOO_LARGE', 'File is too large (max 700 KB)');
    const count = this.db.get('SELECT COUNT(*) AS n FROM docs WHERE emp = ?', emp.id).n;
    if (count >= 12) throw bad('TOO_MANY', 'At most 12 files per employee');
    const id = uid();
    const size = Math.round((d.length - d.indexOf(',') - 1) * 0.75);
    this.db.run('INSERT INTO docs (id, emp, kind, name, mime, data, size, ts, by_admin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, emp.id, kind, str(body.name, 80), m[1], d, size, this.now(), actor.id);
    this.audit(actor, 'employee.doc_added', emp.id, { name: emp.name, kind, file: str(body.name, 80) });
    return { ok: true, id };
  };
  P.getDoc = function getDoc({ actor, params }) {
    const r = this.db.get('SELECT * FROM docs WHERE id = ?', params.id);
    if (!r) throw notFound('File');
    this.assertBranch(actor, this.empRow(r.emp, { withDeleted: true }));
    const b64 = r.data.slice(r.data.indexOf(',') + 1);
    const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    return new Response(bin, { headers: { 'content-type': r.mime, 'cache-control': 'private, no-store' } });
  };
  P.deleteDoc = function deleteDoc({ actor, params }) {
    const r = this.db.get('SELECT id, emp, kind, name FROM docs WHERE id = ?', params.id);
    if (!r) throw notFound('File');
    this.assertBranch(actor, this.empRow(r.emp, { withDeleted: true }));
    this.db.run('DELETE FROM docs WHERE id = ?', r.id);
    this.audit(actor, 'employee.doc_removed', r.emp, { kind: r.kind, file: r.name });
    return { ok: true };
  };

  // ---------------------------------------------------------------- monthly reminder: keep a copy in Google Drive
  P.driveReminder = function driveReminder(force) {
    const l = local(this.now(), this.settings.tzOffsetMin);
    const month = l.date.slice(0, 7);
    if (!force && (l.date.slice(8) !== '01' || l.min < hm('10:00') || this.db.kvGet('driveRemind', '') === month)) return false;
    this.db.kvSet('driveRemind', month);
    this.queuePush('admin', this.ownerIds(), `drive-${month}`, (ur) => ({
      title: ur ? 'ماہانہ بیک اپ گوگل ڈرائیو میں رکھیں' : 'Save the monthly backup to Google Drive',
      body: ur ? 'مزید → بیک اپ → "گوگل ڈرائیو میں محفوظ کریں" دبائیں۔' : 'Open More → Backup and tap "Save to Google Drive".',
    }));
    return true;
  };

  // ---------------------------------------------------------------- birthdays and work anniversaries
  /** Who has a birthday or a work anniversary on this date. */
  P.celebrations = function celebrations(emps, date) {
    const md = date.slice(5);
    const y = Number(date.slice(0, 4));
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const hit = (d) => d && (d.slice(5) === md || (!leap && d.slice(5) === '02-29' && md === '02-28'));
    const out = [];
    for (const e of emps) {
      if (hit(e.dob)) out.push({ id: e.id, name: e.name, nameUr: e.nameUr, kind: 'birthday', years: y - Number(e.dob.slice(0, 4)) });
      if (hit(e.joinDate) && y > Number(e.joinDate.slice(0, 4))) out.push({ id: e.id, name: e.name, nameUr: e.nameUr, kind: 'anniversary', years: y - Number(e.joinDate.slice(0, 4)) });
    }
    return out;
  };
  P.greetings = function greetings(force) {
    const s = this.settings;
    const l = local(this.now(), s.tzOffsetMin);
    if (!force && (l.min < hm('09:00') || this.db.kvGet('greetDate', '') === l.date)) return [];
    this.db.kvSet('greetDate', l.date);
    const list = this.celebrations(this.employees({ activeOnly: true }), l.date);
    const store = s.storeName;
    for (const c of list) {
      const bday = c.kind === 'birthday';
      this.queuePush('emp', [c.id], `greet-${c.kind}-${c.id}-${l.date}`, (ur) => (bday
        ? { title: ur ? 'سالگرہ مبارک! 🎂' : 'Happy birthday! 🎂', body: ur ? `${store} کی پوری ٹیم کی طرف سے سالگرہ مبارک۔` : `Best wishes from everyone at ${store}.` }
        : { title: ur ? `${c.years} سال مکمل! 🎉` : `${c.years} year${c.years > 1 ? 's' : ''} with us! 🎉`, body: ur ? `${store} کے ساتھ ${c.years} سال مکمل ہونے پر مبارکباد۔ آپ کی محنت کا شکریہ۔` : `Thank you for ${c.years} year${c.years > 1 ? 's' : ''} of hard work at ${store}.` }));
    }
    if (list.length) {
      const en = list.map((c) => (c.kind === 'birthday' ? `${c.name}: birthday` : `${c.name}: ${c.years} yr at work`)).join(' · ');
      const ur = list.map((c) => (c.kind === 'birthday' ? `${c.nameUr || c.name}: سالگرہ` : `${c.nameUr || c.name}: ${c.years} سال`)).join(' · ');
      this.queuePush('admin', this.ownerIds(), `greet-owner-${l.date}`, (u) => ({ title: u ? 'آج کی خوشیاں 🎉' : 'Today 🎉', body: u ? ur : en }));
    }
    return list;
  };
}

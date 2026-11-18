// All store logic: one instance lives inside the store's Durable Object.
import {
  HttpError, bad, forbidden, notFound, uid, MIN, local, toTs, hm, isDate, isMonth, addDays, dateRange,
  monthDates, metres, clampInt, str, csv, fmtHM, daysInMonth,
} from './util.js';
import { hashPin, checkPin, newToken, sha256, validPin } from './crypto.js';
import { makeBackup, checkBackup, applyBackup } from './backup.js';
import { sendPushes } from './push.js';
import { installPro } from './pro.js';
import { installOps } from './ops.js';
import { installExtra } from './extra.js';
import { defaultSettings, mergeSettings, normDows, PERMISSIONS, DEFAULT_MANAGER_PERMS, shiftMins } from './settings.js';
import { daySummary, payroll, empShift, empRole, MARKS, paidLeaveQuota, empRules } from './attendance.js';

const ADMIN_TTL = 30 * 24 * 3600 * 1000;
const EMP_TTL = 365 * 24 * 3600 * 1000;
const KIOSK_TTL = 365 * 24 * 3600 * 1000;
const OPEN_MAX_MS = 20 * 3600 * 1000; // a check-in older than this no longer counts as "inside"
const REQUEST_TYPES = ['forgot_in', 'forgot_out', 'past_day', 'leave', 'advance', 'break', 'undo_checkout', 'field_duty', 'recheckin', 'swap', 'pin_reset'];
const MONEY_KINDS = ['advance', 'deposit', 'deposit_cut', 'deposit_return', 'bonus', 'commission', 'fine'];
const MAX_BODY = 1_500_000;
const REQ_EN = { forgot_in: 'Forgot check-in', forgot_out: 'Forgot check-out', past_day: 'Fix a past day', leave: 'Leave', advance: 'Advance salary',
  break: 'Extra break', undo_checkout: 'Undo check-out', field_duty: 'Out-of-town duty', recheckin: 'Check in again', swap: 'Shift swap', pin_reset: 'Forgot PIN' };
const REQ_UR = { forgot_in: 'چیک اِن بھول گئے', forgot_out: 'چیک آؤٹ بھول گئے', past_day: 'پچھلے دن کی درستی', leave: 'چھٹی', advance: 'ایڈوانس تنخواہ',
  break: 'اضافی وقفہ', undo_checkout: 'چیک آؤٹ واپس', field_duty: 'شہر سے باہر ڈیوٹی', recheckin: 'دوبارہ چیک اِن', swap: 'شفٹ کی تبدیلی', pin_reset: 'پن بھول گئے' };

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

export class Store {
  /**
   * @param {import('./db.js').DB} db
   * @param {{SETUP_CODE?:string, PIN_PEPPER?:string}} env
   * @param {() => number} clock
   */
  constructor(db, env, clock = () => Date.now()) {
    this.db = db;
    this.env = env;
    this.now = clock;
    db.migrate();
    // Pepper mixed into every PIN hash: the PIN_PEPPER secret if set, otherwise a random one made once and kept.
    this.pepper = env.PIN_PEPPER || db.kvGet('pepper', null);
    if (!this.pepper) {
      this.pepper = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
      db.kvSet('pepper', this.pepper);
    }
    this.routes = this.buildRoutes();
    this.outbox = [];
    this.pushSender = (msgs, report) => sendPushes(this.env.FIREBASE_SERVICE_ACCOUNT, msgs, report);
  }

  // ---------------------------------------------------------------- settings / helpers
  get settings() {
    if (!this._settings) this._settings = { ...defaultSettings(), ...this.db.kvGet('settings', {}) };
    // keep rules complete when new defaults are added
    this._settings.rules = { ...defaultSettings().rules, ...this._settings.rules };
    // v0.9.5: offline punches are kept for 7 days (was 3); only moves stores still on the old default
    if (!this.db.kvGet('mig.offline7', false)) {
      this.db.kvSet('mig.offline7', true);
      if (this._settings.rules.maxOfflineHours === 72) {
        this._settings.rules.maxOfflineHours = 168;
        if (this.db.kvGet('settings', null)) this.db.kvSet('settings', this._settings);
      }
    }
    return this._settings;
  }
  saveSettings(s) {
    this.db.kvSet('settings', s);
    this._settings = s;
  }
  get off() {
    return this.settings.tzOffsetMin;
  }
  today() {
    return local(this.now(), this.off).date;
  }
  month() {
    return this.today().slice(0, 7);
  }
  bump() {
    this.db.kvSet('ver', (this.db.kvGet('ver', 0) || 0) + 1);
  }
  audit(actor, action, target, detail) {
    this.db.run(
      'INSERT INTO audit (ts, actor, actor_name, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)',
      this.now(), actor?.id || null, actor?.name || null, action, target || null, detail ? JSON.stringify(detail) : null,
    );
  }

  empRow(id, { withDeleted = false } = {}) {
    const r = this.db.get('SELECT * FROM employees WHERE id = ?', id);
    if (!r || (r.deleted && !withDeleted)) throw notFound('Employee');
    return this.empFromRow(r);
  }
  empFromRow(r) {
    return { ...JSON.parse(r.data), id: r.id, code: r.code, active: !!r.active, deleted: !!r.deleted,
      device: r.device, deviceName: r.device_name, hasPin: !!r.pin, hasPhoto: !!r.photo, photoVer: r.updated };
  }
  employees({ activeOnly = false } = {}) {
    return this.db
      .all(`SELECT id, code, data, device, device_name, active, deleted, updated, pin IS NOT NULL AS has_pin,
            photo IS NOT NULL AS has_photo FROM employees WHERE deleted = 0 ${activeOnly ? 'AND active = 1' : ''} ORDER BY code`)
      .map((r) => ({ ...JSON.parse(r.data), id: r.id, code: r.code, active: !!r.active, deleted: false, device: r.device,
        deviceName: r.device_name, hasPin: !!r.has_pin, hasPhoto: !!r.has_photo, photoVer: r.updated }));
  }
  /** Employee as shown to an admin (salary hidden without payroll permission). */
  empOut(e, actor) {
    const o = { ...e, deviceBound: !!e.device };
    delete o.device;
    if (actor && !this.can(actor, 'payroll.view')) delete o.salary;
    return o;
  }

  /** Load punches / breaks / marks for a set of employees across a date range. */
  loadDays(empIds, from, to) {
    const map = new Map();
    const key = (e, d) => `${e}|${d}`;
    const slot = (e, d) => {
      const k = key(e, d);
      if (!map.has(k)) map.set(k, { punches: [], breaks: [], mark: null, roster: null });
      return map.get(k);
    };
    const filt = empIds ? `AND emp IN (${empIds.map(() => '?').join(',')})` : '';
    const args = empIds || [];
    for (const p of this.db.all(`SELECT * FROM punches WHERE day BETWEEN ? AND ? ${filt}`, from, to, ...args)) slot(p.emp, p.day).punches.push(p);
    for (const b of this.db.all(`SELECT * FROM breaks WHERE day BETWEEN ? AND ? ${filt}`, from, to, ...args)) slot(b.emp, b.day).breaks.push(b);
    for (const m of this.db.all(`SELECT * FROM day_marks WHERE day BETWEEN ? AND ? ${filt}`, from, to, ...args)) slot(m.emp, m.day).mark = m;
    for (const x of this.db.all(`SELECT * FROM roster WHERE day BETWEEN ? AND ? ${filt}`, from, to, ...args)) slot(x.emp, x.day).roster = x;
    return (empId, date) => map.get(key(empId, date)) || { punches: [], breaks: [], mark: null, roster: null };
  }
  day(emp, date) {
    const get = this.loadDays([emp.id], date, date);
    return daySummary(emp, this.settings, date, get(emp.id, date), this.now());
  }
  /** The employee's open check-in (if any). */
  openSession(empId) {
    const last = this.db.get('SELECT * FROM punches WHERE emp = ? AND voided = 0 ORDER BY ts DESC LIMIT 1', empId);
    if (last && last.type === 'in' && this.now() - last.ts < OPEN_MAX_MS) return last;
    return null;
  }
  openBreak(empId) {
    return this.db.get('SELECT * FROM breaks WHERE emp = ? AND end IS NULL ORDER BY start DESC LIMIT 1', empId);
  }

  // ---------------------------------------------------------------- auth
  can(actor, perm) {
    return actor.role === 'owner' || (actor.perms || []).includes(perm);
  }
  need(actor, perm) {
    if (!this.can(actor, perm)) throw forbidden('NO_PERMISSION', `You need the "${perm}" permission`);
  }

  lockCheck(keys) {
    const now = this.now();
    for (const k of keys) {
      const r = this.db.get('SELECT until FROM pin_fail WHERE key = ?', k);
      if (r && r.until > now) {
        throw new HttpError(429, 'LOCKED', 'Too many wrong PINs. Try again later.', { retryAfterSec: Math.ceil((r.until - now) / 1000) });
      }
    }
  }
  lockFail(keys) {
    const now = this.now();
    for (const k of keys) {
      const r = this.db.get('SELECT * FROM pin_fail WHERE key = ?', k) || { count: 0, locks: 0 };
      let count = r.count + 1;
      let locks = r.locks;
      let until = 0;
      const limit = k.startsWith('ip:') ? 20 : 5;
      if (count >= limit) {
        locks += 1;
        until = now + Math.min(60, 5 * 2 ** (locks - 1)) * MIN;
        count = 0;
      }
      this.db.run(
        `INSERT INTO pin_fail (key, count, locks, until, last) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET count = excluded.count, locks = excluded.locks, until = excluded.until, last = excluded.last`,
        k, count, locks, until, now,
      );
    }
  }
  lockClear(key) {
    this.db.run('DELETE FROM pin_fail WHERE key = ?', key);
  }

  async issueToken(kind, sub, device, ttl) {
    const token = newToken();
    this.db.run('INSERT INTO sessions (token, kind, sub, device, created, expires) VALUES (?, ?, ?, ?, ?, ?)',
      await sha256(token), kind, sub, device || null, this.now(), this.now() + ttl);
    return token;
  }

  async authenticate(req, kind) {
    const h = req.headers.get('authorization') || '';
    const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(h);
    if (!m) throw new HttpError(401, 'NO_TOKEN', 'Please log in');
    const s = this.db.get('SELECT * FROM sessions WHERE token = ?', await sha256(m[1]));
    if (!s || s.kind !== kind || s.expires < this.now()) throw new HttpError(401, 'BAD_TOKEN', 'Session expired, please log in again');

    if (kind === 'admin') {
      const a = this.db.get('SELECT * FROM admins WHERE id = ?', s.sub);
      if (!a || !a.active) throw new HttpError(401, 'BAD_TOKEN', 'Account disabled');
      const branchId = a.role === 'owner' ? '' : this.db.kvGet('adminBranches', {})[a.id] || '';
      return { id: a.id, name: a.name, login: a.login, role: a.role, perms: JSON.parse(a.perms), kind: 'admin', branchId, device: s.device || '' };
    }
    if (kind === 'emp') {
      const r = this.db.get('SELECT * FROM employees WHERE id = ?', s.sub);
      const dev = req.headers.get('x-device-id');
      if (!r || r.deleted || !r.active) throw new HttpError(401, 'BAD_TOKEN', 'Account disabled');
      if (!r.device || r.device !== s.device || (dev && dev !== s.device)) {
        throw new HttpError(401, 'DEVICE_RESET', 'This phone is no longer linked. Please log in again.');
      }
      return { ...this.empFromRow(r), kind: 'emp' };
    }
    if (kind === 'kiosk') {
      const kiosks = this.db.kvGet('kiosks', []);
      const k = kiosks.find((x) => x.id === s.sub);
      if (!k) throw new HttpError(401, 'BAD_TOKEN', 'Kiosk removed');
      return { ...k, kind: 'kiosk' };
    }
    throw new HttpError(401, 'BAD_TOKEN', 'Bad session');
  }

  // ---------------------------------------------------------------- HTTP entry
  async handle(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    try {
      const route = this.routes.find((r) => r.method === req.method && r.re.test(path));
      if (!route) throw notFound('Route');
      const params = route.re.exec(path).groups || {};
      let body = {};
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const len = Number(req.headers.get('content-length') || 0);
        const max = route.maxBody || MAX_BODY;
        if (len > max) throw new HttpError(413, 'TOO_LARGE', 'Request too large');
        const text = await req.text();
        if (text.length > max) throw new HttpError(413, 'TOO_LARGE', 'Request too large');
        if (text) {
          try { body = JSON.parse(text); } catch { throw bad('BAD_JSON', 'Body must be JSON'); }
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('BAD_JSON', 'Body must be a JSON object');
      }
      const ctx = { req, url, body, params, q: url.searchParams, ip: req.headers.get('cf-connecting-ip') || 'local' };
      if (route.auth !== 'none') {
        ctx.actor = await this.authenticate(req, route.auth);
        if (route.perm) this.need(ctx.actor, route.perm);
        if (route.owner && ctx.actor.role !== 'owner') throw forbidden('OWNER_ONLY', 'Only the owner can do this');
      }
      const out = await route.fn(ctx);
      if (req.method !== 'GET') this.bump();
      if (this.outbox.length) await this.flushPush();
      if (out instanceof Response) return out;
      return json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message, ...(e.extra || {}) }, e.status);
      console.error(e);
      this.outbox = [];
      this.logError(`${req.method} ${path.replace(/\/[A-Za-z0-9_-]{16,}/g, '/:id')}`, e);
      if (this.outbox.length) await this.flushPush().catch(() => {});
      return json({ error: 'SERVER', message: 'Something went wrong' }, 500);
    }
  }

  buildRoutes() {
    const R = [];
    const add = (method, path, fn, opts = {}) => {
      const re = new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_-]+)')}$`);
      R.push({ method, re, fn: fn.bind(this), auth: opts.auth || 'none', perm: opts.perm, owner: opts.owner, maxBody: opts.maxBody });
    };
    const A = (perm, extra = {}) => ({ auth: 'admin', perm, ...extra });
    // public
    add('GET', '/api/info', this.info);
    add('GET', '/api/time', () => ({ serverTime: this.now() }));
    add('GET', '/api/logo', this.logo);
    add('POST', '/api/setup', this.setup);
    add('POST', '/api/admin/login', this.adminLogin);
    add('POST', '/api/emp/login', this.empLogin);
    add('POST', '/api/kiosk/login', this.kioskLogin);
    // admin
    add('GET', '/api/admin/me', (c) => ({ me: c.actor, permissions: PERMISSIONS, serverTime: this.now() }), A());
    add('POST', '/api/admin/logout', this.logout, A());
    add('POST', '/api/admin/me/pin', this.changeOwnPin, A());
    add('GET', '/api/admin/changes', this.changes, A());
    add('GET', '/api/admin/board', this.board, A());
    add('GET', '/api/admin/settings', () => this.settings, A());
    add('PUT', '/api/admin/settings', this.putSettings, A('settings.edit'));
    add('PUT', '/api/admin/logo', this.putLogo, A('settings.edit'));
    add('GET', '/api/admin/backup', this.backup, A(null, { owner: true }));
    add('POST', '/api/admin/restore', this.restore, A(null, { owner: true, maxBody: 40_000_000 }));
    add('GET', '/api/admin/users', this.listUsers, A(null, { owner: true }));
    add('POST', '/api/admin/users', this.saveUser, A(null, { owner: true }));
    add('PUT', '/api/admin/users/:id', this.saveUser, A(null, { owner: true }));
    add('DELETE', '/api/admin/users/:id', this.deleteUser, A(null, { owner: true }));
    add('GET', '/api/admin/employees', this.listEmployees, A('employees.view'));
    add('POST', '/api/admin/employees', this.saveEmployee, A('employees.edit'));
    add('GET', '/api/admin/employees/:id', this.getEmployee, A('employees.view'));
    add('PUT', '/api/admin/employees/:id', this.saveEmployee, A('employees.edit'));
    add('DELETE', '/api/admin/employees/:id', this.deleteEmployee, A('employees.edit'));
    add('GET', '/api/admin/employees/:id/photo', this.empPhoto, A('employees.view'));
    add('PUT', '/api/admin/employees/:id/photo', this.putEmpPhoto, A('employees.edit'));
    add('POST', '/api/admin/employees/:id/pin', this.setEmpPin, A('employees.edit'));
    add('POST', '/api/admin/employees/:id/reset-device', this.resetDevice, A(null, { owner: true }));
    add('GET', '/api/admin/employees/:id/calendar', this.adminCalendar, A('employees.view'));
    add('GET', '/api/admin/employees/:id/day/:date', this.adminDay, A('employees.view'));
    add('GET', '/api/admin/employees/:id/money', this.listMoney, A('payroll.view'));
    add('POST', '/api/admin/punch', this.adminPunch, A('attendance.punch'));
    add('POST', '/api/admin/punches/:id/void', this.voidPunch, A('attendance.punch'));
    add('GET', '/api/admin/punches/:id/photo', this.punchPhoto, A('employees.view'));
    add('POST', '/api/admin/mark', this.adminMark, A('attendance.punch'));
    add('POST', '/api/admin/break/end', this.adminEndBreak, A('attendance.punch'));
    add('GET', '/api/admin/requests', this.listRequests, A());
    add('GET', '/api/admin/notify', this.adminNotify, A());
    add('POST', '/api/admin/push-token', (c) => this.pushToken(c, 'admin'), A());
    add('POST', '/api/admin/requests/:id/decide', this.decide, A('requests.decide'));
    add('POST', '/api/admin/money', this.addMoney, A('money.edit'));
    add('POST', '/api/admin/money/:id/void', this.voidMoney, A('money.edit'));
    add('GET', '/api/admin/payroll', this.payrollAll, A('payroll.view'));
    add('GET', '/api/admin/payroll/:id', this.payrollOne, A('payroll.view'));
    add('GET', '/api/admin/reports', this.reports, A('reports.view'));
    add('GET', '/api/admin/audit', this.auditLog, A('audit.view'));
    add('GET', '/api/admin/kiosks', () => ({ kiosks: this.db.kvGet('kiosks', []) }), A('kiosk.setup'));
    add('POST', '/api/admin/kiosks', this.addKiosk, A('kiosk.setup'));
    add('DELETE', '/api/admin/kiosks/:id', this.removeKiosk, A('kiosk.setup'));
    // employee
    add('GET', '/api/emp/home', this.empHome, { auth: 'emp' });
    add('POST', '/api/emp/punch', this.empPunch, { auth: 'emp' });
    add('POST', '/api/emp/break/end', this.empEndBreak, { auth: 'emp' });
    add('GET', '/api/emp/requests', this.empRequests, { auth: 'emp' });
    add('GET', '/api/emp/notify', this.empNotify, { auth: 'emp' });
    add('POST', '/api/emp/push-token', (c) => this.pushToken(c, 'emp'), { auth: 'emp' });
    add('POST', '/api/admin/push-test', (c) => this.pushTest(c, 'admin'), A());
    add('POST', '/api/emp/push-test', (c) => this.pushTest(c, 'emp'), { auth: 'emp' });
    add('POST', '/api/emp/requests', this.empNewRequest, { auth: 'emp' });
    add('POST', '/api/emp/requests/:id/cancel', this.empCancelRequest, { auth: 'emp' });
    add('GET', '/api/emp/calendar', this.empCalendar, { auth: 'emp' });
    add('GET', '/api/emp/statement', this.empStatement, { auth: 'emp' });
    add('GET', '/api/emp/photo', (c) => this.empPhoto({ ...c, params: { id: c.actor.id } }), { auth: 'emp' });
    add('POST', '/api/emp/logout', this.logout, { auth: 'emp' });
    add('GET', '/api/emp/helper', this.helperList, { auth: 'emp' });
    add('GET', '/api/emp/helper/:id/photo', this.helperPhoto, { auth: 'emp' });
    add('POST', '/api/emp/helper/punch', this.helperPunch, { auth: 'emp' });
    // kiosk
    add('GET', '/api/kiosk/employees', this.kioskEmployees, { auth: 'kiosk' });
    add('GET', '/api/kiosk/employees/:id/photo', this.kioskEmpPhoto, { auth: 'kiosk' });
    add('POST', '/api/kiosk/punch', this.kioskPunch, { auth: 'kiosk' });
    this.proRoutes(add, A);
    this.opsRoutes(add, A);
    this.extraRoutes(add, A);
    return R;
  }

  // ---------------------------------------------------------------- public
  info() {
    const s = this.settings;
    return {
      storeName: s.storeName,
      setupDone: !!this.db.get('SELECT 1 AS x FROM admins LIMIT 1'),
      logoVer: this.db.kvGet('logoVer', 0),
      serverTime: this.now(),
      tzOffsetMin: s.tzOffsetMin,
      currency: s.currency,
    };
  }
  logo() {
    const data = this.db.kvGet('logo', null);
    if (!data) return new Response(null, { status: 404 });
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(data);
    const bin = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
    return new Response(bin, { headers: { 'content-type': m[1], 'cache-control': 'public, max-age=300' } });
  }

  async setup({ body }) {
    if (this.db.get('SELECT 1 AS x FROM admins LIMIT 1')) throw forbidden('ALREADY_SETUP', 'Store is already set up');
    // forgiving compare: phones add capital letters and spaces on their own
    const norm = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!norm(this.env.SETUP_CODE) || norm(body.setupCode) !== norm(this.env.SETUP_CODE)) throw forbidden('BAD_SETUP_CODE', 'Wrong setup code');
    if (!validPin(body.pin)) throw bad('BAD_PIN', 'PIN must be 4 to 6 digits');
    const id = uid();
    const name = str(body.name, 60) || 'Owner';
    const login = str(body.login, 40).toLowerCase() || 'owner';
    this.db.run('INSERT INTO admins (id, name, login, role, perms, pin, active, created) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      id, name, login, 'owner', '[]', await hashPin(body.pin, this.pepper), this.now());
    if (body.storeName) this.saveSettings(mergeSettings(this.settings, { storeName: body.storeName }));
    this.audit({ id, name }, 'setup', null, { login });
    const token = await this.issueToken('admin', id, null, ADMIN_TTL);
    return { token, me: { id, name, login, role: 'owner', perms: [] } };
  }

  async adminLogin({ body, ip }) {
    const login = str(body.login, 40).toLowerCase();
    const keys = [`a:${login}`, `ip:${ip}`];
    this.lockCheck(keys);
    const a = this.db.get('SELECT * FROM admins WHERE login = ?', login);
    const ok = a && a.active && (await checkPin(String(body.pin || ''), a.pin, this.pepper));
    if (!ok) {
      this.lockFail(keys);
      throw new HttpError(401, 'WRONG_PIN', 'Wrong name or PIN');
    }
    this.lockClear(keys[0]);
    // a browser (owner web page) stays logged in for 12 hours; the phone app for 30 days
    const web = str(body.deviceId, 80).startsWith('web-');
    const token = await this.issueToken('admin', a.id, str(body.deviceId, 80), web ? 12 * 3600 * 1000 : ADMIN_TTL);
    this.audit({ id: a.id, name: a.name }, 'login', null, { device: str(body.deviceName, 60) });
    return { token, me: { id: a.id, name: a.name, login: a.login, role: a.role, perms: JSON.parse(a.perms) }, serverTime: this.now() };
  }

  async empLogin({ body, ip }) {
    const code = str(body.code, 40);
    const deviceId = str(body.deviceId, 80);
    if (!deviceId || deviceId.length < 8) throw bad('NO_DEVICE', 'Device id missing');
    const keys = [`e:${code.toLowerCase()}`, `ip:${ip}`, `d:${deviceId}`];
    this.lockCheck(keys);
    const r = this.db.get(
      `SELECT * FROM employees WHERE deleted = 0 AND (lower(code) = lower(?) OR json_extract(data, '$.phone') = ?)`, code, code);
    const ok = r && r.active && (await checkPin(String(body.pin || ''), r.pin, this.pepper));
    if (!ok) {
      this.lockFail(keys);
      throw new HttpError(401, 'WRONG_PIN', 'Wrong employee code or PIN');
    }
    if (deviceId.startsWith('web-') && !JSON.parse(r.data).webAllowed) {
      throw forbidden('WEB_NOT_ALLOWED', 'The web version is not turned on for you. Ask the owner.');
    }
    if (r.device && r.device !== deviceId) {
      throw forbidden('BOUND_TO_OTHER_PHONE', 'Your account is linked to another phone. Ask the owner to reset it.');
    }
    const other = this.db.get('SELECT id, data FROM employees WHERE device = ? AND id != ? AND deleted = 0', deviceId, r.id);
    if (other) {
      throw forbidden('PHONE_USED_BY_OTHER', `This phone belongs to ${JSON.parse(other.data).name}. One phone = one employee.`);
    }
    this.lockClear(keys[0]);
    this.lockClear(keys[2]);
    if (!r.device) {
      this.db.run('UPDATE employees SET device = ?, device_name = ?, updated = ? WHERE id = ?', deviceId, str(body.deviceName, 60), this.now(), r.id);
      this.audit({ id: r.id, name: JSON.parse(r.data).name }, 'employee.phone_linked', r.id, { device: str(body.deviceName, 60) });
    }
    this.db.run("DELETE FROM sessions WHERE kind = 'emp' AND sub = ?", r.id);
    const token = await this.issueToken('emp', r.id, deviceId, EMP_TTL);
    return { token, employee: { id: r.id, code: r.code, name: JSON.parse(r.data).name }, serverTime: this.now() };
  }

  async logout({ req }) {
    const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.get('authorization') || '');
    if (m) this.db.run('DELETE FROM sessions WHERE token = ?', await sha256(m[1]));
    return { ok: true };
  }

  async changeOwnPin({ actor, body }) {
    const a = this.db.get('SELECT * FROM admins WHERE id = ?', actor.id);
    if (!(await checkPin(String(body.oldPin || ''), a.pin, this.pepper))) throw new HttpError(401, 'WRONG_PIN', 'Old PIN is wrong');
    if (!validPin(body.newPin)) throw bad('BAD_PIN', 'PIN must be 4 to 6 digits');
    this.db.run('UPDATE admins SET pin = ? WHERE id = ?', await hashPin(body.newPin, this.pepper), actor.id);
    this.audit(actor, 'admin.pin_changed', actor.id);
    return { ok: true };
  }

  // ---------------------------------------------------------------- admin: users
  listUsers() {
    return {
      users: this.db.all('SELECT id, name, login, role, perms, active, created FROM admins ORDER BY created')
        .map((u) => ({ ...u, perms: JSON.parse(u.perms), active: !!u.active, branchId: this.db.kvGet('adminBranches', {})[u.id] || '' })),
      permissions: PERMISSIONS,
    };
  }
  async saveUser({ actor, body, params }) {
    const id = params.id || uid();
    const existing = params.id ? this.db.get('SELECT * FROM admins WHERE id = ?', id) : null;
    if (params.id && !existing) throw notFound('User');
    const name = str(body.name, 60) || existing?.name;
    const login = (str(body.login, 40) || existing?.login || '').toLowerCase();
    if (!name || !login) throw bad('MISSING', 'Name and login are required');
    if (!/^[a-z0-9._-]{2,40}$/.test(login)) throw bad('BAD_LOGIN', 'Login can use letters, numbers, dot, dash');
    const dupe = this.db.get('SELECT id FROM admins WHERE login = ? AND id != ?', login, id);
    if (dupe) throw bad('LOGIN_TAKEN', 'That login is already used');
    const role = existing?.role === 'owner' ? 'owner' : body.role === 'owner' ? 'owner' : 'manager';
    const perms = Array.isArray(body.perms) ? body.perms.filter((p) => PERMISSIONS.includes(p)) : existing ? JSON.parse(existing.perms) : DEFAULT_MANAGER_PERMS;
    const active = existing?.id === actor.id ? 1 : body.active === undefined ? (existing ? existing.active : 1) : body.active ? 1 : 0;
    let pin = existing?.pin || null;
    if (body.pin !== undefined && body.pin !== '') {
      if (!validPin(body.pin)) throw bad('BAD_PIN', 'PIN must be 4 to 6 digits');
      pin = await hashPin(body.pin, this.pepper);
    }
    if (!pin) throw bad('BAD_PIN', 'A PIN is required');
    if (existing) {
      this.db.run('UPDATE admins SET name = ?, login = ?, role = ?, perms = ?, pin = ?, active = ? WHERE id = ?', name, login, role, JSON.stringify(perms), pin, active, id);
      if (!active) this.db.run("DELETE FROM sessions WHERE kind = 'admin' AND sub = ?", id);
    } else {
      this.db.run('INSERT INTO admins (id, name, login, role, perms, pin, active, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, name, login, role, JSON.stringify(perms), pin, active, this.now());
    }
    if ('branchId' in body) {
      const br = str(body.branchId, 40);
      if (br && !this.settings.locations.some((l) => l.id === br)) throw bad('BAD_BRANCH', 'Unknown branch');
      const map = this.db.kvGet('adminBranches', {});
      if (br && role !== 'owner') map[id] = br; else delete map[id];
      this.db.kvSet('adminBranches', map);
    }
    this.audit(actor, existing ? 'user.updated' : 'user.added', id, { name, login, role, perms, active: !!active, pinChanged: body.pin ? true : undefined, branchId: body.branchId });
    return { id };
  }
  deleteUser({ actor, params }) {
    if (params.id === actor.id) throw bad('SELF', 'You cannot delete yourself');
    const u = this.db.get('SELECT * FROM admins WHERE id = ?', params.id);
    if (!u) throw notFound('User');
    this.db.run('DELETE FROM admins WHERE id = ?', params.id);
    this.db.run("DELETE FROM sessions WHERE kind = 'admin' AND sub = ?", params.id);
    this.audit(actor, 'user.deleted', params.id, { name: u.name });
    return { ok: true };
  }

  // ---------------------------------------------------------------- admin: settings
  putSettings({ actor, body }) {
    const before = this.settings;
    const next = mergeSettings(before, body);
    this.saveSettings(next);
    if ('holidays' in body) this.pushNewHolidays(before.holidays || [], next.holidays);
    const changed = Object.keys(body);
    this.audit(actor, 'settings.updated', null, { changed, rules: body.rules, locations: body.locations });
    return next;
  }
  putLogo({ actor, body }) {
    const d = String(body.dataUrl || '');
    if (d && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(d)) throw bad('BAD_IMAGE', 'Logo must be a PNG, JPEG or WEBP image');
    if (d.length > 400_000) throw bad('TOO_LARGE', 'Logo is too large (max 300 KB)');
    this.db.kvSet('logo', d || null);
    this.db.kvSet('logoVer', this.now());
    this.audit(actor, 'settings.logo', null);
    return { logoVer: this.now() };
  }

  // ---------------------------------------------------------------- admin: employees
  listEmployees({ actor, q }) {
    const all = q.get('all') === '1';
    return { employees: this.inBranch(actor, q, this.employees({ activeOnly: !all })).map((e) => this.empOut(e, actor)) };
  }
  getEmployee({ actor, params }) {
    const e = this.empRow(params.id);
    this.assertBranch(actor, e);
    const out = this.empOut(e, actor);
    if (this.can(actor, 'payroll.view')) out.depositBalance = this.depositBalance(e.id);
    const ps = this.db.get("SELECT data FROM approvals WHERE kind = 'salary' AND status = 'pending' AND emp = ? ORDER BY created DESC LIMIT 1", e.id);
    if (ps && this.can(actor, 'payroll.view')) out.salaryPending = JSON.parse(ps.data).to;
    const acc = this.db.kvGet('policyAccept', {})[e.id] || null;
    out.rulesAccepted = acc ? { ...acc, current: acc.ver === this.policyVer() } : null;
    return { employee: out };
  }
  nextCode() {
    const rows = this.db.all("SELECT code FROM employees WHERE code GLOB 'E[0-9]*'");
    const max = rows.reduce((m, r) => Math.max(m, Number(r.code.slice(1)) || 0), 0);
    return `E${String(max + 1).padStart(3, '0')}`;
  }
  async saveEmployee({ actor, body, params }) {
    const s = this.settings;
    const existing = params.id ? this.empRow(params.id) : null;
    const cur = existing || {};
    const pick = (k, dflt) => (k in body ? body[k] : k in cur ? cur[k] : dflt);
    const data = {
      name: str(pick('name', ''), 60),
      nameUr: str(pick('nameUr', ''), 60),
      phone: str(pick('phone', ''), 20).replace(/[^\d+]/g, ''),
      cnic: str(pick('cnic', ''), 20),
      roleId: str(pick('roleId', s.roles[0].id), 40),
      shiftId: str(pick('shiftId', s.shifts[0].id), 40),
      salary: clampInt(pick('salary', 0), 0, 10_000_000, 0),
      weeklyOff: pick('weeklyOff', null) === null ? null : normDows(pick('weeklyOff', null)),
      fieldStaff: !!pick('fieldStaff', false),
      kioskAllowed: !!pick('kioskAllowed', true),
      // may use the web version (iPhone): no phone binding by hardware id, so the owner turns it on per person
      webAllowed: !!pick('webAllowed', false),
      paidLeavePerMonth: pick('paidLeavePerMonth', null) === null || pick('paidLeavePerMonth', null) === '' ? null : clampInt(pick('paidLeavePerMonth', null), 0, 31, null),
      salaryVisibility: ['last7', 'window'].includes(pick('salaryVisibility', 'always')) ? pick('salaryVisibility', 'always') : 'always',
      joinDate: pick('joinDate', '') && isDate(pick('joinDate', '')) ? pick('joinDate', '') : null,
      notes: str(pick('notes', ''), 300),
      // staff file
      fatherName: str(pick('fatherName', ''), 60),
      dob: pick('dob', '') && isDate(pick('dob', '')) ? pick('dob', '') : null,
      address: str(pick('address', ''), 200),
      emergencyName: str(pick('emergencyName', ''), 60),
      emergencyPhone: str(pick('emergencyPhone', ''), 20).replace(/[^\d+]/g, ''),
      // branch = one of the store locations; '' = any location
      branchId: str(pick('branchId', ''), 40),
      // co-workers this employee may check in/out on their own phone (each one types their own PIN)
      helperFor: (Array.isArray(pick('helperFor', [])) ? pick('helperFor', []) : []).map((x) => str(x, 40)).filter(Boolean).slice(0, 30),
      // set by the final settlement; cleared when the employee is made active again
      leaveDate: body.active === true && existing && !existing.active ? null : (isDate(pick('leaveDate', '')) ? pick('leaveDate', '') : null),
      leaveNote: body.active === true && existing && !existing.active ? '' : str(pick('leaveNote', ''), 300),
    };
    if (!data.name) throw bad('MISSING', 'Name is required');
    if (!s.roles.some((r) => r.id === data.roleId)) throw bad('BAD_ROLE', 'Unknown role');
    if (!s.shifts.some((r) => r.id === data.shiftId)) throw bad('BAD_SHIFT', 'Unknown shift');
    if (data.branchId && !s.locations.some((l) => l.id === data.branchId)) throw bad('BAD_BRANCH', 'Unknown branch');
    if (actor.branchId) data.branchId = actor.branchId; // a branch manager adds staff to their own branch
    if (existing && !this.can(actor, 'payroll.view')) data.salary = existing.salary; // cannot change what they cannot see
    // a manager's salary change waits for the owner
    let salaryAsk = null;
    if (!this.isOwner(actor) && data.salary !== (existing ? existing.salary : 0)) {
      salaryAsk = { from: existing ? existing.salary : 0, to: data.salary };
      data.salary = existing ? existing.salary : 0;
    }
    let code = str(body.code, 20) || cur.code || this.nextCode();
    if (!/^[A-Za-z0-9-]{1,20}$/.test(code)) throw bad('BAD_CODE', 'Employee code can use letters, numbers and dash');
    const dupe = this.db.get('SELECT id FROM employees WHERE lower(code) = lower(?) AND id != ?', code, existing?.id || '');
    if (dupe) throw bad('CODE_TAKEN', 'That employee code is already used');
    if (data.phone) {
      const p = this.db.get("SELECT id FROM employees WHERE deleted = 0 AND json_extract(data, '$.phone') = ? AND id != ?", data.phone, existing?.id || '');
      if (p) throw bad('PHONE_TAKEN', 'Another employee has this phone number');
    }
    const active = 'active' in body ? (body.active ? 1 : 0) : existing ? (existing.active ? 1 : 0) : 1;
    let pin;
    if (body.pin) {
      if (!validPin(String(body.pin))) throw bad('BAD_PIN', 'PIN must be 4 to 6 digits');
      pin = await hashPin(String(body.pin), this.pepper);
    }
    const id = existing?.id || uid();
    if (existing) {
      this.db.run(`UPDATE employees SET code = ?, data = ?, active = ?, updated = ? ${pin ? ', pin = ?' : ''} WHERE id = ?`,
        code, JSON.stringify(data), active, this.now(), ...(pin ? [pin] : []), id);
      if (!active) this.db.run("DELETE FROM sessions WHERE kind = 'emp' AND sub = ?", id);
      const changes = {};
      for (const k of Object.keys(data)) if (JSON.stringify(data[k]) !== JSON.stringify(existing[k])) changes[k] = [existing[k], data[k]];
      if (existing.code !== code) changes.code = [existing.code, code];
      if (existing.active !== !!active) changes.active = [existing.active, !!active];
      if (pin) changes.pin = 'changed';
      this.audit(actor, 'employee.updated', id, { name: data.name, changes });
    } else {
      this.db.run('INSERT INTO employees (id, code, data, pin, active, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, code, JSON.stringify(data), pin || null, active, this.now(), this.now());
      this.audit(actor, 'employee.added', id, { name: data.name, code, salary: data.salary });
    }
    if (body.photo !== undefined) this.putEmpPhoto({ actor, body: { dataUrl: body.photo }, params: { id }, quiet: true });
    if (salaryAsk) {
      this.db.run("UPDATE approvals SET status = 'cancelled', decided = ? WHERE kind = 'salary' AND status = 'pending' AND emp = ?", this.now(), id);
      this.askOwner(actor, 'salary', this.empRow(id), salaryAsk);
    }
    return { employee: this.empOut(this.empRow(id), actor), salaryPendingOwner: !!salaryAsk };
  }
  deleteEmployee({ actor, params }) {
    const e = this.empRow(params.id);
    this.db.run("UPDATE employees SET deleted = 1, active = 0, device = NULL, code = code || '~' || id, updated = ? WHERE id = ?", this.now(), e.id);
    this.db.run("DELETE FROM sessions WHERE kind = 'emp' AND sub = ?", e.id);
    this.audit(actor, 'employee.deleted', e.id, { name: e.name, code: e.code });
    return { ok: true };
  }
  empPhoto({ params }) {
    const r = this.db.get('SELECT photo FROM employees WHERE id = ?', params.id);
    if (!r?.photo) return new Response(null, { status: 404 });
    return dataUrlResponse(r.photo);
  }
  putEmpPhoto({ actor, body, params, quiet }) {
    const e = this.empRow(params.id);
    const d = body.dataUrl ? String(body.dataUrl) : null;
    if (d && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(d)) throw bad('BAD_IMAGE', 'Photo must be a PNG, JPEG or WEBP image');
    if (d && d.length > 300_000) throw bad('TOO_LARGE', 'Photo is too large');
    this.db.run('UPDATE employees SET photo = ?, updated = ? WHERE id = ?', d, this.now(), e.id);
    if (!quiet) this.audit(actor, 'employee.photo', e.id, { name: e.name });
    return { ok: true };
  }
  async setEmpPin({ actor, body, params }) {
    const e = this.empRow(params.id);
    if (!validPin(String(body.pin || ''))) throw bad('BAD_PIN', 'PIN must be 4 to 6 digits');
    this.db.run('UPDATE employees SET pin = ?, updated = ? WHERE id = ?', await hashPin(String(body.pin), this.pepper), this.now(), e.id);
    this.lockClear(`e:${e.code.toLowerCase()}`);
    this.audit(actor, 'employee.pin_set', e.id, { name: e.name });
    return { ok: true };
  }
  resetDevice({ actor, params }) {
    const e = this.empRow(params.id);
    this.db.run('UPDATE employees SET device = NULL, device_name = NULL, updated = ? WHERE id = ?', this.now(), e.id);
    this.db.run("DELETE FROM sessions WHERE kind = 'emp' AND sub = ?", e.id);
    this.audit(actor, 'employee.phone_reset', e.id, { name: e.name, oldPhone: e.deviceName });
    return { ok: true };
  }

  // ---------------------------------------------------------------- punching
  /** Which date a check-in at ts belongs to (handles shifts that cross midnight). */
  /** Earliest check-in time for a day (shift start minus the allowed minutes); null = no limit (off day, holiday, rule off). */
  checkInOpensTs(emp, date) {
    const s = this.settings;
    const r = empRules(emp, s);
    if (!r.checkInWindowOn) return null;
    if ((s.holidays || []).some((h) => h.date === date)) return null;
    if (this.dutyOn(emp, date).off) return null;
    const sm = shiftMins(this.shiftOn(emp, date));
    return toTs(date, sm.start - (Number(r.checkInEarlyMin) || 0), s.tzOffsetMin);
  }
  /** Shift end for a day, as a time stamp. */
  shiftEndTs(emp, date) {
    const sm = shiftMins(this.shiftOn(emp, date));
    return toTs(date, sm.end, this.settings.tzOffsetMin);
  }

  dayForIn(emp, ts) {
    const s = this.settings;
    const l = local(ts, s.tzOffsetMin);
    const prev = addDays(l.date, -1);
    const sm = shiftMins(this.shiftOn(emp, prev));
    if (sm.end > 1440) {
      // early-morning check-in still inside yesterday's shift (e.g. night shift 22:00-06:00)
      if (ts < toTs(prev, sm.end, s.tzOffsetMin) && l.min < sm.start - 120) return prev;
    }
    return l.date;
  }

  geo(emp, type, loc, { kiosk = false } = {}) {
    const s = this.settings;
    const r = empRules(emp, s);
    const role = empRole(emp, s);
    const anywhere = type === 'in'
      ? !kiosk && (emp.fieldStaff || !r.requireInRadiusCheckIn)
      : !kiosk && (emp.fieldStaff || role?.checkoutAnywhere);
    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);
    const has = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
    if (has && loc.mock && r.blockMockLocation) throw forbidden('MOCK_LOCATION', 'Fake GPS apps are not allowed. Turn them off and try again.');
    let dist = null;
    let inside = false;
    const branch = emp.branchId && s.locations.find((L) => L.id === emp.branchId);
    const places = branch ? [branch] : s.locations;
    if (has && places.length) {
      const acc = Math.min(Math.max(0, Number(loc.acc) || 0), 50);
      for (const L of places) {
        const d = metres({ lat, lng }, L);
        if (dist == null || d < dist) dist = d;
        if (d - acc <= L.radius) inside = true;
      }
    }
    if (!anywhere) {
      if (!s.locations.length) throw forbidden('NO_STORE_LOCATION', 'The store location is not set yet. Ask the admin.');
      if (!has) throw bad('NO_LOCATION', 'Location is needed. Turn on GPS and try again.');
      if (!inside) throw forbidden('OUTSIDE_RADIUS', `You are ${Math.round(dist)} m away from ${branch ? branch.name : 'the store'}.`, { distance: Math.round(dist), branch: branch?.name });
    }
    return { lat: has ? lat : null, lng: has ? lng : null, acc: has ? Number(loc.acc) || null : null, dist: dist == null ? null : Math.round(dist) };
  }

  /**
   * Record a live punch. ts defaults to server time; an offline punch carries the phone's
   * estimate of server time when it happened, which is checked against what we already know.
   */
  punch(emp, { type, source, loc, offlineTs, clientId, byAdmin, reason, skipGeo, kiosk }) {
    if (!['in', 'out'].includes(type)) throw bad('BAD_TYPE', 'type must be in or out');
    if (!emp.active) throw forbidden('INACTIVE', 'Employee is not active');
    const now = this.now();
    if (clientId) {
      const dup = this.db.get('SELECT * FROM punches WHERE emp = ? AND client_id = ?', emp.id, clientId);
      if (dup) return { punch: dup, duplicate: true };
    }
    let ts = now;
    let offline = 0;
    if (offlineTs != null) {
      const t = Number(offlineTs);
      const maxAge = this.settings.rules.maxOfflineHours * 3600 * 1000;
      if (!Number.isFinite(t)) throw bad('BAD_TIME', 'Bad offline time');
      if (t < now - maxAge) throw bad('OFFLINE_TOO_OLD', 'This saved punch is too old. Please send a "forgot" request instead.');
      ts = Math.min(t, now);
      offline = now - ts > 2 * MIN ? 1 : 0;
    }
    const last = this.db.get('SELECT * FROM punches WHERE emp = ? AND voided = 0 ORDER BY ts DESC LIMIT 1', emp.id);
    const open = last && last.type === 'in' && Math.max(ts, last.ts) - last.ts < OPEN_MAX_MS ? last : null;
    if (type === 'in' && open) throw bad('ALREADY_IN', 'Already checked in');
    if (type === 'out' && !open) throw bad('NOT_IN', 'Not checked in');
    if (last && ts <= last.ts) {
      if (offline || now - last.ts < 5000) ts = last.ts + 1000;
      else throw bad('OUT_OF_ORDER', 'Time is before the last punch');
    }
    if (type === 'in' && !byAdmin) {
      const opens = this.checkInOpensTs(emp, this.dayForIn(emp, ts));
      if (opens && ts < opens) {
        const l = local(opens, this.settings.tzOffsetMin);
        const at = `${String(Math.floor(l.min / 60)).padStart(2, '0')}:${String(l.min % 60).padStart(2, '0')}`;
        throw bad('TOO_EARLY', `Check-in opens at ${at}`, { opensAt: at, opensTs: opens });
      }
    }
    let recheck = null;
    if (type === 'in' && !byAdmin) {
      const inDay = this.dayForIn(emp, ts);
      const lastOut = this.db.get("SELECT * FROM punches WHERE emp = ? AND day = ? AND type = 'out' AND voided = 0 ORDER BY ts DESC LIMIT 1", emp.id, inDay);
      if (lastOut) {
        recheck = this.approvedRecheckin(emp.id, inDay, lastOut.ts);
        if (!recheck) throw bad('RECHECKIN_NEEDED', 'You already checked out today. Send a "Check in again" request first.');
      }
    }
    const g = skipGeo ? { lat: loc?.lat ?? null, lng: loc?.lng ?? null, acc: loc?.acc ?? null, dist: null } : this.geo(emp, type, loc, { kiosk });
    const day = type === 'in' ? this.dayForIn(emp, ts) : open.day;
    const id = uid();
    this.db.run(
      `INSERT INTO punches (id, emp, day, type, ts, client_id, offline, source, lat, lng, acc, dist, by_admin, reason, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, emp.id, day, type, ts, clientId || null, offline, source, g.lat, g.lng, g.acc, g.dist, byAdmin || null, reason || null, now,
    );
    if (type === 'out') {
      const b = this.openBreak(emp.id);
      if (b) this.db.run('UPDATE breaks SET end = ? WHERE id = ?', ts, b.id);
    }
    if (recheck) {
      const data = JSON.parse(recheck.data);
      data.used = true;
      data.inTs = ts;
      this.db.run('UPDATE requests SET data = ? WHERE id = ?', JSON.stringify(data), recheck.id);
    }
    return { punch: this.db.get('SELECT * FROM punches WHERE id = ?', id) };
  }

  /** An approved, unused "Check in again" request for this day's latest check-out. */
  approvedRecheckin(empId, day, outTs) {
    return this.db.get(
      `SELECT * FROM requests WHERE emp = ? AND type = 'recheckin' AND status = 'approved'
       AND json_extract(data, '$.date') = ? AND json_extract(data, '$.outTs') = ? AND json_extract(data, '$.used') IS NULL
       ORDER BY decided DESC LIMIT 1`, empId, day, outTs);
  }
  /** Where the staff member stands on checking in again today (after a check-out). */
  recheckinState(emp) {
    if (this.openSession(emp.id)) return null;
    const day = this.dayForIn(emp, this.now());
    const lastOut = this.db.get("SELECT * FROM punches WHERE emp = ? AND day = ? AND type = 'out' AND voided = 0 ORDER BY ts DESC LIMIT 1", emp.id, day);
    if (!lastOut) return null;
    const r = this.db.get(
      `SELECT * FROM requests WHERE emp = ? AND type = 'recheckin' AND json_extract(data, '$.date') = ? AND json_extract(data, '$.outTs') = ?
       ORDER BY created DESC LIMIT 1`, emp.id, day, lastOut.ts);
    const d = r ? JSON.parse(r.data) : null;
    return { needed: true, outTs: lastOut.ts, status: r ? (r.status === 'approved' && d.used ? 'used' : r.status) : null, note: r?.note || null, requestId: r?.id || null };
  }

  /** Set the first check-in or last check-out of a past/current day (forgot / correction). */
  setDayTime(emp, date, type, ts, meta) {
    this.assertMonthOpen(date);
    const ps = this.db.all('SELECT * FROM punches WHERE emp = ? AND day = ? AND voided = 0 ORDER BY ts', emp.id, date);
    const ins = ps.filter((p) => p.type === 'in');
    const outs = ps.filter((p) => p.type === 'out');
    if (type === 'in') {
      if (outs.length && ts >= outs[0].ts) throw bad('BAD_TIME', 'Check-in must be before check-out');
      if (ins.length) this.db.run('UPDATE punches SET voided = 1 WHERE id = ?', ins[0].id);
    } else {
      const firstIn = ins[0];
      if (!firstIn) throw bad('NOT_IN', 'There is no check-in on that day');
      const lastIn = ins[ins.length - 1];
      if (ts <= lastIn.ts) throw bad('BAD_TIME', 'Check-out must be after check-in');
      const lastOut = outs[outs.length - 1];
      if (lastOut && lastOut.ts > lastIn.ts) this.db.run('UPDATE punches SET voided = 1 WHERE id = ?', lastOut.id);
      if (ts > this.now() + MIN) throw bad('BAD_TIME', 'Time is in the future');
    }
    if (ts > this.now() + MIN) throw bad('BAD_TIME', 'Time is in the future');
    const id = uid();
    this.db.run(
      `INSERT INTO punches (id, emp, day, type, ts, offline, source, by_admin, reason, created) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      id, emp.id, date, type, ts, meta.source, meta.byAdmin || null, meta.reason || null, this.now(),
    );
    if (type === 'out') {
      const b = this.db.get('SELECT * FROM breaks WHERE emp = ? AND day = ? AND end IS NULL', emp.id, date);
      if (b) this.db.run('UPDATE breaks SET end = ? WHERE id = ?', Math.max(b.start, ts), b.id);
    }
    // a time-based record clears an "absent" mark
    this.db.run("DELETE FROM day_marks WHERE emp = ? AND day = ? AND status = 'absent'", emp.id, date);
    return id;
  }

  startBreak(emp, minutes, requestId, allowedOverride) {
    const open = this.openSession(emp.id);
    if (!open) throw bad('NOT_IN', 'Not checked in');
    if (this.openBreak(emp.id)) throw bad('ON_BREAK', 'Already on a break');
    const used = this.db.all('SELECT start, end FROM breaks WHERE emp = ? AND day = ?', emp.id, open.day)
      .reduce((a, b) => a + Math.floor(((b.end ?? this.now()) - b.start) / MIN), 0);
    const remaining = Math.max(0, empRules(emp, this.settings).breakAllowanceMin - used);
    const allowed = allowedOverride != null ? clampInt(allowedOverride, 0, 480, minutes) : Math.min(minutes, remaining);
    const id = uid();
    this.db.run('INSERT INTO breaks (id, emp, day, start, end, allowed, request_id) VALUES (?, ?, ?, ?, NULL, ?, ?)', id, emp.id, open.day, this.now(), allowed, requestId || null);
    return { id, start: this.now(), allowed, requested: minutes, remainingBefore: remaining };
  }
  endBreak(emp) {
    const b = this.openBreak(emp.id);
    if (!b) throw bad('NOT_ON_BREAK', 'Not on a break');
    this.db.run('UPDATE breaks SET end = ? WHERE id = ?', this.now(), b.id);
    const dur = Math.floor((this.now() - b.start) / MIN);
    return { minutes: dur, lateMin: Math.max(0, dur - b.allowed) };
  }

  // ---------------------------------------------------------------- admin: attendance
  changes({ actor }) {
    const p = this.db.get("SELECT COUNT(*) AS n, MAX(created) AS latest FROM requests WHERE status = 'pending'");
    return { ver: this.db.kvGet('ver', 0), pending: p.n, latestPending: p.latest || 0, serverTime: this.now(),
      ownerPending: this.isOwner(actor) ? this.pendingApprovals() : 0 };
  }

  board({ actor, q }) {
    const date = q.get('date') && isDate(q.get('date')) ? q.get('date') : this.today();
    const emps = this.inBranch(actor, q, this.employees({ activeOnly: true }));
    const get = this.loadDays(null, date, date);
    const s = this.settings;
    const counts = { total: emps.length, in: 0, late: 0, break: 0, out: 0, absent: 0, leave: 0, notyet: 0, off: 0, duty: 0 };
    const pendingByEmp = {};
    for (const r of this.db.all("SELECT emp, COUNT(*) AS n FROM requests WHERE status = 'pending' GROUP BY emp")) pendingByEmp[r.emp] = r.n;
    const rows = emps.map((e) => {
      const d = daySummary(e, s, date, get(e.id, date), this.now());
      let live;
      if (d.onBreak) live = 'break';
      else if (d.isOpen) live = 'in';
      else if (d.checkOut) live = 'out';
      else if (['leave', 'leave_unpaid'].includes(d.status)) live = 'leave';
      else if (['off', 'holiday'].includes(d.status)) live = 'off';
      else if (d.status === 'duty') live = 'duty';
      else if (d.status === 'notyet' || d.status === 'future') live = 'notyet';
      else live = 'absent';
      counts[live] = (counts[live] || 0) + 1;
      if (d.lateMin > 0) counts.late++;
      const role = empRole(e, s);
      return {
        id: e.id, code: e.code, name: e.name, nameUr: e.nameUr, roleId: e.roleId, role: role?.name, shiftId: d.shiftId,
        fieldStaff: e.fieldStaff, hasPhoto: e.hasPhoto, photoVer: e.photoVer, live, pending: pendingByEmp[e.id] || 0, branchId: e.branchId || '',
        ...pickDay(d),
      };
    });
    return { date, serverTime: this.now(), counts, pending: this.db.get("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'").n, rows,
      celebrations: date === this.today() ? this.celebrations(emps, date) : [] };
  }

  async adminPunch({ actor, body }) {
    const emp = this.empRow(str(body.employeeId, 40));
    const reason = str(body.reason, 200);
    if (!reason) throw bad('NEED_REASON', 'Please write a reason');
    const type = body.type;
    let result;
    if (body.time) {
      const date = isDate(body.date) ? body.date : this.today();
      const t = hm(body.time);
      const sm = shiftMins(empShift(emp, this.settings));
      // times "before" the shift start on a midnight-crossing shift belong to the next calendar day
      const mins = sm.end > 1440 && t < sm.start - 120 ? t + 1440 : t;
      const ts = toTs(date, mins, this.off);
      result = { punchId: this.setDayTime(emp, date, type, ts, { source: 'admin', byAdmin: actor.id, reason }) };
    } else {
      result = this.punch(emp, { type, source: 'admin', loc: body.loc, byAdmin: actor.id, reason, skipGeo: true });
    }
    this.audit(actor, type === 'in' ? 'attendance.check_in' : 'attendance.check_out', emp.id, { name: emp.name, date: body.date, time: body.time, reason });
    return { ok: true, ...result };
  }
  voidPunch({ actor, params, body }) {
    const p = this.db.get('SELECT * FROM punches WHERE id = ?', params.id);
    if (!p) throw notFound('Punch');
    this.assertMonthOpen(p.day);
    const reason = str(body.reason, 200);
    if (!reason) throw bad('NEED_REASON', 'Please write a reason');
    this.db.run('UPDATE punches SET voided = 1 WHERE id = ?', p.id);
    const emp = this.empRow(p.emp, { withDeleted: true });
    this.audit(actor, 'attendance.punch_removed', p.emp, { name: emp.name, day: p.day, type: p.type, ts: p.ts, reason });
    return { ok: true };
  }
  punchPhoto({ params }) {
    const r = this.db.get('SELECT data FROM photos WHERE punch = ?', params.id);
    if (!r) return new Response(null, { status: 404 });
    return dataUrlResponse(r.data);
  }
  adminMark({ actor, body }) {
    const emp = this.empRow(str(body.employeeId, 40));
    const dates = isDate(body.toDate) && isDate(body.date) ? dateRange(body.date, body.toDate) : [body.date];
    if (!dates.every(isDate)) throw bad('BAD_DATE', 'Bad date');
    if (dates.length > 62) throw bad('BAD_DATE', 'Too many days');
    this.assertDatesOpen(dates);
    const status = body.status || null;
    if (status && !MARKS.includes(status)) throw bad('BAD_STATUS', `Status must be one of ${MARKS.join(', ')}`);
    for (const d of dates) {
      if (status) {
        this.db.run(`INSERT INTO day_marks (emp, day, status, note, by_admin, ts) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(emp, day) DO UPDATE SET status = excluded.status, note = excluded.note, by_admin = excluded.by_admin, ts = excluded.ts`,
        emp.id, d, status, str(body.note, 200), actor.id, this.now());
      } else this.db.run('DELETE FROM day_marks WHERE emp = ? AND day = ?', emp.id, d);
    }
    this.audit(actor, 'attendance.mark', emp.id, { name: emp.name, dates, status: status || 'cleared', note: str(body.note, 200) });
    return { ok: true };
  }
  adminEndBreak({ actor, body }) {
    const emp = this.empRow(str(body.employeeId, 40));
    const r = this.endBreak(emp);
    this.audit(actor, 'attendance.break_ended', emp.id, { name: emp.name, ...r });
    return r;
  }
  adminDay({ params }) {
    if (!isDate(params.date)) throw bad('BAD_DATE', 'Bad date');
    const emp = this.empRow(params.id, { withDeleted: true });
    const d = this.day(emp, params.date);
    const photos = new Set(this.db.all('SELECT punch FROM photos WHERE punch IN (SELECT id FROM punches WHERE emp = ? AND day = ?)', emp.id, params.date).map((r) => r.punch));
    d.punches = this.db.all('SELECT * FROM punches WHERE emp = ? AND day = ? ORDER BY ts', emp.id, params.date)
      .map((p) => ({ ...p, voided: !!p.voided, offline: !!p.offline, hasPhoto: photos.has(p.id) }));
    d.breaks = this.db.all('SELECT * FROM breaks WHERE emp = ? AND day = ? ORDER BY start', emp.id, params.date);
    d.requests = this.db.all("SELECT * FROM requests WHERE emp = ? AND json_extract(data, '$.date') = ?", emp.id, params.date).map(reqOut);
    return { day: d };
  }

  // ---------------------------------------------------------------- calendar / payroll
  calendar(emp, month) {
    const dates = monthDates(month);
    const get = this.loadDays([emp.id], dates[0], dates[dates.length - 1]);
    const reqs = this.db.all(
      `SELECT * FROM requests WHERE emp = ? AND (substr(json_extract(data, '$.date'), 1, 7) = ? OR substr(json_extract(data, '$.toDate'), 1, 7) = ?)`,
      emp.id, month, month,
    );
    const reqByDate = {};
    for (const r of reqs) {
      const d = JSON.parse(r.data);
      const ds = d.toDate ? dateRange(d.date, d.toDate) : [d.date];
      for (const x of ds) {
        const prev = reqByDate[x];
        // pending wins over approved, approved over declined
        const rank = { pending: 3, approved: 2, declined: 1, cancelled: 0 };
        if (!prev || rank[r.status] > rank[prev]) reqByDate[x] = r.status;
      }
    }
    const days = dates.map((date) => {
      const d = daySummary(emp, this.settings, date, get(emp.id, date), this.now());
      return { ...pickDay(d), request: reqByDate[date] || null };
    });
    return { month, days };
  }
  adminCalendar({ params, q }) {
    const month = isMonth(q.get('month')) ? q.get('month') : this.month();
    const emp = this.empRow(params.id, { withDeleted: true });
    return this.calendar(emp, month);
  }

  depositBalance(empId, uptoMonth) {
    const rows = this.db.all(`SELECT kind, SUM(amount) AS s FROM money WHERE emp = ? AND voided = 0 ${uptoMonth ? 'AND month <= ?' : ''} GROUP BY kind`, empId, ...(uptoMonth ? [uptoMonth] : []));
    const by = Object.fromEntries(rows.map((r) => [r.kind, r.s]));
    return (by.deposit || 0) + (by.deposit_cut || 0) - (by.deposit_return || 0);
  }
  statement(emp, month, preloaded, opts = {}) {
    const frozen = opts.live ? null : this.lockedStatement(emp.id, month);
    const st = frozen ? structuredClone(frozen) : this.liveStatement(emp, month, preloaded);
    const s = this.settings;
    st.payments = this.paymentsFor(emp.id, month).map((p) => ({ id: p.id, amount: p.amount, method: p.method, note: p.note, ts: p.ts }));
    st.paid = st.payments.reduce((a, p) => a + p.amount, 0);
    st.slipNo = `${emp.code}-${month.replace('-', '')}`;
    st.storeAddress = s.storeAddress || '';
    st.storePhone = s.storePhone || '';
    return st;
  }
  liveStatement(emp, month, preloaded) {
    const dates = monthDates(month);
    const get = preloaded || this.loadDays([emp.id], dates[0], dates[dates.length - 1]);
    const days = dates.map((d) => daySummary(emp, this.settings, d, get(emp.id, d), this.now()));
    const money = this.db.all('SELECT * FROM money WHERE emp = ? AND month = ? AND voided = 0 ORDER BY ts', emp.id, month);
    const st = payroll(emp, this.settings, month, days, money, this.depositBalance(emp.id, month), this.now());
    st.employee = { id: emp.id, code: emp.code, name: emp.name, nameUr: emp.nameUr, roleId: emp.roleId,
      role: empRole(emp, this.settings)?.name, shiftId: emp.shiftId, shift: empShift(emp, this.settings) };
    st.storeName = this.settings.storeName;
    st.currency = this.settings.currency;
    st.generatedAt = this.now();
    return st;
  }
  payrollOne({ params, q }) {
    const month = isMonth(q.get('month')) ? q.get('month') : this.month();
    return { statement: this.statement(this.empRow(params.id, { withDeleted: true }), month) };
  }
  payrollAll({ actor, q }) {
    const month = isMonth(q.get('month')) ? q.get('month') : this.month();
    const dates = monthDates(month);
    const get = this.loadDays(null, dates[0], dates[dates.length - 1]);
    const withDays = q.get('days') === '1';
    const rows = this.inBranch(actor, q, this.employees({ activeOnly: false }))
      .filter((e) => q.get('all') === '1' || e.active || (e.leaveDate && e.leaveDate >= `${month}-01`))
      .map((e) => {
      const st = this.statement(e, month, get);
      if (withDays) st.dayCodes = st.days.map((d) => d.status);
      delete st.days;
      st.employee.branchId = e.branchId || '';
      return st;
    });
    const totals = rows.reduce((a, r) => ({ salary: a.salary + r.salary, cuts: a.cuts + r.totalCuts, advances: a.advances + r.advances, net: a.net + r.net,
      paid: a.paid + r.paid, unpaid: a.unpaid + (r.net > 0 && r.paid < r.net ? 1 : 0) }),
    { salary: 0, cuts: 0, advances: 0, net: 0, paid: 0, unpaid: 0 });
    if (q.get('format') === 'csv') {
      return new Response(csv([
        ['Code', 'Name', 'Salary', 'Present', 'Late days', 'Late min', 'Absent', 'Leave paid', 'Leave unpaid', 'Total cuts', 'Advances', 'Deposit cut',
          'Fines', 'Bonus', 'Commission', 'Overtime pay', 'Holiday pay', 'Net pay', 'Paid', 'Deposit balance'],
        ...rows.map((r) => [r.employee.code, r.employee.name, r.salary, r.counts.present, r.counts.late, r.counts.lateMin, r.counts.absent,
          r.leave.paid, r.leave.unpaid, r.totalCuts, r.advances, r.depositCut, r.fines || 0, r.bonus, r.commission || 0, r.overtime?.pay || 0, r.holidayPay || 0,
          r.net, r.paid, r.depositBalance]),
      ]), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="payroll-${month}.csv"` } });
    }
    return { month, totals, rows, locked: this.locks()[month] ? { ts: this.locks()[month].ts, by: this.locks()[month].byName } : null };
  }

  // ---------------------------------------------------------------- money
  addMoney({ actor, body }) {
    const emp = this.empRow(str(body.employeeId, 40));
    const kind = body.kind;
    if (!MONEY_KINDS.includes(kind)) throw bad('BAD_KIND', `kind must be one of ${MONEY_KINDS.join(', ')}`);
    const amount = clampInt(body.amount, 1, 100_000_000, 0);
    if (!amount) throw bad('BAD_AMOUNT', 'Amount must be more than 0');
    const month = isMonth(body.month) ? body.month : this.month();
    if (kind === 'fine' && !str(body.note, 200)) throw bad('NEED_REASON', 'Write the reason for the fine');
    this.assertMonthOpen(month);
    const id = uid();
    // a manager's entry waits for the owner (voided = 2: not counted yet)
    const wait = !this.isOwner(actor);
    const n = kind === 'advance' ? clampInt(body.installments, 1, 12, 1) : 1;
    let ids = [id];
    if (n > 1) ids = this.insertAdvance(actor, emp, amount, month, str(body.note, 200) || 'Advance', n, wait ? 2 : 0);
    else {
      this.db.run('INSERT INTO money (id, emp, kind, amount, month, note, ts, by_admin, voided) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, emp.id, kind, amount, month, str(body.note, 200), this.now(), actor.id, wait ? 2 : 0);
    }
    this.audit(actor, `money.${kind}`, emp.id, { name: emp.name, amount, month, note: str(body.note, 200), installments: n, waitingForOwner: wait });
    if (wait) this.askOwner(actor, 'money_add', emp, { moneyId: ids[0], moneyIds: ids, kind, amount, month, installments: n, note: str(body.note, 200) });
    else this.pushMoney(emp, kind, amount, str(body.note, 200), ids[0]);
    return { id: ids[0], ids, pendingOwner: wait, depositBalance: this.depositBalance(emp.id) };
  }
  voidMoney({ actor, params }) {
    const m = this.db.get('SELECT * FROM money WHERE id = ?', params.id);
    if (!m) throw notFound('Entry');
    this.assertMonthOpen(m.month);
    if (m.voided === 0 && !this.isOwner(actor)) {
      if (this.db.get("SELECT id FROM approvals WHERE kind = 'money_void' AND status = 'pending' AND json_extract(data, '$.moneyId') = ?", m.id)) {
        throw bad('ALREADY_ASKED', 'Already waiting for the owner');
      }
      this.askOwner(actor, 'money_void', this.empRow(m.emp, { withDeleted: true }), { moneyId: m.id, kind: m.kind, amount: m.amount, month: m.month });
      return { ok: true, pendingOwner: true };
    }
    if (m.voided === 2) this.db.run("UPDATE approvals SET status = 'cancelled', decided = ? WHERE status = 'pending' AND json_extract(data, '$.moneyId') = ?", this.now(), m.id);
    this.db.run('UPDATE money SET voided = 1 WHERE id = ?', m.id);
    this.audit(actor, 'money.removed', m.emp, { kind: m.kind, amount: m.amount, month: m.month });
    return { ok: true };
  }
  listMoney({ params }) {
    const emp = this.empRow(params.id, { withDeleted: true });
    return {
      entries: this.db.all('SELECT * FROM money WHERE emp = ? ORDER BY ts DESC LIMIT 500', emp.id).map((m) => ({
        ...m, voided: m.voided === 1, pendingOwner: m.voided === 2,
        removalPending: m.voided === 0 && !!this.db.get("SELECT id FROM approvals WHERE kind = 'money_void' AND status = 'pending' AND json_extract(data, '$.moneyId') = ?", m.id),
      })),
      depositBalance: this.depositBalance(emp.id),
    };
  }

  // ---------------------------------------------------------------- requests
  validateRequest(emp, body) {
    const type = body.type;
    if (!REQUEST_TYPES.includes(type)) throw bad('BAD_TYPE', 'Unknown request type');
    const today = this.today();
    const r = this.settings.rules;
    const data = { reason: str(body.reason, 300) };
    const pastOk = (date, allowToday = true) => {
      if (!isDate(date)) throw bad('BAD_DATE', 'Pick a date');
      if (date > today || (!allowToday && date === today)) throw bad('BAD_DATE', 'Date cannot be in the future');
      if (date.slice(0, 7) !== today.slice(0, 7)) throw bad('NOT_THIS_MONTH', 'Only dates in the current month are allowed');
      if (date < addDays(today, -r.pastDayRequestDays)) throw bad('TOO_OLD', `Only the last ${r.pastDayRequestDays} days are allowed`);
    };
    switch (type) {
      case 'forgot_in':
      case 'forgot_out':
        data.date = body.date || today;
        pastOk(data.date);
        data.time = fmtHM(hm(body.time));
        break;
      case 'past_day':
        data.date = body.date;
        pastOk(data.date, false);
        data.inTime = fmtHM(hm(body.inTime));
        data.outTime = fmtHM(hm(body.outTime));
        break;
      case 'leave':
        if (!isDate(body.date)) throw bad('BAD_DATE', 'Pick a start date');
        data.date = body.date;
        data.toDate = isDate(body.toDate) ? body.toDate : body.date;
        if (data.toDate < data.date) throw bad('BAD_DATE', 'End date is before start date');
        if (dateRange(data.date, data.toDate).length > 31) throw bad('BAD_DATE', 'Leave can be at most 31 days');
        if (data.date < addDays(today, -r.pastDayRequestDays)) throw bad('TOO_OLD', `Only the last ${r.pastDayRequestDays} days are allowed`);
        break;
      case 'advance':
        data.amount = clampInt(body.amount, 1, 10_000_000, 0);
        if (!data.amount) throw bad('BAD_AMOUNT', 'Enter an amount');
        data.date = today;
        break;
      case 'break': {
        data.minutes = clampInt(body.minutes, 1, 240, 0);
        if (!data.minutes) throw bad('BAD_MINUTES', 'Enter break minutes');
        if (!this.openSession(emp.id)) throw bad('NOT_IN', 'Check in first');
        if (this.openBreak(emp.id)) throw bad('ON_BREAK', 'Already on a break');
        data.date = this.openSession(emp.id).day;
        break;
      }
      case 'undo_checkout': {
        const last = this.db.get('SELECT * FROM punches WHERE emp = ? AND voided = 0 ORDER BY ts DESC LIMIT 1', emp.id);
        if (!last || last.type !== 'out' || this.now() - last.ts > 12 * 3600 * 1000) throw bad('NOTHING_TO_UNDO', 'There is no recent check-out to undo');
        data.punchId = last.id;
        data.date = last.day;
        data.outTs = last.ts;
        break;
      }
      case 'recheckin': {
        if (this.openSession(emp.id)) throw bad('ALREADY_IN', 'You are already checked in');
        const day = this.dayForIn(emp, this.now());
        const last = this.db.get("SELECT * FROM punches WHERE emp = ? AND day = ? AND type = 'out' AND voided = 0 ORDER BY ts DESC LIMIT 1", emp.id, day);
        if (!last) throw bad('NOT_CHECKED_OUT', 'You have not checked out today, so you can check in normally');
        if (this.approvedRecheckin(emp.id, day, last.ts)) throw bad('ALREADY_APPROVED', 'Already approved. You can check in now.');
        // same location rule as a check-in: must be at the store unless this person may check in from anywhere
        const g = this.geo(emp, 'in', body.loc);
        data.dist = g.dist;
        data.lat = g.lat;
        data.lng = g.lng;
        data.acc = g.acc;
        data.date = day;
        data.outTs = last.ts;
        break;
      }
      case 'swap':
        Object.assign(data, this.validateSwap(emp, body));
        break;
      case 'field_duty':
        if (!isDate(body.date)) throw bad('BAD_DATE', 'Pick a date');
        data.date = body.date;
        data.toDate = isDate(body.toDate) && body.toDate >= body.date ? body.toDate : body.date;
        if (dateRange(data.date, data.toDate).length > 31) throw bad('BAD_DATE', 'At most 31 days');
        if (data.date < addDays(today, -r.pastDayRequestDays)) throw bad('TOO_OLD', `Only the last ${r.pastDayRequestDays} days are allowed`);
        break;
      default:
        break;
    }
    const dupe = this.db.get("SELECT id FROM requests WHERE emp = ? AND type = ? AND status = 'pending' AND json_extract(data, '$.date') IS ?", emp.id, type, data.date ?? null);
    if (dupe) throw bad('DUPLICATE', 'You already have this request waiting');
    return { type, data };
  }

  createRequest(emp, body, source) {
    const { type, data } = this.validateRequest(emp, body);
    if (type === 'break' && !this.settings.rules.breakNeedsApproval) {
      const br = this.startBreak(emp, data.minutes, null);
      return { started: true, break: br };
    }
    const id = uid();
    data.source = source;
    this.db.run("INSERT INTO requests (id, emp, type, data, status, created) VALUES (?, ?, ?, ?, 'pending', ?)", id, emp.id, type, JSON.stringify(data), this.now());
    this.pushNewRequest({ id, emp: emp.id, type });
    return { request: reqOut(this.db.get('SELECT * FROM requests WHERE id = ?', id)) };
  }

  listRequests({ actor, q }) {
    const status = q.get('status') || 'pending';
    const emp = q.get('employeeId');
    const limit = clampInt(q.get('limit'), 1, 500, 100);
    const where = [];
    const args = [];
    if (status !== 'all') { where.push('status = ?'); args.push(status); }
    if (emp) { where.push('emp = ?'); args.push(emp); }
    let rows = this.db.all(`SELECT * FROM requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created DESC LIMIT ?`, ...args, limit);
    if (actor.branchId) {
      const mine = new Set(this.inBranch(actor, q, this.employees()).map((e) => e.id));
      rows = rows.filter((r) => mine.has(r.emp));
    }
    const names = {};
    for (const e of this.db.all('SELECT id, code, data FROM employees')) names[e.id] = { code: e.code, name: JSON.parse(e.data).name, nameUr: JSON.parse(e.data).nameUr };
    const showMoney = this.can(actor, 'payroll.view') || this.can(actor, 'money.edit');
    return {
      requests: rows.map((r) => {
        const o = { ...reqOut(r), employee: names[r.emp] || null };
        if (!showMoney && r.type === 'advance') o.data.amount = null;
        return o;
      }),
    };
  }

  // ---------------------------------------------------------------- instant push (Firebase)
  pushToken({ actor, body }, kind) {
    const token = str(body.token, 400);
    if (!token || token.length < 20) throw bad('BAD_TOKEN', 'Push token missing');
    if (body.remove) { this.db.run('DELETE FROM push_tokens WHERE token = ?', token); return { ok: true }; }
    this.db.run(`INSERT INTO push_tokens (token, kind, sub, lang, updated) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET kind = excluded.kind, sub = excluded.sub, lang = excluded.lang, updated = excluded.updated`,
    token, kind, actor.id, body.lang === 'ur' ? 'ur' : 'en', this.now());
    return { ok: true, push: !!this.env.FIREBASE_SERVICE_ACCOUNT };
  }

  /** Sends a test alert to the caller's own phone(s) right now and says what happened. */
  async pushTest({ actor, body }, kind) {
    const configured = !!this.env.FIREBASE_SERVICE_ACCOUNT;
    const tk = str(body.token, 400);
    if (tk && tk.length >= 20) this.pushToken({ actor, body: { token: tk, lang: body.lang } }, kind);
    const rows = this.db.all('SELECT token, lang FROM push_tokens WHERE kind = ? AND sub = ?', kind, actor.id);
    if (!configured || !rows.length) return { configured, phones: rows.length, results: [] };
    const report = [];
    const msgs = rows.map((r) => ({
      token: r.token, id: `test-${this.now()}`,
      title: r.lang === 'ur' ? 'ٹیسٹ اطلاع' : 'Test alert',
      body: r.lang === 'ur' ? 'اطلاعات ٹھیک کام کر رہی ہیں۔' : 'Alerts are working on this phone.',
    }));
    let dead = [];
    try { dead = await this.pushSender(msgs, report); } catch (e) { report.push({ status: 0, error: String(e?.message || e).slice(0, 200) }); }
    for (const d of dead || []) this.db.run('DELETE FROM push_tokens WHERE token = ?', d);
    return { configured, phones: rows.length, results: report };
  }

  /** Queue an alert for some phones; text is made per phone language. */
  queuePush(kind, subs, id, make) {
    if (!subs.length) return;
    const rows = this.db.all(`SELECT token, lang FROM push_tokens WHERE kind = ? AND sub IN (${subs.map(() => '?').join(',')})`, kind, ...subs);
    for (const r of rows) this.outbox.push({ token: r.token, id, ...make(r.lang === 'ur') });
  }

  async flushPush() {
    const msgs = this.outbox;
    this.outbox = [];
    try {
      const dead = await this.pushSender(msgs);
      for (const tk of dead || []) this.db.run('DELETE FROM push_tokens WHERE token = ?', tk);
    } catch (e) {
      console.warn('push failed', e?.message);
    }
  }

  pushNewRequest(r) {
    const e = this.db.get('SELECT data FROM employees WHERE id = ?', r.emp);
    const d = e ? JSON.parse(e.data) : {};
    const admins = this.db.all('SELECT id, role, perms FROM admins WHERE active = 1')
      .filter((a) => a.role === 'owner' || JSON.parse(a.perms || '[]').includes('requests.decide')).map((a) => a.id);
    this.queuePush('admin', admins, r.id, (ur) => ({
      title: ur ? `نئی درخواست: ${REQ_UR[r.type] || r.type}` : `New request: ${REQ_EN[r.type] || r.type}`,
      body: ur ? `${d.nameUr || d.name || '?'} نے درخواست بھیجی ہے۔` : `${d.name || '?'} sent a request. Tap to review.`,
    }));
  }

  pushDecided(r, approved, note) {
    this.queuePush('emp', [r.emp], `${r.id}-d`, (ur) => ({
      title: ur ? (approved ? 'درخواست منظور ہو گئی' : 'درخواست نامنظور') : (approved ? 'Request approved' : 'Request refused'),
      body: `${ur ? REQ_UR[r.type] || r.type : REQ_EN[r.type] || r.type}${note ? ` · ${note}` : ''}`,
    }));
  }

  // ---------------------------------------------------------------- phone notifications (background check)
  // The app's background worker asks "anything new since <since>?" every 15 minutes.
  // First call (no since): nothing is returned, only the cursor, so old items are not shown.
  adminNotify({ actor, q }) {
    const now = this.now();
    const since = Number(q.get('since') || 0);
    if (!since || !this.can(actor, 'requests.decide')) return { since: now, items: [] };
    const ur = q.get('lang') === 'ur';
    const rows = this.db.all("SELECT * FROM requests WHERE status = 'pending' AND created > ? ORDER BY created LIMIT 20", since);
    const items = rows.map((r) => {
      const e = this.db.get('SELECT data FROM employees WHERE id = ?', r.emp);
      const d = e ? JSON.parse(e.data) : {};
      const name = (ur && d.nameUr) || d.name || '?';
      return {
        id: r.id,
        title: ur ? `نئی درخواست: ${REQ_UR[r.type] || r.type}` : `New request: ${REQ_EN[r.type] || r.type}`,
        body: ur ? `${name} نے درخواست بھیجی ہے۔ دیکھنے کے لیے کھولیں۔` : `${name} sent a request. Tap to review.`,
      };
    });
    const pending = this.db.get("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'").n;
    return { since: rows.length ? rows[rows.length - 1].created : since, items, pending };
  }

  empNotify({ actor, q }) {
    const now = this.now();
    const since = Number(q.get('since') || 0);
    if (!since) return { since: now, items: [] };
    const ur = q.get('lang') === 'ur';
    const rows = this.db.all("SELECT * FROM requests WHERE emp = ? AND status != 'pending' AND decided > ? ORDER BY decided LIMIT 20", actor.id, since);
    const items = rows.map((r) => {
      const ok = r.status === 'approved';
      const what = ur ? REQ_UR[r.type] || r.type : REQ_EN[r.type] || r.type;
      return {
        id: `${r.id}-d`,
        title: ur ? (ok ? 'درخواست منظور ہو گئی' : 'درخواست نامنظور') : (ok ? 'Request approved' : 'Request refused'),
        body: `${what}${r.note ? ` · ${r.note}` : ''}`,
      };
    });
    return { since: rows.length ? rows[rows.length - 1].decided : since, items };
  }

  async decide({ actor, params, body }) {
    const r = this.db.get('SELECT * FROM requests WHERE id = ?', params.id);
    if (!r) throw notFound('Request');
    if (r.status !== 'pending') throw bad('ALREADY_DECIDED', 'This request was already decided');
    if (r.type === 'advance' && body.approve && !this.can(actor, 'money.edit')) throw forbidden('NO_PERMISSION', 'You need the "money.edit" permission');
    const emp = this.empRow(r.emp, { withDeleted: true });
    const data = JSON.parse(r.data);
    const note = str(body.note, 300);
    const result = {};
    if (body.approve) {
      if (data.date && isDate(data.date)) this.assertDatesOpen(data.toDate ? dateRange(data.date, data.toDate) : [data.date]);
      const meta = { source: 'request', byAdmin: actor.id, reason: `Request ${r.type}${note ? `: ${note}` : ''}` };
      const sm = shiftMins(data.date && isDate(data.date) ? this.shiftOn(emp, data.date) : empShift(emp, this.settings));
      const at = (date, t) => {
        const m = hm(t);
        return toTs(date, sm.end > 1440 && m < sm.start - 120 ? m + 1440 : m, this.off);
      };
      switch (r.type) {
        case 'forgot_in':
        case 'forgot_out': {
          const time = body.time || data.time;
          if (r.type === 'forgot_in') {
            this.setDayTime(emp, data.date, 'in', at(data.date, time), meta);
          } else {
            this.setDayTime(emp, data.date, 'out', at(data.date, time), meta);
          }
          data.approvedTime = fmtHM(hm(time));
          break;
        }
        case 'past_day': {
          const inT = body.inTime || data.inTime;
          const outT = body.outTime || data.outTime;
          const inTs = at(data.date, inT);
          const outTs = at(data.date, outT);
          if (outTs <= inTs) throw bad('BAD_TIME', 'Check-out must be after check-in');
          this.db.run('UPDATE punches SET voided = 1 WHERE emp = ? AND day = ?', emp.id, data.date);
          this.setDayTime(emp, data.date, 'in', inTs, meta);
          this.setDayTime(emp, data.date, 'out', outTs, meta);
          data.approvedIn = fmtHM(hm(inT));
          data.approvedOut = fmtHM(hm(outT));
          break;
        }
        case 'leave': {
          const status = body.paid === false ? 'leave_unpaid' : 'leave';
          for (const d of dateRange(data.date, data.toDate)) {
            this.db.run(`INSERT INTO day_marks (emp, day, status, note, by_admin, ts) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(emp, day) DO UPDATE SET status = excluded.status, note = excluded.note, by_admin = excluded.by_admin, ts = excluded.ts`,
            emp.id, d, status, data.reason || 'Leave', actor.id, this.now());
          }
          data.approvedAs = status;
          break;
        }
        case 'field_duty':
          for (const d of dateRange(data.date, data.toDate)) {
            this.db.run(`INSERT INTO day_marks (emp, day, status, note, by_admin, ts) VALUES (?, ?, 'duty', ?, ?, ?)
              ON CONFLICT(emp, day) DO UPDATE SET status = 'duty', note = excluded.note, by_admin = excluded.by_admin, ts = excluded.ts`,
            emp.id, d, data.reason || 'Out-of-town duty', actor.id, this.now());
          }
          break;
        case 'advance': {
          const amount = clampInt(body.amount ?? data.amount, 1, 10_000_000, data.amount);
          const wait = !this.isOwner(actor);
          const n = clampInt(body.installments, 1, 12, 1);
          const ids = this.insertAdvance(actor, emp, amount, this.month(), data.reason || 'Advance', n, wait ? 2 : 0);
          data.installments = n;
          if (wait) {
            this.askOwner(actor, 'money_add', emp, { moneyId: ids[0], moneyIds: ids, kind: 'advance', amount, month: this.month(), installments: n, note: data.reason || 'Advance' });
            data.waitingForOwner = true;
          }
          data.approvedAmount = amount;
          break;
        }
        case 'break':
          result.break = this.startBreak(emp, data.minutes, r.id, body.allowedMin);
          break;
        case 'swap':
          this.applySwap(actor, emp, data);
          break;
        case 'recheckin': {
          // The employee asked from inside the store, so work time starts again from the moment they asked.
          const last = this.db.get('SELECT * FROM punches WHERE emp = ? AND voided = 0 ORDER BY ts DESC LIMIT 1', emp.id);
          if (last && last.type === 'in' && last.ts > data.outTs) { data.used = true; data.inTs = last.ts; break; } // already back in
          if (!last || last.type !== 'out' || last.ts !== data.outTs) throw bad('RECHECKIN_STALE', 'The check-out this request is about has changed');
          const ts = Math.max(r.created, data.outTs + 1000);
          const id = uid();
          this.db.run(
            `INSERT INTO punches (id, emp, day, type, ts, client_id, offline, source, lat, lng, acc, dist, by_admin, reason, created)
             VALUES (?, ?, ?, 'in', ?, NULL, 0, 'request', ?, ?, ?, ?, ?, ?, ?)`,
            id, emp.id, data.date, ts, data.lat ?? null, data.lng ?? null, data.acc ?? null, data.dist ?? null, actor.id,
            `Check in again (asked ${new Date(ts).toISOString()})${note ? `: ${note}` : ''}`, this.now(),
          );
          data.used = true;
          data.inTs = ts;
          result.checkedIn = ts;
          break;
        }
        case 'pin_reset':
          if (!this.can(actor, 'employees.edit')) throw forbidden('NO_PERMISSION', 'You need the "employees.edit" permission');
          await this.applyPinReset(actor, emp, body, data, result);
          break;
        case 'undo_checkout': {
          const p = this.db.get('SELECT * FROM punches WHERE id = ?', data.punchId);
          const later = this.db.get('SELECT id FROM punches WHERE emp = ? AND voided = 0 AND ts > ?', emp.id, p.ts);
          if (later) throw bad('CANNOT_UNDO', 'Employee has punched again since then');
          this.db.run('UPDATE punches SET voided = 1 WHERE id = ?', p.id);
          break;
        }
        default:
          break;
      }
    }
    const status = body.approve ? 'approved' : 'declined';
    this.db.run('UPDATE requests SET status = ?, note = ?, decided = ?, decided_by = ?, data = ? WHERE id = ?', status, note, this.now(), actor.id, JSON.stringify(data), r.id);
    this.audit(actor, `request.${status}`, emp.id, { name: emp.name, type: r.type, data, note });
    this.pushDecided(r, status === 'approved', note);
    return { request: reqOut(this.db.get('SELECT * FROM requests WHERE id = ?', r.id)), ...result };
  }

  // ---------------------------------------------------------------- reports / audit
  reports({ q }) {
    const today = this.today();
    const type = q.get('type') || 'daily';
    let from = q.get('from');
    let to = q.get('to');
    if (type === 'daily') { from = isDate(from) ? from : today; to = from; }
    else if (type === 'weekly' && !isDate(from)) { from = addDays(today, -6); to = today; }
    else if (type === 'monthly' && !isDate(from)) { from = `${today.slice(0, 7)}-01`; to = today; }
    if (!isDate(from)) from = addDays(today, -6);
    if (!isDate(to)) to = today;
    if (to < from) [from, to] = [to, from];
    const dates = dateRange(from, to);
    if (dates.length > 62) throw bad('RANGE', 'Pick at most 62 days');
    const emps = this.employees({ activeOnly: q.get('all') !== '1' });
    const get = this.loadDays(null, from, to);
    const s = this.settings;
    const rows = [];
    const summary = [];
    for (const e of emps) {
      const sum = { id: e.id, code: e.code, name: e.name, present: 0, late: 0, lateMin: 0, earlyMin: 0, absent: 0, leave: 0, off: 0, duty: 0, workedMin: 0, missingOut: 0 };
      for (const d of dates) {
        const x = daySummary(e, s, d, get(e.id, d), this.now());
        if (['future', 'notjoined'].includes(x.status)) continue;
        rows.push({ date: d, id: e.id, code: e.code, name: e.name, status: x.status, checkIn: x.checkIn, checkOut: x.checkOut, workedMin: x.workedMin,
          lateMin: x.lateMin, earlyMin: x.earlyMin, breakMin: x.breakMin, missingOut: x.missingOut, offline: x.offline });
        if (x.status === 'present' || x.status === 'late') sum.present++;
        if (x.lateMin > 0) sum.late++;
        if (x.status === 'absent') sum.absent++;
        if (x.status === 'leave' || x.status === 'leave_unpaid') sum.leave++;
        if (x.status === 'off' || x.status === 'holiday') sum.off++;
        if (x.status === 'duty') sum.duty++;
        if (x.missingOut) sum.missingOut++;
        sum.lateMin += x.lateMin; sum.earlyMin += x.earlyMin; sum.workedMin += x.workedMin;
      }
      summary.push(sum);
    }
    const list = q.get('list'); // 'late' | 'absent' | undefined
    const filtered = list === 'late' ? rows.filter((r) => r.lateMin > 0) : list === 'absent' ? rows.filter((r) => r.status === 'absent') : rows;
    if (q.get('format') === 'csv') {
      const t = (ts) => (ts ? fmtHM(local(ts, this.off).min) : '');
      const body = q.get('view') === 'summary'
        ? csv([['Code', 'Name', 'Present', 'Late days', 'Late minutes', 'Early minutes', 'Absent', 'Leave', 'Off', 'Duty', 'Hours worked', 'Missing check-out'],
          ...summary.map((x) => [x.code, x.name, x.present, x.late, x.lateMin, x.earlyMin, x.absent, x.leave, x.off, x.duty, (x.workedMin / 60).toFixed(1), x.missingOut])])
        : csv([['Date', 'Code', 'Name', 'Status', 'Check in', 'Check out', 'Hours', 'Late min', 'Early min', 'Break min', 'Note'],
          ...filtered.map((x) => [x.date, x.code, x.name, x.status, t(x.checkIn), t(x.checkOut), (x.workedMin / 60).toFixed(1), x.lateMin, x.earlyMin, x.breakMin,
            [x.missingOut ? 'no check-out' : '', x.offline ? 'offline punch' : ''].filter(Boolean).join('; ')])]);
      return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="attendance-${list || type}-${from}_${to}.csv"` } });
    }
    return { type, from, to, rows: filtered, summary };
  }

  auditLog({ q }) {
    const before = Number(q.get('before')) || Number.MAX_SAFE_INTEGER;
    const limit = clampInt(q.get('limit'), 1, 500, 100);
    const target = q.get('target');
    const rows = target
      ? this.db.all('SELECT * FROM audit WHERE id < ? AND target = ? ORDER BY id DESC LIMIT ?', before, target, limit)
      : this.db.all('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?', before, limit);
    return { entries: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) };
  }

  // ---------------------------------------------------------------- kiosk
  async addKiosk({ actor, body }) {
    const deviceId = str(body.deviceId, 80);
    if (!deviceId) throw bad('NO_DEVICE', 'Device id missing');
    const kiosks = this.db.kvGet('kiosks', []).filter((k) => k.deviceId !== deviceId);
    const k = { id: uid(), name: str(body.name, 40) || 'Store kiosk', deviceId, created: this.now(), by: actor.name };
    kiosks.push(k);
    this.db.kvSet('kiosks', kiosks);
    const token = await this.issueToken('kiosk', k.id, deviceId, KIOSK_TTL);
    this.audit(actor, 'kiosk.added', k.id, { name: k.name });
    return { kiosk: k, token };
  }
  async kioskLogin() {
    throw forbidden('USE_ADMIN', 'Turn on kiosk mode from the admin app');
  }
  removeKiosk({ actor, params }) {
    const kiosks = this.db.kvGet('kiosks', []);
    const k = kiosks.find((x) => x.id === params.id);
    if (!k) throw notFound('Kiosk');
    this.db.kvSet('kiosks', kiosks.filter((x) => x.id !== params.id));
    this.db.run("DELETE FROM sessions WHERE kind = 'kiosk' AND sub = ?", params.id);
    this.audit(actor, 'kiosk.removed', k.id, { name: k.name });
    return { ok: true };
  }
  kioskEmployees() {
    const today = this.today();
    const emps = this.employees({ activeOnly: true }).filter((e) => e.kioskAllowed !== false);
    const get = this.loadDays(null, today, today);
    return {
      serverTime: this.now(),
      storeName: this.settings.storeName,
      photoRequired: !!this.settings.rules.kioskPhoto,
      employees: emps.map((e) => {
        const d = daySummary(e, this.settings, today, get(e.id, today), this.now());
        // an open session from yesterday's night shift still counts as "in"
        const open = d.isOpen || !!this.openSession(e.id);
        return { id: e.id, code: e.code, name: e.name, nameUr: e.nameUr, hasPhoto: e.hasPhoto, photoVer: e.photoVer, isIn: open, onBreak: !!d.onBreak, checkIn: d.checkIn, checkOut: d.checkOut };
      }),
    };
  }
  kioskEmpPhoto({ params }) {
    const e = this.empRow(params.id);
    if (e.kioskAllowed === false) throw forbidden();
    return this.empPhoto({ params });
  }
  async kioskPunch({ actor, body, ip }) {
    const emp = this.empRow(str(body.employeeId, 40));
    if (emp.kioskAllowed === false) throw forbidden('NOT_ON_KIOSK', 'This employee cannot use the kiosk');
    const keys = [`e:${emp.code.toLowerCase()}`, `ip:${ip}`];
    this.lockCheck(keys);
    const row = this.db.get('SELECT pin FROM employees WHERE id = ?', emp.id);
    if (!(await checkPin(String(body.pin || ''), row.pin, this.pepper))) {
      this.lockFail(keys);
      throw new HttpError(401, 'WRONG_PIN', 'Wrong PIN');
    }
    this.lockClear(keys[0]);
    const photo = body.photo ? String(body.photo) : null;
    if (this.settings.rules.kioskPhoto && !photo) throw bad('NEED_PHOTO', 'A photo is needed');
    if (photo && (!/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 200_000)) throw bad('BAD_IMAGE', 'Bad photo');
    const type = body.type || (this.openSession(emp.id) ? 'out' : 'in');
    const res = this.punch(emp, { type, source: `kiosk:${actor.name}`, loc: body.loc, clientId: str(body.clientId, 60) || null, offlineTs: body.offlineTs, kiosk: true });
    if (photo && !res.duplicate) this.db.run('INSERT INTO photos (id, punch, data, ts) VALUES (?, ?, ?, ?)', uid(), res.punch.id, photo, this.now());
    return { ok: true, type, name: emp.name, ts: res.punch.ts, today: pickDay(this.day(emp, res.punch.day)) };
  }

  // ---------------------------------------------------------------- helper phone (staff without a phone)
  helperIds(actor) {
    const ids = (actor.helperFor || []).filter((id) => id !== actor.id);
    return new Set(ids);
  }
  helperList({ actor }) {
    const ids = this.helperIds(actor);
    const today = this.today();
    const emps = this.employees({ activeOnly: true }).filter((e) => ids.has(e.id));
    const get = this.loadDays(null, today, today);
    return {
      serverTime: this.now(),
      employees: emps.map((e) => {
        const d = daySummary(e, this.settings, today, get(e.id, today), this.now());
        const open = d.isOpen || !!this.openSession(e.id);
        return { id: e.id, code: e.code, name: e.name, nameUr: e.nameUr, hasPhoto: e.hasPhoto, photoVer: e.photoVer, isIn: open, onBreak: !!d.onBreak, checkIn: d.checkIn, checkOut: d.checkOut };
      }),
    };
  }
  helperPhoto({ actor, params }) {
    if (!this.helperIds(actor).has(params.id)) throw forbidden();
    return this.empPhoto({ params });
  }
  async helperPunch({ actor, body, ip }) {
    const id = str(body.employeeId, 40);
    if (!this.helperIds(actor).has(id)) throw forbidden('NOT_HELPER', 'You are not allowed to check in this employee');
    const emp = this.empRow(id);
    const keys = [`e:${emp.code.toLowerCase()}`, `ip:${ip}`];
    this.lockCheck(keys);
    const row = this.db.get('SELECT pin FROM employees WHERE id = ?', emp.id);
    if (!(await checkPin(String(body.pin || ''), row.pin, this.pepper))) {
      this.lockFail(keys);
      throw new HttpError(401, 'WRONG_PIN', 'Wrong PIN');
    }
    this.lockClear(keys[0]);
    const photo = body.photo ? String(body.photo) : null;
    if (photo && (!/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 200_000)) throw bad('BAD_IMAGE', 'Bad photo');
    const type = body.type || (this.openSession(emp.id) ? 'out' : 'in');
    const res = this.punch(emp, { type, source: `helper:${actor.name}`, loc: body.loc, clientId: str(body.clientId, 60) || null, offlineTs: body.offlineTs });
    if (photo && !res.duplicate) this.db.run('INSERT INTO photos (id, punch, data, ts) VALUES (?, ?, ?, ?)', uid(), res.punch.id, photo, this.now());
    this.audit({ id: actor.id, name: actor.name }, type === 'in' ? 'attendance.helper_in' : 'attendance.helper_out', emp.id, { name: emp.name });
    return { ok: true, type, name: emp.name, ts: res.punch.ts, today: pickDay(this.day(emp, res.punch.day)) };
  }

  // ---------------------------------------------------------------- employee app
  empHome({ actor }) {
    const emp = actor;
    const s = this.settings;
    const open = this.openSession(emp.id);
    const date = open ? open.day : this.today();
    const today = this.day(emp, date);
    const shiftToday = this.shiftOn(emp, date);
    const month = this.month();
    const st = this.statement(emp, month);
    const role = empRole(emp, s);
    const er = empRules(emp, s);
    return {
      serverTime: this.now(),
      store: {
        name: s.storeName, nameUr: s.storeNameUr || '', currency: s.currency, tzOffsetMin: s.tzOffsetMin, logoVer: this.db.kvGet('logoVer', 0),
        locations: s.locations.map((l) => ({ name: l.name, lat: l.lat, lng: l.lng, radius: l.radius })),
        rules: { breakAllowanceMin: er.breakAllowanceMin, breakNeedsApproval: s.rules.breakNeedsApproval, pastDayRequestDays: s.rules.pastDayRequestDays,
          lateGraceMin: er.lateGraceMin, maxOfflineHours: s.rules.maxOfflineHours, requireInRadiusCheckIn: er.requireInRadiusCheckIn },
      },
      employee: {
        id: emp.id, code: emp.code, name: emp.name, nameUr: emp.nameUr, role: role?.name, roleUr: role?.nameUr,
        shift: shiftToday, normalShift: empShift(emp, s), branch: emp.branchId ? s.locations.find((l) => l.id === emp.branchId)?.name || null : null, branchUr: emp.branchId ? s.locations.find((l) => l.id === emp.branchId)?.nameUr || null : null, fieldStaff: !!emp.fieldStaff, checkoutAnywhere: !!(emp.fieldStaff || role?.checkoutAnywhere),
        salaryVisibility: emp.salaryVisibility, hasPhoto: emp.hasPhoto, photoVer: emp.photoVer, helperCount: this.helperIds(emp).size,
      },
      window: (() => {
        // for the staff app: when check-in opens and when the shift ends (early check-out warning)
        const inDay = open ? open.day : this.dayForIn(emp, this.now());
        return { opensTs: open ? null : this.checkInOpensTs(emp, inDay), endTs: this.shiftEndTs(emp, open ? open.day : inDay), earlyMin: er.checkInEarlyMin };
      })(),
      today: { ...pickDay(today), breakUsedMin: today.breakMin, breakLeftMin: Math.max(0, er.breakAllowanceMin - today.breakMin) },
      leave: st.leave,
      depositBalance: this.depositBalance(emp.id),
      pendingRequests: this.db.all("SELECT * FROM requests WHERE emp = ? AND status = 'pending' ORDER BY created DESC", emp.id).map(reqOut),
      recheckin: this.recheckinState(emp),
      holidays: (s.holidays || []).filter((h) => h.date >= this.today() && h.date <= addDays(this.today(), 60)).slice(0, 10),
      unseenNotes: this.db.get('SELECT COUNT(*) AS n FROM staff_notes WHERE emp = ? AND voided = 0 AND seen IS NULL', emp.id).n,
      celebrate: this.celebrations([emp], this.today())[0] || null,
      policy: (() => { const p = this.policyFor(emp); return p.needed ? p : { ver: p.ver, needed: false, accepted: p.accepted }; })(),
    };
  }
  empPunch({ actor, body }) {
    const res = this.punch(actor, {
      type: body.type, source: String(actor.device || '').startsWith('web-') ? 'web' : 'app', loc: body.loc, offlineTs: body.offlineTs ?? null, clientId: str(body.clientId, 60) || null,
    });
    return { ok: true, duplicate: !!res.duplicate, ts: res.punch.ts, offline: !!res.punch.offline, today: pickDay(this.day(actor, res.punch.day)) };
  }
  empEndBreak({ actor }) {
    return this.endBreak(actor);
  }
  empRequests({ actor }) {
    return { requests: this.db.all('SELECT * FROM requests WHERE emp = ? ORDER BY created DESC LIMIT 100', actor.id).map(reqOut) };
  }
  empNewRequest({ actor, body }) {
    return this.createRequest(actor, body, 'app');
  }
  empCancelRequest({ actor, params }) {
    const r = this.db.get('SELECT * FROM requests WHERE id = ? AND emp = ?', params.id, actor.id);
    if (!r) throw notFound('Request');
    if (r.status !== 'pending') throw bad('ALREADY_DECIDED', 'Already decided');
    this.db.run("UPDATE requests SET status = 'cancelled', decided = ? WHERE id = ?", this.now(), r.id);
    return { ok: true };
  }
  empCalendar({ actor, q }) {
    const month = isMonth(q.get('month')) ? q.get('month') : this.month();
    if (month > this.month()) throw bad('BAD_MONTH', 'Future month');
    return this.calendar(actor, month);
  }
  empStatement({ actor, q }) {
    const month = isMonth(q.get('month')) ? q.get('month') : this.month();
    if (month > this.month()) throw bad('BAD_MONTH', 'Future month');
    if (actor.salaryVisibility === 'window') {
      // full statement only on the last 2 days of a month (that month) and on the 1st (the month just ended)
      const today = this.today();
      const day = Number(today.slice(8));
      const cur = this.month();
      const dim = daysInMonth(cur);
      const prev = addDays(`${cur}-01`, -1).slice(0, 7);
      const open = day >= dim - 1 ? cur : day === 1 ? prev : null;
      if (month !== open) {
        return { hidden: true, month, openMonth: open, opensOn: `${cur}-${String(dim - 1).padStart(2, '0')}`, currency: this.settings.currency,
          employee: { name: actor.name, nameUr: actor.nameUr, code: actor.code }, depositBalance: this.depositBalance(actor.id) };
      }
    }
    const st = this.statement(actor, month);
    if (actor.salaryVisibility === 'last7') {
      // only the last 7 days of records, no monthly totals
      const today = this.today();
      const from = addDays(today, -6);
      const days = st.days.filter((d) => d.date >= from && d.date <= today);
      return { limited: true, from, to: today, currency: st.currency, storeName: st.storeName, employee: st.employee, rates: st.rates,
        days, totalCut: Math.round(days.reduce((a, d) => a + d.cut, 0)), depositBalance: this.depositBalance(actor.id), leave: st.leave };
    }
    return { limited: false, statement: st };
  }

  // ---------------------------------------------------------------- housekeeping (daily alarm)
  // ---------------------------------------------------------------- backup / restore (owner only)
  backup({ actor }) {
    const s = this.settings;
    const b = makeBackup(this.db, { created: this.now(), storeName: s.storeName, by: actor.name });
    const day = new Date(this.now() + (s.tzOffsetMin || 0) * 60000).toISOString().slice(0, 10);
    return new Response(JSON.stringify(b), {
      headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="afford-backup-${day}.json"`, 'cache-control': 'no-store' },
    });
  }

  async restore({ actor, body, ip }) {
    const a = this.db.get('SELECT * FROM admins WHERE id = ?', actor.id);
    const keys = [`a:${a.login}`, `ip:${ip}`];
    this.lockCheck(keys);
    if (!(await checkPin(String(body.pin || ''), a.pin, this.pepper))) {
      this.lockFail(keys);
      throw new HttpError(401, 'WRONG_PIN', 'Wrong PIN');
    }
    let info;
    try { info = checkBackup(body.backup); } catch (e) { throw bad('BAD_BACKUP', e.message); }
    if (body.check) return { ok: true, info };
    // everything below is synchronous: the Durable Object saves it as one unit
    applyBackup(this.db, body.backup);
    this.pepper = this.env.PIN_PEPPER || this.db.kvGet('pepper', null) || this.pepper;
    if (!this.env.PIN_PEPPER) this.db.kvSet('pepper', this.pepper);
    this._settings = null;
    this.audit(actor, 'data.restore', null, { from: info.created, employees: info.employees });
    return { ok: true, info };
  }

  cleanup() {
    const now = this.now();
    this.db.run('DELETE FROM sessions WHERE expires < ?', now);
    this.db.run('DELETE FROM pin_fail WHERE until < ? AND last < ?', now, now - 24 * 3600 * 1000);
    this.db.run('DELETE FROM photos WHERE ts < ?', now - 90 * 24 * 3600 * 1000);
    this.db.run('DELETE FROM audit WHERE ts < ?', now - 3 * 365 * 24 * 3600 * 1000);
  }
}

function pickDay(d) {
  return {
    date: d.date, status: d.status, mark: d.mark, checkIn: d.checkIn, checkOut: d.checkOut, isOpen: d.isOpen, onBreak: d.onBreak,
    workedMin: d.workedMin, breakMin: d.breakMin, lateMin: d.lateMin, arriveLateMin: d.arriveLateMin, awayMin: d.awayMin, gaps: d.gaps, earlyMin: d.earlyMin, breakLateMin: d.breakLateMin,
    missingOut: d.missingOut, offline: d.offline, holiday: d.holiday, shiftStart: d.shiftStart, shiftEnd: d.shiftEnd,
  };
}
function reqOut(r) {
  return { id: r.id, emp: r.emp, type: r.type, data: JSON.parse(r.data), status: r.status, note: r.note, created: r.created, decided: r.decided };
}
function dataUrlResponse(d) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(d);
  const bin = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
  return new Response(bin, { headers: { 'content-type': m[1], 'cache-control': 'private, max-age=86400' } });
}

export { paidLeaveQuota };

installPro(Store);
installOps(Store);
installExtra(Store);

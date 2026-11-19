// v0.12.0 features:
//  - selfie with every staff check-in (rule staffSelfie), required from app v0.12.0 so older apps keep working until updated
//  - fake GPS: blocked check-ins are recorded and the owner gets one alert per employee per day
//  - owner dashboard: monthly late minutes, absences and salary cost, most and least punctual staff
//  - payslips on WhatsApp: remembers which payslips were sent for a month
//  - change history filters (attendance / money / staff / settings)
import { bad, str, isMonth, clampInt, monthDates, uid } from './util.js';

const IMG_RE = /^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/;

/** "employee/0.12.0" → true when the app is at least that version (web builds send the same header). */
export function appAtLeast(req, ver) {
  const h = req?.headers?.get?.('x-app-version') || '';
  const m = h.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const a = m.slice(1).map(Number);
  const b = ver.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

const monthsBack = (month, n) => {
  const out = [];
  let [y, m] = month.split('-').map(Number);
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (!m) { m = 12; y -= 1; }
  }
  return out;
};

// audit actions grouped for the change history filters
export const AUDIT_KINDS = {
  attendance: ['attendance.%', 'request.%', 'roster.%'],
  money: ['money.%', 'payroll.%'],
  staff: ['employee.%', 'note.%'],
  settings: ['settings.%', 'user.%', 'admin.%', 'kiosk.%', 'data.%', 'setup', 'login', 'approval.%'],
  security: ['security.%', 'employee.pin_%', 'employee.phone_reset'],
};

export function installInsights(Store) {
  const P = Store.prototype;

  P.insightsRoutes = function insightsRoutes(add, A) {
    add('GET', '/api/admin/dashboard', this.dashboard, A('payroll.view'));
    add('GET', '/api/admin/payslips/wa', this.waList, A('payroll.view'));
    add('POST', '/api/admin/payslips/wa-sent', this.waSent, A('payroll.view'));
  };

  // ---------------------------------------------------------------- selfie + fake GPS (staff app check-in)
  /** Staff app check-in / check-out. `pickDay` comes from store.js. */
  P.empPunchV2 = function empPunchV2({ actor, body, req }, pickDay) {
    const type = body.type;
    const photo = body.photo ? String(body.photo) : null;
    if (photo && (!IMG_RE.test(photo) || photo.length > 200_000)) throw bad('BAD_IMAGE', 'Bad photo');
    if (type === 'in' && this.settings.rules.staffSelfie && !photo && appAtLeast(req, '0.12.0')) {
      throw bad('NEED_SELFIE', 'A selfie is needed to check in. Allow the camera and try again.');
    }
    let res;
    try {
      res = this.punch(actor, {
        type, source: String(actor.device || '').startsWith('web-') ? 'web' : 'app', loc: body.loc, offlineTs: body.offlineTs ?? null, clientId: str(body.clientId, 60) || null,
      });
    } catch (e) {
      if (e.code === 'MOCK_LOCATION') this.fakeGpsCaught(actor, type, body.loc);
      throw e;
    }
    if (photo && !res.duplicate) this.db.run('INSERT INTO photos (id, punch, data, ts) VALUES (?, ?, ?, ?)', uid(), res.punch.id, photo, this.now());
    return { ok: true, duplicate: !!res.duplicate, ts: res.punch.ts, offline: !!res.punch.offline, selfie: !!photo, today: pickDay(this.day(actor, res.punch.day)) };
  };

  /** A check-in from a fake GPS app was blocked: write it down and tell the owner once a day per employee. */
  P.fakeGpsCaught = function fakeGpsCaught(emp, type, loc) {
    const today = this.today();
    this.audit({ id: emp.id, name: emp.name }, 'security.fake_gps', emp.id, {
      name: emp.name, punch: type, lat: Number(loc?.lat) || null, lng: Number(loc?.lng) || null,
    });
    const k = `fakegps:${today}`;
    const seen = this.db.kvGet(k, []);
    if (seen.includes(emp.id)) return;
    seen.push(emp.id);
    this.db.kvSet(k, seen);
    this.queuePush('admin', this.ownerIds(), `fakegps-${emp.id}-${today}`, (ur) => ({
      person: emp.id, personName: (ur && emp.nameUr) || emp.name, actions: 'open',
      card: {
        ...this.empCardHead(emp.id, ur), label: ur ? '⚠ جعلی GPS' : '⚠ Fake GPS', color: 'red',
        rows: [[ur ? 'کیا ہوا' : 'What', ur ? 'جعلی لوکیشن ایپ سے چیک اِن کی کوشش، روک دی گئی' : 'Tried to check in with a fake location app. Blocked.']],
      },
      title: ur ? `جعلی GPS · ${(ur && emp.nameUr) || emp.name}` : `Fake GPS · ${emp.name}`,
      body: ur ? 'جعلی لوکیشن ایپ سے چیک اِن کی کوشش روک دی گئی۔' : 'A check-in from a fake location app was blocked.',
    }));
  };

  // ---------------------------------------------------------------- owner dashboard
  P.dashboard = function dashboard({ actor, q }) {
    const month = isMonth(q.get('month')) ? q.get('month') : this.month();
    const n = clampInt(q.get('months'), 1, 12, 6);
    const list = monthsBack(month, n);
    const emps = this.inBranch(actor, q, this.employees({ activeOnly: false }));
    const months = [];
    let rank = [];
    for (const m of list) {
      if (m > this.month()) continue;
      const dates = monthDates(m);
      const get = this.loadDays(null, dates[0], dates[dates.length - 1]);
      const rows = emps
        .filter((e) => (e.active || (e.leaveDate && e.leaveDate >= `${m}-01`)) && (!e.joinDate || e.joinDate <= dates[dates.length - 1]))
        .map((e) => ({ e, st: this.statement(e, m, get) }));
      const sum = (f) => rows.reduce((a, r) => a + (Number(f(r.st)) || 0), 0);
      months.push({
        month: m, staff: rows.length,
        lateMin: sum((s) => s.counts.lateMin), lateDays: sum((s) => s.counts.late), absentDays: sum((s) => s.counts.absent),
        leaveDays: sum((s) => s.leave.paid + s.leave.unpaid), salaryCost: sum((s) => s.net), cuts: sum((s) => s.totalCuts),
        overtimePay: sum((s) => s.overtime?.pay || 0), complete: rows.every((r) => r.st.complete),
      });
      if (m === month) {
        rank = rows.filter((r) => r.st.counts.present > 0).map(({ e, st }) => ({
          id: e.id, code: e.code, name: e.name, nameUr: e.nameUr, hasPhoto: e.hasPhoto, photoVer: e.photoVer,
          present: st.counts.present, lateDays: st.counts.late, lateMin: st.counts.lateMin, absent: st.counts.absent,
          onTimePct: Math.round(((st.counts.present - st.counts.late) / st.counts.present) * 100),
        }));
      }
    }
    // best half and worst half, at most 5 each, never the same person in both lists
    const sorted = [...rank].sort((a, b) => a.lateMin - b.lateMin || a.absent - b.absent || b.present - a.present);
    const best = sorted.slice(0, Math.min(5, Math.ceil(sorted.length / 2)));
    const worst = sorted.slice(best.length).reverse().filter((r) => r.lateMin > 0 || r.absent > 0).slice(0, 5);
    return { month, months, best, worst, currency: this.settings.currency };
  };

  // ---------------------------------------------------------------- payslips on WhatsApp
  P.waList = function waList({ actor, q }) {
    const month = isMonth(q.get('month')) ? q.get('month') : this.month();
    const sent = this.db.kvGet(`waSent:${month}`, {});
    const dates = monthDates(month);
    const get = this.loadDays(null, dates[0], dates[dates.length - 1]);
    const rows = this.inBranch(actor, q, this.employees({ activeOnly: false }))
      .filter((e) => e.active || (e.leaveDate && e.leaveDate >= `${month}-01`))
      .map((e) => {
        const st = this.statement(e, month, get);
        return { id: e.id, code: e.code, name: e.name, nameUr: e.nameUr, phone: e.phone || '', hasPhoto: e.hasPhoto, photoVer: e.photoVer,
          net: st.net, paid: st.paid, sentTs: sent[e.id] || null };
      });
    return { month, rows };
  };
  P.waSent = function waSent({ actor, body }) {
    const month = isMonth(body.month) ? body.month : null;
    if (!month) throw bad('BAD_MONTH', 'Pick the salary month');
    const emp = this.empRow(str(body.employeeId, 40), { withDeleted: true });
    const k = `waSent:${month}`;
    const sent = this.db.kvGet(k, {});
    sent[emp.id] = this.now();
    this.db.kvSet(k, sent);
    this.audit(actor, 'payroll.payslip_whatsapp', emp.id, { name: emp.name, month });
    return { ok: true, sentTs: sent[emp.id] };
  };
}

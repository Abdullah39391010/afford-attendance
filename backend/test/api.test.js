import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, seeded } from './helpers.js';

test('setup needs the secret code and only works once', async () => {
  const t = await makeStore();
  assert.equal((await t.api('GET', '/api/info')).data.setupDone, false);
  assert.equal((await t.api('POST', '/api/setup', { setupCode: 'nope', pin: '1234' })).status, 403);
  const ok = await t.api('POST', '/api/setup', { setupCode: ' Setup123 ', name: 'Owner', login: 'owner', pin: '1234' });
  assert.equal(ok.status, 200);
  assert.match(ok.data.token, /^[a-f0-9]{64}$/);
  assert.equal((await t.api('POST', '/api/setup', { setupCode: 'setup123', pin: '9999' })).status, 403);
  // PIN is stored hashed, never in clear
  const row = t.store.db.get('SELECT pin FROM admins');
  assert.ok(row.pin.startsWith('p1$') && !row.pin.includes('1234'));
});

test('wrong PINs lock the login for a while', async () => {
  const t = await seeded();
  for (let i = 0; i < 5; i++) assert.equal((await t.api('POST', '/api/admin/login', { login: 'owner', pin: '0000' })).status, 401);
  const locked = await t.api('POST', '/api/admin/login', { login: 'owner', pin: '1234' });
  assert.equal(locked.status, 429);
  assert.equal(locked.data.error, 'LOCKED');
  t.advance(6);
  assert.equal((await t.api('POST', '/api/admin/login', { login: 'owner', pin: '1234' })).status, 200);
});

test('one phone = one employee, and owner can reset the binding', async () => {
  const t = await seeded();
  // Ali on another phone
  const r1 = await t.api('POST', '/api/emp/login', { code: t.ali.code, pin: '1111', deviceId: 'some-other-phone' });
  assert.equal(r1.data.error, 'BOUND_TO_OTHER_PHONE');
  // a new employee on Ali's phone
  const c = (await t.api('POST', '/api/admin/employees', { name: 'Cara', salary: 1, pin: '3333' }, t.owner)).data.employee;
  const r2 = await t.api('POST', '/api/emp/login', { code: c.code, pin: '3333', deviceId: 'phone-ali-0001' });
  assert.equal(r2.data.error, 'PHONE_USED_BY_OTHER');
  // login by phone number works on the right phone
  assert.equal((await t.api('POST', '/api/emp/login', { code: '03001234567', pin: '1111', deviceId: 'phone-ali-0001' })).status, 200);
  // owner resets Ali's phone: old session dies, new phone works
  assert.equal((await t.api('POST', `/api/admin/employees/${t.ali.id}/reset-device`, {}, t.owner)).status, 200);
  assert.equal((await t.aliApi('GET', '/api/emp/home')).status, 401);
  assert.equal((await t.api('POST', '/api/emp/login', { code: t.ali.code, pin: '1111', deviceId: 'some-other-phone' })).status, 200);
});

test('a manager cannot reset phones or see salaries without permission', async () => {
  const t = await seeded();
  await t.api('POST', '/api/admin/users', { name: 'Usman', login: 'usman', pin: '5555' }, t.owner);
  const m = (await t.api('POST', '/api/admin/login', { login: 'usman', pin: '5555' })).data.token;
  assert.equal((await t.api('POST', `/api/admin/employees/${t.ali.id}/reset-device`, {}, m)).data.error, 'OWNER_ONLY');
  const list = (await t.api('GET', '/api/admin/employees', null, m)).data.employees;
  assert.equal(list[0].salary, undefined);
  assert.equal((await t.api('GET', '/api/admin/payroll', null, m)).status, 403);
  assert.equal((await t.api('PUT', '/api/admin/settings', { rules: { lateGraceMin: 0 } }, m)).status, 403);
  assert.equal((await t.api('POST', '/api/admin/punch', { employeeId: t.ali.id, type: 'in', reason: 'no phone' }, m)).status, 200);
});

test('check-in needs to be inside the store radius; delivery can check out anywhere', async () => {
  const t = await seeded('2026-11-16T07:55');
  assert.equal((await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.far })).data.error, 'OUTSIDE_RADIUS');
  assert.equal((await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: { ...t.inStore, mock: true } })).data.error, 'MOCK_LOCATION');
  const ok = await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.today.status, 'present');
  assert.equal((await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore })).data.error, 'ALREADY_IN');
  t.advance(8 * 60 + 10);
  assert.equal((await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.far })).data.error, 'OUTSIDE_RADIUS');

  await t.bilalApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  t.advance(30);
  assert.equal((await t.bilalApi('POST', '/api/emp/punch', { type: 'out', loc: t.far })).status, 200);
});

test('field staff (purchaser) can check in from anywhere and the GPS point is kept', async () => {
  const t = await seeded('2026-11-16T09:00');
  await t.api('PUT', `/api/admin/employees/${t.ali.id}`, { fieldStaff: true }, t.owner);
  const r = await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.far });
  assert.equal(r.status, 200);
  const day = (await t.api('GET', `/api/admin/employees/${t.ali.id}/day/2026-11-16`, null, t.owner)).data.day;
  assert.ok(day.punches[0].dist > 100000);
});

test('late minutes and payroll cuts follow the formula', async () => {
  const t = await seeded('2026-11-16T08:40'); // shift 08:00, grace 15 -> late 40 min
  const r = await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  assert.equal(r.data.today.status, 'late');
  assert.equal(r.data.today.lateMin, 40);
  t.setTime('2026-11-16T15:30'); // leaves 30 min early (grace 10)
  await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore });
  t.setTime('2026-11-16T23:00');
  const st = (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-11`, null, t.owner)).data.statement;
  // 26000 / 26 days = 1000/day, /8h = 125/h, 2.0833/min
  assert.equal(st.rates.daily, 1000);
  assert.equal(st.rates.hourly, 125);
  assert.equal(st.cuts.late, 83.33);
  assert.equal(st.cuts.early, 62.5);
  // Nov 1..15 before Ali existed count as absent unless a join date is set; Sundays are working days, Fridays off
  assert.equal(st.counts.present, 1);
  assert.equal(st.counts.off, 2); // Fri 6 and 13
  assert.equal(st.counts.absent, 13);
  assert.equal(st.cuts.absent, 13000);
  assert.equal(st.net, Math.round(26000 - 13000 - 83.33 - 62.5));
});

test('join date stops earlier days counting as absent; holidays and actual-days basis', async () => {
  const t = await seeded('2026-11-16T08:00');
  await t.api('PUT', `/api/admin/employees/${t.ali.id}`, { joinDate: '2026-11-16' }, t.owner);
  await t.api('PUT', '/api/admin/settings', { holidays: [{ date: '2026-11-17', name: 'Test holiday' }], rules: { daysBasis: 'actual' } }, t.owner);
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  t.setTime('2026-11-17T20:00');
  const st = (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-11`, null, t.owner)).data.statement;
  assert.equal(st.basisDays, 30);
  assert.equal(st.counts.holiday, 1);
  assert.equal(st.counts.absent, 0);
  assert.equal(st.counts.notJoined, 13); // 15 days minus 2 Fridays
  assert.equal(st.counts.missingOut, 1); // checked in on the 16th, never checked out
});

test('break: request, approve, late return is counted', async () => {
  const t = await seeded('2026-11-16T08:00');
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  t.setTime('2026-11-16T13:00');
  const req = (await t.aliApi('POST', '/api/emp/requests', { type: 'break', minutes: 20 })).data.request;
  assert.equal(req.status, 'pending');
  const chg = (await t.api('GET', '/api/admin/changes', null, t.owner)).data;
  assert.equal(chg.pending, 1);
  const d = await t.api('POST', `/api/admin/requests/${req.id}/decide`, { approve: true }, t.owner);
  assert.equal(d.data.break.allowed, 20);
  let board = (await t.api('GET', '/api/admin/board', null, t.owner)).data;
  assert.equal(board.counts.break, 1);
  t.advance(35);
  const end = (await t.aliApi('POST', '/api/emp/break/end')).data;
  assert.equal(end.lateMin, 15);
  const home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.today.breakLateMin, 15);
  assert.equal(home.today.breakLeftMin, 0);
  board = (await t.api('GET', '/api/admin/board', null, t.owner)).data;
  assert.equal(board.counts.in, 1);
});

test('break without approval starts at once when the rule is switched off', async () => {
  const t = await seeded('2026-11-16T08:00');
  await t.api('PUT', '/api/admin/settings', { rules: { breakNeedsApproval: false } }, t.owner);
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  const r = (await t.aliApi('POST', '/api/emp/requests', { type: 'break', minutes: 15 })).data;
  assert.equal(r.started, true);
  // check-out also ends the break
  t.advance(10);
  await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore });
  assert.equal(t.store.openBreak(t.ali.id), null);
});

test('forgot check-in, forgot check-out, past day, leave, advance, undo check-out', async () => {
  const t = await seeded('2026-11-16T10:00');
  const decide = (id, body = {}) => t.api('POST', `/api/admin/requests/${id}/decide`, { approve: true, ...body }, t.owner);
  // forgot check-in today at 08:05
  let r = (await t.aliApi('POST', '/api/emp/requests', { type: 'forgot_in', time: '08:05' })).data.request;
  await decide(r.id);
  let home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.today.isOpen, true);
  assert.equal(home.today.lateMin, 0);
  // checks out by mistake at 12:00, asks to undo
  t.setTime('2026-11-16T12:00');
  await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore });
  r = (await t.aliApi('POST', '/api/emp/requests', { type: 'undo_checkout' })).data.request;
  await decide(r.id);
  home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.today.isOpen, true);
  // past day (yesterday, Sunday)
  r = (await t.aliApi('POST', '/api/emp/requests', { type: 'past_day', date: '2026-11-15', inTime: '08:00', outTime: '16:00' })).data.request;
  await decide(r.id);
  // too old / last month refused
  assert.equal((await t.aliApi('POST', '/api/emp/requests', { type: 'past_day', date: '2026-11-01', inTime: '08:00', outTime: '16:00' })).data.error, 'TOO_OLD');
  assert.equal((await t.aliApi('POST', '/api/emp/requests', { type: 'past_day', date: '2026-10-31', inTime: '08:00', outTime: '16:00' })).data.error, 'NOT_THIS_MONTH');
  // leave for 2 days, 1 paid quota -> one unpaid
  r = (await t.aliApi('POST', '/api/emp/requests', { type: 'leave', date: '2026-11-18', toDate: '2026-11-19', reason: 'Wedding' })).data.request;
  await decide(r.id);
  // advance
  r = (await t.aliApi('POST', '/api/emp/requests', { type: 'advance', amount: 5000, reason: 'Rent' })).data.request;
  await decide(r.id, { amount: 4000 });
  // forgot check-out at 16:00
  t.setTime('2026-11-16T18:00');
  await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore }).catch(() => {});
  t.setTime('2026-11-20T09:00');
  const cal = (await t.aliApi('GET', '/api/emp/calendar?month=2026-11')).data.days;
  const byDate = Object.fromEntries(cal.map((d) => [d.date, d]));
  assert.equal(byDate['2026-11-15'].status, 'present');
  assert.equal(byDate['2026-11-15'].request, 'approved');
  assert.equal(byDate['2026-11-18'].status, 'leave');
  assert.equal(byDate['2026-11-20'].status, 'off');
  const st = (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-11`, null, t.owner)).data.statement;
  assert.equal(st.leave.paid, 1);
  assert.equal(st.leave.unpaid, 1);
  assert.equal(st.advances, 4000);
  const audit = (await t.api('GET', '/api/admin/audit', null, t.owner)).data.entries.map((e) => e.action);
  assert.ok(audit.includes('request.approved'));
});

test('checking in again after check-out needs an approved request, and the time away counts as late', async () => {
  const t = await seeded('2026-11-16T08:00');
  const decide = (id, approve = true) => t.api('POST', `/api/admin/requests/${id}/decide`, { approve }, t.owner);
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  t.setTime('2026-11-16T12:00');
  await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore });
  t.setTime('2026-11-16T12:30');
  // straight check-in is refused
  let res = await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  assert.equal(res.data.error, 'RECHECKIN_NEEDED');
  let home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.recheckin.needed, true);
  assert.equal(home.recheckin.status, null);
  // ask, get declined, still refused
  assert.equal((await t.aliApi('POST', '/api/emp/requests', { type: 'recheckin' })).data.error, 'NO_LOCATION');
  assert.equal((await t.aliApi('POST', '/api/emp/requests', { type: 'recheckin', loc: { lat: 31.5, lng: 74.3 } })).data.error, 'OUTSIDE_RADIUS');
  let r = (await t.aliApi('POST', '/api/emp/requests', { type: 'recheckin', reason: 'Bank work done', loc: t.inStore })).data.request;
  assert.equal((await t.aliApi('POST', '/api/emp/requests', { type: 'recheckin', loc: t.inStore })).data.error, 'DUPLICATE');
  assert.equal((await t.aliApi('GET', '/api/emp/home')).data.recheckin.status, 'pending');
  await decide(r.id, false);
  assert.equal((await t.aliApi('GET', '/api/emp/home')).data.recheckin.status, 'declined');
  assert.equal((await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore })).data.error, 'RECHECKIN_NEEDED');
  // ask again at 12:30; the manager approves at 13:00 -> checked in from 12:30 (the time of the request)
  r = (await t.aliApi('POST', '/api/emp/requests', { type: 'recheckin', loc: t.inStore })).data.request;
  t.setTime('2026-11-16T13:00');
  const dec = (await decide(r.id)).data;
  assert.equal(dec.checkedIn, Date.parse('2026-11-16T12:30:00+05:00'));
  home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.today.isOpen, true);
  assert.equal(home.recheckin, null);
  res = { data: { today: home.today } };
  assert.equal(res.data.today.awayMin, 30);
  assert.equal(res.data.today.lateMin, 30);
  assert.equal(res.data.today.arriveLateMin, 0);
  assert.equal(res.data.today.status, 'late');
  assert.equal(res.data.today.gaps.length, 1);
  // the approval is used up: after another check-out a new request is needed
  t.setTime('2026-11-16T14:00');
  await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore });
  assert.equal((await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore })).data.error, 'RECHECKIN_NEEDED');
  // admin can still check them in by hand
  res = await t.api('POST', '/api/admin/punch', { employeeId: t.ali.id, type: 'in', reason: 'Came back' }, t.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  // next day is a fresh start
  t.setTime('2026-11-17T08:00');
  await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore }).catch(() => {});
  res = await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  assert.equal(res.data.ok, true);
});

test('offline punches use the phone estimate, are flagged, and are not duplicated', async () => {
  const t = await seeded('2026-11-16T08:00');
  const clientId = 'abc-123';
  t.setTime('2026-11-16T09:30'); // phone comes online 90 minutes later
  const body = { type: 'in', loc: t.inStore, clientId, offlineTs: Date.parse('2026-11-16T08:02:00+05:00') };
  const a = await t.aliApi('POST', '/api/emp/punch', body);
  assert.equal(a.data.offline, true);
  assert.equal(a.data.today.lateMin, 0);
  const b = await t.aliApi('POST', '/api/emp/punch', body);
  assert.equal(b.data.duplicate, true);
  // a "future" timestamp from a wrong phone clock is capped at server time
  const c = await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore, clientId: 'x2', offlineTs: t.now() + 3600000 });
  assert.equal(c.data.ts, t.now());
  // too old (more than 7 days)
  t.setTime('2026-11-24T09:30');
  const d = await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore, clientId: 'x3', offlineTs: Date.parse('2026-11-16T10:00:00+05:00') });
  assert.equal(d.data.error, 'OFFLINE_TOO_OLD');
});

test('admin check-in for staff without a phone needs a reason and is audited', async () => {
  const t = await seeded('2026-11-16T08:10');
  const g = (await t.api('POST', '/api/admin/employees', { name: 'Guard Khan', roleId: 'guard', salary: 20000 }, t.owner)).data.employee;
  assert.equal((await t.api('POST', '/api/admin/punch', { employeeId: g.id, type: 'in' }, t.owner)).data.error, 'NEED_REASON');
  assert.equal((await t.api('POST', '/api/admin/punch', { employeeId: g.id, type: 'in', reason: 'No phone' }, t.owner)).status, 200);
  // set a past check-out time
  t.setTime('2026-11-16T17:00');
  assert.equal((await t.api('POST', '/api/admin/punch', { employeeId: g.id, type: 'out', time: '16:00', reason: 'Forgot' }, t.owner)).status, 200);
  const day = (await t.api('GET', `/api/admin/employees/${g.id}/day/2026-11-16`, null, t.owner)).data.day;
  assert.equal(day.workedMin, 470);
  const audit = (await t.api('GET', `/api/admin/audit?target=${g.id}`, null, t.owner)).data.entries;
  assert.equal(audit.length, 3);
});

test('kiosk: PIN + photo, inside store only, toggles in/out', async () => {
  const t = await seeded('2026-11-16T07:58');
  const g = (await t.api('POST', '/api/admin/employees', { name: 'Cleaner Bibi', roleId: 'cleaner', salary: 18000, pin: '4321' }, t.owner)).data.employee;
  const k = (await t.api('POST', '/api/admin/kiosks', { name: 'Counter phone', deviceId: 'kiosk-device-1' }, t.owner)).data;
  const kApi = (m, p, b) => t.api(m, p, b, k.token);
  const list = (await kApi('GET', '/api/kiosk/employees')).data.employees;
  assert.ok(list.some((e) => e.id === g.id));
  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  assert.equal((await kApi('POST', '/api/kiosk/punch', { employeeId: g.id, pin: '0000', loc: t.inStore, photo })).data.error, 'WRONG_PIN');
  assert.equal((await kApi('POST', '/api/kiosk/punch', { employeeId: g.id, pin: '4321', loc: t.inStore })).data.error, 'NEED_PHOTO');
  assert.equal((await kApi('POST', '/api/kiosk/punch', { employeeId: g.id, pin: '4321', loc: t.far, photo })).data.error, 'OUTSIDE_RADIUS');
  const r1 = (await kApi('POST', '/api/kiosk/punch', { employeeId: g.id, pin: '4321', loc: t.inStore, photo })).data;
  assert.equal(r1.type, 'in');
  t.advance(480);
  const r2 = (await kApi('POST', '/api/kiosk/punch', { employeeId: g.id, pin: '4321', loc: t.inStore, photo })).data;
  assert.equal(r2.type, 'out');
  // employee app tokens cannot use kiosk endpoints
  assert.equal((await t.aliApi('GET', '/api/kiosk/employees')).status, 401);
  // removing the kiosk kills its token
  await t.api('DELETE', `/api/admin/kiosks/${k.kiosk.id}`, null, t.owner);
  assert.equal((await kApi('GET', '/api/kiosk/employees')).status, 401);
});

test('board shows live counts, and night shifts across midnight stay on the start day', async () => {
  const t = await seeded('2026-11-16T15:55');
  await t.api('PUT', `/api/admin/employees/${t.ali.id}`, { shiftId: 'evening' }, t.owner);
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  let board = (await t.api('GET', '/api/admin/board', null, t.owner)).data;
  assert.equal(board.counts.in, 1);
  assert.equal(board.counts.absent, 1); // Bilal, morning shift, never came
  t.setTime('2026-11-17T00:05');
  await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore });
  const day = (await t.api('GET', `/api/admin/employees/${t.ali.id}/day/2026-11-16`, null, t.owner)).data.day;
  assert.equal(day.workedMin, 490);
  assert.equal(day.earlyMin, 0);
});

test('salary statement visibility: last 7 days only', async () => {
  const t = await seeded('2026-11-16T08:00');
  await t.api('PUT', `/api/admin/employees/${t.ali.id}`, { salaryVisibility: 'last7' }, t.owner);
  const r = (await t.aliApi('GET', '/api/emp/statement?month=2026-11')).data;
  assert.equal(r.limited, true);
  assert.equal(r.days.length, 7);
  assert.equal(r.statement, undefined);
  const b = (await t.bilalApi('GET', '/api/emp/statement')).data;
  assert.equal(b.limited, false);
  assert.ok(b.statement.net !== undefined);
});

test('security deposit balance and money entries', async () => {
  const t = await seeded('2026-11-16T08:00');
  await t.api('POST', '/api/admin/money', { employeeId: t.ali.id, kind: 'deposit', amount: 10000, note: 'Cash' }, t.owner);
  await t.api('POST', '/api/admin/money', { employeeId: t.ali.id, kind: 'deposit_cut', amount: 2000 }, t.owner);
  const home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.depositBalance, 12000);
  const st = (await t.api('GET', `/api/admin/payroll/${t.ali.id}`, null, t.owner)).data.statement;
  assert.equal(st.depositCut, 2000);
});

test('reports export CSV', async () => {
  const t = await seeded('2026-11-16T08:30');
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  const late = await t.api('GET', '/api/admin/reports?type=daily&list=late&format=csv', null, t.owner);
  assert.equal(late.status, 200);
  assert.match(late.data, /Ali/);
  assert.match(late.data, /late,08:30/);
  const monthly = (await t.api('GET', '/api/admin/reports?type=monthly', null, t.owner)).data;
  assert.equal(monthly.summary.length, 2);
  const pay = await t.api('GET', '/api/admin/payroll?month=2026-11&format=csv', null, t.owner);
  assert.match(pay.data, /Net pay/);
});

test('mark days as leave / out-of-town duty / absent from admin', async () => {
  const t = await seeded('2026-11-16T12:00');
  await t.api('POST', '/api/admin/mark', { employeeId: t.bilal.id, date: '2026-11-16', status: 'duty', note: 'Lahore purchase' }, t.owner);
  const r = (await t.bilalApi('POST', '/api/emp/requests', { type: 'field_duty', date: '2026-11-17', reason: 'Multan' })).data.request;
  await t.api('POST', `/api/admin/requests/${r.id}/decide`, { approve: true }, t.owner);
  t.setTime('2026-11-17T12:00');
  const cal = (await t.bilalApi('GET', '/api/emp/calendar')).data.days;
  assert.equal(cal.find((d) => d.date === '2026-11-16').status, 'duty');
  assert.equal(cal.find((d) => d.date === '2026-11-17').status, 'duty');
});

test('settings validation', async () => {
  const t = await seeded();
  assert.equal((await t.api('PUT', '/api/admin/settings', { rules: { daysBasis: 99 } }, t.owner)).status, 400);
  assert.equal((await t.api('PUT', '/api/admin/settings', { locations: [{ lat: 0, lng: 0 }] }, t.owner)).status, 400);
  const s = (await t.api('PUT', '/api/admin/settings', { rules: { daysBasis: 30, lateGraceMin: 5 } }, t.owner)).data;
  assert.equal(s.rules.daysBasis, 30);
  assert.equal(s.rules.lateGraceMin, 5);
  assert.equal(s.rules.paidLeavePerMonth, 1);
});

test('helper phone: a chosen employee checks in listed co-workers with their own PIN', async () => {
  const t = await seeded('2026-11-16T07:58');
  const g = (await t.api('POST', '/api/admin/employees', { name: 'Guard Khan', roleId: 'guard', salary: 20000, pin: '4321' }, t.owner)).data.employee;
  // not allowed yet
  assert.equal((await t.aliApi('POST', '/api/emp/helper/punch', { employeeId: g.id, pin: '4321', loc: t.inStore })).data.error, 'NOT_HELPER');
  await t.api('PUT', `/api/admin/employees/${t.ali.id}`, { helperFor: [g.id] }, t.owner);
  const home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.employee.helperCount, 1);
  const list = (await t.aliApi('GET', '/api/emp/helper')).data.employees;
  assert.deepEqual(list.map((e) => e.id), [g.id]);
  assert.equal((await t.aliApi('POST', '/api/emp/helper/punch', { employeeId: g.id, pin: '0000', loc: t.inStore })).data.error, 'WRONG_PIN');
  assert.equal((await t.aliApi('POST', '/api/emp/helper/punch', { employeeId: g.id, pin: '4321', loc: t.far })).data.error, 'OUTSIDE_RADIUS');
  const r = (await t.aliApi('POST', '/api/emp/helper/punch', { employeeId: g.id, pin: '4321', loc: t.inStore })).data;
  assert.equal(r.type, 'in');
  // Bilal is not on the list
  assert.equal((await t.aliApi('POST', '/api/emp/helper/punch', { employeeId: t.bilal.id, pin: '2222', loc: t.inStore })).data.error, 'NOT_HELPER');
  // Bilal's own phone cannot use the helper list
  assert.equal((await t.bilalApi('GET', '/api/emp/helper')).data.employees.length, 0);
});

test('job rules: a role can have its own grace time', async () => {
  const t = await seeded('2026-11-16T08:20');
  const s = (await t.api('GET', '/api/admin/settings', null, t.owner)).data;
  const roles = s.roles.map((r) => (r.id === 'cashier' ? { ...r, rules: { lateGraceMin: 30 } } : r));
  await t.api('PUT', '/api/admin/settings', { roles }, t.owner);
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore }); // cashier, 20 min late but grace 30
  await t.bilalApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore }); // delivery, store grace 15
  const a = (await t.api('GET', `/api/admin/employees/${t.ali.id}/day/2026-11-16`, null, t.owner)).data.day;
  const b = (await t.api('GET', `/api/admin/employees/${t.bilal.id}/day/2026-11-16`, null, t.owner)).data.day;
  assert.equal(a.lateMin, 0);
  assert.equal(b.lateMin, 20);
});

test('salary statement visibility: last 2 days of the month and the 1st', async () => {
  const t = await seeded('2026-11-16T08:00');
  await t.api('PUT', `/api/admin/employees/${t.ali.id}`, { salaryVisibility: 'window' }, t.owner);
  let r = (await t.aliApi('GET', '/api/emp/statement?month=2026-11')).data;
  assert.equal(r.hidden, true);
  assert.equal(r.opensOn, '2026-11-29');
  t.setTime('2026-11-29T09:00');
  r = (await t.aliApi('GET', '/api/emp/statement?month=2026-11')).data;
  assert.ok(r.statement);
  t.setTime('2026-12-01T09:00');
  r = (await t.aliApi('GET', '/api/emp/statement?month=2026-11')).data;
  assert.ok(r.statement);
  t.setTime('2026-12-02T09:00');
  r = (await t.aliApi('GET', '/api/emp/statement?month=2026-11')).data;
  assert.equal(r.hidden, true);
});

test('backup and restore: owner only, needs PIN, brings data back', async () => {
  const t = await seeded('2026-11-16T07:50');
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore, clientId: 'b1' });
  // manager cannot back up
  await t.api('POST', '/api/admin/users', { name: 'Mgr', login: 'mgr', pin: '5555', role: 'manager' }, t.owner);
  const mgr = (await t.api('POST', '/api/admin/login', { login: 'mgr', pin: '5555' })).data.token;
  assert.equal((await t.api('GET', '/api/admin/backup', null, mgr)).status, 403);
  const b = (await t.api('GET', '/api/admin/backup', null, t.owner)).data;
  const backup = typeof b === 'string' ? JSON.parse(b) : b;
  assert.equal(backup.format, 'afford-backup');
  assert.equal(backup.counts.employees, 2);
  assert.equal(backup.counts.punches, 1);
  // change things after the backup
  await t.api('POST', '/api/admin/employees', { name: 'Late joiner', salary: 1, pin: '7777' }, t.owner);
  assert.equal((await t.api('GET', '/api/admin/employees', null, t.owner)).data.employees.length, 3);
  // wrong PIN / bad file are refused
  assert.equal((await t.api('POST', '/api/admin/restore', { pin: '0000', backup }, t.owner)).status, 401);
  assert.equal((await t.api('POST', '/api/admin/restore', { pin: '1234', backup: { format: 'x' } }, t.owner)).data.error, 'BAD_BACKUP');
  const bad = structuredClone(backup); bad.columns.admins[0] = 'id); DROP TABLE kv; --';
  assert.equal((await t.api('POST', '/api/admin/restore', { pin: '1234', backup: bad }, t.owner)).data.error, 'BAD_BACKUP');
  // check only
  const chk = await t.api('POST', '/api/admin/restore', { pin: '1234', backup, check: true }, t.owner);
  assert.equal(chk.data.info.employees, 2);
  assert.equal((await t.api('GET', '/api/admin/employees', null, t.owner)).data.employees.length, 3);
  // real restore
  const r = await t.api('POST', '/api/admin/restore', { pin: '1234', backup }, t.owner);
  assert.equal(r.status, 200);
  assert.equal((await t.api('GET', '/api/admin/employees', null, t.owner)).data.employees.length, 2);
  // PINs still work after restore, phone links kept
  assert.equal((await t.api('POST', '/api/admin/login', { login: 'owner', pin: '1234' })).status, 200);
  assert.equal((await t.aliApi('GET', '/api/emp/home')).status, 200);
  assert.equal((await t.aliApi('GET', '/api/emp/home')).data.today.isOpen, true);
});

test('background notifications: admin hears about new requests, staff about decisions', async () => {
  const t = await seeded();
  const first = (await t.api('GET', '/api/admin/notify', null, t.owner)).data;
  assert.equal(first.items.length, 0);
  t.advance(1);
  const req = (await t.aliApi('POST', '/api/emp/requests', { type: 'leave', date: '2026-11-20', toDate: '2026-11-20', reason: 'wedding' })).data.request;
  const n = (await t.api('GET', `/api/admin/notify?since=${first.since}`, null, t.owner)).data;
  assert.equal(n.items.length, 1);
  assert.match(n.items[0].title, /Leave/);
  assert.match(n.items[0].body, /Ali/);
  // nothing new next time
  assert.equal((await t.api('GET', `/api/admin/notify?since=${n.since}`, null, t.owner)).data.items.length, 0);
  // Urdu
  assert.match((await t.api('GET', `/api/admin/notify?since=${first.since}&lang=ur`, null, t.owner)).data.items[0].title, /چھٹی/);
  // staff side
  const e0 = (await t.aliApi('GET', '/api/emp/notify')).data;
  t.advance(1);
  await t.api('POST', `/api/admin/requests/${req.id}/decide`, { approve: true }, t.owner);
  const e1 = (await t.aliApi('GET', `/api/emp/notify?since=${e0.since}`)).data;
  assert.equal(e1.items.length, 1);
  assert.equal(e1.items[0].title, 'Request approved');
});

test('instant push: phones register, admins get new requests, staff get answers', async () => {
  const t = await seeded();
  const sent = [];
  t.store.pushSender = async (msgs) => { sent.push(...msgs); return ['admin-phone-token-dead-000000000']; };
  assert.equal((await t.api('POST', '/api/admin/push-token', { token: 'admin-phone-token-1234567890', lang: 'en' }, t.owner)).status, 200);
  await t.api('POST', '/api/admin/push-token', { token: 'admin-phone-token-dead-000000000' }, t.owner);
  assert.equal((await t.aliApi('POST', '/api/emp/push-token', { token: 'ali-phone-token-123456789012', lang: 'ur' })).status, 200);
  const req = (await t.aliApi('POST', '/api/emp/requests', { type: 'leave', date: '2026-11-20', toDate: '2026-11-20', reason: 'x' })).data.request;
  assert.equal(sent.length, 2); // both admin tokens
  assert.match(sent[0].title, /New request: Leave/);
  // dead token removed
  assert.equal(t.store.db.all("SELECT * FROM push_tokens WHERE kind = 'admin'").length, 1);
  sent.length = 0;
  await t.api('POST', `/api/admin/requests/${req.id}/decide`, { approve: true }, t.owner);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, 'ali-phone-token-123456789012');
  assert.equal(sent[0].title, 'درخواست منظور ہو گئی');
});

test('push test: sends to the caller only and reports the result', async () => {
  const t = await seeded();
  const sent = [];
  t.store.pushSender = async (msgs, report) => { sent.push(...msgs); msgs.forEach(() => report.push({ status: 200, error: '' })); return []; };
  const off = (await t.api('POST', '/api/admin/push-test', {}, t.owner)).data;
  assert.equal(off.phones, 0);
  t.store.env = { ...t.store.env, FIREBASE_SERVICE_ACCOUNT: '{}' };
  await t.aliApi('POST', '/api/emp/push-token', { token: 'ali-phone-token-123456789012', lang: 'en' });
  const r = (await t.api('POST', '/api/admin/push-test', { token: 'owner-phone-token-1234567890', lang: 'en' }, t.owner)).data;
  assert.equal(r.configured, true);
  assert.equal(r.phones, 1);
  assert.equal(r.results[0].status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, 'owner-phone-token-1234567890');
  const e = (await t.aliApi('POST', '/api/emp/push-test', {})).data;
  assert.equal(e.phones, 1);
  assert.equal(sent[1].token, 'ali-phone-token-123456789012');
});

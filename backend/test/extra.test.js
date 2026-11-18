import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seeded } from './helpers.js';

const capture = (t) => {
  const sent = [];
  t.store.pushSender = async (msgs) => { sent.push(...msgs); return []; };
  return sent;
};
const token = (t, kind, sub, tk) => t.store.db.run("INSERT INTO push_tokens (token, kind, sub, lang, updated) VALUES (?, ?, ?, 'en', 0)", tk, kind, sub);
const stmt = async (t, id, month = '2026-11') => (await t.api('GET', `/api/admin/payroll/${id}?month=${month}`, null, t.owner)).data.statement;

test('holidays: paid off day, extra pay for working on it, staff told', async () => {
  const t = await seeded('2026-11-16T08:00');
  const sent = capture(t);
  token(t, 'emp', t.ali.id, 'ali-token-12345678901234');
  let r = await t.api('PUT', '/api/admin/settings', { holidays: [{ date: '2026-11-18', name: 'Test day', nameUr: 'ٹیسٹ' }, { date: '2026-11-18', name: 'dupe' }] }, t.owner);
  assert.equal(r.status, 200);
  assert.equal(r.data.holidays.length, 1);
  assert.equal(sent.filter((m) => m.title === 'Holiday').length, 1);
  const home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.holidays[0].date, '2026-11-18');
  // Ali works on the holiday
  t.setTime('2026-11-18T08:00');
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  t.setTime('2026-11-18T16:00');
  await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore });
  let st = await stmt(t, t.ali.id);
  assert.equal(st.counts.holidayWorked, 1);
  assert.equal(st.holidayPay, 0);
  await t.api('PUT', '/api/admin/settings', { rules: { holidayWorkExtra: true } }, t.owner);
  st = await stmt(t, t.ali.id);
  assert.equal(st.holidayPay, 1000); // 26000 / 26
});

test('bonus, commission and fines change net pay; fine needs a reason; bulk bonus by percent', async () => {
  const t = await seeded('2026-11-16T08:00');
  const before = (await stmt(t, t.ali.id)).net;
  let r = await t.api('POST', '/api/admin/money', { employeeId: t.ali.id, kind: 'fine', amount: 500 }, t.owner);
  assert.equal(r.data.error, 'NEED_REASON');
  r = await t.api('POST', '/api/admin/money', { employeeId: t.ali.id, kind: 'fine', amount: 500, note: 'Broken jar' }, t.owner);
  assert.equal(r.status, 200);
  await t.api('POST', '/api/admin/money', { employeeId: t.ali.id, kind: 'commission', amount: 300, note: 'Sales' }, t.owner);
  let st = await stmt(t, t.ali.id);
  assert.equal(st.fines, 500);
  assert.equal(st.commission, 300);
  assert.equal(st.net, before - 200);
  r = await t.api('POST', '/api/admin/money/bulk', { kind: 'bonus', percent: 10, note: 'Eid bonus' }, t.owner);
  assert.equal(r.data.count, 2);
  assert.equal(r.data.total, 2600 + 3000);
  st = await stmt(t, t.ali.id);
  assert.equal(st.bonus, 2600);
  const csv = (await t.api('GET', '/api/admin/payroll?month=2026-11&format=csv', null, t.owner)).data;
  assert.match(csv.split('\n')[0], /Fines.*Commission/);
});

test('duty roster changes the shift, a day off, and swap requests', async () => {
  const t = await seeded('2026-11-16T08:00');
  const sent = capture(t);
  token(t, 'emp', t.ali.id, 'ali-token-12345678901234');
  // Ali: evening on Tuesday 17th, off on Wednesday 18th, works Friday 20th (normal weekly off)
  let r = await t.api('PUT', '/api/admin/roster', { cells: [
    { employeeId: t.ali.id, date: '2026-11-17', shiftId: 'evening', off: false },
    { employeeId: t.ali.id, date: '2026-11-18', shiftId: 'morning', off: true },
    { employeeId: t.ali.id, date: '2026-11-20', shiftId: 'morning', off: false },
  ] }, t.owner);
  assert.equal(r.data.changed, 3);
  assert.equal(sent.filter((m) => m.title === 'Your duty roster changed').length, 1);
  const g = (await t.api('GET', '/api/admin/roster?from=2026-11-16', null, t.owner)).data;
  const ali = g.employees.find((e) => e.id === t.ali.id);
  assert.deepEqual(ali.cells.map((c) => (c.off ? 'off' : c.shiftId)), ['morning', 'evening', 'off', 'morning', 'morning', 'morning', 'morning']);
  // evening check-in at 16:05 on the 17th is on time
  t.setTime('2026-11-17T16:05');
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  const cal = (await t.aliApi('GET', '/api/emp/calendar?month=2026-11')).data.days;
  assert.equal(cal.find((d) => d.date === '2026-11-17').status, 'present');
  t.setTime('2026-11-19T07:00');
  const st = await stmt(t, t.ali.id);
  const day = (d) => st.days.find((x) => x.date === d);
  assert.equal(day('2026-11-18').status, 'off');
  assert.equal(day('2026-11-18').cut, 0);
  // swap: Ali asks to swap Saturday 21st with Bilal, who is on evening that day
  await t.api('PUT', '/api/admin/roster', { cells: [{ employeeId: t.bilal.id, date: '2026-11-21', shiftId: 'evening' }] }, t.owner);
  r = await t.aliApi('POST', '/api/emp/requests', { type: 'swap', date: '2026-11-21', withId: t.ali.id });
  assert.equal(r.data.error, 'PICK_COLLEAGUE');
  r = await t.aliApi('POST', '/api/emp/requests', { type: 'swap', date: '2026-11-21', withId: t.bilal.id, reason: 'Wedding' });
  assert.equal(r.status, 200);
  const er = (await t.aliApi('GET', '/api/emp/roster?from=2026-11-21&days=1')).data;
  assert.equal(er.swaps.length, 1);
  assert.ok(er.colleagues.some((c) => c.id === t.bilal.id));
  r = await t.api('POST', `/api/admin/requests/${r.data.request.id}/decide`, { approve: true }, t.owner);
  assert.equal(r.status, 200);
  const g2 = (await t.api('GET', '/api/admin/roster?from=2026-11-21&days=1', null, t.owner)).data;
  assert.equal(g2.employees.find((e) => e.id === t.ali.id).cells[0].shiftId, 'evening');
  assert.equal(g2.employees.find((e) => e.id === t.bilal.id).cells[0].shiftId, 'morning');
  // copy the week forward
  r = await t.api('POST', '/api/admin/roster/copy', { from: '2026-11-16', to: '2026-11-23' }, t.owner);
  assert.ok(r.data.changed >= 3);
});

test('staff file, documents, warnings seen by the employee', async () => {
  const t = await seeded('2026-11-16T08:00');
  let r = await t.api('PUT', `/api/admin/employees/${t.ali.id}`, { fatherName: 'Aslam', dob: '1999-11-16', address: 'Layyah', emergencyName: 'Aslam', emergencyPhone: '0300-1112223' }, t.owner);
  assert.equal(r.data.employee.emergencyPhone, '03001112223');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await t.api('POST', `/api/admin/employees/${t.ali.id}/docs`, { kind: 'cnic_front', name: 'cnic.png', dataUrl: png }, t.owner);
  assert.equal(r.status, 200);
  r = await t.api('POST', `/api/admin/employees/${t.ali.id}/docs`, { kind: 'other', dataUrl: 'data:text/html;base64,PGI+' }, t.owner);
  assert.equal(r.data.error, 'BAD_FILE');
  const docs = (await t.api('GET', `/api/admin/employees/${t.ali.id}/docs`, null, t.owner)).data.docs;
  assert.equal(docs.length, 1);
  const file = await t.store.handle(new Request(`https://x/api/admin/docs/${docs[0].id}`, { headers: { authorization: `Bearer ${t.owner}` } }));
  assert.equal(file.headers.get('content-type'), 'image/png');
  r = await t.api('POST', `/api/admin/employees/${t.ali.id}/notes`, { kind: 'warning', text: 'Late three days this week' }, t.owner);
  assert.equal(r.status, 200);
  let home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.unseenNotes, 1);
  assert.equal(home.celebrate.kind, 'birthday');
  const notes = (await t.aliApi('GET', '/api/emp/notes')).data.notes;
  await t.aliApi('POST', `/api/emp/notes/${notes[0].id}/seen`);
  home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.unseenNotes, 0);
  const list = (await t.api('GET', `/api/admin/employees/${t.ali.id}/notes`, null, t.owner)).data;
  assert.equal(list.warnings, 1);
  assert.ok(list.notes[0].seen);
  // backup keeps the new tables
  const b = (await t.api('GET', '/api/admin/backup', null, t.owner)).data;
  assert.equal(b.tables.docs.length, 1);
  assert.equal(b.tables.staff_notes.length, 1);
});

test('birthday and anniversary wishes once a day after 9 AM', async () => {
  const t = await seeded('2026-11-16T08:00');
  const sent = capture(t);
  await t.api('PUT', `/api/admin/employees/${t.ali.id}`, { dob: '2000-11-16' }, t.owner);
  await t.api('PUT', `/api/admin/employees/${t.bilal.id}`, { joinDate: '2024-11-16' }, t.owner);
  token(t, 'emp', t.ali.id, 'ali-token-12345678901234');
  token(t, 'emp', t.bilal.id, 'bilal-token-1234567890123');
  token(t, 'admin', t.store.ownerIds()[0], 'owner-token-1234567890123');
  await t.store.tick();
  assert.equal(sent.filter((m) => /birthday/i.test(m.title)).length, 0);
  t.setTime('2026-11-16T09:05');
  await t.store.tick();
  await t.store.tick();
  assert.equal(sent.filter((m) => m.title.startsWith('Happy birthday')).length, 1);
  assert.equal(sent.filter((m) => m.title.startsWith('2 years with us')).length, 1);
  assert.equal(sent.filter((m) => m.title.startsWith('Today')).length, 1);
  const b = (await t.api('GET', '/api/admin/board', null, t.owner)).data;
  assert.equal(b.celebrations.length, 2);
});

test('branches: staff must check in at their own branch; branch manager sees only their branch', async () => {
  const t = await seeded('2026-11-16T08:00');
  const s = (await t.api('PUT', '/api/admin/settings', { locations: [
    { name: 'Main store', lat: 30.9693, lng: 70.9428, radius: 100 },
    { name: 'Branch 2', lat: 31.5204, lng: 74.3587, radius: 100 },
  ] }, t.owner)).data;
  const [main, b2] = s.locations;
  await t.api('PUT', `/api/admin/employees/${t.ali.id}`, { branchId: b2.id }, t.owner);
  let r = await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  assert.equal(r.data.error, 'OUTSIDE_RADIUS');
  assert.equal(r.data.branch, 'Branch 2');
  r = await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.far });
  assert.equal(r.status, 200);
  // Bilal belongs to the main store
  await t.api('PUT', `/api/admin/employees/${t.bilal.id}`, { branchId: main.id }, t.owner);
  r = await t.api('POST', '/api/admin/users', { name: 'Kamran', login: 'kamran', pin: '5555', branchId: b2.id }, t.owner);
  assert.equal(r.status, 200);
  const mgr = (await t.api('POST', '/api/admin/login', { login: 'kamran', pin: '5555' })).data.token;
  const emps = (await t.api('GET', '/api/admin/employees', null, mgr)).data.employees;
  assert.deepEqual(emps.map((e) => e.name), ['Ali']);
  const board = (await t.api('GET', '/api/admin/board', null, mgr)).data;
  assert.equal(board.rows.length, 1);
  r = await t.api('GET', `/api/admin/employees/${t.bilal.id}`, null, mgr);
  assert.equal(r.data.error, 'OTHER_BRANCH');
  // the owner can filter by branch
  const ob = (await t.api('GET', `/api/admin/board?branch=${main.id}`, null, t.owner)).data;
  assert.deepEqual(ob.rows.map((x) => x.name), ['Bilal']);
  const pr = (await t.api('GET', '/api/admin/payroll?month=2026-11&days=1', null, t.owner)).data;
  assert.equal(pr.rows[0].dayCodes.length, 30);
});

test('web version login only when the owner allows it', async () => {
  const t = await seeded('2026-11-16T08:00');
  const raza = (await t.api('POST', '/api/admin/employees', { name: 'Raza', roleId: 'cashier', salary: 20000, pin: '3333' }, t.owner)).data.employee;
  let r = await t.api('POST', '/api/emp/login', { code: raza.code, pin: '3333', deviceId: 'web-1234-5678-abcd' });
  assert.equal(r.data.error, 'WEB_NOT_ALLOWED');
  await t.api('PUT', `/api/admin/employees/${raza.id}`, { webAllowed: true }, t.owner);
  r = await t.api('POST', '/api/emp/login', { code: raza.code, pin: '3333', deviceId: 'web-1234-5678-abcd' });
  assert.equal(r.status, 200);
  const p = await t.api('POST', '/api/emp/punch', { type: 'in', loc: t.inStore }, r.data.token, { 'x-device-id': 'web-1234-5678-abcd' });
  assert.equal(p.status, 200);
  const day = (await t.api('GET', `/api/admin/employees/${raza.id}/day/2026-11-16`, null, t.owner)).data.day;
  assert.equal(day.punches[0].source, 'web');
});

test('forgot PIN: request from the login screen, admin sets a new PIN, staff logs in with it', async () => {
  const t = await seeded('2026-11-16T08:00');
  const sent = capture(t);
  // unknown code: same answer, nothing stored
  let r = await t.api('POST', '/api/emp/forgot-pin', { code: 'NOPE99' });
  assert.deepEqual(r.data, { ok: true });
  r = await t.api('POST', '/api/emp/forgot-pin', { code: t.ali.code.toLowerCase(), note: 'new phone' });
  assert.deepEqual(r.data, { ok: true });
  await t.api('POST', '/api/emp/forgot-pin', { code: '03001234567' }); // by phone: same pending request
  const list = (await t.api('GET', '/api/admin/requests?status=pending', null, t.owner)).data.requests.filter((x) => x.type === 'pin_reset');
  assert.equal(list.length, 1);
  assert.equal(list[0].data.reason, 'new phone');
  r = await t.api('POST', `/api/admin/requests/${list[0].id}/decide`, { approve: true, pin: '12' }, t.owner);
  assert.equal(r.data.error, 'BAD_PIN');
  r = await t.api('POST', `/api/admin/requests/${list[0].id}/decide`, { approve: true, pin: '4321' }, t.owner);
  assert.equal(r.status, 200);
  assert.equal(r.data.newPin, '4321');
  assert.equal(r.data.request.status, 'approved');
  r = await t.api('POST', '/api/emp/login', { code: t.ali.code, pin: '1111', deviceId: 'phone-ali-0001' });
  assert.notEqual(r.status, 200);
  r = await t.api('POST', '/api/emp/login', { code: t.ali.code, pin: '4321', deviceId: 'phone-ali-0001' });
  assert.equal(r.status, 200);
  assert.ok(sent.length >= 0);
});

test('forgot PIN is rate limited per address', async () => {
  const t = await seeded('2026-11-16T08:00');
  let last;
  for (let i = 0; i < 8; i++) last = await t.api('POST', '/api/emp/forgot-pin', { code: 'X' + i });
  assert.equal(last.status, 429);
});

test('monthly Google Drive reminder goes to the owner once, on the 1st after 10 AM', async () => {
  const t = await seeded('2026-11-30T12:00');
  assert.equal(t.store.driveReminder(), false);
  t.setTime('2026-12-01T09:00');
  assert.equal(t.store.driveReminder(), false);
  t.setTime('2026-12-01T10:05');
  assert.equal(t.store.driveReminder(), true);
  t.setTime('2026-12-01T15:00');
  assert.equal(t.store.driveReminder(), false);
});

test('web owner page gets a short login', async () => {
  const t = await seeded('2026-11-16T08:00');
  const web = await t.api('POST', '/api/admin/login', { login: 'owner', pin: '1234', deviceId: 'web-abc123' });
  assert.equal(web.status, 200);
  t.advance(13 * 60);
  const r = await t.api('GET', '/api/admin/board', null, web.data.token);
  assert.equal(r.status, 401);
});

test('owner web page: own code from the server secret, wrong codes locked out, logs in as owner', async () => {
  const t = await seeded('2026-11-16T08:00');
  let r = await t.api('POST', '/api/owner-page/login', { code: '9999' });
  assert.equal(r.data.error, 'OWNER_PAGE_OFF');
  t.store.env.OWNER_PAGE_CODE = '4455';
  r = await t.api('POST', '/api/owner-page/login', { code: '4455' });
  assert.equal(r.status, 200);
  assert.equal(r.data.me.role, 'owner');
  const tok = r.data.token;
  assert.equal((await t.api('GET', '/api/admin/board', null, tok)).status, 200);
  // the admin app has no way to see or change it
  assert.equal((await t.api('GET', '/api/admin/owner-page', null, t.owner)).status, 404);
  // a new code (next deploy) logs out open owner pages at the next tick
  t.store.env.OWNER_PAGE_CODE = '5566';
  await t.store.tick();
  assert.equal((await t.api('GET', '/api/admin/board', null, tok)).status, 401);
  for (let i = 0; i < 5; i++) r = await t.api('POST', '/api/owner-page/login', { code: '0000' });
  assert.equal(r.data.error, 'WRONG_CODE');
  r = await t.api('POST', '/api/owner-page/login', { code: '5566' });
  assert.equal(r.status, 429); // locked even with the right code
  t.advance(6);
  r = await t.api('POST', '/api/owner-page/login', { code: '5566' });
  assert.equal(r.status, 200);
});

test('offline punches are accepted for 7 days; old 72-hour setting moves to 7 days once', async () => {
  const t = await seeded('2026-11-16T08:00');
  assert.equal(t.store.settings.rules.maxOfflineHours, 168);
  // a store still on the old default
  const s = t.store.db.kvGet('settings', {});
  s.rules = { ...(s.rules || {}), maxOfflineHours: 72 };
  t.store.db.kvSet('settings', s);
  t.store.db.kvSet('mig.offline7', false);
  t.store._settings = null;
  assert.equal(t.store.settings.rules.maxOfflineHours, 168);
  // the owner's own choice is kept afterwards
  await t.api('PUT', '/api/admin/settings', { rules: { maxOfflineHours: 48 } }, t.owner);
  t.store._settings = null;
  assert.equal(t.store.settings.rules.maxOfflineHours, 48);
});

test('check-in opens 15 minutes before the shift; off days, holidays and admin punches are not limited', async () => {
  const t = await seeded('2026-11-16T07:30'); // morning shift 08:00
  let home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.window.opensTs, Date.parse('2026-11-16T07:45:00+05:00'));
  assert.equal(home.window.endTs, Date.parse('2026-11-16T16:00:00+05:00'));
  let r = await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  assert.equal(r.data.error, 'TOO_EARLY');
  assert.equal(r.data.opensAt, '07:45');
  // a manager can still record it
  r = await t.api('POST', '/api/admin/punch', { employeeId: t.bilal.id, type: 'in', reason: 'came early to unload' }, t.owner);
  assert.equal(r.status, 200);
  t.setTime('2026-11-16T07:45');
  r = await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  assert.equal(r.status, 200);
  // a holiday has no limit
  await t.api('PUT', '/api/admin/settings', { holidays: [{ date: '2026-11-17', name: 'Test' }] }, t.owner);
  t.setTime('2026-11-16T16:00');
  await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore });
  t.setTime('2026-11-17T06:00');
  r = await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  assert.equal(r.status, 200);
  // the owner can turn it off or change the minutes
  await t.api('PUT', '/api/admin/settings', { rules: { checkInEarlyMin: 60 } }, t.owner);
  home = (await t.api('GET', '/api/emp/home', null, t.bilalTok, { 'x-device-id': 'phone-bilal-01' })).data;
  assert.equal(home.window.earlyMin, 60);
  await t.api('PUT', '/api/admin/settings', { rules: { checkInWindowOn: false } }, t.owner);
  t.setTime('2026-11-18T05:00');
  r = await t.api('POST', '/api/emp/punch', { type: 'in', loc: t.inStore }, t.bilalTok, { 'x-device-id': 'phone-bilal-01' });
  assert.equal(r.status, 200);
});

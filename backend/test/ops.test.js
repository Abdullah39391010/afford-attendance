import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seeded } from './helpers.js';

const capture = (t) => {
  const sent = [];
  t.store.pushSender = async (msgs) => { sent.push(...msgs); return []; };
  return sent;
};
const token = (t, kind, sub, tk) => t.store.db.run("INSERT INTO push_tokens (token, kind, sub, lang, updated) VALUES (?, ?, ?, 'en', 0)", tk, kind, sub);

test('reminders: shift starts soon, forgot to check out; sent once', async () => {
  const t = await seeded('2026-11-16T07:40');
  const sent = capture(t);
  token(t, 'emp', t.ali.id, 'ali-token-12345678901234');
  await t.store.tick();
  assert.equal(sent.length, 0); // 20 min before: not yet
  t.setTime('2026-11-16T07:47');
  await t.store.tick();
  await t.store.tick();
  assert.equal(sent.filter((m) => m.title === 'Your shift starts soon').length, 1);
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  t.setTime('2026-11-16T16:40');
  await t.store.tick();
  await t.store.tick();
  assert.equal(sent.filter((m) => m.title === 'Forgot to check out?').length, 1);
  // Friday is the weekly off: no reminder
  t.setTime('2026-11-20T07:50');
  await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore }).catch(() => {});
  const before = sent.length;
  await t.store.tick();
  assert.equal(sent.filter((m) => m.title === 'Your shift starts soon').length, 1);
  assert.ok(sent.length >= before);
});

test('nightly summary goes to the owner once', async () => {
  const t = await seeded('2026-11-16T08:00');
  const sent = capture(t);
  token(t, 'admin', t.store.ownerIds()[0], 'owner-token-1234567890123');
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  t.setTime('2026-11-16T21:00');
  await t.store.tick();
  assert.equal(sent.filter((m) => m.title.startsWith("Today's attendance")).length, 0);
  t.setTime('2026-11-16T22:05');
  await t.store.tick();
  await t.store.tick();
  const s = sent.filter((m) => m.title.startsWith("Today's attendance"));
  assert.equal(s.length, 1);
  assert.match(s[0].body, /Present 1/);
  assert.match(s[0].body, /Not checked out 1/);
});

test('overtime is paid when switched on', async () => {
  const t = await seeded('2026-11-16T08:00');
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  t.setTime('2026-11-16T17:00');
  await t.aliApi('POST', '/api/emp/punch', { type: 'out', loc: t.inStore });
  let st = (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-11`, null, t.owner)).data.statement;
  assert.equal(st.overtime.min, 60);
  assert.equal(st.overtime.pay, 0);
  await t.api('PUT', '/api/admin/settings', { rules: { overtimeOn: true, overtimeRate: 1.5 } }, t.owner);
  st = (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-11`, null, t.owner)).data.statement;
  assert.ok(Math.abs(st.overtime.pay - 60 * st.rates.perMinute * 1.5) < 2);
});

test('salary paid record and payslip details', async () => {
  const t = await seeded('2026-11-16T08:00');
  await t.api('PUT', '/api/admin/settings', { storeAddress: 'Main Bazar, Layyah', storePhone: '0300-0000000' }, t.owner);
  const st0 = (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-11`, null, t.owner)).data.statement;
  assert.equal(st0.storeAddress, 'Main Bazar, Layyah');
  assert.equal(st0.slipNo, `${t.ali.code}-202611`);
  const p = (await t.api('POST', '/api/admin/payments', { employeeId: t.ali.id, month: '2026-11', method: 'bank' }, t.owner)).data;
  assert.equal(p.amount, st0.net);
  const all = (await t.api('GET', '/api/admin/payroll?month=2026-11', null, t.owner)).data;
  assert.equal(all.rows.find((r) => r.employee.id === t.ali.id).paid, st0.net);
  assert.equal(all.totals.unpaid, 1); // Bilal not paid
  await t.api('POST', `/api/admin/payments/${p.id}/void`, {}, t.owner);
  assert.equal((await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-11`, null, t.owner)).data.statement.paid, 0);
});

test('advance in installments is cut over several months', async () => {
  const t = await seeded('2026-11-16T08:00');
  const r = (await t.api('POST', '/api/admin/money', { employeeId: t.ali.id, kind: 'advance', amount: 10000, installments: 3, month: '2026-11' }, t.owner)).data;
  assert.equal(r.ids.length, 3);
  const adv = async (m) => (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=${m}`, null, t.owner)).data.statement.advances;
  assert.equal(await adv('2026-11'), 3333);
  assert.equal(await adv('2026-12'), 3333);
  assert.equal(await adv('2027-01'), 3334);
});

test('final settlement: last day, remaining advances, deposit returned, staff made inactive', async () => {
  const t = await seeded('2026-11-16T08:00');
  await t.api('POST', '/api/admin/money', { employeeId: t.ali.id, kind: 'deposit', amount: 5000 }, t.owner);
  await t.api('POST', '/api/admin/money', { employeeId: t.ali.id, kind: 'advance', amount: 6000, installments: 3, month: '2026-11' }, t.owner);
  const s = (await t.api('GET', `/api/admin/employees/${t.ali.id}/settlement?lastDay=2026-11-16`, null, t.owner)).data;
  assert.equal(s.laterAdvances, 4000);
  assert.equal(s.depositBalance, 5000);
  assert.equal(s.statement.counts.left, 14); // 17th to 30th
  assert.equal(s.total, Math.round(s.statement.net - 4000 + 5000));
  const r = (await t.api('POST', `/api/admin/employees/${t.ali.id}/settle`, { lastDay: '2026-11-16', note: 'Moved city' }, t.owner)).data;
  assert.equal(r.ok, true);
  const list = (await t.api('GET', '/api/admin/employees?all=1', null, t.owner)).data.employees;
  const ali = list.find((x) => x.id === t.ali.id);
  assert.equal(ali.active, false);
  assert.equal(ali.leaveDate, '2026-11-16');
  // still shows in this month's payroll with all advances cut now
  const all = (await t.api('GET', '/api/admin/payroll?month=2026-11', null, t.owner)).data;
  assert.equal(all.rows.find((x) => x.employee.id === t.ali.id).advances, 6000);
  // phone is logged out
  assert.equal((await t.aliApi('GET', '/api/emp/home')).status, 401);
});

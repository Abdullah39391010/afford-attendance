import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seeded } from './helpers.js';
import { memoryVault } from '../src/lib/pro.js';

async function withManager(t) {
  await t.api('POST', '/api/admin/users', { name: 'Usman', login: 'usman', pin: '5555', role: 'manager',
    perms: ['employees.view', 'employees.edit', 'payroll.view', 'money.edit', 'requests.decide', 'attendance.punch'] }, t.owner);
  return (await t.api('POST', '/api/admin/login', { login: 'usman', pin: '5555' })).data.token;
}

test('cloud backup: daily once, list, download, restore, old ones removed', async () => {
  const t = await seeded('2026-11-16T10:00');
  t.store.vault = memoryVault();
  const first = await t.store.dailyCloudBackup();
  assert.ok(first.name.startsWith('afford-backup-2026-11-16'));
  assert.equal(await t.store.dailyCloudBackup(), null); // same day: nothing
  let list = (await t.api('GET', '/api/admin/cloud-backups', null, t.owner)).data;
  assert.equal(list.backups.length, 1);
  const got = (await t.api('GET', `/api/admin/cloud-backups/${first.name}`, null, t.owner)).data;
  assert.equal((typeof got === 'string' ? JSON.parse(got) : got).format, 'afford-backup');
  // data changes, then restore from the cloud copy
  await t.api('POST', '/api/admin/employees', { name: 'Extra', salary: 1, pin: '7777' }, t.owner);
  assert.equal((await t.api('POST', `/api/admin/cloud-backups/${first.name}/restore`, { pin: '0000' }, t.owner)).status, 401);
  assert.equal((await t.api('POST', `/api/admin/cloud-backups/${first.name}/restore`, { pin: '1234' }, t.owner)).data.ok, true);
  assert.equal((await t.api('GET', '/api/admin/employees', null, t.owner)).data.employees.length, 2);
  // manager cannot see cloud backups
  const m = await withManager(t);
  assert.equal((await t.api('GET', '/api/admin/cloud-backups', null, m)).status, 403);
});

test('staff must accept the rules; changing them asks again', async () => {
  const t = await seeded('2026-11-16T10:00');
  let home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.policy.needed, true);
  assert.ok(home.policy.en.length > 5 && home.policy.ur.length > 5);
  assert.equal((await t.aliApi('POST', '/api/emp/policy/accept', { ver: 99 })).data.error, 'POLICY_CHANGED');
  await t.aliApi('POST', '/api/emp/policy/accept', { ver: home.policy.ver });
  home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.policy.needed, false);
  let p = (await t.api('GET', '/api/admin/policy', null, t.owner)).data;
  assert.equal(p.staff.find((s) => s.id === t.ali.id).current, true);
  assert.equal(p.staff.find((s) => s.id === t.bilal.id).current, false);
  p = (await t.api('PUT', '/api/admin/policy', { extraEn: 'No mobile phone use at the counter.' }, t.owner)).data;
  assert.ok(p.en.includes('No mobile phone use at the counter.'));
  home = (await t.aliApi('GET', '/api/emp/home')).data;
  assert.equal(home.policy.needed, true);
});

test('manager money and salary changes wait for the owner', async () => {
  const t = await seeded('2026-11-16T10:00');
  const m = await withManager(t);
  // bonus by manager is not counted until approved
  const add = (await t.api('POST', '/api/admin/money', { employeeId: t.ali.id, kind: 'bonus', amount: 2000 }, m)).data;
  assert.equal(add.pendingOwner, true);
  let st = (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-11`, null, t.owner)).data.statement;
  assert.equal(st.bonus, 0);
  assert.equal((await t.api('GET', '/api/admin/changes', null, t.owner)).data.ownerPending, 1);
  let ap = (await t.api('GET', '/api/admin/approvals', null, t.owner)).data.approvals;
  assert.equal(ap.length, 1);
  assert.equal((await t.api('GET', '/api/admin/approvals', null, m)).status, 403);
  await t.api('POST', `/api/admin/approvals/${ap[0].id}/decide`, { approve: true }, t.owner);
  st = (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-11`, null, t.owner)).data.statement;
  assert.equal(st.bonus, 2000);
  // removing it also needs the owner
  assert.equal((await t.api('POST', `/api/admin/money/${add.id}/void`, {}, m)).data.pendingOwner, true);
  ap = (await t.api('GET', '/api/admin/approvals', null, t.owner)).data.approvals;
  await t.api('POST', `/api/admin/approvals/${ap[0].id}/decide`, { approve: false }, t.owner);
  st = (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-11`, null, t.owner)).data.statement;
  assert.equal(st.bonus, 2000);
  // salary change by manager
  const r = (await t.api('PUT', `/api/admin/employees/${t.ali.id}`, { salary: 50000 }, m)).data;
  assert.equal(r.salaryPendingOwner, true);
  assert.equal(r.employee.salary, 26000);
  assert.equal((await t.api('GET', `/api/admin/employees/${t.ali.id}`, null, m)).data.employee.salaryPending, 50000);
  ap = (await t.api('GET', '/api/admin/approvals', null, t.owner)).data.approvals;
  await t.api('POST', `/api/admin/approvals/${ap[0].id}/decide`, { approve: true }, t.owner);
  assert.equal((await t.api('GET', `/api/admin/employees/${t.ali.id}`, null, t.owner)).data.employee.salary, 50000);
  // owner's own changes go straight through
  assert.equal((await t.api('POST', '/api/admin/money', { employeeId: t.ali.id, kind: 'bonus', amount: 100 }, t.owner)).data.pendingOwner, false);
});

test('a locked month keeps its salary and cannot be edited', async () => {
  const t = await seeded('2026-10-10T08:00');
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  t.setTime('2026-11-05T10:00');
  assert.equal((await t.api('POST', '/api/admin/months/2026-11/lock', {}, t.owner)).data.error, 'MONTH_NOT_OVER');
  const before = (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-10`, null, t.owner)).data.statement;
  assert.equal((await t.api('POST', '/api/admin/months/2026-10/lock', {}, t.owner)).data.locked, true);
  // salary change does not touch the locked statement
  await t.api('PUT', `/api/admin/employees/${t.ali.id}`, { salary: 90000 }, t.owner);
  const after = (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-10`, null, t.owner)).data.statement;
  assert.equal(after.net, before.net);
  assert.equal(after.locked, true);
  // edits to October are refused
  assert.equal((await t.api('POST', '/api/admin/mark', { employeeId: t.ali.id, date: '2026-10-12', status: 'leave' }, t.owner)).data.error, 'MONTH_LOCKED');
  assert.equal((await t.api('POST', '/api/admin/punch', { employeeId: t.ali.id, type: 'out', date: '2026-10-10', time: '16:00', reason: 'x' }, t.owner)).data.error, 'MONTH_LOCKED');
  assert.equal((await t.api('POST', '/api/admin/money', { employeeId: t.ali.id, kind: 'bonus', amount: 5, month: '2026-10' }, t.owner)).data.error, 'MONTH_LOCKED');
  // only the owner can unlock
  const m = await withManager(t);
  assert.equal((await t.api('POST', '/api/admin/months/2026-10/lock', { lock: false }, m)).status, 403);
  await t.api('POST', '/api/admin/months/2026-10/lock', { lock: false, reason: 'fix' }, t.owner);
  assert.equal((await t.api('POST', '/api/admin/mark', { employeeId: t.ali.id, date: '2026-10-12', status: 'leave' }, t.owner)).status, 200);
});

test('server errors are logged and the owner is alerted once an hour', async () => {
  const t = await seeded('2026-11-16T10:00');
  const sent = [];
  t.store.pushSender = async (msgs) => { sent.push(...msgs); return []; };
  t.store.db.run("INSERT INTO push_tokens (token, kind, sub, lang, updated) VALUES ('owner-token-1234567890', 'admin', (SELECT id FROM admins WHERE role = 'owner'), 'en', 0)");
  t.store.routes.push({ method: 'GET', re: /^\/api\/boom$/, fn: () => { throw new Error('kaboom'); }, auth: 'none' });
  assert.equal((await t.api('GET', '/api/boom')).status, 500);
  assert.equal((await t.api('GET', '/api/boom')).status, 500);
  const h = (await t.api('GET', '/api/admin/health', null, t.owner)).data;
  assert.equal(h.errors.length, 2);
  assert.match(h.errors[0].msg, /kaboom/);
  assert.equal(sent.filter((m) => m.title === 'Server problem').length, 1);
});

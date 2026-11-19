import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seeded } from './helpers.js';

const SELFIE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const V12 = { 'x-device-id': 'phone-ali-0001', 'x-app-version': 'employee/0.12.0' };

test('selfie: new staff app must send one to check in; it is kept with the punch', async () => {
  const t = await seeded('2026-11-16T08:55');
  const ali = (m, p, b) => t.api(m, p, b, t.aliTok, V12);
  const r1 = await ali('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  assert.equal(r1.status, 400); assert.equal(r1.data.error, 'NEED_SELFIE');
  const r2 = await ali('POST', '/api/emp/punch', { type: 'in', loc: t.inStore, photo: SELFIE });
  assert.equal(r2.status, 200); assert.equal(r2.data.selfie, true);
  const day = (await t.api('GET', `/api/admin/employees/${t.ali.id}/day/2026-11-16`, null, t.owner)).data.day;
  assert.equal(day.punches[0].hasPhoto, true);
  // older app (no version header) still works until it is updated
  const old = await t.bilalApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  assert.equal(old.status, 200);
  // check-out never needs a selfie; rule can be switched off
  t.advance(60);
  assert.equal((await ali('POST', '/api/emp/punch', { type: 'out', loc: t.inStore })).status, 200);
  await t.api('PUT', '/api/admin/settings', { rules: { staffSelfie: false } }, t.owner);
  assert.equal((await t.aliApi('GET', '/api/emp/home')).data.store.rules.staffSelfie, false);
});

test('fake GPS: blocked, written in history, owner told once a day', async () => {
  const t = await seeded('2026-11-16T08:55');
  const sent = [];
  t.store.pushSender = async (msgs) => { sent.push(...msgs); return []; };
  t.store.db.run("INSERT INTO push_tokens (token, kind, sub, lang, updated) VALUES ('owner-token-1234567890123', 'admin', ?, 'en', 0)", t.store.ownerIds()[0]);
  for (let i = 0; i < 2; i++) {
    const r = await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: { ...t.inStore, mock: true } });
    assert.equal(r.data.error, 'MOCK_LOCATION');
  }
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /^Fake GPS · Ali/);
  const log = (await t.api('GET', '/api/admin/audit?kind=security', null, t.owner)).data.entries;
  assert.equal(log.filter((a) => a.action === 'security.fake_gps').length, 2);
});

test('owner dashboard: months, salary cost, most and least punctual', async () => {
  const t = await seeded('2026-11-16T09:20');
  await t.aliApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore }); // 20 min late
  t.setTime('2026-11-16T08:58');
  await t.bilalApi('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  t.setTime('2026-11-16T18:00');
  const d = (await t.api('GET', '/api/admin/dashboard?month=2026-11&months=3', null, t.owner)).data;
  assert.deepEqual(d.months.map((m) => m.month), ['2026-09', '2026-10', '2026-11']);
  const nov = d.months[2];
  assert.ok(nov.lateMin >= 20); assert.equal(nov.staff, 2); assert.ok(nov.salaryCost > 0);
  assert.equal(d.best[0].name, 'Bilal');
  assert.equal(d.worst[0].name, 'Ali');
  // managers without salary access can't see it
  assert.equal((await t.aliApi('GET', '/api/admin/dashboard')).status, 401);
});

test('payslips on WhatsApp: list with phones, remembers who was sent', async () => {
  const t = await seeded('2026-11-16T09:00');
  const l = (await t.api('GET', '/api/admin/payslips/wa?month=2026-11', null, t.owner)).data;
  const ali = l.rows.find((r) => r.name === 'Ali');
  assert.equal(ali.phone, '03001234567'); assert.equal(ali.sentTs, null);
  await t.api('POST', '/api/admin/payslips/wa-sent', { month: '2026-11', employeeId: t.ali.id }, t.owner);
  const l2 = (await t.api('GET', '/api/admin/payslips/wa?month=2026-11', null, t.owner)).data;
  assert.ok(l2.rows.find((r) => r.name === 'Ali').sentTs);
  const hist = (await t.api('GET', '/api/admin/audit?kind=money', null, t.owner)).data.entries;
  assert.ok(hist.some((a) => a.action === 'payroll.payslip_whatsapp'));
  const att = (await t.api('GET', '/api/admin/audit?kind=attendance', null, t.owner)).data.entries;
  assert.ok(att.every((a) => /^(attendance|request|roster)\./.test(a.action)));
});

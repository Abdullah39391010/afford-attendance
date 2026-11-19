import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seeded } from './helpers.js';

const V = { 'x-device-id': 'phone-ali-0001', 'x-app-version': 'employee/0.11.0' }; // no selfie needed in tests

async function setup(t) {
  const ali = (m, p, b) => t.api(m, p, b, t.aliTok, V);
  const r = await ali('POST', '/api/emp/requests', { type: 'short_leave', date: '2026-11-16', from: '12:00', to: '13:00', reason: 'Doctor' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.request?.id || r.data.id;
  const d = await t.api('POST', `/api/admin/requests/${id}/decide`, { approve: true }, t.owner);
  assert.equal(d.status, 200, JSON.stringify(d.data));
  return ali;
}
const statement = async (t) => (await t.api('GET', `/api/admin/payroll/${t.ali.id}?month=2026-11`, null, t.owner)).data.statement;

test('short leave: back within 1 hour = no cut, no late, no "check in again" request needed', async () => {
  const t = await seeded('2026-11-16T07:58');
  const ali = await setup(t);
  assert.equal((await ali('POST', '/api/emp/punch', { type: 'in', loc: t.inStore })).status, 200);
  t.advance(4 * 60 + 2); // 12:00
  assert.equal((await ali('POST', '/api/emp/punch', { type: 'out', loc: t.inStore })).status, 200);
  t.advance(55); // back 12:55
  const back = await ali('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  t.advance(3 * 60 + 6); // 16:01
  await ali('POST', '/api/emp/punch', { type: 'out', loc: t.inStore });
  const day = (await t.api('GET', `/api/admin/employees/${t.ali.id}/day/2026-11-16`, null, t.owner)).data.day;
  assert.equal(day.lateMin, 0);
  assert.equal(day.shortLeave.min, 55);
  assert.equal(day.shortLeave.over, false);
  const st = await statement(t);
  assert.equal(st.cuts.shortLeave, 0);
  assert.equal(st.counts.shortLeave, 1);
});

test('short leave: away more than 1 hour = half day cut (and never back = half day too)', async () => {
  const t = await seeded('2026-11-16T07:58');
  const ali = await setup(t);
  await ali('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  t.advance(4 * 60 + 2);
  await ali('POST', '/api/emp/punch', { type: 'out', loc: t.inStore });
  t.advance(80); // back 13:20
  await ali('POST', '/api/emp/punch', { type: 'in', loc: t.inStore });
  t.advance(2 * 60 + 41);
  await ali('POST', '/api/emp/punch', { type: 'out', loc: t.inStore });
  const st = await statement(t);
  const daily = st.rates?.daily ?? 26000 / 26;
  assert.equal(st.counts.shortLeaveOver, 1);
  assert.equal(Math.round(st.cuts.shortLeave), Math.round(daily / 2));
  assert.equal(st.cuts.late, 0); // the 80 minutes away are not late minutes
});

test('short leave: times must be inside the shift and in order', async () => {
  const t = await seeded('2026-11-16T07:58');
  const ali = (m, p, b) => t.api(m, p, b, t.aliTok, V);
  assert.equal((await ali('POST', '/api/emp/requests', { type: 'short_leave', date: '2026-11-16', from: '13:00', to: '12:00' })).data.error, 'BAD_TIME');
  assert.equal((await ali('POST', '/api/emp/requests', { type: 'short_leave', date: '2026-11-16', from: '20:00', to: '21:00' })).data.error, 'BAD_TIME');
});

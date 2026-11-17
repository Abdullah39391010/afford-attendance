// Test harness: runs the real Store on Node's built-in SQLite with a controllable clock.
import { DatabaseSync } from 'node:sqlite';
import { DB } from '../src/lib/db.js';
import { Store } from '../src/lib/store.js';

class NodeSql {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }
  exec(sql, ...params) {
    const st = this.db.prepare(sql);
    let rows;
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /RETURNING/i.test(sql)) rows = st.all(...params);
    else {
      st.run(...params);
      rows = [];
    }
    return { toArray: () => rows.map((r) => ({ ...r })) };
  }
}

/** PKT (UTC+5) wall clock -> UTC ms */
export const pkt = (s) => Date.parse(`${s}:00+05:00`);

export async function makeStore(startAt = '2026-11-16T07:00') {
  let now = pkt(startAt);
  const store = new Store(new DB(new NodeSql()), { SETUP_CODE: 'setup123', PIN_PEPPER: 'pepper' }, () => now);
  const api = async (method, path, body, token, headers = {}) => {
    const res = await store.handle(new Request(`https://x${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }));
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  const t = {
    store,
    api,
    setTime: (s) => { now = pkt(s); },
    advance: (min) => { now += min * 60000; },
    now: () => now,
  };
  return t;
}

/** Store with owner, a location, and two employees bound to phones. */
export async function seeded(startAt) {
  const t = await makeStore(startAt);
  const setup = await t.api('POST', '/api/setup', { setupCode: 'setup123', name: 'Abdullah', login: 'owner', pin: '1234' });
  t.owner = setup.data.token;
  await t.api('PUT', '/api/admin/settings', {
    locations: [{ name: 'Main store', lat: 30.9693, lng: 70.9428, radius: 100 }],
  }, t.owner);
  const mk = async (body) => (await t.api('POST', '/api/admin/employees', body, t.owner)).data.employee;
  t.ali = await mk({ name: 'Ali', roleId: 'cashier', shiftId: 'morning', salary: 26000, pin: '1111', phone: '03001234567' });
  t.bilal = await mk({ name: 'Bilal', roleId: 'delivery', shiftId: 'morning', salary: 30000, pin: '2222' });
  t.aliTok = (await t.api('POST', '/api/emp/login', { code: t.ali.code, pin: '1111', deviceId: 'phone-ali-0001' })).data.token;
  t.bilalTok = (await t.api('POST', '/api/emp/login', { code: t.bilal.code, pin: '2222', deviceId: 'phone-bilal-01' })).data.token;
  t.inStore = { lat: 30.9694, lng: 70.9429, acc: 10 };
  t.far = { lat: 31.5204, lng: 74.3587, acc: 10 }; // Lahore
  t.emp = (tok, dev) => (m, p, b) => t.api(m, p, b, tok, { 'x-device-id': dev });
  t.aliApi = t.emp(t.aliTok, 'phone-ali-0001');
  t.bilalApi = t.emp(t.bilalTok, 'phone-bilal-01');
  return t;
}

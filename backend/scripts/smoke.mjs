// End-to-end smoke test against a running worker (local `wrangler dev` or the deployed URL).
// Usage: node scripts/smoke.mjs http://localhost:8787 <setupCode>
// It creates sample data, so only run it against a fresh/local store.
const base = process.argv[2] || 'http://localhost:8787';
const setupCode = process.argv[3] || 'dev-setup';
let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
async function api(method, path, body, token, headers = {}) {
  const t0 = Date.now();
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, ms: Date.now() - t0, cors: res.headers.get('access-control-allow-origin') };
}

const info = await api('GET', '/api/info');
ok(info.status === 200 && info.cors === '*', `info + CORS (${info.ms} ms)`);
let owner;
if (!info.data.setupDone) {
  const s = await api('POST', '/api/setup', { setupCode, name: 'Owner', login: 'owner', pin: '1234' });
  ok(s.status === 200, `owner setup (${s.ms} ms)`);
  owner = s.data.token;
} else {
  const l = await api('POST', '/api/admin/login', { login: 'owner', pin: '1234' });
  ok(l.status === 200, `owner login (${l.ms} ms)`);
  owner = l.data.token;
}
const st = await api('PUT', '/api/admin/settings', { locations: [{ name: 'Main', lat: 30.9693, lng: 70.9428, radius: 100 }], rules: { breakNeedsApproval: true } }, owner);
ok(st.status === 200, 'save store location');
const code = `S${Date.now() % 100000}`;
const e = await api('POST', '/api/admin/employees', { code, name: 'Smoke Test', roleId: 'cashier', salary: 26000, pin: '1111' }, owner);
ok(e.status === 200, `add employee (${e.ms} ms)`);
const dev = `smoke-${code}`;
const lg = await api('POST', '/api/emp/login', { code, pin: '1111', deviceId: dev });
ok(lg.status === 200, `employee login + phone binding (${lg.ms} ms)`);
const H = { 'x-device-id': dev };
const tok = lg.data.token;
const out = await api('POST', '/api/emp/punch', { type: 'in', loc: { lat: 31.52, lng: 74.35 } }, tok, H);
ok(out.data.error === 'OUTSIDE_RADIUS', 'check-in refused far from store');
const pin = await api('POST', '/api/emp/punch', { type: 'in', loc: { lat: 30.9694, lng: 70.9429, acc: 8 }, clientId: 'c1' }, tok, H);
ok(pin.status === 200, `check-in inside store (${pin.ms} ms)`);
const br = await api('POST', '/api/emp/requests', { type: 'break', minutes: 15 }, tok, H);
ok(br.status === 200 && br.data.request?.status === 'pending', 'break request');
const dec = await api('POST', `/api/admin/requests/${br.data.request.id}/decide`, { approve: true }, owner);
ok(dec.status === 200 && dec.data.break, 'approve break');
const board = await api('GET', '/api/admin/board', null, owner);
ok(board.status === 200 && board.data.counts.break >= 1, `live board (${board.ms} ms)`);
ok((await api('POST', '/api/emp/break/end', {}, tok, H)).status === 200, 'resume from break');
const home = await api('GET', '/api/emp/home', null, tok, H);
ok(home.status === 200 && home.data.today.isOpen, `employee home (${home.ms} ms)`);
const pay = await api('GET', '/api/admin/payroll', null, owner);
ok(pay.status === 200 && pay.data.rows.length >= 1, `payroll for all (${pay.ms} ms)`);
const csv = await api('GET', '/api/admin/reports?type=monthly&format=csv&view=summary', null, owner);
ok(csv.status === 200 && String(csv.data).includes('Smoke Test'), 'monthly CSV');
const wrong = [];
for (let i = 0; i < 6; i++) wrong.push((await api('POST', '/api/emp/login', { code, pin: '0000', deviceId: dev })).status);
ok(wrong.includes(429), 'wrong PIN lock-out');
const aud = await api('GET', '/api/admin/audit?limit=5', null, owner);
ok(aud.status === 200 && aud.data.entries.length === 5, 'audit log');
await api('DELETE', `/api/admin/employees/${e.data.employee.id}`, null, owner);
console.log(fails ? `\n${fails} FAILED` : '\nAll smoke checks passed');
process.exit(fails ? 1 : 0);

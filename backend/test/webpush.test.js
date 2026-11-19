import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { seeded } from './helpers.js';

const b64u = (b) => Buffer.from(b).toString('base64url');

/** A fake browser: its own P-256 key and auth secret, like PushManager.subscribe() gives. */
function fakeBrowser(endpoint) {
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return { ecdh, auth, sub: { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } } };
}

/** RFC 8291 decrypt, written with node:crypto (separately from the server code). */
function decrypt(br, body) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idlen = buf[20];
  const asPub = buf.subarray(21, 21 + idlen);
  const ct = buf.subarray(21 + idlen);
  const shared = br.ecdh.computeSecret(asPub);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), br.ecdh.getPublicKey(), asPub]);
  const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, br.auth, info, 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2);
  return JSON.parse(pt.subarray(0, pt.length - 1).toString());
}

test('web push (iPhone): subscribe, alert arrives encrypted and signed, dead ones removed', async () => {
  const t = await seeded('2026-11-16T08:55');
  const key = (await t.api('GET', '/api/push/web-key')).data.key;
  assert.equal(Buffer.from(key, 'base64url').length, 65);
  assert.equal((await t.api('GET', '/api/push/web-key')).data.key, key); // kept, not made again

  const br = fakeBrowser('https://web.push.apple.com/QabcDEF123');
  const r = await t.aliApi('POST', '/api/emp/web-push', { subscription: br.sub, lang: 'en' });
  assert.equal(r.status, 200);
  assert.match(r.data.token, /^web:/);

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('', { status: calls.length > 1 ? 410 : 201 }); };
  try {
    const res = await t.aliApi('POST', '/api/emp/push-test', {});
    assert.equal(res.data.configured, true);
    assert.equal(res.data.results[0].status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, br.sub.endpoint);
    const h = calls[0].init.headers;
    assert.equal(h['content-encoding'], 'aes128gcm');
    const msg = decrypt(br, calls[0].init.body);
    assert.match(msg.title, /Alerts are on/);

    // VAPID: JWT signed by the server key, for the push service's origin
    const m = h.authorization.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
    assert.ok(m);
    assert.equal(m[4], key);
    const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
    assert.equal(claims.aud, 'https://web.push.apple.com');
    const pub = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(Buffer.from(key, 'base64url').subarray(1, 33)), y: b64u(Buffer.from(key, 'base64url').subarray(33)) }, format: 'jwk' });
    assert.ok(nodeCrypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));

    // the browser unsubscribed (410): it is removed
    await t.aliApi('POST', '/api/emp/push-test', {});
    assert.equal(t.store.db.all("SELECT token FROM push_tokens WHERE token LIKE 'web:%'").length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// iPhone (and any browser) alerts through Web Push, for the web versions at /staff/ and /owner/.
//  - The server makes its own VAPID key pair once and keeps it (no secret to set up).
//  - A browser subscription is saved in push_tokens as token "web:<hash>"; its endpoint and keys live in web_subs.
//  - Messages are encrypted as RFC 8291 (aes128gcm) and signed with a VAPID JWT (RFC 8292).
import { bad, str } from './util.js';

const te = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

/** RFC 8291 body for one subscription. */
export async function encryptPayload(sub, payload) {
  const uaPub = unb64u(sub.p256dh);
  const auth = unb64u(sub.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(te.encode(payload), new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = 65;
  return cat(head, asPub, ct);
}

async function vapidHeader(vapid, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const enc = (o) => b64u(te.encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/**
 * Sends web push messages. `subs` maps token -> {endpoint, p256dh, auth}.
 * Returns the tokens whose subscription is gone (404 / 410), to delete.
 */
export async function sendWebPushes(vapid, subs, msgs, subject, report) {
  const dead = [];
  await Promise.all(msgs.map(async (m) => {
    const s = subs[m.token];
    let status = 0;
    let txt = '';
    if (!s) { if (report) report.push({ status: 0, error: 'subscription missing' }); return; }
    try {
      const body = await encryptPayload(s, JSON.stringify({ id: String(m.id), title: String(m.title || ''), body: String(m.body || ''), ref: String(m.ref || '') }));
      const res = await fetch(s.endpoint, {
        method: 'POST',
        headers: {
          authorization: await vapidHeader(vapid, s.endpoint, subject),
          'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high',
          topic: String(m.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'afford',
        },
        body,
      });
      status = res.status;
      if (!res.ok) txt = await res.text().catch(() => '');
    } catch (e) {
      txt = String(e?.message || e);
    }
    if (status === 404 || status === 410) dead.push(m.token);
    if (status && (status < 200 || status > 299)) console.warn('webpush', status, txt.slice(0, 200));
    if (report) report.push({ status: status >= 200 && status < 300 ? 200 : status, error: txt.slice(0, 200) });
  }));
  return dead;
}

export function installWebPush(Store) {
  const P = Store.prototype;

  P.webPushRoutes = function webPushRoutes(add, A) {
    add('GET', '/api/push/web-key', this.webPushKey);
    add('POST', '/api/admin/web-push', (c) => this.webPushSave(c, 'admin'), A());
    add('POST', '/api/emp/web-push', (c) => this.webPushSave(c, 'emp'), { auth: 'emp' });
  };

  /** VAPID key pair, made once and kept in the store. */
  P.vapid = async function vapid() {
    let v = this.db.kvGet('vapid', null);
    if (v?.publicKey && v?.privateJwk) return v;
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    this.db.kvSet('vapid', v);
    return v;
  };

  P.webPushKey = async function webPushKey() {
    return { key: (await this.vapid()).publicKey };
  };

  /** Save (or remove) this browser's push subscription for the signed-in person. */
  P.webPushSave = async function webPushSave({ actor, body }, kind) {
    const sub = body.subscription || {};
    const endpoint = str(sub.endpoint, 1000);
    const p256dh = str(sub.keys?.p256dh, 200);
    const auth = str(sub.keys?.auth, 100);
    if (!/^https:\/\//.test(endpoint || '')) throw bad('BAD_SUB', 'Push subscription missing');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(endpoint)));
    const token = `web:${b64u(digest).slice(0, 32)}`;
    const subs = this.db.kvGet('webSubs', {});
    if (body.remove) {
      delete subs[token];
      this.db.kvSet('webSubs', subs);
      this.db.run('DELETE FROM push_tokens WHERE token = ?', token);
      return { ok: true };
    }
    if (!p256dh || !auth) throw bad('BAD_SUB', 'Push subscription missing');
    subs[token] = { endpoint, p256dh, auth };
    this.db.kvSet('webSubs', subs);
    this.setRich(token, false);
    this.db.run(`INSERT INTO push_tokens (token, kind, sub, lang, updated) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET kind = excluded.kind, sub = excluded.sub, lang = excluded.lang, updated = excluded.updated`,
    token, kind, actor.id, body.lang === 'ur' ? 'ur' : 'en', this.now());
    return { ok: true, token };
  };

  /** Phone apps go to Firebase, browsers to Web Push. Returns the dead tokens of both. */
  P.sendAll = async function sendAll(msgs, report, fcm) {
    const web = msgs.filter((m) => String(m.token).startsWith('web:'));
    const app = msgs.filter((m) => !String(m.token).startsWith('web:'));
    const dead = [];
    if (app.length) dead.push(...(await fcm(app, report)));
    if (web.length) {
      const subs = this.db.kvGet('webSubs', {});
      const gone = await sendWebPushes(await this.vapid(), subs, web, this.env.PUSH_SUBJECT || 'https://afford-attendance.abdullah6763939.workers.dev', report);
      if (gone.length) {
        for (const tk of gone) delete subs[tk];
        this.db.kvSet('webSubs', subs);
      }
      dead.push(...gone);
    }
    return dead;
  };
}

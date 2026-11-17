// Instant phone alerts through Firebase Cloud Messaging (HTTP v1).
// Needs the FIREBASE_SERVICE_ACCOUNT secret (the service-account JSON from Firebase). Without it, nothing is sent.

let cached = null; // { token, exp, email }

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = (s) => b64url(new TextEncoder().encode(s));

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === sa.client_email && cached.exp > now + 60) return cached.token;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claim}`)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claim}.${sig}`,
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const j = await res.json();
  cached = { token: j.access_token, exp: now + (j.expires_in || 3600), email: sa.client_email };
  return cached.token;
}

/**
 * Sends each message; returns the device tokens Firebase says are gone (to delete).
 * @param {string} saJson service-account JSON
 * @param {{token:string,id:string,title:string,body:string}[]} msgs
 */
export async function sendPushes(saJson, msgs) {
  if (!saJson || !msgs.length) return [];
  const sa = JSON.parse(saJson);
  const at = await accessToken(sa);
  const dead = [];
  await Promise.all(msgs.map(async (m) => {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: m.token,
          // data-only + high priority: the app shows it itself (sound, lock screen) even when closed
          data: { id: String(m.id), title: m.title, body: m.body },
          android: { priority: 'HIGH', ttl: '86400s' },
        },
      }),
    }).catch(() => null);
    if (res && (res.status === 404 || res.status === 400)) {
      const txt = await res.text().catch(() => '');
      if (/UNREGISTERED|registration-token-not-registered/.test(txt)) dead.push(m.token);
    }
  }));
  return dead;
}

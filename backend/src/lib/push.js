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
 * Sends each message. Returns the device tokens Firebase says are gone (to delete).
 * When `report` is given, one {status, error} per message is pushed into it.
 * @param {string} saJson service-account JSON
 * @param {{token:string,id:string,title:string,body:string}[]} msgs
 */
export async function sendPushes(saJson, msgs, report) {
  if (!saJson || !msgs.length) return [];
  let sa;
  try { sa = JSON.parse(saJson); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON'); }
  if (!sa.private_key || !sa.client_email || !sa.project_id) {
    throw new Error(sa.project_info ? 'FIREBASE_SERVICE_ACCOUNT holds google-services.json, not the service account key' : 'FIREBASE_SERVICE_ACCOUNT is not a service account key');
  }
  const at = await accessToken(sa);
  const dead = [];
  await Promise.all(msgs.map(async (m) => {
    let status = 0;
    let txt = '';
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: m.token,
            // A notification message: Android shows it itself even when the app is closed or asleep
            // (phone makers' battery savers can block data-only messages). Sound follows the phone's
            // ring mode, so a phone on silent only shows it.
            // Rich (new apps): data only, the app draws it with photo and buttons, then acks.
            // Plain: Android shows it by itself (also the backup when a rich alert was not acked).
            ...(m.rich ? {} : { notification: { title: m.title, body: m.body } }),
            data: {
              id: String(m.id), title: String(m.title || ''), body: String(m.body || ''), channel: channelFor(m.id),
              ...(m.rich ? { rich: '1', person: String(m.person || ''), personName: String(m.personName || ''), actions: String(m.actions || ''), ref: String(m.ref || ''), lang: String(m.lang || 'en') } : {}),
            },
            android: {
              priority: 'HIGH',
              ttl: '86400s',
              ...(m.rich ? {} : {
                notification: {
                  channel_id: channelFor(m.id), icon: 'ic_afford_notify', color: '#C62032', tag: String(m.id),
                  default_sound: true, default_vibrate_timings: true, notification_priority: 'PRIORITY_HIGH', visibility: 'PUBLIC',
                },
              }),
            },
          },
        }),
      });
      status = res.status;
      if (!res.ok) txt = await res.text().catch(() => '');
    } catch (e) {
      txt = String(e?.message || e);
    }
    if ((status === 404 || status === 400) && /UNREGISTERED|registration-token-not-registered/.test(txt)) dead.push(m.token);
    if (status && status !== 200) console.warn('push', status, txt.slice(0, 300));
    if (report) report.push({ status, error: txt ? (txt.match(/"message":\s*"([^"]+)"/)?.[1] || txt).slice(0, 200) : '' });
  }));
  return dead;
}

/**
 * Alert type -> Android notification channel. Each type shows separately in the phone's
 * notification settings (people can mute one kind without missing the others).
 * The apps create these channels; ids must match AffordNotifyWorker.CHANNELS.
 */
export function channelFor(id) {
  const k = String(id || '');
  if (/^(paid-|money-)/.test(k)) return 'afford_salary2';
  if (/^rem-/.test(k)) return 'afford_reminders2';
  if (/^(sum-|err-|drive-|appr-|greet-owner-)/.test(k)) return 'afford_reports2';
  if (/^(hol-|greet-|note-|roster-|swap-)/.test(k)) return 'afford_news2';
  return 'afford_alerts2'; // requests and answers to requests
}

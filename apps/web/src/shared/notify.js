// Phone alerts for requests.
// 1) Instant push (Firebase) when this build has it: the phone registers its push token with the server.
// 2) A background check about every 15 minutes (backup when push is not set up or is blocked).
// 3) While the app is open: a quick check every 20 seconds, so the tone plays right away.
import { AffordDevice } from 'afford-device';
import { api, LS, deviceInfo } from './api.js';
import { getLang, onLang } from './i18n.js';
import { IS_WEB, webPushRegister, webPushRemove } from './webapp.jsx';

let current = null;
let langHooked = false;
let timer = null;

async function registerPush(kind) {
  try {
    const { token } = await AffordDevice.getPushToken();
    if (!token) return;
    // rich: this app draws alerts itself (photo, buttons) and replies when one arrives
    await api.post(`/api/${kind}/push-token`, { token, lang: getLang(), rich: true });
    LS.set('afford.pushToken', token);
  } catch { /* push not set up */ }
}

export async function startNotify(kind) {
  if (!api.base || !api.token) return;
  current = kind;
  try {
    const dev = await deviceInfo();
    await AffordDevice.startBackgroundCheck({ base: api.base, token: api.token, deviceId: dev.deviceId, kind, lang: getLang() });
  } catch { /* not available on this phone */ }
  if (IS_WEB) webPushRegister(kind); // iPhone / browser alerts
  else registerPush(kind);
  if (!timer) {
    timer = setInterval(() => { if (current && document.visibilityState === 'visible') AffordDevice.checkNow().catch(() => {}); }, 20000);
    document.addEventListener('visibilitychange', () => { if (current && document.visibilityState === 'visible') (IS_WEB ? webPushRegister : registerPush)(current); });
  }
  if (!langHooked) { langHooked = true; onLang(() => current && startNotify(current)); }
}

export async function stopNotify() {
  const kind = current;
  current = null;
  if (IS_WEB && kind) await webPushRemove(kind);
  const tk = LS.get('afford.pushToken');
  if (tk && kind && api.token) { try { await api.post(`/api/${kind}/push-token`, { token: tk, remove: true }); } catch { /* ignore */ } }
  LS.set('afford.pushToken', null);
  try { await AffordDevice.stopBackgroundCheck(); } catch { /* ignore */ }
}

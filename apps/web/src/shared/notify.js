// Phone notifications while the app is closed: a background check every ~15 minutes
// (admins: new requests; staff: answers to their requests).
import { AffordDevice } from 'afford-device';
import { api, deviceInfo } from './api.js';
import { getLang, onLang } from './i18n.js';

let current = null;
let langHooked = false;

export async function startNotify(kind) {
  if (!api.base || !api.token) return;
  current = kind;
  try {
    const dev = await deviceInfo();
    await AffordDevice.startBackgroundCheck({ base: api.base, token: api.token, deviceId: dev.deviceId, kind, lang: getLang() });
  } catch { /* not available on this phone */ }
  if (!langHooked) { langHooked = true; onLang(() => current && startNotify(current)); }
}

export async function stopNotify() {
  current = null;
  try { await AffordDevice.stopBackgroundCheck(); } catch { /* ignore */ }
}

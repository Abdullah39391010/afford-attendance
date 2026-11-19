// Web versions (/staff/ and /owner/), mainly for iPhone:
//  - first open in Safari: a guide to put the app on the home screen
//  - after the first login (opened from the home screen): ask to turn on notifications
//  - Web Push subscription sent to the server, alerts shown by public/sw.js
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api, LS } from './api.js';
import { t, getLang } from './i18n.js';
import { Icon, LangSwitch } from './ui.jsx';

export const IS_WEB = typeof __WEB_APP__ !== 'undefined' && __WEB_APP__;
const APP_NAME = typeof __APP_KIND__ !== 'undefined' && __APP_KIND__ === 'admin' ? 'Afford Admin' : 'Afford Staff';

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => !!(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone);
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let swReg = null;
export function registerSW() {
  if (!IS_WEB || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((r) => { swReg = r; }).catch(() => {});
}

const b64ToBytes = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** Subscribe this browser (permission must already be granted) and tell the server. */
export async function webPushRegister(kind) {
  if (!IS_WEB || !pushSupported() || Notification.permission !== 'granted' || !api.token) return false;
  try {
    const reg = swReg || (await navigator.serviceWorker.ready);
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await api.get('/api/push/web-key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    }
    await api.post(`/api/${kind}/web-push`, { subscription: sub.toJSON(), lang: getLang() });
    return true;
  } catch { return false; }
}

export async function webPushRemove(kind) {
  if (!IS_WEB || !pushSupported()) return;
  try {
    const reg = swReg || (await navigator.serviceWorker.getRegistration());
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub && api.token) await api.post(`/api/${kind}/web-push`, { subscription: sub.toJSON(), remove: true });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- install guide (iPhone Safari, first open)
export const needsInstallGuide = () => IS_WEB && isIOS() && !isStandalone() && LS.get('afford.installSkip') !== '1';

const Step = ({ n, icon, title, sub }) => (
  <div class="ig-step">
    <span class="ig-n">{n}</span>
    <div class="grow"><b>{title}</b><div class="small muted">{sub}</div></div>
    <span class="ig-ic"><Icon n={icon} /></span>
  </div>
);

export function InstallGuide({ onSkip }) {
  return (
    <div class="auth ig">
      <div class="lang-switch"><LangSwitch /></div>
      <img class="logo" src="./logo.png" alt="" />
      <h1>{t('Install {app}', { app: APP_NAME })}</h1>
      <p class="sub">{t('Put the app on your home screen. It then opens like a normal app and can send you alerts.')}</p>
      <div class="box ig-box">
        <Step n="1" icon="iosshare" title={t('Tap the Share button')} sub={t('At the bottom of Safari (or tap ⋯ first)')} />
        <Step n="2" icon="addsq" title={t('Tap "Add to Home Screen"')} sub={t('Scroll down the list if you don\'t see it')} />
        <Step n="3" icon="check" title={t('Tap "Add"')} sub={t('Then open {app} from your home screen', { app: APP_NAME })} />
      </div>
      <button class="link ig-skip" onClick={() => { LS.set('afford.installSkip', '1'); onSkip(); }}>{t('Continue in browser instead')}</button>
      <div class="ig-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v15M6 13l6 6 6-6" /></svg></div>
    </div>
  );
}

// ---------------------------------------------------------------- "turn on notifications" (once, after login)
export const needsNotifyAsk = () => IS_WEB && pushSupported() && Notification.permission === 'default' && LS.get('afford.notifyAsked') !== '1';

export function NotifyAsk({ kind, onDone }) {
  const [busy, setBusy] = useState(false);
  const allow = async () => {
    setBusy(true);
    try { if ((await Notification.requestPermission()) === 'granted') await webPushRegister(kind); } catch { /* ignore */ }
    LS.set('afford.notifyAsked', '1');
    onDone();
  };
  const items = kind === 'admin'
    ? [['inbox', t('Requests to approve'), 'blue'], ['warn', t('Fake GPS and other warnings'), 'amber'], ['report', t('Daily summary'), 'green'], ['clock', t('Staff late or absent'), 'red']]
    : [['clock', t('Shift starts soon'), 'blue'], ['out', t('You forgot to check out'), 'amber'], ['leave', t('Leave approved or declined'), 'green'], ['money', t('Salary paid'), 'red']];
  return (
    <div class="na">
      <div class="na-bell"><Icon n="bell" /></div>
      <h1>{t('Turn on notifications')}</h1>
      <p class="sub">{kind === 'admin' ? t('So you see requests and warnings right away.') : t('So you never miss a shift or a message from the store.')}</p>
      <div class="box na-list">
        {items.map(([i, label, c]) => <div class="na-item"><span class={`na-ic ${c}`}><Icon n={i} /></span><b>{label}</b></div>)}
      </div>
      <div class="na-foot">
        <button class="btn block big" disabled={busy} onClick={allow}><Icon n="bell" /> {t('Allow notifications')}</button>
        <button class="link na-later" onClick={() => { LS.set('afford.notifyAsked', '1'); onDone(); }}>{t('Not now')}</button>
      </div>
    </div>
  );
}

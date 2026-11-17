// "Allow permissions" popup: shown when the app opens (and when it comes back) if something it needs is off.
// First tap asks Android; if Android no longer asks (refused before), the tap opens the app's settings.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { LS } from './api.js';
import { t } from './i18n.js';
import { Dialog, Icon, toast } from './ui.jsx';

const INFO = {
  location: { icon: 'map', title: 'Location', why: 'To check that you are at the store when you check in or out.' },
  camera: { icon: 'camera', title: 'Camera', why: 'For the photo when someone checks in on this phone.' },
  notifications: { icon: 'inbox', title: 'Notifications', why: 'To tell you about requests even when the app is closed.' },
};

let hiddenThisRun = false;

export function PermissionGate({ need }) {
  const [st, setSt] = useState(null);
  const [open, setOpen] = useState(false);
  const check = async () => {
    try {
      const s = await AffordDevice.permissionStatus();
      setSt(s);
      const missing = need.filter((p) => !s[p]);
      if (missing.length && !hiddenThisRun) setOpen(true);
      if (!missing.length && open) { setOpen(false); toast(t('All set, thank you'), 'ok'); }
      return s;
    } catch { return null; }
  };
  useEffect(() => {
    const tm = setTimeout(check, 1500);
    const vis = () => document.visibilityState === 'visible' && setTimeout(check, 400);
    document.addEventListener('visibilitychange', vis);
    return () => { clearTimeout(tm); document.removeEventListener('visibilitychange', vis); };
  }, [open]);

  const allow = async (p) => {
    const key = `afford.permAsked.${p}`;
    if (LS.get(key)) { await AffordDevice.openAppSettings().catch(() => {}); return; }
    try { await AffordDevice.requestPermissions({ permissions: [p] }); } catch { /* ignore */ }
    const s = await check();
    if (s && !s[p]) { LS.set(key, '1'); toast(t('Turn it on in the settings screen that opens next.')); setTimeout(() => AffordDevice.openAppSettings().catch(() => {}), 1200); }
  };

  if (!open || !st) return null;
  const list = need.filter((p) => INFO[p]);
  return (
    <Dialog open title={t('Allow permissions')} onClose={() => { hiddenThisRun = true; setOpen(false); }}>
      <p class="small muted" style="margin:0 0 8px">{t('The app needs these to work properly.')}</p>
      <div class="list" style="margin:0">
        {list.map((p) => (
          <div key={p} class="row">
            <Icon n={INFO[p].icon} />
            <div class="main"><div class="title">{t(INFO[p].title)}</div><div class="sub">{t(INFO[p].why)}</div></div>
            {st[p]
              ? <span class="pill st-present"><Icon n="check" /></span>
              : <button class="btn small" onClick={() => allow(p)}>{LS.get(`afford.permAsked.${p}`) ? t('Settings') : t('Allow')}</button>}
          </div>
        ))}
      </div>
      <div class="btn-row">
        <button class="btn ghost" onClick={() => { hiddenThisRun = true; setOpen(false); }}>{t('Later')}</button>
      </div>
    </Dialog>
  );
}

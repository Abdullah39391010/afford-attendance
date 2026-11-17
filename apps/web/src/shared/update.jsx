// In-app update popup: compares this build's version with the latest GitHub release (via the worker).
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { api, LS } from './api.js';
import { t, getLang } from './i18n.js';
import { Dialog, Icon, Spinner, toast } from './ui.jsx';

const newer = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

/** Release notes may contain "EN: ..." and "UR: ..." lines; show the one for the current language. */
function pickNotes(notes) {
  const lines = String(notes || '').split(/\r?\n/);
  const ur = lines.filter((l) => /^UR:/i.test(l)).map((l) => l.replace(/^UR:\s*/i, ''));
  const en = lines.filter((l) => !/^UR:/i.test(l)).map((l) => l.replace(/^EN:\s*/i, ''));
  return (getLang() === 'ur' && ur.length ? ur : en).join('\n').trim();
}

const mb = (n) => (n / 1048576).toFixed(1);

export function UpdatePopup() {
  const [rel, setRel] = useState(null);
  const [dl, setDl] = useState(null); // null | {state: 'loading'|'ready'|'error', loaded, total, error}
  useEffect(() => {
    let h;
    AffordDevice.addListener('updateProgress', (p) => setDl((d) => (d && d.state === 'loading' ? { ...d, loaded: p.loaded, total: p.total } : d)))
      .then((x) => { h = x; }).catch(() => {});
    return () => { if (h) h.remove(); };
  }, []);
  const install = async () => {
    try {
      const r = await AffordDevice.installUpdate();
      if (r.needsPermission) toast(t('Allow "Install unknown apps" for this app, then come back and tap Install now.'));
    } catch (e) { setDl({ state: 'error', error: e.message }); }
  };
  const start = async () => {
    setDl({ state: 'loading', loaded: 0, total: 0 });
    try {
      const r = await AffordDevice.downloadUpdate({ url: rel.url });
      if (r.web) { setDl(null); return; }
      setDl((d) => ({ ...d, state: 'ready' }));
      install();
    } catch (e) {
      if (e.code === 'BUSY') return;
      setDl({ state: 'error', error: e.message });
    }
  };
  useEffect(() => {
    const check = async () => {
      try {
        const r = await api.get(`/api/app/latest?app=${__APP_KIND__}`);
        if (r.version && newer(r.version, __APP_VERSION__) && Date.now() > Number(LS.get(`afford.snooze.${r.version}`) || 0)) setRel(r);
      } catch { /* offline: try later */ }
    };
    const tm = setTimeout(check, 4000);
    const iv = setInterval(check, 6 * 3600 * 1000);
    return () => { clearTimeout(tm); clearInterval(iv); };
  }, []);
  if (!rel) return null;
  return (
    <Dialog open title={t('New update available')} onClose={() => { if (dl?.state !== 'loading') { setRel(null); setDl(null); } }}>
      <p class="small muted" style="margin:0 0 6px">{t('Version {v} is ready. You have {o}.', { v: rel.version, o: __APP_VERSION__ })}</p>
      <div class="card flat" style="white-space:pre-wrap;font-size:14.5px;max-height:40vh;overflow:auto;margin:8px 0"><b>{t("What's new")}</b>{'\n'}{pickNotes(rel.notes)}</div>
      {dl && dl.state !== 'error' && (
        <div class="dl">
          <div class="dl-top">
            <span>{dl.state === 'ready' ? t('Downloaded') : t('Downloading...')}</span>
            <b class="ltr">{dl.total ? `${Math.floor((dl.loaded / dl.total) * 100)}%` : dl.loaded ? `${mb(dl.loaded)} MB` : ''}</b>
          </div>
          <div class={`dl-bar ${!dl.total && dl.state === 'loading' ? 'busy' : ''}`}><i style={`width:${dl.total ? Math.min(100, (dl.loaded / dl.total) * 100) : dl.state === 'ready' ? 100 : 30}%`} /></div>
          {dl.total > 0 && <div class="small muted ltr" style="margin-top:4px">{mb(dl.loaded)} / {mb(dl.total)} MB</div>}
        </div>
      )}
      {dl?.state === 'error' && <p class="small" style="color:var(--red);margin:6px 0">{t('Download failed. Check the internet and try again.')}</p>}
      <div class="btn-row">
        {dl?.state !== 'loading' && dl?.state !== 'ready' && <button class="btn ghost" onClick={() => { LS.set(`afford.snooze.${rel.version}`, String(Date.now() + 24 * 3600 * 1000)); setRel(null); setDl(null); }}>{t('Later')}</button>}
        {(!dl || dl.state === 'error') && <button class="btn green" onClick={start}><Icon n="download" />{dl ? t('Try again') : t('Tap to download')}</button>}
        {dl?.state === 'loading' && <button class="btn ghost" disabled><Spinner sm />{t('Please wait')}</button>}
        {dl?.state === 'ready' && <button class="btn green" onClick={install}><Icon n="check" />{t('Install now')}</button>}
      </div>
    </Dialog>
  );
}

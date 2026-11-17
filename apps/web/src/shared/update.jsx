// In-app update popup: compares this build's version with the latest GitHub release (via the worker).
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { api, LS } from './api.js';
import { t, getLang } from './i18n.js';
import { Dialog, Icon } from './ui.jsx';

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

export function UpdatePopup() {
  const [rel, setRel] = useState(null);
  useEffect(() => {
    const check = async () => {
      try {
        const r = await api.get(`/api/app/latest?app=${__APP_KIND__}`);
        if (r.version && newer(r.version, __APP_VERSION__) && LS.get(`afford.skip.${r.version}`) !== '1') setRel(r);
      } catch { /* offline: try later */ }
    };
    const tm = setTimeout(check, 4000);
    const iv = setInterval(check, 6 * 3600 * 1000);
    return () => { clearTimeout(tm); clearInterval(iv); };
  }, []);
  if (!rel) return null;
  return (
    <Dialog open title={t('New version {v} is ready', { v: rel.version })} onClose={() => setRel(null)}>
      <p class="small muted" style="margin:0 0 6px">{t('You have {v}', { v: __APP_VERSION__ })}</p>
      <div class="card flat" style="white-space:pre-wrap;font-size:14.5px;max-height:40vh;overflow:auto;margin:8px 0"><b>{t("What's new")}</b>{'\n'}{pickNotes(rel.notes)}</div>
      <div class="btn-row">
        <button class="btn ghost" onClick={() => { LS.set(`afford.skip.${rel.version}`, '1'); setRel(null); }}>{t('Later')}</button>
        <button class="btn green" onClick={() => AffordDevice.openUrl({ url: rel.url })}><Icon n="download" />{t('Download')}</button>
      </div>
    </Dialog>
  );
}

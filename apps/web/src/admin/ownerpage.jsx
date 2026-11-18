// Owner web page: its own code (not an admin login). The code is the server secret OWNER_PAGE_CODE, set from GitHub.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t } from '../shared/i18n.js';
import { toastErr, Spinner, PinPad, LangSwitch, Credit, Banner } from '../shared/ui.jsx';

const KEY = 'afford.ownerPageToken';
const lsGet = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const lsSet = (v) => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* ignore */ } };
export const forgetOwnerPage = () => lsSet(null);

/** Code-only login used by the web build. */
export function OwnerCodeLogin({ onDone }) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(!!lsGet());
  const [off, setOff] = useState(false);

  useEffect(() => {
    const saved = lsGet();
    if (!saved) return;
    (async () => {
      api.setToken(saved);
      try { const me = await api.get('/api/admin/me'); onDone({ token: saved, me: me.me }, { remember: false }); }
      catch { api.setToken(null); lsSet(null); setChecking(false); }
    })();
  }, []);

  const submit = async (code) => {
    setBusy(true);
    try {
      const res = await api.post('/api/owner-page/login', { code });
      lsSet(res.token);
      onDone(res, { remember: false });
    } catch (e) {
      if (e.code === 'OWNER_PAGE_OFF') setOff(true);
      setErr({ at: Date.now() });
      toastErr(e);
    } finally { setBusy(false); }
  };

  if (checking) return <div class="auth"><Spinner /></div>;
  return (
    <div class="auth auth-e">
      <div class="lang-switch"><LangSwitch /></div>
      <img class="logo" src="./logo.png" alt="Afford Supermarket" />
      <div class="box">
        <h1>{t('Owner page')}</h1>
        <p class="sub">{t('Enter the owner page code')}</p>
        {off && <Banner kind="warn">{t('This page is not turned on yet.')}</Banner>}
        <PinPad length={4} max={8} onDone={submit} error={err?.at} busy={busy} />
      </div>
      <div class="auth-credit"><Credit /></div>
    </div>
  );
}

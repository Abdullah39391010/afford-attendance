// Owner web page: its own code (not an admin login). The code is set by the owner in the phone app.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { api } from '../shared/api.js';
import { t } from '../shared/i18n.js';
import { TopBar, Icon, Field, Loader, useLoad, toast, toastErr, Spinner, PinPad, LangSwitch, Credit, Banner, confirmBox } from '../shared/ui.jsx';

export const OWNER_PAGE_URL = 'https://afford-attendance.abdullah6763939.workers.dev/owner/';
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
        {off && <Banner kind="warn">{t('The code is not set yet. In the admin app open More, Owner web page, and set it.')}</Banner>}
        <PinPad length={4} max={8} onDone={submit} error={err?.at} busy={busy} />
      </div>
      <div class="auth-credit"><Credit /></div>
    </div>
  );
}

/** Admin app (owner only): link to the page and its code. */
export function OwnerPageScreen() {
  const st = useLoad(() => api.get('/api/admin/owner-page'), []);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = /^\d{4,8}$/.test(code);

  const save = async (value) => {
    setBusy(true);
    try {
      await api.put('/api/admin/owner-page', { code: value });
      toast(value ? t('Code saved') : t('Owner page turned off'), 'ok');
      setCode('');
      st.reload(true);
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(OWNER_PAGE_URL); toast(t('Link copied'), 'ok'); }
    catch { AffordDevice.openUrl({ url: OWNER_PAGE_URL }).catch(() => {}); }
  };

  return (
    <div class="screen no-nav">
      <TopBar back title={t('Owner web page')} />
      <div class="wrap">
        <Loader st={st}>{(d) => (
          <div>
            <div class="card">
              <h2>{t('Open on a computer')}</h2>
              <p class="small muted" style="margin:0 0 10px">{t('A separate page for the owner. It asks only for its own code, not your admin login. Open this link in any browser:')}</p>
              <div class="ltr" style="font-weight:700;word-break:break-all;margin-bottom:10px">{OWNER_PAGE_URL}</div>
              <button class="btn block ghost" onClick={copy}><Icon n="share" />{t('Copy link')}</button>
            </div>
            <div class="card">
              <h2>{t('Page code')}</h2>
              {d.codeSet
                ? <p class="small" style="margin:0 0 10px"><Icon n="check" /> {t('A code is set. Type a new one to change it. Changing it logs out every open owner page.')}</p>
                : <Banner kind="warn">{t('No code yet. The page cannot be opened until you set one.')}</Banner>}
              <Field label={t('New code (4 to 8 digits)')} hint={t('Keep it secret. After 5 wrong tries the page is locked for a while.')}>
                <input class="input ltr" style="width:100%;font-size:22px;letter-spacing:4px" type="password" inputmode="numeric" maxLength={8} autocomplete="new-password"
                  value={code} onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))} />
              </Field>
              <button class="btn block" disabled={!ok || busy} onClick={() => save(code)}>{busy ? <Spinner sm /> : t('Save code')}</button>
              {d.codeSet && <button class="btn block ghost" style="margin-top:10px" disabled={busy}
                onClick={async () => { if (await confirmBox({ title: t('Turn off the owner page?'), text: t('Nobody can open it until you set a code again.'), yes: t('Turn off') })) save(''); }}>{t('Turn off owner page')}</button>}
            </div>
          </div>
        )}</Loader>
      </div>
    </div>
  );
}

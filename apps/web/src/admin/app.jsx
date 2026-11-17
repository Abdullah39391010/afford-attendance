// Admin / Manager app: boot, setup, login and lock, navigation shell.
import { h, createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { api, LS, deviceInfo } from '../shared/api.js';
import { t, applyDir, errText, onLang } from '../shared/i18n.js';
import { setTz } from '../shared/format.js';
import {
  Splash, ToastHost, ConfirmHost, PinPad, LangSwitch, BottomNav, Field, Icon, Spinner, toast, toastErr, useRoute, go, replace, Banner, setBackHome, Credit, askFinger,
} from '../shared/ui.jsx';
import { BackupScreen, autoBackupTick } from './backup.jsx';
import { UpdatePopup } from '../shared/update.jsx';
import { Board } from './board.jsx';
import { Requests } from './requests.jsx';
import { StaffList, StaffForm, StaffDetail } from './staff.jsx';
import { Payroll, PayrollOne } from './payroll.jsx';
import { More, Reports, Audit, ChangePin } from './more.jsx';
import { SettingsHome, SettingsLocation, SettingsShifts, SettingsRoles, SettingsRules, SettingsHolidays, SettingsStore, Users } from './settings.jsx';
import { KioskSetup, KioskMode } from './kiosk.jsx';

export const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

const SECURE_TOKEN = 'adminToken';

async function secureGet(key) { try { return (await AffordDevice.secureGet({ key })).value; } catch { return null; } }
async function secureSet(key, value) { try { await AffordDevice.secureSet({ key, value }); } catch { /* ignore */ } }
async function secureRemove(key) { try { await AffordDevice.secureRemove({ key }); } catch { /* ignore */ } }

export function App() {
  const [, force] = useState(0);
  const [phase, setPhase] = useState('splash'); // splash | server | setup | login | app | kiosk
  const [info, setInfo] = useState(null);
  const [me, setMe] = useState(null);
  const [bootErr, setBootErr] = useState(null);
  const splashDone = useRef(false);
  const nextPhase = useRef(null);

  useEffect(() => onLang(() => force((x) => x + 1)), []);
  useEffect(() => {
    applyDir();
    api.onAuthLost(() => { secureRemove(SECURE_TOKEN); api.setToken(null); setMe(null); setPhase('login'); });
    boot();
  }, []);

  const show = (p) => {
    if (splashDone.current) setPhase(p);
    else nextPhase.current = p;
  };

  async function boot() {
    const dev = await deviceInfo();
    api.setDevice(dev.deviceId);
    if (!api.base) return show('server');
    const kiosk = await secureGet('kioskToken');
    if (kiosk) { api.setToken(kiosk); return show('kiosk'); }
    try {
      const inf = await api.get('/api/info');
      setInfo(inf);
      setTz(inf.tzOffsetMin);
      setBootErr(null);
      show(inf.setupDone ? 'login' : 'setup');
    } catch (e) {
      setBootErr(e);
      show(LS.get('afford.setupDone') ? 'login' : 'server');
    }
  }

  const onSplashDone = () => {
    splashDone.current = true;
    setPhase(nextPhase.current || 'login');
  };

  const signedIn = async (res, { remember = true } = {}) => {
    api.setToken(res.token);
    setMe(res.me);
    LS.set('afford.lastLogin', res.me.login);
    LS.set('afford.setupDone', '1');
    if (remember) await secureSet(SECURE_TOKEN, res.token);
    if (!location.hash || location.hash === '#/') replace('board');
    setPhase('app');
  };

  const logout = async () => {
    try { await api.post('/api/admin/logout'); } catch { /* ignore */ }
    await secureRemove(SECURE_TOKEN);
    LS.set('afford.bio', null);
    api.setToken(null);
    setMe(null);
    setPhase('login');
  };

  setBackHome('board', phase === 'app');
  return (
    <div>
      {phase === 'splash' && <Splash title="Afford Super Store" sub={t('Attendance & Payroll · Admin')} onDone={onSplashDone} />}
      {phase === 'server' && <ServerSetup err={bootErr} onSaved={() => { setPhase('splash2'); boot().then(() => { splashDone.current = true; setPhase(nextPhase.current || 'login'); }); }} />}
      {phase === 'splash2' && <div class="auth"><Spinner /></div>}
      {phase === 'setup' && <OwnerSetup onDone={signedIn} />}
      {phase === 'login' && <Login info={info} onDone={signedIn} onKiosk={() => setPhase('kiosk')} />}
      {phase === 'kiosk' && <KioskMode onExit={async (res) => { await secureRemove('kioskToken'); api.setToken(null); if (res) signedIn(res, { remember: false }); else setPhase('login'); }} />}
      {phase === 'app' && me && <Shell me={me} logout={logout} toKiosk={() => setPhase('kiosk')} />}
      <ToastHost />
      <ConfirmHost />
      {phase !== 'splash' && <UpdatePopup />}
    </div>
  );
}

/** "Use fingerprint next time?" — tests the sensor before switching it on. */
function BioAsk({ title, onDone }) {
  const yes = async () => { if (await askFinger(title)) onDone(true); };
  return (
    <div class="auth">
      <img class="logo" src="./logo.png" alt="" />
      <h1>{t('Use fingerprint next time?')}</h1>
      <p class="sub">{t('Unlock the app with your fingerprint instead of typing your PIN.')}</p>
      <div class="box">
        <button class="btn block" onClick={yes}><Icon n="finger" />{t('Yes, use fingerprint')}</button>
        <button class="btn block ghost" style="margin-top:10px" onClick={() => onDone(false)}>{t('No, keep PIN')}</button>
      </div>
    </div>
  );
}

function ServerSetup({ err, onSaved }) {
  const [url, setUrl] = useState(api.base || 'https://');
  return (
    <div class="auth">
      <div class="lang-switch"><LangSwitch /></div>
      <img class="logo" src="./logo.png" alt="" />
      <h1>{t('Connect to your store server')}</h1>
      <p class="sub">{t('Enter the server address given by the owner.')}</p>
      <div class="box">
        {err && <Banner kind="err">{errText(err)}</Banner>}
        <Field label={t('Server address')}>
          <input class="input ltr" style="width:100%" value={url} onInput={(e) => setUrl(e.currentTarget.value)} inputmode="url" autocapitalize="off" spellcheck={false} />
        </Field>
        <button class="btn block" onClick={() => { api.setBase(url); onSaved(); }}>{t('Continue')}</button>
      </div>
    </div>
  );
}

function OwnerSetup({ onDone }) {
  const [f, setF] = useState({ setupCode: '', name: '', login: 'owner', pin: '', pin2: '', storeName: 'Afford Super Store' });
  const [busy, setBusy] = useState(false);
  const [askBio, setAskBio] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  const submit = async () => {
    if (!/^\d{4,6}$/.test(f.pin)) return toast(t('PIN must be 4 to 6 digits.'), 'err');
    if (f.pin !== f.pin2) return toast(t('The two PINs do not match.'), 'err');
    setBusy(true);
    try {
      const res = await api.post('/api/setup', { setupCode: f.setupCode.trim(), name: f.name, login: f.login, pin: f.pin, storeName: f.storeName });
      toast(t('Welcome! Your owner account is ready.'), 'ok');
      const avail = (await AffordDevice.biometricAvailable().catch(() => ({}))).available;
      if (avail) setAskBio(res); else onDone(res);
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  if (askBio) return <BioAsk title={t('Unlock Afford Admin')} onDone={(on) => { LS.set('afford.bio', on ? '1' : '0'); onDone(askBio); }} />;
  return (
    <div class="auth">
      <div class="lang-switch"><LangSwitch /></div>
      <img class="logo" src="./logo.png" alt="" />
      <h1>{t('First-time setup')}</h1>
      <p class="sub">{t('Create the owner account. This is done only once.')}</p>
      <div class="box">
        <Field label={t('Setup code')} hint={t('The secret word chosen when the server was set up.')}>
          <input class="input" value={f.setupCode} onInput={set('setupCode')} autocapitalize="off" />
        </Field>
        <Field label={t('Store name')}><input class="input" value={f.storeName} onInput={set('storeName')} /></Field>
        <Field label={t('Your name')}><input class="input" value={f.name} onInput={set('name')} /></Field>
        <Field label={t('Login name')} hint={t('Short, no spaces. You will type it when logging in.')}>
          <input class="input ltr" style="width:100%" value={f.login} onInput={set('login')} autocapitalize="off" />
        </Field>
        <div class="two">
          <Field label={t('PIN (4-6 digits)')}><input class="input ltr" style="width:100%" type="password" inputmode="numeric" maxLength={6} value={f.pin} onInput={set('pin')} /></Field>
          <Field label={t('Repeat PIN')}><input class="input ltr" style="width:100%" type="password" inputmode="numeric" maxLength={6} value={f.pin2} onInput={set('pin2')} /></Field>
        </div>
        <button class="btn block" disabled={busy || !f.setupCode || !f.name} onClick={submit}>{busy ? <Spinner sm /> : t('Create owner account')}</button>
      </div>
    </div>
  );
}

function Login({ info, onDone }) {
  const [login, setLogin] = useState(LS.get('afford.lastLogin') || '');
  const [step, setStep] = useState(LS.get('afford.lastLogin') ? 'pin' : 'name');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [bio, setBio] = useState(false);
  const [askBio, setAskBio] = useState(null);

  useEffect(() => {
    (async () => {
      const saved = await secureGet(SECURE_TOKEN);
      const avail = (await AffordDevice.biometricAvailable().catch(() => ({}))).available;
      if (saved && avail && LS.get('afford.bio') === '1') { setBio(true); tryBio(saved); }
    })();
  }, []);

  async function tryBio(saved) {
    if (!saved) { setBio(false); return; }
    if (!(await askFinger(t('Unlock Afford Admin')))) return;
    api.setToken(saved);
    try {
      const me = await api.get('/api/admin/me');
      onDone({ token: saved, me: me.me }, { remember: false });
    } catch (e) {
      api.setToken(null);
      setErr(e);
      toastErr(e);
    }
  }

  const submit = async (pin) => {
    setBusy(true);
    setErr(null);
    try {
      const dev = await deviceInfo();
      const res = await api.post('/api/admin/login', { login: login.trim().toLowerCase(), pin, deviceId: dev.deviceId, deviceName: dev.model });
      const avail = (await AffordDevice.biometricAvailable().catch(() => ({}))).available;
      if (avail && LS.get('afford.bio') == null) setAskBio(res);
      else onDone(res);
    } catch (e) {
      setErr({ ...e, at: Date.now() });
      toastErr(e);
    } finally { setBusy(false); }
  };

  if (askBio) return <BioAsk title={t('Unlock Afford Admin')} onDone={(on) => { LS.set('afford.bio', on ? '1' : '0'); onDone(askBio); }} />;

  return (
    <div class="auth">
      <div class="lang-switch"><LangSwitch /></div>
      <img class="logo" src="./logo.png" alt="" />
      <h1>{info?.storeName || 'Afford Super Store'}</h1>
      <p class="sub">{t('Admin & Manager login')}</p>
      <div class="box">
        {step === 'name' ? (
          <div>
            <Field label={t('Login name')}>
              <input class="input ltr" style="width:100%" value={login} onInput={(e) => setLogin(e.currentTarget.value)} autocapitalize="off" autoFocus
                onKeyDown={(e) => e.key === 'Enter' && login && setStep('pin')} />
            </Field>
            <button class="btn block" disabled={!login} onClick={() => setStep('pin')}>{t('Next')}</button>
          </div>
        ) : (
          <div>
            <div class="center" style="margin-bottom:-4px">
              <b class="ltr">{login}</b> · <a href="#" onClick={(e) => { e.preventDefault(); setStep('name'); }}>{t('Change')}</a>
            </div>
            <div class="center muted small" style="margin-top:6px">{t('Enter your PIN')}</div>
            <PinPad length={4} max={6} onDone={submit} error={err?.at} busy={busy}
              extra={bio ? <button class="fn" onClick={async () => tryBio(await secureGet(SECURE_TOKEN))} aria-label={t('Fingerprint')}><Icon n="finger" /></button> : undefined} />
          </div>
        )}
      </div>
      <div class="auth-credit"><Credit /></div>
    </div>
  );
}

// ---------------------------------------------------------------- main shell
function Shell({ me, logout, toKiosk }) {
  const route = useRoute();
  const [settings, setSettings] = useState(null);
  const [chg, setChg] = useState({ ver: 0, pending: 0, latestPending: 0 });
  const [online, setOnline] = useState(true);
  const [seen, setSeen] = useState(Number(LS.get('afford.seenPending') || 0));
  const can = (p) => me.role === 'owner' || (me.perms || []).includes(p);

  const loadSettings = async () => {
    try {
      const s = await api.get('/api/admin/settings');
      setSettings(s);
      setTz(s.tzOffsetMin);
    } catch (e) { toastErr(e); }
  };
  useEffect(() => { loadSettings(); }, []);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const c = await api.get('/api/admin/changes');
        if (alive) { setChg((p) => (p.ver === c.ver && p.pending === c.pending ? p : c)); setOnline(true); }
      } catch (e) { if (alive && e.code === 'NETWORK') setOnline(false); }
    };
    poll();
    const iv = setInterval(poll, 15000);
    const onVis = () => document.visibilityState === 'visible' && poll();
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // daily auto backup (owner's phone): checked every minute and when the app comes back
  const bref = useRef(null);
  bref.current = { me, settings };
  useEffect(() => {
    const tick = () => autoBackupTick(bref.current);
    const iv = setInterval(tick, 60000);
    const onVis = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  useEffect(() => { if (settings) autoBackupTick(bref.current); }, [settings]);

  const tab = route.parts[0] || 'board';
  useEffect(() => {
    if (tab === 'requests' && chg.latestPending > seen) {
      setSeen(chg.latestPending);
      LS.set('afford.seenPending', String(chg.latestPending));
    }
  }, [tab, chg.latestPending]);
  const showLine = chg.pending > 0 && chg.latestPending > seen && tab !== 'requests';

  const nav = [
    { key: 'board', icon: 'board', label: 'Board' },
    { key: 'requests', icon: 'inbox', label: 'Requests', badge: chg.pending },
    can('employees.view') && { key: 'staff', icon: 'users', label: 'Staff' },
    can('payroll.view') && { key: 'payroll', icon: 'money', label: 'Payroll' },
    { key: 'more', icon: 'more', label: 'More' },
  ].filter(Boolean);

  if (!settings) return <div class="auth"><Spinner /></div>;
  const ctx = { me, can, settings, reloadSettings: loadSettings, ver: chg.ver, pending: chg.pending, logout, toKiosk, refreshChanges: () => setChg((c) => ({ ...c, ver: c.ver + 0.001 })) };
  const p = route.parts;
  let screen;
  switch (p[0]) {
    case 'requests': screen = <Requests />; break;
    case 'staff':
      if (p[1] === 'new') screen = <StaffForm />;
      else if (p[1] && p[2] === 'edit') screen = <StaffForm id={p[1]} />;
      else if (p[1]) screen = <StaffDetail id={p[1]} tab={p[2] || 'info'} q={route.q} />;
      else screen = <StaffList />;
      break;
    case 'payroll': screen = p[1] ? <PayrollOne id={p[1]} q={route.q} /> : <Payroll q={route.q} />; break;
    case 'more': screen = <More />; break;
    case 'reports': screen = <Reports q={route.q} />; break;
    case 'audit': screen = <Audit />; break;
    case 'pin': screen = <ChangePin />; break;
    case 'users': screen = <Users />; break;
    case 'kiosk': screen = <KioskSetup />; break;
    case 'backup': screen = <BackupScreen />; break;
    case 'settings':
      screen = { location: <SettingsLocation />, shifts: <SettingsShifts />, roles: <SettingsRoles />, rules: <SettingsRules />, holidays: <SettingsHolidays />, store: <SettingsStore /> }[p[1]] || <SettingsHome />;
      break;
    default: screen = <Board />;
  }
  const mainTab = ['board', 'requests', 'staff', 'payroll'].includes(tab) ? tab : 'more';
  return (
    <Ctx.Provider value={ctx}>
      <div class={showLine ? 'has-pending' : ''}>
        {showLine && <button class="pending-line" onClick={() => go('requests')}>{t('{n} requests waiting · tap to open', { n: chg.pending })}</button>}
        {!online && <div class="offline-bar" style="position:fixed;bottom:calc(var(--safe-bottom) + 62px);left:0;right:0;z-index:21">{t('No internet — showing last saved data')}</div>}
        {screen}
        <BottomNav items={nav} active={mainTab} onGo={(k) => go(k)} />
      </div>
    </Ctx.Provider>
  );
}

// Staff app: boot, phone-locked login, fingerprint unlock, navigation shell.
import { h, createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { api, LS, deviceInfo } from '../shared/api.js';
import { t, applyDir, errText, onLang } from '../shared/i18n.js';
import { setTz } from '../shared/format.js';
import { Splash, ToastHost, ConfirmHost, PinPad, LangSwitch, BottomNav, Field, Icon, Spinner, toast, toastErr, useRoute, go, replace, Banner, setBackHome, askFinger, Credit } from '../shared/ui.jsx';
import { UpdatePopup } from '../shared/update.jsx';
import { flush, onQueue, queued } from '../shared/offline.js';
import { startNotify, stopNotify } from '../shared/notify.js';
import { Home } from './home.jsx';
import { MyCalendar, MyRequests, MyPay, MyMore, Helper } from './screens.jsx';

export const ECtx = createContext(null);
export const useEmp = () => useContext(ECtx);

const SECURE_TOKEN = 'empToken';
async function secureGet(key) { try { return (await AffordDevice.secureGet({ key })).value; } catch { return null; } }
async function secureSet(key, value) { try { await AffordDevice.secureSet({ key, value }); } catch { /* ignore */ } }
async function secureRemove(key) { try { await AffordDevice.secureRemove({ key }); } catch { /* ignore */ } }

export function App() {
  const [, force] = useState(0);
  const [phase, setPhase] = useState('splash'); // splash | server | login | unlock | app
  const splashDone = useRef(false);
  const next = useRef(null);

  useEffect(() => onLang(() => force((x) => x + 1)), []);
  useEffect(() => {
    applyDir();
    api.onAuthLost(async (e) => {
      await secureRemove(SECURE_TOKEN);
      api.setToken(null);
      stopNotify();
      if (e.code === 'DEVICE_RESET') toast(errText(e), 'err');
      setPhase('login');
    });
    boot();
  }, []);

  const show = (p) => { if (splashDone.current) setPhase(p); else next.current = p; };

  async function boot() {
    const dev = await deviceInfo();
    api.setDevice(dev.deviceId);
    if (!api.base) return show('server');
    api.get('/api/info').then((i) => setTz(i.tzOffsetMin)).catch(() => {});
    const saved = await secureGet(SECURE_TOKEN);
    if (!saved) return show('login');
    const bio = LS.get('afford.bio') === '1' && (await AffordDevice.biometricAvailable().catch(() => ({}))).available;
    if (bio) return show('unlock');
    api.setToken(saved);
    show('app');
  }

  const signedIn = async (res) => {
    api.setToken(res.token);
    await secureSet(SECURE_TOKEN, res.token);
    LS.set('afford.empCode', res.employee.code);
    replace('home');
    setPhase('app');
  };

  const logout = async () => {
    await stopNotify();
    try { await api.post('/api/emp/logout'); } catch { /* ignore */ }
    await secureRemove(SECURE_TOKEN);
    api.setToken(null);
    LS.set('afford.home', null);
    setPhase('login');
  };

  setBackHome('home', phase === 'app');
  return (
    <div>
      {phase === 'splash' && <Splash title="Afford Super Store" sub={t('Staff attendance')} onDone={() => { splashDone.current = true; setPhase(next.current || 'login'); }} />}
      {phase === 'server' && <ServerSetup onSaved={() => { boot(); setPhase('login'); }} />}
      {phase === 'login' && <Login onDone={signedIn} />}
      {phase === 'unlock' && <Unlock onDone={async () => { api.setToken(await secureGet(SECURE_TOKEN)); setPhase('app'); }} onPin={async () => { await secureRemove(SECURE_TOKEN); setPhase('login'); }} />}
      {phase === 'app' && <Shell logout={logout} />}
      <ToastHost />
      <ConfirmHost />
      {phase === 'app' && <UpdatePopup />}
    </div>
  );
}

function ServerSetup({ onSaved }) {
  const [url, setUrl] = useState(api.base || 'https://');
  return (
    <div class="auth">
      <div class="lang-switch"><LangSwitch /></div>
      <img class="logo" src="./logo.png" alt="" />
      <h1>{t('Connect to your store server')}</h1>
      <p class="sub">{t('Enter the server address given by the owner.')}</p>
      <div class="box">
        <Field label={t('Server address')}><input class="input ltr" style="width:100%" value={url} onInput={(e) => setUrl(e.currentTarget.value)} autocapitalize="off" /></Field>
        <button class="btn block" onClick={() => { api.setBase(url); onSaved(); }}>{t('Continue')}</button>
      </div>
    </div>
  );
}

function Login({ onDone }) {
  const [code, setCode] = useState(LS.get('afford.empCode') || '');
  const [step, setStep] = useState(LS.get('afford.empCode') ? 'pin' : 'code');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [askBio, setAskBio] = useState(null);

  const submit = async (pin) => {
    setBusy(true);
    try {
      const dev = await deviceInfo();
      const res = await api.post('/api/emp/login', { code: code.trim(), pin, deviceId: dev.deviceId, deviceName: dev.model });
      const avail = (await AffordDevice.biometricAvailable().catch(() => ({}))).available;
      if (avail && LS.get('afford.bio') == null) setAskBio(res);
      else onDone(res);
    } catch (e) {
      setErr({ at: Date.now() });
      toastErr(e);
    } finally { setBusy(false); }
  };

  if (askBio) {
    return (
      <div class="auth">
        <img class="logo" src="./logo.png" alt="" />
        <h1>{t('Use fingerprint next time?')}</h1>
        <p class="sub">{t('Unlock the app with your fingerprint instead of typing your PIN.')}</p>
        <div class="box">
          <button class="btn block" onClick={async () => { if (await askFinger(t('Unlock Afford Staff'))) { LS.set('afford.bio', '1'); onDone(askBio); } }}><Icon n="finger" />{t('Yes, use fingerprint')}</button>
          <button class="btn block ghost" style="margin-top:10px" onClick={() => { LS.set('afford.bio', '0'); onDone(askBio); }}>{t('No, keep PIN')}</button>
        </div>
      </div>
    );
  }
  return (
    <div class="auth">
      <div class="lang-switch"><LangSwitch /></div>
      <img class="logo" src="./logo.png" alt="" />
      <h1>Afford Super Store</h1>
      <p class="sub">{t('Staff login')}</p>
      <div class="box">
        {step === 'code' ? (
          <div>
            <Field label={t('Employee code or phone number')} hint={t('Ask the manager if you do not know it.')}>
              <input class="input ltr" style="width:100%" value={code} onInput={(e) => setCode(e.currentTarget.value)} autocapitalize="characters"
                onKeyDown={(e) => e.key === 'Enter' && code && setStep('pin')} />
            </Field>
            <button class="btn block" disabled={!code.trim()} onClick={() => setStep('pin')}>{t('Next')}</button>
            <p class="small muted center" style="margin-top:12px">{t('This phone will be linked to your account. One phone = one employee.')}</p>
          </div>
        ) : (
          <div>
            <div class="center" style="margin-bottom:-4px"><b class="ltr">{code}</b> · <a href="#" onClick={(e) => { e.preventDefault(); setStep('code'); }}>{t('Change')}</a></div>
            <div class="center muted small" style="margin-top:6px">{t('Enter your PIN')}</div>
            <PinPad length={4} max={6} onDone={submit} error={err?.at} busy={busy} />
          </div>
        )}
      </div>
      <div class="auth-credit"><Credit /></div>
    </div>
  );
}

function Unlock({ onDone, onPin }) {
  const tryBio = async () => {
    if (await askFinger(t('Unlock Afford Staff'))) onDone();
  };
  useEffect(() => { tryBio(); }, []);
  return (
    <div class="auth">
      <img class="logo" src="./logo.png" alt="" />
      <h1>{t('Welcome back')}</h1>
      <p class="sub">{t('Touch the fingerprint sensor to open the app.')}</p>
      <div class="box center">
        <button class="bio-btn" onClick={tryBio} aria-label={t('Fingerprint')}><Icon n="finger" /></button>
        <button class="btn block ghost" style="margin-top:18px" onClick={onPin}>{t('Use PIN instead')}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- shell
function Shell({ logout }) {
  const route = useRoute();
  const [home, setHome] = useState(() => { try { return JSON.parse(LS.get('afford.home') || 'null'); } catch { return null; } });
  const [online, setOnline] = useState(navigator.onLine);
  const [queue, setQueue] = useState(queued());

  const loadHome = async () => {
    try {
      const h1 = await api.get('/api/emp/home');
      setTz(h1.store.tzOffsetMin);
      setHome(h1);
      LS.set('afford.home', JSON.stringify(h1));
      setOnline(true);
      return h1;
    } catch (e) {
      if (e.code === 'NETWORK') setOnline(false);
      else toastErr(e);
      return null;
    }
  };
  const sync = async () => {
    if (!queued().length) return;
    const r = await flush();
    if (r.sent) toast(t('{n} saved punch(es) sent', { n: r.sent }), 'ok');
    for (const f of r.failed) toast(`${t('A saved punch was refused')}: ${errText(f.error)}`, 'err');
    if (r.sent || r.failed.length) loadHome();
  };

  useEffect(() => { startNotify('emp'); }, []);
  useEffect(() => {
    sync().then(loadHome);
    const iv = setInterval(() => { sync(); loadHome(); }, 60000);
    const on = () => { setOnline(true); sync().then(loadHome); };
    const off = () => setOnline(false);
    const vis = () => { if (document.visibilityState === 'visible') { sync(); loadHome(); } };
    addEventListener('online', on);
    addEventListener('offline', off);
    document.addEventListener('visibilitychange', vis);
    const un = onQueue(setQueue);
    return () => { clearInterval(iv); removeEventListener('online', on); removeEventListener('offline', off); document.removeEventListener('visibilitychange', vis); un(); };
  }, []);

  const tab = route.parts[0] || 'home';
  const ctx = { home, loadHome, online, setOnline, queue, sync, logout };
  let screen;
  switch (tab) {
    case 'calendar': screen = <MyCalendar />; break;
    case 'requests': screen = <MyRequests q={route.q} />; break;
    case 'pay': screen = <MyPay />; break;
    case 'more': screen = <MyMore />; break;
    case 'helper': screen = <Helper />; break;
    default: screen = <Home />;
  }
  const nav = [
    { key: 'home', icon: 'board', label: 'Today' },
    { key: 'calendar', icon: 'cal', label: 'Calendar' },
    { key: 'requests', icon: 'inbox', label: 'Requests', badge: home?.pendingRequests?.length || 0 },
    { key: 'pay', icon: 'money', label: 'Salary' },
    { key: 'more', icon: 'more', label: 'More' },
  ];
  return (
    <ECtx.Provider value={ctx}>
      {(!online || queue.length > 0) && (
        <div class="offline-bar" style="position:fixed;bottom:calc(var(--safe-bottom) + 62px);left:0;right:0;z-index:21">
          {!online ? t('No internet. Punches are saved on the phone and sent later.') : t('{n} saved punch(es) waiting to send', { n: queue.length })}
        </div>
      )}
      {!home ? <div class="auth"><Spinner /></div> : screen}
      <BottomNav items={nav} active={['home', 'calendar', 'requests', 'pay'].includes(tab) ? tab : 'more'} onGo={(k) => go(k)} />
    </ECtx.Provider>
  );
}

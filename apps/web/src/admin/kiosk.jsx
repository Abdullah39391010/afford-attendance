// Kiosk mode: one shared store phone at the door for staff who have no phone.
// Staff tap their name, type their PIN, a front-camera photo is taken, and the punch is recorded.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { api, deviceInfo } from '../shared/api.js';
import { t, nm, errText } from '../shared/i18n.js';
import { fmtTime, fmtDate, todayStr, fmtDateTime } from '../shared/format.js';
import { TopBar, Icon, Loader, useLoad, toast, toastErr, PinPad, Avatar, Sheet, Dialog, Field, Spinner, Empty, Banner, confirmBox, LangSwitch } from '../shared/ui.jsx';
import { useApp } from './app.jsx';

async function secureSet(key, value) { try { await AffordDevice.secureSet({ key, value }); } catch { /* ignore */ } }

// ---------------------------------------------------------------- setup (inside admin app, More → Kiosk mode)
export function KioskSetup() {
  const app = useApp();
  const st = useLoad(() => api.get('/api/admin/kiosks'), []);
  const [name, setName] = useState('Store door');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    const ok = await confirmBox({
      title: t('Turn this phone into the kiosk?'),
      text: t('You will be logged out. Staff can then check in on this phone with their PIN. To leave kiosk mode an admin or manager must log in.'),
      yes: t('Start kiosk'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const dev = await deviceInfo();
      const res = await api.post('/api/admin/kiosks', { name, deviceId: dev.deviceId });
      await secureSet('kioskToken', res.token);
      api.setToken(res.token);
      app.toKiosk();
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  const remove = async (k) => {
    if (!(await confirmBox({ title: t('Remove this kiosk?'), text: t('That phone will stop working as a kiosk.'), yes: t('Remove'), danger: true }))) return;
    try { await api.del(`/api/admin/kiosks/${k.id}`); toast(t('Removed'), 'ok'); st.reload(true); } catch (e) { toastErr(e); }
  };

  return (
    <div class="screen no-nav">
      <TopBar back title={t('Kiosk mode')} />
      <div class="wrap">
        <div class="card">
          <h2>{t('For staff without a phone')}</h2>
          <p class="small muted" style="margin:0 0 10px">{t('Keep one store phone at the door. Staff tap their name, enter their PIN and a photo is taken. The kiosk phone must stay inside the store circle.')}</p>
          <Field label={t('Kiosk name')}><input class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} /></Field>
          <button class="btn block" disabled={busy || !name.trim()} onClick={start}>{busy ? <Spinner sm /> : <><Icon n="kiosk" />{t('Use this phone as kiosk')}</>}</button>
        </div>
        <div class="section-title">{t('Kiosk phones')}</div>
        <Loader st={st}>{(d) => (
          <div class="list">
            {!d.kiosks.length && <Empty icon="kiosk" text={t('No kiosk phone yet')} />}
            {d.kiosks.map((k) => (
              <div key={k.id} class="row">
                <Icon n="kiosk" />
                <div class="main"><div class="title">{k.name}</div><div class="sub">{t('Added by {n}', { n: k.by })} · {fmtDateTime(k.created)}</div></div>
                <button class="iconbtn" onClick={() => remove(k)} aria-label={t('Remove')}><Icon n="trash" /></button>
              </div>
            ))}
          </div>
        )}</Loader>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- kiosk location
// The kiosk phone itself must be inside the store circle, so a kiosk taken home cannot be used.
let lastLoc = null;
async function kioskLoc(fresh = false) {
  if (!fresh && lastLoc && Date.now() - lastLoc.at < 5 * 60 * 1000) return lastLoc.loc;
  try {
    await AffordDevice.ensureGps().catch(() => {});
    const l = await AffordDevice.getLocation({ timeoutMs: 12000 });
    lastLoc = { at: Date.now(), loc: { lat: l.lat, lng: l.lng, acc: l.acc, mock: !!l.mock } };
  } catch { /* keep the last one */ }
  return lastLoc?.loc || null;
}

// ---------------------------------------------------------------- the kiosk itself
export function KioskMode({ onExit }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [done, setDone] = useState(null);
  const [exit, setExit] = useState(false);
  const [now, setNow] = useState(api.serverNow());

  const load = async () => {
    try {
      const d = await api.get('/api/kiosk/employees');
      setData(d);
      setErr(null);
    } catch (e) {
      if (e.status === 401) { toast(t('This kiosk was removed by the admin.'), 'err'); onExit(null); return; }
      setErr(e);
    }
  };
  useEffect(() => {
    load();
    kioskLoc(true);
    const c = setInterval(() => kioskLoc(true), 3 * 60 * 1000);
    AffordDevice.keepAwake({ on: true }).catch(() => {});
    const a = setInterval(load, 30000);
    const b = setInterval(() => setNow(api.serverNow()), 1000);
    return () => { clearInterval(a); clearInterval(b); clearInterval(c); AffordDevice.keepAwake({ on: false }).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!done) return undefined;
    const tm = setTimeout(() => setDone(null), 3500);
    return () => clearTimeout(tm);
  }, [done]);

  const list = (data?.employees || []).filter((e) => {
    const s = q.trim().toLowerCase();
    return !s || e.name.toLowerCase().includes(s) || (e.nameUr || '').includes(s) || e.code.toLowerCase().includes(s);
  });

  return (
    <div class="screen no-nav kiosk">
      <header class="topbar">
        <div class="in">
          <img class="logo-sm" src="./logo.png" alt="" />
          <h1>{data?.storeName || 'Afford Super Store'}<div class="small muted" style="font-weight:400">{fmtDate(todayStr(now))}</div></h1>
          <div class="kiosk-clock ltr">{fmtTime(now)}</div>
          <button class="iconbtn" onClick={() => setExit(true)} aria-label={t('Exit kiosk')}><Icon n="lock" /></button>
        </div>
      </header>
      <div class="wrap">
        <div class="center" style="margin:14px 0 6px"><b style="font-size:18px">{t('Tap your name')}</b></div>
        <input class="input" style="width:100%" placeholder={t('Search name or code')} value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        {err && <Banner kind="err">{errText(err)}</Banner>}
        {!data && !err && <div class="center" style="padding:40px"><Spinner /></div>}
        {data && !list.length && <Empty icon="users" text={t('Nothing to show')} />}
        <div class="kiosk-grid">
          {list.map((e) => (
            <button key={e.id} class={`kiosk-tile ${e.isIn ? 'in' : ''}`} onClick={() => setSel(e)}>
              <Avatar name={e.name} src={e.hasPhoto ? `/api/kiosk/employees/${e.id}/photo` : null} ver={e.photoVer} lg />
              <div class="kt-name">{nm(e)}</div>
              <div class="kt-sub ltr">{e.code}</div>
              <div class={`pill ${e.isIn ? 'st-present' : 'st-none'}`}>{e.isIn ? `${t('In')} ${e.checkIn ? fmtTime(e.checkIn) : ''}` : e.checkOut ? `${t('Out')} ${fmtTime(e.checkOut)}` : t('Not in')}</div>
            </button>
          ))}
        </div>
        <div class="center" style="margin:18px 0"><LangSwitch /></div>
      </div>
      {sel && <KioskPunch emp={sel} photoRequired={data?.photoRequired} onClose={() => setSel(null)} onDone={(r) => { setSel(null); setDone(r); setQ(''); load(); }} />}
      {done && (
        <div class="kiosk-done" onClick={() => setDone(null)}>
          <div class={`kd-icon ${done.type === 'in' ? 'in' : 'out'}`}><Icon n={done.type === 'in' ? 'in' : 'out'} /></div>
          <h1>{done.type === 'in' ? t('Checked in') : t('Checked out')}</h1>
          <div class="kd-name">{done.name}</div>
          <div class="kd-time ltr">{fmtTime(done.ts)}</div>
          {done.today?.lateMin > 0 && <div class="pill st-late" style="margin-top:10px">{t('Late {m} min', { m: done.today.lateMin })}</div>}
        </div>
      )}
      {exit && <ExitKiosk onClose={() => setExit(false)} onExit={onExit} />}
    </div>
  );
}

function KioskPunch({ emp, photoRequired, onClose, onDone }) {
  const video = useRef(null);
  const stream = useRef(null);
  const [cam, setCam] = useState('starting'); // starting | on | off
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const p = await AffordDevice.requestCamera().catch(() => ({ granted: true }));
        if (!p.granted) throw new Error('denied');
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 } }, audio: false });
        if (!live) { s.getTracks().forEach((tr) => tr.stop()); return; }
        stream.current = s;
        if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => {}); }
        setCam('on');
      } catch { if (live) setCam('off'); }
    })();
    return () => { live = false; stream.current?.getTracks().forEach((tr) => tr.stop()); };
  }, []);

  const snap = () => {
    const v = video.current;
    if (cam !== 'on' || !v || !v.videoWidth) return null;
    const w = 320;
    const hgt = Math.round((v.videoHeight / v.videoWidth) * w);
    const c = document.createElement('canvas');
    c.width = w; c.height = hgt;
    const g = c.getContext('2d');
    g.translate(w, 0); g.scale(-1, 1); // mirror like the preview
    g.drawImage(v, 0, 0, w, hgt);
    return c.toDataURL('image/jpeg', 0.6);
  };

  const submit = async (pin) => {
    setBusy(true);
    try {
      const photo = snap();
      const loc = await kioskLoc();
      const type = emp.isIn ? 'out' : 'in';
      const res = await api.post('/api/kiosk/punch', { employeeId: emp.id, pin, photo, type, loc, clientId: `k-${emp.id}-${Date.now()}` });
      onDone({ ...res, name: nm(emp) });
    } catch (e) {
      setErr({ at: Date.now() });
      toastErr(e);
    } finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} title={`${nm(emp)} · ${emp.isIn ? t('Check out') : t('Check in')}`}>
      <div class="kiosk-cam">
        <video ref={video} playsInline muted autoPlay style={cam === 'on' ? '' : 'display:none'} />
        {cam === 'starting' && <Spinner />}
        {cam === 'off' && <div class="small muted center"><Icon n="camera" /><br />{t('Camera not available')}</div>}
      </div>
      {cam === 'off' && photoRequired ? (
        <Banner kind="err">{t('The camera is needed for kiosk check-in. Allow camera for this app in phone settings.')}</Banner>
      ) : (
        <div>
          <div class="center muted small" style="margin-top:8px">{t('Look at the camera and enter your PIN')}</div>
          <PinPad length={4} max={6} onDone={submit} error={err?.at} busy={busy} />
        </div>
      )}
    </Sheet>
  );
}

function ExitKiosk({ onClose, onExit }) {
  const [login, setLogin] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const dev = await deviceInfo();
      const kioskToken = api.token;
      api.setToken(null);
      const res = await api.post('/api/admin/login', { login: login.trim().toLowerCase(), pin, deviceId: dev.deviceId, deviceName: dev.model }).catch((e) => { api.setToken(kioskToken); throw e; });
      // switch this phone off as a kiosk on the server too
      api.setToken(res.token);
      try {
        const { kiosks } = await api.get('/api/admin/kiosks');
        for (const k of kiosks.filter((x) => x.deviceId === dev.deviceId)) await api.del(`/api/admin/kiosks/${k.id}`);
      } catch { /* a manager without kiosk permission: the owner can remove it later */ }
      onExit(res);
    } catch (e) { toastErr(e); setPin(''); } finally { setBusy(false); }
  };
  return (
    <Dialog open title={t('Exit kiosk')} onClose={onClose}>
      <p class="small muted" style="margin:0 0 8px">{t('An admin or manager must log in to leave kiosk mode.')}</p>
      <Field label={t('Login name')}><input class="input ltr" style="width:100%" value={login} onInput={(e) => setLogin(e.currentTarget.value)} autocapitalize="off" /></Field>
      <Field label={t('PIN')}><input class="input ltr" style="width:100%" type="password" inputmode="numeric" maxLength={6} value={pin} onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))} /></Field>
      <div class="btn-row">
        <button class="btn ghost" onClick={onClose}>{t('Cancel')}</button>
        <button class="btn" disabled={busy || !login || pin.length < 4} onClick={submit}>{busy ? <Spinner sm /> : t('Exit')}</button>
      </div>
    </Dialog>
  );
}

// Shared UI building blocks for both apps.
import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t, getLang, setLang, errText, statusLabel } from './i18n.js';
import { api, LS } from './api.js';
import { AffordDevice } from 'afford-device';

// ---------------------------------------------------------------- icons (inline SVG, no third party)
const P = {
  back: 'M15 18l-6-6 6-6',
  fwd: 'M9 18l6-6-6-6',
  board: 'M4 5h7v7H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 14h7v5H4z',
  inbox: 'M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 3h4l1-3h5',
  users: 'M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7M21 19v-1a4 4 0 00-3-3.9M16 3.1a3.5 3.5 0 010 6.8',
  money: 'M3 7h18v10H3zM12 15a3 3 0 100-6 3 3 0 000 6M6 10v.01M18 14v.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14M20 20l-4-4',
  cal: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18M12 7v5l3 2',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 018 0v4',
  pin: 'M12 21s-7-6-7-11a7 7 0 0114 0c0 5-7 11-7 11zM12 12a2 2 0 100-4 2 2 0 000 4',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  report: 'M5 3h10l4 4v14H5zM14 3v5h5M8 13h8M8 17h5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  log: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  phone: 'M7 2h10v20H7zM11 18h2',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  iosshare: 'M12 3v12M8 7l4-4 4 4M6 11H5v10h14V11h-1',
  addsq: 'M4 4h16v16H4zM12 8v8M8 12h8',
  menu: 'M4 6h16M4 12h16M4 18h10',
  bell: 'M6 16v-5a6 6 0 0112 0v5l2 2H4zM10 21a2 2 0 004 0',
  call: 'M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8 9.8a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z',
  kiosk: 'M4 4h16v12H4zM8 20h8M12 16v4',
  logout: 'M15 4h4v16h-4M10 17l5-5-5-5M15 12H3',
  lang: 'M4 5h8M8 3v2M6 5c0 4 3 7 6 8M10 5c0 4-3 7-6 8M13 21l4-9 4 9M14.5 18h5',
  print: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z',
  share: 'M18 8a3 3 0 100-6 3 3 0 000 6M6 15a3 3 0 100-6 3 3 0 000 6M18 22a3 3 0 100-6 3 3 0 000 6M8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 100-8 4 4 0 000 8',
  finger: 'M12 11v4M8 14c0-3 1.5-6 4-6s4 2 4 5M5 12c0-4 3-7 7-7s7 3 7 7c0 3-1 5-2 7M9 20c1-2 1.5-4 1.5-6M15 21c.5-1.5 1-3.5 1-6',
  wifi: 'M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0M12 20h.01',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18M12 11v5M12 8h.01',
  warn: 'M12 3l10 18H2zM12 10v4M12 17h.01',
  key: 'M15 7a4 4 0 11-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0115 7z',
  refresh: 'M20 11a8 8 0 00-14.9-3M4 4v4h4M4 13a8 8 0 0014.9 3M20 20v-4h-4',
  coffee: 'M4 9h13v5a5 5 0 01-5 5H9a5 5 0 01-5-5zM17 10h1.5a2.5 2.5 0 010 5H17M8 3v3M12 3v3',
  in: 'M15 3h4v18h-4M10 17l5-5-5-5M15 12H3',
  out: 'M9 21H5V3h4M16 17l5-5-5-5M21 12H9',
  map: 'M9 4l6 2 5-2v14l-5 2-6-2-5 2V6zM9 4v14M15 6v14',
  wallet: 'M3 7h16v12H3zM3 7l12-4v4M16 13h.01',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3',
  leave: 'M4 20c4-1 6-4 6-8V4c3 2 6 6 6 10M4 20h16',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
};
export function Icon({ n, cls = '' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={cls} aria-hidden="true">
      <path d={P[n] || P.info} />
    </svg>
  );
}

// ---------------------------------------------------------------- toast
let toastSet = null;
export function toast(msg, kind = '') {
  if (toastSet) toastSet({ msg, kind, id: Date.now() });
}
export const toastErr = (e) => toast(errText(e), 'err');
export function ToastHost() {
  const [tst, setTst] = useState(null);
  toastSet = setTst;
  useEffect(() => {
    if (!tst) return undefined;
    const tm = setTimeout(() => setTst(null), tst.kind === 'err' ? 4500 : 2600);
    return () => clearTimeout(tm);
  }, [tst]);
  return tst ? <div class={`toast ${tst.kind}`} role="status">{tst.msg}</div> : null;
}

// ---------------------------------------------------------------- layout
export function TopBar({ title, back, right, logo }) {
  return (
    <header class="topbar">
      <div class="in">
        {back && (
          <button class="iconbtn" onClick={back === true ? goBack : back} aria-label={t('Back')}>
            <Icon n="back" cls="flip" />
          </button>
        )}
        {logo && <img class="logo-sm" src="./logo-mark.png" alt="" />}
        <h1>{title}</h1>
        {right}
      </div>
    </header>
  );
}

export function BottomNav({ items, active, onGo }) {
  return (
    <nav class="bottomnav">
      <div class="in">
        {items.map((it) => (
          <button key={it.key} class={active === it.key ? 'on' : ''} onClick={() => onGo(it.key)}>
            <Icon n={it.icon} />
            <span>{t(it.label)}</span>
            {it.badge > 0 && <span class="dot">{it.badge > 99 ? '99+' : it.badge}</span>}
          </button>
        ))}
      </div>
    </nav>
  );
}

export function Sheet({ open, onClose, title, children }) {
  useBackClose(open, onClose);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div class="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="grab" />
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

export function Dialog({ open, title, children, onClose }) {
  useBackClose(open, onClose);
  if (!open) return null;
  return (
    <div class="backdrop center" onClick={(e) => e.target === e.currentTarget && onClose && onClose()}>
      <div class="dialog" role="dialog" aria-modal="true">
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

/** Promise-based confirm dialog (no browser confirm()). */
let confirmSet = null;
export function confirmBox(opts) {
  return new Promise((resolve) => confirmSet && confirmSet({ ...opts, resolve }));
}
export function ConfirmHost() {
  const [c, setC] = useState(null);
  confirmSet = setC;
  if (!c) return null;
  const done = (v) => { setC(null); c.resolve(v); };
  return (
    <Dialog open title={c.title} onClose={() => done(false)}>
      {c.text && <p class="muted" style="margin:0 0 6px">{c.text}</p>}
      <div class="btn-row">
        <button class="btn ghost" onClick={() => done(false)}>{c.no || t('Cancel')}</button>
        <button class={`btn ${c.danger ? '' : 'green'}`} onClick={() => done(true)}>{c.yes || t('Yes')}</button>
      </div>
    </Dialog>
  );
}

/** Amount box that shows 30,000 while typing. onValue gets the plain number text ("30000"). */
export function MoneyInput({ value, onValue, decimal, style = 'width:100%', ...rest }) {
  const raw = value == null ? '' : String(value);
  const [i, d] = raw.split('.');
  const shown = i === '' && d == null ? '' : `${String(i || '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${d != null ? `.${d}` : ''}`;
  return (
    <input class="input ltr" style={style} type="text" inputmode={decimal ? 'decimal' : 'numeric'} autocomplete="off" value={shown} {...rest}
      onInput={(e) => {
        let v = e.currentTarget.value.replace(/[^\d.]/g, '');
        if (!decimal) v = v.replace(/\./g, '');
        else { const k = v.indexOf('.'); if (k >= 0) v = v.slice(0, k + 1) + v.slice(k + 1).replace(/\./g, '').slice(0, 2); }
        v = v.replace(/^0+(?=\d)/, '');
        onValue(v);
        const pretty = v === '' ? '' : v.split('.')[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (v.includes('.') ? `.${v.split('.')[1]}` : '');
        if (e.currentTarget.value !== pretty) e.currentTarget.value = pretty;
      }} />
  );
}

export function Field({ label, hint, children }) {
  return (
    <div class="field">
      {label && <label>{label}</label>}
      {children}
      {hint && <div class="hint">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- fingerprint
const BIO_CANCEL = [5, 10, 13]; // cancelled by the user or the "Use PIN" button
/** Shows the fingerprint prompt. Returns true if it worked; shows why if it failed. */
export async function askFinger(title) {
  const r = await AffordDevice.biometricAuth({ title, cancel: t('Use PIN') }).catch((e) => ({ ok: false, code: -1, error: e?.message }));
  if (!r.ok && !BIO_CANCEL.includes(r.code)) toast(`${t('Fingerprint did not work')}${r.error ? `: ${r.error}` : ''}`, 'err');
  return !!r.ok;
}

/** Settings switch: "Open with fingerprint". Tests the sensor when switched on. */
export function FingerToggle({ title }) {
  const [state, setState] = useState(null); // null = checking
  const [on, setOn] = useState(LS.get('afford.bio') === '1');
  useEffect(() => { AffordDevice.biometricAvailable().then((r) => setState(r)).catch(() => setState({ available: false })); }, []);
  if (!state) return null;
  if (!state.available) {
    return <p class="small muted" style="margin:10px 0 0"><Icon n="finger" /> {t('Fingerprint is not set up on this phone. Add a fingerprint in the phone Settings > Security, then open this page again.')}</p>;
  }
  const change = async (v) => {
    if (v && !(await askFinger(title))) return;
    setOn(v);
    LS.set('afford.bio', v ? '1' : '0');
    if (v) toast(t('Fingerprint is on'), 'ok');
  };
  return <div style="margin-top:10px"><Toggle checked={on} onChange={change} label={t('Open with fingerprint')} sub={t('Instead of typing your PIN')} /></div>;
}

export function Toggle({ checked, onChange, label, sub }) {
  return (
    <label class="switch">
      <div class="lbl">{label}{sub && <small>{sub}</small>}</div>
      <span class="toggle">
        <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.currentTarget.checked)} />
        <span />
      </span>
    </label>
  );
}

export function Seg({ value, options, onChange }) {
  return (
    <div class="seg">
      {options.map(([v, label]) => (
        <button key={v} type="button" class={value === v ? 'on' : ''} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

export function Chips({ value, options, onChange }) {
  return (
    <div class="chips">
      {options.map(([v, label]) => (
        <button key={v} type="button" class={`chip ${value === v ? 'on' : ''}`} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

export const Spinner = ({ sm }) => <div class={`spinner ${sm ? 'sm' : ''}`} />;
export const Empty = ({ icon = 'inbox', text }) => (
  <div class="empty"><Icon n={icon} /><div>{text}</div></div>
);
export const Pill = ({ s, children }) => <span class={`pill st-${s}`}>{children || statusLabel(s)}</span>;
export function Banner({ kind = 'info', icon, children }) {
  return <div class={`banner ${kind}`}><Icon n={icon || (kind === 'warn' ? 'warn' : kind === 'err' ? 'warn' : 'info')} /><div>{children}</div></div>;
}

// ---------------------------------------------------------------- avatar with authenticated photo
const photoCache = new Map();
export function Avatar({ name, src, lg, ver }) {
  const [url, setUrl] = useState(src && photoCache.get(`${src}|${ver}`));
  useEffect(() => {
    if (!src) { setUrl(null); return; }
    const key = `${src}|${ver}`;
    if (photoCache.has(key)) { setUrl(photoCache.get(key)); return; }
    let live = true;
    api.image(src).then((u) => { photoCache.set(key, u); if (live) setUrl(u); }).catch(() => {});
    return () => { live = false; };
  }, [src, ver]);
  const initials = String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return <div class={`avatar ${lg ? 'lg' : ''}`}>{url ? <img src={url} alt="" /> : initials}</div>;
}

// ---------------------------------------------------------------- login: "who is logging in" card
export function WhoCard({ name, sub, onChange }) {
  const ini = String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div class="who">
      <div class="who-av">{ini}</div>
      <div class="who-main"><b class="ltr">{name}</b>{sub && <span>{sub}</span>}</div>
      {onChange && <button class="who-ch" onClick={onChange}>{t('Change')}</button>}
    </div>
  );
}

// ---------------------------------------------------------------- PIN pad
export function PinPad({ length = 4, max = 6, onDone, error, busy, extra }) {
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);
  useEffect(() => {
    if (error) { setShake(true); setPin(''); const tm = setTimeout(() => setShake(false), 450); return () => clearTimeout(tm); }
    return undefined;
  }, [error]);
  const press = (d) => {
    if (busy) return;
    if (d === 'del') return setPin((p) => p.slice(0, -1));
    if (d === 'ok') { if (pin.length >= length) onDone(pin); return; }
    const next = (pin + d).slice(0, max);
    setPin(next);
    if (max === length && next.length === length) setTimeout(() => onDone(next), 120);
  };
  useEffect(() => {
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter') press('ok');
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  const dots = Math.max(length, pin.length);
  return (
    <div>
      <div class={`pin-dots ${shake ? 'shake' : ''}`}>
        {Array.from({ length: dots }, (_, i) => <i key={i} class={i < pin.length ? 'on' : ''} />)}
      </div>
      <div class="pinpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} onClick={() => press(d)}>{d}</button>)}
        {extra || <button class="fn" onClick={() => press('ok')} disabled={pin.length < length}>{max > length ? t('OK') : ''}</button>}
        <button onClick={() => press('0')}>0</button>
        <button class="fn" onClick={() => press('del')} aria-label={t('Delete')}><Icon n="back" /></button>
      </div>
      {busy && <Spinner />}
    </div>
  );
}

// ---------------------------------------------------------------- language switch
export function LangSwitch({ onChange }) {
  return (
    <div class="seg" style="width:150px">
      <button class={getLang() === 'en' ? 'on' : ''} onClick={() => { setLang('en'); onChange && onChange('en'); }}>English</button>
      <button class={getLang() === 'ur' ? 'on' : ''} style="font-family:Naskh,serif" onClick={() => { setLang('ur'); onChange && onChange('ur'); }}>اردو</button>
    </div>
  );
}

// ---------------------------------------------------------------- version + developer credit
export const BUILD_TEXT = `v${__APP_VERSION__}${__APP_BUILD__ ? ` · build ${__APP_BUILD__}` : ''}`;
export function Credit({ app }) {
  const [dev, setDev] = useState(false);
  return (
    <Fragment>
      <p class="credit">
        {app && <span>{app} </span>}<span class="ltr">{BUILD_TEXT}</span>
        <button type="button" class="by" onClick={() => setDev(true)}>by <b>Innovative Layyah</b></button>
      </p>
      {dev && <DevSheet onClose={() => setDev(false)} />}
    </Fragment>
  );
}

// ---------------------------------------------------------------- developer details (tap the credit)
const DEV = {
  org: 'Innovative Layyah', person: 'Abdullah Farooq', city: 'Layyah, Punjab',
  phone: '0303 6763939', tel: '+923036763939', wa: '923036763939', email: 'abdullah6763939@gmail.com',
};
const WA_PATH = 'M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1112 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 01-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 00-.7.3 3 3 0 00-.9 2.2 5.2 5.2 0 001.1 2.7 11.8 11.8 0 004.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 001.8-1.2 2.2 2.2 0 00.2-1.3c-.1-.1-.3-.2-.5-.3z';
const openLink = (url) => AffordDevice.openUrl({ url }).catch(() => window.open(url, '_blank'));
export function DevSheet({ onClose }) {
  return (
    <Sheet open onClose={onClose}>
      <div class="devcard">
        <svg class="devcard-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6l-6 6 6 6M16 6l6 6-6 6M14 3l-4 18" /></svg>
        <div class="devcard-head">
          <div class="devcard-logo"><img src="./dev-logo.png" alt="" /></div>
          <div><div class="devcard-org">{DEV.org}</div><div class="devcard-tag">{t('Apps · Websites · Software')}</div></div>
        </div>
        <div class="devcard-name">{DEV.person}</div>
        <div class="devcard-role">{t('App & web developer')}</div>
        <div class="devcard-rows">
          <div><Icon n="call" /><span class="ltr">{DEV.phone}</span></div>
          <div><Icon n="mail" /><span class="ltr">{DEV.email}</span></div>
          <div><Icon n="pin" /><span>{t(DEV.city)}</span></div>
        </div>
      </div>
      <div class="devbtns">
        <button class="wa" onClick={() => openLink(`https://wa.me/${DEV.wa}`)}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={WA_PATH} /></svg>WhatsApp</button>
        <button onClick={() => openLink(`tel:${DEV.tel}`)}><Icon n="call" />{t('Call')}</button>
        <button onClick={() => openLink(`mailto:${DEV.email}`)}><Icon n="mail" />{t('Email')}</button>
      </div>
      <p class="devfoot"><span class="ltr">Afford Attendance {BUILD_TEXT}</span> · {t('Made in Layyah')}</p>
    </Sheet>
  );
}

// ---------------------------------------------------------------- splash
const GLEAM = { WebkitMaskImage: 'url(./logo.png)', maskImage: 'url(./logo.png)' };
export function Splash({ title, sub, onDone, minMs = 3100 }) {
  const [out, setOut] = useState(false);
  useEffect(() => {
    const t1 = setTimeout(() => setOut(true), minMs);
    const t2 = setTimeout(() => onDone && onDone(), minMs + 500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);
  return (
    <div class={`splash ${out ? 'out' : ''}`}>
      <div class="sp-glow" />
      <div class="sp-logo" role="img" aria-label={title}>
        <img class="sp-a" src="./sp-a.png" alt="" />
        <div class="sp-fford-wrap"><img class="sp-fford" src="./sp-fford.png" alt="" /></div>
        <img class="sp-super" src="./sp-super.png" alt="" />
        <div class="sp-sweep" />
        <img class="sp-dot" src="./sp-dot.png" alt="" />
        <div class="sp-dot-ring" />
        <div class="sp-gleam" style={GLEAM} />
      </div>
      <p class="sp-sub">{sub}</p>
      <div class="sp-bar"><i style={`animation-duration:${minMs - 300}ms`} /></div>
      <div class="sp-foot">
        <span class="ltr">{BUILD_TEXT}</span>
        <span>by <b>Innovative Layyah</b></span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- hash router
export function useRoute() {
  const parse = () => {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    const parts = path.split('/').filter(Boolean);
    return { parts, q: new URLSearchParams(qs || '') };
  };
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => setR(parse());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return r;
}
// Each in-app page change keeps a depth number in the history entry, so "back" knows
// whether there is an app page to go back to.
const depth = () => (history.state && history.state.d) || 0;
export const go = (path) => {
  if (location.hash === `#/${path}`) return;
  history.pushState({ d: depth() + 1 }, '', `#/${path}`);
  dispatchEvent(new HashChangeEvent('hashchange'));
};
export const replace = (path) => { history.replaceState({ d: depth() }, '', `#/${path}`); dispatchEvent(new HashChangeEvent('hashchange')); };

// ---------------------------------------------------------------- back button (Android and the top bar)
const backStack = []; // close handlers of open sheets/dialogs, last = on top
let homeRoute = 'home';
let inApp = false;
let lastBackAt = 0;
export function setBackHome(route, appOpen) { homeRoute = route; inApp = appOpen; }

/** Closes a sheet/dialog with the back button while it is open. */
export function useBackClose(open, onClose) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const h = () => ref.current && ref.current();
    backStack.push(h);
    return () => { const i = backStack.lastIndexOf(h); if (i >= 0) backStack.splice(i, 1); };
  }, [open]);
}

/** Back one step: close the top sheet, else the previous app page, else the home page, else leave the app. */
export function goBack() {
  if (backStack.length) { backStack[backStack.length - 1](); return; }
  const cur = location.hash.replace(/^#\/?/, '').split('?')[0];
  if (inApp && depth() > 0) { history.back(); return; }
  if (inApp && cur && cur !== homeRoute) { replace(homeRoute); return; }
  if (Date.now() - lastBackAt < 2000) { lastBackAt = 0; AffordDevice.minimize().catch(() => {}); return; }
  lastBackAt = Date.now();
  toast(t('Press back again to close'));
}
AffordDevice.addListener('backButton', goBack);
addEventListener('afford:back', goBack); // used by browser tests

/** Simple async loader hook */
export function useLoad(fn, deps = []) {
  const [st, setSt] = useState({ loading: true, data: null, error: null });
  const seq = useRef(0);
  const run = async (quiet) => {
    const my = ++seq.current;
    if (!quiet) setSt((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fn();
      if (my === seq.current) setSt({ loading: false, data, error: null });
    } catch (e) {
      if (my === seq.current) setSt((s) => ({ loading: false, data: s.data, error: e }));
    }
  };
  useEffect(() => { run(); }, deps);
  return { ...st, reload: run };
}

export function Loader({ st, children }) {
  if (st.loading && !st.data) return <Spinner />;
  if (st.error && !st.data) return (
    <div class="empty">
      <Icon n="wifi" />
      <div>{errText(st.error)}</div>
      <button class="btn small ghost" style="margin-top:12px" onClick={() => st.reload()}>{t('Try again')}</button>
    </div>
  );
  return children(st.data);
}

export { h, Fragment };

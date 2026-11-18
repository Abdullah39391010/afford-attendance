// Staff app: Today screen with the big check-in / check-out button, break, leave and deposit.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { api, LS } from '../shared/api.js';
import { t, nm, reqLabel, getLang } from '../shared/i18n.js';
import { fmtTime, fmtDur, fmtDate, fmtMoney, todayStr } from '../shared/format.js';
import { TopBar, Icon, Pill, Sheet, Field, toast, toastErr, confirmBox, Banner, Spinner, Chips, go, Avatar } from '../shared/ui.jsx';
import { enqueue } from '../shared/offline.js';
import { describe } from '../shared/describe.js';
import { useEmp } from './app.jsx';
import { HomeExtras, WebInstallHint } from './extra.jsx';

/** distance in metres */
function metres(a, b) {
  const R = 6371000;
  const r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Ask for GPS (turn it on if needed) and get a fresh position. */
export async function getLoc() {
  try { await AffordDevice.ensureGps(); } catch (e) { throw Object.assign(new Error('GPS_OFF'), { code: 'GPS_OFF' }); }
  try {
    const l = await AffordDevice.getLocation({ timeoutMs: 20000 });
    return { lat: l.lat, lng: l.lng, acc: l.acc, mock: !!l.mock };
  } catch (e) {
    const code = /PERMISSION/.test(e.message || e.code || '') ? 'PERMISSION_DENIED' : 'NO_FIX';
    throw Object.assign(new Error(code), { code });
  }
}

export function Home() {
  const E = useEmp();
  const { home } = E;
  const [now, setNow] = useState(api.serverNow());
  const [busy, setBusy] = useState(null);
  const [breakSheet, setBreakSheet] = useState(false);
  useEffect(() => { const iv = setInterval(() => setNow(api.serverNow()), 15000); return () => clearInterval(iv); }, []);

  const emp = home.employee;
  const d = home.today;
  const store = home.store;
  const cur = store.currency;
  const isIn = !!d.isOpen;
  const worked = d.checkIn ? (isIn ? Math.max(0, Math.floor((now - d.checkIn) / 60000) - (d.breakMin || 0) - (d.awayMin || 0)) : d.workedMin) : 0;
  const onBreak = d.onBreak;

  const win = home.window || {};
  const tooEarly = !isIn && !d.checkOut && win.opensTs && now < win.opensTs;
  const punch = async () => {
    const type = isIn ? 'out' : 'in';
    if (type === 'in' && win.opensTs && api.serverNow() < win.opensTs && !d.checkOut) {
      toast(t('Check-in opens at {t}.', { t: fmtTime(win.opensTs) }), 'err');
      return;
    }
    if (type === 'out') {
      const early = win.endTs ? Math.ceil((win.endTs - api.serverNow()) / 60000) : 0;
      const ok = early > 0
        ? await confirmBox({ title: t('Leave before your shift ends?'), text: t('Your shift ends at {t}. Leaving now cuts {m} from your salary. Check out anyway?', { t: fmtTime(win.endTs), m: fmtDur(early) }), yes: t('Yes, check out'), danger: true })
        : await confirmBox({ title: t('Check out now?'), text: t('Your work time for today will end. If you are only going for a break, use "Take a break" instead.'), yes: t('Yes, check out'), danger: true });
      if (!ok) return;
    }
    setBusy(type);
    let loc = null;
    try {
      loc = await getLoc();
      if (loc.mock) throw Object.assign(new Error('MOCK_LOCATION'), { code: 'MOCK_LOCATION' });
      const res = await api.post('/api/emp/punch', { type, loc, clientId: `a-${Date.now()}` });
      toast(type === 'in' ? `${t('Checked in')} ${fmtTime(res.ts)}` : `${t('Checked out')} ${fmtTime(res.ts)}`, 'ok');
      if (res.today?.lateMin > 0) toast(t('Late {m} min', { m: res.today.lateMin }), 'err');
      await E.loadHome();
    } catch (e) {
      if (e.code === 'NETWORK' && loc) {
        // no internet: check the circle on the phone and save the punch for later
        const anywhere = type === 'in' ? emp.fieldStaff || !store.rules.requireInRadiusCheckIn : emp.checkoutAnywhere;
        const near = store.locations.some((L) => metres(loc, L) - Math.min(loc.acc || 0, 50) <= L.radius);
        if (!anywhere && !near) { toast(t('You are outside the store circle.'), 'err'); return; }
        const p = enqueue({ type, loc });
        const today = { ...d, isOpen: type === 'in', checkIn: type === 'in' ? d.checkIn || p.offlineTs : d.checkIn, checkOut: type === 'out' ? p.offlineTs : null };
        const next = { ...home, today };
        LS.set('afford.home', JSON.stringify(next));
        E.loadHome(); // keeps cached copy if offline
        toast(t('No internet. Saved on this phone. It is sent by itself when the phone gets any Wi-Fi or internet.'), 'ok');
        E.setOnline(false);
        Object.assign(home, next);
      } else toastErr(e);
    } finally { setBusy(null); }
  };

  const endBreak = async () => {
    setBusy('break');
    try {
      const r = await api.post('/api/emp/break/end');
      toast(r.lateMin > 0 ? t('Break ended · {m} min late', { m: r.lateMin }) : t('Welcome back!'), r.lateMin > 0 ? 'err' : 'ok');
      await E.loadHome();
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };

  const pending = home.pendingRequests || [];
  const rc = home.recheckin; // set when checked out today: re-check-in needs approval
  const rcOk = rc?.status === 'approved';
  const [rcSheet, setRcSheet] = useState(false);
  const breakPending = pending.find((r) => r.type === 'break');
  const leave = home.leave || {};
  const dueLeft = onBreak ? Math.ceil((onBreak.due - now) / 60000) : 0;
  const hour = Number(new Date(now + store.tzOffsetMin * 60000).getUTCHours());
  const greet = hour < 12 ? t('Good morning') : hour < 17 ? t('Good afternoon') : t('Good evening');

  return (
    <div class="screen">
      <TopBar logo title={store.name || 'Afford Super Store'} />
      <div class="wrap">
        <div class="card gap" style="margin-top:12px">
          <Avatar name={emp.name} src={emp.hasPhoto ? '/api/emp/photo' : null} ver={emp.photoVer} />
          <div class="grow">
            <div class="small muted">{greet}</div>
            <b style="font-size:17px">{nm(emp)}</b>
            <div class="small muted">{getLang() === 'ur' && emp.roleUr ? emp.roleUr : emp.role} · <span class="ltr">{emp.code}</span>{emp.branch ? ` · ${emp.branch}` : ''}</div>
          </div>
        </div>
        <WebInstallHint />
        <HomeExtras />

        <div class={`today-card ${isIn ? (onBreak ? 'brk' : 'in') : d.checkOut ? 'done' : ''}`}>
          <div class="small" style="opacity:.85">{fmtDate(d.date || todayStr(now))}</div>
          <div class="tc-shift">{t('Shift')} {nm(emp.shift)} · <span class="ltr">{emp.shift.start}–{emp.shift.end}</span>{emp.normalShift && emp.normalShift.id !== emp.shift.id ? ` · ${t('from roster')}` : ''}</div>
          <div class="tc-status">
            {onBreak ? t('On break') : isIn ? t('You are checked in') : d.checkOut ? t('Day finished') : t('Not checked in yet')}
          </div>
          {d.checkIn && (
            <div class="tc-times">
              <div><span>{t('In')}</span><b class="ltr">{fmtTime(d.checkIn)}</b></div>
              <div><span>{t('Out')}</span><b class="ltr">{d.checkOut ? fmtTime(d.checkOut) : '—'}</b></div>
              <div><span>{t('Worked')}</span><b>{fmtDur(worked)}</b></div>
            </div>
          )}
          {d.lateMin > 0 && <div class="pill st-late" style="margin-top:8px">{t('Late {m} min', { m: d.lateMin })}</div>}
          {d.awayMin > 0 && <div class="small" style="opacity:.9;margin-top:6px">{t('Away {m} min between check-out and check-in (counted as late)', { m: d.awayMin })}</div>}
          {!d.checkIn && store.rules.lateGraceMin > 0 && <div class="small" style="opacity:.85;margin-top:6px">{t('Check in before {t} to be on time.', { t: addMin(emp.shift.start, store.rules.lateGraceMin) })}</div>}
        </div>

        {onBreak ? (
          <div class="card center">
            <div class="small muted">{t('Break ends at')} <b class="ltr">{fmtTime(onBreak.due)}</b></div>
            <div class={`brk-left ${dueLeft < 0 ? 'late' : ''}`}>{dueLeft >= 0 ? t('{m} min left', { m: dueLeft }) : t('{m} min late', { m: -dueLeft })}</div>
            <button class="btn block green big" disabled={!!busy} onClick={endBreak}>{busy === 'break' ? <Spinner sm /> : <><Icon n="check" />{t("I'm back from break")}</>}</button>
          </div>
        ) : (
          <div>
            {!isIn && d.checkOut ? (
              rcOk ? (
                <div>
                  <Banner kind="ok" icon="check">{t('Approved. You can check in again. The time you were away counts as late.')}</Banner>
                  <button class="btn block" style="margin-top:10px" disabled={!!busy} onClick={punch}>{busy ? <Spinner sm /> : <><Icon n="in" />{t('Check in again')}</>}</button>
                </div>
              ) : rc?.status === 'pending' ? (
                <Banner kind="info" icon="clock">{t('Check-in request sent. Waiting for the admin or manager.')} {t('When it is approved, your time counts from when you asked.')}</Banner>
              ) : (
                <div>
                  {rc?.status === 'declined' && <Banner kind="err" icon="x">{t('Your request to check in again was declined.')}{rc.note ? ` ${rc.note}` : ''}</Banner>}
                  <button class="btn block ghost" style="margin-top:14px" onClick={() => setRcSheet(true)}><Icon n="in" />{t('Ask to check in again')}</button>
                </div>
              )
            ) : (
              <button class={`punch-btn ${isIn ? 'out' : 'in'}${tooEarly ? ' wait' : ''}`} disabled={!!busy} onClick={punch}>
                {busy === 'in' || busy === 'out' ? <Spinner /> : <><Icon n={isIn ? 'out' : 'in'} /><span>{isIn ? t('Check out') : t('Check in')}</span></>}
              </button>
            )}
            {tooEarly && <p class="center small" style="margin:6px 0 0;font-weight:600"><Icon n="clock" /> {t('Check-in opens at {t}.', { t: fmtTime(win.opensTs) })}</p>}
            {!(!isIn && d.checkOut) && <p class="center small muted" style="margin:6px 0 0">
              {isIn && emp.checkoutAnywhere ? t('You can check out from anywhere.') : isIn ? t('You must be inside the store to check out.') : emp.fieldStaff ? t('Field staff: you can check in from anywhere. Your location is saved.') : t('You must be inside the store to check in.')}
            </p>}
            {!isIn && d.checkOut && <p class="center small muted" style="margin:6px 0 0">{t('You checked out at {t}. To come back today, the admin or manager must allow it.', { t: fmtTime(d.checkOut) })}</p>}
            {isIn && (
              breakPending
                ? <Banner kind="info" icon="coffee">{t('Break request sent. Waiting for the admin or manager.')}</Banner>
                : <button class="btn block ghost" style="margin-top:12px" disabled={home.today.breakLeftMin <= 0} onClick={() => setBreakSheet(true)}>
                  <Icon n="coffee" />{t('Take a break')} · {t('{m} min left today', { m: home.today.breakLeftMin })}
                </button>
            )}
          </div>
        )}

        {emp.helperCount > 0 && (
          <button class="btn block soft" style="margin-top:12px" onClick={() => go('helper')}><Icon n="users" />{t('Check in other staff ({n})', { n: emp.helperCount })}</button>
        )}

        <div class="two" style="margin-top:12px">
          <div class="card mini">
            <div class="small muted">{t('Leave left this month')}</div>
            <b class="big-num">{leave.left ?? 0} <span class="small muted">/ {leave.quota ?? 0}</span></b>
            <button class="link small" onClick={() => go('requests?new=leave')}>{t('Ask for leave')}</button>
          </div>
          <div class="card mini">
            <div class="small muted">{t('Security deposit')}</div>
            <b class="big-num">{fmtMoney(home.depositBalance || 0, cur)}</b>
            <button class="link small" onClick={() => go('pay')}>{t('See salary')}</button>
          </div>
        </div>

        {pending.length > 0 && (
          <div>
            <div class="section-title">{t('Waiting for approval')}</div>
            <div class="list">
              {pending.map((r) => (
                <div key={r.id} class="row">
                  <div class="main"><div class="title">{reqLabel(r.type)}</div><div class="sub">{describe(r, cur)}</div></div>
                  <Pill s="pending">{t('Waiting')}</Pill>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {rcSheet && <RecheckinSheet outTs={d.checkOut} onClose={() => setRcSheet(false)} onDone={() => { setRcSheet(false); E.loadHome(); }} />}
      {breakSheet && <BreakSheet left={home.today.breakLeftMin} needsApproval={store.rules.breakNeedsApproval} onClose={() => setBreakSheet(false)} onDone={() => { setBreakSheet(false); E.loadHome(); }} />}
    </div>
  );
}

function addMin(hm, m) {
  const [a, b] = hm.split(':').map(Number);
  const x = (a * 60 + b + m) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
}

function BreakSheet({ left, needsApproval, onClose, onDone }) {
  const opts = [10, 15, 20, 30, 45, 60].filter((m) => m <= left);
  const [min, setMin] = useState(String(opts.includes(15) ? 15 : opts[opts.length - 1] || left));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/emp/requests', { type: 'break', minutes: Number(min), reason });
      toast(r.started ? t('Break started. Come back on time.') : t('Break request sent. Waiting for the admin or manager.'), 'ok');
      onDone();
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title={t('Take a break')}>
      <p class="small muted" style="margin:0 0 10px">{t('You have {m} minutes of break left today. Coming back late is cut from salary.', { m: left })}</p>
      <Field label={t('How long?')}>
        <Chips value={min} onChange={setMin} options={(opts.length ? opts : [left]).map((m) => [String(m), t('{m} min', { m })])} />
      </Field>
      <Field label={t('Reason (optional)')}><input class="input" value={reason} onInput={(e) => setReason(e.currentTarget.value)} placeholder={t('e.g. Lunch, prayer')} /></Field>
      <button class="btn block" disabled={busy} onClick={send}>{busy ? <Spinner sm /> : needsApproval ? t('Send to admin / manager') : t('Start break')}</button>
    </Sheet>
  );
}

function RecheckinSheet({ outTs, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const loc = await getLoc();
      if (loc.mock) throw Object.assign(new Error('MOCK_LOCATION'), { code: 'MOCK_LOCATION' });
      await api.post('/api/emp/requests', { type: 'recheckin', reason, loc });
      toast(t('Check-in request sent. Waiting for the admin or manager.'), 'ok');
      onDone();
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title={t('Ask to check in again')}>
      <p class="small muted" style="margin:0 0 10px">{t('You checked out at {t}. If approved, the time between your check-out and new check-in is counted as late and cut from salary.', { t: fmtTime(outTs) })}</p>
      <Field label={t('Reason')}><input class="input" value={reason} onInput={(e) => setReason(e.currentTarget.value)} placeholder={t('e.g. Came back for evening rush')} /></Field>
      <button class="btn block" disabled={busy} onClick={send}>{busy ? <Spinner sm /> : t('Send to admin / manager')}</button>
    </Sheet>
  );
}

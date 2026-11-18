// Settings: store, location (GPS), shifts, roles, rules, holidays; managers and permissions.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { api } from '../shared/api.js';
import { t, nm, errText } from '../shared/i18n.js';
import { dayShort, fmtDate, todayStr, addDays } from '../shared/format.js';
import { TopBar, Icon, Field, Toggle, Seg, Sheet, Loader, useLoad, toast, toastErr, go, Spinner, Empty, confirmBox, Banner, Pill } from '../shared/ui.jsx';
import { useApp } from './app.jsx';
import { resizePhoto } from './staff.jsx';
import { SignaturePad } from './ops.jsx';
import { SigImage } from '../shared/statement.jsx';
import { pakistanHolidays, PK_YEARS } from './extra.jsx';

function useSave() {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const save = async (patch, msg = t('Saved')) => {
    setBusy(true);
    try { await api.put('/api/admin/settings', patch); await app.reloadSettings(); toast(msg, 'ok'); return true; } catch (e) { toastErr(e); return false; } finally { setBusy(false); }
  };
  return [save, busy];
}

export function SettingsHome() {
  const app = useApp();
  const s = app.settings;
  const items = [
    ['store', 'gear', 'Store', `${s.storeName} · ${t('logo, weekly off')}`],
    ['location', 'pin', 'Store location', s.locations.length ? t('{n} location(s) set', { n: s.locations.length }) : t('Not set yet — staff cannot check in')],
    ['shifts', 'clock', 'Shifts', s.shifts.map((x) => `${nm(x)} ${x.start}–${x.end}`).join(' · ')],
    ['roles', 'users', 'Roles', t('{n} roles', { n: s.roles.length })],
    ['rules', 'shield', 'Rules', t('Late, break, leave, cuts')],
    ['holidays', 'cal', 'Holidays', t('{n} holidays', { n: s.holidays.length })],
  ];
  return (
    <div class="screen">
      <TopBar back title={t('Settings')} />
      <div class="wrap">
        {!s.locations.length && <Banner kind="warn">{t('Set the store location first. Without it nobody can check in.')}</Banner>}
        <div class="list">
          {items.map(([k, icon, label, sub]) => (
            <button key={k} class="row" onClick={() => go(`settings/${k}`)}>
              <Icon n={icon} /><div class="main"><div class="title">{t(label)}</div><div class="sub">{sub}</div></div><Icon n="fwd" cls="flip" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One PIN that every new employee gets automatically. Staff can change it later in the staff app. */
function DefaultPinCard() {
  const [pin, setPin] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/api/admin/default-pin').then((r) => setPin(r.pin || '')).catch(() => setPin('')); }, []);
  const save = async () => {
    if (pin && !/^\d{4,6}$/.test(pin)) return toast(t('PIN must be 4 to 6 digits.'), 'err');
    setBusy(true);
    try { await api.put('/api/admin/default-pin', { pin }); toast(pin ? t('Default PIN saved') : t('Default PIN turned off'), 'ok'); } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  return (
    <div class="card">
      <h2>{t('Default PIN for new staff')}</h2>
      <Field hint={t('Every new employee gets this PIN automatically. Leave empty to type a PIN for each person. Staff can change their PIN in the staff app.')}>
        <input class="input ltr" style="width:100%" inputmode="numeric" maxLength={6} value={pin ?? ''} disabled={pin === null} onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))} />
      </Field>
      <button class="btn block" disabled={busy || pin === null} onClick={save}>{busy ? <Spinner sm /> : t('Save')}</button>
    </div>
  );
}

/** Owner draws the authorised signature once; payslips add it after the employee signs for the salary. */
function AuthSigCard() {
  const [cur, setCur] = useState(undefined);
  const [draw, setDraw] = useState(false);
  const [sig, setSig] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/api/admin/auth-signature').then((r) => setCur(r.signature)).catch(() => setCur(null));
  useEffect(() => { load(); }, []);
  const save = async (value) => {
    setBusy(true);
    try { await api.put('/api/admin/auth-signature', { signature: value }); toast(value ? t('Signature saved') : t('Signature removed'), 'ok'); setDraw(false); setSig(null); load(); } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  return (
    <div class="card">
      <h2>{t('Authorised signature')}</h2>
      <p class="small muted" style="margin:0 0 8px">{t('Sign once. When an employee signs for their salary, the payslip adds this signature next to theirs.')}</p>
      {cur === undefined ? <Spinner /> : draw ? (
        <div>
          <SignaturePad onChange={setSig} />
          <div class="two" style="margin-top:8px">
            <button class="btn ghost" onClick={() => { setDraw(false); setSig(null); }}>{t('Cancel')}</button>
            <button class="btn" disabled={busy || !sig} onClick={() => save(sig)}>{busy ? <Spinner sm /> : t('Save')}</button>
          </div>
        </div>
      ) : (
        <div>
          {cur && <SigImage src={cur} label={t('Current signature')} />}
          <div class="two" style="margin-top:10px">
            <button class="btn ghost" onClick={() => setDraw(true)}><Icon n="edit" />{cur ? t('Sign again') : t('Add signature')}</button>
            {cur && <button class="btn ghost" disabled={busy} onClick={async () => { if (await confirmBox({ title: t('Remove the authorised signature?'), yes: t('Remove'), danger: true })) save(''); }}>{t('Remove')}</button>}
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsStore() {
  const app = useApp();
  const s = app.settings;
  const [f, setF] = useState({ storeName: s.storeName, storeNameUr: s.storeNameUr || '', currency: s.currency, weeklyOff: s.weeklyOff, storeAddress: s.storeAddress || '', storePhone: s.storePhone || '' });
  const [save, busy] = useSave();
  const uploadLogo = async (e) => {
    const file = e.currentTarget.files[0];
    if (!file) return;
    try {
      const data = await resizePhoto(file, 400);
      await api.put('/api/admin/logo', { dataUrl: data });
      toast(t('Logo saved'), 'ok');
    } catch (err) { toastErr(err); }
  };
  return (
    <div class="screen">
      <TopBar back title={t('Store')} />
      <div class="wrap">
        <div class="card">
          <Field label={t('Store name')}><input class="input" value={f.storeName} onInput={(e) => setF({ ...f, storeName: e.currentTarget.value })} /></Field>
          <Field label={t('Store name in Urdu (optional)')}><input class="input" dir="rtl" style="font-family:Naskh,serif" value={f.storeNameUr} onInput={(e) => setF({ ...f, storeNameUr: e.currentTarget.value })} /></Field>
          <Field label={t('Currency')}><input class="input ltr" style="width:100%" value={f.currency} onInput={(e) => setF({ ...f, currency: e.currentTarget.value })} /></Field>
          <Field label={t('Address (shown on payslips)')}><input class="input" value={f.storeAddress} onInput={(e) => setF({ ...f, storeAddress: e.currentTarget.value })} /></Field>
          <Field label={t('Phone (shown on payslips)')}><input class="input ltr" style="width:100%" value={f.storePhone} onInput={(e) => setF({ ...f, storePhone: e.currentTarget.value })} /></Field>
          <Field label={t('Weekly off (store default)')} hint={t('Each employee can have their own days.')}>
            <div class="chips">
              {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                <button key={d} type="button" class={`chip ${f.weeklyOff.includes(d) ? 'on' : ''}`}
                  onClick={() => setF({ ...f, weeklyOff: f.weeklyOff.includes(d) ? f.weeklyOff.filter((x) => x !== d) : [...f.weeklyOff, d] })}>{dayShort(d)}</button>
              ))}
            </div>
          </Field>
          <button class="btn block" disabled={busy} onClick={() => save(f)}>{t('Save')}</button>
        </div>
        {app.can('employees.edit') && <DefaultPinCard />}
        {app.me.role === 'owner' && <AuthSigCard />}
        <div class="card gap">
          <img src="./logo.png" alt="" style="width:96px;height:auto;flex:none" />
          <div class="grow"><b>{t('Logo')}</b><div class="small muted">{t('Used on printouts and the owner page.')}</div></div>
          <label class="btn small ghost"><Icon n="edit" />{t('Change')}<input type="file" accept="image/*" style="display:none" onChange={uploadLogo} /></label>
        </div>
      </div>
    </div>
  );
}

export function SettingsLocation() {
  const app = useApp();
  const [locs, setLocs] = useState(app.settings.locations.map((l) => ({ ...l })));
  const [busyGps, setBusyGps] = useState(null);
  const [save, busy] = useSave();
  const useMine = async (i) => {
    setBusyGps(i);
    try {
      const p = await AffordDevice.getLocation({ timeoutMs: 25000 });
      if (p.mock) toast(t('Fake GPS detected. Turn it off.'), 'err');
      const next = [...locs];
      if (i === -1) next.push({ name: next.length ? t('Branch {n}', { n: next.length + 1 }) : t('Main store'), lat: p.lat, lng: p.lng, radius: 100 });
      else next[i] = { ...next[i], lat: p.lat, lng: p.lng };
      setLocs(next);
      toast(t('Location found (accuracy {m} m)', { m: Math.round(p.acc || 0) }), 'ok');
    } catch (e) { toast(errText({ code: e.code || e.message }), 'err'); } finally { setBusyGps(null); }
  };
  const upd = (i, k, v) => setLocs(locs.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <div class="screen">
      <TopBar back title={t('Store location')} />
      <div class="wrap">
        <Banner kind="info">{t('Stand inside the store and tap "Use my current location". Staff can check in only inside the circle.')}</Banner>
        <p class="small muted" style="margin:0 4px 10px">{t('Have a second branch? Add its location here with the branch name. Then pick the branch for each employee and manager.')}</p>
        {locs.map((l, i) => (
          <div key={i} class="card">
            <Field label={t('Name')}><input class="input" value={l.name} onInput={(e) => upd(i, 'name', e.currentTarget.value)} /></Field>
            <Field label={t('Name in Urdu (optional)')}><input class="input" dir="rtl" style="font-family:Naskh,serif" value={l.nameUr || ''} onInput={(e) => upd(i, 'nameUr', e.currentTarget.value)} /></Field>
            <div class="two">
              <Field label={t('Latitude')}><input class="input ltr" style="width:100%" inputmode="decimal" value={l.lat} onInput={(e) => upd(i, 'lat', e.currentTarget.value)} /></Field>
              <Field label={t('Longitude')}><input class="input ltr" style="width:100%" inputmode="decimal" value={l.lng} onInput={(e) => upd(i, 'lng', e.currentTarget.value)} /></Field>
            </div>
            <Field label={t('Allowed radius: {m} metres', { m: l.radius })}>
              <input type="range" min="20" max="500" step="10" value={l.radius} style="width:100%;accent-color:var(--red)" onInput={(e) => upd(i, 'radius', Number(e.currentTarget.value))} />
            </Field>
            <div class="btn-row" style="margin-top:0">
              <button class="btn small ghost" disabled={busyGps != null} onClick={() => useMine(i)}>{busyGps === i ? <Spinner sm /> : <><Icon n="pin" />{t('Use my current location')}</>}</button>
              <a class="btn small ghost" href={`https://www.google.com/maps?q=${l.lat},${l.lng}`} target="_blank" rel="noopener"><Icon n="map" />{t('Map')}</a>
              <button class="btn small soft" style="flex:0 0 48px" onClick={() => setLocs(locs.filter((_, j) => j !== i))} aria-label={t('Remove')}><Icon n="trash" /></button>
            </div>
          </div>
        ))}
        <button class="btn block ghost" disabled={busyGps != null} onClick={() => useMine(-1)}>{busyGps === -1 ? <Spinner sm /> : <><Icon n="pin" />{locs.length ? t('Add another branch here') : t('Use my current location')}</>}</button>
        <button class="btn block" style="margin-top:12px" disabled={busy} onClick={() => save({ locations: locs.map((l) => ({ ...l, lat: Number(l.lat), lng: Number(l.lng) })) })}>{t('Save locations')}</button>
      </div>
    </div>
  );
}

export function SettingsShifts() {
  const app = useApp();
  const [list, setList] = useState(app.settings.shifts.map((x) => ({ ...x })));
  const [save, busy] = useSave();
  const upd = (i, k, v) => setList(list.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <div class="screen">
      <TopBar back title={t('Shifts')} />
      <div class="wrap">
        <Banner kind="info">{t('A shift ending at 24:00 or after midnight (e.g. 22:00–06:00) stays on the day it started.')}</Banner>
        {list.map((x, i) => (
          <div key={x.id || i} class="card">
            <div class="two">
              <Field label={t('Name')}><input class="input" value={x.name} onInput={(e) => upd(i, 'name', e.currentTarget.value)} /></Field>
              <Field label={t('Name in Urdu')}><input class="input" dir="rtl" value={x.nameUr} onInput={(e) => upd(i, 'nameUr', e.currentTarget.value)} /></Field>
            </div>
            <div class="two">
              <Field label={t('Starts')}><input class="input ltr" style="width:100%" type="time" value={x.start} onInput={(e) => upd(i, 'start', e.currentTarget.value)} /></Field>
              <Field label={t('Ends')}><input class="input ltr" style="width:100%" value={x.end} placeholder="16:00" onInput={(e) => upd(i, 'end', e.currentTarget.value)} /></Field>
            </div>
            {list.length > 1 && <button class="btn small soft" onClick={() => setList(list.filter((_, j) => j !== i))}><Icon n="trash" />{t('Remove shift')}</button>}
          </div>
        ))}
        <button class="btn block ghost" onClick={() => setList([...list, { name: t('New shift'), nameUr: '', start: '09:00', end: '17:00' }])}><Icon n="plus" />{t('Add shift')}</button>
        <button class="btn block" style="margin-top:12px" disabled={busy} onClick={() => save({ shifts: list })}>{t('Save shifts')}</button>
      </div>
    </div>
  );
}

const JOB_NUM = [['lateGraceMin', 'Late grace time (min)'], ['earlyLeaveGraceMin', 'Early leave grace (min)'], ['breakAllowanceMin', 'Break allowed per day (min)'], ['paidLeavePerMonth', 'Paid leave days per month']];
const JOB_BOOL = [['lateCutOn', 'Cut salary for late minutes'], ['earlyLeaveCutOn', 'Cut salary for leaving early'], ['breakLateCutOn', 'Cut salary for late return from break'], ['requireInRadiusCheckIn', 'Check-in only inside the store circle']];

/** Rules for one job. Empty = same as the store rule. */
function JobRules({ role, store, onChange }) {
  const r = role.rules || {};
  const n = Object.keys(r).length;
  const [open, setOpen] = useState(false);
  const set = (k, v) => { const next = { ...r }; if (v === '' || v == null) delete next[k]; else next[k] = v; onChange(next); };
  return (
    <div style="margin-top:6px">
      <button class="btn small ghost" onClick={() => setOpen(!open)}><Icon n="gear" />{t('Job rules')}{n ? ` (${n})` : ''}</button>
      {open && (
        <div style="margin-top:10px">
          <p class="small muted" style="margin:0 0 8px">{t('Leave empty to use the store rule. Only staff in this job follow these.')}</p>
          <div class="two">
            {JOB_NUM.map(([k, label]) => (
              <Field key={k} label={t(label)}>
                <input class="input ltr" style="width:100%" type="number" inputmode="numeric" placeholder={`${store[k]}`} value={r[k] ?? ''} onInput={(e) => set(k, e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))} />
              </Field>
            ))}
          </div>
          {JOB_BOOL.map(([k, label]) => (
            <Field key={k} label={t(label)}>
              <Seg value={r[k] == null ? '' : r[k] ? 'on' : 'off'} onChange={(v) => set(k, v === '' ? null : v === 'on')}
                options={[['', `${t('Store rule')} (${store[k] ? t('On') : t('Off')})`], ['on', t('On')], ['off', t('Off')]]} />
            </Field>
          ))}
        </div>
      )}
    </div>
  );
}

export function SettingsRoles() {
  const app = useApp();
  const [list, setList] = useState(app.settings.roles.map((x) => ({ ...x })));
  const [save, busy] = useSave();
  const upd = (i, k, v) => setList(list.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <div class="screen">
      <TopBar back title={t('Roles')} />
      <div class="wrap">
        {list.map((x, i) => (
          <div key={x.id || i} class="card">
            <div class="two">
              <Field label={t('Role')}><input class="input" value={x.name} onInput={(e) => upd(i, 'name', e.currentTarget.value)} /></Field>
              <Field label={t('Name in Urdu')}><input class="input" dir="rtl" value={x.nameUr} onInput={(e) => upd(i, 'nameUr', e.currentTarget.value)} /></Field>
            </div>
            <Toggle checked={x.checkoutAnywhere} onChange={(v) => upd(i, 'checkoutAnywhere', v)} label={t('Can check out anywhere')} sub={t('e.g. delivery boys finishing on the road')} />
            <JobRules role={x} store={app.settings.rules} onChange={(r) => upd(i, 'rules', r)} />
            {list.length > 1 && <button class="btn small soft" style="margin-top:8px" onClick={() => setList(list.filter((_, j) => j !== i))}><Icon n="trash" />{t('Remove role')}</button>}
          </div>
        ))}
        <button class="btn block ghost" onClick={() => setList([...list, { name: t('New role'), nameUr: '', checkoutAnywhere: false, rules: {} }])}><Icon n="plus" />{t('Add role')}</button>
        <button class="btn block" style="margin-top:12px" disabled={busy} onClick={() => save({ roles: list })}>{t('Save roles')}</button>
      </div>
    </div>
  );
}

export function SettingsRules() {
  const app = useApp();
  const [r, setR] = useState({ ...app.settings.rules });
  const [save, busy] = useSave();
  const set = (k, v) => setR({ ...r, [k]: v });
  const num = (k, label, hint, unit = t('min')) => (
    <Field label={label} hint={hint}>
      <div class="gap"><input class="input ltr" style="width:110px" type="number" inputmode="numeric" value={r[k]} onInput={(e) => set(k, e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))} /><span class="muted">{unit}</span></div>
    </Field>
  );
  return (
    <div class="screen">
      <TopBar back title={t('Rules')} />
      <div class="wrap">
        <div class="card">
          <h2>{t('Salary maths')}</h2>
          <Field label={t('Days used to work out daily pay')} hint={t('Hourly pay = salary ÷ these days ÷ shift hours')}>
            <Seg value={String(r.daysBasis)} onChange={(v) => set('daysBasis', v === 'actual' ? 'actual' : Number(v))} options={[['26', '26'], ['30', '30'], ['actual', t('Days in month')]]} />
          </Field>
          <Toggle checked={r.absentCutOn} onChange={(v) => set('absentCutOn', v)} label={t('Cut one day for each absent day')} />
        </div>
        <div class="card">
          <h2>{t('Late coming')}</h2>
          {num('lateGraceMin', t('Grace time'), t('Coming within this time is not late'))}
          <Field label={t('When late, count minutes from')}>
            <Seg value={r.lateCountFrom} onChange={(v) => set('lateCountFrom', v)} options={[['start', t('Shift start')], ['grace', t('End of grace')]]} />
          </Field>
          <Toggle checked={r.lateCutOn} onChange={(v) => set('lateCutOn', v)} label={t('Cut salary for late minutes')} />
        </div>
        <div class="card">
          <h2>{t('Leaving early')}</h2>
          {num('earlyLeaveGraceMin', t('Grace time'))}
          <Toggle checked={r.earlyLeaveCutOn} onChange={(v) => set('earlyLeaveCutOn', v)} label={t('Cut salary for leaving early')} />
        </div>
        <div class="card">
          <h2>{t('Breaks')}</h2>
          {num('breakAllowanceMin', t('Break allowed per day'))}
          <Toggle checked={r.breakNeedsApproval} onChange={(v) => set('breakNeedsApproval', v)} label={t('Break needs approval')} sub={t('Off = break starts as soon as the employee asks')} />
          <Toggle checked={r.breakLateCutOn} onChange={(v) => set('breakLateCutOn', v)} label={t('Cut salary for late return from break')} />
        </div>
        <div class="card">
          <h2>{t('Leave & requests')}</h2>
          {num('paidLeavePerMonth', t('Paid leave days per month'), t('Extra leave days are unpaid. Each employee can have their own number.'), t('days'))}
          {num('pastDayRequestDays', t('Past-day requests allowed for'), t('Only within the current month'), t('days back'))}
        </div>
        <div class="card">
          <h2>{t('Overtime')}</h2>
          <Toggle checked={r.overtimeOn} onChange={(v) => set('overtimeOn', v)} label={t('Pay for time worked after the shift ends')} />
          {r.overtimeOn && (
            <div>
              <Field label={t('Overtime rate')} hint={t('1x = normal per-minute pay')}>
                <Seg value={String(r.overtimeRate)} onChange={(v) => set('overtimeRate', Number(v))} options={[['1', '1x'], ['1.5', '1.5x'], ['2', '2x']]} />
              </Field>
              {num('overtimeAfterMin', t('Count only if staying at least'), t('Shorter stays after the shift are not paid'))}
            </div>
          )}
        </div>
        <div class="card">
          <h2>{t('Reminders & daily summary')}</h2>
          <Toggle checked={r.remindersOn} onChange={(v) => set('remindersOn', v)} label={t('Remind staff before their shift and if they forget to check out')} />
          {r.remindersOn && num('remindBeforeMin', t('Remind before shift'))}
          <Toggle checked={r.dailySummaryOn} onChange={(v) => set('dailySummaryOn', v)} label={t("Send me today's attendance summary every night")} />
          {r.dailySummaryOn && (
            <Field label={t('Summary time')}><input class="input ltr" style="width:140px" type="time" value={r.dailySummaryAt} onInput={(e) => set('dailySummaryAt', e.currentTarget.value)} /></Field>
          )}
        </div>
        <div class="card">
          <h2>{t('Check-in safety')}</h2>
          <Toggle checked={r.requireInRadiusCheckIn} onChange={(v) => set('requireInRadiusCheckIn', v)} label={t('Check-in only inside the store circle')} />
          <Toggle checked={r.blockMockLocation} onChange={(v) => set('blockMockLocation', v)} label={t('Block fake GPS apps')} />
          <Toggle checked={r.kioskPhoto} onChange={(v) => set('kioskPhoto', v)} label={t('Kiosk takes a photo with every punch')} />
          <Toggle checked={r.checkInWindowOn} onChange={(v) => set('checkInWindowOn', v)} label={t('Check-in opens only shortly before the shift')} sub={t('Not on days off and holidays. A manager can still record a check-in by hand.')} />
          {r.checkInWindowOn && num('checkInEarlyMin', t('Check-in opens before shift start'))}
          {num('maxOfflineHours', t('Accept offline punches up to'), '', t('hours'))}
          {num('autoAbsentAfterMin', t('Show as absent after shift start'), t('Before this the board shows "Not yet in"'))}
        </div>
        <button class="btn block" style="margin-bottom:20px" disabled={busy} onClick={() => save({ rules: r })}>{t('Save rules')}</button>
      </div>
    </div>
  );
}

export function SettingsHolidays() {
  const app = useApp();
  const today = todayStr(api.serverNow());
  const [list, setList] = useState(app.settings.holidays.map((x) => ({ ...x })));
  const [d, setD] = useState({ date: '', toDate: '', name: '', nameUr: '' });
  const [extra, setExtra] = useState(!!app.settings.rules.holidayWorkExtra);
  const [showPast, setShowPast] = useState(false);
  const [save, busy] = useSave();
  const merge = (items) => {
    const have = new Set(list.map((x) => x.date));
    const add = items.filter((x) => !have.has(x.date));
    setList([...list, ...add].sort((a, b) => a.date.localeCompare(b.date)));
    return add.length;
  };
  const addOne = () => {
    const to = d.toDate && d.toDate > d.date ? d.toDate : d.date;
    const items = [];
    for (let x = d.date, i = 1; x <= to && i <= 15; x = addDays(x, 1), i++) {
      const multi = to !== d.date;
      items.push({ date: x, name: multi && d.name ? `${d.name} (${i})` : d.name, nameUr: multi && d.nameUr ? `${d.nameUr} (${i})` : d.nameUr });
    }
    merge(items);
    setD({ date: '', toDate: '', name: '', nameUr: '' });
  };
  const preset = (y) => {
    const n = merge(pakistanHolidays(y).filter((x) => x.date >= today));
    toast(n ? t('{n} holidays added. Tap Save.', { n }) : t('Already added'), 'ok');
  };
  const shown = list.filter((x) => showPast || x.date >= today);
  return (
    <div class="screen">
      <TopBar back title={t('Holidays')} />
      <div class="wrap">
        <Banner kind="info">{t('Holidays are paid days off for everyone, e.g. Eid. Staff are told on their phones when you add one.')}</Banner>
        <div class="card">
          <h2>{t('Pakistan public holidays')}</h2>
          <p class="small muted" style="margin:0 0 8px">{t('Adds national days and the expected Eid, Ashura and Milad dates. Islamic dates depend on the moon, so check them when the moon is sighted.')}</p>
          <div class="btn-row" style="margin:0">{PK_YEARS.filter((y) => y >= Number(today.slice(0, 4))).map((y) => <button key={y} class="btn ghost" onClick={() => preset(y)}><Icon n="plus" />{y}</button>)}</div>
        </div>
        <div class="card">
          <h2>{t('Add a holiday')}</h2>
          <div class="two">
            <Field label={t('From')}><input class="input ltr" style="width:100%" type="date" value={d.date} onInput={(e) => setD({ ...d, date: e.currentTarget.value })} /></Field>
            <Field label={t('To (optional)')}><input class="input ltr" style="width:100%" type="date" value={d.toDate} min={d.date} onInput={(e) => setD({ ...d, toDate: e.currentTarget.value })} /></Field>
          </div>
          <div class="two">
            <Field label={t('Name')}><input class="input" value={d.name} placeholder={t('e.g. Eid ul Fitr')} onInput={(e) => setD({ ...d, name: e.currentTarget.value })} /></Field>
            <Field label={t('Name in Urdu (optional)')}><input class="input" dir="rtl" value={d.nameUr} onInput={(e) => setD({ ...d, nameUr: e.currentTarget.value })} /></Field>
          </div>
          <button class="btn block ghost" disabled={!d.date} onClick={addOne}><Icon n="plus" />{t('Add holiday')}</button>
        </div>
        <div class="card">
          <Toggle checked={extra} onChange={setExtra} label={t('Extra pay for working on a holiday')} sub={t('Staff who work on a holiday get one extra day of salary for it.')} />
        </div>
        <div class="gap" style="justify-content:space-between;margin:4px 4px 0">
          <span class="small muted">{t('{n} holidays', { n: shown.length })}</span>
          <button class="link small" onClick={() => setShowPast(!showPast)}>{showPast ? t('Hide past') : t('Show past')}</button>
        </div>
        <div class="list">
          {!shown.length && <Empty icon="cal" text={t('No holidays added')} />}
          {shown.map((x) => (
            <div key={x.date} class="row"><div class="main"><div class="title">{nm(x) || t('Holiday')}</div><div class="sub">{fmtDate(x.date)}</div></div>
              <button class="iconbtn" onClick={() => setList(list.filter((y) => y.date !== x.date))}><Icon n="trash" /></button></div>
          ))}
        </div>
        <button class="btn block" style="margin-bottom:20px" disabled={busy} onClick={() => save({ holidays: list, rules: { holidayWorkExtra: extra } })}>{t('Save holidays')}</button>
      </div>
    </div>
  );
}

const PERM_LABELS = {
  'employees.view': 'View staff', 'employees.edit': 'Add, edit & delete staff, set PINs', 'attendance.punch': 'Check staff in/out, mark leave',
  'requests.decide': 'Approve / decline requests', 'payroll.view': 'See salaries & statements', 'money.edit': 'Advances & security deposits',
  'reports.view': 'Reports & exports', 'settings.edit': 'Change settings & rules', 'audit.view': 'See audit log', 'kiosk.setup': 'Set up kiosk phone',
};

export function Users() {
  const app = useApp();
  const st = useLoad(() => api.get('/api/admin/users'), []);
  const [edit, setEdit] = useState(null);
  const save = async () => {
    try {
      if (edit.id) await api.put(`/api/admin/users/${edit.id}`, edit);
      else await api.post('/api/admin/users', edit);
      toast(t('Saved'), 'ok');
      setEdit(null);
      st.reload(true);
    } catch (e) { toastErr(e); }
  };
  const del = async (u) => {
    if (!(await confirmBox({ title: t('Remove {name}?', { name: u.name }), yes: t('Remove'), danger: true }))) return;
    try { await api.del(`/api/admin/users/${u.id}`); setEdit(null); st.reload(true); } catch (e) { toastErr(e); }
  };
  return (
    <div class="screen">
      <TopBar back title={t('Managers')} />
      <div class="wrap">
        <Loader st={st}>{(d) => (
          <div class="list">
            {d.users.map((u) => (
              <button key={u.id} class="row" onClick={() => setEdit({ ...u, pin: '' })}>
                <div class="avatar">{u.name.slice(0, 1)}</div>
                <div class="main"><div class="title">{u.name} <span class="muted small ltr">{u.login}</span></div>
                  <div class="sub">{u.role === 'owner' ? t('Owner / Admin — everything') : t('{n} permissions', { n: u.perms.length })}</div></div>
                {!u.active && <Pill s="absent">{t('Inactive')}</Pill>}
              </button>
            ))}
          </div>
        )}</Loader>
        <button class="btn block" onClick={() => setEdit({ name: '', login: '', pin: '', role: 'manager', perms: ['employees.view', 'attendance.punch', 'requests.decide', 'reports.view'], active: true })}><Icon n="plus" />{t('Add manager')}</button>
      </div>
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? t('Edit manager') : t('Add manager')}>
        {edit && (
          <div>
            <Field label={t('Name')}><input class="input" value={edit.name} onInput={(e) => setEdit({ ...edit, name: e.currentTarget.value })} /></Field>
            <div class="two">
              <Field label={t('Login name')}><input class="input ltr" style="width:100%" autocapitalize="off" value={edit.login} onInput={(e) => setEdit({ ...edit, login: e.currentTarget.value.toLowerCase() })} /></Field>
              <Field label={edit.id ? t('New PIN (optional)') : t('PIN')}><input class="input ltr" style="width:100%" inputmode="numeric" maxLength={6} value={edit.pin} onInput={(e) => setEdit({ ...edit, pin: e.currentTarget.value.replace(/\D/g, '') })} /></Field>
            </div>
            {edit.role !== 'owner' && (
              <div>
                <div class="section-title">{t('Can do')}</div>
                {Object.keys(PERM_LABELS).map((p) => (
                  <Toggle key={p} checked={edit.perms.includes(p)} label={t(PERM_LABELS[p])}
                    onChange={(v) => setEdit({ ...edit, perms: v ? [...edit.perms, p] : edit.perms.filter((x) => x !== p) })} />
                ))}
                {(app.settings.locations || []).length > 1 && (
                  <Field label={t('Branch')} hint={t('A branch manager only sees staff of that branch.')}>
                    <select class="input" value={edit.branchId || ''} onChange={(e) => setEdit({ ...edit, branchId: e.currentTarget.value })}>
                      <option value="">{t('All branches')}</option>
                      {app.settings.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </Field>
                )}
                <Toggle checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label={t('Active')} />
              </div>
            )}
            <div class="btn-row">
              {edit.id && edit.role !== 'owner' && edit.id !== app.me.id && <button class="btn soft" onClick={() => del(edit)}><Icon n="trash" /></button>}
              <button class="btn" onClick={save}>{t('Save')}</button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}

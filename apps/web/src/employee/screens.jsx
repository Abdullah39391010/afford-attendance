// Staff app: calendar, requests, salary, more, and "check in other staff".
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { api, LS } from '../shared/api.js';
import { t, nm, statusLabel, reqLabel, getLang } from '../shared/i18n.js';
import { fmtTime, fmtDur, fmtDate, fmtMoney, fmtMoney2, todayStr, addDays, ago } from '../shared/format.js';
import { TopBar, Icon, Pill, Sheet, Field, Loader, useLoad, toast, toastErr, confirmBox, Banner, Spinner, Seg, Empty, go, replace, Avatar, LangSwitch, Toggle, FingerToggle, Credit } from '../shared/ui.jsx';
import { Calendar, MonthNav } from '../shared/calendar.jsx';
import { Statement } from '../shared/statement.jsx';
import { statementDoc, printDoc, shareDocPdf } from '../shared/printdoc.js';
import { describe } from '../shared/describe.js';
import { PunchSheet } from '../shared/punchsheet.jsx';
import { getLoc } from './home.jsx';
import { useEmp } from './app.jsx';
import { TestAlert } from '../shared/perms.jsx';

// ---------------------------------------------------------------- calendar
export function MyCalendar() {
  const E = useEmp();
  const today = todayStr(api.serverNow());
  const oldest = (() => { const m = addDays(today, -E.home.store.rules.pastDayRequestDays); const first = `${today.slice(0, 7)}-01`; return m > first ? m : first; })();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [day, setDay] = useState(null);
  const st = useLoad(() => api.get(`/api/emp/calendar?month=${month}`), [month]);
  const count = (days, ...s) => days.filter((d) => s.includes(d.status)).length;
  return (
    <div class="screen">
      <TopBar logo title={t('My attendance')} />
      <div class="wrap">
        <div class="card" style="margin-top:12px">
          <MonthNav month={month} onChange={setMonth} max={today.slice(0, 7)} />
          <Loader st={st}>{(d) => (
            <div>
              <Calendar month={month} days={d.days} today={today} onPick={(x) => x.status !== 'future' && setDay(x)} />
              <div class="chips" style="margin-top:10px;flex-wrap:wrap">
                <span class="pill st-present">{t('Present')} {count(d.days, 'present', 'late')}</span>
                <span class="pill st-late">{t('Late')} {count(d.days, 'late')}</span>
                <span class="pill st-absent">{t('Absent')} {count(d.days, 'absent')}</span>
                <span class="pill st-leave">{t('Leave')} {count(d.days, 'leave', 'leave_unpaid')}</span>
              </div>
            </div>
          )}</Loader>
        </div>
      </div>
      {day && (
        <Sheet open onClose={() => setDay(null)} title={fmtDate(day.date)}>
          <div class="kv"><span class="k">{t('Status')}</span><span class="v"><Pill s={day.status} /></span></div>
          {day.checkIn && <div class="kv"><span class="k">{t('Check in')}</span><span class="v ltr">{fmtTime(day.checkIn)}</span></div>}
          {day.checkIn && <div class="kv"><span class="k">{t('Check out')}</span><span class="v ltr">{day.checkOut ? fmtTime(day.checkOut) : '—'}</span></div>}
          {day.workedMin > 0 && <div class="kv"><span class="k">{t('Hours worked')}</span><span class="v">{fmtDur(day.workedMin)}</span></div>}
          {day.lateMin > 0 && <div class="kv"><span class="k">{t('Late')}</span><span class="v">{t('{m} min', { m: day.lateMin })}</span></div>}
          {day.earlyMin > 0 && <div class="kv"><span class="k">{t('Left early')}</span><span class="v">{t('{m} min', { m: day.earlyMin })}</span></div>}
          {day.breakMin > 0 && <div class="kv"><span class="k">{t('Break')}</span><span class="v">{t('{m} min', { m: day.breakMin })}</span></div>}
          {day.holiday && <div class="kv"><span class="k">{t('Holiday')}</span><span class="v">{day.holiday}</span></div>}
          {day.request && <div class="kv"><span class="k">{t('Request')}</span><span class="v"><Pill s={day.request === 'pending' ? 'pending' : day.request}>{t(day.request === 'pending' ? 'Waiting' : day.request === 'approved' ? 'Approved' : 'Declined')}</Pill></span></div>}
          {day.date >= oldest && (day.status === 'absent' || (day.checkIn && !day.checkOut && !day.isOpen)) && (
            <button class="btn block ghost" style="margin-top:12px" onClick={() => { setDay(null); go(`requests?new=${day.checkIn ? 'forgot_out' : 'past_day'}&date=${day.date}`); }}>
              <Icon n="edit" />{day.checkIn ? t('I forgot to check out') : t('I was at work this day')}
            </button>
          )}
        </Sheet>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- requests
const TYPES = [
  ['forgot_in', 'in', 'I forgot to check in'],
  ['forgot_out', 'out', 'I forgot to check out'],
  ['past_day', 'cal', 'I worked on a past day'],
  ['leave', 'leave', 'Leave'],
  ['field_duty', 'map', 'Out-of-town duty'],
  ['advance', 'wallet', 'Advance salary'],
  ['undo_checkout', 'undo', 'I checked out by mistake'],
];

export function MyRequests({ q }) {
  const E = useEmp();
  const [newType, setNewType] = useState(q.get('new') || null);
  const [picker, setPicker] = useState(false);
  const st = useLoad(() => api.get('/api/emp/requests'), []);
  const cur = E.home.store.currency;
  const cancel = async (r) => {
    if (!(await confirmBox({ title: t('Cancel this request?'), yes: t('Yes, cancel'), danger: true }))) return;
    try { await api.post(`/api/emp/requests/${r.id}/cancel`); st.reload(true); E.loadHome(); } catch (e) { toastErr(e); }
  };
  return (
    <div class="screen">
      <TopBar logo title={t('My requests')} />
      <div class="wrap">
        <button class="btn block" style="margin-top:12px" onClick={() => setPicker(true)}><Icon n="plus" />{t('New request')}</button>
        <Loader st={st}>{(d) => (
          <div class="list">
            {!d.requests.length && <Empty icon="inbox" text={t('You have not sent any request yet')} />}
            {d.requests.map((r) => (
              <div key={r.id} class="row">
                <div class="main">
                  <div class="title">{reqLabel(r.type)}</div>
                  <div class="sub">{describe(r, cur)}</div>
                  {r.note && <div class="sub">{t('Reply')}: “{r.note}”</div>}
                </div>
                <div class="end">
                  <Pill s={r.status === 'pending' ? 'pending' : r.status}>{t(r.status === 'pending' ? 'Waiting' : r.status === 'approved' ? 'Approved' : r.status === 'declined' ? 'Declined' : 'Cancelled')}</Pill>
                  <div class="small muted" style="margin-top:4px">{ago(r.created, api.serverNow())}</div>
                  {r.status === 'pending' && <button class="link small" onClick={() => cancel(r)}>{t('Cancel')}</button>}
                </div>
              </div>
            ))}
          </div>
        )}</Loader>
      </div>
      {picker && (
        <Sheet open onClose={() => setPicker(false)} title={t('What do you need?')}>
          <div class="list" style="margin:0;box-shadow:none">
            {TYPES.filter(([k]) => k !== 'field_duty' || E.home.employee.fieldStaff).map(([k, icon, label]) => (
              <button key={k} class="row" onClick={() => { setPicker(false); setNewType(k); }}>
                <Icon n={icon} /><div class="main"><div class="title">{t(label)}</div></div><Icon n="fwd" cls="flip" />
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {newType && <NewRequest type={newType} date0={q.get('date')} onClose={() => { setNewType(null); replace('requests'); }} onDone={() => { setNewType(null); st.reload(true); E.loadHome(); replace('requests'); }} />}
    </div>
  );
}

function NewRequest({ type, date0, onClose, onDone }) {
  const E = useEmp();
  const rules = E.home.store.rules;
  const today = todayStr(api.serverNow());
  const minDate = (() => { const m = addDays(today, -rules.pastDayRequestDays); const first = `${today.slice(0, 7)}-01`; return m > first ? m : first; })();
  const [f, setF] = useState({
    date: date0 || (type === 'past_day' ? addDays(today, -1) : today), toDate: '', time: type === 'forgot_out' ? E.home.employee.shift.end.replace('24:00', '23:59') : E.home.employee.shift.start,
    inTime: E.home.employee.shift.start, outTime: E.home.employee.shift.end.replace('24:00', '23:59'), amount: '', reason: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  const send = async () => {
    setBusy(true);
    try {
      const body = { type, reason: f.reason };
      if (type === 'forgot_in' || type === 'forgot_out') Object.assign(body, { date: f.date, time: f.time });
      if (type === 'past_day') Object.assign(body, { date: f.date, inTime: f.inTime, outTime: f.outTime });
      if (type === 'leave' || type === 'field_duty') Object.assign(body, { date: f.date, toDate: f.toDate || f.date });
      if (type === 'advance') body.amount = Number(f.amount);
      await api.post('/api/emp/requests', body);
      toast(t('Request sent to the admin and managers'), 'ok');
      onDone();
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  const label = TYPES.find((x) => x[0] === type)?.[2];
  const dateInput = (k, min, max) => <input class="input ltr" style="width:100%" type="date" min={min} max={max} value={f[k]} onInput={set(k)} />;
  return (
    <Sheet open onClose={onClose} title={t(label)}>
      {(type === 'forgot_in' || type === 'forgot_out') && (
        <div class="two">
          <Field label={t('Date')}>{dateInput('date', minDate, today)}</Field>
          <Field label={type === 'forgot_in' ? t('Time you came') : t('Time you left')}><input class="input ltr" style="width:100%" type="time" value={f.time} onInput={set('time')} /></Field>
        </div>
      )}
      {type === 'past_day' && (
        <div>
          <Field label={t('Date')} hint={t('Only dates in the current month are allowed.')}>{dateInput('date', minDate, addDays(today, -1))}</Field>
          <div class="two">
            <Field label={t('Time you came')}><input class="input ltr" style="width:100%" type="time" value={f.inTime} onInput={set('inTime')} /></Field>
            <Field label={t('Time you left')}><input class="input ltr" style="width:100%" type="time" value={f.outTime} onInput={set('outTime')} /></Field>
          </div>
        </div>
      )}
      {(type === 'leave' || type === 'field_duty') && (
        <div>
          <div class="two">
            <Field label={t('From')}>{dateInput('date', minDate)}</Field>
            <Field label={t('To (optional)')}>{dateInput('toDate', f.date)}</Field>
          </div>
          {type === 'leave' && <p class="small muted" style="margin:-4px 0 8px">{t('Paid leave left this month: {n}. Extra days are unpaid.', { n: E.home.leave?.left ?? 0 })}</p>}
        </div>
      )}
      {type === 'advance' && <Field label={t('Amount ({c})', { c: E.home.store.currency })}><input class="input ltr" style="width:100%" type="number" inputmode="numeric" value={f.amount} onInput={set('amount')} /></Field>}
      {type === 'undo_checkout' && <p class="small muted">{t('Your last check-out will be removed after the admin or manager approves, so you are checked in again.')}</p>}
      <Field label={t('Reason')}><input class="input" value={f.reason} onInput={set('reason')} placeholder={t('Write a short reason')} /></Field>
      <button class="btn block" disabled={busy || (type === 'advance' && !(Number(f.amount) > 0))} onClick={send}>{busy ? <Spinner sm /> : t('Send to admin / manager')}</button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- salary
export function MyPay() {
  const today = todayStr(api.serverNow());
  const [month, setMonth] = useState(today.slice(0, 7));
  const st = useLoad(() => api.get(`/api/emp/statement?month=${month}`), [month]);
  const [busy, setBusy] = useState(null);
  const run = async (kind, s) => {
    setBusy(kind);
    try {
      const doc = await statementDoc(s);
      if (kind === 'print') await printDoc(doc); else await shareDocPdf(doc, `salary-${s.employee.code}-${s.month}.pdf`);
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  return (
    <div class="screen">
      <TopBar logo title={t('My salary')} />
      <div class="wrap">
        <MonthNav month={month} onChange={setMonth} max={today.slice(0, 7)} />
        <Loader st={st}>{(d) => {
          if (d.hidden) {
            return (
              <div class="card center" style="padding:28px 18px">
                <Icon n="lock" cls="lg-ic" />
                <h2 style="margin-top:10px">{t('Salary statement is closed')}</h2>
                <p class="muted">{t('Your statement opens on the last 2 days of the month and on the 1st of the next month.')}</p>
                <p><b>{t('Next opening: {d}', { d: fmtDate(d.opensOn) })}</b></p>
                <div class="kv" style="margin-top:12px"><span class="k">{t('Security deposit balance')}</span><span class="v">{fmtMoney(d.depositBalance, d.currency)}</span></div>
              </div>
            );
          }
          if (d.limited) {
            return (
              <div>
                <Banner kind="info">{t('You can see the last 7 days of your record.')}</Banner>
                <div class="card scroll-x" style="padding:6px">
                  <table class="table">
                    <thead><tr><th>{t('Date')}</th><th>{t('Status')}</th><th>{t('In')}</th><th>{t('Out')}</th><th>{t('Late')}</th><th>{t('Cut')}</th></tr></thead>
                    <tbody>{d.days.map((x) => (
                      <tr key={x.date}><td>{fmtDate(x.date).replace(/ \d{4}$/, '')}</td><td><Pill s={x.status} /></td><td>{x.checkIn ? fmtTime(x.checkIn) : ''}</td><td>{x.checkOut ? fmtTime(x.checkOut) : ''}</td><td>{x.lateMin || ''}</td><td>{x.cut ? fmtMoney2(x.cut, '') : ''}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
                <div class="card"><div class="kv total"><span class="k">{t('Cuts in these days')}</span><span class="v">{fmtMoney(d.totalCut, d.currency)}</span></div>
                  <div class="kv"><span class="k">{t('Security deposit balance')}</span><span class="v">{fmtMoney(d.depositBalance, d.currency)}</span></div></div>
              </div>
            );
          }
          return <Statement s={d.statement} busy={busy} onPrint={() => run('print', d.statement)} onShare={() => run('share', d.statement)} />;
        }}</Loader>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- more
export function MyMore() {
  const E = useEmp();
  const emp = E.home.employee;
  return (
    <div class="screen">
      <TopBar logo title={t('More')} />
      <div class="wrap">
        <div class="card gap" style="margin-top:12px">
          <Avatar lg name={emp.name} src={emp.hasPhoto ? '/api/emp/photo' : null} ver={emp.photoVer} />
          <div class="grow">
            <b style="font-size:18px">{nm(emp)}</b>
            <div class="small muted">{getLang() === 'ur' && emp.roleUr ? emp.roleUr : emp.role} · <span class="ltr">{emp.code}</span></div>
            <div class="small muted">{t('Shift')} {nm(emp.shift)} <span class="ltr">{emp.shift.start}–{emp.shift.end}</span></div>
          </div>
        </div>
        <div class="list">
          {emp.helperCount > 0 && <button class="row" onClick={() => go('helper')}><Icon n="users" /><div class="main"><div class="title">{t('Check in other staff')}</div><div class="sub">{t('{n} people', { n: emp.helperCount })}</div></div><Icon n="fwd" cls="flip" /></button>}
          <button class="row" onClick={() => go('requests?new=leave')}><Icon n="leave" /><div class="main"><div class="title">{t('Ask for leave')}</div></div><Icon n="fwd" cls="flip" /></button>
          <button class="row" onClick={() => go('requests?new=advance')}><Icon n="wallet" /><div class="main"><div class="title">{t('Advance salary')}</div></div><Icon n="fwd" cls="flip" /></button>
        </div>
        <div class="card">
          <div class="gap" style="justify-content:space-between"><span><Icon n="lang" /> {t('Language')}</span><LangSwitch /></div>
          <FingerToggle title={t('Unlock Afford Staff')} />
        </div>
        <TestAlert kind="emp" />
        <Banner kind="info" icon="phone">{t('This app is linked to this phone. If you change your phone, ask the owner to reset it.')}</Banner>
        <button class="btn block ghost" onClick={async () => { if (await confirmBox({ title: t('Log out?'), text: t('You will need your PIN to log in again.'), yes: t('Log out'), danger: true })) E.logout(); }}><Icon n="logout" />{t('Log out')}</button>
        <Credit app="Afford Staff" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- check in other staff (helper phone)
export function Helper() {
  const [sel, setSel] = useState(null);
  const [done, setDone] = useState(null);
  const st = useLoad(() => api.get('/api/emp/helper'), []);
  useEffect(() => { if (!done) return undefined; const tm = setTimeout(() => setDone(null), 3000); return () => clearTimeout(tm); }, [done]);
  return (
    <div class="screen">
      <TopBar back title={t('Check in other staff')} />
      <div class="wrap">
        <p class="small muted" style="margin:12px 4px">{t('Tap the person. They look at the camera and type their own PIN. Your phone must be inside the store.')}</p>
        <Loader st={st}>{(d) => (
          <div class="kiosk-grid">
            {!d.employees.length && <Empty icon="users" text={t('Nobody yet')} />}
            {d.employees.map((e) => (
              <button key={e.id} class={`kiosk-tile ${e.isIn ? 'in' : ''}`} onClick={() => setSel(e)}>
                <Avatar name={e.name} src={e.hasPhoto ? `/api/emp/helper/${e.id}/photo` : null} ver={e.photoVer} lg />
                <div class="kt-name">{nm(e)}</div>
                <div class="kt-sub ltr">{e.code}</div>
                <div class={`pill ${e.isIn ? 'st-present' : 'st-none'}`}>{e.isIn ? `${t('In')} ${e.checkIn ? fmtTime(e.checkIn) : ''}` : e.checkOut ? `${t('Out')} ${fmtTime(e.checkOut)}` : t('Not in')}</div>
              </button>
            ))}
          </div>
        )}</Loader>
      </div>
      {sel && (
        <PunchSheet emp={sel} onClose={() => setSel(null)} onDone={(r) => { setSel(null); setDone(r); st.reload(true); }}
          send={async ({ pin, photo, type }) => api.post('/api/emp/helper/punch', { employeeId: sel.id, pin, photo, type, loc: await getLoc(), clientId: `h-${sel.id}-${Date.now()}` })} />
      )}
      {done && (
        <div class="kiosk-done" onClick={() => setDone(null)}>
          <div class={`kd-icon ${done.type === 'in' ? 'in' : 'out'}`}><Icon n={done.type === 'in' ? 'in' : 'out'} /></div>
          <h1>{done.type === 'in' ? t('Checked in') : t('Checked out')}</h1>
          <div class="kd-name">{done.name}</div>
          <div class="kd-time ltr">{fmtTime(done.ts)}</div>
        </div>
      )}
    </div>
  );
}

// Live board: who is in, late, on break, absent, on leave, not yet in.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t, nm, statusLabel } from '../shared/i18n.js';
import { fmtTime, fmtDur, fmtDate, todayStr, addDays } from '../shared/format.js';
import { TopBar, Icon, Avatar, Pill, Sheet, Field, Loader, useLoad, toast, toastErr, go, Seg, Spinner } from '../shared/ui.jsx';
import { useApp } from './app.jsx';

const TILES = [
  ['in', 'In'], ['late', 'Late'], ['break', 'On break'], ['absent', 'Absent'],
  ['leave', 'Leave'], ['notyet', 'Not yet in'], ['out', 'Checked out'], ['off', 'Off'],
];

export function Board() {
  const app = useApp();
  const [date, setDate] = useState(todayStr(api.serverNow()));
  const [filter, setFilter] = useState(null);
  const [qtext, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const st = useLoad(() => api.get(`/api/admin/board?date=${date}`), [date]);
  useEffect(() => { st.reload(true); }, [app.ver]);
  useEffect(() => {
    const iv = setInterval(() => st.reload(true), 60000); // keep "not yet in" / worked hours fresh
    return () => clearInterval(iv);
  }, [date]);
  const today = todayStr(api.serverNow());

  return (
    <div class="screen">
      <TopBar logo title={t('Live board')} right={
        <button class="iconbtn" onClick={() => st.reload()} aria-label={t('Refresh')}>{st.loading ? <Spinner sm /> : <Icon n="refresh" />}</button>
      } />
      <div class="wrap">
        <div class="datebar">
          <button class="iconbtn" onClick={() => setDate(addDays(date, -1))} aria-label={t('Previous day')}><Icon n="back" cls="flip" /></button>
          <div class="db-mid">
            {date === today ? <span class="db-tag">{t('Today')}</span> : <button class="db-tag ghost" onClick={() => setDate(today)}>{t('Go to today')}</button>}
            <b>{fmtDate(date, { short: true })}</b>
          </div>
          <button class="iconbtn" disabled={date >= today} onClick={() => setDate(addDays(date, 1))} aria-label={t('Next day')}><Icon n="fwd" cls="flip" /></button>
        </div>
        <Loader st={st}>{(data) => {
          const counts = { ...data.counts, off: (data.counts.off || 0) + (data.counts.duty || 0) };
          let rows = data.rows;
          if (filter === 'late') rows = rows.filter((r) => r.lateMin > 0);
          else if (filter === 'off') rows = rows.filter((r) => r.live === 'off' || r.live === 'duty');
          else if (filter) rows = rows.filter((r) => r.live === filter);
          if (qtext) {
            const q = qtext.toLowerCase();
            rows = rows.filter((r) => `${r.name} ${r.nameUr || ''} ${r.code} ${r.role || ''}`.toLowerCase().includes(q));
          }
          return (
            <div>
              <div class="counts">
                {TILES.map(([k, label]) => (
                  <button key={k} class={`count c-${k} ${filter === k ? 'on' : ''}`} onClick={() => setFilter(filter === k ? null : k)}>
                    <b>{counts[k] || 0}</b><span>{t(label)}</span>
                  </button>
                ))}
              </div>
              <div class="gap">
                <div class="search grow">
                  <Icon n="search" />
                  <input class="input" placeholder={t('Search name or code')} value={qtext} onInput={(e) => setQ(e.currentTarget.value)} />
                </div>
              </div>
              <div class="small muted" style="margin:8px 4px 0">
                {filter ? `${t(TILES.find((x) => x[0] === filter)[1])}: ${rows.length}` : t('{n} active staff', { n: data.counts.total })}
                {filter && <a href="#" style="margin-inline-start:8px" onClick={(e) => { e.preventDefault(); setFilter(null); }}>{t('Show all')}</a>}
              </div>
              <div class="list">
                {!rows.length && <div class="empty">{t('Nobody here')}</div>}
                {rows.map((r) => <BoardRow key={r.id} r={r} onClick={() => setSel(r)} />)}
              </div>
            </div>
          );
        }}</Loader>
      </div>
      {sel && <EmpActions r={sel} date={date} onClose={() => setSel(null)} onDone={() => { setSel(null); st.reload(true); }} />}
    </div>
  );
}

function BoardRow({ r, onClick }) {
  let sub;
  if (r.live === 'in' || r.live === 'break') sub = `${t('In')} ${fmtTime(r.checkIn)} · ${fmtDur(r.workedMin)}`;
  else if (r.live === 'out') sub = `${fmtTime(r.checkIn)} – ${fmtTime(r.checkOut)} · ${fmtDur(r.workedMin)}`;
  else sub = r.role || '';
  return (
    <button class="row" onClick={onClick}>
      <Avatar name={r.name} src={r.hasPhoto ? `/api/admin/employees/${r.id}/photo` : null} ver={r.photoVer} />
      <div class="main">
        <div class="title">{nm(r)} <span class="muted small ltr">{r.code}</span></div>
        <div class="sub">{sub}</div>
      </div>
      <div class="end" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        <Pill s={r.live} />
        {r.lateMin > 0 && <span class="pill st-late">{t('Late {m} min', { m: r.lateMin })}</span>}
        {r.onBreak && <span class="small muted">{t('Due back')} {fmtTime(r.onBreak.due)}</span>}
        {r.missingOut && <span class="pill st-absent">{t('No check-out')}</span>}
      </div>
    </button>
  );
}

/** Actions for one employee: check in/out with reason, end break, mark the day */
export function EmpActions({ r, date, onClose, onDone }) {
  const app = useApp();
  const [mode, setMode] = useState(null); // punch-in | punch-out | mark
  const [reason, setReason] = useState('');
  const [time, setTime] = useState('');
  const [mark, setMark] = useState('leave');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const today = todayStr(api.serverNow());
  const canPunch = app.can('attendance.punch');
  const isPast = date < today;

  const doPunch = async (type) => {
    if (!reason.trim()) return toast(t('Please write a reason.'), 'err');
    setBusy(true);
    try {
      await api.post('/api/admin/punch', { employeeId: r.id, type, reason, ...(time || isPast ? { date, time: time || (type === 'in' ? '08:00' : '16:00') } : {}) });
      toast(type === 'in' ? t('{name} checked in', { name: r.name }) : t('{name} checked out', { name: r.name }), 'ok');
      onDone();
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  const doMark = async () => {
    setBusy(true);
    try {
      await api.post('/api/admin/mark', { employeeId: r.id, date, status: mark === 'clear' ? null : mark, note });
      toast(t('Saved'), 'ok');
      onDone();
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  const endBreak = async () => {
    setBusy(true);
    try {
      const res = await api.post('/api/admin/break/end', { employeeId: r.id });
      toast(res.lateMin ? t('Break ended · {m} min late', { m: res.lateMin }) : t('Break ended'), 'ok');
      onDone();
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };

  const isIn = r.live === 'in' || r.live === 'break';
  return (
    <Sheet open onClose={onClose}>
      <div class="gap" style="margin-bottom:12px">
        <Avatar name={r.name} src={r.hasPhoto ? `/api/admin/employees/${r.id}/photo` : null} ver={r.photoVer} />
        <div class="grow">
          <b style="font-size:17px">{nm(r)}</b>
          <div class="small muted">{r.role} · <span class="ltr">{r.code}</span></div>
        </div>
        <Pill s={r.live} />
      </div>
      {r.checkIn && <div class="kv"><span class="k">{t('Check in')}</span><span class="v">{fmtTime(r.checkIn)}</span></div>}
      {r.checkOut && <div class="kv"><span class="k">{t('Check out')}</span><span class="v">{fmtTime(r.checkOut)}</span></div>}
      {r.lateMin > 0 && <div class="kv"><span class="k">{t('Late')}</span><span class="v">{t('{m} min', { m: r.lateMin })}</span></div>}

      {!mode && (
        <div style="display:grid;gap:10px;margin-top:14px">
          {canPunch && !isIn && <button class="btn green" onClick={() => setMode('in')}><Icon n="in" />{t('Check in')}</button>}
          {canPunch && (isIn || isPast) && <button class="btn dark" onClick={() => setMode('out')}><Icon n="out" />{t('Check out')}</button>}
          {canPunch && r.live === 'break' && <button class="btn soft" disabled={busy} onClick={endBreak}><Icon n="coffee" />{t('End break now')}</button>}
          {canPunch && <button class="btn ghost" onClick={() => setMode('mark')}><Icon n="cal" />{t('Mark day (leave, absent, out-of-town)')}</button>}
          {app.can('employees.view') && <button class="btn ghost" onClick={() => { onClose(); go(`staff/${r.id}/cal`); }}><Icon n="users" />{t('Open profile & calendar')}</button>}
        </div>
      )}

      {(mode === 'in' || mode === 'out') && (
        <div style="margin-top:14px">
          <Field label={t('Reason (required)')}>
            <input class="input" value={reason} onInput={(e) => setReason(e.currentTarget.value)} placeholder={t('e.g. No phone, phone broken')} />
          </Field>
          <Field label={isPast ? t('Time') : t('Time (leave empty for now)')}>
            <input class="input ltr" style="width:100%" type="time" value={time} onInput={(e) => setTime(e.currentTarget.value)} />
          </Field>
          <div class="btn-row">
            <button class="btn ghost" onClick={() => setMode(null)}>{t('Back')}</button>
            <button class={`btn ${mode === 'in' ? 'green' : 'dark'}`} disabled={busy} onClick={() => doPunch(mode)}>{busy ? <Spinner sm /> : mode === 'in' ? t('Check in') : t('Check out')}</button>
          </div>
        </div>
      )}

      {mode === 'mark' && (
        <div style="margin-top:14px">
          <Field label={t('Mark {date} as', { date: fmtDate(date) })}>
            <select class="input" value={mark} onChange={(e) => setMark(e.currentTarget.value)}>
              {['leave', 'leave_unpaid', 'absent', 'duty', 'present', 'off'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
              <option value="clear">{t('Clear mark')}</option>
            </select>
          </Field>
          <Field label={t('Note')}><input class="input" value={note} onInput={(e) => setNote(e.currentTarget.value)} /></Field>
          <div class="btn-row">
            <button class="btn ghost" onClick={() => setMode(null)}>{t('Back')}</button>
            <button class="btn" disabled={busy} onClick={doMark}>{t('Save')}</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

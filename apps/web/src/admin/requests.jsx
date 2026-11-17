// Requests inbox: approve / decline with a note; admin can adjust time or amount first.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t, nm, reqLabel } from '../shared/i18n.js';
import { fmtDate, fmtTime, fmtMoney, ago } from '../shared/format.js';
import { TopBar, Icon, Pill, Sheet, Field, Loader, useLoad, toast, toastErr, Seg, Empty, Spinner, Toggle } from '../shared/ui.jsx';
import { useApp } from './app.jsx';

const ICON = { forgot_in: 'in', forgot_out: 'out', past_day: 'cal', leave: 'leave', advance: 'wallet', break: 'coffee', undo_checkout: 'undo', field_duty: 'map' };

export function describe(r, currency) {
  const d = r.data || {};
  switch (r.type) {
    case 'forgot_in': return `${fmtDate(d.date)} · ${t('check-in at')} ${d.approvedTime || d.time}`;
    case 'forgot_out': return `${fmtDate(d.date)} · ${t('check-out at')} ${d.approvedTime || d.time}`;
    case 'past_day': return `${fmtDate(d.date)} · ${d.approvedIn || d.inTime} – ${d.approvedOut || d.outTime}`;
    case 'leave': return d.toDate && d.toDate !== d.date ? `${fmtDate(d.date)} → ${fmtDate(d.toDate)}` : fmtDate(d.date);
    case 'field_duty': return d.toDate && d.toDate !== d.date ? `${fmtDate(d.date)} → ${fmtDate(d.toDate)}` : fmtDate(d.date);
    case 'advance': return d.amount == null ? t('Amount hidden') : fmtMoney(d.approvedAmount || d.amount, currency);
    case 'break': return t('{m} minutes', { m: d.minutes });
    case 'undo_checkout': return `${t('Checked out at')} ${fmtTime(d.outTs)}`;
    default: return '';
  }
}

export function Requests() {
  const app = useApp();
  const [tab, setTab] = useState('pending');
  const [sel, setSel] = useState(null);
  const st = useLoad(() => api.get(`/api/admin/requests?status=${tab}&limit=150`), [tab]);
  useEffect(() => { st.reload(true); }, [app.ver]);
  const cur = app.settings.currency;
  return (
    <div class="screen">
      <TopBar logo title={t('Requests')} />
      <div class="wrap">
        <div style="margin-top:12px">
          <Seg value={tab} onChange={setTab} options={[['pending', t('Waiting')], ['approved', t('Approved')], ['declined', t('Declined')], ['all', t('All')]]} />
        </div>
        <Loader st={st}>{(data) => (
          <div class="list">
            {!data.requests.length && <Empty icon="inbox" text={tab === 'pending' ? t('No requests waiting. All done!') : t('Nothing here')} />}
            {data.requests.map((r) => (
              <button key={r.id} class="row" onClick={() => setSel(r)}>
                <div class="avatar" style="background:var(--bg);color:var(--ink2)"><Icon n={ICON[r.type]} /></div>
                <div class="main">
                  <div class="title">{nm(r.employee) || '—'} · {reqLabel(r.type)}</div>
                  <div class="sub">{describe(r, cur)}</div>
                  {r.data.reason && <div class="sub">“{r.data.reason}”</div>}
                </div>
                <div class="end">
                  <Pill s={r.status}>{t(r.status === 'pending' ? 'Waiting' : r.status === 'approved' ? 'Approved' : r.status === 'declined' ? 'Declined' : 'Cancelled')}</Pill>
                  <div class="small muted" style="margin-top:4px">{ago(r.created, api.serverNow())}</div>
                </div>
              </button>
            ))}
          </div>
        )}</Loader>
      </div>
      {sel && <Decide r={sel} onClose={() => setSel(null)} onDone={() => { setSel(null); st.reload(true); app.refreshChanges(); }} />}
    </div>
  );
}

function Decide({ r, onClose, onDone }) {
  const app = useApp();
  const d = r.data;
  const [note, setNote] = useState('');
  const [time, setTime] = useState(d.time || '');
  const [inTime, setIn] = useState(d.inTime || '');
  const [outTime, setOut] = useState(d.outTime || '');
  const [amount, setAmount] = useState(d.amount ?? '');
  const [paid, setPaid] = useState(true);
  const [busy, setBusy] = useState(null);
  const canDecide = app.can('requests.decide') && r.status === 'pending';

  const go = async (approve) => {
    setBusy(approve ? 'yes' : 'no');
    try {
      const body = { approve, note };
      if (approve) {
        if (r.type === 'forgot_in' || r.type === 'forgot_out') body.time = time;
        if (r.type === 'past_day') { body.inTime = inTime; body.outTime = outTime; }
        if (r.type === 'advance') body.amount = Number(amount);
        if (r.type === 'leave') body.paid = paid;
      }
      await api.post(`/api/admin/requests/${r.id}/decide`, body);
      toast(approve ? t('Approved') : t('Declined'), 'ok');
      onDone();
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };

  return (
    <Sheet open onClose={onClose} title={reqLabel(r.type)}>
      <div class="kv"><span class="k">{t('Employee')}</span><span class="v">{nm(r.employee)} <span class="muted ltr">{r.employee?.code}</span></span></div>
      <div class="kv"><span class="k">{t('Details')}</span><span class="v">{describe(r, app.settings.currency)}</span></div>
      {d.reason && <div class="kv"><span class="k">{t('Reason')}</span><span class="v">{d.reason}</span></div>}
      <div class="kv"><span class="k">{t('Sent')}</span><span class="v">{ago(r.created, api.serverNow())}</span></div>
      {r.note && <div class="kv"><span class="k">{t('Admin note')}</span><span class="v">{r.note}</span></div>}

      {canDecide && (
        <div style="margin-top:14px">
          {(r.type === 'forgot_in' || r.type === 'forgot_out') && (
            <Field label={t('Time to record')}><input class="input ltr" style="width:100%" type="time" value={time} onInput={(e) => setTime(e.currentTarget.value)} /></Field>
          )}
          {r.type === 'past_day' && (
            <div class="two">
              <Field label={t('Check in')}><input class="input ltr" style="width:100%" type="time" value={inTime} onInput={(e) => setIn(e.currentTarget.value)} /></Field>
              <Field label={t('Check out')}><input class="input ltr" style="width:100%" type="time" value={outTime} onInput={(e) => setOut(e.currentTarget.value)} /></Field>
            </div>
          )}
          {r.type === 'advance' && (
            <Field label={t('Amount to give')}><input class="input ltr" style="width:100%" type="number" inputmode="numeric" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} /></Field>
          )}
          {r.type === 'leave' && <Toggle checked={paid} onChange={setPaid} label={t('Paid leave (within monthly allowance)')} sub={t('Turn off to approve as unpaid leave')} />}
          {r.type === 'break' && <p class="small muted">{t('The break starts when you approve. Coming back late is cut from salary.')}</p>}
          <Field label={t('Note to employee (optional)')}><input class="input" value={note} onInput={(e) => setNote(e.currentTarget.value)} /></Field>
          <div class="btn-row">
            <button class="btn soft" disabled={!!busy} onClick={() => go(false)}>{busy === 'no' ? <Spinner sm /> : <><Icon n="x" />{t('Decline')}</>}</button>
            <button class="btn green" disabled={!!busy} onClick={() => go(true)}>{busy === 'yes' ? <Spinner sm /> : <><Icon n="check" />{t('Approve')}</>}</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

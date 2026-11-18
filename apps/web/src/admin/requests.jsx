// Requests inbox: approve / decline with a note; admin can adjust time or amount first.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t, nm, reqLabel } from '../shared/i18n.js';
import { fmtDate, fmtTime, fmtMoney, ago } from '../shared/format.js';
import { TopBar, Icon, Pill, Sheet, Field, Loader, useLoad, toast, toastErr, Seg, Empty, Spinner, Toggle, Chips, Dialog, MoneyInput } from '../shared/ui.jsx';
import { useApp } from './app.jsx';
import { describe } from '../shared/describe.js';
import { OwnerApprovals } from './pro.jsx';

const ICON = { forgot_in: 'in', forgot_out: 'out', past_day: 'cal', leave: 'leave', advance: 'wallet', break: 'coffee', undo_checkout: 'undo', field_duty: 'map', recheckin: 'in', swap: 'cal', pin_reset: 'lock' };

export { describe };

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
        {app.me.role === 'owner' && tab === 'pending' && <OwnerApprovals />}
        <Loader st={st}>{(data) => (
          <div class="list">
            {!data.requests.length && !(tab === 'pending' && app.ownerPending) && <Empty icon="inbox" text={tab === 'pending' ? t('No requests waiting. All done!') : t('Nothing here')} />}
            {tab === 'pending' && app.ownerPending > 0 && data.requests.length > 0 && <div class="section-title">{t('Staff requests')}</div>}
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
  const [inst, setInst] = useState(1);
  const [busy, setBusy] = useState(null);
  const [pin, setPin] = useState(() => String(Math.floor(1000 + Math.random() * 9000)));
  const [newPin, setNewPin] = useState(null);
  const canDecide = app.can('requests.decide') && r.status === 'pending';
  const pinOk = /^\d{4,6}$/.test(pin);

  const go = async (approve) => {
    setBusy(approve ? 'yes' : 'no');
    try {
      const body = { approve, note };
      if (approve) {
        if (r.type === 'forgot_in' || r.type === 'forgot_out') body.time = time;
        if (r.type === 'past_day') { body.inTime = inTime; body.outTime = outTime; }
        if (r.type === 'advance') { body.amount = Number(amount); body.installments = inst; }
        if (r.type === 'leave') body.paid = paid;
        if (r.type === 'pin_reset') body.pin = pin;
      }
      const res = await api.post(`/api/admin/requests/${r.id}/decide`, body);
      if (res.newPin) { setNewPin(res.newPin); return; }
      toast(approve ? (res.request?.data?.waitingForOwner ? t('Approved. The advance waits for the owner.') : t('Approved')) : t('Declined'), 'ok');
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
            <div>
              <Field label={t('Amount to give')}><MoneyInput value={amount} onValue={setAmount} /></Field>
              <Field label={t('Cut from salary in')}>
                <Chips value={String(inst)} onChange={(v) => setInst(Number(v))} options={[1, 2, 3, 4, 6].map((n) => [String(n), n === 1 ? t('1 month') : t('{n} months', { n })])} />
              </Field>
            </div>
          )}
          {r.type === 'leave' && <Toggle checked={paid} onChange={setPaid} label={t('Paid leave (within monthly allowance)')} sub={t('Turn off to approve as unpaid leave')} />}
          {r.type === 'break' && <p class="small muted">{t('The break starts when you approve. Coming back late is cut from salary.')}</p>}
          {r.type === 'pin_reset' && (app.can('employees.edit') ? (
            <div>
              <p class="small muted">{t('Only approve if you are sure this is really the employee. Ask them in person or call them.')}</p>
              <Field label={t('New PIN (4 to 6 digits)')}>
                <input class="input ltr" style="width:100%;font-size:22px;letter-spacing:4px" inputmode="numeric" maxLength={6} value={pin} onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))} />
              </Field>
            </div>
          ) : <p class="small muted">{t('Only someone who can edit staff can approve this.')}</p>)}
          <Field label={t('Note to employee (optional)')}><input class="input" value={note} onInput={(e) => setNote(e.currentTarget.value)} /></Field>
          <div class="btn-row">
            <button class="btn soft" disabled={!!busy} onClick={() => go(false)}>{busy === 'no' ? <Spinner sm /> : <><Icon n="x" />{t('Decline')}</>}</button>
            <button class="btn green" disabled={!!busy || (r.type === 'pin_reset' && (!pinOk || !app.can('employees.edit')))} onClick={() => go(true)}>{busy === 'yes' ? <Spinner sm /> : <><Icon n="check" />{t('Approve')}</>}</button>
          </div>
        </div>
      )}
      <Dialog open={!!newPin} title={t('New PIN set')} onClose={() => { setNewPin(null); onDone(); }}>
        <p>{t('Tell {name} the new PIN:', { name: nm(r.employee) })}</p>
        <div class="center ltr" style="font-size:36px;font-weight:800;letter-spacing:8px;margin:12px 0">{newPin}</div>
        <button class="btn block" onClick={() => { setNewPin(null); onDone(); }}>{t('Done')}</button>
      </Dialog>
    </Sheet>
  );
}

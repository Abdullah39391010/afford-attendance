// Salary paid record (on the salary statement) and the final settlement screen.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t, nm } from '../shared/i18n.js';
import { fmtMoney, fmtMonth, fmtDate, fmtDateTime, todayStr } from '../shared/format.js';
import { TopBar, Icon, Field, Loader, useLoad, toast, toastErr, Spinner, Banner, Sheet, Seg, confirmBox, go } from '../shared/ui.jsx';
import { PAY_METHOD } from '../shared/statement.jsx';
import { settlementDoc, printDoc, shareDocPdf } from '../shared/printdoc.js';
import { useApp } from './app.jsx';

export function PaidBox({ s, onChanged }) {
  const app = useApp();
  const cur = s.currency;
  const left = Math.max(0, s.net - (s.paid || 0));
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ amount: String(left), method: 'cash', note: '' });
  const [busy, setBusy] = useState(false);
  if (!app.can('money.edit')) return null;
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/admin/payments', { employeeId: s.employee.id, month: s.month, amount: Number(f.amount), method: f.method, note: f.note });
      toast(t('Salary marked as paid'), 'ok');
      setOpen(false);
      onChanged();
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  const undo = async (p) => {
    if (!(await confirmBox({ title: t('Remove this payment?'), yes: t('Remove'), danger: true }))) return;
    try { await api.post(`/api/admin/payments/${p.id}/void`); onChanged(); } catch (e) { toastErr(e); }
  };
  return (
    <div class="card">
      <h2>{t('Salary payment')}</h2>
      {(s.payments || []).map((p) => (
        <div key={p.id} class="kv"><span class="k">{t(PAY_METHOD[p.method] || p.method)} · {fmtDateTime(p.ts)}{p.note ? ` · ${p.note}` : ''}</span>
          <span class="v">{fmtMoney(p.amount, cur)} <button class="link small" onClick={() => undo(p)}>{t('Remove')}</button></span></div>
      ))}
      {left > 0
        ? <button class="btn block green" style="margin-top:8px" onClick={() => { setF({ ...f, amount: String(left) }); setOpen(true); }}><Icon n="check" />{t('Mark salary as paid')} · {fmtMoney(left, cur)}</button>
        : <p class="small" style="margin:6px 0 0;color:var(--green)"><Icon n="check" /> {t('Salary paid in full')}</p>}
      <Sheet open={open} onClose={() => setOpen(false)} title={t('Mark salary as paid')}>
        <Field label={t('Amount ({c})', { c: cur })}><input class="input ltr" style="width:100%" type="number" inputmode="numeric" value={f.amount} onInput={(e) => setF({ ...f, amount: e.currentTarget.value })} /></Field>
        <Field label={t('Paid by')}><Seg value={f.method} onChange={(v) => setF({ ...f, method: v })} options={[['cash', t('Cash')], ['bank', t('Bank transfer')], ['other', t('Other')]]} /></Field>
        <Field label={t('Note (optional)')}><input class="input" value={f.note} onInput={(e) => setF({ ...f, note: e.currentTarget.value })} placeholder={t('e.g. JazzCash / cheque no.')} /></Field>
        <button class="btn block" disabled={busy || !Number(f.amount)} onClick={save}>{busy ? <Spinner sm /> : t('Save')}</button>
      </Sheet>
    </div>
  );
}

export function Settlement({ id }) {
  const app = useApp();
  const owner = app.me.role === 'owner';
  const cur = app.settings.currency;
  const [lastDay, setLastDay] = useState(todayStr(api.serverNow()));
  const st = useLoad(() => api.get(`/api/admin/employees/${id}/settlement?lastDay=${lastDay}`), [id, lastDay]);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState('');
  const kv = (k, v, cls = '') => <div class={`kv ${cls}`}><span class="k">{k}</span><span class="v">{v}</span></div>;
  const doc = async (kind, x) => {
    setBusy(kind);
    try {
      const d = await settlementDoc(x, app.settings.storeName, cur, [app.settings.storeAddress, app.settings.storePhone].filter(Boolean).join(' · '));
      if (kind === 'print') await printDoc(d);
      else await shareDocPdf(d, `settlement-${x.statement.employee.code}.pdf`);
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  const finish = async (x) => {
    const ok = await confirmBox({
      title: t('Finish settlement for {name}?', { name: x.statement.employee.name }),
      text: t('Remaining advances are cut now, the deposit is marked as returned, and the employee is made inactive and logged out.'),
      yes: t('Finish'), danger: true,
    });
    if (!ok) return;
    setBusy('finish');
    try {
      await api.post(`/api/admin/employees/${id}/settle`, { lastDay, note });
      toast(t('Settlement saved'), 'ok');
      go(`staff/${id}`);
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  return (
    <div class="screen no-nav">
      <TopBar back title={t('Final settlement')} />
      <div class="wrap">
        <div class="card" style="margin-top:12px">
          <Field label={t('Last working day')}><input class="input ltr" style="width:100%" type="date" value={lastDay} max={todayStr(api.serverNow())} onInput={(e) => e.currentTarget.value && setLastDay(e.currentTarget.value)} /></Field>
        </div>
        <Loader st={st}>{(x) => {
          const s = x.statement;
          return (
            <div>
              <div class="card">
                <h2>{nm(s.employee)} <span class="muted small ltr">{s.employee.code}</span></h2>
                {kv(t('Salary for {m} (after cuts)', { m: fmtMonth(x.month) }), fmtMoney(s.net, cur))}
                <div class="small muted" style="margin:-2px 0 6px">{t('Days after {d} are cut', { d: fmtDate(x.lastDay) })}{s.cuts.left ? ` · − ${fmtMoney(s.cuts.left, cur)}` : ''}</div>
                {x.laterAdvances > 0 && kv(t('Advance installments still due'), `− ${fmtMoney(x.laterAdvances, cur)}`)}
                {x.alreadyPaid > 0 && kv(t('Already paid for this month'), `− ${fmtMoney(x.alreadyPaid, cur)}`)}
                {kv(t('Security deposit returned'), `+ ${fmtMoney(x.depositBalance, cur)}`)}
                {kv(x.total >= 0 ? t('Amount to pay the employee') : t('Amount the employee owes'), fmtMoney(Math.abs(x.total), cur), 'total')}
              </div>
              <div class="btn-row" style="margin-top:0">
                <button class="btn ghost" disabled={!!busy} onClick={() => doc('print', x)}>{busy === 'print' ? <Spinner sm /> : <><Icon n="print" />{t('Print')}</>}</button>
                <button class="btn" disabled={!!busy} onClick={() => doc('share', x)}>{busy === 'share' ? <Spinner sm /> : <><Icon n="share" />{t('Share PDF')}</>}</button>
              </div>
              {owner ? (
                <div class="card" style="margin-top:12px">
                  <Field label={t('Reason for leaving (optional)')}><input class="input" value={note} onInput={(e) => setNote(e.currentTarget.value)} /></Field>
                  <button class="btn block danger" disabled={!!busy} onClick={() => finish(x)}>{busy === 'finish' ? <Spinner sm /> : t('Finish settlement & make inactive')}</button>
                </div>
              ) : <Banner kind="info">{t('Only the owner can finish a settlement.')}</Banner>}
            </div>
          );
        }}</Loader>
      </div>
    </div>
  );
}

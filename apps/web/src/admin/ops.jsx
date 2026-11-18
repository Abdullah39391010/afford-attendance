// Salary paid record (on the salary statement) and the final settlement screen.
import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t, nm } from '../shared/i18n.js';
import { fmtMoney, fmtMonth, fmtDate, fmtDateTime, todayStr } from '../shared/format.js';
import { TopBar, Icon, Field, Loader, useLoad, toast, toastErr, Spinner, Banner, Sheet, Seg, confirmBox, go, MoneyInput } from '../shared/ui.jsx';
import { PAY_METHOD } from '../shared/statement.jsx';
import { settlementDoc, printDoc, shareDocPdf } from '../shared/printdoc.js';
import { useApp } from './app.jsx';

export function PaidBox({ s, onChanged }) {
  const app = useApp();
  const cur = s.currency;
  const left = Math.max(0, s.net - (s.paid || 0));
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ amount: String(left), method: 'cash', note: '' });
  const [sig, setSig] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!app.can('money.edit')) return null;
  const save = async (noSig) => {
    if (!sig && !noSig && f.method === 'cash') return toast(t('Ask the employee to sign in the box first.'), 'err');
    setBusy(true);
    try {
      await api.post('/api/admin/payments', { employeeId: s.employee.id, month: s.month, amount: Number(f.amount), method: f.method, note: f.note, signature: noSig ? undefined : sig || undefined });
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
        ? <button class="btn block green" style="margin-top:8px" onClick={() => { setF({ ...f, amount: String(left) }); setSig(null); setOpen(true); }}><Icon n="check" />{t('Mark salary as paid')} · {fmtMoney(left, cur)}</button>
        : <p class="small" style="margin:6px 0 0;color:var(--green)"><Icon n="check" /> {t('Salary paid in full')}</p>}
      <Sheet open={open} onClose={() => setOpen(false)} title={t('Mark salary as paid')}>
        <Field label={t('Amount ({c})', { c: cur })}><MoneyInput value={f.amount} onValue={(v) => setF({ ...f, amount: v })} /></Field>
        <Field label={t('Paid by')}><Seg value={f.method} onChange={(v) => setF({ ...f, method: v })} options={[['cash', t('Cash')], ['bank', t('Bank transfer')], ['other', t('Other')]]} /></Field>
        <Field label={t('Note (optional)')}><input class="input" value={f.note} onInput={(e) => setF({ ...f, note: e.currentTarget.value })} placeholder={t('e.g. JazzCash / cheque no.')} /></Field>
        <Field label={t('Employee signature')} hint={t('{name} signs here with a finger to confirm they got the money.', { name: nm(s.employee) })}>
          <SignaturePad onChange={setSig} />
        </Field>
        <button class="btn block" disabled={busy || !Number(f.amount)} onClick={() => save(false)}>{busy ? <Spinner sm /> : t('Save')}</button>
        {f.method === 'cash' && !sig && <button class="btn block ghost small" style="margin-top:8px" disabled={busy || !Number(f.amount)} onClick={() => save(true)}>{t('Save without signature')}</button>}
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

/** Finger signature pad. Gives a small white PNG (data URL) or null when cleared. */
export function SignaturePad({ onChange }) {
  const ref = useRef(null);
  const st = useRef({ drawing: false, dirty: false, last: null });
  useEffect(() => {
    const c = ref.current;
    const r = c.getBoundingClientRect();
    const k = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(r.width * k); c.height = Math.round(r.height * k);
    const g = c.getContext('2d');
    g.scale(k, k); g.fillStyle = '#fff'; g.fillRect(0, 0, r.width, r.height);
    g.lineWidth = 2.6; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#111';
  }, []);
  const pt = (e) => { const r = ref.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const down = (e) => {
    e.preventDefault(); ref.current.setPointerCapture?.(e.pointerId);
    st.current.drawing = true; st.current.last = pt(e);
    const g = ref.current.getContext('2d'); const [x, y] = st.current.last;
    g.beginPath(); g.arc(x, y, 1.3, 0, Math.PI * 2); g.fillStyle = '#111'; g.fill();
  };
  const move = (e) => {
    if (!st.current.drawing) return;
    e.preventDefault();
    const g = ref.current.getContext('2d'); const [x0, y0] = st.current.last; const [x, y] = pt(e);
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x, y); g.stroke();
    st.current.last = [x, y]; st.current.dirty = true;
  };
  const up = () => {
    if (!st.current.drawing) return;
    st.current.drawing = false;
    if (st.current.dirty) onChange(exportPng(ref.current));
  };
  const clear = () => {
    const c = ref.current; const g = c.getContext('2d');
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.restore();
    st.current.dirty = false; onChange(null);
  };
  return (
    <div>
      <canvas ref={ref} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}
        style="display:block;width:100%;height:170px;background:#fff;border:1.5px dashed var(--line);border-radius:12px;touch-action:none" />
      <div class="gap" style="justify-content:space-between;margin-top:6px">
        <span class="small muted">{t('Sign above')}</span>
        <button type="button" class="link small" onClick={clear}>{t('Clear')}</button>
      </div>
    </div>
  );
}

// keep the saved picture small: at most 600 px wide
function exportPng(c) {
  const w = Math.min(600, c.width); const h = Math.round(c.height * (w / c.width));
  const o = document.createElement('canvas'); o.width = w; o.height = h;
  const g = o.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(c, 0, 0, w, h);
  return o.toDataURL('image/png');
}

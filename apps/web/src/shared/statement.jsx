// Salary statement view, used by the admin app and the staff app.
import { h } from 'preact';
import { t, nm, statusLabel, moneyLabel } from './i18n.js';
import { fmtMoney, fmtMoney2, fmtMonth, fmtDate, fmtTime, fmtDur, fmtDateTime } from './format.js';
import { Icon, Spinner, Banner } from './ui.jsx';

export const PAY_METHOD = { cash: 'Cash', bank: 'Bank transfer', other: 'Other' };

/** Statement view, also reused by the employee app */
export function Statement({ s, busy, onPrint, onShare, extra }) {
  const cur = s.currency;
  const c = s.counts;
  const kv = (k, v, cls = '') => <div class={`kv ${cls}`}><span class="k">{k}</span><span class="v">{v}</span></div>;
  return (
    <div>
      <div class="card gap">
        <img src="./logo.png" alt="" style="width:84px;height:auto;flex:none" />
        <div class="grow">
          <b>{nm(s.employee)}</b> <span class="muted small ltr">{s.employee.code}</span>
          <div class="small muted">{s.employee.role} · {fmtMonth(s.month)}</div>
          {s.slipNo && <div class="small muted">{t('Payslip no.')} <span class="ltr">{s.slipNo}</span></div>}
        </div>
      </div>
      {!s.complete && <Banner kind="info">{t('This month is still running. Figures are up to today.')}</Banner>}
      {(onPrint || onShare) && (
        <div class="btn-row" style="margin-top:0">
          {onPrint && <button class="btn ghost" disabled={!!busy} onClick={onPrint}>{busy === 'print' ? <Spinner sm /> : <><Icon n="print" />{t('Print')}</>}</button>}
          {onShare && <button class="btn" disabled={!!busy} onClick={onShare}>{busy === 'share' ? <Spinner sm /> : <><Icon n="share" />{t('Share PDF')}</>}</button>}
        </div>
      )}
      <div class="card">
        <h2>{t('Attendance')}</h2>
        {kv(t('Present days'), c.present)}
        {kv(t('Late'), `${c.late} ${t('days')} · ${c.lateMin} ${t('min')}`)}
        {kv(t('Absent days'), c.absent)}
        {kv(t('Leave (paid / unpaid)'), `${s.leave.paid} / ${s.leave.unpaid}`)}
        {kv(t('Off days & holidays'), c.off + c.holiday)}
        {c.duty > 0 && kv(t('Out-of-town duty'), c.duty)}
        {kv(t('Early leave minutes'), c.earlyMin)}
        {kv(t('Late break return (min)'), c.breakLateMin)}
        {c.overtimeMin > 0 && kv(t('Overtime minutes'), c.overtimeMin)}
        {c.missingOut > 0 && kv(t('Days without check-out'), c.missingOut)}
      </div>
      <div class="card">
        <h2>{t('Pay')}</h2>
        {kv(t('Monthly salary'), fmtMoney(s.salary, cur))}
        <div class="small muted" style="margin:-2px 0 4px">{t('Daily {d} · Hourly {h} · basis {b} days', { d: fmtMoney2(s.rates.daily, cur), h: fmtMoney2(s.rates.hourly, cur), b: s.basisDays })}</div>
        {s.cuts.absent > 0 && kv(t('Absent cut'), `− ${fmtMoney2(s.cuts.absent, cur)}`)}
        {s.cuts.leaveUnpaid > 0 && kv(t('Unpaid leave cut'), `− ${fmtMoney2(s.cuts.leaveUnpaid, cur)}`)}
        {s.cuts.notJoined > 0 && kv(t('Before joining'), `− ${fmtMoney2(s.cuts.notJoined, cur)}`)}
        {s.cuts.left > 0 && kv(t('After leaving'), `− ${fmtMoney2(s.cuts.left, cur)}`)}
        {kv(t('Late cut'), `− ${fmtMoney2(s.cuts.late, cur)}`)}
        {kv(t('Early leave cut'), `− ${fmtMoney2(s.cuts.early, cur)}`)}
        {kv(t('Late break cut'), `− ${fmtMoney2(s.cuts.breakLate, cur)}`)}
        {s.advances > 0 && kv(t('Advances'), `− ${fmtMoney(s.advances, cur)}`)}
        {s.depositCut > 0 && kv(t('Security deposit cut'), `− ${fmtMoney(s.depositCut, cur)}`)}
        {s.fines > 0 && kv(t('Fines'), `− ${fmtMoney(s.fines, cur)}`)}
        {s.bonus > 0 && kv(t('Bonus'), `+ ${fmtMoney(s.bonus, cur)}`)}
        {s.commission > 0 && kv(t('Commission'), `+ ${fmtMoney(s.commission, cur)}`)}
        {s.holidayPay > 0 && kv(t('Holiday work pay ({n} days)', { n: c.holidayWorked }), `+ ${fmtMoney2(s.holidayPay, cur)}`)}
        {s.overtime?.pay > 0 && kv(t('Overtime ({m} min × {r})', { m: s.overtime.min, r: s.overtime.rate }), `+ ${fmtMoney2(s.overtime.pay, cur)}`)}
        {kv(t('Net pay'), fmtMoney(s.net, cur), 'total')}
        {s.payments?.length > 0 && s.payments.map((p) => kv(`${t('Paid')} · ${t(PAY_METHOD[p.method] || p.method)} · ${fmtDateTime(p.ts)}`, fmtMoney(p.amount, cur)))}
        {s.payments && s.net > 0 && (s.paid >= s.net
          ? <div class="pill st-approved" style="margin-top:8px">{t('Salary paid')}</div>
          : s.complete && <div class="pill st-pending" style="margin-top:8px">{s.paid ? t('{a} still to pay', { a: fmtMoney(s.net - s.paid, cur) }) : t('Not paid yet')}</div>)}
        {s.locked && <div class="small muted" style="margin-top:6px"><Icon n="shield" /> {t('Locked. Salary is final.')}</div>}
      </div>
      {extra}
      <div class="card gap" style="justify-content:space-between">
        <div><div class="small muted">{t('Security deposit balance')}</div><b style="font-size:20px">{fmtMoney(s.depositBalance, cur)}</b></div>
        <div style="text-align:end"><div class="small muted">{t('Leave left this month')}</div><b style="font-size:20px">{s.leave.left} / {s.leave.quota}</b></div>
      </div>
      <div class="section-title">{t('Daily record')}</div>
      <div class="card scroll-x" style="padding:6px">
        <table class="table">
          <thead><tr><th>{t('Date')}</th><th>{t('Status')}</th><th>{t('In')}</th><th>{t('Out')}</th><th>{t('Hours')}</th><th>{t('Late')}</th><th>{t('Cut')}</th></tr></thead>
          <tbody>
            {s.days.filter((d) => d.status !== 'future').map((d) => (
              <tr key={d.date}>
                <td>{fmtDate(d.date, { withDay: true }).replace(/ \d{4}$/, '')}</td>
                <td><span class={`pill st-${d.status}`}>{statusLabel(d.status)}</span></td>
                <td>{d.checkIn ? fmtTime(d.checkIn) : ''}</td>
                <td>{d.checkOut ? fmtTime(d.checkOut) : ''}</td>
                <td>{d.workedMin ? fmtDur(d.workedMin) : ''}</td>
                <td>{d.lateMin || ''}</td>
                <td>{d.cut ? fmtMoney2(d.cut, '') : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.money?.length > 0 && <div class="section-title">{t('Money this month')}</div>}
      {s.money?.length > 0 && (
        <div class="list">
          {s.money.map((m) => <div key={m.id} class="row"><div class="main"><div class="title">{moneyLabel(m.kind)}</div><div class="sub">{m.note}</div></div><div class="end" style={m.kind === 'fine' ? 'color:var(--red)' : ''}>{m.kind === 'fine' ? '− ' : ''}{fmtMoney(m.amount, cur)}</div></div>)}
        </div>
      )}
    </div>
  );
}

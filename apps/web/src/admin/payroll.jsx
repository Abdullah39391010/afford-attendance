// Payroll: month list for all staff and a full salary statement per employee (print / share PDF).
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t, nm, statusLabel, moneyLabel } from '../shared/i18n.js';
import { fmtMoney, fmtMoney2, fmtMonth, fmtDate, fmtTime, fmtDur, todayStr } from '../shared/format.js';
import { TopBar, Icon, Avatar, Loader, useLoad, toastErr, go, Spinner, Empty, Banner } from '../shared/ui.jsx';
import { MonthNav } from '../shared/calendar.jsx';
import { statementDoc, printDoc, shareDocPdf, shareCsv } from '../shared/printdoc.js';
import { useApp } from './app.jsx';

export function Payroll({ q }) {
  const app = useApp();
  const cur = app.settings.currency;
  const today = todayStr(api.serverNow());
  const [month, setMonth] = useState(q.get('month') || today.slice(0, 7));
  const st = useLoad(() => api.get(`/api/admin/payroll?month=${month}`), [month]);
  const [busy, setBusy] = useState(false);
  const exportCsv = async () => {
    setBusy(true);
    try {
      const res = await api.call('GET', `/api/admin/payroll?month=${month}&format=csv`, null, { raw: true });
      await shareCsv(await res.text(), `payroll-${month}.csv`);
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  return (
    <div class="screen">
      <TopBar logo title={t('Payroll')} right={<button class="iconbtn" onClick={exportCsv} aria-label="CSV">{busy ? <Spinner sm /> : <Icon n="download" />}</button>} />
      <div class="wrap">
        <MonthNav month={month} onChange={setMonth} max={today.slice(0, 7)} />
        <Loader st={st}>{(data) => (
          <div>
            {month === today.slice(0, 7) && <Banner kind="info">{t('This month is still running. Figures are up to today.')}</Banner>}
            <div class="card">
              <div class="kv"><span class="k">{t('Total salaries')}</span><span class="v">{fmtMoney(data.totals.salary, cur)}</span></div>
              <div class="kv"><span class="k">{t('Total cuts')}</span><span class="v">− {fmtMoney(data.totals.cuts, cur)}</span></div>
              <div class="kv"><span class="k">{t('Advances')}</span><span class="v">− {fmtMoney(data.totals.advances, cur)}</span></div>
              <div class="kv total"><span class="k">{t('Total net pay')}</span><span class="v">{fmtMoney(data.totals.net, cur)}</span></div>
            </div>
            <div class="list">
              {!data.rows.length && <Empty icon="money" text={t('No staff yet')} />}
              {data.rows.map((r) => (
                <button key={r.employee.id} class="row" onClick={() => go(`payroll/${r.employee.id}?month=${month}`)}>
                  <Avatar name={r.employee.name} />
                  <div class="main">
                    <div class="title">{nm(r.employee)} <span class="muted small ltr">{r.employee.code}</span></div>
                    <div class="sub">{t('Present {p} · Absent {a} · Late {l} min', { p: r.counts.present, a: r.counts.absent, l: r.counts.lateMin })}</div>
                  </div>
                  <div class="end"><b style="font-size:15px">{fmtMoney(r.net, cur)}</b><div class="small muted">{t('of')} {fmtMoney(r.salary, cur)}</div></div>
                </button>
              ))}
            </div>
          </div>
        )}</Loader>
      </div>
    </div>
  );
}

export function PayrollOne({ id, q }) {
  const app = useApp();
  const today = todayStr(api.serverNow());
  const [month, setMonth] = useState(q.get('month') || today.slice(0, 7));
  const st = useLoad(() => api.get(`/api/admin/payroll/${id}?month=${month}`), [id, month]);
  const [busy, setBusy] = useState(null);
  const run = async (kind, s) => {
    setBusy(kind);
    try {
      const doc = await statementDoc(s);
      if (kind === 'print') await printDoc(doc);
      else await shareDocPdf(doc, `salary-${s.employee.code}-${s.month}.pdf`);
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  return (
    <div class="screen no-nav">
      <TopBar back title={t('Salary statement')} />
      <div class="wrap">
        <MonthNav month={month} onChange={setMonth} max={today.slice(0, 7)} />
        <Loader st={st}>{({ statement: s }) => <Statement s={s} busy={busy} onPrint={() => run('print', s)} onShare={() => run('share', s)} />}</Loader>
      </div>
    </div>
  );
}

/** Statement view, also reused by the employee app */
export function Statement({ s, busy, onPrint, onShare }) {
  const cur = s.currency;
  const c = s.counts;
  const kv = (k, v, cls = '') => <div class={`kv ${cls}`}><span class="k">{k}</span><span class="v">{v}</span></div>;
  return (
    <div>
      <div class="card gap">
        <img src="./logo.png" alt="" style="width:46px;height:46px;border-radius:50%" />
        <div class="grow">
          <b>{nm(s.employee)}</b> <span class="muted small ltr">{s.employee.code}</span>
          <div class="small muted">{s.employee.role} · {fmtMonth(s.month)}</div>
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
        {c.missingOut > 0 && kv(t('Days without check-out'), c.missingOut)}
      </div>
      <div class="card">
        <h2>{t('Pay')}</h2>
        {kv(t('Monthly salary'), fmtMoney(s.salary, cur))}
        <div class="small muted" style="margin:-2px 0 4px">{t('Daily {d} · Hourly {h} · basis {b} days', { d: fmtMoney2(s.rates.daily, cur), h: fmtMoney2(s.rates.hourly, cur), b: s.basisDays })}</div>
        {s.cuts.absent > 0 && kv(t('Absent cut'), `− ${fmtMoney2(s.cuts.absent, cur)}`)}
        {s.cuts.leaveUnpaid > 0 && kv(t('Unpaid leave cut'), `− ${fmtMoney2(s.cuts.leaveUnpaid, cur)}`)}
        {s.cuts.notJoined > 0 && kv(t('Before joining'), `− ${fmtMoney2(s.cuts.notJoined, cur)}`)}
        {kv(t('Late cut'), `− ${fmtMoney2(s.cuts.late, cur)}`)}
        {kv(t('Early leave cut'), `− ${fmtMoney2(s.cuts.early, cur)}`)}
        {kv(t('Late break cut'), `− ${fmtMoney2(s.cuts.breakLate, cur)}`)}
        {s.advances > 0 && kv(t('Advances'), `− ${fmtMoney(s.advances, cur)}`)}
        {s.depositCut > 0 && kv(t('Security deposit cut'), `− ${fmtMoney(s.depositCut, cur)}`)}
        {s.bonus > 0 && kv(t('Bonus'), `+ ${fmtMoney(s.bonus, cur)}`)}
        {kv(t('Net pay'), fmtMoney(s.net, cur), 'total')}
      </div>
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
          {s.money.map((m) => <div key={m.id} class="row"><div class="main"><div class="title">{moneyLabel(m.kind)}</div><div class="sub">{m.note}</div></div><div class="end">{fmtMoney(m.amount, cur)}</div></div>)}
        </div>
      )}
    </div>
  );
}

// Payroll: month list for all staff and a full salary statement per employee (print / share PDF).
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t, nm, statusLabel, moneyLabel } from '../shared/i18n.js';
import { fmtMoney, fmtMoney2, fmtMonth, fmtDate, fmtTime, fmtDur, todayStr } from '../shared/format.js';
import { TopBar, Icon, Avatar, Loader, useLoad, toastErr, go, Spinner, Empty, Banner } from '../shared/ui.jsx';
import { MonthNav } from '../shared/calendar.jsx';
import { Statement } from '../shared/statement.jsx';
import { statementDoc, printDoc, shareDocPdf, shareCsv } from '../shared/printdoc.js';
import { useApp } from './app.jsx';
import { MonthLock } from './pro.jsx';
import { PaidBox } from './ops.jsx';
import { BranchChips, branchQ, BulkMoney, MonthReport } from './extra.jsx';

export function Payroll({ q }) {
  const app = useApp();
  const cur = app.settings.currency;
  const today = todayStr(api.serverNow());
  const [month, setMonth] = useState(q.get('month') || today.slice(0, 7));
  const [branch, setBranch] = useState('');
  const st = useLoad(() => api.get(`/api/admin/payroll?month=${month}${branchQ(branch)}`), [month, branch]);
  const [busy, setBusy] = useState(false);
  const exportCsv = async () => {
    setBusy(true);
    try {
      const res = await api.call('GET', `/api/admin/payroll?month=${month}&format=csv${branchQ(branch)}`, null, { raw: true });
      await shareCsv(await res.text(), `payroll-${month}.csv`);
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  return (
    <div class="screen">
      <TopBar logo title={t('Payroll')} right={<button class="iconbtn" onClick={exportCsv} aria-label="CSV">{busy ? <Spinner sm /> : <Icon n="download" />}</button>} />
      <div class="wrap">
        <MonthNav month={month} onChange={setMonth} max={today.slice(0, 7)} />
        <BranchChips value={branch} onChange={setBranch} />
        <Loader st={st}>{(data) => (
          <div>
            {month === today.slice(0, 7) && <Banner kind="info">{t('This month is still running. Figures are up to today.')}</Banner>}
            <MonthLock month={month} locked={data.locked} current={month >= today.slice(0, 7)} onChanged={() => st.reload(true)} />
            <div class="card">
              <div class="kv"><span class="k">{t('Total salaries')}</span><span class="v">{fmtMoney(data.totals.salary, cur)}</span></div>
              <div class="kv"><span class="k">{t('Total cuts')}</span><span class="v">− {fmtMoney(data.totals.cuts, cur)}</span></div>
              <div class="kv"><span class="k">{t('Advances')}</span><span class="v">− {fmtMoney(data.totals.advances, cur)}</span></div>
              <div class="kv total"><span class="k">{t('Total net pay')}</span><span class="v">{fmtMoney(data.totals.net, cur)}</span></div>
              {data.totals.paid > 0 && <div class="kv"><span class="k">{t('Paid so far')}</span><span class="v">{fmtMoney(data.totals.paid, cur)}</span></div>}
              {month < today.slice(0, 7) && <div class="kv"><span class="k">{t('Staff not paid yet')}</span><span class="v">{data.totals.unpaid}</span></div>}
            </div>
            {!data.locked && <BulkMoney month={month} onDone={() => st.reload(true)} />}
            <MonthReport month={month} branch={branch} />
            <button class="btn block ghost" style="margin-top:10px" onClick={() => go(`wa?month=${month}`)}><Icon n="send" /> {t('Send payslips on WhatsApp')}</button>
            <div class="list">
              {!data.rows.length && <Empty icon="money" text={t('No staff yet')} />}
              {data.rows.map((r) => (
                <button key={r.employee.id} class="row" onClick={() => go(`payroll/${r.employee.id}?month=${month}`)}>
                  <Avatar name={r.employee.name} />
                  <div class="main">
                    <div class="title">{nm(r.employee)} <span class="muted small ltr">{r.employee.code}</span></div>
                    <div class="sub">{t('Present {p} · Absent {a} · Late {l} min', { p: r.counts.present, a: r.counts.absent, l: r.counts.lateMin })}</div>
                  </div>
                  <div class="end"><b style="font-size:15px">{fmtMoney(r.net, cur)}</b>
                    {r.net > 0 && r.paid >= r.net ? <div class="small" style="color:var(--green)">✓ {t('Paid')}</div> : <div class="small muted">{t('of')} {fmtMoney(r.salary, cur)}</div>}</div>
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
        <Loader st={st}>{({ statement: s }) => <Statement s={s} busy={busy} onPrint={() => run('print', s)} onShare={() => run('share', s)}
          extra={<PaidBox s={s} onChanged={() => st.reload(true)} />} />}</Loader>
      </div>
    </div>
  );
}

export { Statement } from '../shared/statement.jsx';

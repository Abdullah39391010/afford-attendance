// Owner dashboard (monthly charts, most / least punctual) and sending payslips on WhatsApp.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t, nm, getLang } from '../shared/i18n.js';
import { fmtMoney, fmtMonth, fmtDateTime, todayStr } from '../shared/format.js';
import { TopBar, Icon, Avatar, Loader, useLoad, toast, toastErr, go, Seg, Spinner, Empty, Banner } from '../shared/ui.jsx';
import { MonthNav } from '../shared/calendar.jsx';
import { statementDoc, shareDocPdf } from '../shared/printdoc.js';
import { useApp } from './app.jsx';

const short = (m) => fmtMonth(m).split(' ')[0].slice(0, getLang() === 'ur' ? 6 : 3);
const kfmt = (n) => (n >= 100000 ? `${(n / 100000).toFixed(n >= 1000000 ? 0 : 1)}L` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

/** Simple bar chart, one bar per month; the picked month is red. */
function Bars({ months, pick, value, fmt = (v) => String(v), current }) {
  const max = Math.max(1, ...months.map(value));
  return (
    <div class="dbars">
      {months.map((m) => {
        const v = value(m);
        return (
          <button key={m.month} type="button" class={`dbar ${m.month === current ? 'on' : ''}`} onClick={() => pick(m.month)}>
            <span class="dv">{fmt(v)}</span>
            <span class="dcol"><i style={`height:${Math.max(3, (v / max) * 100)}%`} /></span>
            <span class="dl">{short(m.month)}</span>
          </button>
        );
      })}
    </div>
  );
}

function PersonRow({ r, bad }) {
  return (
    <button class="row" onClick={() => go(`staff/${r.id}/cal`)}>
      <Avatar name={r.name} src={r.hasPhoto ? `/api/admin/employees/${r.id}/photo` : null} ver={r.photoVer} />
      <div class="main">
        <div class="title">{nm(r)}</div>
        <div class="sub">{t('{p} present · {l} late · {a} absent', { p: r.present, l: r.lateDays, a: r.absent })}</div>
      </div>
      <div class="end"><b style={`color:var(${bad ? '--red' : '--green'})`}>{bad ? t('{m} min late', { m: r.lateMin }) : `${r.onTimePct}%`}</b><div class="small muted">{bad ? '' : t('on time')}</div></div>
    </button>
  );
}

export function Dashboard() {
  const app = useApp();
  const now = todayStr(api.serverNow()).slice(0, 7);
  const [month, setMonth] = useState(now);
  const [chart, setChart] = useState('late');
  const st = useLoad(() => api.get(`/api/admin/dashboard?month=${month}&months=6`), [month]);
  const cur = app.settings.currency;
  return (
    <div class="screen">
      <TopBar back title={t('Owner dashboard')} />
      <div class="wrap">
        <MonthNav month={month} onChange={setMonth} max={now} />
        <Loader st={st}>{(d) => {
          const m = d.months.find((x) => x.month === month) || d.months[d.months.length - 1] || {};
          const prev = d.months[d.months.indexOf(m) - 1];
          const diff = (k) => {
            if (!prev || !prev[k]) return null;
            const p = Math.round(((m[k] - prev[k]) / prev[k]) * 100);
            return p ? <span class={p > 0 ? 'dup' : 'ddown'}>{p > 0 ? '▲' : '▼'} {Math.abs(p)}%</span> : null;
          };
          const charts = {
            late: [t('Late minutes'), (x) => x.lateMin, (v) => kfmt(v)],
            absent: [t('Absent days'), (x) => x.absentDays, (v) => String(v)],
            cost: [t('Salary cost'), (x) => x.salaryCost, (v) => kfmt(v)],
          };
          const [label, val, fmt] = charts[chart];
          return (
            <div>
              {!m.complete && month === now && <div class="small muted" style="margin:0 4px 8px">{t('Month in progress (so far)')}</div>}
              <div class="dtiles">
                <div class="dtile"><small>{t('Late minutes')}</small><b>{m.lateMin || 0}</b>{diff('lateMin')}<span class="small muted">{t('{n} late days', { n: m.lateDays || 0 })}</span></div>
                <div class="dtile"><small>{t('Absent days')}</small><b>{m.absentDays || 0}</b>{diff('absentDays')}<span class="small muted">{t('{n} on leave', { n: m.leaveDays || 0 })}</span></div>
                <div class="dtile wide"><small>{t('Salary cost')}</small><b>{fmtMoney(m.salaryCost || 0, cur)}</b>{diff('salaryCost')}<span class="small muted">{t('{n} staff · cuts {c}', { n: m.staff || 0, c: fmtMoney(m.cuts || 0, cur) })}</span></div>
              </div>
              <div class="card" style="margin-top:12px">
                <Seg value={chart} onChange={setChart} options={[['late', t('Late')], ['absent', t('Absent')], ['cost', t('Salary')]]} />
                <div class="small muted" style="margin:10px 2px 4px">{label} · {t('last 6 months')}</div>
                <Bars months={d.months} value={val} fmt={fmt} current={month} pick={setMonth} />
              </div>
              <div class="section-title">{t('Most punctual')}</div>
              <div class="list" style="margin-top:0">{d.best.length ? d.best.map((r) => <PersonRow key={r.id} r={r} />) : <Empty text={t('No attendance yet this month')} />}</div>
              <div class="section-title">{t('Least punctual')}</div>
              <div class="list" style="margin-top:0">{d.worst.length ? d.worst.map((r) => <PersonRow key={r.id} r={r} bad />) : <Empty icon="check" text={t('Nobody was late or absent')} />}</div>
            </div>
          );
        }}</Loader>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- payslips on WhatsApp

/** 0300 1234567 / +92 300 1234567 / 0092... → 923001234567 */
export function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = `92${d.slice(1)}`;
  if (d.length === 10 && d.startsWith('3')) d = `92${d}`;
  return d.length >= 11 ? d : '';
}

export function WaPayslips({ q }) {
  const app = useApp();
  const cur = app.settings.currency;
  const [month, setMonth] = useState(q?.get('month') || todayStr(api.serverNow()).slice(0, 7));
  const st = useLoad(() => api.get(`/api/admin/payslips/wa?month=${month}`), [month]);
  const [busy, setBusy] = useState(null);

  const send = async (r) => {
    setBusy(r.id);
    try {
      const s = (await api.get(`/api/admin/payroll/${r.id}?month=${month}`)).statement;
      const doc = await statementDoc(s);
      const caption = t('{name}, your payslip for {m}. Net pay {n}. — {store}', { name: nm(r), m: fmtMonth(month), n: fmtMoney(s.net, cur), store: app.settings.storeName });
      await shareDocPdf(doc, `payslip-${r.code}-${month}.pdf`, { whatsapp: waNumber(r.phone), caption });
      await api.post('/api/admin/payslips/wa-sent', { month, employeeId: r.id });
      st.reload(true);
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };

  return (
    <div class="screen">
      <TopBar back title={t('Payslips on WhatsApp')} />
      <div class="wrap">
        <MonthNav month={month} onChange={setMonth} max={todayStr(api.serverNow()).slice(0, 7)} />
        <Loader st={st}>{(d) => {
          const ready = d.rows.filter((r) => waNumber(r.phone));
          const left = ready.filter((r) => !r.sentTs);
          const noPhone = d.rows.length - ready.length;
          return (
            <div>
              <Banner>{t('Each tap opens the employee\'s WhatsApp chat with the payslip PDF attached. Press send in WhatsApp, then come back for the next one.')}</Banner>
              <div class="card gap" style="margin-top:10px">
                <div class="grow"><b>{t('{a} of {b} sent', { a: ready.length - left.length, b: ready.length })}</b>{noPhone > 0 && <div class="small muted">{t('{n} staff have no phone number', { n: noPhone })}</div>}</div>
                {left.length > 0 && <button class="btn" disabled={!!busy} onClick={() => send(left[0])}>{busy === left[0].id ? <Spinner sm /> : <span><Icon n="send" /> {t('Send next')}</span>}</button>}
              </div>
              <div class="list">
                {d.rows.map((r) => {
                  const num = waNumber(r.phone);
                  return (
                    <div key={r.id} class="row">
                      <Avatar name={r.name} src={r.hasPhoto ? `/api/admin/employees/${r.id}/photo` : null} ver={r.photoVer} />
                      <div class="main">
                        <div class="title">{nm(r)}</div>
                        <div class="sub">{num ? <span class="ltr">+{num}</span> : t('No phone number')} · {fmtMoney(r.net, cur)}</div>
                        {r.sentTs && <div class="small" style="color:var(--green)">✓ {t('Sent')} {fmtDateTime(r.sentTs)}</div>}
                      </div>
                      {num
                        ? <button class={`btn small ${r.sentTs ? 'ghost' : ''}`} disabled={!!busy} onClick={() => send(r)}>{busy === r.id ? <Spinner sm /> : r.sentTs ? t('Again') : t('Send')}</button>
                        : <button class="btn small ghost" onClick={() => go(`staff/${r.id}/edit`)}>{t('Add phone')}</button>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }}</Loader>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- change history filters
export const HISTORY_KINDS = [['', 'All'], ['attendance', 'Attendance'], ['money', 'Salary & money'], ['staff', 'Staff'], ['settings', 'Settings'], ['security', 'Security']];

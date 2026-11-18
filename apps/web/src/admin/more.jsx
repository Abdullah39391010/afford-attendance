// More menu, reports (daily / weekly / monthly, late and absent lists, CSV + PDF), audit log, change PIN.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t, nm, statusLabel, getLang, setLang } from '../shared/i18n.js';
import { fmtTime, fmtDur, fmtDate, todayStr, addDays } from '../shared/format.js';
import { TopBar, Icon, Loader, useLoad, toast, toastErr, go, goBack, Seg, Chips, Field, Spinner, Empty, Pill, LangSwitch, FingerToggle, Credit } from '../shared/ui.jsx';
import { tableDoc, printDoc, shareDocPdf, shareCsv } from '../shared/printdoc.js';
import { AuditList } from './staff.jsx';
import { useApp } from './app.jsx';
import { TestAlert } from '../shared/perms.jsx';
import { CheckUpdateButton } from '../shared/update.jsx';

const IS_WEB = typeof __WEB_APP__ !== 'undefined' && __WEB_APP__;

export function More() {
  const app = useApp();
  const items = [
    app.can('employees.view') && ['roster', 'cal', 'Duty roster', 'Weekly shifts and days off · shift swaps'],
    app.can('reports.view') && ['reports', 'report', 'Reports', 'Daily, weekly, monthly · late & absent lists'],
    app.can('settings.edit') && ['settings', 'gear', 'Settings', 'Location, shifts, rules, holidays, logo'],
    app.me.role === 'owner' && ['users', 'key', 'Managers', 'Add managers and set what they can do'],
    app.me.role === 'owner' && ['backup', 'download', 'Backup & restore', 'Cloud backup, phone backup, server health'],
    app.can('employees.view') && ['rules', 'shield', 'Staff rules agreement', 'Rules every employee accepts in the app'],
    app.can('audit.view') && ['audit', 'log', 'Audit log', 'Every admin action'],
    ['pin', 'shield', 'Change my PIN', ''],
  ].filter(Boolean);
  return (
    <div class="screen">
      <TopBar logo title={t('More')} />
      <div class="wrap">
        <div class="card gap">
          <div class="avatar">{app.me.name.slice(0, 1)}</div>
          <div class="grow"><b>{app.me.name}</b><div class="small muted">{app.me.role === 'owner' ? t('Owner / Admin') : t('Manager')} · <span class="ltr">{app.me.login}</span></div></div>
        </div>
        <div class="list">
          {items.map(([k, icon, label, sub]) => (
            <button key={k} class="row" onClick={() => go(k)}>
              <Icon n={icon} />
              <div class="main"><div class="title">{t(label)}</div>{sub && <div class="sub">{t(sub)}</div>}</div>
              <Icon n="fwd" cls="flip" />
            </button>
          ))}
        </div>
        <div class="card">
          <div class="gap" style="justify-content:space-between"><span><Icon n="lang" /> {t('Language')}</span><LangSwitch /></div>
          {!IS_WEB && <FingerToggle title={t('Unlock Afford Admin')} />}
        </div>
        {!IS_WEB && app.can('requests.decide') && <TestAlert kind="admin" />}
        {!IS_WEB && <CheckUpdateButton />}
        <button class="btn block ghost" onClick={app.logout}><Icon n="logout" />{t('Log out')}</button>
        <Credit app="Afford Admin" />
      </div>
    </div>
  );
}

export function Reports({ q }) {
  const app = useApp();
  const today = todayStr(api.serverNow());
  const [type, setType] = useState(q.get('type') || 'daily');
  const [list, setList] = useState('');
  const [date, setDate] = useState(today);
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(null);
  const qs = () => {
    const p = new URLSearchParams({ type });
    if (type === 'daily') p.set('from', date);
    else if (type === 'custom') { p.set('type', 'range'); p.set('from', from); p.set('to', to); }
    if (list) p.set('list', list);
    return p;
  };
  const st = useLoad(() => api.get(`/api/admin/reports?${qs()}`), [type, list, date, from, to]);
  const summaryView = type !== 'daily' && !list;

  const exportCsv = async () => {
    setBusy('csv');
    try {
      const p = qs(); p.set('format', 'csv'); if (summaryView) p.set('view', 'summary');
      const res = await api.call('GET', `/api/admin/reports?${p}`, null, { raw: true });
      await shareCsv(await res.text(), `attendance-${list || type}-${st.data.from}.csv`);
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  const exportPdf = async (print) => {
    setBusy(print ? 'print' : 'pdf');
    try {
      const d = st.data;
      const title = `${t(list === 'late' ? 'Late list' : list === 'absent' ? 'Absent list' : 'Attendance report')} · ${fmtDate(d.from)}${d.to !== d.from ? ` – ${fmtDate(d.to)}` : ''}`;
      const doc = summaryView
        ? await tableDoc({ storeName: app.settings.storeName, title, columns: [
          { label: t('Code'), get: (r) => r.code }, { label: t('Name'), get: (r) => r.name }, { label: t('Present'), get: (r) => r.present, num: true },
          { label: t('Late'), get: (r) => r.late, num: true }, { label: t('Late min'), get: (r) => r.lateMin, num: true }, { label: t('Absent'), get: (r) => r.absent, num: true },
          { label: t('Leave'), get: (r) => r.leave, num: true }, { label: t('Hours'), get: (r) => (r.workedMin / 60).toFixed(1), num: true }], rows: d.summary })
        : await tableDoc({ storeName: app.settings.storeName, title, columns: [
          { label: t('Date'), get: (r) => fmtDate(r.date) }, { label: t('Name'), get: (r) => `${r.name} (${r.code})` }, { label: t('Status'), get: (r) => statusLabel(r.status) },
          { label: t('In'), get: (r) => (r.checkIn ? fmtTime(r.checkIn) : ''), num: true }, { label: t('Out'), get: (r) => (r.checkOut ? fmtTime(r.checkOut) : ''), num: true },
          { label: t('Late min'), get: (r) => r.lateMin || '', num: true }, { label: t('Hours'), get: (r) => (r.workedMin ? (r.workedMin / 60).toFixed(1) : ''), num: true }], rows: d.rows });
      if (print) await printDoc(doc); else await shareDocPdf(doc, `attendance-${list || type}-${d.from}.pdf`);
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };

  return (
    <div class="screen">
      <TopBar back title={t('Reports')} />
      <div class="wrap">
        <div style="margin-top:12px"><Seg value={type} onChange={setType} options={[['daily', t('Daily')], ['weekly', t('Weekly')], ['monthly', t('Monthly')], ['custom', t('Dates')]]} /></div>
        <div style="margin-top:10px"><Chips value={list} onChange={setList} options={[['', t('Everyone')], ['late', t('Late list')], ['absent', t('Absent list')]]} /></div>
        {type === 'daily' && <div style="margin-top:10px"><input class="input ltr" style="width:100%" type="date" max={today} value={date} onInput={(e) => setDate(e.currentTarget.value)} /></div>}
        {type === 'custom' && (
          <div class="two" style="margin-top:10px">
            <input class="input ltr" type="date" value={from} max={today} onInput={(e) => setFrom(e.currentTarget.value)} />
            <input class="input ltr" type="date" value={to} max={today} onInput={(e) => setTo(e.currentTarget.value)} />
          </div>
        )}
        <div class="btn-row">
          <button class="btn small ghost" disabled={!st.data || !!busy} onClick={exportCsv}>{busy === 'csv' ? <Spinner sm /> : <><Icon n="download" />CSV</>}</button>
          <button class="btn small ghost" disabled={!st.data || !!busy} onClick={() => exportPdf(true)}>{busy === 'print' ? <Spinner sm /> : <><Icon n="print" />{t('Print')}</>}</button>
          <button class="btn small" disabled={!st.data || !!busy} onClick={() => exportPdf(false)}>{busy === 'pdf' ? <Spinner sm /> : <><Icon n="share" />PDF</>}</button>
        </div>
        <Loader st={st}>{(d) => (
          <div>
            <div class="small muted" style="margin:12px 4px 0">{fmtDate(d.from)}{d.to !== d.from ? ` – ${fmtDate(d.to)}` : ''}</div>
            {summaryView ? (
              <div class="card scroll-x" style="padding:6px">
                <table class="table">
                  <thead><tr><th>{t('Name')}</th><th>{t('Present')}</th><th>{t('Late')}</th><th>{t('Late min')}</th><th>{t('Absent')}</th><th>{t('Leave')}</th><th>{t('Hours')}</th></tr></thead>
                  <tbody>{d.summary.map((r) => (
                    <tr key={r.id} onClick={() => go(`staff/${r.id}/cal`)}><td><b>{r.name}</b> <span class="muted ltr">{r.code}</span></td><td>{r.present}</td><td>{r.late}</td><td>{r.lateMin}</td><td>{r.absent}</td><td>{r.leave}</td><td>{(r.workedMin / 60).toFixed(1)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            ) : (
              <div class="list">
                {!d.rows.length && <Empty icon="report" text={t('Nothing to show')} />}
                {d.rows.map((r) => (
                  <div key={`${r.id}${r.date}`} class="row">
                    <div class="main">
                      <div class="title">{r.name} <span class="muted small ltr">{r.code}</span></div>
                      <div class="sub">{type !== 'daily' ? `${fmtDate(r.date)} · ` : ''}{r.checkIn ? `${fmtTime(r.checkIn)} – ${r.checkOut ? fmtTime(r.checkOut) : '…'} · ${fmtDur(r.workedMin)}` : ''}</div>
                    </div>
                    <div class="end"><Pill s={r.status} />{r.lateMin > 0 && <div class="small" style="margin-top:3px">{t('{m} min', { m: r.lateMin })}</div>}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}</Loader>
      </div>
    </div>
  );
}

export function Audit() {
  const [before, setBefore] = useState(null);
  const [all, setAll] = useState([]);
  const st = useLoad(async () => {
    const r = await api.get(`/api/admin/audit?limit=60${before ? `&before=${before}` : ''}`);
    setAll((a) => (before ? [...a, ...r.entries] : r.entries));
    return r;
  }, [before]);
  return (
    <div class="screen">
      <TopBar back title={t('Audit log')} />
      <div class="wrap">
        {all.length ? <AuditList entries={all} /> : <Loader st={st}>{() => <Empty icon="log" text={t('Nothing recorded yet')} />}</Loader>}
        {st.data?.entries.length === 60 && <button class="btn block ghost" onClick={() => setBefore(all[all.length - 1].id)}>{t('Load more')}</button>}
      </div>
    </div>
  );
}

export function ChangePin() {
  const [f, setF] = useState({ oldPin: '', newPin: '', newPin2: '' });
  const save = async () => {
    if (f.newPin !== f.newPin2) return toast(t('The two PINs do not match.'), 'err');
    try { await api.post('/api/admin/me/pin', { oldPin: f.oldPin, newPin: f.newPin }); toast(t('PIN changed'), 'ok'); goBack(); } catch (e) { toastErr(e); }
  };
  const inp = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value.replace(/\D/g, '') });
  return (
    <div class="screen">
      <TopBar back title={t('Change my PIN')} />
      <div class="wrap card">
        <Field label={t('Current PIN')}><input class="input ltr" style="width:100%" type="password" inputmode="numeric" maxLength={6} value={f.oldPin} onInput={inp('oldPin')} /></Field>
        <Field label={t('New PIN (4-6 digits)')}><input class="input ltr" style="width:100%" type="password" inputmode="numeric" maxLength={6} value={f.newPin} onInput={inp('newPin')} /></Field>
        <Field label={t('Repeat new PIN')}><input class="input ltr" style="width:100%" type="password" inputmode="numeric" maxLength={6} value={f.newPin2} onInput={inp('newPin2')} /></Field>
        <button class="btn block" onClick={save}>{t('Save')}</button>
      </div>
    </div>
  );
}

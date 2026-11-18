// Duty roster, bonus / fines for many staff, monthly report (PDF + Excel), staff file (documents),
// warnings and good-work notes, branch filter, birthdays on the board, holiday presets.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { api } from '../shared/api.js';
import { t, nm, getLang, statusLabel } from '../shared/i18n.js';
import { fmtDate, fmtMoney, fmtMonth, fmtDateTime, todayStr, addDays, dayShort } from '../shared/format.js';
import { TopBar, Icon, Sheet, Field, Loader, useLoad, toast, toastErr, Seg, Spinner, Empty, confirmBox, Banner, Chips, Pill } from '../shared/ui.jsx';
import { tableDoc, printDoc, shareDocPdf } from '../shared/printdoc.js';
import { makeXlsx, toBase64 } from '../shared/xlsx.js';
import { useApp } from './app.jsx';

// ---------------------------------------------------------------- branches
export function BranchChips({ value, onChange }) {
  const app = useApp();
  const locs = app.settings.locations || [];
  if (locs.length < 2 || app.me.branchId) return null;
  return (
    <div style="margin-top:10px">
      <Chips value={value || ''} onChange={onChange} options={[['', t('All branches')], ...locs.map((l) => [l.id, l.name])]} />
    </div>
  );
}
export const branchName = (app, id) => (app.settings.locations || []).find((l) => l.id === id)?.name || '';
export const branchQ = (b) => (b ? `&branch=${encodeURIComponent(b)}` : '');

// ---------------------------------------------------------------- birthdays on the board
export function Celebrations({ list }) {
  if (!list?.length) return null;
  return (
    <div class="card celebrate">
      {list.map((c) => (
        <div key={c.id + c.kind} class="gap" style="padding:4px 0">
          <span style="font-size:22px">{c.kind === 'birthday' ? '🎂' : '🎉'}</span>
          <div class="grow"><b>{nm(c)}</b><div class="small muted">{c.kind === 'birthday' ? t('Birthday today') : t('{n} years at work today', { n: c.years })}</div></div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- duty roster
const weekStart = (date) => {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7)); // Monday
};
const shortDate = (d) => fmtDate(d, { withDay: false, short: true }).replace(/ \d{4}$/, '');
const weekDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const shortShift = (x) => (nm(x) || '').slice(0, getLang() === 'ur' ? 4 : 3);

export function Roster() {
  const app = useApp();
  const s = app.settings;
  const today = todayStr(api.serverNow());
  const [from, setFrom] = useState(weekStart(today));
  const [branch, setBranch] = useState('');
  const [edits, setEdits] = useState({});
  const [cell, setCell] = useState(null);
  const [busy, setBusy] = useState(false);
  const st = useLoad(() => api.get(`/api/admin/roster?from=${from}&days=7${branchQ(branch)}`), [from, branch]);
  const canEdit = app.can('attendance.punch');
  const n = Object.keys(edits).length;
  const move = (d) => {
    setEdits({});
    setFrom(addDays(from, d));
  };
  const save = async () => {
    setBusy(true);
    try {
      const cells = Object.entries(edits).map(([k, v]) => { const [employeeId, date] = k.split('|'); return { employeeId, date, ...v }; });
      const r = await api.put('/api/admin/roster', { cells });
      toast(t('Roster saved · {n} changes. Staff are told on their phones.', { n: r.changed }), 'ok');
      setEdits({});
      st.reload(true);
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  const copyNext = async () => {
    if (!(await confirmBox({ title: t('Copy this week to next week?'), text: t('Next week gets the same shifts and days off as this week.'), yes: t('Copy') }))) return;
    try {
      const r = await api.post('/api/admin/roster/copy', { from, to: addDays(from, 7) });
      toast(t('Copied · {n} changes', { n: r.changed }), 'ok');
      setEdits({});
      setFrom(addDays(from, 7));
    } catch (e) { toastErr(e); }
  };
  return (
    <div class="screen no-nav">
      <TopBar back title={t('Duty roster')} />
      <div class="wrap">
        <div class="datebar">
          <button class="iconbtn" onClick={() => move(-7)} aria-label={t('Previous week')}><Icon n="back" cls="flip" /></button>
          <div class="db-mid">{from <= today && today <= addDays(from, 6) ? <span class="db-tag">{t('This week')}</span> : <button class="db-tag ghost" onClick={() => move(weekDiff(from, weekStart(today)))}>{t('Go to this week')}</button>}<b>{shortDate(from)} – {shortDate(addDays(from, 6))}</b></div>
          <button class="iconbtn" onClick={() => move(7)} aria-label={t('Next week')}><Icon n="fwd" cls="flip" /></button>
        </div>
        <BranchChips value={branch} onChange={(v) => { setEdits({}); setBranch(v); }} />
        <p class="small muted" style="margin:8px 4px">{t('Tap a box to change the shift or give a day off. The roster wins over the normal shift and weekly off.')}</p>
        <Loader st={st}>{(data) => {
          const hol = Object.fromEntries(data.holidays.map((x) => [x.date, x.name]));
          return (
            <div class="card scroll-x roster" style="padding:4px">
              <table class="table">
                <thead><tr><th class="sticky">{t('Staff')}</th>{data.dates.map((d) => (
                  <th key={d} class={d === today ? 'today' : ''}>{dayShort(new Date(`${d}T00:00:00Z`).getUTCDay())}<div class="small">{Number(d.slice(8))}</div>{hol[d] && <div class="small" style="color:var(--teal)">{t('Holiday')}</div>}</th>
                ))}</tr></thead>
                <tbody>
                  {!data.employees.length && <tr><td colSpan={8}><Empty icon="users" text={t('No staff yet')} /></td></tr>}
                  {data.employees.map((e) => (
                    <tr key={e.id}>
                      <td class="sticky"><b style="font-size:13px">{nm(e)}</b><div class="small muted"><span class="ltr">{e.code}</span></div></td>
                      {e.cells.map((c) => {
                        const ed = edits[`${e.id}|${c.date}`];
                        const v = ed || c;
                        const sh = s.shifts.find((x) => x.id === v.shiftId);
                        const leave = c.mark && ['leave', 'leave_unpaid', 'duty', 'absent'].includes(c.mark);
                        return (
                          <td key={c.date}>
                            <button class={`rcell ${v.off ? 'off' : `sh${Math.max(0, s.shifts.indexOf(sh)) % 4}`} ${ed ? 'edited' : ''} ${c.rostered && !ed ? 'rostered' : ''}`}
                              disabled={!canEdit} onClick={() => setCell({ e, c, v })}>
                              {leave ? statusLabel(c.mark) : v.off ? t('Off') : shortShift(sh)}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}</Loader>
        <div class="gap small muted" style="margin:6px 4px;flex-wrap:wrap">
          {s.shifts.map((x, i) => <span key={x.id} class="gap"><span class={`rcell sh${i % 4}`} style="width:auto;padding:2px 6px">{shortShift(x)}</span>{nm(x)} {x.start}–{x.end}</span>)}
        </div>
        {canEdit && (
          <div style="display:grid;gap:10px;margin:10px 0 24px">
            <button class="btn block" disabled={!n || busy} onClick={save}>{busy ? <Spinner sm /> : n ? t('Save {n} changes', { n }) : t('No changes yet')}</button>
            <button class="btn block ghost" disabled={busy || n > 0} onClick={copyNext}><Icon n="cal" />{t('Copy this week to next week')}</button>
          </div>
        )}
      </div>
      {cell && (
        <Sheet open onClose={() => setCell(null)} title={`${nm(cell.e)} · ${fmtDate(cell.c.date)}`}>
          {cell.c.mark && <Banner kind="info">{t('Marked as {s} for this day.', { s: statusLabel(cell.c.mark) })}</Banner>}
          <div style="display:grid;gap:8px">
            {s.shifts.map((x) => (
              <button key={x.id} class={`btn ${!cell.v.off && cell.v.shiftId === x.id ? '' : 'ghost'}`}
                onClick={() => { setEdits({ ...edits, [`${cell.e.id}|${cell.c.date}`]: { shiftId: x.id, off: false } }); setCell(null); }}>
                {nm(x)} <span class="ltr">{x.start}–{x.end}</span>
              </button>
            ))}
            <button class={`btn ${cell.v.off ? '' : 'ghost'}`} onClick={() => { setEdits({ ...edits, [`${cell.e.id}|${cell.c.date}`]: { shiftId: cell.v.shiftId, off: true } }); setCell(null); }}>{t('Day off')}</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- bonus / fine for many staff
export function BulkMoney({ month, onDone }) {
  const app = useApp();
  const cur = app.settings.currency;
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ kind: 'bonus', by: 'amount', value: '', note: '', who: 'all', ids: [] });
  const [busy, setBusy] = useState(false);
  const emps = useLoad(() => (open ? api.get('/api/admin/employees') : Promise.resolve({ employees: [] })), [open]);
  if (!app.can('money.edit')) return null;
  const save = async () => {
    if (f.kind === 'fine' && !f.note.trim()) return toast(t('Please write a reason.'), 'err');
    setBusy(true);
    try {
      const body = { kind: f.kind, month, note: f.note, [f.by === 'percent' ? 'percent' : 'amount']: Number(f.value) };
      if (f.who === 'pick') body.employeeIds = f.ids;
      const r = await api.post('/api/admin/money/bulk', body);
      toast(r.pendingOwner ? t('Sent to the owner for approval') : t('Added for {n} staff · {a}', { n: r.count, a: fmtMoney(r.total, cur) }), 'ok');
      setOpen(false);
      setF({ ...f, value: '', note: '', ids: [] });
      onDone?.();
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  return (
    <div>
      <button class="btn block ghost" style="margin-top:10px" onClick={() => setOpen(true)}><Icon n="wallet" />{t('Bonus / commission / fine for many staff')}</button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('Bonus / commission / fine')}>
        <Field label={t('Type')}><Seg value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={[['bonus', t('Bonus')], ['commission', t('Commission')], ['fine', t('Fine')]]} /></Field>
        <Field label={t('How much')}><Seg value={f.by} onChange={(v) => setF({ ...f, by: v })} options={[['amount', t('Same amount')], ['percent', t('% of salary')]]} /></Field>
        <div class="two">
          <Field label={f.by === 'percent' ? t('Percent of salary') : t('Amount ({c})', { c: cur })}>
            <input class="input ltr" style="width:100%" type="number" inputmode="decimal" value={f.value} onInput={(e) => setF({ ...f, value: e.currentTarget.value })} placeholder={f.by === 'percent' ? '50' : '2000'} />
          </Field>
          <Field label={t('Salary month')}><input class="input ltr" style="width:100%" value={fmtMonth(month)} disabled /></Field>
        </div>
        <Field label={f.kind === 'fine' ? t('Reason (required)') : t('Note (shown on payslip)')}><input class="input" value={f.note} placeholder={f.kind === 'bonus' ? t('e.g. Eid bonus') : ''} onInput={(e) => setF({ ...f, note: e.currentTarget.value })} /></Field>
        <Field label={t('Staff')}><Seg value={f.who} onChange={(v) => setF({ ...f, who: v })} options={[['all', t('All active staff')], ['pick', t('Pick staff')]]} /></Field>
        {f.who === 'pick' && (
          <div class="list" style="margin:0 0 10px;box-shadow:none;border:1px solid var(--line);max-height:260px;overflow:auto">
            {(emps.data?.employees || []).map((e) => {
              const on = f.ids.includes(e.id);
              return (
                <label key={e.id} class="row" style="cursor:pointer">
                  <input type="checkbox" checked={on} onChange={() => setF({ ...f, ids: on ? f.ids.filter((x) => x !== e.id) : [...f.ids, e.id] })} style="width:20px;height:20px;accent-color:var(--red)" />
                  <div class="main"><div class="title">{nm(e)} <span class="muted small ltr">{e.code}</span></div></div>
                </label>
              );
            })}
          </div>
        )}
        <button class="btn block" disabled={busy || !Number(f.value) || (f.who === 'pick' && !f.ids.length)} onClick={save}>{busy ? <Spinner sm /> : t('Add')}</button>
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------- monthly report
const CODE = { present: 'P', late: 'L', absent: 'A', leave: 'LV', leave_unpaid: 'UL', off: 'O', holiday: 'H', duty: 'D', notjoined: '-', left: 'X', notyet: '', future: '' };

export function MonthReport({ month, branch }) {
  const app = useApp();
  const cur = app.settings.currency;
  const [busy, setBusy] = useState(null);
  const load = () => api.get(`/api/admin/payroll?month=${month}&days=1${branchQ(branch)}`);
  const title = `${t('Monthly report')} · ${fmtMonth(month)}${branch ? ` · ${branchName(app, branch)}` : ''}`;
  const pdf = async (kind) => {
    setBusy(kind);
    try {
      const d = await load();
      const doc = await tableDoc({
        storeName: app.settings.storeName, title, subtitle: `${t('{n} staff', { n: d.rows.length })} · ${t('Total net pay')}: ${fmtMoney(d.totals.net, cur)} · ${t('Paid so far')}: ${fmtMoney(d.totals.paid, cur)}`,
        columns: [
          { label: t('Code'), get: (r) => r.employee.code }, { label: t('Name'), get: (r) => nm(r.employee) },
          { label: t('Present'), num: true, get: (r) => r.counts.present }, { label: t('Absent'), num: true, get: (r) => r.counts.absent },
          { label: t('Late min'), num: true, get: (r) => r.counts.lateMin }, { label: t('Leave'), num: true, get: (r) => r.leave.paid + r.leave.unpaid },
          { label: t('Salary'), num: true, get: (r) => fmtMoney(r.salary, '') }, { label: t('Cuts'), num: true, get: (r) => fmtMoney(r.totalCuts, '') },
          { label: t('Advances'), num: true, get: (r) => fmtMoney(r.advances, '') }, { label: t('Fines'), num: true, get: (r) => fmtMoney(r.fines || 0, '') },
          { label: t('Extra'), num: true, get: (r) => fmtMoney((r.bonus || 0) + (r.commission || 0) + (r.overtime?.pay || 0) + (r.holidayPay || 0), '') },
          { label: t('Net pay'), num: true, get: (r) => fmtMoney(r.net, '') }, { label: t('Paid'), num: true, get: (r) => fmtMoney(r.paid, '') },
        ],
        rows: d.rows,
      });
      if (kind === 'print') await printDoc(doc);
      else await shareDocPdf(doc, `report-${month}.pdf`);
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  const excel = async () => {
    setBusy('xlsx');
    try {
      const d = await load();
      const n = d.rows[0]?.dayCodes?.length || 0;
      const salary = [
        ['Code', 'Name', 'Role', 'Salary', 'Present', 'Late days', 'Late min', 'Absent', 'Leave paid', 'Leave unpaid', 'Overtime min', 'Total cuts', 'Advances',
          'Deposit cut', 'Fines', 'Bonus', 'Commission', 'Overtime pay', 'Holiday pay', 'Net pay', 'Paid', 'Still to pay', 'Deposit balance'],
        ...d.rows.map((r) => [r.employee.code, r.employee.name, r.employee.role || '', r.salary, r.counts.present, r.counts.late, r.counts.lateMin, r.counts.absent,
          r.leave.paid, r.leave.unpaid, r.counts.overtimeMin || 0, r.totalCuts, r.advances, r.depositCut, r.fines || 0, r.bonus, r.commission || 0,
          r.overtime?.pay || 0, r.holidayPay || 0, r.net, r.paid, Math.max(0, r.net - r.paid), r.depositBalance]),
        [],
        ['', 'Total', '', d.totals.salary, '', '', '', '', '', '', '', d.totals.cuts, d.totals.advances, '', '', '', '', '', '', d.totals.net, d.totals.paid],
      ];
      const att = [
        ['Code', 'Name', ...Array.from({ length: n }, (_, i) => i + 1), 'P', 'L', 'A', 'LV'],
        ...d.rows.map((r) => [r.employee.code, r.employee.name, ...(r.dayCodes || []).map((c) => CODE[c] ?? c), r.counts.present, r.counts.late, r.counts.absent, r.leave.paid + r.leave.unpaid]),
        [],
        ['P = Present, L = Late, A = Absent, LV = Paid leave, UL = Unpaid leave, O = Weekly off, H = Holiday, D = Out-of-town duty, X = Left'],
      ];
      const bytes = makeXlsx([{ name: 'Salary', rows: salary }, { name: 'Attendance', rows: att }]);
      await AffordDevice.shareFile({ filename: `afford-report-${month}.xlsx`, base64: toBase64(bytes), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', title: t('Share Excel') });
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  return (
    <div class="card">
      <h2>{t('Monthly report')}</h2>
      <p class="small muted" style="margin:0 0 8px">{t('Attendance and salary of all staff for {m}. Excel has two sheets: salary and a day-by-day attendance grid.', { m: fmtMonth(month) })}</p>
      <div class="btn-row" style="margin:0">
        <button class="btn ghost" disabled={!!busy} onClick={() => pdf('print')}>{busy === 'print' ? <Spinner sm /> : <><Icon n="print" />{t('Print')}</>}</button>
        <button class="btn ghost" disabled={!!busy} onClick={() => pdf('share')}>{busy === 'share' ? <Spinner sm /> : <><Icon n="share" />PDF</>}</button>
        <button class="btn" disabled={!!busy} onClick={excel}>{busy === 'xlsx' ? <Spinner sm /> : <><Icon n="download" />Excel</>}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- staff file: documents
const DOC_KINDS = [['cnic_front', 'CNIC front'], ['cnic_back', 'CNIC back'], ['contract', 'Contract'], ['photo', 'Photo'], ['other', 'Other']];
const readUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
function shrinkImage(file, max, q) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', q));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export function StaffFile({ e }) {
  const app = useApp();
  const canEdit = app.can('employees.edit');
  const st = useLoad(() => (canEdit ? api.get(`/api/admin/employees/${e.id}/docs`) : Promise.resolve({ docs: [] })), [e.id]);
  const [kind, setKind] = useState('cnic_front');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(null);
  const upload = async (ev) => {
    const file = ev.currentTarget.files[0];
    ev.currentTarget.value = '';
    if (!file) return;
    setBusy(true);
    try {
      let dataUrl;
      if (file.type === 'application/pdf') {
        if (file.size > 700_000) throw new Error(t('PDF is too large (max 700 KB). Take a photo instead.'));
        dataUrl = await readUrl(file);
      } else {
        dataUrl = await shrinkImage(file, 1600, 0.75);
        if (dataUrl.length > 900_000) dataUrl = await shrinkImage(file, 1200, 0.6);
      }
      await api.post(`/api/admin/employees/${e.id}/docs`, { kind, name: file.name, dataUrl });
      toast(t('File saved'), 'ok');
      st.reload(true);
    } catch (err) { toastErr(err); } finally { setBusy(false); }
  };
  const open = async (d) => {
    try {
      const res = await api.call('GET', `/api/admin/docs/${d.id}`, null, { raw: true });
      const blob = await res.blob();
      if (d.mime === 'application/pdf') {
        const b64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
        await AffordDevice.shareFile({ filename: d.name || `${d.kind}.pdf`, base64: b64, mime: 'application/pdf', title: t('Open file') });
      } else setView({ d, url: URL.createObjectURL(blob) });
    } catch (err) { toastErr(err); }
  };
  const del = async (d) => {
    if (!(await confirmBox({ title: t('Delete this file?'), yes: t('Delete'), danger: true }))) return;
    try { await api.del(`/api/admin/docs/${d.id}`); setView(null); st.reload(true); } catch (err) { toastErr(err); }
  };
  const label = (k) => t((DOC_KINDS.find((x) => x[0] === k) || [k, k])[1]);
  const kv = (k, v) => v ? <div class="kv"><span class="k">{k}</span><span class="v">{v}</span></div> : null;
  return (
    <div class="card">
      <h2>{t('Staff file')}</h2>
      {kv(t("Father's name"), e.fatherName)}
      {kv(t('Date of birth'), e.dob && fmtDate(e.dob))}
      {kv(t('Address'), e.address)}
      {(e.emergencyName || e.emergencyPhone) && <div class="kv"><span class="k">{t('Emergency contact')}</span><span class="v">{e.emergencyName} {e.emergencyPhone && <a class="ltr" href={`tel:${e.emergencyPhone}`}>{e.emergencyPhone}</a>}</span></div>}
      {!e.fatherName && !e.dob && !e.address && !e.emergencyName && <p class="small muted" style="margin:0 0 6px">{t('Add father\'s name, date of birth, address and emergency contact with Edit details.')}</p>}
      {canEdit && (
        <div>
          <div class="section-title" style="margin-top:10px">{t('Documents')}</div>
          <Loader st={st}>{(data) => (
            <div class="list" style="margin:0 0 10px;box-shadow:none;border:1px solid var(--line)">
              {!data.docs.length && <div class="empty small">{t('No files yet. Add CNIC photos and the contract.')}</div>}
              {data.docs.map((d) => (
                <div key={d.id} class="row">
                  <Icon n={d.mime === 'application/pdf' ? 'report' : 'camera'} />
                  <button class="main" style="text-align:start;background:none;border:0;padding:0" onClick={() => open(d)}>
                    <div class="title">{label(d.kind)}</div><div class="sub">{fmtDateTime(d.ts)} · {Math.max(1, Math.round(d.size / 1024))} KB</div>
                  </button>
                  <button class="iconbtn" onClick={() => del(d)} aria-label={t('Delete')}><Icon n="trash" /></button>
                </div>
              ))}
            </div>
          )}</Loader>
          <div class="two">
            <select class="input" value={kind} onChange={(ev) => setKind(ev.currentTarget.value)}>{DOC_KINDS.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select>
            <label class={`btn ghost ${busy ? 'disabled' : ''}`}>{busy ? <Spinner sm /> : <><Icon n="camera" />{t('Add file')}</>}
              <input type="file" accept="image/*,application/pdf" style="display:none" disabled={busy} onChange={upload} /></label>
          </div>
        </div>
      )}
      {view && (
        <Sheet open onClose={() => { URL.revokeObjectURL(view.url); setView(null); }} title={label(view.d.kind)}>
          <img src={view.url} alt="" style="width:100%;border-radius:10px" />
          <button class="btn block soft" style="margin-top:10px" onClick={() => del(view.d)}><Icon n="trash" />{t('Delete')}</button>
        </Sheet>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- warnings and good-work notes
const NOTE = { warning: ['Warning', 'absent'], praise: ['Good work', 'present'], note: ['Note', 'notyet'] };
export function NotesTab({ e }) {
  const app = useApp();
  const st = useLoad(() => api.get(`/api/admin/employees/${e.id}/notes`), [e.id]);
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ kind: 'warning', text: '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/api/admin/employees/${e.id}/notes`, f);
      toast(t('Saved. The employee sees it in their app.'), 'ok');
      setAdd(false);
      setF({ ...f, text: '' });
      st.reload(true);
    } catch (err) { toastErr(err); } finally { setBusy(false); }
  };
  const del = async (n) => {
    if (!(await confirmBox({ title: t('Remove this note?'), yes: t('Remove'), danger: true }))) return;
    try { await api.post(`/api/admin/notes/${n.id}/void`); st.reload(true); } catch (err) { toastErr(err); }
  };
  return (
    <div>
      {app.can('employees.edit') && <button class="btn block" onClick={() => setAdd(true)}><Icon n="plus" />{t('Write a warning or good-work note')}</button>}
      <Loader st={st}>{(data) => (
        <div>
          {data.warnings > 0 && <div class="small muted" style="margin:10px 4px 0">{t('Warnings: {n}', { n: data.warnings })}</div>}
          <div class="list">
            {!data.notes.length && <Empty icon="log" text={t('No notes yet')} />}
            {data.notes.map((n) => (
              <div key={n.id} class="row">
                <div class="main">
                  <div class="gap"><Pill s={NOTE[n.kind][1]}>{t(NOTE[n.kind][0])}</Pill><span class="small muted">{fmtDateTime(n.ts)} · {n.byName}</span></div>
                  <div style="margin-top:6px;white-space:pre-wrap">{n.text}</div>
                  <div class="small muted" style="margin-top:4px">{n.seen ? `✓ ${t('Read by employee')} · ${fmtDateTime(n.seen)}` : t('Not read yet')}</div>
                </div>
                {app.can('employees.edit') && <button class="iconbtn" onClick={() => del(n)} aria-label={t('Remove')}><Icon n="trash" /></button>}
              </div>
            ))}
          </div>
        </div>
      )}</Loader>
      <Sheet open={add} onClose={() => setAdd(false)} title={t('Note for {name}', { name: nm(e) })}>
        <Field label={t('Type')}><Seg value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={[['warning', t('Warning')], ['praise', t('Good work')], ['note', t('Note')]]} /></Field>
        <Field label={t('Message')}><textarea class="input" rows={4} value={f.text} onInput={(ev) => setF({ ...f, text: ev.currentTarget.value })}
          placeholder={f.kind === 'warning' ? t('e.g. Late three times this week. Next time salary will be cut.') : f.kind === 'praise' ? t('e.g. Thank you for handling the Eid rush so well.') : ''} /></Field>
        <p class="small muted" style="margin:-4px 0 10px">{t('The employee gets a notification and sees it in the app.')}</p>
        <button class="btn block" disabled={busy || !f.text.trim()} onClick={save}>{busy ? <Spinner sm /> : t('Send')}</button>
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------- holidays in Pakistan
// Islamic dates move with the moon: these are the expected dates; fix them when the moon is sighted.
const PK_FIXED = [['02-05', 'Kashmir Day', 'یومِ کشمیر'], ['03-23', 'Pakistan Day', 'یومِ پاکستان'], ['05-01', 'Labour Day', 'یومِ مزدور'],
  ['05-28', 'Youm-e-Takbeer', 'یومِ تکبیر'], ['08-14', 'Independence Day', 'یومِ آزادی'], ['11-09', 'Iqbal Day', 'یومِ اقبال'], ['12-25', 'Quaid-e-Azam Day', 'یومِ قائد']];
const PK_MOON = {
  2026: [['2026-03-20', 3, 'Eid ul Fitr', 'عید الفطر'], ['2026-05-27', 3, 'Eid ul Adha', 'عید الاضحیٰ'], ['2026-06-24', 2, 'Ashura', 'عاشورہ'], ['2026-08-26', 1, 'Eid Milad un Nabi', 'عید میلاد النبی']],
  2027: [['2027-03-10', 3, 'Eid ul Fitr', 'عید الفطر'], ['2027-05-17', 3, 'Eid ul Adha', 'عید الاضحیٰ'], ['2027-06-14', 2, 'Ashura', 'عاشورہ'], ['2027-08-15', 1, 'Eid Milad un Nabi', 'عید میلاد النبی']],
};
export function pakistanHolidays(year) {
  const out = PK_FIXED.map(([md, name, nameUr]) => ({ date: `${year}-${md}`, name, nameUr }));
  for (const [start, days, name, nameUr] of PK_MOON[year] || []) {
    for (let i = 0; i < days; i++) out.push({ date: addDays(start, i), name: days > 1 ? `${name} (${i + 1})` : name, nameUr: days > 1 ? `${nameUr} (${i + 1})` : nameUr, moon: true });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
export const PK_YEARS = Object.keys(PK_MOON).map(Number);

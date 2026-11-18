// Employees: list, add/edit form, profile with calendar, day details, money (advances, deposit), history.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t, nm, statusLabel, getLang, reqLabel, auditLabel, moneyLabel } from '../shared/i18n.js';
import { fmtTime, fmtDur, fmtDate, fmtMoney, fmtDateTime, todayStr, fmtMonth, dayShort } from '../shared/format.js';
import {
  TopBar, Icon, Avatar, Pill, Sheet, Field, Loader, useLoad, toast, toastErr, go, goBack, replace, Seg, Toggle, Spinner, Empty, confirmBox, Banner, Chips, MoneyInput } from '../shared/ui.jsx';
import { Calendar, MonthNav } from '../shared/calendar.jsx';
import { useApp } from './app.jsx';
import { BranchChips, branchName, branchQ, StaffFile, NotesTab } from './extra.jsx';

export function StaffList() {
  const app = useApp();
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [branch, setBranch] = useState('');
  const st = useLoad(() => api.get(`/api/admin/employees?all=${showAll ? 1 : 0}${branchQ(branch)}`), [showAll, branch]);
  useEffect(() => { st.reload(true); }, [app.ver]);
  const roleName = (id) => nm(app.settings.roles.find((r) => r.id === id)) || id;
  return (
    <div class="screen">
      <TopBar logo title={t('Staff')} />
      <div class="wrap">
        <div class="gap" style="margin-top:12px">
          <div class="search grow"><Icon n="search" /><input class="input" placeholder={t('Search name, code or phone')} value={q} onInput={(e) => setQ(e.currentTarget.value)} /></div>
        </div>
        <div style="margin-top:10px"><Seg value={showAll ? 'all' : 'active'} onChange={(v) => setShowAll(v === 'all')} options={[['active', t('Active')], ['all', t('All (with inactive)')]]} /></div>
        <BranchChips value={branch} onChange={setBranch} />
        <Loader st={st}>{(data) => {
          const ql = q.toLowerCase();
          const rows = data.employees.filter((e) => !ql || `${e.name} ${e.nameUr} ${e.code} ${e.phone}`.toLowerCase().includes(ql));
          return (
            <div>
              <div class="small muted" style="margin:10px 4px 0">{t('{n} employees', { n: rows.length })}</div>
              <div class="list">
                {!rows.length && <Empty icon="users" text={t('No employees yet. Tap + to add.')} />}
                {rows.map((e) => (
                  <button key={e.id} class="row" onClick={() => go(`staff/${e.id}`)}>
                    <Avatar name={e.name} src={e.hasPhoto ? `/api/admin/employees/${e.id}/photo` : null} ver={e.photoVer} />
                    <div class="main">
                      <div class="title">{nm(e)} <span class="muted small ltr">{e.code}</span></div>
                      <div class="sub">{roleName(e.roleId)}{e.branchId && (app.settings.locations || []).length > 1 ? ` · ${branchName(app, e.branchId)}` : ''}{e.fieldStaff ? ` · ${t('Field staff')}` : ''}{e.phone ? ` · ` : ''}<span class="ltr">{e.phone}</span></div>
                    </div>
                    <div class="end">
                      {!e.active && <Pill s="absent">{t('Inactive')}</Pill>}
                      {e.active && !e.deviceBound && <span class="pill st-notyet">{t('No phone')}</span>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        }}</Loader>
      </div>
      {app.can('employees.edit') && <button class="fab" onClick={() => go('staff/new')} aria-label={t('Add employee')}><Icon n="plus" /></button>}
    </div>
  );
}

/** Resize a picked/taken photo to a small JPEG data URL */
export function resizePhoto(file, size = 360) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const s = Math.min(img.width, img.height);
      c.width = size; c.height = size;
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      resolve(c.toDataURL('image/jpeg', 0.82));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

const VIS_LABEL = { always: 'Always (full month)', window: 'Last 2 days of month + 1st of next', last7: 'Last 7 days only' };
const VIS_HINT = {
  always: 'The employee can open their salary statement any time.',
  window: 'The statement opens on the last 2 days of the month and on the 1st of the next month. Hidden on other days.',
  last7: 'Only the last 7 days of records, without monthly totals.',
};

/** Pick co-workers (without a phone) that this employee can check in on their own phone. */
function HelperPicker({ id, value, onChange }) {
  const st = useLoad(() => api.get('/api/admin/employees'), []);
  const [open, setOpen] = useState(value.length > 0);
  const others = (st.data?.employees || []).filter((e) => e.id !== id && e.active);
  const names = others.filter((e) => value.includes(e.id)).map((e) => nm(e)).join(', ');
  return (
    <div class="card">
      <h2>{t('Check in other staff')}</h2>
      <p class="small muted" style="margin:0 0 8px">{t('For staff without a phone. This employee can check in and out the people you tick, on their own phone. Each person types their own PIN, and the phone must be inside the store.')}</p>
      <Toggle checked={open} onChange={(v) => { setOpen(v); if (!v) onChange([]); }} label={t('Allow on this phone')} sub={value.length ? `${t('{n} people', { n: value.length })}: ${names}` : t('Nobody yet')} />
      {open && (
        <div class="list" style="margin:8px 0 0;box-shadow:none;border:1px solid var(--line)">
          {!others.length && <Empty icon="users" text={t('No staff yet')} />}
          {others.map((e) => {
            const on = value.includes(e.id);
            return (
              <label key={e.id} class="row" style="cursor:pointer">
                <input type="checkbox" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== e.id) : [...value, e.id])} style="width:20px;height:20px;accent-color:var(--red)" />
                <div class="main"><div class="title">{nm(e)} <span class="muted small ltr">{e.code}</span></div></div>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function StaffForm({ id }) {
  const app = useApp();
  const s = app.settings;
  const [f, setF] = useState(null);
  const [photo, setPhoto] = useState(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id) {
      setF({ name: '', nameUr: '', code: '', phone: '', cnic: '', roleId: s.roles[1]?.id || s.roles[0].id, shiftId: s.shifts[0].id, salary: '', weeklyOff: null,
        fieldStaff: false, kioskAllowed: true, helperFor: [], paidLeavePerMonth: '', salaryVisibility: 'always', joinDate: todayStr(api.serverNow()), notes: '', active: true, pin: '',
        fatherName: '', dob: '', address: '', emergencyName: '', emergencyPhone: '', branchId: app.me.branchId || '', webAllowed: false });
    } else {
      api.get(`/api/admin/employees/${id}`).then((r) => setF({ ...r.employee, helperFor: r.employee.helperFor || [], paidLeavePerMonth: r.employee.paidLeavePerMonth ?? '', pin: '' })).catch(toastErr);
    }
  }, [id]);
  if (!f) return <div class="screen"><TopBar back title={t('Employee')} /><Spinner /></div>;
  const set = (k, v) => setF({ ...f, [k]: v });
  const inp = (k) => (e) => set(k, e.currentTarget.value);
  const customOff = Array.isArray(f.weeklyOff);
  const pickPhoto = async (e) => {
    const file = e.currentTarget.files[0];
    if (file) setPhoto(await resizePhoto(file));
  };
  const save = async () => {
    if (!f.name.trim()) return toast(t('Name is required'), 'err');
    if (!id && !/^\d{4,6}$/.test(f.pin || '')) return toast(t('Set a 4-6 digit PIN for the employee'), 'err');
    if (f.pin && !/^\d{4,6}$/.test(f.pin)) return toast(t('PIN must be 4 to 6 digits.'), 'err');
    setBusy(true);
    try {
      const body = { ...f, salary: f.salary === '' ? 0 : Number(f.salary), paidLeavePerMonth: f.paidLeavePerMonth === '' ? null : Number(f.paidLeavePerMonth) };
      if (!body.pin) delete body.pin;
      if (photo !== undefined) body.photo = photo;
      const r = id ? await api.put(`/api/admin/employees/${id}`, body) : await api.post('/api/admin/employees', body);
      toast(r.salaryPendingOwner ? t('Saved. The salary change waits for the owner.') : t('Saved'), 'ok');
      if (id) goBack(); else go(`staff/${r.employee.id}`);
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  return (
    <div class="screen no-nav">
      <TopBar back title={id ? t('Edit employee') : t('Add employee')} />
      <div class="wrap">
        <div class="card">
          <div class="gap" style="margin-bottom:12px">
            {photo ? <div class="avatar lg"><img src={photo} alt="" /></div>
              : <Avatar lg name={f.name} src={id && f.hasPhoto ? `/api/admin/employees/${id}/photo` : null} ver={f.photoVer} />}
            <div style="display:grid;gap:8px">
              <label class="btn small ghost"><Icon n="camera" />{t('Take photo')}<input type="file" accept="image/*" capture="user" style="display:none" onChange={pickPhoto} /></label>
              <label class="btn small ghost"><Icon n="users" />{t('Choose from gallery')}<input type="file" accept="image/*" style="display:none" onChange={pickPhoto} /></label>
            </div>
          </div>
          <Field label={t('Full name')}><input class="input" value={f.name} onInput={inp('name')} /></Field>
          <Field label={t('Name in Urdu (optional)')}><input class="input" dir="rtl" style="font-family:Naskh,serif" value={f.nameUr} onInput={inp('nameUr')} /></Field>
          <div class="two">
            <Field label={t('Employee code')} hint={id ? '' : t('Leave empty for automatic')}><input class="input ltr" style="width:100%" value={f.code} onInput={inp('code')} placeholder="E001" /></Field>
            <Field label={t('Phone')}><input class="input ltr" style="width:100%" inputmode="tel" value={f.phone} onInput={inp('phone')} placeholder="03xx xxxxxxx" /></Field>
          </div>
          <Field label={t('CNIC (optional)')}><input class="input ltr" style="width:100%" value={f.cnic} onInput={inp('cnic')} placeholder="xxxxx-xxxxxxx-x" /></Field>
        </div>

        <div class="card">
          <h2>{t('Staff file')}</h2>
          <Field label={t("Father's name")}><input class="input" value={f.fatherName || ''} onInput={inp('fatherName')} /></Field>
          <Field label={t('Date of birth')} hint={t('Used for the birthday wish')}><input class="input ltr" style="width:100%" type="date" value={f.dob || ''} onInput={inp('dob')} /></Field>
          <Field label={t('Address')}><input class="input" value={f.address || ''} onInput={inp('address')} /></Field>
          <div class="two">
            <Field label={t('Emergency contact name')}><input class="input" value={f.emergencyName || ''} onInput={inp('emergencyName')} /></Field>
            <Field label={t('Emergency phone')}><input class="input ltr" style="width:100%" inputmode="tel" value={f.emergencyPhone || ''} onInput={inp('emergencyPhone')} placeholder="03xx xxxxxxx" /></Field>
          </div>
          {id && <p class="small muted" style="margin:0">{t('CNIC photos and the contract are added on the profile page.')}</p>}
        </div>

        <div class="card">
          <h2>{t('Job')}</h2>
          <div class="two">
            <Field label={t('Role')}>
              <select class="input" value={f.roleId} onChange={inp('roleId')}>{s.roles.map((r) => <option key={r.id} value={r.id}>{nm(r)}</option>)}</select>
            </Field>
            <Field label={t('Shift')}>
              <select class="input" value={f.shiftId} onChange={inp('shiftId')}>{s.shifts.map((x) => <option key={x.id} value={x.id}>{nm(x)} {x.start}–{x.end}</option>)}</select>
            </Field>
          </div>
          {app.can('payroll.view') && (
            <Field label={t('Monthly salary ({c})', { c: s.currency })}><MoneyInput value={f.salary} onValue={(v) => set('salary', v)} /></Field>
          )}
          {(s.locations || []).length > 1 && !app.me.branchId && (
            <Field label={t('Branch')} hint={t('The employee must check in at this branch.')}>
              <select class="input" value={f.branchId || ''} onChange={inp('branchId')}>
                <option value="">{t('Any branch')}</option>
                {s.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
          )}
          <Field label={t('Joining date')}><input class="input ltr" style="width:100%" type="date" value={f.joinDate || ''} onInput={inp('joinDate')} /></Field>
          <Field label={t('Weekly off')}>
            <Seg value={customOff ? 'custom' : 'store'} onChange={(v) => set('weeklyOff', v === 'store' ? null : [...s.weeklyOff])}
              options={[['store', t('Store default')], ['custom', t('Own days')]]} />
            {customOff && (
              <div class="chips" style="margin-top:8px">
                {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                  <button key={d} type="button" class={`chip ${f.weeklyOff.includes(d) ? 'on' : ''}`}
                    onClick={() => set('weeklyOff', f.weeklyOff.includes(d) ? f.weeklyOff.filter((x) => x !== d) : [...f.weeklyOff, d])}>{dayShort(d)}</button>
                ))}
              </div>
            )}
          </Field>
          <Toggle checked={f.fieldStaff} onChange={(v) => set('fieldStaff', v)} label={t('Field staff (works out of store)')} sub={t('Can check in and out from anywhere. Location is saved.')} />
          <Toggle checked={f.active} onChange={(v) => set('active', v)} label={t('Active')} sub={t('Inactive staff cannot log in and are not counted')} />
          <Toggle checked={!!f.webAllowed} onChange={(v) => set('webAllowed', v)} label={t('Allow the web version (iPhone)')} sub={t('For staff without an Android phone. They open the staff web page in Safari. Same PIN and location rules.')} />
        </div>

        <div class="card">
          <h2>{t('Leave & salary view')}</h2>
          <Field label={t('Paid leave days per month')} hint={t('Leave empty to use the store rule ({n} days)', { n: s.rules.paidLeavePerMonth })}>
            <input class="input ltr" style="width:100%" type="number" inputmode="numeric" value={f.paidLeavePerMonth} onInput={inp('paidLeavePerMonth')} />
          </Field>
          <Field label={t('Employee can see salary statement')}>
            <Seg value={f.salaryVisibility} onChange={(v) => set('salaryVisibility', v)} options={[['always', t('Always')], ['window', t('Month end only')], ['last7', t('Last 7 days')]]} />
          </Field>
          <p class="small muted" style="margin:-4px 0 0">{VIS_HINT[f.salaryVisibility] && t(VIS_HINT[f.salaryVisibility])}</p>
        </div>

        <HelperPicker id={id} value={f.helperFor} onChange={(v) => set('helperFor', v)} />

        <div class="card">
          <h2>{t('Login PIN')}</h2>
          <Field label={id ? t('New PIN (leave empty to keep)') : t('PIN for the employee app and kiosk')} hint={t('4 to 6 digits. Give it to the employee privately.')}>
            <input class="input ltr" style="width:100%" inputmode="numeric" maxLength={6} value={f.pin} onInput={(e) => set('pin', e.currentTarget.value.replace(/\D/g, ''))} />
          </Field>
          <Field label={t('Notes')}><textarea class="input" value={f.notes} onInput={inp('notes')} /></Field>
        </div>
        <button class="btn block" disabled={busy} onClick={save} style="margin-bottom:20px">{busy ? <Spinner sm /> : t('Save')}</button>
      </div>
    </div>
  );
}

export function StaffDetail({ id, tab, q }) {
  const app = useApp();
  const st = useLoad(() => api.get(`/api/admin/employees/${id}`), [id]);
  useEffect(() => { st.reload(true); }, [app.ver]);
  const tabs = [['info', t('Profile')], ['cal', t('Calendar')], ['notes', t('Notes')], app.can('payroll.view') && ['money', t('Money')], app.can('audit.view') && ['log', t('History')]].filter(Boolean);
  return (
    <div class="screen">
      <TopBar back={() => go('staff')} title={st.data ? nm(st.data.employee) : t('Employee')}
        right={app.can('employees.edit') && <button class="iconbtn" onClick={() => go(`staff/${id}/edit`)} aria-label={t('Edit')}><Icon n="edit" /></button>} />
      <div class="wrap">
        <Loader st={st}>{({ employee: e }) => (
          <div>
            <div class="card gap">
              <Avatar lg name={e.name} src={e.hasPhoto ? `/api/admin/employees/${e.id}/photo` : null} ver={e.photoVer} />
              <div class="grow">
                <b style="font-size:19px">{nm(e)}</b>
                <div class="muted">{nm(app.settings.roles.find((r) => r.id === e.roleId))} · <span class="ltr">{e.code}</span></div>
                <div class="gap" style="margin-top:6px">
                  {!e.active && <Pill s="absent">{t('Inactive')}</Pill>}
                  {e.fieldStaff && <Pill s="duty">{t('Field staff')}</Pill>}
                  {e.branchId && (app.settings.locations || []).length > 1 && <span class="pill st-notyet"><Icon n="map" />{branchName(app, e.branchId)}</span>}
                  {e.webAllowed && <span class="pill st-notyet">{t('Web version')}</span>}
                  {e.deviceBound ? <span class="pill st-in"><Icon n="phone" />{t('Phone linked')}</span> : <span class="pill st-notyet">{t('No phone linked')}</span>}
                </div>
              </div>
            </div>
            {app.can('employees.edit') && (
              <div class="btn-row" style="margin:0 0 12px">
                <button class="btn ghost" onClick={() => go(`staff/${id}/edit`)}><Icon n="edit" />{t('Edit details')}</button>
                <button class="btn soft" onClick={() => delEmp(e)}><Icon n="trash" />{t('Delete')}</button>
              </div>
            )}
            <div class="tabs">{tabs.map(([k, l]) => <button key={k} class={`chip ${tab === k ? 'on' : ''}`} onClick={() => replace(`staff/${id}/${k}`)}>{l}</button>)}</div>
            {tab === 'info' && <Info e={e} reload={() => st.reload(true)} />}
            {tab === 'cal' && <EmpCalendar e={e} />}
            {tab === 'money' && <Money e={e} />}
            {tab === 'notes' && <NotesTab e={e} />}
            {tab === 'log' && <EmpLog e={e} />}
          </div>
        )}</Loader>
      </div>
    </div>
  );
}

async function delEmp(e) {
  if (!(await confirmBox({ title: t('Delete {name}?', { name: e.name }), text: t('The employee is removed from lists. Old attendance and salary records are kept.'), yes: t('Delete'), danger: true }))) return;
  try { await api.del(`/api/admin/employees/${e.id}`); toast(t('Deleted'), 'ok'); go('staff'); } catch (err) { toastErr(err); }
}

function Info({ e, reload }) {
  const app = useApp();
  const s = app.settings;
  const shift = s.shifts.find((x) => x.id === e.shiftId);
  const off = (Array.isArray(e.weeklyOff) ? e.weeklyOff : s.weeklyOff).map(dayShort).join(', ') || t('None');
  const resetPhone = async () => {
    if (!(await confirmBox({ title: t('Reset phone for {name}?', { name: e.name }), text: t('The old phone stops working at once. The employee can then log in on a new phone.'), yes: t('Reset phone'), danger: true }))) return;
    try { await api.post(`/api/admin/employees/${e.id}/reset-device`); toast(t('Phone reset'), 'ok'); reload(); } catch (err) { toastErr(err); }
  };
  const month = todayStr(api.serverNow()).slice(0, 7);
  return (
    <div>
      <div class="card">
        <div class="kv"><span class="k">{t('Phone')}</span><span class="v ltr">{e.phone || '—'}</span></div>
        {e.cnic && <div class="kv"><span class="k">{t('CNIC')}</span><span class="v ltr">{e.cnic}</span></div>}
        <div class="kv"><span class="k">{t('Shift')}</span><span class="v">{nm(shift)} <span class="ltr">{shift?.start}–{shift?.end}</span></span></div>
        <div class="kv"><span class="k">{t('Weekly off')}</span><span class="v">{off}</span></div>
        {app.can('payroll.view') && <div class="kv"><span class="k">{t('Monthly salary')}</span><span class="v">{fmtMoney(e.salary, s.currency)}{e.salaryPending != null && <div class="small" style="color:var(--orange)">{t('Change to {a} waits for the owner', { a: fmtMoney(e.salaryPending, s.currency) })}</div>}</span></div>}
        {app.can('payroll.view') && <div class="kv"><span class="k">{t('Security deposit')}</span><span class="v">{fmtMoney(e.depositBalance, s.currency)}</span></div>}
        <div class="kv"><span class="k">{t('Joined')}</span><span class="v">{e.joinDate ? fmtDate(e.joinDate) : '—'}</span></div>
        <div class="kv"><span class="k">{t('Paid leave / month')}</span><span class="v">{e.paidLeavePerMonth ?? `${s.rules.paidLeavePerMonth} (${t('store rule')})`}</span></div>
        <div class="kv"><span class="k">{t('Salary statement')}</span><span class="v">{t(VIS_LABEL[e.salaryVisibility] || VIS_LABEL.always)}</span></div>
        {e.helperFor?.length > 0 && <div class="kv"><span class="k">{t('Can check in others')}</span><span class="v">{t('{n} people', { n: e.helperFor.length })}</span></div>}
        <div class="kv"><span class="k">{t('Phone')}</span><span class="v">{e.deviceBound ? `${t('Linked')} ${e.deviceName ? `(${e.deviceName})` : ''}` : t('Not linked yet')}</span></div>
        <div class="kv"><span class="k">{t('Rules agreement')}</span><span class="v">{e.rulesAccepted?.current ? `${t('Accepted')} · ${fmtDateTime(e.rulesAccepted.ts)}` : e.rulesAccepted ? t('Accepted an older version') : t('Not accepted yet')}</span></div>
        {e.notes && <div class="kv"><span class="k">{t('Notes')}</span><span class="v">{e.notes}</span></div>}
      </div>
      <StaffFile e={e} />
      <div style="display:grid;gap:10px;margin-bottom:20px">
        {app.can('payroll.view') && <button class="btn ghost" onClick={() => go(`payroll/${e.id}?month=${month}`)}><Icon n="money" />{t('Salary statement')}</button>}
        {app.can('payroll.view') && <button class="btn ghost" onClick={() => go(`staff/${e.id}/settle`)}><Icon n="out" />{e.active ? t('Final settlement (leaving)') : t('Final settlement')}</button>}
        {app.me.role === 'owner' && e.deviceBound && <button class="btn ghost" onClick={resetPhone}><Icon n="phone" />{t('Reset phone (allow new phone)')}</button>}
      </div>
    </div>
  );
}

function EmpCalendar({ e }) {
  const today = todayStr(api.serverNow());
  const [month, setMonth] = useState(today.slice(0, 7));
  const [day, setDay] = useState(null);
  const st = useLoad(() => api.get(`/api/admin/employees/${e.id}/calendar?month=${month}`), [month]);
  return (
    <div class="card">
      <MonthNav month={month} onChange={setMonth} max={today.slice(0, 7)} />
      <Loader st={st}>{(data) => {
        const c = {};
        for (const d of data.days) c[d.status] = (c[d.status] || 0) + 1;
        return (
          <div>
            <Calendar month={month} days={data.days} today={today} onPick={(d) => d.status !== 'future' && setDay(d.date)} />
            <hr class="sep" />
            <div class="gap small">
              {['present', 'late', 'absent', 'leave', 'off', 'duty'].map((k) => <span key={k} class={`pill st-${k}`}>{statusLabel(k)} {c[k] || 0}</span>)}
            </div>
          </div>
        );
      }}</Loader>
      {day && <DayDetail e={e} date={day} onClose={() => setDay(null)} onChanged={() => st.reload(true)} />}
    </div>
  );
}

export function DayDetail({ e, date, onClose, onChanged }) {
  const app = useApp();
  const st = useLoad(() => api.get(`/api/admin/employees/${e.id}/day/${date}`), [date]);
  const [photo, setPhoto] = useState(null);
  const voidP = async (p) => {
    if (!(await confirmBox({ title: t('Remove this punch?'), text: `${p.type === 'in' ? t('Check in') : t('Check out')} ${fmtTime(p.ts)}`, yes: t('Remove'), danger: true }))) return;
    try { await api.post(`/api/admin/punches/${p.id}/void`, { reason: 'Removed by admin' }); toast(t('Removed'), 'ok'); st.reload(true); onChanged(); } catch (err) { toastErr(err); }
  };
  const showPhoto = async (p) => { try { setPhoto(await api.image(`/api/admin/punches/${p.id}/photo`)); } catch (err) { toastErr(err); } };
  const mapUrl = (p) => `https://www.google.com/maps?q=${p.lat},${p.lng}`;
  return (
    <Sheet open onClose={onClose} title={fmtDate(date)}>
      <Loader st={st}>{({ day: d }) => (
        <div>
          <div class="gap" style="margin-bottom:8px"><Pill s={d.status} />{d.holiday && <span class="small muted">{d.holiday}</span>}{d.mark && <span class="small muted">{t('Marked by admin')}</span>}</div>
          <div class="kv"><span class="k">{t('Hours worked')}</span><span class="v">{fmtDur(d.workedMin)}</span></div>
          <div class="kv"><span class="k">{t('Late')}</span><span class="v">{t('{m} min', { m: d.lateMin })}</span></div>
          {d.awayMin > 0 && <div class="kv"><span class="k">{t('Away (counted as late)')}</span><span class="v">{t('{m} min', { m: d.awayMin })}{(d.gaps || []).map((g) => <div key={g.out} class="small muted ltr">{fmtTime(g.out)} → {fmtTime(g.in)}</div>)}</span></div>}
          <div class="kv"><span class="k">{t('Left early')}</span><span class="v">{t('{m} min', { m: d.earlyMin })}</span></div>
          <div class="kv"><span class="k">{t('Break')}</span><span class="v">{fmtDur(d.breakMin)}{d.breakLateMin ? ` · ${t('{m} min late', { m: d.breakLateMin })}` : ''}</span></div>
          <div class="section-title">{t('Punches')}</div>
          <div class="list" style="margin-top:0">
            {!d.punches.length && <div class="empty small">{t('No punches')}</div>}
            {d.punches.map((p) => (
              <div key={p.id} class="row" style={p.voided ? 'opacity:.45;text-decoration:line-through' : ''}>
                <Icon n={p.type === 'in' ? 'in' : 'out'} />
                <div class="main">
                  <div class="title">{p.type === 'in' ? t('Check in') : t('Check out')} · {fmtTime(p.ts)}</div>
                  <div class="sub">
                    {p.source.startsWith('kiosk') ? t('Kiosk') : p.source === 'admin' ? t('By admin') : p.source === 'request' ? t('From request') : t('Phone app')}
                    {p.offline ? ` · ${t('offline, synced later')}` : ''}
                    {p.dist != null ? ` · ${t('{m} m from store', { m: p.dist })}` : ''}
                    {p.reason ? ` · ${p.reason}` : ''}
                  </div>
                </div>
                <div class="gap">
                  {p.lat != null && <a class="iconbtn" href={mapUrl(p)} target="_blank" rel="noopener" aria-label={t('Map')}><Icon n="map" /></a>}
                  {p.hasPhoto && <button class="iconbtn" onClick={() => showPhoto(p)} aria-label={t('Photo')}><Icon n="camera" /></button>}
                  {!p.voided && app.can('attendance.punch') && <button class="iconbtn" onClick={() => voidP(p)} aria-label={t('Remove')}><Icon n="trash" /></button>}
                </div>
              </div>
            ))}
          </div>
          {d.requests.length > 0 && <div class="section-title">{t('Requests')}</div>}
          {d.requests.map((r) => <div key={r.id} class="kv"><span class="k">{reqLabel(r.type)}</span><Pill s={r.status} /></div>)}
          {photo && <img src={photo} alt="" style="width:100%;border-radius:12px;margin-top:10px" onClick={() => setPhoto(null)} />}
        </div>
      )}</Loader>
    </Sheet>
  );
}

const KINDS = [['advance', 'Advance'], ['bonus', 'Bonus'], ['commission', 'Commission'], ['fine', 'Fine'], ['deposit', 'Security deposit (paid in)'], ['deposit_cut', 'Deposit cut from salary'], ['deposit_return', 'Deposit returned']];
function Money({ e }) {
  const app = useApp();
  const cur = app.settings.currency;
  const st = useLoad(() => api.get(`/api/admin/employees/${e.id}/money`), [e.id]);
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ kind: 'advance', amount: '', note: '', installments: 1, month: todayStr(api.serverNow()).slice(0, 7) });
  const save = async () => {
    try {
      const r = await api.post('/api/admin/money', { employeeId: e.id, ...f, amount: Number(f.amount) });
      toast(r.pendingOwner ? t('Sent to the owner for approval') : t('Saved'), 'ok');
      setAdd(false);
      setF({ ...f, amount: '', note: '' });
      st.reload(true);
    } catch (err) { toastErr(err); }
  };
  const voidM = async (m) => {
    if (!(await confirmBox({ title: t('Remove this entry?'), yes: t('Remove'), danger: true }))) return;
    try {
      const r = await api.post(`/api/admin/money/${m.id}/void`);
      if (r.pendingOwner) toast(t('Sent to the owner for approval'), 'ok');
      st.reload(true);
    } catch (err) { toastErr(err); }
  };
  const label = moneyLabel;
  return (
    <div>
      <Loader st={st}>{(data) => (
        <div>
          <div class="card gap" style="justify-content:space-between">
            <div><div class="muted small">{t('Security deposit balance')}</div><div class="big-number">{fmtMoney(data.depositBalance, cur)}</div></div>
            <Icon n="shield" />
          </div>
          {app.can('money.edit') && <button class="btn block" onClick={() => setAdd(true)}><Icon n="plus" />{t('Add advance / bonus / fine / deposit')}</button>}
          <div class="list">
            {!data.entries.length && <Empty icon="wallet" text={t('No money entries yet')} />}
            {data.entries.map((m) => (
              <div key={m.id} class="row" style={m.voided ? 'opacity:.45;text-decoration:line-through' : ''}>
                <div class="main">
                  <div class="title">{label(m.kind)} · {m.kind === 'fine' ? '− ' : ''}{fmtMoney(m.amount, cur)}</div>
                  <div class="sub">{fmtMonth(m.month)} · {fmtDateTime(m.ts)}{m.note ? ` · ${m.note}` : ''}</div>
                  {m.pendingOwner && <div style="margin-top:4px"><Pill s="pending">{t('Waiting for owner')}</Pill></div>}
                  {m.removalPending && <div style="margin-top:4px"><Pill s="pending">{t('Removal waits for owner')}</Pill></div>}
                </div>
                {!m.voided && !m.removalPending && app.can('money.edit') && <button class="iconbtn" onClick={() => voidM(m)}><Icon n="trash" /></button>}
              </div>
            ))}
          </div>
        </div>
      )}</Loader>
      <Sheet open={add} onClose={() => setAdd(false)} title={t('Add money entry')}>
        <Field label={t('Type')}><select class="input" value={f.kind} onChange={(ev) => setF({ ...f, kind: ev.currentTarget.value })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select></Field>
        <div class="two">
          <Field label={t('Amount ({c})', { c: cur })}><MoneyInput value={f.amount} onValue={(v) => setF({ ...f, amount: v })} /></Field>
          <Field label={t('Salary month')}><input class="input ltr" style="width:100%" type="month" value={f.month} onInput={(ev) => setF({ ...f, month: ev.currentTarget.value })} /></Field>
        </div>
        {f.kind === 'advance' && (
          <Field label={t('Cut from salary in')} hint={f.installments > 1 && f.amount ? t('{a} a month for {n} months', { a: fmtMoney(Math.floor(Number(f.amount) / f.installments), cur), n: f.installments }) : ''}>
            <Chips value={String(f.installments)} onChange={(v) => setF({ ...f, installments: Number(v) })} options={[1, 2, 3, 4, 6].map((n) => [String(n), n === 1 ? t('1 month') : t('{n} months', { n })])} />
          </Field>
        )}
        <Field label={f.kind === 'fine' ? t('Reason (required)') : ['bonus', 'commission'].includes(f.kind) ? t('Note (shown on payslip)') : t('Note')}><input class="input" value={f.note} onInput={(ev) => setF({ ...f, note: ev.currentTarget.value })} /></Field>
        <button class="btn block" disabled={!f.amount || (f.kind === 'fine' && !f.note.trim())} onClick={save}>{t('Save')}</button>
      </Sheet>
    </div>
  );
}

function EmpLog({ e }) {
  const st = useLoad(() => api.get(`/api/admin/audit?target=${e.id}&limit=100`), [e.id]);
  return <Loader st={st}>{(data) => <AuditList entries={data.entries} />}</Loader>;
}

export function AuditList({ entries }) {
  if (!entries.length) return <Empty icon="log" text={t('Nothing recorded yet')} />;
  return (
    <div class="list">
      {entries.map((a) => (
        <div key={a.id} class="row">
          <div class="main">
            <div class="title">{auditLabel(a.action)}{a.detail?.name ? ` · ${a.detail.name}` : ''}</div>
            <div class="sub" style="white-space:normal">{auditText(a)}</div>
          </div>
          <div class="end small">{a.actor_name}<br />{fmtDateTime(a.ts)}</div>
        </div>
      ))}
    </div>
  );
}
function auditText(a) {
  const d = a.detail || {};
  const bits = [];
  if (d.reason) bits.push(`${t('Reason')}: ${d.reason}`);
  if (d.note) bits.push(`${t('Note')}: ${d.note}`);
  if (d.type) bits.push(reqLabel(d.type));
  if (d.amount) bits.push(String(d.amount));
  if (d.status) bits.push(d.status);
  if (d.dates) bits.push(d.dates.join(', '));
  if (d.date || d.time) bits.push(`${d.date || ''} ${d.time || ''}`);
  if (d.changes) bits.push(Object.keys(d.changes).join(', '));
  if (d.changed) bits.push(d.changed.join(', '));
  return bits.join(' · ');
}

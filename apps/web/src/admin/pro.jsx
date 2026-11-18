// Owner tools: approvals of manager changes, cloud backups, server health, staff rules agreement, month lock.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t, nm, moneyLabel, getLang } from '../shared/i18n.js';
import { fmtMoney, fmtDateTime, fmtMonth, ago } from '../shared/format.js';
import { TopBar, Icon, Pill, Field, Loader, useLoad, toast, toastErr, Spinner, Banner, Dialog, confirmBox, Empty, Seg } from '../shared/ui.jsx';
import { useApp } from './app.jsx';
import { AffordDevice } from 'afford-device';

// ---------------------------------------------------------------- owner approvals
function approvalText(a, cur) {
  const d = a.data;
  if (a.kind === 'salary') return t('Salary {a} → {b}', { a: fmtMoney(d.from, cur), b: fmtMoney(d.to, cur) });
  if (a.kind === 'money_void') return `${t('Remove')}: ${moneyLabel(d.kind)} ${fmtMoney(d.amount, cur)} · ${fmtMonth(d.month)}`;
  return `${moneyLabel(d.kind)} ${fmtMoney(d.amount, cur)} · ${fmtMonth(d.month)}${d.note ? ` · ${d.note}` : ''}`;
}

/** Shown at the top of Requests for the owner. */
export function OwnerApprovals() {
  const app = useApp();
  const st = useLoad(() => api.get('/api/admin/approvals'), []);
  useEffect(() => { st.reload(true); }, [app.ver, app.ownerPending]);
  const [busy, setBusy] = useState(null);
  const cur = app.settings.currency;
  const decide = async (a, approve) => {
    setBusy(a.id + approve);
    try {
      await api.post(`/api/admin/approvals/${a.id}/decide`, { approve });
      toast(approve ? t('Approved') : t('Declined'), 'ok');
      st.reload(true);
      app.refreshChanges();
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  const list = st.data?.approvals || [];
  if (!list.length) return null;
  return (
    <div>
      <div class="section-title">{t('Waiting for your approval')}</div>
      <div class="list">
        {list.map((a) => (
          <div key={a.id} class="row" style="flex-wrap:wrap">
            <div class="avatar" style="background:var(--orange-soft);color:var(--orange)"><Icon n={a.kind === 'salary' ? 'money' : 'wallet'} /></div>
            <div class="main">
              <div class="title" style="white-space:normal">{nm(a.employee) || "—"} · {approvalText(a, cur)}</div>
              <div class="sub">{t('By {name}', { name: a.by_name || '?' })} · {ago(a.created, api.serverNow())}</div>
            </div>
            <div class="btn-row" style="width:100%;margin-top:8px">
              <button class="btn soft" disabled={!!busy} onClick={() => decide(a, false)}>{busy === a.id + false ? <Spinner sm /> : <><Icon n="x" />{t('Decline')}</>}</button>
              <button class="btn green" disabled={!!busy} onClick={() => decide(a, true)}>{busy === a.id + true ? <Spinner sm /> : <><Icon n="check" />{t('Approve')}</>}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- cloud backups + health
export function CloudBackups() {
  const st = useLoad(() => api.get('/api/admin/cloud-backups'), []);
  const [busy, setBusy] = useState(null);
  const [restore, setRestore] = useState(null);
  const now = async () => {
    setBusy('now');
    try { await api.post('/api/admin/cloud-backups', {}, { timeoutMs: 60000 }); toast(t('Cloud backup saved'), 'ok'); st.reload(true); } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  const download = async (b) => {
    setBusy(b.name);
    try {
      const res = await api.call('GET', `/api/admin/cloud-backups/${b.name}`, null, { raw: true, timeoutMs: 60000 });
      await AffordDevice.shareFile({ filename: `${b.name}.json`, text: await res.text(), mime: 'application/json', title: b.name });
    } catch (e) { toastErr(e); } finally { setBusy(null); }
  };
  return (
    <div class="card">
      <h2>{t('Cloud backup')}</h2>
      <p class="small muted" style="margin:0 0 10px">{t('Every day the server saves a full backup in separate cloud storage. The last 30 days are kept. It works even if every phone is lost.')}</p>
      <Loader st={st}>{(d) => (
        <div>
          {d.last ? <p class="small" style="margin:0 0 10px"><Icon n="check" /> {t('Last cloud backup')}: <b>{fmtDateTime(d.last.last)}</b></p>
            : <p class="small muted" style="margin:0 0 10px">{t('No cloud backup yet. The first one is made within an hour.')}</p>}
          <button class="btn block" disabled={!!busy} onClick={now}>{busy === 'now' ? <Spinner sm /> : <><Icon n="refresh" />{t('Back up to cloud now')}</>}</button>
          <div class="list">
            {d.backups.slice(0, 30).map((b) => (
              <div key={b.name} class="row">
                <Icon n="download" />
                <div class="main"><div class="title">{fmtDateTime(b.created)}</div><div class="sub ltr">{Math.max(1, Math.round(b.size / 1024))} KB</div></div>
                <button class="iconbtn" aria-label="download" disabled={!!busy} onClick={() => download(b)}>{busy === b.name ? <Spinner sm /> : <Icon n="download" />}</button>
                <button class="iconbtn" aria-label="restore" onClick={() => setRestore(b)}><Icon n="refresh" /></button>
              </div>
            ))}
          </div>
        </div>
      )}</Loader>
      {restore && <CloudRestore b={restore} onClose={() => setRestore(null)} />}
    </div>
  );
}

function CloudRestore({ b, onClose }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const go1 = async () => {
    setBusy(true);
    try {
      const chk = await api.post(`/api/admin/cloud-backups/${b.name}/restore`, { pin, check: true }, { timeoutMs: 120000 });
      const ok = await confirmBox({
        title: t('Replace all data?'),
        text: t('Backup from {d} with {n} staff. Everything added after it will be lost.', { d: fmtDateTime(chk.info.created || b.created), n: chk.info.employees }),
        yes: t('Restore'), danger: true,
      });
      if (!ok) { setBusy(false); return; }
      await api.post(`/api/admin/cloud-backups/${b.name}/restore`, { pin }, { timeoutMs: 120000 });
      toast(t('Data restored'), 'ok');
      setTimeout(() => location.reload(), 900);
    } catch (e) { toastErr(e); setBusy(false); }
  };
  return (
    <Dialog open title={t('Restore backup')} onClose={busy ? undefined : onClose}>
      <p class="small" style="margin:0 0 8px">{t('Cloud backup')} · <b>{fmtDateTime(b.created)}</b></p>
      <Banner kind="warn">{t('Restoring replaces ALL current data with the data in the backup file.')}</Banner>
      <Field label={t('Your PIN')}><input class="input ltr" style="width:100%" type="password" inputmode="numeric" maxLength={6} value={pin} onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))} /></Field>
      <div class="btn-row">
        <button class="btn ghost" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
        <button class="btn" disabled={busy || pin.length < 4} onClick={go1}>{busy ? <Spinner sm /> : t('Restore')}</button>
      </div>
    </Dialog>
  );
}

export function ServerHealth() {
  const st = useLoad(() => api.get('/api/admin/health'), []);
  return (
    <div class="card">
      <h2>{t('Server health')}</h2>
      <Loader st={st}>{(d) => (
        <div>
          <div class="kv"><span class="k">{t('Instant alerts')}</span><span class="v">{d.push ? t('On') : t('Off')}</span></div>
          <div class="kv"><span class="k">{t('Cloud backup storage')}</span><span class="v">{d.cloud?.ok ? t('Working') : d.cloud ? t('Problem') : '—'}</span></div>
          <div class="kv"><span class="k">{t('Errors (last 50)')}</span><span class="v">{d.errors.length}</span></div>
          {!d.errors.length && <p class="small muted" style="margin:8px 0 0"><Icon n="check" /> {t('No server errors. If something fails, you get an alert on this phone.')}</p>}
          {d.errors.slice(0, 10).map((e, i) => (
            <div key={i} class="small" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line)">
              <b>{fmtDateTime(e.ts)}</b> <span class="muted ltr">{e.where}</span><div class="muted ltr" style="word-break:break-word">{e.msg}</div>
            </div>
          ))}
        </div>
      )}</Loader>
    </div>
  );
}

// ---------------------------------------------------------------- staff rules agreement
export function RulesAgreement() {
  const app = useApp();
  const owner = app.me.role === 'owner';
  const st = useLoad(() => api.get('/api/admin/policy'), []);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lang, setLangV] = useState(getLang());
  const save = async (body) => {
    setBusy(true);
    try { await api.put('/api/admin/policy', body); toast(t('Saved. Staff will be asked to accept again.'), 'ok'); setEdit(null); st.reload(true); } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  return (
    <div class="screen no-nav">
      <TopBar back title={t('Staff rules agreement')} />
      <div class="wrap">
        <Loader st={st}>{(d) => {
          const done = d.staff.filter((s) => s.current).length;
          return (
            <div>
              <p class="small muted" style="margin:12px 0">{t('Every employee must read and accept these rules in the staff app before they can use it. The date they accepted is saved.')}</p>
              <div style="margin-bottom:10px"><Seg value={lang} onChange={setLangV} options={[['en', 'English'], ['ur', 'اردو']]} /></div>
              <div class="card" dir={lang === 'ur' ? 'rtl' : 'ltr'}>
                <h2>{t('Rules')} · v{d.ver}</h2>
                <ol style="margin:0;padding-inline-start:20px;display:grid;gap:6px">{(lang === 'ur' ? d.ur : d.en).map((l, i) => <li key={i} class="small">{l}</li>)}</ol>
              </div>
              {owner && !edit && (
                <div class="btn-row" style="margin-bottom:12px">
                  <button class="btn ghost" onClick={() => setEdit({ extraEn: d.extraEn, extraUr: d.extraUr })}><Icon n="edit" />{t('Add your own rules')}</button>
                  <button class="btn soft" disabled={busy} onClick={async () => { if (await confirmBox({ title: t('Ask all staff to accept again?'), yes: t('Yes') })) save({ askAgain: true }); }}><Icon n="refresh" />{t('Ask all again')}</button>
                </div>
              )}
              {edit && (
                <div class="card">
                  <p class="small muted" style="margin:0 0 8px">{t('One rule per line. The standard rules above are made from your settings automatically.')}</p>
                  <Field label="English"><textarea class="input" rows={4} value={edit.extraEn} onInput={(e) => setEdit({ ...edit, extraEn: e.currentTarget.value })} /></Field>
                  <Field label="اردو"><textarea class="input" dir="rtl" rows={4} value={edit.extraUr} onInput={(e) => setEdit({ ...edit, extraUr: e.currentTarget.value })} /></Field>
                  <div class="btn-row">
                    <button class="btn ghost" onClick={() => setEdit(null)}>{t('Cancel')}</button>
                    <button class="btn" disabled={busy} onClick={() => save(edit)}>{busy ? <Spinner sm /> : t('Save')}</button>
                  </div>
                </div>
              )}
              <div class="section-title">{t('Accepted by {a} of {b} staff', { a: done, b: d.staff.length })}</div>
              <div class="list">
                {d.staff.map((s) => (
                  <div key={s.id} class="row">
                    <div class="main"><div class="title">{nm(s)} <span class="muted small ltr">{s.code}</span></div>
                      <div class="sub">{s.current ? `${t('Accepted')} · ${fmtDateTime(s.accepted.ts)}` : s.accepted ? t('Accepted an older version') : t('Not accepted yet')}</div></div>
                    <Pill s={s.current ? 'approved' : 'pending'}>{s.current ? t('Accepted') : t('Waiting')}</Pill>
                  </div>
                ))}
              </div>
            </div>
          );
        }}</Loader>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- month lock (payroll)
export function MonthLock({ month, locked, current, onChanged }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const owner = app.me.role === 'owner';
  const set = async (lock) => {
    const ok = await confirmBox(lock
      ? { title: t('Lock {m}?', { m: fmtMonth(month) }), text: t('Use this after salaries are paid. The salary figures are frozen and nobody can change attendance or money for this month. You can unlock it later.'), yes: t('Lock month') }
      : { title: t('Unlock {m}?', { m: fmtMonth(month) }), text: t('Changes will be allowed again and salary figures will be worked out fresh. This is saved in the audit log.'), yes: t('Unlock'), danger: true });
    if (!ok) return;
    setBusy(true);
    try { await api.post(`/api/admin/months/${month}/lock`, { lock }); toast(lock ? t('Month locked') : t('Month unlocked'), 'ok'); onChanged(); } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  if (locked) {
    return (
      <div class="banner ok" style="align-items:center">
        <Icon n="shield" />
        <div style="flex:1">{t('Locked. Salary is final.')}<div class="small" style="opacity:.8">{fmtDateTime(locked.ts)}{locked.by ? ` · ${locked.by}` : ''}</div></div>
        {owner && <button class="link small" disabled={busy} onClick={() => set(false)}>{busy ? <Spinner sm /> : t('Unlock')}</button>}
      </div>
    );
  }
  if (!owner || current) return null;
  return <button class="btn block ghost" style="margin-bottom:10px" disabled={busy} onClick={() => set(true)}>{busy ? <Spinner sm /> : <><Icon n="shield" />{t('Salary paid? Lock this month')}</>}</button>;
}

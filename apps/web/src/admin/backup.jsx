// Backup & restore (owner only).
// Auto backup: once a day, after the last shift ends, a full backup is saved in the phone's
// Downloads/Afford Backups folder. Files older than 7 days are removed. Restore reads a backup file back.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { api, LS } from '../shared/api.js';
import { t } from '../shared/i18n.js';
import { fmtDateTime, fmtDate } from '../shared/format.js';
import { TopBar, Icon, Toggle, Field, Spinner, Banner, Dialog, toast, toastErr, confirmBox } from '../shared/ui.jsx';
import { useApp } from './app.jsx';
import { CloudBackups, ServerHealth } from './pro.jsx';

const FOLDER = 'Afford Backups';
const KEEP_DAYS = 7;
const DAY = 86400000;

const lastInfo = () => { try { return JSON.parse(LS.get('afford.lastBackup') || 'null'); } catch { return null; } };
export const autoOn = () => LS.get('afford.autoBackup') !== '0';

/** Minutes after midnight when the last shift of the day ends (can be past 24:00). */
function lastShiftEnd(settings) {
  const hm = (s) => { const [a, b] = String(s || '0:0').split(':').map(Number); return a * 60 + (b || 0); };
  let end = 0;
  for (const sh of settings.shifts || []) {
    const s = hm(sh.start);
    let e = hm(sh.end);
    if (e <= s) e += 1440;
    end = Math.max(end, e);
  }
  return end || 1440;
}

/** The latest store day whose last shift has ended (plus 15 minutes). */
function dueDay(settings) {
  const wall = api.serverNow() + (settings.tzOffsetMin || 0) * 60000;
  const d = Math.floor((wall - (lastShiftEnd(settings) + 15) * 60000) / DAY);
  return new Date(d * DAY).toISOString().slice(0, 10);
}

/** Downloads a full backup and saves it in the phone's Downloads folder. */
export async function saveBackup(label) {
  const data = await api.get('/api/admin/backup', { timeoutMs: 60000 });
  const name = `afford-backup-${label}.json`;
  const r = await AffordDevice.saveDownload({ folder: FOLDER, filename: name, text: JSON.stringify(data), mime: 'application/json' });
  await AffordDevice.pruneDownloads({ folder: FOLDER, keepDays: KEEP_DAYS }).catch(() => {});
  const info = { at: Date.now(), path: r.path || name, employees: data.counts?.employees, punches: data.counts?.punches };
  LS.set('afford.lastBackup', JSON.stringify(info));
  return info;
}

let running = false;
/** Called every minute and when the app opens: saves the daily backup when it is due. */
export async function autoBackupTick(app) {
  if (running || app.me.role !== 'owner' || !autoOn() || !app.settings) return;
  const day = dueDay(app.settings);
  if ((LS.get('afford.autoBackupDay') || '') >= day) return;
  running = true;
  try {
    await saveBackup(day);
    LS.set('afford.autoBackupDay', day);
    toast(t('Daily backup saved in Downloads'), 'ok');
  } catch (e) {
    if (e.code !== 'NETWORK') console.warn('auto backup failed', e);
  } finally { running = false; }
}

export function BackupScreen() {
  const app = useApp();
  const [auto, setAuto] = useState(autoOn());
  const [last, setLast] = useState(lastInfo());
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null); // {name, backup, info}
  const pick = useRef(null);
  const end = lastShiftEnd(app.settings);
  const endTxt = `${String(Math.floor((end % 1440) / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;

  const now = async () => {
    setBusy(true);
    try {
      const d = new Date(api.serverNow() + (app.settings.tzOffsetMin || 0) * 60000).toISOString();
      const info = await saveBackup(`${d.slice(0, 10)}-${d.slice(11, 16).replace(':', '')}`);
      setLast(info);
      toast(t('Backup saved'), 'ok');
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };

  const onFile = async (e) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    try {
      const backup = JSON.parse(await f.text());
      if (backup?.format !== 'afford-backup') throw new Error();
      setFile({ name: f.name, backup });
    } catch { toast(t('This is not an Afford backup file'), 'err'); }
  };

  return (
    <div class="screen no-nav">
      <TopBar back title={t('Backup & restore')} />
      <div class="wrap">
        <div class="card">
          <h2>{t('Backup')}</h2>
          <p class="small muted" style="margin:0 0 10px">{t('A backup has all staff, attendance, requests, salary records and settings. Check-in selfies are not included.')}</p>
          <Toggle checked={auto} onChange={(v) => { setAuto(v); LS.set('afford.autoBackup', v ? '1' : '0'); }}
            label={t('Daily auto backup on this phone')} sub={t('Saved after the last shift ends ({t}) in Downloads/Afford Backups. Files older than 7 days are removed.', { t: endTxt })} />
          {last
            ? <p class="small" style="margin:10px 0"><Icon n="check" /> {t('Last backup')}: <b>{fmtDateTime(last.at)}</b><br /><span class="muted ltr">{last.path}</span></p>
            : <p class="small muted" style="margin:10px 0">{t('No backup on this phone yet.')}</p>}
          <button class="btn block" disabled={busy} onClick={now}>{busy ? <Spinner sm /> : <><Icon n="download" />{t('Back up now')}</>}</button>
          <p class="small muted" style="margin:8px 0 0">{t('The app must be opened at least once after closing time for the daily backup. If the phone was off, it is saved the next time you open the app.')}</p>
        </div>
        <CloudBackups />
        <div class="card">
          <h2>{t('Restore')}</h2>
          <Banner kind="warn">{t('Restoring replaces ALL current data with the data in the backup file.')}</Banner>
          <input ref={pick} type="file" accept=".json,application/json" style="display:none" onChange={onFile} />
          <button class="btn block ghost" onClick={() => pick.current.click()}><Icon n="refresh" />{t('Choose backup file')}</button>
        </div>
      </div>
      <div class="wrap"><ServerHealth /></div>
      {file && <RestoreDialog file={file} onClose={() => setFile(null)} />}
    </div>
  );
}

function RestoreDialog({ file, onClose }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const b = file.backup;
  const go1 = async () => {
    setBusy(true);
    try {
      const chk = await api.post('/api/admin/restore', { pin, backup: b, check: true }, { timeoutMs: 120000 });
      const ok = await confirmBox({
        title: t('Replace all data?'),
        text: t('Backup from {d} with {n} staff. Everything added after it will be lost.', { d: chk.info.created ? fmtDateTime(chk.info.created) : '?', n: chk.info.employees }),
        yes: t('Restore'),
        danger: true,
      });
      if (!ok) { setBusy(false); return; }
      await api.post('/api/admin/restore', { pin, backup: b }, { timeoutMs: 120000 });
      toast(t('Data restored'), 'ok');
      setTimeout(() => location.reload(), 900);
    } catch (e) { toastErr(e); setBusy(false); }
  };
  return (
    <Dialog open title={t('Restore backup')} onClose={busy ? undefined : onClose}>
      <p class="small" style="margin:0 0 8px"><b class="ltr">{file.name}</b><br />
        <span class="muted">{b.storeName} · {b.created ? fmtDate(new Date(b.created).toISOString().slice(0, 10)) : ''} · {t('{n} staff', { n: b.counts?.employees ?? '?' })}</span></p>
      <Field label={t('Your PIN')}><input class="input ltr" style="width:100%" type="password" inputmode="numeric" maxLength={6} value={pin} onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))} /></Field>
      <div class="btn-row">
        <button class="btn ghost" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
        <button class="btn" disabled={busy || pin.length < 4} onClick={go1}>{busy ? <Spinner sm /> : t('Restore')}</button>
      </div>
    </Dialog>
  );
}

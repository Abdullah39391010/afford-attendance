// Staff app: duty roster with shift swaps, notes from admin, birthday card, upcoming holidays, iPhone install hint.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../shared/api.js';
import { t, nm, getLang } from '../shared/i18n.js';
import { fmtDate, fmtDateTime, todayStr, dayShort } from '../shared/format.js';
import { TopBar, Icon, Pill, Sheet, Field, Loader, useLoad, toast, toastErr, Banner, Spinner, Empty, go } from '../shared/ui.jsx';
import { useEmp } from './app.jsx';

export const IS_WEB = typeof __WEB_APP__ !== 'undefined' && __WEB_APP__;

/** Cards on the Today screen: greeting, unread notes, next holiday. */
export function HomeExtras() {
  const { home } = useEmp();
  const c = home.celebrate;
  const hol = home.holidays?.[0];
  const ur = getLang() === 'ur';
  return (
    <div>
      {c && (
        <div class="card celebrate center">
          <div style="font-size:34px">{c.kind === 'birthday' ? '🎂' : '🎉'}</div>
          <b style="font-size:18px">{c.kind === 'birthday' ? t('Happy birthday!') : t('{n} years with us!', { n: c.years })}</b>
          <div class="small muted">{c.kind === 'birthday' ? t('Best wishes from everyone at Afford.') : t('Thank you for your hard work.')}</div>
        </div>
      )}
      {home.unseenNotes > 0 && (
        <button class="banner warn" style="width:100%;text-align:start;cursor:pointer" onClick={() => go('notes')}>
          <Icon n="inbox" /><div>{t('You have {n} new message(s) from the admin. Tap to read.', { n: home.unseenNotes })}</div>
        </button>
      )}
      {hol && (
        <div class="banner info"><Icon n="cal" /><div>{t('Next holiday')}: <b>{(ur && hol.nameUr) || hol.name || t('Holiday')}</b> · {fmtDate(hol.date)}</div></div>
      )}
    </div>
  );
}

export function MyRoster() {
  const { home } = useEmp();
  const today = todayStr(api.serverNow());
  const st = useLoad(() => api.get(`/api/emp/roster?from=${today}&days=14`), []);
  const [swap, setSwap] = useState(null);
  return (
    <div class="screen no-nav">
      <TopBar back title={t('My duty roster')} />
      <div class="wrap">
        <p class="small muted" style="margin:12px 4px">{t('Your shifts for the next 2 weeks. To swap a day with a colleague, tap the day.')}</p>
        <Loader st={st}>{(data) => (
          <div>
            {data.swaps.length > 0 && <Banner kind="info">{t('{n} swap request(s) waiting for the admin.', { n: data.swaps.length })}</Banner>}
            <div class="list">
              {data.days.map((d) => {
                const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
                const pend = data.swaps.find((x) => x.date === d.date);
                return (
                  <button key={d.date} class="row" onClick={() => setSwap(d)}>
                    <div class={`avatar ${d.date === today ? '' : 'muted-av'}`} style="font-size:13px;flex-direction:column;line-height:1.1">{dayShort(dow)}<b>{Number(d.date.slice(8))}</b></div>
                    <div class="main">
                      <div class="title">{d.holiday ? `${t('Holiday')} · ${(getLang() === 'ur' && d.holidayUr) || d.holiday}` : d.off ? t('Day off') : `${nm(d.shift)} · `}{!d.holiday && !d.off && <span class="ltr">{d.shift?.start}–{d.shift?.end}</span>}</div>
                      <div class="sub">{fmtDate(d.date)}{d.rostered ? ` · ${t('changed in roster')}` : ''}{pend ? ` · ${t('swap waiting')}` : ''}</div>
                    </div>
                    {d.date === today && <Pill s="in">{t('Today')}</Pill>}
                  </button>
                );
              })}
            </div>
            {swap && <SwapSheet day={swap} colleagues={data.colleagues} onClose={() => setSwap(null)} onDone={() => { setSwap(null); st.reload(true); }} />}
          </div>
        )}</Loader>
      </div>
    </div>
  );
}

function SwapSheet({ day, colleagues, onClose, onDone }) {
  const [withId, setWith] = useState('');
  const [reason, setReason] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api.post('/api/emp/requests', { type: 'swap', date: day.date, withId, reason });
      toast(t('Sent to admin / manager'), 'ok');
      onDone();
    } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  const list = colleagues.filter((c) => !q || `${c.name} ${c.nameUr || ''} ${c.code}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Sheet open onClose={onClose} title={`${t('Swap my duty')} · ${fmtDate(day.date)}`}>
      <p class="small muted" style="margin:0 0 8px">{t('Talk to your colleague first. If the admin approves, you take their duty for this day and they take yours.')}</p>
      <div class="search" style="margin-bottom:8px"><Icon n="search" /><input class="input" placeholder={t('Search name or code')} value={q} onInput={(e) => setQ(e.currentTarget.value)} /></div>
      <div class="list" style="margin:0 0 10px;box-shadow:none;border:1px solid var(--line);max-height:220px;overflow:auto">
        {!list.length && <Empty icon="users" text={t('No staff yet')} />}
        {list.map((c) => (
          <label key={c.id} class="row" style="cursor:pointer">
            <input type="radio" name="swapwith" checked={withId === c.id} onChange={() => setWith(c.id)} style="width:20px;height:20px;accent-color:var(--red)" />
            <div class="main"><div class="title">{nm(c)} <span class="muted small ltr">{c.code}</span></div></div>
          </label>
        ))}
      </div>
      <Field label={t('Reason')}><input class="input" value={reason} onInput={(e) => setReason(e.currentTarget.value)} /></Field>
      <button class="btn block" disabled={!withId || busy} onClick={send}>{busy ? <Spinner sm /> : t('Send request')}</button>
    </Sheet>
  );
}

const NOTE = { warning: ['Warning', 'absent'], praise: ['Good work', 'present'], note: ['Note', 'notyet'] };
export function MyNotes() {
  const E = useEmp();
  const st = useLoad(() => api.get('/api/emp/notes'), []);
  useEffect(() => {
    const unseen = (st.data?.notes || []).filter((n) => !n.seen);
    if (!unseen.length) return;
    Promise.all(unseen.map((n) => api.post(`/api/emp/notes/${n.id}/seen`).catch(() => {}))).then(() => E.loadHome?.());
  }, [st.data]);
  return (
    <div class="screen no-nav">
      <TopBar back title={t('Messages from admin')} />
      <div class="wrap">
        <Loader st={st}>{(data) => (
          <div class="list" style="margin-top:12px">
            {!data.notes.length && <Empty icon="inbox" text={t('No messages yet')} />}
            {data.notes.map((n) => (
              <div key={n.id} class="row">
                <div class="main">
                  <div class="gap"><Pill s={NOTE[n.kind][1]}>{t(NOTE[n.kind][0])}</Pill><span class="small muted">{fmtDateTime(n.ts)}</span>{!n.seen && <span class="pill st-pending">{t('New')}</span>}</div>
                  <div style="margin-top:6px;white-space:pre-wrap">{n.text}</div>
                </div>
              </div>
            ))}
          </div>
        )}</Loader>
      </div>
    </div>
  );
}

/** On iPhone Safari: how to put the web version on the home screen. */
export function WebInstallHint() {
  const [hide, setHide] = useState(() => { try { return localStorage.getItem('afford.hideInstall') === '1'; } catch { return false; } });
  if (!IS_WEB || hide) return null;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return null;
  return (
    <div class="banner info">
      <Icon n="phone" />
      <div class="grow">{t('iPhone: tap the Share button in Safari, then "Add to Home Screen". The app then opens like a normal app.')}</div>
      <button class="link small" onClick={() => { try { localStorage.setItem('afford.hideInstall', '1'); } catch { /* ignore */ } setHide(true); }}>{t('OK')}</button>
    </div>
  );
}

import { h } from 'preact';
import { t } from './i18n.js';
import { dayShort, fmtMonth, addMonths } from './format.js';
import { Icon } from './ui.jsx';

export const LEGEND = [
  ['present', 'Present', 'var(--green)'], ['late', 'Late', 'var(--orange)'], ['absent', 'Absent', '#D7262E'],
  ['leave', 'Leave', 'var(--blue)'], ['leave_unpaid', 'Unpaid leave', 'var(--purple)'], ['off', 'Off', '#B9BDC2'],
  ['holiday', 'Holiday', 'var(--teal)'], ['duty', 'Out-of-town', 'var(--indigo)'], ['pending', 'Pending', 'var(--yellow)'],
];

export function MonthNav({ month, onChange, max }) {
  return (
    <div class="datebar" style="margin:6px 0 10px">
      <button class="iconbtn" onClick={() => onChange(addMonths(month, -1))} aria-label={t('Previous month')}><Icon n="back" cls="flip" /></button>
      <div class="db-mid"><b>{fmtMonth(month)}</b></div>
      <button class="iconbtn" disabled={max && month >= max} onClick={() => onChange(addMonths(month, 1))} aria-label={t('Next month')}>
        <Icon n="fwd" cls="flip" />
      </button>
    </div>
  );
}

/** days: [{date, status, request}] for a full month */
export function Calendar({ month, days, today, onPick }) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(<div key={`b${i}`} />);
  for (const d of days) {
    const n = Number(d.date.slice(8));
    const cls = ['d', `c-${d.status}`, d.request ? `r-${d.request}` : '', d.date === today ? 'today' : ''].join(' ');
    cells.push(
      <button key={d.date} class={cls} onClick={() => onPick && onPick(d)} aria-label={d.date}>
        {n}
        {d.request === 'approved' && <span class="ck">✓</span>}
      </button>,
    );
  }
  return (
    <div>
      <div class="cal">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => <div key={i} class="dh">{dayShort(i)}</div>)}
        {cells}
      </div>
      <div class="legend">
        {LEGEND.map(([k, label, color]) => <span key={k}><i style={`background:${color}`} />{t(label)}</span>)}
        <span><i style="background:#fff;border:2px solid var(--green)" />✓ {t('Approved')}</span>
      </div>
    </div>
  );
}

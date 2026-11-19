// One-line text for a request (used by both apps).
import { t } from './i18n.js';
import { fmtDate, fmtTime, fmtMoney } from './format.js';

export function describe(r, currency) {
  const d = r.data || {};
  switch (r.type) {
    case 'forgot_in': return `${fmtDate(d.date)} · ${t('check-in at')} ${d.approvedTime || d.time}`;
    case 'forgot_out': return `${fmtDate(d.date)} · ${t('check-out at')} ${d.approvedTime || d.time}`;
    case 'past_day': return `${fmtDate(d.date)} · ${d.approvedIn || d.inTime} – ${d.approvedOut || d.outTime}`;
    case 'leave': return d.toDate && d.toDate !== d.date ? `${fmtDate(d.date)} → ${fmtDate(d.toDate)}` : fmtDate(d.date);
    case 'short_leave': return `${fmtDate(d.date)} · ${d.from} – ${d.to}`;
    case 'field_duty': return d.toDate && d.toDate !== d.date ? `${fmtDate(d.date)} → ${fmtDate(d.toDate)}` : fmtDate(d.date);
    case 'advance': return d.amount == null ? t('Amount hidden') : fmtMoney(d.approvedAmount || d.amount, currency);
    case 'break': return t('{m} minutes', { m: d.minutes });
    case 'undo_checkout': return `${t('Checked out at')} ${fmtTime(d.outTs)}`;
    case 'recheckin': return d.inTs
      ? `${t('Out')} ${fmtTime(d.outTs)} → ${t('In')} ${fmtTime(d.inTs)} · ${t('counted as late')}`
      : `${t('Out')} ${fmtTime(d.outTs)} → ${t('asked at')} ${fmtTime(r.created)} · ${t('time away counts as late')}`;
    case 'swap': return `${fmtDate(d.date)} · ${t('with')} ${d.withName || ''}`;
    case 'pin_reset': return d.pinSet ? t('New PIN set') : t('Asked from the login screen');
    default: return '';
  }
}


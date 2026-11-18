import { getLang, t } from './i18n.js';

let tzOff = 300;
export const setTz = (m) => { if (Number.isFinite(m)) tzOff = m; };
export const tz = () => tzOff;

const pad = (n) => String(n).padStart(2, '0');
const URDU_DIGITS = false; // keep Latin digits: easier to read on payslips

/** Local (store time zone) parts of a timestamp */
export function parts(ts) {
  const d = new Date(ts + tzOff * 60000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), dow: d.getUTCDay() };
}
export function todayStr(now) {
  const p = parts(now);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
export function fmtTime(ts) {
  if (!ts) return '—';
  const p = parts(ts);
  const h12 = p.h % 12 || 12;
  return `${h12}:${pad(p.min)} ${p.h < 12 ? t('AM') : t('PM')}`;
}
export function fmtHM24(mins) {
  return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
}
export function fmtDur(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return t('{m} min', { m });
  return t('{h}h {m}m', { h, m });
}
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_UR = ['جنوری', 'فروری', 'مارچ', 'اپریل', 'مئی', 'جون', 'جولائی', 'اگست', 'ستمبر', 'اکتوبر', 'نومبر', 'دسمبر'];
const DAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_UR = ['اتوار', 'پیر', 'منگل', 'بدھ', 'جمعرات', 'جمعہ', 'ہفتہ'];
const DAYS_LONG_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const monthName = (m) => (getLang() === 'ur' ? MONTHS_UR : MONTHS_EN)[m - 1];
export const dayShort = (d) => (getLang() === 'ur' ? DAYS_UR : DAYS_EN)[d];
export const dayLong = (d) => (getLang() === 'ur' ? DAYS_UR : DAYS_LONG_EN)[d];
export function fmtMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return `${monthName(m)} ${y}`;
}
export function fmtDate(date, { withDay = true, short = false } = {}) {
  if (!date) return '—';
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const mn = short && getLang() !== 'ur' ? monthName(m).slice(0, 3) : monthName(m);
  return `${withDay ? `${dayShort(dow)}, ` : ''}${d} ${mn} ${y}`;
}
export function fmtDateTime(ts) {
  const p = parts(ts);
  return `${p.d} ${monthName(p.m).slice(0, getLang() === 'ur' ? 20 : 3)} ${fmtTime(ts)}`;
}
export function fmtMoney(n, currency = 'Rs.') {
  if (n == null || Number.isNaN(n)) return '—';
  const neg = n < 0;
  const v = Math.abs(Math.round(n)).toLocaleString('en-PK');
  return `${neg ? '−' : ''}${currency} ${v}`;
}
export function fmtMoney2(n, currency = 'Rs.') {
  if (n == null) return '—';
  return `${currency} ${Number(n).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
export const ago = (ts, now = Date.now()) => {
  const m = Math.round((now - ts) / 60000);
  if (m < 1) return t('just now');
  if (m < 60) return t('{n} min ago', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('{n} h ago', { n: h });
  return fmtDateTime(ts);
};
export { URDU_DIGITS };

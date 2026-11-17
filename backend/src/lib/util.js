// Small shared helpers: errors, ids, time maths, geo.

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (code, message, extra) => new HttpError(400, code, message, extra);
export const forbidden = (code = 'FORBIDDEN', message = 'Not allowed') => new HttpError(403, code, message);
export const notFound = (what = 'Item') => new HttpError(404, 'NOT_FOUND', `${what} not found`);

export const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

export const MIN = 60000;
export const DAY_MS = 86400000;

/** "08:30" -> 510 */
export function hm(s) {
  if (typeof s === 'number') return s;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) throw bad('BAD_TIME', `Bad time "${s}"`);
  const v = Number(m[1]) * 60 + Number(m[2]);
  if (v > 24 * 60) throw bad('BAD_TIME', `Bad time "${s}"`);
  return v;
}

export const fmtHM = (mins) => {
  mins = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};

/** Local calendar parts of a UTC timestamp for a fixed offset (Pakistan has no DST). */
export function local(ts, offMin) {
  const d = new Date(ts + offMin * MIN);
  return {
    date: d.toISOString().slice(0, 10),
    min: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

/** Local date + minutes after local midnight -> UTC timestamp. */
export const toTs = (date, mins, offMin) => Date.parse(`${date}T00:00:00Z`) + mins * MIN - offMin * MIN;

export function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}
export function isMonth(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
export const dowOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
export function monthDates(month) {
  const n = daysInMonth(month);
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}
export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Distance in metres between two GPS points. */
export function metres(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const round2 = (n) => Math.round(n * 100) / 100;
export const clampInt = (v, lo, hi, dflt) => {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
export const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));

export function csv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

// English / Urdu. Strings are written in English in the code; ur.js maps them to Urdu.
import { UR as UR1 } from './ur.js';
import { UR2 } from './ur2.js';

const UR = { ...UR1, ...UR2 };

let lang = (() => { try { return localStorage.getItem('afford.lang') || 'en'; } catch { return 'en'; } })();
const listeners = new Set();

export const getLang = () => lang;
export function setLang(l) {
  lang = l === 'ur' ? 'ur' : 'en';
  try { localStorage.setItem('afford.lang', lang); } catch { /* ignore */ }
  applyDir();
  listeners.forEach((f) => f(lang));
}
export const onLang = (f) => { listeners.add(f); return () => listeners.delete(f); };
export function applyDir() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ur' ? 'rtl' : 'ltr';
}

export function t(s, vars) {
  let out = lang === 'ur' ? UR[s] ?? s : s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

/** Pick the Urdu name when available, e.g. {name, nameUr} */
export const nm = (o) => (o ? (lang === 'ur' && o.nameUr ? o.nameUr : o.name) : '');

const ERRORS = {
  NETWORK: 'No internet. Please check your connection.',
  NO_SERVER: 'Server address is not set.',
  WRONG_PIN: 'Wrong PIN. Please try again.',
  WRONG_CODE: 'Wrong code. Please try again.',
  OWNER_PAGE_OFF: 'This page is not turned on yet.',
  LOCKED: 'Too many wrong PINs. Try again in {min} minutes.',
  OUTSIDE_RADIUS: 'You are {d} m away from the store. Go inside the store and try again.',
  NO_STORE_LOCATION: 'The store location is not set yet. Ask the admin.',
  NO_LOCATION: 'Location is needed. Turn on GPS and try again.',
  MOCK_LOCATION: 'Fake GPS apps are not allowed. Turn them off and try again.',
  BOUND_TO_OTHER_PHONE: 'Your account is linked to another phone. Ask the owner to reset it.',
  PHONE_USED_BY_OTHER: 'This phone belongs to another employee. One phone = one employee.',
  DEVICE_RESET: 'This phone is no longer linked. Please log in again.',
  ALREADY_IN: 'Already checked in.',
  NOT_IN: 'Not checked in.',
  ON_BREAK: 'Already on a break.',
  NOT_ON_BREAK: 'Not on a break.',
  DUPLICATE: 'You already have this request waiting.',
  TOO_OLD: 'That date is too old.',
  NOT_THIS_MONTH: 'Only dates in the current month are allowed.',
  NOTHING_TO_UNDO: 'There is no recent check-out to undo.',
  MONTH_LOCKED: 'This month is locked because its salary is final. Only the owner can unlock it.',
  MONTH_NOT_OVER: 'Only a finished month can be locked.',
  POLICY_CHANGED: 'The rules were updated. Please read them again.',
  ALREADY_ASKED: 'Already waiting for the owner.',
  NO_CLOUD: 'Cloud backup is not available on this server.',
  RECHECKIN_NEEDED: 'You already checked out today. Ask the admin or manager to let you check in again.',
  NOT_CHECKED_OUT: 'You have not checked out today, so you can check in normally.',
  ALREADY_APPROVED: 'Already approved. You can check in now.',
  OFFLINE_TOO_OLD: 'This saved punch is too old. Please send a "forgot" request instead.',
  NEED_REASON: 'Please write a reason.',
  NO_PERMISSION: 'You do not have permission for this.',
  WEB_NOT_ALLOWED: 'The web version is not turned on for you. Ask the owner.',
  OTHER_BRANCH: 'This employee belongs to another branch.',
  PICK_COLLEAGUE: 'Pick the colleague to swap with.',
  SAME_DUTY: 'You both have the same duty that day.',
  BAD_FILE: 'File must be a photo (JPEG / PNG) or a PDF.',
  TOO_LARGE: 'The file is too large.',
  TOO_MANY: 'At most 12 files per employee.',
  OWNER_ONLY: 'Only the owner can do this.',
  BAD_SETUP_CODE: 'Wrong setup code.',
  GPS_OFF: 'Location (GPS) is off. Please turn it on.',
  PERMISSION_DENIED: 'Location permission is needed. Allow it in phone settings.',
  NO_FIX: 'Could not get your location. Go near a door or window and try again.',
  INACTIVE: 'This employee is not active.',
  BAD_PIN: 'PIN must be 4 to 6 digits.',
  CODE_TAKEN: 'That employee code is already used.',
  PHONE_TAKEN: 'Another employee has this phone number.',
  LOGIN_TAKEN: 'That login name is already used.',
  NEED_PHOTO: 'A photo is needed.',
  ALREADY_DECIDED: 'This request was already decided.',
  CANNOT_UNDO: 'Employee has punched again since then.',
  BAD_TIME: 'Please check the time.',
  BAD_DATE: 'Please check the date.',
  SERVER: 'Something went wrong. Please try again.',
};

export function errText(e) {
  if (!e) return '';
  const code = e.code || e.message;
  if (code === 'LOCKED') return t(ERRORS.LOCKED, { min: Math.max(1, Math.ceil((e.data?.retryAfterSec || 60) / 60)) });
  if (code === 'OUTSIDE_RADIUS' && e.data?.branch) return t('You are {d} m away from {b}. Go inside and try again.', { d: e.data?.distance ?? '?', b: e.data.branch });
  if (code === 'OUTSIDE_RADIUS') return t(ERRORS.OUTSIDE_RADIUS, { d: e.data?.distance ?? '?' });
  if (code === 'TOO_EARLY' && e.data?.opensAt) {
    const [hh, mm] = e.data.opensAt.split(':').map(Number);
    return t('Check-in opens at {t}.', { t: `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? t('AM') : t('PM')}` });
  }
  if (ERRORS[code]) return t(ERRORS[code]);
  return lang === 'ur' ? t('Something went wrong. Please try again.') : e.message || String(code);
}

export const STATUS = {
  present: 'Present', late: 'Late', absent: 'Absent', leave: 'Leave', leave_unpaid: 'Unpaid leave', off: 'Off', holiday: 'Holiday',
  duty: 'Out-of-town', notyet: 'Not yet in', future: '', notjoined: 'Not joined', left: 'Left', in: 'In', out: 'Checked out', break: 'On break',
};
export const statusLabel = (s) => t(STATUS[s] || s);

export const REQ_TYPES = {
  forgot_in: 'Forgot check-in', forgot_out: 'Forgot check-out', past_day: 'Past-day attendance', leave: 'Leave',
  advance: 'Advance salary', break: 'Break', undo_checkout: 'Checked out by mistake', field_duty: 'Out-of-town duty', recheckin: 'Check in again', swap: 'Shift swap', pin_reset: 'Forgot PIN',
};
export const reqLabel = (s) => t(REQ_TYPES[s] || s);

export const MONEY_KINDS = {
  advance: 'Advance', deposit: 'Security deposit (paid in)', deposit_cut: 'Deposit cut from salary', deposit_return: 'Deposit returned', bonus: 'Bonus', commission: 'Commission', fine: 'Fine',
};
export const moneyLabel = (k) => t(MONEY_KINDS[k] || k);

export const AUDIT = {
  setup: 'Owner account created', login: 'Logged in', 'admin.pin_changed': 'Changed own PIN',
  'attendance.check_in': 'Checked in by admin', 'attendance.check_out': 'Checked out by admin', 'attendance.break_ended': 'Break ended by admin',
  'attendance.mark': 'Day marked', 'attendance.punch_removed': 'Punch removed',
  'employee.added': 'Employee added', 'employee.updated': 'Employee updated', 'employee.deleted': 'Employee deleted', 'employee.erased': 'Employee and all records deleted', 'employee.records_cleared': 'Employee records cleared',
  'employee.phone_linked': 'Phone linked', 'employee.phone_reset': 'Phone reset', 'employee.photo': 'Photo changed', 'employee.pin_set': 'PIN set', 'employee.pin_viewed': 'PIN viewed', 'employee.pin_changed': 'PIN changed by staff', 'settings.default_pin': 'Default PIN changed', 'settings.auth_signature': 'Authorised signature changed',
  'attendance.helper_in': 'Helper check-in', 'attendance.helper_out': 'Helper check-out', 'kiosk.added': 'Kiosk added', 'kiosk.removed': 'Kiosk removed', 'data.restore': 'Data restored from backup',
  'money.advance': 'Advance given', 'money.deposit': 'Deposit received', 'money.deposit_cut': 'Deposit cut', 'money.deposit_return': 'Deposit returned',
  'money.bonus': 'Bonus given', 'money.removed': 'Money entry removed',
  'request.approved': 'Request approved', 'request.declined': 'Request declined',
  'settings.logo': 'Logo changed', 'settings.updated': 'Settings changed',
  'user.added': 'Manager added', 'user.updated': 'Manager updated', 'user.deleted': 'Manager removed',
  'money.commission': 'Commission given', 'money.fine': 'Fine', 'roster.updated': 'Duty roster changed', 'roster.copied': 'Duty roster copied',
  'note.warning': 'Warning given', 'note.praise': 'Good work note', 'note.note': 'Note added', 'note.removed': 'Note removed',
  'employee.doc_added': 'File added', 'employee.doc_removed': 'File removed', 'employee.settled': 'Final settlement',
  'payroll.salary_paid': 'Salary paid', 'payroll.payment_removed': 'Payment removed',
};
export const auditLabel = (a) => t(AUDIT[a] || a);

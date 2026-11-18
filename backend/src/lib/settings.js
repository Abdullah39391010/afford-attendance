// Store settings: defaults, validation and normalisation. Everything here is editable by admin.
import { bad, clampInt, hm, isDate, str, uid } from './util.js';

export const PERMISSIONS = [
  'employees.view', // see employee list and details (salary hidden without payroll.view)
  'employees.edit', // add / edit / deactivate employees, set PINs
  'attendance.punch', // check employees in/out, mark leave/absent/duty
  'requests.decide', // approve / decline requests
  'payroll.view', // salary statements, salaries
  'money.edit', // advances and security deposits
  'reports.view', // reports and exports
  'settings.edit', // store settings, rules, locations
  'audit.view', // audit log
  'kiosk.setup', // turn a phone into a store kiosk
];

export const DEFAULT_MANAGER_PERMS = ['employees.view', 'attendance.punch', 'requests.decide', 'reports.view'];

export function defaultSettings() {
  return {
    storeName: 'Afford Super Store',
    currency: 'Rs.',
    tzOffsetMin: 300, // Pakistan Standard Time, UTC+5
    locations: [], // [{id, name, lat, lng, radius}]
    shifts: [
      { id: 'morning', name: 'Morning', nameUr: 'صبح', start: '08:00', end: '16:00' },
      { id: 'evening', name: 'Evening', nameUr: 'شام', start: '16:00', end: '24:00' },
    ],
    roles: [
      { id: 'manager', name: 'Manager', nameUr: 'مینیجر', checkoutAnywhere: false },
      { id: 'cashier', name: 'Cashier', nameUr: 'کیشیئر', checkoutAnywhere: false },
      { id: 'stocker', name: 'Shelf stocker', nameUr: 'شیلف اسٹاکر', checkoutAnywhere: false },
      { id: 'guard', name: 'Guard', nameUr: 'گارڈ', checkoutAnywhere: false },
      { id: 'cleaner', name: 'Cleaner', nameUr: 'صفائی والا', checkoutAnywhere: false },
      { id: 'delivery', name: 'Delivery boy', nameUr: 'ڈیلیوری بوائے', checkoutAnywhere: true },
      { id: 'purchaser', name: 'Purchaser', nameUr: 'پرچیزر', checkoutAnywhere: true },
    ],
    weeklyOff: [5], // 0 = Sunday ... 5 = Friday; employees can override
    holidays: [], // [{date, name}] paid off days for everyone
    rules: {
      daysBasis: 26, // 26 | 30 | 'actual' (days in that month) - used for daily / hourly rate
      lateGraceMin: 15,
      lateCountFrom: 'start', // 'start' = count from shift start once grace is passed, 'grace' = only minutes after grace
      lateCutOn: true,
      earlyLeaveCutOn: true,
      earlyLeaveGraceMin: 10,
      breakAllowanceMin: 30, // per day
      breakNeedsApproval: true,
      breakLateCutOn: true,
      absentCutOn: true,
      paidLeavePerMonth: 1,
      pastDayRequestDays: 3,
      requireInRadiusCheckIn: true,
      blockMockLocation: true,
      checkInWindowOn: true, // check-in opens only shortly before the shift starts
      checkInEarlyMin: 15,
      maxOfflineHours: 168, // a punch saved without internet is accepted for 7 days
      autoAbsentAfterMin: 120, // board shows "absent" once this long past shift start with no check-in
      kioskPhoto: true,
      overtimeOn: false, // pay minutes worked after the shift end
      overtimeRate: 1, // x normal per-minute rate (1, 1.5, 2)
      overtimeAfterMin: 15, // only counts when staying at least this long after shift end
      remindersOn: true, // push "shift starts soon" and "you forgot to check out"
      remindBeforeMin: 15,
      dailySummaryOn: true, // nightly attendance summary to the owner
      dailySummaryAt: '22:00',
      holidayWorkExtra: false, // working on a public holiday pays one extra day
      greetingsOn: true, // birthday + work anniversary wishes
    },
    storeAddress: '',
    storePhone: '',
    appVersions: { admin: null, employee: null }, // filled from GitHub releases
  };
}

const num = (v, lo, hi, d) => clampInt(v, lo, hi, d);
const bool = (v, d) => (v === undefined ? d : !!v);

/** Merge a partial update into current settings, validating every field. */
export function mergeSettings(cur, patch) {
  const s = structuredClone(cur);
  if (!patch || typeof patch !== 'object') throw bad('BAD_SETTINGS', 'Settings must be an object');

  if ('storeName' in patch) s.storeName = str(patch.storeName, 80) || s.storeName;
  if ('currency' in patch) s.currency = str(patch.currency, 8) || s.currency;
  if ('storeAddress' in patch) s.storeAddress = str(patch.storeAddress, 160);
  if ('storePhone' in patch) s.storePhone = str(patch.storePhone, 40);
  if ('tzOffsetMin' in patch) s.tzOffsetMin = num(patch.tzOffsetMin, -720, 840, 300);

  if ('locations' in patch) {
    if (!Array.isArray(patch.locations) || patch.locations.length > 20) throw bad('BAD_LOCATIONS', 'Locations must be a list');
    s.locations = patch.locations.map((l) => {
      const lat = Number(l.lat);
      const lng = Number(l.lng);
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180) || (lat === 0 && lng === 0))
        throw bad('BAD_LOCATION', `Bad GPS point for "${l.name}"`);
      return { id: str(l.id, 40) || uid(), name: str(l.name, 60) || 'Store', lat, lng, radius: num(l.radius, 10, 5000, 100),
        address: str(l.address, 160), phone: str(l.phone, 40) };
    });
  }

  if ('shifts' in patch) {
    if (!Array.isArray(patch.shifts) || !patch.shifts.length || patch.shifts.length > 20)
      throw bad('BAD_SHIFTS', 'At least one shift is needed');
    s.shifts = patch.shifts.map((x) => {
      const start = hm(x.start);
      const end = hm(x.end);
      if (start === end) throw bad('BAD_SHIFT', `Shift "${x.name}" has the same start and end`);
      return {
        id: str(x.id, 40) || uid(),
        name: str(x.name, 40) || 'Shift',
        nameUr: str(x.nameUr, 40),
        start: str(x.start, 5),
        end: str(x.end, 5),
      };
    });
  }

  if ('roles' in patch) {
    if (!Array.isArray(patch.roles) || !patch.roles.length || patch.roles.length > 40) throw bad('BAD_ROLES', 'At least one role is needed');
    s.roles = patch.roles.map((r) => ({
      id: str(r.id, 40) || uid(),
      name: str(r.name, 40) || 'Role',
      nameUr: str(r.nameUr, 40),
      checkoutAnywhere: !!r.checkoutAnywhere,
      // optional job rules; null = use the store rule
      rules: roleRules(r.rules),
    }));
  }

  if ('weeklyOff' in patch) s.weeklyOff = normDows(patch.weeklyOff);

  if ('holidays' in patch) {
    if (!Array.isArray(patch.holidays) || patch.holidays.length > 200) throw bad('BAD_HOLIDAYS', 'Holidays must be a list');
    s.holidays = patch.holidays.map((h) => {
      if (!isDate(h.date)) throw bad('BAD_DATE', 'Bad holiday date');
      return { date: h.date, name: str(h.name, 60), nameUr: str(h.nameUr, 60) };
    }).filter((h, i, a) => a.findIndex((x) => x.date === h.date) === i).sort((a, b) => a.date.localeCompare(b.date));
  }

  if (patch.rules) {
    const r = s.rules;
    const p = patch.rules;
    if ('daysBasis' in p) {
      if (![26, 30, 'actual'].includes(p.daysBasis) && !(Number(p.daysBasis) >= 20 && Number(p.daysBasis) <= 31))
        throw bad('BAD_RULE', 'Days basis must be 26, 30 or actual');
      r.daysBasis = p.daysBasis === 'actual' ? 'actual' : Number(p.daysBasis);
    }
    if ('lateGraceMin' in p) r.lateGraceMin = num(p.lateGraceMin, 0, 240, 15);
    if ('lateCountFrom' in p) r.lateCountFrom = p.lateCountFrom === 'grace' ? 'grace' : 'start';
    if ('earlyLeaveGraceMin' in p) r.earlyLeaveGraceMin = num(p.earlyLeaveGraceMin, 0, 240, 10);
    if ('breakAllowanceMin' in p) r.breakAllowanceMin = num(p.breakAllowanceMin, 0, 480, 30);
    if ('paidLeavePerMonth' in p) r.paidLeavePerMonth = num(p.paidLeavePerMonth, 0, 31, 1);
    if ('pastDayRequestDays' in p) r.pastDayRequestDays = num(p.pastDayRequestDays, 0, 31, 3);
    if ('maxOfflineHours' in p) r.maxOfflineHours = num(p.maxOfflineHours, 1, 168, 168);
    if ('checkInEarlyMin' in p) r.checkInEarlyMin = num(p.checkInEarlyMin, 0, 240, 15);
    if ('autoAbsentAfterMin' in p) r.autoAbsentAfterMin = num(p.autoAbsentAfterMin, 0, 720, 120);
    if ('overtimeRate' in p) {
      const v = Math.round(Number(p.overtimeRate) * 100) / 100;
      r.overtimeRate = Number.isFinite(v) ? Math.min(3, Math.max(0.5, v)) : 1;
    }
    if ('overtimeAfterMin' in p) r.overtimeAfterMin = num(p.overtimeAfterMin, 0, 240, 15);
    if ('remindBeforeMin' in p) r.remindBeforeMin = num(p.remindBeforeMin, 5, 60, 15);
    if ('dailySummaryAt' in p) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(p.dailySummaryAt))) throw bad('BAD_RULE', 'Summary time must be HH:MM');
      r.dailySummaryAt = String(p.dailySummaryAt);
    }
    for (const k of ['lateCutOn', 'earlyLeaveCutOn', 'breakNeedsApproval', 'breakLateCutOn', 'absentCutOn',
      'requireInRadiusCheckIn', 'blockMockLocation', 'kioskPhoto', 'overtimeOn', 'remindersOn', 'dailySummaryOn', 'holidayWorkExtra', 'greetingsOn', 'checkInWindowOn']) {
      if (k in p) r[k] = bool(p[k], r[k]);
    }
  }
  return s;
}

export function normDows(v) {
  if (!Array.isArray(v)) v = v == null || v === '' ? [] : [v];
  return [...new Set(v.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
}

/** Shift as minutes; end is after start (an end at/before start means it ends next day). */
export function shiftMins(shift) {
  const start = hm(shift.start);
  let end = hm(shift.end);
  if (end <= start) end += 1440;
  return { start, end, hours: (end - start) / 60 };
}

/** Store rules a job (role) may change for its own staff. */
export const ROLE_RULE_KEYS = {
  lateGraceMin: [0, 240], earlyLeaveGraceMin: [0, 240], breakAllowanceMin: [0, 480], paidLeavePerMonth: [0, 31],
  lateCutOn: 'bool', earlyLeaveCutOn: 'bool', breakLateCutOn: 'bool', requireInRadiusCheckIn: 'bool',
};
function roleRules(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const [k, spec] of Object.entries(ROLE_RULE_KEYS)) {
    const v = src[k];
    if (v == null || v === '') continue;
    if (spec === 'bool') out[k] = !!v;
    else {
      const n = Math.round(Number(v));
      if (Number.isFinite(n)) out[k] = Math.min(spec[1], Math.max(spec[0], n));
    }
  }
  return out;
}

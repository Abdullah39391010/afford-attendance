// Pure attendance + payroll maths. No storage access here, so it is easy to test.
import { local, monthDates, MIN, toTs, round2, daysInMonth } from './util.js';
import { shiftMins } from './settings.js';

export const MARKS = ['present', 'absent', 'leave', 'leave_unpaid', 'duty', 'off'];

export function empShift(emp, s) {
  return s.shifts.find((x) => x.id === emp.shiftId) || s.shifts[0];
}
export function empWeeklyOff(emp, s) {
  return Array.isArray(emp.weeklyOff) ? emp.weeklyOff : s.weeklyOff;
}
export function empRole(emp, s) {
  return s.roles.find((r) => r.id === emp.roleId) || null;
}
export function paidLeaveQuota(emp, s) {
  return emp.paidLeavePerMonth == null || emp.paidLeavePerMonth === '' ? s.rules.paidLeavePerMonth : Number(emp.paidLeavePerMonth);
}

/**
 * Summarise one employee-day.
 * @param emp employee data
 * @param s settings
 * @param date YYYY-MM-DD (shift start date)
 * @param d {punches, breaks, mark}
 * @param now current ts
 */
export function daySummary(emp, s, date, d, now) {
  const off = s.tzOffsetMin;
  const r = s.rules;
  const shift = empShift(emp, s);
  const sm = shiftMins(shift);
  const startTs = toTs(date, sm.start, off);
  const endTs = toTs(date, sm.end, off);
  const today = local(now, off).date;

  const punches = (d.punches || []).filter((p) => !p.voided).sort((a, b) => a.ts - b.ts);
  let open = null;
  let workedMs = 0;
  let checkIn = null;
  let checkOut = null;
  let offline = false;
  for (const p of punches) {
    if (p.offline) offline = true;
    if (p.type === 'in' && open == null) {
      open = p.ts;
      if (checkIn == null) checkIn = p.ts;
    } else if (p.type === 'out' && open != null) {
      workedMs += p.ts - open;
      checkOut = p.ts;
      open = null;
    }
  }
  const isOpen = open != null;
  if (isOpen) {
    checkOut = null;
    if (date >= today || now - open < 20 * 3600 * 1000) workedMs += Math.max(0, now - open);
  }

  // Breaks
  let breakMs = 0;
  let breakLateMin = 0;
  let onBreak = null;
  for (const b of d.breaks || []) {
    const end = b.end ?? (isOpen ? now : b.start);
    const dur = Math.max(0, end - b.start);
    breakMs += dur;
    breakLateMin += Math.max(0, Math.floor(dur / MIN) - b.allowed);
    if (b.end == null) onBreak = { id: b.id, start: b.start, allowed: b.allowed, due: b.start + b.allowed * MIN };
  }

  let lateMin = 0;
  if (checkIn != null && checkIn > startTs + r.lateGraceMin * MIN) {
    const from = r.lateCountFrom === 'grace' ? startTs + r.lateGraceMin * MIN : startTs;
    lateMin = Math.floor((checkIn - from) / MIN);
  }
  let earlyMin = 0;
  if (!isOpen && checkOut != null && checkOut < endTs - r.earlyLeaveGraceMin * MIN) {
    earlyMin = Math.ceil((endTs - checkOut) / MIN);
  }

  const holiday = (s.holidays || []).find((h) => h.date === date);
  const weeklyOff = empWeeklyOff(emp, s).includes(new Date(`${date}T00:00:00Z`).getUTCDay());
  const mark = d.mark?.status || null;
  let status;
  if (mark === 'present') status = punches.length && lateMin ? 'late' : 'present';
  else if (mark) status = mark;
  else if (punches.length) status = lateMin > 0 ? 'late' : 'present';
  else if (holiday) status = 'holiday';
  else if (weeklyOff) status = 'off';
  else if (emp.joinDate && date < emp.joinDate) status = 'notjoined';
  else if (date > today) status = 'future';
  else if (date === today && now < startTs + r.autoAbsentAfterMin * MIN) status = 'notyet';
  else status = 'absent';

  // Marked days (leave, duty, absent...) carry no time-based cuts.
  const timed = !mark || mark === 'present';
  const missingOut = timed && punches.length > 0 && isOpen && now > endTs + 4 * 3600 * 1000;

  return {
    date,
    status,
    mark,
    shiftId: shift.id,
    shiftStart: startTs,
    shiftEnd: endTs,
    checkIn,
    checkOut,
    isOpen,
    onBreak,
    workedMin: Math.floor(workedMs / MIN),
    breakMin: Math.floor(breakMs / MIN),
    lateMin: timed ? lateMin : 0,
    earlyMin: timed && !missingOut ? earlyMin : 0,
    breakLateMin: timed ? breakLateMin : 0,
    missingOut,
    offline,
    holiday: holiday?.name || null,
    weeklyOff,
    punches: punches.map((p) => ({ id: p.id, type: p.type, ts: p.ts, source: p.source, offline: !!p.offline, lat: p.lat, lng: p.lng, dist: p.dist })),
  };
}

/**
 * Monthly salary statement.
 * @param days array of daySummary for every date of the month (in order)
 * @param money rows for this employee+month: {kind, amount, note, ts}
 * @param depositBalance total deposit balance up to and including this month
 */
export function payroll(emp, s, month, days, money, depositBalance, now) {
  const r = s.rules;
  const today = local(now, s.tzOffsetMin).date;
  const dim = daysInMonth(month);
  const basis = r.daysBasis === 'actual' ? dim : Number(r.daysBasis);
  const salary = Number(emp.salary) || 0;
  const shiftHours = shiftMins(empShift(emp, s)).hours;
  const daily = salary / basis;
  const hourly = daily / shiftHours;
  const perMin = hourly / 60;
  const quota = paidLeaveQuota(emp, s);

  const c = { present: 0, late: 0, absent: 0, leavePaid: 0, leaveUnpaid: 0, off: 0, holiday: 0, duty: 0, notJoined: 0, pending: 0,
    lateMin: 0, earlyMin: 0, breakLateMin: 0, workedMin: 0, missingOut: 0, offWorked: 0 };
  let leaveSeen = 0;
  const rows = [];
  for (const d of days) {
    const row = { date: d.date, status: d.status, checkIn: d.checkIn, checkOut: d.checkOut, workedMin: d.workedMin,
      lateMin: d.lateMin, earlyMin: d.earlyMin, breakLateMin: d.breakLateMin, cut: 0 };
    if (d.date > today) { row.status = d.status === 'leave' ? 'leave' : 'future'; rows.push(row); continue; }
    switch (d.status) {
      case 'present': case 'late':
        c.present++; if (d.status === 'late') c.late++;
        if (d.weeklyOff || d.holiday) c.offWorked++;
        break;
      case 'duty': c.duty++; break;
      case 'off': c.off++; break;
      case 'holiday': c.holiday++; break;
      case 'notjoined':
        c.notJoined++; row.cut = daily; break;
      case 'leave':
        leaveSeen++;
        if (leaveSeen <= quota) { c.leavePaid++; row.status = 'leave'; }
        else { c.leaveUnpaid++; row.status = 'leave_unpaid'; row.cut = daily; }
        break;
      case 'leave_unpaid': c.leaveUnpaid++; row.cut = daily; break;
      case 'absent': c.absent++; if (r.absentCutOn) row.cut = daily; break;
      case 'notyet': c.pending++; break;
      default: break;
    }
    c.lateMin += d.lateMin; c.earlyMin += d.earlyMin; c.breakLateMin += d.breakLateMin; c.workedMin += d.workedMin;
    if (d.missingOut) c.missingOut++;
    if (r.lateCutOn) row.cut += d.lateMin * perMin;
    if (r.earlyLeaveCutOn) row.cut += d.earlyMin * perMin;
    if (r.breakLateCutOn) row.cut += d.breakLateMin * perMin;
    row.cut = round2(row.cut);
    rows.push(row);
  }

  const cuts = {
    absent: r.absentCutOn ? round2(c.absent * daily) : 0,
    leaveUnpaid: round2(c.leaveUnpaid * daily),
    notJoined: round2(c.notJoined * daily),
    late: r.lateCutOn ? round2(c.lateMin * perMin) : 0,
    early: r.earlyLeaveCutOn ? round2(c.earlyMin * perMin) : 0,
    breakLate: r.breakLateCutOn ? round2(c.breakLateMin * perMin) : 0,
  };
  const sum = (k) => money.filter((m) => m.kind === k).reduce((a, m) => a + m.amount, 0);
  const advances = sum('advance');
  const depositCut = sum('deposit_cut');
  const bonus = sum('bonus');
  const totalCuts = round2(Object.values(cuts).reduce((a, b) => a + b, 0));
  const net = Math.round(salary - totalCuts - advances - depositCut + bonus);

  return {
    month,
    complete: `${month}-${String(dim).padStart(2, '0')}` <= today,
    basisDays: basis,
    salary,
    rates: { daily: round2(daily), hourly: round2(hourly), perMinute: round2(perMin), shiftHours },
    counts: c,
    leave: { quota, used: c.leavePaid + c.leaveUnpaid, paid: c.leavePaid, unpaid: c.leaveUnpaid, left: Math.max(0, quota - c.leavePaid) },
    cuts,
    totalCuts,
    advances,
    depositCut,
    bonus,
    net,
    depositBalance,
    money: money.map((m) => ({ id: m.id, kind: m.kind, amount: m.amount, note: m.note, ts: m.ts })),
    days: rows,
  };
}

export { monthDates };

'use strict';
// What each month should pay, joining the tracker's salary records to the payslips on file.
//
//   payslipDues()       payroll staff: the figure each month's payslip should show, worked
//                       out from the payslips on file the way the payroll software does it
//                       (paye.js), using the tracker's salary for the months still to come.
//   contractorMonths()  self-employed staff: a row per month, counting payments as a
//                       running balance, because they are often paid several months at once.
//
// Both are pure: the server passes in rows it has read (server.js: salaryOverviewRow).

const { payrollMonths, periodsFrom, salaryOnDate, workdaysBetween } = require('./salary-periods');
const { payFromPayslips, settingsFrom } = require('./paye');

const round2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const ym = (y, m) => `${y}-${pad(m)}`;
const iso = d => (!d ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const monthEnd = (y, m) => `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;

// ─── The tracker's own idea of a month's pay before tax ──────────────────────
/**
 * Pay before tax for each month of `years`, going by the salary on record:
 * { 'YYYY-MM': { gross, full, whole } } where `full` is a whole month at the salary in
 * force at the end of that month, and `whole` says the person worked all of it.
 *
 * A month someone starts or leaves in is paid by the working day, at a 260th of the yearly
 * salary a day (the way the payroll software prices a part month), never more than the
 * whole month. A month with a salary change in the middle is split by working days.
 */
function trackerGross({ history, annual, startDate, endDate, years }) {
  const out = {}, start = iso(startDate), end = iso(endDate);
  const periods = periodsFrom(history);
  const salaryOn = day => (periods.length < 2 ? annual : salaryOnDate(history, day, annual));
  const changes = periods.length < 2 ? [] : periods.slice(1).map(p => p.from);
  for (const year of years) {
    for (const m of payrollMonths({ history, year, startDate: start, endDate: end, annual, netMonthly: a => a / 12 })) {
      const first = `${year}-${pad(m.month)}-01`, last = monthEnd(year, m.month);
      const from = start && start > first ? start : first, to = end && end < last ? end : last;
      const full = round2(salaryOn(last) / 12);
      let gross = m.due;
      const changedInside = changes.some(c => c > from && c <= to);
      if (!m.whole && !changedInside) gross = Math.min(round2(salaryOn(from) / 12), round2((salaryOn(from) / 260) * workdaysBetween(from, to)));
      out[ym(year, m.month)] = { gross: round2(gross), full, whole: m.whole };
    }
  }
  return out;
}

// ─── Payroll: what each payslip should say ───────────────────────────────────
/**
 * The payment each month's payslip should show.
 *
 *   slips     the payslips on file for this person, as read (payslip-read.js); any order
 *   gross     trackerGross() covering the months wanted and the months leading up to them
 *   history   salary history rows (to see whether pay changed after the latest payslip)
 *   annual    the current salary
 *   months    [{ year, month }]
 *   none      months with nothing owed, as 'YYYY-MM' (no pay went through payroll for them)
 *
 * Returns { dues: { 'YYYY-MM': { due, source, figures } }, differs } where `source` is
 *   'payslip'  that month's own payslip is on file: its payment
 *   'worked'   worked out from the latest payslip, and should match the next one to the penny
 *   'rough'    worked out from a payslip, but only an estimate (a new tax year, a month from
 *              before the first payslip, or a payslip the calculator cannot reproduce)
 * and `differs` describes a
 * payslip whose monthly pay is not what the tracker's salary gives, when that is so:
 * { payslip, tracker, year, month }.
 *
 * Pay for the months to come is the tracker's salary. When the latest payslip's basic pay
 * is not what the tracker's salary gives and no pay change has been recorded since, the
 * payslip is taken as right (it is what the accountant actually runs) and `differs` says so.
 */
function payslipDues({ slips, gross, history, annual, months, none = [] }) {
  const usable = (slips || []).filter(s => s && s.period && s.payment != null && settingsFrom(s))
    .sort((a, b) => (a.period.year - b.period.year) || (a.period.month - b.period.month));
  if (!usable.length) return { dues: {}, differs: null };
  const periods = periodsFrom(history);
  const salaryAt = (y, m) => (periods.length < 2 ? annual : salaryOnDate(history, monthEnd(y, m), annual));
  const withBasic = usable.filter(s => s.basic > 0);

  // The payslip that speaks for a month's basic pay: the latest one up to that month, else the first after
  const speaker = (y, m) => {
    const upTo = withBasic.filter(s => s.period.year < y || (s.period.year === y && s.period.month <= m));
    return upTo.length ? upTo[upTo.length - 1] : withBasic[0] || null;
  };
  const disagrees = s => {
    const t = gross[ym(s.period.year, s.period.month)];
    return !!(t && t.whole && Math.abs(t.full - s.basic) > 0.011);
  };
  const grossFor = (y, m) => {
    const t = gross[ym(y, m)];
    if (!t || !(t.gross > 0) || none.includes(ym(y, m))) return null;
    const s = speaker(y, m);
    // The payslip's basic pay stands in for the tracker's when they differ and the salary on
    // record is the same now as it was for that payslip
    if (s && disagrees(s) && Math.abs(salaryAt(y, m) - salaryAt(s.period.year, s.period.month)) < 0.005) {
      const g = round2(s.basic * (t.full > 0 ? Math.min(1, t.gross / t.full) : 1));
      return { gross: g, basic: g };
    }
    return { gross: t.gross, basic: t.gross };
  };

  const worked = payFromPayslips({ slips: usable, grossFor, months });
  const dues = {};
  for (const [k, v] of Object.entries(worked)) {
    if (!(v.payment >= 0)) continue;   // a figure below nothing is not something to pay: leave it to the estimate
    dues[k] = { due: round2(v.payment), source: v.source === 'payslip' ? 'payslip' : v.source === 'worked' && v.exact ? 'worked' : 'rough',
      figures: { gross: v.gross, tax: v.tax, ni: v.ni, student_loan: v.student_loan || 0, postgrad_loan: v.postgrad_loan || 0, pension: v.pension || 0 } };
  }
  const latest = withBasic[withBasic.length - 1];
  const differs = latest && disagrees(latest) && Math.abs(annual - salaryAt(latest.period.year, latest.period.month)) < 0.005
    ? { payslip: latest.basic, tracker: gross[ym(latest.period.year, latest.period.month)].full, year: latest.period.year, month: latest.period.month } : null;
  return { dues, differs };
}

// ─── Self-employed: the year as a running balance ────────────────────────────
/**
 * A row per month for someone paid without payslips.
 *
 *   months       payrollMonths() with netMonthly a => a / 12 (what each month is worth)
 *   payments     this year's payments ({ payment_month, amount })
 *   deductions   { month: amount } taken off for days off and office deductions
 *   skips        { month: 'later' | 'none' }
 *
 * They are often paid several months in one go, so a month with no payment of its own
 * still counts as paid when the payments so far cover everything due so far. A month
 * marked 'none' is worth nothing. Each row: { month, due, logged, paid, covered, skip,
 * status, left, deduction } where `left` is what to send for an unpaid month (the month's
 * pay, or less when earlier payments ran ahead).
 */
function contractorMonths({ months, payments, deductions = {}, skips = {} }) {
  const logged = {};
  (payments || []).forEach(p => { const m = Number(p.payment_month); logged[m] = (logged[m] || 0) + (parseFloat(p.amount) || 0); });
  let dueSoFar = 0, paidSoFar = 0, offSoFar = 0;
  // Payments logged against a month the person was not working in still count from the start
  const firstMonth = months.length ? months[0].month : 13;
  for (let m = 1; m < firstMonth; m++) paidSoFar += logged[m] || 0;
  return months.map(row => {
    const got = round2(logged[row.month] || 0);
    const skip = got > 0 ? null : skips[row.month] || null;
    const due = skip === 'none' ? 0 : round2(row.due), off = round2(deductions[row.month] || 0);
    dueSoFar += due; paidSoFar += got; offSoFar += off;
    const behind = round2(dueSoFar - paidSoFar);
    const covered = !(got > 0) && due > 0 && behind - offSoFar <= 0.5;
    const paid = got > 0 || covered;
    const left = paid || skip === 'none' ? 0 : round2(Math.max(0, Math.min(due, behind)));
    const status = skip === 'none' ? 'none' : paid ? 'paid' : skip === 'later' ? 'later' : 'due';
    return { month: row.month, due, logged: got, paid, covered, short: 0, over: 0, source: 'salary', skip, status, left, deduction: off };
  });
}

module.exports = { trackerGross, payslipDues, contractorMonths };

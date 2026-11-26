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
 * force at the end of that month, and `whole` says the person was employed from the first
 * of it to the last on one salary.
 *
 * A month someone starts or leaves in is paid by the working day, at a 260th of the yearly
 * salary a day, never more than the whole month; with every working day of it worked it is
 * a whole month's pay. A month with a salary change in the middle is split by working
 * days. How the payroll software prices a part month is not known for certain, so a month
 * that is not `whole` is never passed on as exact (see payslipDues).
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
      if (!m.whole && !changedInside) {
        const month = round2(salaryOn(from) / 12), days = workdaysBetween(from, to);
        gross = days >= workdaysBetween(first, last) ? month : Math.min(month, round2((salaryOn(from) / 260) * days));
      }
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
 * Returns { dues: { 'YYYY-MM': { due, source, figures, regular } }, differs } where `source` is
 *   'payslip'  that month's own payslip is on file: its payment
 *   'worked'   worked out from the latest payslip, and should match the next one to the penny
 *   'rough'    worked out from a payslip, but only an estimate (a new tax year, a month from
 *              before the first payslip, a part month, pay that may have changed)
 * `regular` says the figure is an ordinary month's pay (a payslip with a one-off bonus on
 * it is not), and `differs` describes a payslip whose monthly pay is being used in place
 * of the salary on record: { payslip, tracker, year, month }.
 *
 * A month is left out altogether (the caller then goes by the usual amount paid, see
 * payrollYear) when the payslip it would be worked out from is one the calculator cannot
 * itself arrive at: something on it is not understood (a deduction with a name of its own,
 * a director's National Insurance, a payday outside its own tax month), and working forward
 * would silently leave that out.
 *
 * What a regular month pays before tax is the salary on record, plus any allowance that is
 * on the last two payslips running. The payslips overrule the salary on record only when
 * two of them running agree with each other and not with it (the salary on record is out
 * of date, and `differs` says so). One payslip on its own is believed too, but only as an
 * estimate. A payslip still at the pay from before a change recorded since (a rise entered
 * after the payslip and dated back before it) and one odd month among ordinary ones (unpaid
 * days) do not overrule it: the salary on record is used, as an estimate.
 */
function payslipDues({ slips, gross, history, annual, months, none = [] }) {
  const usable = (slips || []).filter(s => s && s.period && s.payment != null && settingsFrom(s))
    .sort((a, b) => (a.period.year - b.period.year) || (a.period.month - b.period.month));
  if (!usable.length) return { dues: {}, differs: null };
  const periods = periodsFrom(history);
  const salaryAt = (y, m) => (periods.length < 2 ? annual : salaryOnDate(history, monthEnd(y, m), annual));
  const withBasic = usable.filter(s => s.basic > 0);
  const near = (a, b) => Math.abs(a - b) <= 0.011;
  const monthNo = s => s.period.year * 12 + s.period.month;
  const trackerOf = s => gross[ym(s.period.year, s.period.month)] || null;

  // The payslip that speaks for a month's pay: the latest one up to that month, else the first after
  const speaker = (y, m) => {
    const upTo = withBasic.filter(s => s.period.year < y || (s.period.year === y && s.period.month <= m));
    return upTo.length ? upTo[upTo.length - 1] : withBasic[0] || null;
  };
  const before = s => { const i = withBasic.indexOf(s); return i > 0 ? withBasic[i - 1] : null; };

  // Additions other than basic pay that are on this payslip and on last month's under the
  // same name: an allowance that comes every month, where a bonus is a one-off. `sure` is
  // false when that cannot be told (there is no payslip for the month before) or the amount moved.
  const extrasOf = s => (s.additions || []).filter(a => a && a.kind !== 'basic' && Number.isFinite(a.amount) && a.amount !== 0);
  const named = a => String(a.label || '').trim().toLowerCase();
  const everyMonth = s => {
    const mine = extrasOf(s), last = before(s);
    if (!mine.length) return { amount: 0, sure: true };
    if (!last || monthNo(last) !== monthNo(s) - 1) return { amount: 0, sure: false };
    let amount = 0, sure = true;
    for (const a of mine) {
      const b = extrasOf(last).find(x => named(x) === named(a));
      if (!b) continue;
      amount += a.amount;
      if (!near(a.amount, b.amount)) sure = false;
    }
    return { amount: round2(amount), sure };
  };

  // Which says what a regular month pays: the salary on record, or this payslip?
  const standings = new Map();
  const standing = s => {
    if (standings.has(s)) return standings.get(s);
    const t = trackerOf(s), extra = everyMonth(s);
    const out = { use: 'tracker', sure: extra.sure, extra: extra.amount, counted: false };
    const settle = more => { const v = { ...out, ...more }; standings.set(s, v); return v; };
    if (!t || !t.whole || near(t.full, s.basic)) return settle({});   // they agree (a part month's payslip says nothing of a whole one)
    if (extra.amount && near(t.full, round2(s.basic + extra.amount))) return settle({ counted: true });   // the salary on record has the allowance in it
    const here = salaryAt(s.period.year, s.period.month);
    if (periods.some(p => Math.abs(p.annual - here) > 0.005 && near(round2(p.annual / 12), s.basic))) return settle({ sure: false });   // still at the pay from before a change
    const last = before(s), lastT = last && trackerOf(last);
    if (last && near(last.basic, s.basic)) return settle({ use: 'payslip' });                                    // two running agree
    if (last && lastT && lastT.whole && near(lastT.full, last.basic)) return settle({ sure: false });           // one odd month
    return settle({ use: 'payslip', sure: false });
  };

  const grossFor = (y, m) => {
    const t = gross[ym(y, m)];
    if (!t || !(t.gross > 0) || none.includes(ym(y, m))) return null;
    const s = speaker(y, m);
    if (!s) return { gross: t.gross, basic: t.gross, sure: t.whole };
    const st = standing(s), share = t.full > 0 ? Math.min(1, t.gross / t.full) : 1;
    const extra = round2(st.extra * share);
    let sure = st.sure && t.whole;
    if (st.counted) return { gross: t.gross, basic: round2(Math.max(0, t.gross - extra)), sure };
    let basic = t.gross;
    if (st.use === 'payslip') {
      // (once the salary on record has changed since that payslip, the payslip's pay is out of date too)
      if (Math.abs(salaryAt(y, m) - salaryAt(s.period.year, s.period.month)) < 0.005) basic = round2(s.basic * share);
      else sure = false;
    }
    return { gross: round2(basic + extra), basic, sure };
  };

  const worked = payFromPayslips({ slips: usable, grossFor, months });
  const byMonth = new Map(usable.map(s => [ym(s.period.year, s.period.month), s]));
  const dues = {};
  for (const [k, v] of Object.entries(worked)) {
    if (!(v.payment >= 0)) continue;   // a figure below nothing is not something to pay: leave it to the estimate
    if (v.source !== 'payslip' && v.explained === false) continue;
    const own = v.source === 'payslip' ? byMonth.get(k) : null;
    dues[k] = { due: round2(v.payment), source: v.source === 'payslip' ? 'payslip' : v.source === 'worked' && v.exact ? 'worked' : 'rough',
      figures: { gross: v.gross, tax: v.tax, ni: v.ni, student_loan: v.student_loan || 0, postgrad_loan: v.postgrad_loan || 0, pension: v.pension || 0 },
      // (a payslip with a one-off on it, or a part month, is not what an ordinary month pays)
      regular: own ? !!(own.basic > 0 && near(own.gross, round2(own.basic + everyMonth(own).amount)) && (trackerOf(own) || {}).whole !== false) : true };
  }
  const latest = withBasic[withBasic.length - 1];
  const differs = latest && standing(latest).use === 'payslip' && Math.abs(annual - salaryAt(latest.period.year, latest.period.month)) < 0.005
    ? { payslip: latest.basic, tracker: trackerOf(latest).full, year: latest.period.year, month: latest.period.month } : null;
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
 * They are often paid several months in one go, or a missed month is made up with a later
 * payment, so the months are settled the way a running account is. A payment pays its own
 * month first. Anything over goes to the oldest month still owing, and what is left after
 * that is pay in advance, which covers the months that follow. (January's payment for four
 * months covers February to April; a double payment in May covers a missed April; a missed
 * February followed by ordinary payments stays missed.) A payment logged before the
 * person's first month counts as an advance, and one logged after their last month goes to
 * whatever is still owing. A month marked 'none' is worth nothing.
 *
 * What a month needs is its pay less that month's deductions, to within 50p.
 * Each row: { month, due, logged, paid, covered, short, skip, status, left, deduction }
 *   paid      a payment is logged in the month, or other payments have settled it (`covered`)
 *   short     a payment is logged in it, but the month is still owed this much
 *   left      what to send: the shortfall, or for an unpaid month its pay less whatever
 *             other payments have already put towards it (before any deduction is taken off)
 */
function contractorMonths({ months, payments, deductions = {}, skips = {} }) {
  const logged = {};
  (payments || []).forEach(p => { const m = Number(p.payment_month); logged[m] = (logged[m] || 0) + (parseFloat(p.amount) || 0); });
  const first = months.length ? months[0].month : 13, last = months.length ? months[months.length - 1].month : 0;
  let ahead = 0;   // pay in advance, not yet used
  for (let m = 1; m < first; m++) ahead += logged[m] || 0;
  const rows = [];
  const payOff = spare => {   // put money towards the oldest months still owing; returns what is left of it
    for (const r of rows) { if (spare <= 0) break; const use = Math.min(spare, r.owing); r.owing = round2(r.owing - use); spare = round2(spare - use); if (use > 0) r.helped = true; }
    return spare;
  };
  for (const row of months) {
    const got = round2(logged[row.month] || 0);
    const skip = got > 0 ? null : skips[row.month] || null;
    const due = skip === 'none' ? 0 : round2(row.due), off = Math.min(due, round2(deductions[row.month] || 0));
    const r = { month: row.month, due, got, skip, off: round2(deductions[row.month] || 0), owing: round2(due - off), helped: false };
    const fromAhead = Math.min(ahead, r.owing);
    if (fromAhead > 0) { r.owing = round2(r.owing - fromAhead); ahead = round2(ahead - fromAhead); r.helped = true; }
    const own = Math.min(got, r.owing);
    r.owing = round2(r.owing - own);
    ahead = round2(ahead + payOff(round2(got - own)));
    rows.push(r);
  }
  let late = 0;
  for (let m = last + 1; m <= 12; m++) late += logged[m] || 0;
  if (rows.length) payOff(round2(late));
  return rows.map(r => {
    const settled = r.owing <= 0.5;
    const covered = !(r.got > 0) && r.due > 0 && settled;
    const paid = r.got > 0 || covered;
    const short = r.got > 0 && !settled ? r.owing : 0;
    // (an unpaid month's figure is before its deduction: the page offers to take that off)
    const left = r.skip === 'none' || settled ? 0 : short || round2(Math.min(r.due, r.owing + Math.min(r.due, r.off)));
    const status = r.skip === 'none' ? 'none' : short ? 'short' : paid ? 'paid' : r.skip === 'later' ? 'later' : 'due';
    return { month: r.month, due: r.due, logged: r.got, paid, covered, short, over: 0, source: 'salary', skip: r.skip, status, left, deduction: r.off };
  });
}

module.exports = { trackerGross, payslipDues, contractorMonths };

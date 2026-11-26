'use strict';
// What each month should pay, joining the tracker's salary records to the payslips on file.
//
//   payslipDues()       payroll staff: the figure each month's payslip should show, worked
//                       out from the payslips on file the way the payroll software does it
//                       (paye.js), using the tracker's salary for the months still to come.
//   contractorYear()    self-employed staff: a row per month and where the year stands,
//                       counting payments and deductions as a running account, because
//                       they are often paid several months at once.
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
 * it is not), and `differs` describes a latest payslip whose monthly pay is not what the
 * salary on record gives, and which of the two is being used: { payslip, tracker, year,
 * month, used: 'payslip' | 'record' }. `behind` is { payslip, tracker, year, month } for a
 * latest payslip run at the pay from before a rise that covers its month: the difference
 * is still owed for that month.
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
 * after the payslip and dated back before it) and one payslip out of line with the ones
 * before it (unpaid days, arrears; or a change of pay not yet put on record, which the
 * next payslip will confirm) do not overrule it: the salary on record is used, as an
 * estimate, and `differs` or `behind` says so.
 */
function payslipDues({ slips, gross, history, annual, months, none = [] }) {
  const usable = (slips || []).filter(s => s && s.period && s.payment != null && settingsFrom(s))
    .sort((a, b) => (a.period.year - b.period.year) || (a.period.month - b.period.month));
  if (!usable.length) return { dues: {}, differs: null, behind: null };
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
    const out = { use: 'tracker', sure: extra.sure, extra: extra.amount, counted: false, old: false, odd: false };
    const settle = more => { const v = { ...out, ...more }; standings.set(s, v); return v; };
    if (!t || !t.whole || near(t.full, s.basic)) return settle({});   // they agree (a part month's payslip says nothing of a whole one)
    if (extra.amount && near(t.full, round2(s.basic + extra.amount))) return settle({ counted: true });   // the salary on record has the allowance in it
    const here = salaryAt(s.period.year, s.period.month);
    if (periods.some(p => Math.abs(p.annual - here) > 0.005 && near(round2(p.annual / 12), s.basic))) return settle({ sure: false, old: true });   // still at the pay from before a change
    const last = before(s), lastT = last && trackerOf(last);
    if (last && near(last.basic, s.basic)) return settle({ use: 'payslip' });                                    // two running agree
    if (last && lastT && lastT.whole && near(lastT.full, last.basic)) return settle({ sure: false, odd: true });   // one odd month
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
  const about = latest ? { payslip: latest.basic, tracker: (trackerOf(latest) || {}).full, year: latest.period.year, month: latest.period.month } : null;
  // (`used` says which of the two the months to come go by: 'payslip', or 'record' when one
  // payslip out of line with the ones before it is being taken for a one-off)
  const stood = latest && Math.abs(annual - salaryAt(latest.period.year, latest.period.month)) < 0.005 ? standing(latest) : null;
  const differs = stood && stood.use === 'payslip' ? { ...about, used: 'payslip' } : stood && stood.odd ? { ...about, used: 'record' } : null;
  // The latest payslip was run at the pay from before a rise that covers its month: the
  // difference is still owed for that month (payroll usually adds it to the next payslip)
  const behind = latest && standing(latest).old && about.tracker > latest.basic + 0.011 ? about : null;
  return { dues, differs, behind };
}

// ─── Self-employed: the year as a running account ────────────────────────────
/**
 * A row per month for someone paid without payslips, and where the year stands.
 *
 *   months       payrollMonths() with netMonthly a => a / 12 (what each month is worth)
 *   payments     this year's payments ({ payment_month, amount })
 *   deductions   { month: amount } taken off for days off and office deductions
 *   skips        { month: 'later' | 'none' }
 *
 * They are often paid several months in one go, a missed month is made up with a later
 * payment, or a large deduction (an advance being paid back) covers months to come. So the
 * year is kept the way a running account is, to the penny, and a deduction counts exactly
 * as money paid does:
 *
 *   1. A month's own payment goes to that month first, then its own deduction.
 *   2. What the month still needs is met from what was carried forward, oldest first.
 *   3. Whatever the month did not need (a payment or a deduction bigger than its pay) goes
 *      to the oldest month still owing, and what is left after that is carried forward to
 *      the months that follow.
 *
 * (January's payment for four months covers February to April; a double payment in May
 * covers a missed April; a missed February followed by ordinary payments stays missed; a
 * deduction of three months' pay in July leaves August and September with nothing to pay.)
 * Anything logged before the person's first month is carried forward into it, and anything
 * after their last month goes to whatever is still owing. A month marked 'none', or one
 * with no working day of theirs in it, is worth nothing.
 *
 * Pay logged by hand is seldom to the penny (a bank fee, a rounded figure). A month left
 * within half a percent of its pay (never less than 1.00) is not called short: it is
 * settled, and the pounds or pence go on to the next month, which asks for them with its
 * own pay. Nothing is dropped on the way: a little paid over is carried forward like any
 * other money, so somebody paid 2,090 a month against 2,083.33 and squared up in December
 * comes out level. Only what is still waiting at the very end of the year, which can be no
 * more than that half a percent of one month, is let go (`rounding`).
 *
 * Returns { months, left, credit, remaining, rounding }:
 *   left        what is still owed across the months
 *   credit      what was carried forward and never needed: more paid and deducted than
 *               the year's pay
 *   remaining   left − credit: the year's figure, below nothing when they are ahead.
 *               Always the year's pay, less paid, less deducted, less `rounding`.
 *   rounding    the small shortfall let go at the end of the year
 *
 * Each month: { month, due, logged, deduction, paid, covered, short, skip, status, left,
 *               taken, advance, from, made_up, made_up_in, back, back_to, ahead,
 *               brought, brought_from, passed, balance }
 *   paid        a payment is logged in the month, or it was settled another way (`covered`)
 *   short       a payment is logged in it, but the month is still owed this much
 *   left        what to send for it: its pay less everything already put towards it
 *   taken       how much of its pay was met by its own deduction
 *   advance     how much was met by what was carried forward, and `from` the months that
 *               was paid or deducted in
 *   made_up     how much was met afterwards, by payments or deductions in `made_up_in`
 *   back        how much this month put towards older months still owing (`back_to`)
 *   ahead       how much this month put towards the months after it
 *   brought     the small shortfall of earlier months (`brought_from`) asked for with this one
 *   passed      the small shortfall of this month that went on to the next
 *   balance     where the account stood at the end of the month: above nothing is ahead,
 *               below it is owed
 */
function contractorYear({ months, payments, deductions = {}, skips = {} }) {
  const logged = {};
  (payments || []).forEach(p => { const m = Number(p.payment_month); logged[m] = (logged[m] || 0) + (parseFloat(p.amount) || 0); });
  const paidIn = m => Math.max(0, round2(logged[m] || 0)), offIn = m => Math.max(0, round2(parseFloat(deductions[m]) || 0));
  const first = months.length ? months[0].month : 13, last = months.length ? months[months.length - 1].month : 0;
  const near = due => Math.max(1, round2(due * 0.005));
  const rows = [], credit = [];   // credit: [{ month, amount }], oldest first
  let debt = 0, debtFrom = [];    // small shortfalls passed on, waiting for the next month with pay of its own
  const carried = () => round2(credit.reduce((a, c) => a + c.amount, 0));
  const carry = (month, amount) => { if (amount > 0.004) credit.push({ month, amount: round2(amount) }); };
  // Take up to `want` from what was carried forward, oldest first
  const draw = want => {
    let used = 0;
    const from = [];
    while (credit.length && want - used > 0.004) {
      const c = credit[0], use = Math.min(c.amount, round2(want - used));
      used = round2(used + use); c.amount = round2(c.amount - use);
      if (use > 0 && !from.includes(c.month)) from.push(c.month);
      if (c.amount <= 0.004) credit.shift();
    }
    return { used, from };
  };
  // What a month did not need, paid or deducted in month `by`: towards the oldest months
  // still owing, then any small shortfall still waiting, and the rest carried forward.
  // { back: what went to older months, to: which ones, on: what was carried forward }
  const passOn = (by, spare) => {
    const to = [];
    let back = 0;
    for (const r of rows) {
      if (spare <= 0.004) break;
      const use = Math.min(spare, r.owing);
      if (!(use > 0)) continue;
      r.owing = round2(r.owing - use); r.later = round2(r.later + use); spare = round2(spare - use); back = round2(back + use);
      if (!r.laterIn.includes(by)) r.laterIn.push(by);
      to.push(r.month);
    }
    if (spare > 0.004 && debt > 0.004) { const use = Math.min(spare, debt); debt = round2(debt - use); spare = round2(spare - use); if (debt <= 0.004) { debt = 0; debtFrom = []; } }
    const on = spare > 0.004 ? round2(spare) : 0;
    carry(by, on);
    return { back, to, on };
  };
  const owingSoFar = () => rows.reduce((a, r) => a + r.owing, 0);

  for (let m = 1; m < first; m++) carry(m, paidIn(m) + offIn(m));
  for (const row of months) {
    const got = paidIn(row.month), off = offIn(row.month);
    const skip = got > 0 ? null : skips[row.month] || null;
    const due = skip === 'none' ? 0 : round2(row.due);
    const r = { month: row.month, due, got, off, skip, later: 0, laterIn: [], brought: 0, broughtFrom: [], passed: 0 };
    // (a small shortfall passed on by the months before is asked for with this month's pay)
    if (due > 0 && debt > 0.004) { r.brought = debt; r.broughtFrom = debtFrom; debt = 0; debtFrom = []; }
    r.owing = round2(due + r.brought);
    const own = Math.min(got, r.owing);
    r.owing = round2(r.owing - own);
    r.taken = Math.min(off, r.owing);
    r.owing = round2(r.owing - r.taken);
    const drawn = draw(r.owing);
    r.advance = drawn.used; r.from = drawn.from;
    r.owing = round2(r.owing - drawn.used);
    const spare = passOn(row.month, round2(got - own + off - r.taken));
    r.back = spare.back; r.backTo = spare.to; r.ahead = spare.on;
    // Within half a percent of settled is settled: the pounds or pence go on to the next month
    if (due > 0 && r.owing > 0.004 && r.owing <= near(due)) {
      debtFrom = r.owing <= r.brought ? r.broughtFrom : [...r.broughtFrom, row.month];
      debt = r.owing; r.passed = r.owing; r.owing = 0;
    }
    rows.push(r);
    r.balance = round2(carried() - owingSoFar() - debt);
  }
  // (with no months at all, everything was carried forward above, and nothing is owed for it)
  if (months.length) for (let m = last + 1; m <= 12; m++) passOn(m, round2(paidIn(m) + offIn(m)));

  const out = rows.map(r => {
    const settled = r.owing <= 0.004;
    // Worth nothing: set aside as nothing owed, or no working day of theirs fell in it
    const nothing = r.skip === 'none' || (r.due <= 0.004 && !(r.got > 0));
    const covered = !nothing && !(r.got > 0) && settled;
    const paid = !nothing && (r.got > 0 || covered);
    const short = r.got > 0 && !settled ? r.owing : 0;
    const left = nothing || settled ? 0 : r.owing;
    const status = nothing ? 'none' : short ? 'short' : paid ? 'paid' : r.skip === 'later' ? 'later' : 'due';
    return { month: r.month, due: r.due, logged: r.got, deduction: r.off, paid, covered, short, over: 0, source: 'salary', skip: r.skip, status, left,
      taken: round2(r.taken), advance: r.advance, from: r.from, made_up: r.later, made_up_in: r.laterIn, back: r.back, back_to: r.backTo, ahead: r.ahead,
      brought: r.brought, brought_from: r.broughtFrom, passed: r.passed, balance: r.balance };
  });
  const left = round2(out.reduce((a, r) => a + r.left, 0)), over = carried();
  return { months: out, left, credit: over, remaining: round2(left - over), rounding: round2(debt) };
}
const contractorMonths = args => contractorYear(args).months;

module.exports = { trackerGross, payslipDues, contractorMonths, contractorYear };

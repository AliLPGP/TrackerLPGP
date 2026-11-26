'use strict';
// What a self-employed person is owed for one year when their salary changed
// part-way through it. Each month is paid at the salary in force, and a month
// that holds a change is split by working days (Mon-Fri), so 30k -> 33k from
// 1 October is 9 x 2,500 + 3 x 2,750 = 30,750 for the year: +250 a month from
// the effective date, not 3,000 more for months already worked.
//
// Returns null unless the history shows at least two salaries, so people who
// were never promoted keep the existing calculation untouched.
const round2 = v => Math.round(v * 100) / 100;

function iso(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

function workdaysBetween(a, b) {
  let n = 0;
  const end = Date.parse(b + 'T00:00:00Z');
  for (let t = Date.parse(a + 'T00:00:00Z'); t <= end; t += 86400000) {
    const dow = new Date(t).getUTCDay();
    if (dow >= 1 && dow <= 5) n++;
  }
  return n;
}

function periodsFrom(history) {
  const rows = (history || [])
    .filter(h => h && h.effective_from && Number.isFinite(parseFloat(h.annual_salary)))
    .map(h => ({ from: iso(h.effective_from), annual: parseFloat(h.annual_salary), id: h.id || 0 }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.id - b.id);
  // Two entries on one day: the later one wins
  return rows.filter((p, i) => !rows[i + 1] || rows[i + 1].from !== p.from);
}

// The annual salary in force on a given day. With fewer than two salaries on record
// there is no timeline to follow, so the caller's current salary stands.
function salaryOnDate(history, day, fallback) {
  const periods = periodsFrom(history);
  if (periods.length < 2) return fallback;
  let cur = periods[0].annual;
  for (const p of periods) { if (p.from <= day) cur = p.annual; else break; }
  return cur;
}

// The salary bands that make up a year, for showing how a target was worked out:
// [{from, to, annual, monthly}] clipped to the days the person was employed that year.
// Empty unless the salary actually changed within that window.
function payBands({ history, year, startDate, endDate }) {
  const periods = periodsFrom(history);
  if (periods.length < 2) return [];
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const start = iso(startDate), end = iso(endDate);
  const winFrom = start && start > yStart ? start : yStart;
  const winTo = end && end < yEnd ? end : yEnd;
  const bands = [];
  periods.forEach((p, i) => {
    const nextFrom = periods[i + 1] ? addDay(periods[i + 1].from, -1) : '9999-12-31';
    const from = i === 0 ? winFrom : (p.from > winFrom ? p.from : winFrom);
    const to = nextFrom < winTo ? nextFrom : winTo;
    if (from <= to) bands.push({ from, to, annual: p.annual, monthly: parseFloat((p.annual / 12).toFixed(2)) });
  });
  return bands.length > 1 ? bands : [];
}

function addDay(isoDate, n) {
  return new Date(Date.parse(isoDate + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

function selfEmployedYearTarget({ history, year, startDate, endDate }) {
  const periods = periodsFrom(history);
  if (periods.length < 2) return null;

  const salaryOn = day => salaryOnDate(history, day, periods[0].annual);
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const start = iso(startDate), end = iso(endDate);
  const winFrom = start && start > yStart ? start : yStart;
  const winTo = end && end < yEnd ? end : yEnd;
  const changes = periods.slice(1).map(p => p.from);

  let total = 0;
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const dim = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const first = `${year}-${mm}-01`, last = `${year}-${mm}-${String(dim).padStart(2, '0')}`;
    const from = winFrom > first ? winFrom : first;
    const to = winTo < last ? winTo : last;
    if (from > to) continue;
    const monthDays = workdaysBetween(first, last);
    if (!monthDays) continue;
    // Cut the span wherever a salary change lands inside it
    const cuts = changes.filter(c => c > from && c <= to);
    let segFrom = from;
    for (const edge of [...cuts, null]) {
      const segTo = edge ? new Date(Date.parse(edge + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10) : to;
      if (segFrom <= segTo) total += (salaryOn(segFrom) / 12) * (workdaysBetween(segFrom, segTo) / monthDays);
      if (edge) segFrom = edge;
    }
  }
  return parseFloat(total.toFixed(2));
}

// Payroll staff are paid a fixed amount every month, so their year is a list of months,
// each owed in full at the salary in force that month (take-home, from netMonthly).
// A month they only partly worked (they started or left in it, or their salary changed
// in it) is split by working days. Returns [{ month, due, whole }] for the months they
// were employed in `year`; `whole` marks a month worked start to end on one salary.
function payrollMonths({ history, year, startDate, endDate, annual, netMonthly }) {
  const y = String(year), yStart = `${y}-01-01`, yEnd = `${y}-12-31`;
  const start = iso(startDate), end = iso(endDate);
  const from = start && start > yStart ? start : yStart;
  const to = end && end < yEnd ? end : yEnd;
  if (from > to) return [];
  const periods = periodsFrom(history);
  const salaryOn = day => (periods.length < 2 ? annual : salaryOnDate(history, day, annual));
  const changes = periods.length < 2 ? [] : periods.map(p => p.from);
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const mStart = `${y}-${mm}-01`, mEnd = `${y}-${mm}-${String(new Date(Date.UTC(+y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    const s = from > mStart ? from : mStart, e = to < mEnd ? to : mEnd;
    if (s > e) continue;
    const full = workdaysBetween(mStart, mEnd) || 1;
    // Split the employed days of the month wherever the salary changed
    const cuts = [s, ...changes.filter(d => d > s && d <= e), addDay(e, 1)];
    let due = 0;
    for (let i = 0; i < cuts.length - 1; i++) {
      const segEnd = addDay(cuts[i + 1], -1);
      due += netMonthly(salaryOn(cuts[i])) * workdaysBetween(cuts[i], segEnd) / full;
    }
    const row = { month: m, due: round2(due), whole: s === mStart && e === mEnd && cuts.length === 2 };
    // After a pay rise: what this month would have paid at the salary before it, so a
    // payment still made at the old amount can be told apart (see payrollYear).
    const rise = periods.length < 2 ? null : periods.slice(1).filter(p => p.from <= e).pop();
    // Only for the six months after it: by then a payment is no longer "still the old amount"
    if (rise && addDay(rise.from, 183) >= s) {
      const before = salaryOn(addDay(rise.from, -1));
      if (salaryOn(e) > before) row.dueBefore = round2(netMonthly(before) * workdaysBetween(s, e) / full);
    }
    out.push(row);
  }
  return out;
}

// A payroll person's year, counted in months rather than pounds, because that is how
// they are paid: a month with a payment logged is paid, and what is left is the months
// without one, each at what the person really takes home, less deductions. Paid to
// October means November and December are owed, whatever the amounts logged were.
//
// What they really take home is their usual payslip. The take-home worked out from the
// salary is only our tax estimate, which knows nothing of pension schemes, student loans
// or tax codes: with payslips of 1,900 logged against an estimate of 2,000, the months
// still to pay are 1,900 each. Only a whole month's payslip counts, and only when it is
// near the estimate (PAYSLIP_BAND), so an advance does not.
//
// Some months pay extra on top: a bonus, a tax refund, expenses paid back. Those are
// one-offs, so the usual payslip is the amount that repeats: the latest one that has come
// up at least twice (usualRate). A pay change is picked up from its second month, and a
// single month of 2,150 among the 1,900s changes nothing. Last year's payslips count too,
// so the rate carries into January and a January bonus does not set the new year.
//
// The one time a paid month is not settled: a pay rise was in force and the payment was
// still the old amount (nearer the old pay than the new). The difference is owed as a
// top-up (`short`), and that payslip says nothing about the new usual pay.
//
// Better than any of that is the payslip itself. `exact` gives, for the months it can, the
// figure worked out from the payslips on file ({ month: { due, source } }, see pay-months.js):
// the payslip's own payment for a month whose payslip is on file ('payslip'), or the month
// worked out forward from the latest payslip the way the payroll software does ('worked').
// A paid month with its own payslip is short when less was paid than the payslip says, and
// over when more was. Paying less by no more than that month's deductions
// (`deductionsByMonth`, { month: amount }) is the deduction being taken: the month is not
// short, and that deduction is not taken off the rest of the year a second time.
//
// `skips` marks months set aside on purpose ({ month: 'later' | 'none' }): 'later' is still
// owed and only changes the status; 'none' means nothing is owed for that month at all.
//
// `months` (and `lastYear.months`) come from payrollMonths. Returns the months with what
// was logged and what is still due, plus `rate` (payslip ÷ estimate, 1 with no payslip yet).
const PAYSLIP_BAND = [0.75, 1.25];
const SAME_PAYSLIP = 0.001;   // payslips within 0.1% of each other (2 in 2,000) are the same amount

function loggedByMonth(payments) {
  const logged = {};
  (payments || []).forEach(p => { const m = Number(p.payment_month); logged[m] = (logged[m] || 0) + (parseFloat(p.amount) || 0); });
  return logged;
}

// Each whole month's payslip as a share of the estimate for that month, oldest first
function payslipRates(months, logged, base = 1) {
  const rates = [];
  for (const m of months || []) {
    const got = logged[m.month] || 0;
    if (atOldPay(m, got, base)) continue;
    if (m.whole && m.due > 0 && got >= m.due * PAYSLIP_BAND[0] && got <= m.due * PAYSLIP_BAND[1]) rates.push(got / m.due);
  }
  return rates;
}

// Paid at the amount from before a pay rise: nearer the old pay than the new, and not a
// small advance. `rate` scales the estimates to real payslips.
function atOldPay(m, got, rate) {
  if (!(m.dueBefore > 0) || !(m.due > m.dueBefore) || !(got > 0)) return false;
  return got >= m.dueBefore * rate * PAYSLIP_BAND[0] && got <= (m.dueBefore + m.due) / 2 * rate;
}

// The usual one of those: the latest that matches another (SAME_PAYSLIP). With no two
// alike yet it is the middle one, the lower of two, since a one-off is usually extra.
function usualRate(rates) {
  if (!rates.length) return null;
  const same = (a, b) => Math.abs(a - b) <= SAME_PAYSLIP * b;
  for (let i = rates.length - 1; i >= 0; i--) {
    if (rates.some((r, j) => j !== i && same(r, rates[i]))) return rates[i];
  }
  const sorted = [...rates].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function payrollYear({ months, payments, deductions = 0, lastYear = null, exact = null, skips = null, deductionsByMonth = null }) {
  const logged = loggedByMonth(payments);
  const lastLogged = lastYear ? loggedByMonth(lastYear.payments) : {};
  const ratesWith = (pick, base) => [...(lastYear ? payslipRates(lastYear.months.filter(pick), lastLogged, base) : []), ...payslipRates(months.filter(pick), logged, base)];
  // The payslips from before any recent rise say how real pay compares with the estimate,
  // which is what tells an old-amount payment from a new one
  const before = usualRate(ratesWith(m => !m.dueBefore, 1)) ?? 1;
  const payslip = usualRate(ratesWith(() => true, before));
  const rate = payslip ?? 1;
  const rows = months.map(m => {
    const got = round2(logged[m.month] || 0), paid = got > 0;
    const fixed = exact && exact[m.month] && exact[m.month].due >= 0 ? exact[m.month] : null;
    const skip = !paid && skips && skips[m.month] ? skips[m.month] : null;
    const due = skip === 'none' ? 0 : fixed ? round2(fixed.due) : round2(m.due * rate);
    const source = fixed ? fixed.source : payslip !== null ? 'usual' : 'estimate';
    const onSlip = fixed && fixed.source === 'payslip';
    const gap = paid ? round2(due - got) : 0;
    // Less paid than the payslip says, by no more than that month's deductions (days off
    // over the allowance, office deductions): the deduction was taken, nothing is short
    const taken = onSlip && gap > 0.005 ? Math.min(gap, round2((deductionsByMonth && deductionsByMonth[m.month]) || 0)) : 0;
    const short = !paid ? 0 : onSlip ? (gap - taken > 0.005 ? round2(gap - taken) : 0) : (atOldPay(m, got, rate) ? Math.max(0, gap) : 0);
    const over = paid && onSlip && got > due + 0.005 ? round2(got - due) : 0;
    const status = skip === 'none' ? 'none' : short ? 'short' : paid ? 'paid' : skip === 'later' ? 'later' : 'due';
    return { month: m.month, due, logged: got, paid, short, over, taken: round2(taken), source, skip, status, left: paid ? short : due };
  });
  const totalPaid = round2((payments || []).reduce((a, p) => a + (parseFloat(p.amount) || 0), 0));
  const toPay = round2(rows.reduce((a, m) => a + m.left, 0));
  // (a deduction already taken out of a payment is not taken off again)
  const stillToTake = Math.max(0, round2(deductions - rows.reduce((a, m) => a + m.taken, 0)));
  const remaining = round2(toPay - stillToTake), owed = Math.max(0, remaining);
  return { months: rows, rate, fromPayslip: payslip !== null, target: round2(totalPaid + toPay), remaining, totalPaid,
    pct: totalPaid + owed > 0 ? Math.min(100, Math.round(totalPaid / (totalPaid + owed) * 100)) : 100 };
}

module.exports = { selfEmployedYearTarget, periodsFrom, workdaysBetween, salaryOnDate, payBands, payrollMonths, payrollYear };

'use strict';
// Payroll: each month owed in full at the salary in force; months not paid are what is left
const assert = require('assert');
const round2 = v => Math.round(v * 100) / 100;
const { payrollMonths, payrollYear } = require('../salary-periods');

const net = a => a / 12; // keep the arithmetic readable: take-home = gross / 12
// Started 1 Aug on 18k (probation), 28.5k from 1 Oct
const history = [{ effective_from: '2026-08-01', annual_salary: 18000 }, { effective_from: '2026-10-01', annual_salary: 28500 }];
const months = payrollMonths({ history, year: 2026, startDate: '2026-08-01', endDate: null, annual: 28500, netMonthly: net });
assert.deepStrictEqual(months.map(m => m.month), [8, 9, 10, 11, 12], 'August to December');
assert.deepStrictEqual(months.map(m => m.due), [1500, 1500, 2375, 2375, 2375], 'probation rate, then the new salary');
const paid = new Set([8, 9, 10]);
const left = months.filter(m => !paid.has(m.month)).reduce((a, m) => a + m.due, 0);
assert.strictEqual(left, 4750, 'November and December still to pay, at 28.5k');

// Never changed salary, all year: twelve equal months
const flat = payrollMonths({ history: [], year: 2026, startDate: '2024-05-01', endDate: null, annual: 24000, netMonthly: net });
assert.strictEqual(flat.length, 12); assert.ok(flat.every(m => m.due === 2000 && m.whole));

// Left on 15 May: May is part of a month (by working days); nothing after
const leaver = payrollMonths({ history: [], year: 2026, startDate: '2024-05-01', endDate: '2026-05-15', annual: 24000, netMonthly: net });
assert.deepStrictEqual(leaver.map(m => m.month), [1, 2, 3, 4, 5]);
assert.ok(leaver[4].due > 0 && leaver[4].due < 2000, 'May is part paid');
assert.ok(leaver[3].whole && !leaver[4].whole, 'May is not a whole month');

// Salary changed mid-month: that month is split by working days
const mid = payrollMonths({ history: [{ effective_from: '2025-01-01', annual_salary: 24000 }, { effective_from: '2026-06-15', annual_salary: 36000 }],
  year: 2026, startDate: '2025-01-01', endDate: null, annual: 36000, netMonthly: net });
const june = mid.find(m => m.month === 6).due;
assert.ok(june > 2000 && june < 3000, 'June is between the two monthly amounts');
assert.strictEqual(mid.find(m => m.month === 7).due, 3000);

assert.ok(!mid.find(m => m.month === 6).whole, 'nor is a month the salary changed in');

// ── The year in months (payrollYear) ──
// Jane Example started 19 January on a take-home we estimate at 2,000 a month. Her payslips
// are 1,900 (a pension the estimate knows nothing about), logged for January to October.
const pay = (month, amount) => ({ payment_month: month, amount });
const jane = payrollMonths({ history: [], year: 2026, startDate: '2026-01-19', endDate: null, annual: 24000, netMonthly: net });
const janePaid = [pay(1, 1250), ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map(m => pay(m, 1900))];
let y = payrollYear({ months: jane, payments: janePaid, deductions: 150 });
assert.deepStrictEqual(y.months.filter(m => !m.paid).map(m => [m.month, m.due]), [[11, 1900], [12, 1900]], 'paid to October: two months owed, at what she really gets');
assert.strictEqual(y.remaining, 3650, 'two payslips, less deductions');
assert.strictEqual(y.rate, 0.95); assert.ok(y.fromPayslip);
assert.strictEqual(y.totalPaid, 18350);
assert.strictEqual(y.target, 18350 + 3800, 'the year adds up to what was paid plus what is still to pay');
assert.ok(y.months.slice(0, 10).every(m => m.paid && m.left === 0), 'a month with a payslip is paid, though it is under the estimate');

// Nothing logged yet: the estimate stands in for a payslip
y = payrollYear({ months: flat, payments: [], deductions: 0 });
assert.strictEqual(y.remaining, 24000); assert.ok(!y.fromPayslip); assert.strictEqual(y.pct, 0);

// January of a new year: last year's payslips still set the monthly pay
y = payrollYear({ months: flat, payments: [], lastYear: { months: flat, payments: [pay(11, 1900), pay(12, 1900)] } });
assert.strictEqual(y.months[0].due, 1900); assert.strictEqual(y.remaining, 22800); assert.ok(y.fromPayslip);

// Only a whole month's payslip near the estimate sets the rate: not the part month she
// started in, an advance, or a month with a bonus on top
y = payrollYear({ months: jane, payments: [pay(1, 1250)] });
assert.strictEqual(y.rate, 1, 'a part month says nothing about a whole one');
y = payrollYear({ months: flat, payments: [pay(1, 1900), pay(2, 500), pay(3, 4400)] });
assert.strictEqual(y.rate, 0.95, 'the advance and the bonus month are passed over');
assert.deepStrictEqual(y.months.slice(0, 4).map(m => m.paid), [true, true, true, false], 'but each still counts as a paid month');

// A month that pays extra (a bonus, a tax refund) is a one-off: the usual payslip is the
// amount that repeats, so the months still to pay stay at 1,900
y = payrollYear({ months: flat, payments: [...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(m => pay(m, 1900)), pay(10, 2150)] });
assert.strictEqual(y.rate, 0.95, 'a bonus in the latest month does not become the monthly pay');
assert.deepStrictEqual(y.months.filter(m => !m.paid).map(m => [m.month, m.due]), [[11, 1900], [12, 1900]]);
assert.strictEqual(y.remaining, 3800); assert.strictEqual(y.totalPaid, 19250, 'the extra is still counted as paid');
y = payrollYear({ months: flat, payments: [pay(1, 1900), pay(2, 1900), pay(3, 1936.4), pay(4, 1900), pay(5, 2300)] });
assert.strictEqual(y.rate, 0.95, 'nor does a small refund, or two different extras');
y = payrollYear({ months: flat, payments: [pay(1, 1900), pay(2, 2150)] });
assert.strictEqual(y.rate, 0.95, 'two payslips that differ: the lower one, as extras are extra');
y = payrollYear({ months: flat, payments: [pay(1, 1900), pay(2, 2150), pay(3, 1760)] });
assert.strictEqual(y.rate, 0.95, 'three that all differ: the middle one');
// A real change (a new tax code, a pension starting) shows from its second month
y = payrollYear({ months: flat, payments: [...[1, 2, 3, 4, 5, 6].map(m => pay(m, 1900)), pay(7, 1960)] });
assert.strictEqual(y.rate, 0.95, 'one month at a new amount could be a one-off');
y = payrollYear({ months: flat, payments: [...[1, 2, 3, 4, 5, 6].map(m => pay(m, 1900)), pay(7, 1960), pay(8, 1960)] });
assert.strictEqual(y.rate, 0.98, 'two months at it and it is the monthly pay');
assert.strictEqual(y.months.find(m => m.month === 9).due, 1960);
// A January bonus does not set the new year: last year's payslips still say what is usual
y = payrollYear({ months: flat, payments: [pay(1, 2400)], lastYear: { months: flat, payments: flat.map(m => pay(m.month, 1900)) } });
assert.strictEqual(y.rate, 0.95); assert.strictEqual(y.remaining, 11 * 1900);

// A month missed in the middle is still owed
y = payrollYear({ months: flat, payments: [1, 3, 4].map(m => pay(m, 2000)) });
assert.deepStrictEqual(y.months.filter(m => !m.paid).map(m => m.month), [2, 5, 6, 7, 8, 9, 10, 11, 12]);

// After a raise the payslip follows the new salary in the same proportion
const raised = payrollMonths({ history: [{ effective_from: '2025-01-01', annual_salary: 24000 }, { effective_from: '2026-07-01', annual_salary: 30000 }],
  year: 2026, startDate: '2025-01-01', endDate: null, annual: 30000, netMonthly: net });
y = payrollYear({ months: raised, payments: [1, 2, 3, 4, 5, 6].map(m => pay(m, 1900)) });
assert.strictEqual(y.months.find(m => m.month === 7).due, 2375, '2,500 estimated, at 95%');

// Everything paid, with a deduction never taken off a payslip: paid ahead by that much
y = payrollYear({ months: flat, payments: flat.map(m => pay(m.month, 2000)), deductions: 100 });
assert.strictEqual(y.remaining, -100); assert.strictEqual(y.pct, 100);

// A pay rise from 1 November, but November was still paid at the old amount: the difference is owed
{
  const hist = [{ id: 1, effective_from: '2026-08-15', annual_salary: 18000 }, { id: 2, effective_from: '2026-11-01', annual_salary: 28000 }];
  const ms = payrollMonths({ history: hist, year: 2026, startDate: '2026-08-15', endDate: null, annual: 28000, netMonthly: a => a / 15 });
  const pay = (m, amount) => ({ payment_month: m, amount });
  const old = payrollYear({ months: ms, payments: [pay(8, 600), pay(9, 1200), pay(10, 1200), pay(11, 1200)] });
  const nov = old.months.find(m => m.month === 11);
  assert.strictEqual(nov.paid, true);
  assert.strictEqual(nov.short, round2(28000 / 15 - 1200));
  assert.strictEqual(old.remaining, round2(nov.short + 28000 / 15));
  // Paid at the new amount: nothing short
  const fine = payrollYear({ months: ms, payments: [pay(9, 1200), pay(10, 1200), pay(11, 1866.67)] });
  assert.strictEqual(fine.months.find(m => m.month === 11).short, 0);
  // No rise: a low payment is still just a paid month
  const flatMs = payrollMonths({ history: [], year: 2026, startDate: '2025-01-01', endDate: null, annual: 18000, netMonthly: a => a / 15 });
  assert.strictEqual(payrollYear({ months: flatMs, payments: [pay(1, 900)] }).months[0].short, 0);
}

// Payslips on file give the months their figures, and a month can be set aside
{
  const ms = payrollMonths({ history: [], year: 2026, startDate: '2025-01-01', endDate: null, annual: 30000, netMonthly: a => a / 15 });   // 2,000 a month by the estimate
  const pay = (m, amount) => ({ payment_month: m, amount });
  const exact = { 10: { due: 2010.24, source: 'payslip' }, 11: { due: 2010.44, source: 'payslip' }, 12: { due: 2010.24, source: 'worked' } };
  const toOctober = () => [...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(m => pay(m, 2010.44)), pay(10, 2010.24)];
  const y = payrollYear({ months: ms, payments: [...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(m => pay(m, 2010.44)), pay(10, 2010.24), pay(11, 1900)], exact,
    skips: { 12: 'later' } });
  const row = m => y.months.find(r => r.month === m);
  // October was paid what its payslip says; November less than its payslip says; December is worked out, and set aside to pay later
  assert.deepStrictEqual([row(10).status, row(10).short, row(10).source], ['paid', 0, 'payslip']);
  assert.deepStrictEqual([row(11).status, row(11).short, row(11).left, row(11).due], ['short', 110.44, 110.44, 2010.44]);
  assert.deepStrictEqual([row(12).status, row(12).due, row(12).left, row(12).source, row(12).skip], ['later', 2010.24, 2010.24, 'worked', 'later']);
  assert.strictEqual(y.remaining, round2(110.44 + 2010.24));
  // A month without a figure from the payslips falls back to the usual amount paid
  assert.strictEqual(row(9).source, 'usual');
  // More than the payslip says is noted, never owed
  const over = payrollYear({ months: ms, payments: [pay(11, 2100)], exact });
  assert.deepStrictEqual([over.months.find(r => r.month === 11).over, over.months.find(r => r.month === 11).short], [89.56, 0]);
  // Nothing owed for a month: it is worth nothing and nothing is left on it
  const none = payrollYear({ months: ms, payments: [], exact, skips: { 12: 'none' } });
  assert.deepStrictEqual([none.months.find(r => r.month === 12).status, none.months.find(r => r.month === 12).due, none.months.find(r => r.month === 12).left], ['none', 0, 0]);
  // ...but a payment logged for a month set aside wins
  const paidAnyway = payrollYear({ months: ms, payments: [pay(12, 2010.24)], exact, skips: { 12: 'none' } });
  assert.deepStrictEqual([paidAnyway.months.find(r => r.month === 12).status, paidAnyway.months.find(r => r.month === 12).skip], ['paid', null]);

  // A month whose own payslip pays nothing (unpaid leave put through payroll) is settled
  const nil = payrollYear({ months: ms, payments: toOctober(), exact: { ...exact, 11: { due: 0, source: 'payslip' } } });
  assert.deepStrictEqual([nil.months.find(r => r.month === 11).status, nil.months.find(r => r.month === 11).left, nil.remaining], ['none', 0, 2010.24]);

  // A day off over the allowance in November costs 115.38. Paying November's payslip less
  // that is the deduction being taken: nothing is short, and it is not taken off December too
  const toOct = toOctober();
  const taken = payrollYear({ months: ms, payments: [...toOct, pay(11, 1895.06)], exact, deductions: 115.38, deductionsByMonth: { 11: 115.38 } });
  const nov = taken.months.find(r => r.month === 11);
  assert.deepStrictEqual([nov.status, nov.short, nov.taken, nov.left], ['paid', 0, 115.38, 0]);
  assert.strictEqual(taken.remaining, 2010.24);
  // Paying less than that again is short by the difference
  const less = payrollYear({ months: ms, payments: [...toOct, pay(11, 1800)], exact, deductions: 115.38, deductionsByMonth: { 11: 115.38 } });
  assert.deepStrictEqual([less.months.find(r => r.month === 11).status, less.months.find(r => r.month === 11).short, less.remaining], ['short', 95.06, round2(95.06 + 2010.24)]);
  // Paid in full, the deduction is still to come off what is left
  const inFull = payrollYear({ months: ms, payments: [...toOct, pay(11, 2010.44)], exact, deductions: 115.38, deductionsByMonth: { 11: 115.38 } });
  assert.deepStrictEqual([inFull.months.find(r => r.month === 11).taken, inFull.remaining], [0, round2(2010.24 - 115.38)]);
  // A deduction in another month does not excuse a short payment in this one
  const elsewhere = payrollYear({ months: ms, payments: [...toOct, pay(11, 1895.06)], exact, deductions: 115.38, deductionsByMonth: { 3: 115.38 } });
  assert.deepStrictEqual([elsewhere.months.find(r => r.month === 11).status, elsewhere.months.find(r => r.month === 11).short], ['short', 115.38]);
}

console.log('payroll months tests passed');

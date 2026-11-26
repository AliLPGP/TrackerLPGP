'use strict';
// The month-by-month pay calculator, checked against HMRC's own published test data for
// payroll software (2026 to 2027, the monthly rows: England and Northern Ireland, Wales
// and Scotland), HMRC's worked examples, and made-up payslips.
const assert = require('assert');
const P = require('../paye');
const { trackerGross, payslipDues, contractorMonths } = require('../pay-months');

const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.0051, `${what}: got ${a}, expected ${b}`);
const round2 = v => Math.round(v * 100) / 100;

// ── HMRC's test data ──
// Each row: [sheet, tax code, month-1 basis?, tax month, pay this month, tax due this month].
// Within a sheet the months follow on from each other, as one employee's year.
{
  const rows = require('./fixtures/hmrc-paye-test-data-2026-27.json');
  let sheet = '', payBefore = 0, taxBefore = 0, checked = 0;
  for (const [name, code, month1, month, pay, expected] of rows) {
    if (name !== sheet || month === 1) { payBefore = 0; taxBefore = 0; }
    sheet = name;
    const tax = P.taxForMonth({ code, month1: !!month1, taxMonth: month, pay, payBefore, taxBefore, taxYear: 2026 });
    near(tax, expected, `HMRC ${name} ${code}${month1 ? ' M1' : ''} month ${month} on ${pay}`);
    if (!month1) { payBefore = round2(payBefore + pay); taxBefore = round2(taxBefore + tax); }
    checked++;
  }
  assert.strictEqual(checked, 87);
}

// ── Tax-free pay for a month, from the code number (HMRC Tables A) ──
for (const [code, monthly] of [[1257, 1048.26], [45, 38.25], [431, 359.92], [500, 417.42], [501, 418.26], [999, 833.26], [1000, 834.09], [1001, 834.93], [585, 488.26], [0, 0]]) {
  near(P.monthlyAdjustment(code), monthly, `free pay for code ${code}`);
}

// ── Worked examples ──
{
  // 1257L on 2,500.00 every month: the pattern a real payslip shows (20p moves about with the rounding)
  const got = []; let payBefore = 0, taxBefore = 0;
  for (let m = 1; m <= 12; m++) {
    const tax = P.taxForMonth({ code: '1257L', taxMonth: m, pay: 2500, payBefore, taxBefore, taxYear: 2026 });
    got.push(tax); payBefore += 2500; taxBefore = round2(taxBefore + tax);
  }
  assert.deepStrictEqual(got, [290.2, 290.4, 290.4, 290.2, 290.4, 290.4, 290.4, 290.2, 290.4, 290.4, 290.4, 290.2]);
  assert.strictEqual(taxBefore, 3484);

  // A month-1 code taxes each month by itself, whatever came before
  near(P.taxForMonth({ code: '1257L', month1: true, taxMonth: 8, pay: 2166.67, payBefore: 99999, taxBefore: 99999, taxYear: 2026 }), 223.6, 'month-1 basis');
  near(P.taxForMonth({ code: '1257LM1', taxMonth: 8, pay: 2166.67, taxYear: 2026 }), 223.6, 'month-1 marker in the code itself');

  // Into the higher rate: 6,000.00 a month
  near(P.taxForMonth({ code: '1257L', taxMonth: 1, pay: 6000, taxYear: 2026 }), 1352.06, 'higher rate month 1');
  near(P.taxForMonth({ code: '1257L', taxMonth: 2, pay: 6000, payBefore: 6000, taxBefore: 1352.06, taxYear: 2026 }), 1352.47, 'higher rate month 2');

  // Someone who starts in tax month 7 with nothing before: seven months of tax-free pay at once, so no tax
  near(P.taxForMonth({ code: '1257L', taxMonth: 7, pay: 1361.91, taxYear: 2026 }), 0, 'starter month 7');
  near(P.taxForMonth({ code: '1257L', taxMonth: 8, pay: 1361.91, payBefore: 1361.91, taxBefore: 0, taxYear: 2026 }), 0, 'starter month 8');
  // ...and tax starts with the new tax year
  near(P.taxForMonth({ code: '1257L', taxMonth: 1, pay: 1361.91, taxYear: 2026 }), 62.6, 'the same pay in month 1');

  // Paid too much tax earlier in the year: a cumulative code gives it back, a month-1 code never does
  near(P.taxForMonth({ code: '1257L', taxMonth: 3, pay: 1000, payBefore: 2000, taxBefore: 400, taxYear: 2026 }), -400, 'refund');
  near(P.taxForMonth({ code: '1257L', month1: true, taxMonth: 3, pay: 1000, payBefore: 2000, taxBefore: 400, taxYear: 2026 }), 0, 'no refund on month 1');

  // Tax never takes more than half the month's pay
  near(P.taxForMonth({ code: 'K2000', month1: true, taxMonth: 1, pay: 400, taxYear: 2026 }), 200, 'the 50% limit');

  // Flat-rate codes (HMRC's 99.99 cases)
  for (const [code, tax] of [['BR', 19.8], ['D0', 39.6], ['D1', 44.55], ['SBR', 19.8], ['SD0', 20.79], ['SD1', 41.58], ['SD2', 44.55], ['SD3', 47.52], ['CBR', 19.8], ['NT', 0]]) {
    near(P.taxForMonth({ code, month1: true, taxMonth: 1, pay: 99.99, taxYear: 2026 }), tax, code);
  }
  near(P.taxForMonth({ code: '0T', month1: true, taxMonth: 1, pay: 2166.67, taxYear: 2026 }), 433.2, '0T');
}

// ── Tax codes as printed ──
assert.deepStrictEqual(P.parseTaxCode('1257L'), { kind: 'suffix', region: 'ruk', month1: false, number: 1257 });
assert.deepStrictEqual(P.parseTaxCode('1257l w1m1'), { kind: 'suffix', region: 'ruk', month1: true, number: 1257 });
assert.deepStrictEqual(P.parseTaxCode('1257L X'), { kind: 'suffix', region: 'ruk', month1: true, number: 1257 });
assert.deepStrictEqual(P.parseTaxCode('S1257L'), { kind: 'suffix', region: 'scot', month1: false, number: 1257 });
assert.deepStrictEqual(P.parseTaxCode('C1257L'), { kind: 'suffix', region: 'wales', month1: false, number: 1257 });
assert.deepStrictEqual(P.parseTaxCode('K475'), { kind: 'K', region: 'ruk', month1: false, number: 475 });
assert.deepStrictEqual(P.parseTaxCode('SK475 M1'), { kind: 'K', region: 'scot', month1: true, number: 475 });
assert.deepStrictEqual(P.parseTaxCode('BR'), { kind: 'BR', region: 'ruk', month1: false, number: 0 });
assert.deepStrictEqual(P.parseTaxCode('D1'), { kind: 'D', region: 'ruk', month1: false, number: 1 });
assert.deepStrictEqual(P.parseTaxCode('0T'), { kind: 'suffix', region: 'ruk', month1: false, number: 0 });
assert.deepStrictEqual(P.parseTaxCode('NT'), { kind: 'NT', region: 'ruk', month1: false, number: 0 });
for (const junk of ['', null, 'hello', '12', 'L1257', '1257LL']) assert.strictEqual(P.parseTaxCode(junk), null, `"${junk}" is not a tax code`);

// ── Which tax month a payment falls in ──
assert.deepStrictEqual([4, 5, 11, 12, 1, 3].map(P.taxMonthOf), [1, 2, 8, 9, 10, 12]);
assert.deepStrictEqual([[2026, 4], [2026, 12], [2027, 1], [2027, 3], [2027, 4]].map(([y, m]) => P.taxYearOf(y, m)), [2026, 2026, 2026, 2026, 2027]);
assert.deepStrictEqual(P.taxPeriodOfDate('2026-11-30'), { taxYear: 2026, taxMonth: 8 });
assert.deepStrictEqual(P.taxPeriodOfDate('2026-11-05'), { taxYear: 2026, taxMonth: 7 });
assert.deepStrictEqual(P.taxPeriodOfDate('2026-04-06'), { taxYear: 2026, taxMonth: 1 });
assert.deepStrictEqual(P.taxPeriodOfDate('2026-04-05'), { taxYear: 2025, taxMonth: 12 });
assert.deepStrictEqual(P.taxPeriodOfDate('2027-01-03'), { taxYear: 2026, taxMonth: 9 });

// ── National Insurance: each month alone ──
for (const [gross, employee, employer] of [[2500, 116.16, 312.45], [2666.67, 129.49, 337.45], [1361.91, 25.11, 141.74], [1000, 0, 87.45], [5000, 267.5, 687.45],
  [417, 0, 0], [1048, 0, 94.65], [1048.13, 0.01, 94.67], [4189, 251.28, 565.8], [4189.01, 251.28, 565.8],
  // HMRC's rounding looks no further than the third decimal place: these would be a penny out otherwise
  [2000.07, 76.16, 237.46], [2000.17, 76.17, 237.47], [4215.26, 251.8, 569.74]]) {
  near(P.niEmployee(gross, 'A', 2026), employee, `employee NI on ${gross}`);
  near(P.niEmployer(gross, 'A', 2026), employer, `employer NI on ${gross}`);
}
near(P.niEmployee(3000, 'C', 2026), 0, 'over State Pension age pays none');
near(P.niEmployee(3000, 'J', 2026), 39.04, 'deferment: 2%');
near(P.niEmployee(3000, 'B', 2026), 36.11, 'reduced rate: 1.85%');
near(P.niEmployee(3000, 'M', 2026), 156.16, 'under 21: the usual employee rate');
near(P.niEmployer(3000, 'M', 2026), 0, 'under 21: no employer NI below the upper threshold');
near(P.niEmployer(3000, 'X', 2026), 0, 'category X');
near(P.niEmployee(2500, undefined, 2026), 116.16, 'no letter means A');

// ── Student and postgraduate loans ──
assert.strictEqual(P.studentLoan(2375, ['2'], 2026), 0, 'under the Plan 2 threshold');
assert.strictEqual(P.studentLoan(2500, ['2'], 2026), 4);
assert.strictEqual(P.studentLoan(3200, ['2'], 2026), 67);
assert.strictEqual(P.studentLoan(2500, ['1'], 2026), 23);
assert.strictEqual(P.studentLoan(2500, ['5'], 2026), 37);
assert.strictEqual(P.studentLoan(2500, ['1', '2'], 2026), 23, 'two plans: the lower threshold');
assert.strictEqual(P.studentLoan(2500, [], 2026), 0);
assert.strictEqual(P.postgradLoan(2500, 2026), 45);
assert.strictEqual(P.postgradLoan(1700, 2026), 0);

// ── Pension: the rule is read off a payslip ──
{
  // NEST: 4% of the pay between 520 and 4,189 a month comes off pay
  const nest = P.pensionRule({ gross: 2375, basic: 2375, pension: 74.2, taxable_gross: 2375 }, 2026);
  assert.deepStrictEqual(nest, { on: 'qualifying', rate: 0.04, before_tax: false });
  near(P.pensionFor(nest, 2666.67, 2666.67, 2026), 85.87, 'the same rule on other pay');
  near(P.pensionFor(nest, 6000, 6000, 2026), 146.76, 'capped at the upper limit');
  near(P.pensionFor(nest, 400, 400, 2026), 0, 'nothing below the floor');
  // 5% of all pay, taken before tax
  const all = P.pensionRule({ gross: 3000, basic: 3000, pension: 150, taxable_gross: 2850 }, 2026);
  assert.deepStrictEqual(all, { on: 'gross', rate: 0.05, before_tax: true });
  assert.strictEqual(P.pensionRule({ gross: 2000, pension: null }, 2026), null);
  assert.strictEqual(P.pensionFor(null, 2000, 2000, 2026), 0);
}

// ── A whole payslip, and the months after it ──
// A made-up payslip for November 2026: 2,500.00 a month, Plan 2 loan, NEST, eight months into the tax year
const slip = (over = {}) => ({
  period: { year: 2026, month: 11, end: '2026-11-30' }, paid_on: '2026-11-30', tax_code: '1257L', tax_basis: 'cumulative', ni_table: 'A',
  student_loan_plans: ['2'], postgrad_loan: false, basic: 2500, gross: 2500, taxable_gross: 2500, tax: 290.2, ni: 116.16, student_loan: 4,
  postgrad_loan_amount: null, pension: 79.2, other_deductions: null, payment: 2010.44,
  ytd: { gross: 20000, tax: 2322.6 }, ...over,
});
{
  const s = slip(), settings = P.settingsFrom(s);
  assert.deepStrictEqual(settings, { tax_code: '1257L', month1: false, ni_table: 'A', student_loan_plans: ['2'], postgrad_loan: false, pension: { on: 'qualifying', rate: 0.04, before_tax: false } });
  // The calculator arrives at the payslip's own figures from the year-to-date figures before it
  const own = P.monthFigures({ settings, year: 2026, month: 11, gross: 2500, basic: 2500, payBefore: 17500, taxBefore: 2032.4 });
  assert.deepStrictEqual([own.tax, own.ni, own.student_loan, own.pension, own.payment, own.employer_ni], [290.2, 116.16, 4, 79.2, 2010.44, 312.45]);
  assert.strictEqual(P.reproduces(s), true);
  assert.strictEqual(P.reproduces(slip({ payment: 1990.44 })), false, 'a payslip the calculator cannot explain');
  assert.strictEqual(P.reproduces(slip({ other_deductions: 20, payment: 1990.44 })), false, 'a deduction it does not know about');
  assert.strictEqual(P.settingsFrom({ period: null }), null);
  assert.strictEqual(P.settingsFrom(slip({ tax_code: '???' })), null);

  const grossFor = () => ({ gross: 2500, basic: 2500 });
  const months = [[2026, 11], [2026, 12], [2027, 1], [2027, 3], [2027, 4], [2027, 5]].map(([year, month]) => ({ year, month }));
  const out = P.payFromPayslips({ slips: [s], grossFor, months });
  // November is the payslip itself
  assert.deepStrictEqual([out['2026-11'].payment, out['2026-11'].source, out['2026-11'].exact], [2010.44, 'payslip', true]);
  // December to March follow on from its year-to-date figures (tax 290.40, 290.40, .., 290.20 in month 12)
  assert.deepStrictEqual([out['2026-12'].payment, out['2026-12'].tax, out['2026-12'].source, out['2026-12'].exact], [2010.24, 290.4, 'worked', true]);
  assert.strictEqual(out['2027-01'].payment, 2010.24);
  assert.deepStrictEqual([out['2027-03'].payment, out['2027-03'].tax], [2010.44, 290.2]);
  // April starts a new tax year from nothing: a figure, but no longer a promise
  assert.deepStrictEqual([out['2027-04'].tax, out['2027-04'].source, out['2027-04'].exact], [290.2, 'worked', false]);
  assert.strictEqual(out['2027-05'].tax, 290.4);

  // A bonus month does not change the months after it, except for the tax it used up
  const bonus = slip({ gross: 3500, taxable_gross: 3500, tax: 490.2, ni: 196.16, student_loan: 94, pension: 119.2, payment: 2600.44, ytd: { gross: 21000, tax: 2522.6 } });
  assert.strictEqual(P.reproduces(bonus), true);
  const after = P.payFromPayslips({ slips: [bonus], grossFor, months: [{ year: 2026, month: 12 }] })['2026-12'];
  assert.deepStrictEqual([after.gross, after.tax, after.student_loan, after.pension, after.payment], [2500, 290.4, 4, 79.2, 2010.24]);

  // A month-1 code: the same every month, and cumulative again from April
  const m1 = slip({ tax_basis: 'month1', student_loan_plans: [], pension: null, basic: 2166.67, gross: 2166.67, taxable_gross: 2166.67, tax: 223.6, ni: 89.49, student_loan: null, payment: 1853.58, ytd: { gross: 3366.67, tax: 253.8 } });
  const m1out = P.payFromPayslips({ slips: [m1], grossFor: () => ({ gross: 2166.67, basic: 2166.67 }), months: [{ year: 2026, month: 12 }, { year: 2027, month: 4 }, { year: 2027, month: 5 }, { year: 2027, month: 6 }] });
  assert.deepStrictEqual([m1out['2026-12'].payment, m1out['2026-12'].exact], [1853.58, true]);
  // (on a month-1 basis every month would be 223.60; cumulatively the odd pence add up to 223.80 in the third month)
  assert.deepStrictEqual([m1out['2027-04'].tax, m1out['2027-05'].tax, m1out['2027-06'].tax], [223.6, 223.6, 223.8], 'cumulative from the new tax year');

  // A starter with tax-free pay in hand: no tax until April
  const starter = slip({ student_loan_plans: [], pension: null, basic: 1361.91, gross: 1361.91, taxable_gross: 1361.91, tax: 0, ni: 25.11, student_loan: null, payment: 1336.8, ytd: { gross: 2723.82, tax: 0 } });
  const st = P.payFromPayslips({ slips: [starter], grossFor: () => ({ gross: 1361.91, basic: 1361.91 }), months: [{ year: 2026, month: 12 }, { year: 2027, month: 3 }, { year: 2027, month: 4 }] });
  assert.deepStrictEqual([st['2026-12'].payment, st['2027-03'].payment, st['2027-04'].payment], [1336.8, 1336.8, 1274.2]);

  // A month from before the first payslip on file: its settings, working back from its year-to-date figures
  const back = P.payFromPayslips({ slips: [s], grossFor, months: [{ year: 2026, month: 10 }, { year: 2026, month: 4 }] });
  assert.deepStrictEqual([back['2026-10'].payment, back['2026-10'].source, back['2026-10'].exact], [2010.24, 'back', false]);
  assert.strictEqual(back['2026-04'].payment, 2010.44);

  // Months the person is not employed in, and people with no payslip, get nothing
  assert.deepStrictEqual(P.payFromPayslips({ slips: [s], grossFor: () => null, months }), { '2026-11': out['2026-11'] });
  assert.deepStrictEqual(P.payFromPayslips({ slips: [], grossFor, months }), {});
  assert.deepStrictEqual(P.payFromPayslips({ slips: [slip({ tax_code: '' })], grossFor, months }), {});

  // Two payslips: the later one speaks for the months after it
  const dec = slip({ period: { year: 2026, month: 12, end: '2026-12-31' }, tax: 290.4, payment: 2010.24, ytd: { gross: 22500, tax: 2613 } });
  const two = P.payFromPayslips({ slips: [s, dec], grossFor, months: [{ year: 2027, month: 1 }, { year: 2026, month: 12 }] });
  assert.deepStrictEqual([two['2026-12'].source, two['2027-01'].payment, two['2027-01'].tax], ['payslip', 2010.24, 290.4]);
}

// ── Joining the payslips to the salary on record (pay-months.js) ──
{
  const history = [], annual = 30000;
  const gross = trackerGross({ history, annual, startDate: '2024-03-01', endDate: null, years: [2026, 2027] });
  assert.deepStrictEqual(gross['2026-12'], { gross: 2500, full: 2500, whole: true });
  const months = [11, 12].map(month => ({ year: 2026, month }));
  const { dues, differs } = payslipDues({ slips: [slip()], gross, history, annual, months });
  assert.deepStrictEqual([dues['2026-11'].due, dues['2026-11'].source, dues['2026-12'].due, dues['2026-12'].source], [2010.44, 'payslip', 2010.24, 'worked']);
  assert.deepStrictEqual(dues['2026-12'].figures, { gross: 2500, tax: 290.4, ni: 116.16, student_loan: 4, postgrad_loan: 0, pension: 79.2 });
  assert.strictEqual(differs, null);

  // The payslip pays a different monthly amount from the salary on record, and no pay change is recorded: the payslip wins, and says so
  const other = payslipDues({ slips: [slip()], gross: trackerGross({ history, annual: 31200, startDate: '2024-03-01', endDate: null, years: [2026] }), history, annual: 31200, months });
  assert.strictEqual(other.dues['2026-12'].figures.gross, 2500);
  assert.deepStrictEqual(other.differs, { payslip: 2500, tracker: 2600, year: 2026, month: 11 });

  // A pay rise recorded from December: December is worked out on the new pay
  const rise = [{ id: 1, effective_from: '2024-03-01', annual_salary: 30000 }, { id: 2, effective_from: '2026-12-01', annual_salary: 36000 }];
  const risen = payslipDues({ slips: [slip()], gross: trackerGross({ history: rise, annual: 36000, startDate: '2024-03-01', endDate: null, years: [2026] }), history: rise, annual: 36000, months });
  assert.strictEqual(risen.dues['2026-12'].figures.gross, 3000);
  assert.strictEqual(risen.differs, null);

  // A month marked "nothing owed" went through payroll as nothing
  const skipped = payslipDues({ slips: [slip()], gross: trackerGross({ history, annual, startDate: '2024-03-01', endDate: null, years: [2026, 2027] }), history, annual,
    months: [{ year: 2026, month: 12 }, { year: 2027, month: 1 }], none: ['2026-12'] });
  assert.strictEqual(skipped.dues['2026-12'], undefined);
  // (January then has two months of tax-free pay to set against one month's pay: 80.80 of tax, not 290.40)
  assert.strictEqual(skipped.dues['2027-01'].figures.tax, 80.8);

  // A payslip the calculator cannot reproduce still gives a figure, marked as an estimate
  const odd = payslipDues({ slips: [slip({ payment: 1950.44 })], gross, history, annual, months });
  assert.deepStrictEqual([odd.dues['2026-11'].source, odd.dues['2026-12'].source], ['payslip', 'rough']);
  assert.deepStrictEqual(payslipDues({ slips: [], gross, history, annual, months }), { dues: {}, differs: null });

  // A part month is paid by the working day at a 260th of the salary: 26,000 a year, starting Thursday 15 October 2026 (12 working days)
  const part = trackerGross({ history: [], annual: 26000, startDate: '2026-10-15', endDate: null, years: [2026] });
  assert.deepStrictEqual(part['2026-10'], { gross: 1200, full: 2166.67, whole: false });
  assert.deepStrictEqual(part['2026-11'], { gross: 2166.67, full: 2166.67, whole: true });
  assert.strictEqual(part['2026-09'], undefined);
  // ...never more than the whole month
  assert.strictEqual(trackerGross({ history: [], annual: 26000, startDate: '2026-12-02', endDate: null, years: [2026] })['2026-12'].gross, 2166.67);
}

// ── Self-employed: the year as a running balance ──
{
  const months = [1, 2, 3, 4, 5, 6].map(month => ({ month, due: 8000, whole: true }));
  const pay = (payment_month, amount) => ({ payment_month, amount });
  // January's payment covered four months
  const ahead = contractorMonths({ months, payments: [pay(1, 32000), pay(5, 8000)] });
  assert.deepStrictEqual(ahead.map(r => r.status), ['paid', 'paid', 'paid', 'paid', 'paid', 'due']);
  assert.deepStrictEqual(ahead.map(r => r.covered), [false, true, true, true, false, false]);
  assert.strictEqual(ahead[5].left, 8000);
  // Part of a month already paid ahead
  const partly = contractorMonths({ months, payments: [pay(1, 12000)] });
  assert.deepStrictEqual([partly[1].paid, partly[1].left, partly[2].left], [false, 4000, 8000]);
  // Set aside: still owed, or nothing owed
  const aside = contractorMonths({ months, payments: [pay(1, 8000)], skips: { 2: 'later', 3: 'none' } });
  assert.deepStrictEqual(aside.map(r => r.status), ['paid', 'later', 'none', 'due', 'due', 'due']);
  assert.deepStrictEqual([aside[1].left, aside[2].left, aside[2].due, aside[3].left], [8000, 0, 0, 8000]);
  // A deduction taken off a payment does not leave the month looking unpaid
  const off = contractorMonths({ months: months.slice(0, 2), payments: [pay(1, 7800)], deductions: { 1: 200 } });
  assert.deepStrictEqual([off[0].paid, off[0].deduction, off[1].left], [true, 200, 8000]);
  assert.deepStrictEqual(contractorMonths({ months: [], payments: [] }), []);
}

console.log('pay calculator tests passed');

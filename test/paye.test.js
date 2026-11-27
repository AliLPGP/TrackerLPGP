'use strict';
// The month-by-month pay calculator, checked against HMRC's own published test data for
// payroll software (2026 to 2027, the monthly rows: England and Northern Ireland, Wales
// and Scotland), HMRC's worked examples, and made-up payslips.
const assert = require('assert');
const P = require('../paye');
const { trackerGross, payslipDues, contractorMonths, contractorYear } = require('../pay-months');

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
assert.strictEqual(P.studentLoan(3200, ['2'], 2026) + P.postgradLoan(3200, 2026), 154, 'a plan and a postgraduate loan: two separate deductions');
assert.strictEqual(P.studentLoan(3200, ['2'], 2025), 74, 'the year before had a lower threshold');
assert.strictEqual(P.studentLoan(2500, ['5'], 2025), 0, 'Plan 5 deductions only began in April 2026');
// HMRC's own penny-boundary cases (2026 to 2027, Plan 2, monthly)
for (const [pay, loan] of [[2459.86, 0], [2459.87, 1], [2459.97, 1], [2493.2, 4], [2948.86, 45], [5137.64, 242], [8793.2, 571]]) {
  assert.strictEqual(P.studentLoan(pay, ['2'], 2026), loan, `Plan 2 on ${pay}`);
}

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

  // Pay the caller is only guessing at is never passed on as exact; and a payslip the
  // calculator cannot arrive at is marked, so the caller can go by what was paid instead
  const guess = P.payFromPayslips({ slips: [s], grossFor: () => ({ gross: 2500, basic: 2500, sure: false }), months: [{ year: 2026, month: 12 }] })['2026-12'];
  assert.deepStrictEqual([guess.payment, guess.exact, guess.explained], [2010.24, false, true]);
  const unexplained = P.payFromPayslips({ slips: [slip({ payment: 1950.44 })], grossFor, months: [{ year: 2026, month: 11 }, { year: 2026, month: 12 }, { year: 2027, month: 4 }, { year: 2026, month: 10 }] });
  assert.deepStrictEqual(['2026-11', '2026-12', '2027-04', '2026-10'].map(k => unexplained[k].explained), [true, false, false, false]);

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
  assert.deepStrictEqual(other.differs, { payslip: 2500, tracker: 2600, year: 2026, month: 11, used: 'payslip' });

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

  // A payslip the calculator cannot arrive at (something on it is not understood: here 60.00
  // more came off than the lines explain) keeps its own figure, but no later month is worked
  // out from it. Working forward would leave the 60.00 out every month, so those months are
  // left to the usual amount paid.
  const odd = payslipDues({ slips: [slip({ payment: 1950.44 })], gross, history, annual, months });
  assert.strictEqual(odd.dues['2026-11'].source, 'payslip');
  assert.strictEqual(odd.dues['2026-12'], undefined);
  assert.deepStrictEqual(payslipDues({ slips: [], gross, history, annual, months }), { dues: {}, differs: null, behind: null });

  // ── What a regular month pays: the salary on record, or the payslips? ──
  // A made-up payslip the calculator arrives at by construction, for someone on the same
  // settings as slip() who has had 2,500.00 every month of the tax year before it
  const made = (year, month, over = {}) => {
    const settings = P.settingsFrom(slip()), grossPay = over.gross != null ? over.gross : 2500, basic = over.basic != null ? over.basic : grossPay;
    const monthsBefore = P.taxMonthOf(month) - 1, payBefore = 2500 * monthsBefore;
    const taxBefore = monthsBefore ? P.taxToDate('1257L', payBefore, monthsBefore, P.taxYearOf(year, month)) : 0;
    const f = P.monthFigures({ settings, year, month, gross: grossPay, basic, payBefore, taxBefore });
    const made = slip({ period: { year, month, end: null }, basic, gross: grossPay, taxable_gross: f.taxable, tax: f.tax, ni: f.ni, student_loan: f.student_loan || null, pension: f.pension || null,
      payment: f.payment, ytd: { gross: payBefore + f.taxable, tax: Math.round((taxBefore + f.tax) * 100) / 100 },
      additions: [{ label: 'Monthly pay', amount: basic, kind: 'basic' }, ...(over.extras || []).map(([label, amount]) => ({ label, amount, kind: 'extra' }))] });
    assert.strictEqual(P.reproduces(made), true, `the made-up payslip for ${month}/${year} is one the calculator arrives at`);
    return made;
  };
  const due = (res, key) => [res.dues[key].figures.gross, res.dues[key].source];
  const grossAt = (salary, hist = []) => trackerGross({ history: hist, annual: salary, startDate: '2024-03-01', endDate: null, years: [2026, 2027] });

  // One payslip against the salary on record is believed, but only as an estimate. Two
  // running that agree with each other are believed outright.
  assert.deepStrictEqual(due(other, '2026-12'), [2500, 'rough']);
  const twoAgree = payslipDues({ slips: [made(2026, 10), made(2026, 11)], gross: grossAt(31200), history, annual: 31200, months });
  assert.deepStrictEqual(due(twoAgree, '2026-12'), [2500, 'worked']);
  assert.deepStrictEqual(twoAgree.differs, { payslip: 2500, tracker: 2600, year: 2026, month: 11, used: 'payslip' });

  // A rise entered after October's payslip and dated back to 1 October: that payslip is
  // still at the old pay, so the salary on record speaks for the months after it. An
  // estimate, because the next payslip will carry the arrears as well.
  const backdated = [{ id: 1, effective_from: '2024-03-01', annual_salary: 30000 }, { id: 2, effective_from: '2026-10-01', annual_salary: 36000 }];
  const late = payslipDues({ slips: [made(2026, 9), made(2026, 10)], gross: grossAt(36000, backdated), history: backdated, annual: 36000, months });
  assert.deepStrictEqual([due(late, '2026-11'), due(late, '2026-12'), late.differs], [[3000, 'rough'], [3000, 'rough'], null]);
  // ...and October's payslip is said to be behind: 500.00 before tax is still owed for it
  assert.deepStrictEqual(late.behind, { payslip: 2500, tracker: 3000, year: 2026, month: 10 });
  assert.strictEqual(twoAgree.behind, null);

  // One odd month (two unpaid days in September) among ordinary ones is not the new pay
  const oddMonth = payslipDues({ slips: [made(2026, 8), made(2026, 9, { gross: 2269.23 })], gross: grossAt(30000), history, annual,
    months: [{ year: 2026, month: 10 }] });
  assert.deepStrictEqual([due(oddMonth, '2026-10'), oddMonth.differs], [[2500, 'rough'], { payslip: 2269.23, tracker: 2500, year: 2026, month: 9, used: 'record' }]);
  // (it may instead be a change of pay nobody has put on record: the page says the two
  // disagree, and a second payslip at the new amount settles it)
  const unrecorded = payslipDues({ slips: [made(2026, 8), made(2026, 9, { gross: 2800 }), made(2026, 10, { gross: 2800 })], gross: grossAt(30000), history, annual, months });
  assert.deepStrictEqual([due(unrecorded, '2026-11'), unrecorded.differs.used], [[2800, 'worked'], 'payslip']);

  // An allowance on the last two payslips running comes every month; a bonus on the
  // latest one only is a one-off; and one payslip cannot say which it is
  const car = [['Car allowance', 300]];
  const allowance = payslipDues({ slips: [made(2026, 10, { gross: 2800, basic: 2500, extras: car }), made(2026, 11, { gross: 2800, basic: 2500, extras: car })], gross: grossAt(30000), history, annual, months });
  assert.deepStrictEqual([due(allowance, '2026-12'), allowance.differs, allowance.dues['2026-11'].regular], [[2800, 'worked'], null, true]);
  // (the salary on record may already have the allowance in it: then it is not added twice)
  const counted = payslipDues({ slips: [made(2026, 10, { gross: 2800, basic: 2500, extras: car }), made(2026, 11, { gross: 2800, basic: 2500, extras: car })], gross: grossAt(33600), history, annual: 33600, months });
  assert.deepStrictEqual([due(counted, '2026-12'), counted.differs], [[2800, 'worked'], null]);
  const bonus = payslipDues({ slips: [made(2026, 10), made(2026, 11, { gross: 3500, basic: 2500, extras: [['Bonus', 1000]] })], gross: grossAt(30000), history, annual, months });
  assert.deepStrictEqual([due(bonus, '2026-12'), bonus.dues['2026-11'].regular, bonus.dues['2026-12'].regular], [[2500, 'worked'], false, true]);
  const lone = payslipDues({ slips: [made(2026, 11, { gross: 3500, basic: 2500, extras: [['Bonus', 1000]] })], gross: grossAt(30000), history, annual, months });
  assert.deepStrictEqual(due(lone, '2026-12'), [2500, 'rough']);

  // A tax year this file has no tables for yet: the first month is an estimate, but once a
  // payslip from that year comes out right on the latest tables the months after it are exact
  const beyond = P.LATEST_YEAR + 1;
  const newYear = payslipDues({ slips: [made(beyond, 5)], gross: trackerGross({ history, annual, startDate: '2024-03-01', endDate: null, years: [beyond] }), history, annual,
    months: [{ year: beyond, month: 6 }, { year: beyond, month: 7 }] });
  assert.strictEqual(P.hasTables(beyond), false);
  assert.deepStrictEqual([newYear.dues[`${beyond}-06`].source, newYear.dues[`${beyond}-07`].source], ['worked', 'worked']);

  // A part month is paid by the working day at a 260th of the salary: 26,000 a year, starting Thursday 15 October 2026 (12 working days)
  const part = trackerGross({ history: [], annual: 26000, startDate: '2026-10-15', endDate: null, years: [2026] });
  assert.deepStrictEqual(part['2026-10'], { gross: 1200, full: 2166.67, whole: false });
  assert.deepStrictEqual(part['2026-11'], { gross: 2166.67, full: 2166.67, whole: true });
  assert.strictEqual(part['2026-09'], undefined);
  // ...never more than the whole month
  assert.strictEqual(trackerGross({ history: [], annual: 26000, startDate: '2026-12-02', endDate: null, years: [2026] })['2026-12'].gross, 2166.67);
  // With every working day of the month worked it is a whole month's pay: starting Monday
  // 2 November 2026 (the 1st is a Sunday), leaving Friday 29 May 2026 (the 30th and 31st are a weekend)
  assert.deepStrictEqual(trackerGross({ history: [], annual: 30000, startDate: '2026-11-02', endDate: null, years: [2026] })['2026-11'], { gross: 2500, full: 2500, whole: false });
  assert.strictEqual(trackerGross({ history: [], annual: 30000, startDate: '2024-03-01', endDate: '2026-05-29', years: [2026] })['2026-05'].gross, 2500);
  // How the payroll software prices a part month is not known for certain, so a month the
  // person leaves in is only ever an estimate: leaving Friday 18 December 2026 (14 working days)
  const leaving = payslipDues({ slips: [slip()], gross: trackerGross({ history: [], annual: 30000, startDate: '2024-03-01', endDate: '2026-12-18', years: [2026] }), history: [], annual: 30000,
    months: [{ year: 2026, month: 12 }] });
  assert.deepStrictEqual([leaving.dues['2026-12'].figures.gross, leaving.dues['2026-12'].source], [1615.38, 'rough']);
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
  // A payment pays the oldest month still owing first: 24,000 a year and 6,000 paid in April
  // pays January to March, and April is still to pay; 7,000 leaves 1,000 of April to pay
  const year2k = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, due: 2000, whole: true }));
  const april = contractorYear({ months: year2k, payments: [pay(4, 6000)] });
  assert.deepStrictEqual([april.months.slice(0, 5).map(r => r.status), april.months[3].left, april.remaining], [['paid', 'paid', 'paid', 'due', 'due'], 2000, 18000]);
  assert.deepStrictEqual([april.months[0].made_up_in, april.months[3].back, april.months[3].back_to, april.months[3].applied], [[4], 6000, [1, 2, 3], 0]);
  const april7 = contractorYear({ months: year2k, payments: [pay(4, 7000)] });
  assert.deepStrictEqual([april7.months[3].status, april7.months[3].left, april7.months[3].applied, april7.remaining], ['short', 1000, 1000, 17000]);
  // A missed month made up with a double payment the month after is settled
  const madeUp = contractorMonths({ months, payments: [pay(1, 8000), pay(2, 8000), pay(3, 8000), pay(5, 16000)] });
  assert.deepStrictEqual(madeUp.map(r => r.status), ['paid', 'paid', 'paid', 'paid', 'paid', 'due']);
  assert.strictEqual(madeUp[3].covered, true);
  // ...and a month missed and never made up leaves the latest month to pay, each payment
  // having gone to the oldest month owing (paid a month in arrears)
  const missed = contractorMonths({ months, payments: [pay(1, 8000), pay(3, 8000), pay(4, 8000), pay(5, 8000)] });
  assert.deepStrictEqual(missed.map(r => r.status), ['paid', 'paid', 'paid', 'paid', 'due', 'due']);
  assert.deepStrictEqual([missed[1].covered, missed[1].made_up_in, missed[4].left], [true, [3], 8000]);
  // Part of a month already paid ahead
  const partly = contractorMonths({ months, payments: [pay(1, 12000)] });
  assert.deepStrictEqual([partly[1].paid, partly[1].left, partly[2].left], [false, 4000, 8000]);
  // Set aside: still owed, or nothing owed
  const aside = contractorMonths({ months, payments: [pay(1, 8000)], skips: { 2: 'later', 3: 'none' } });
  assert.deepStrictEqual(aside.map(r => r.status), ['paid', 'later', 'none', 'due', 'due', 'due']);
  assert.deepStrictEqual([aside[1].left, aside[2].left, aside[2].due, aside[3].left], [8000, 0, 0, 8000]);
  // A deduction taken off a payment does not leave the month looking unpaid
  const off = contractorMonths({ months: months.slice(0, 2), payments: [pay(1, 7800)], deductions: { 1: 200 } });
  assert.deepStrictEqual([off[0].paid, off[0].status, off[0].deduction, off[1].left], [true, 'paid', 200, 8000]);
  assert.strictEqual(off[0].taken, 200);
  // An unpaid month's figure is what to send: its pay less its deduction
  const unpaidOff = contractorMonths({ months: months.slice(0, 2), payments: [], deductions: { 1: 200 } });
  assert.deepStrictEqual([unpaidOff[0].left, unpaidOff[0].taken, unpaidOff[0].status, unpaidOff[1].left], [7800, 200, 'due', 8000]);
  assert.deepStrictEqual(contractorMonths({ months: [], payments: [] }), []);

  // Paid in part: the next payment makes that month up first, and the shortfall moves on to
  // the latest month, which is what is still owed
  const partPaid = contractorMonths({ months, payments: [pay(1, 8000), pay(2, 3000), pay(3, 8000)] });
  assert.deepStrictEqual(partPaid.map(r => r.status), ['paid', 'paid', 'short', 'due', 'due', 'due']);
  assert.deepStrictEqual([partPaid[1].made_up, partPaid[2].short, partPaid[2].left, partPaid[2].applied], [5000, 5000, 5000, 3000]);
  // ...made up the month after: settled
  assert.deepStrictEqual(contractorMonths({ months, payments: [pay(1, 8000), pay(2, 3000), pay(3, 13000)] }).map(r => r.status).slice(0, 3), ['paid', 'paid', 'paid']);
  // ...made up in part: the latest month is short by the rest
  assert.strictEqual(contractorMonths({ months, payments: [pay(1, 8000), pay(2, 3000), pay(3, 10000)] })[2].short, 3000);
  // A later payment pays a missed month first, and its own month is owed what is left
  const partWay = contractorMonths({ months, payments: [pay(1, 8000), pay(3, 12000)] });
  assert.deepStrictEqual([partWay[1].status, partWay[1].covered, partWay[2].status, partWay[2].left], ['paid', true, 'short', 4000]);
  // Paid ahead, then a smaller payment: nothing is short (the advance makes up the month), and what is left of the advance goes to the next
  const aheadThenLess = contractorMonths({ months, payments: [pay(1, 16000), pay(2, 3000)] });
  assert.deepStrictEqual([aheadThenLess[1].status, aheadThenLess[1].short, aheadThenLess[2].status, aheadThenLess[2].left], ['paid', 0, 'due', 5000]);
  // What is owing across the months is never more than the year is behind by
  for (const paid of [[pay(2, 3000), pay(4, 12000)], [pay(1, 500), pay(2, 500), pay(6, 20000)], [pay(3, 30000)], [pay(1, 8000), pay(2, 8000), pay(3, 8000), pay(4, 8000), pay(5, 8000), pay(6, 8000)]]) {
    const total = paid.reduce((a, x) => a + x.amount, 0), rowsNow = contractorMonths({ months, payments: paid });
    assert.strictEqual(rowsNow.reduce((a, r) => a + r.left, 0), Math.max(0, 48000 - total), JSON.stringify(paid));
  }
  // Someone who left in March, paid for March in April: March is settled
  const leaver = contractorMonths({ months: months.slice(0, 3), payments: [pay(1, 8000), pay(2, 8000), pay(4, 8000)] });
  assert.deepStrictEqual([leaver.map(r => r.status), leaver[2].covered], [['paid', 'paid', 'paid'], true]);
  // A payment logged in a month that went entirely to older months leaves that month to pay, not "part paid"
  const allBack = contractorMonths({ months, payments: [pay(2, 8000)] });
  assert.deepStrictEqual([allBack[0].status, allBack[1].status, allBack[1].applied, allBack[1].left], ['paid', 'due', 0, 8000]);
  // Pay logged by hand is seldom to the penny: a month within half a percent of its pay is
  // settled (a bank fee, a rounded figure), and the difference goes on to the next month.
  // Nothing is dropped: 23,920 paid against 24,000 leaves March 80 short.
  const fee = contractorMonths({ months, payments: [pay(1, 7990), pay(2, 8030), pay(3, 7900)] });
  assert.deepStrictEqual(fee.map(r => r.status).slice(0, 4), ['paid', 'paid', 'short', 'due']);
  assert.deepStrictEqual([fee[0].passed, fee[1].brought, fee[1].brought_from, fee[1].ahead, fee[2].short, fee[3].left], [10, 10, [1], 20, 80, 8000]);
  // Pay in advance says which month it was paid in, on the months it covers and on its own row
  const named = contractorMonths({ months, payments: [pay(2, 20000)] });
  assert.deepStrictEqual([named[0].status, named[1].ahead, named[2].from, named[2].covered, named[3].from, named[3].left], ['paid', 4000, [2], false, [], 8000]);
  assert.deepStrictEqual([named[0].made_up, named[0].made_up_in, named[2].advance], [8000, [2], 4000], 'January was made up in February');
  assert.deepStrictEqual([named[2].status, named[2].left], ['due', 4000], 'March: half already paid in February');
  const whole = contractorMonths({ months, payments: [pay(1, 24000)] });
  assert.deepStrictEqual([whole[0].ahead, whole[1].covered, whole[1].from, whole[2].covered, whole[3].status], [16000, true, [1], true, 'due']);

  // Paid before they started (an advance on January, logged in last... a month they were not working in)
  const early = contractorMonths({ months: months.slice(2), payments: [pay(2, 8000)] });
  assert.deepStrictEqual([early[0].status, early[0].covered, early[1].status], ['paid', true, 'due']);

  // A month's own payment counts for that month first, and the advance only makes up the rest
  const ownFirst = contractorMonths({ months, payments: [pay(1, 16000), pay(2, 8000)] });
  assert.deepStrictEqual([ownFirst[1].advance, ownFirst[1].from, ownFirst[2].covered, ownFirst[2].from, ownFirst[3].left], [0, [], true, [1], 8000]);
}

// ── Self-employed: a deduction counts as money paid does, and the months agree with the year ──
// What must hold for any year, whatever was paid and deducted
function checkAccount(y, say) {
  const p2 = v => Math.round(v * 100) / 100;
  const tolerance = Math.max(1, p2(y.months.reduce((a, r) => Math.max(a, r.due), 0) * 0.005));
  assert.ok(y.rounding >= 0 && y.rounding <= tolerance + 0.005, `let go ${y.rounding}, more than ${tolerance}: ` + say);
  assert.strictEqual(y.left, p2(y.months.reduce((a, r) => a + r.left, 0)), say);
  assert.strictEqual(y.remaining, p2(y.left - y.credit), say);
  assert.ok(!(y.left > 0 && y.credit > 0), 'nothing is carried past a month still owing: ' + say);
  // Every small shortfall passed on was either asked for by a later month or let go at the end
  assert.strictEqual(p2(y.months.reduce((a, r) => a + r.passed - r.brought, 0)) || 0, y.rounding, 'passed on, less brought in, is what was let go: ' + say);
  for (const r of y.months) {
    // Every month's pay (and any small shortfall asked for with it) is accounted for: its own
    // payment, its deduction, what was carried forward, what came later, what went on to the
    // next month, and what is left
    // (`applied`: what of the month's own payment was left for it after older months)
    const asked = p2(r.due + r.brought), own = r.applied;
    assert.ok(own <= Math.min(r.logged, asked) + 0.005, say);
    assert.ok(r.left >= 0 && r.left <= asked + 0.005 && r.taken <= r.deduction + 0.005 && r.advance >= 0 && r.made_up >= 0 && r.passed >= 0 && r.back >= 0 && r.ahead >= 0, say);
    assert.ok(Math.abs(own + r.taken + r.advance + r.made_up + r.passed + r.left - asked) < 0.006, `month ${r.month} does not add up: ` + say);
    assert.ok(r.passed <= tolerance + 0.005, say);
    assert.ok(r.left === 0 || r.left > tolerance, `month ${r.month} is left owing a sum small enough to be settled: ` + say);
    assert.strictEqual(r.status === 'short', r.applied > 0 && r.left > 0, say);
    assert.strictEqual(r.short, r.status === 'short' ? r.left : 0, say);
    if (r.status === 'none') assert.deepStrictEqual([r.left, r.paid], [0, false], say);
    if (r.covered) assert.ok(!(r.applied > 0) && r.left === 0, say);
  }
}
{
  const year = (due = 4000) => Array.from({ length: 12 }, (_, i) => ({ month: i + 1, due, whole: true }));
  const pays = amounts => amounts.map((amount, i) => ({ payment_month: i + 1, amount })).filter(p => p.amount > 0);
  // Paid unevenly all year, with a deduction of three and a half months' pay in July (an
  // advance being paid back). 48,000 for the year, less 14,000, less the 33,000 paid: only
  // 1,000 is left, and it is December's. No month in between is short.
  const uneven = contractorYear({ months: year(), payments: pays([4000, 3350, 4500, 1200, 2000, 9000, 650, 1700, 4000, 1550, 1050]), deductions: { 7: 14000 } });
  assert.deepStrictEqual(uneven.months.map(r => r.status), [...Array(11).fill('paid'), 'due']);
  assert.deepStrictEqual(uneven.months.map(r => r.short), Array(12).fill(0));
  assert.deepStrictEqual([uneven.months[11].left, uneven.left, uneven.credit, uneven.remaining], [1000, 1000, 0, 1000]);
  // Where the account stood month by month: behind until June caught up, ahead from July
  assert.deepStrictEqual(uneven.months.map(r => r.balance), [0, -650, -150, -2950, -4950, 50, 10700, 8400, 8400, 5950, 3000, -1000]);
  // Each payment made up the oldest month still owing first: March's made up February,
  // April's March, May's April, and June's April and May; June's extra was carried forward
  assert.deepStrictEqual([uneven.months[1].made_up, uneven.months[1].made_up_in, uneven.months[3].made_up_in, uneven.months[5].ahead], [650, [3], [5, 6], 50]);
  assert.deepStrictEqual([uneven.months[2].back, uneven.months[2].back_to, uneven.months[5].back, uneven.months[5].back_to], [650, [2], 4950, [4, 5]]);
  // July: its 650 and 3,350 of the deduction settle it, and the rest of the deduction is carried forward
  assert.deepStrictEqual([uneven.months[6].taken, uneven.months[6].ahead, uneven.months[6].deduction], [3350, 10650, 14000]);
  // October: 1,550 paid, the other 2,450 from what July carried forward
  assert.deepStrictEqual([uneven.months[9].advance, uneven.months[9].from, uneven.months[11].advance, uneven.months[11].from], [2450, [7], 3000, [7]]);

  // A deduction bigger than its month and nothing paid since: it covers the months after it
  const big = contractorYear({ months: year().slice(0, 6), payments: pays([4000]), deductions: { 2: 10000 } });
  assert.deepStrictEqual(big.months.map(r => [r.status, r.left, r.covered]), [['paid', 0, false], ['paid', 0, true], ['paid', 0, true], ['due', 2000, false], ['due', 4000, false], ['due', 4000, false]]);
  assert.deepStrictEqual([big.months[1].taken, big.months[1].ahead, big.months[2].from, big.remaining], [4000, 6000, [2], 10000]);
  // ...and goes to an older month still owing before it is carried forward
  const older = contractorYear({ months: year().slice(0, 4), payments: pays([1000, 4000]), deductions: { 2: 5000 } });
  assert.deepStrictEqual([older.months[0].status, older.months[0].made_up, older.months[0].made_up_in, older.months[1].ahead, older.months[2].left, older.remaining], ['paid', 3000, [2], 2000, 2000, 6000]);
  // A small deduction left over is a figure put on record, not a rounding difference: it is carried on
  const small = contractorYear({ months: year().slice(0, 2), payments: pays([4000]), deductions: { 1: 10 } });
  assert.deepStrictEqual([small.months[0].ahead, small.months[1].left, small.remaining], [10, 3990, 3990]);
  // ...and so is a few pounds of money over: nothing is dropped on the way
  assert.deepStrictEqual(contractorYear({ months: year().slice(0, 2), payments: pays([4010]) }).months[1].left, 3990);

  // Paid a rounded-up figure every month and squared up in December: level, and nothing short
  const roundUp = contractorYear({ months: year(2083.33), payments: pays([...Array(11).fill(2090), 2009.96]) });
  assert.deepStrictEqual([roundUp.remaining, roundUp.credit, roundUp.rounding, roundUp.months.map(r => r.status).join()], [0, 0, 0, Array(12).fill('paid').join()]);
  assert.deepStrictEqual(contractorYear({ months: year(1000), payments: pays([...Array(11).fill(1005), 945]) }).remaining, 0);
  // ...and before December is paid, it asks for what squares the year
  assert.strictEqual(contractorYear({ months: year(2083.33), payments: pays(Array(11).fill(2090)) }).months[11].left, 2009.96);
  // A little over every month adds up, and shows: 14.99 a month on 3,000 is 179.88 over the year
  const steadyOver = contractorYear({ months: year(3000), payments: pays(Array(12).fill(3014.99)) });
  assert.deepStrictEqual([steadyOver.remaining, steadyOver.credit, steadyOver.months[11].balance], [-179.88, 179.88, 179.88]);
  // A rounded-down figure every month, topped up in December: level too
  const roundDown = contractorYear({ months: year(2083.33), payments: pays([...Array(11).fill(2080), 2119.96]) });
  assert.deepStrictEqual([roundDown.remaining, roundDown.rounding, roundDown.months.every(r => r.status === 'paid')], [0, 0, true]);
  // A little under every month is not written off: each payment makes up the month before
  // first, so what is owed moves on to the latest month (12 short a month on 2,500: 144 on December)
  const steadyUnder = contractorYear({ months: year(2500), payments: pays(Array(12).fill(2488)) });
  assert.deepStrictEqual([steadyUnder.remaining, steadyUnder.rounding, steadyUnder.months.map(r => r.short).join()], [144, 0, [...Array(11).fill(0), 144].join()]);
  // Round pounds on a pay that does not divide (2,083 on 2,083.33): no month is short, the
  // pence roll on, and the 3.96 still waiting at the end of the year is let go
  const pence = contractorYear({ months: year(2083.33), payments: pays(Array(12).fill(2083)) });
  assert.deepStrictEqual([pence.remaining, pence.rounding, pence.months.every(r => r.status === 'paid'), pence.months[11].brought], [0, 3.96, true, 3.63]);
  // ...and while a month is still to pay, it asks for the pence with its own pay
  const penceSoFar = contractorYear({ months: year(2083.33), payments: pays(Array(10).fill(2083)) });
  assert.deepStrictEqual([penceSoFar.months[10].left, penceSoFar.months[10].brought, penceSoFar.months[11].left, penceSoFar.remaining], [2086.63, 3.3, 2083.33, 4169.96]);
  // The pence wait through a month marked nothing owed for the next month with pay of its own
  const through = contractorYear({ months: year(2083.33).slice(0, 3), payments: pays([2080]), skips: { 2: 'none' } });
  assert.deepStrictEqual(through.months.map(r => [r.status, r.left, r.brought_from.join()]), [['paid', 0, ''], ['none', 0, ''], ['due', 2086.66, '1']]);
  // Two months paid at once in round pounds come out the same paid behind as paid ahead: the
  // pence left on the month that was made up go on like any others, and no month reads unpaid
  const rest = Array(10).fill(2083.33);
  const behind = contractorYear({ months: year(2083.33), payments: pays([0, 4166, ...rest]) });
  const aheadOf = contractorYear({ months: year(2083.33), payments: pays([4166, 0, ...rest]) });
  assert.deepStrictEqual([behind.remaining, behind.rounding, behind.months[0].status, behind.months[0].covered, behind.months[0].left, behind.months[1].passed], [0, 0.66, 'paid', true, 0, 0.66]);
  assert.deepStrictEqual([aheadOf.remaining, aheadOf.rounding, aheadOf.months[1].status, aheadOf.months[1].passed], [0, 0.66, 'paid', 0.66]);
  // ...nor short, when part of it was paid in its own month
  const partThen = contractorYear({ months: year(2083.33), payments: pays([1000, 3166, ...rest]) });
  assert.deepStrictEqual([partThen.months[0].status, partThen.months[0].short, partThen.remaining, partThen.rounding], ['paid', 0, 0, 0.66]);
  // ...and the same in pesos: 99,990 in February for January and February
  const pesos = contractorYear({ months: year(50000), payments: pays([0, 99990, ...Array(10).fill(50000)]) });
  assert.deepStrictEqual([pesos.months[0].status, pesos.months[0].left, pesos.remaining, pesos.rounding], ['paid', 0, 0, 10]);
  // What is let go at the end is never more than half a percent of a month: any more is owed,
  // on the last month (each payment made up the month before: February 4 short, March 3 short)
  const two = contractorYear({ months: year(1000).slice(0, 3), payments: pays([0, 1000, 996, 997]) });
  assert.deepStrictEqual([two.rounding, two.remaining, two.months[0].status, two.months[2].status, two.months[2].left, two.months[2].brought, two.months[2].brought_from, two.months[2].passed], [0, 7, 'paid', 'due', 7, 4, [2], 0]);
  // A leaver's last month paid 5 under and topped up the month after: June was made up in
  // July, nothing is let go, and nothing is left
  const topped = contractorYear({ months: year(2000).slice(0, 6), payments: pays([2000, 2000, 2000, 2000, 2000, 1995, 5]) });
  assert.deepStrictEqual([topped.months[5].status, topped.months[5].passed, topped.months[5].made_up, topped.months[5].made_up_in, topped.rounding, topped.remaining], ['paid', 0, 5, [7], 0, 0]);
  // ...and a few pence deducted after the only month counts towards what that month was under
  const oneMonth = contractorYear({ months: [{ month: 5, due: 1430.95, whole: true }], payments: [{ payment_month: 5, amount: 353.5 }, { payment_month: 5, amount: 359.75 }, { payment_month: 5, amount: 357.74 }], deductions: { 4: 357.74, 9: 0.82 } });
  assert.deepStrictEqual([oneMonth.months[0].passed, oneMonth.months[0].made_up, oneMonth.months[0].made_up_in, oneMonth.rounding, oneMonth.remaining], [1.4, 0.82, [9], 1.4, 0]);
  // A part month passes on what a whole month handed it (half a percent of a whole month's pay, not of its own)
  const partMonth = contractorYear({ months: [...year(2000).slice(0, 2), { month: 3, due: 400, whole: false }], payments: pays([1992, 2000, 400]) });
  assert.deepStrictEqual([partMonth.months.map(r => r.status).join(), partMonth.remaining, partMonth.rounding], ['paid,paid,paid', 0, 8]);
  // A month with no working day of theirs in it (they started on Saturday the 31st) is worth nothing, not unpaid
  const weekend = contractorYear({ months: [{ month: 1, due: 0, whole: false }, { month: 2, due: 2000, whole: true }], payments: [] });
  assert.deepStrictEqual(weekend.months.map(r => [r.status, r.paid, r.left]), [['none', false, 0], ['due', false, 2000]]);

  // Paid more than the year is worth: nothing is left, and the rest is what they are ahead by
  const over = contractorYear({ months: year().slice(0, 3), payments: pays([4000, 4000, 9000]) });
  assert.deepStrictEqual([over.left, over.credit, over.remaining, over.months[2].ahead, over.months[2].balance], [0, 5000, -5000, 5000, 5000]);
  // Deducted before their first month, or after their last: it still counts
  const before = contractorYear({ months: year().slice(2, 5), payments: [], deductions: { 1: 1000 } });
  assert.deepStrictEqual([before.months[0].left, before.months[0].from, before.remaining], [3000, [1], 11000]);
  const after = contractorYear({ months: year().slice(0, 3), payments: pays([4000, 4000]), deductions: { 5: 1500 } });
  assert.deepStrictEqual([after.months[2].left, after.months[2].made_up_in, after.remaining], [2500, [5], 2500]);
  // A month marked nothing owed with a deduction dated in it: the deduction comes off the others
  const noneOff = contractorYear({ months: year().slice(0, 3), payments: [], deductions: { 2: 500 }, skips: { 2: 'none' } });
  assert.deepStrictEqual(noneOff.months.map(r => r.left), [3500, 0, 4000]);
  // Nobody to count months for
  assert.deepStrictEqual(contractorYear({ months: [], payments: pays([500]), deductions: { 3: 100 } }), { months: [], left: 0, credit: 600, remaining: -600, rounding: 0 });

  // Whatever is paid and deducted, in whatever months, the months add up to the year:
  // what is left is the year's pay, less everything paid, less everything deducted.
  // (Round hundreds, so that nothing is small enough to be let go as a rounding difference.)
  let seed = 20261126;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let run = 0; run < 3000; run++) {
    const from = 1 + rand(4), to = 9 + rand(4), months = year().filter(m => m.month >= from && m.month <= to);
    const payments = [], deductions = {}, skips = {};
    for (let m = 1; m <= 12; m++) {
      if (rand(10) < 7) payments.push({ payment_month: m, amount: 100 * (1 + rand(90)) });
      if (rand(10) < 2) payments.push({ payment_month: m, amount: 100 * (1 + rand(40)) });
      if (rand(10) < 3) deductions[m] = 100 * (1 + rand(rand(4) ? 30 : 160));
      if (rand(12) === 0) skips[m] = rand(2) ? 'later' : 'none';
    }
    const y = contractorYear({ months, payments, deductions, skips });
    const worth = y.months.reduce((a, r) => a + r.due, 0), paid = payments.reduce((a, p) => a + p.amount, 0), off = Object.values(deductions).reduce((a, b) => a + b, 0);
    const say = JSON.stringify({ from, to, payments, deductions, skips });
    assert.strictEqual(y.remaining, worth - paid - off, say);
    assert.strictEqual(y.rounding, 0, say);
    checkAccount(y, say);
    // The balance at the end of the last month is the year's figure before anything logged after it
    const tail = Object.keys(deductions).map(Number).concat(payments.map(p => p.payment_month)).some(m => m > to);
    if (!tail && y.months.length) assert.strictEqual(y.months[y.months.length - 1].balance, -y.remaining, say);
    // What months put towards older ones is what those older ones had made up
    const sum = pick => Math.round(y.months.reduce((a, r) => a + pick(r), 0) * 100) / 100;
    if (!tail) assert.strictEqual(sum(r => r.back), sum(r => r.made_up), say);
  }

  // The same with pounds and pence, amounts a little over and a little under a month's pay,
  // and part months: the year is always its pay, less paid, less deducted, less the little
  // let go at the very end, which is never more than half a percent of one month
  for (let run = 0; run < 4000; run++) {
    const pay = [2083.33, 1000, 4166.67, 3333.33, 50000][rand(5)], from = 1 + rand(3), to = 10 + rand(3);
    const months = year(pay).filter(m => m.month >= from && m.month <= to).map((m, i, all) => (i === 0 && rand(3) === 0 ? { ...m, due: Math.round(pay * (1 + rand(20)) / 22 * 100) / 100 } : i === all.length - 1 && rand(4) === 0 ? { ...m, due: 0 } : m));
    const payments = [], deductions = {}, skips = {};
    for (let m = 1; m <= 12; m++) {
      const kind = rand(10);
      if (kind < 5) payments.push({ payment_month: m, amount: Math.round((pay + (rand(4001) - 2000) / 100 * (pay / 2000)) * 100) / 100 });   // within about a percent either way
      else if (kind < 7) payments.push({ payment_month: m, amount: Math.round(pay * (rand(300) + 1)) / 100 });                                  // anything up to three months
      if (rand(10) < 2) deductions[m] = Math.round(pay * (rand(250) + 1)) / 100;
      if (rand(15) === 0) skips[m] = rand(2) ? 'later' : 'none';
    }
    const y = contractorYear({ months, payments, deductions, skips });
    const p2 = v => Math.round(v * 100) / 100, say = JSON.stringify({ months, payments, deductions, skips });
    const worth = y.months.reduce((a, r) => a + r.due, 0), paid = payments.reduce((a, p) => a + p.amount, 0), off = Object.values(deductions).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(y.remaining - p2(worth - paid - off - y.rounding)) < 0.011, `remaining ${y.remaining} against ${p2(worth - paid - off)} less ${y.rounding}: ` + say);
    checkAccount(y, say);
  }
}

console.log('pay calculator tests passed');

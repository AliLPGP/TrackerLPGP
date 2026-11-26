'use strict';
// A month's pay worked out the way payroll software does it, so the tracker's figure for
// "what do I pay them this month" is the figure the accountant's payslip will show.
//
// The old estimate took a year's tax and divided by 12. Real payslips are not worked out
// like that. Income tax is CUMULATIVE: each month the software adds up pay so far this tax
// year, takes off the tax-free pay the tax code allows so far, taxes what is left, and
// subtracts the tax already paid. Someone who joins in October therefore pays no tax for
// months, and a tax code marked "month 1" (W1/M1) is taxed on each month alone. National
// Insurance and student loans are worked out on each month's pay by itself, and a workplace
// pension is a percentage of the pay above a monthly floor. These are HMRC's published
// routines; the figures for each tax year are in YEARS below.
//
// Everything here is a pure function of the figures passed in. The figures themselves (tax
// code, year-to-date pay and tax, pension) come from the latest payslip (payslip-read.js).

const round2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
const floor2 = v => Math.floor(v * 100 + 1e-7) / 100;
const ceil2 = v => Math.ceil(v * 100 - 1e-7) / 100;

// ─── The tax year ────────────────────────────────────────────────────────────
// A tax year runs 6 April to 5 April and is named here by the year it starts in (2026 is
// 2026-27). Tax month 1 is 6 April to 5 May. A month's pay, paid at the end of that month,
// falls in the tax month that starts on the 6th: April's pay is month 1, March's month 12.
const taxMonthOf = month => ((month + 8) % 12) + 1;
const taxYearOf = (year, month) => (month >= 4 ? year : year - 1);
// From the date the money was paid, when a payslip says
function taxPeriodOfDate(iso) {
  const y = Number(String(iso).slice(0, 4)), m = Number(String(iso).slice(5, 7)), d = Number(String(iso).slice(8, 10));
  if (!(y > 0) || !(m >= 1 && m <= 12) || !(d >= 1)) return null;
  let mm = m, yy = y;
  if (d < 6) { mm = m === 1 ? 12 : m - 1; if (m === 1) yy = y - 1; }
  return { taxYear: taxYearOf(yy, mm), taxMonth: taxMonthOf(mm) };
}

// ─── Rates and thresholds, per tax year ──────────────────────────────────────
// From HMRC's "Specification for PAYE Tax Table Routines" (v24.0, February 2026), the
// "Rates and thresholds for employers" pages and the National Insurance guidance for
// software developers. Income tax bands are [width of the band in pounds of taxable pay a
// year, rate in hundredths of a percent]; the last band has no upper limit. The National
// Insurance and pension figures are the published ones for a monthly pay period.
const RUK_BANDS = [[37700, 2000], [87440, 4000], [Infinity, 4500]];
const scot = (starter, basic, intermediate) => [[starter, 1900], [basic, 2000], [intermediate, 2100], [31338, 4200], [62710, 4500], [Infinity, 4800]];
// Employee National Insurance: [rate between the primary threshold and the upper limit,
// rate above it], in hundredths of a percent, by category letter
const NI_EMPLOYEE = {
  A: [800, 200], F: [800, 200], H: [800, 200], M: [800, 200], N: [800, 200], V: [800, 200],
  B: [185, 200], E: [185, 200], I: [185, 200],
  D: [200, 200], J: [200, 200], L: [200, 200], Z: [200, 200],
  C: [0, 0], K: [0, 0], S: [0, 0], X: [0, 0],
};
// Which monthly threshold the employer's contribution starts from, by category letter:
// the ordinary secondary threshold, the freeport and investment-zone one, or the upper
// one for under-21s, apprentices and veterans
const NI_EMPLOYER_FROM = { A: 'secondary', B: 'secondary', C: 'secondary', J: 'secondary',
  D: 'zone', E: 'zone', F: 'zone', I: 'zone', K: 'zone', L: 'zone', N: 'zone', S: 'zone',
  H: 'upper', M: 'upper', V: 'upper', Z: 'upper' };
const YEARS = {
  2024: {
    bands: { ruk: RUK_BANDS, scot: scot(2306, 11685, 17101) },
    ni: { primary: 1048, upper: 4189, secondary: 758, zone: 2083, employer: 1380 },
    loans: { 1: 24990, 2: 27295, 4: 31395, pg: 21000 },
    pension: { lower: 520, upper: 4189 },
  },
  2025: {
    bands: { ruk: RUK_BANDS, scot: scot(2827, 12094, 16171) },
    ni: { primary: 1048, upper: 4189, secondary: 417, zone: 2083, employer: 1500 },
    loans: { 1: 26065, 2: 28470, 4: 32745, pg: 21000 },   // (Plan 5 deductions began in April 2026)
    pension: { lower: 520, upper: 4189 },
  },
  2026: {
    bands: { ruk: RUK_BANDS, scot: scot(3967, 12989, 14136) },
    ni: { primary: 1048, upper: 4189, secondary: 417, zone: 2083, employer: 1500 },
    loans: { 1: 26900, 2: 29385, 4: 33795, 5: 25000, pg: 21000 },
    pension: { lower: 520, upper: 4189 },
  },
};
const LATEST_YEAR = Math.max(...Object.keys(YEARS).map(Number));
const EARLIEST_YEAR = Math.min(...Object.keys(YEARS).map(Number));
// A year this file has no figures for uses the nearest one it has (thresholds are frozen
// for long stretches; the Salary page says when a figure is beyond the published years)
const tables = taxYear => YEARS[Math.min(LATEST_YEAR, Math.max(EARLIEST_YEAR, Number(taxYear) || LATEST_YEAR))];
const hasTables = taxYear => !!YEARS[taxYear];

// ─── Tax codes ───────────────────────────────────────────────────────────────
// "1257L", "S1257L", "C1257L", "K475", "BR", "D0", "D1", "NT", "0T", with or without a
// month-1 marker. Returns null for something that is not a tax code.
function parseTaxCode(raw) {
  let s = String(raw || '').toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  let month1 = false;
  const marker = /(W1M1|W1\/M1|W1|M1|X)$/.exec(s);
  if (marker && s.length > marker[0].length && /\d[A-Z]?$|^(S|C)?(BR|NT|D\d|0T)$/.test(s.slice(0, -marker[0].length))) { month1 = true; s = s.slice(0, -marker[0].length); }
  let region = 'ruk';
  if (/^[SC]/.test(s) && s.length > 1 && /^[SC](\d|K\d|BR$|NT$|D\d$|0T$)/.test(s)) { region = s[0] === 'S' ? 'scot' : 'wales'; s = s.slice(1); }
  if (s === 'NT') return { kind: 'NT', region, month1, number: 0 };
  if (s === 'BR') return { kind: 'BR', region, month1, number: 0 };
  if (/^D\d$/.test(s)) return { kind: 'D', region, month1, number: Number(s[1]) };
  if (s === '0T') return { kind: 'suffix', region, month1, number: 0 };
  let m = /^K(\d{1,5})$/.exec(s);
  if (m) return { kind: 'K', region, month1, number: Number(m[1]) };
  m = /^(\d{1,5})[A-Z]$/.exec(s);
  if (m) return { kind: 'suffix', region, month1, number: Number(m[1]) };
  return null;
}

// HMRC's routine is exact about rounding, and ordinary floating point is not (it loses a
// penny now and then), so the arithmetic below is in whole numbers: pence for money, and
// ten-thousandths of a pound where the routine works to four decimal places.
const pence = pounds => Math.round((Number(pounds) || 0) * 100);

// Tax-free pay for one month from the number in a tax code, in pence (HMRC's pay
// adjustment tables): the code number x 10, plus 9, over 12, rounded UP to the penny.
// The tables only run to 500, so above that the code is split into 500s, each worth
// 416.67 a month. Code 1257 is 1,048.26 a month.
function monthlyAdjustmentPence(number) {
  if (!(number > 0)) return 0;
  const whole = Math.floor((number - 1) / 500), rest = ((number - 1) % 500) + 1;
  return Math.ceil(Math.floor(((rest * 10 + 9) * 10000) / 12) / 100) + whole * 41667;
}
const monthlyAdjustment = number => monthlyAdjustmentPence(number) / 100;

// Tax due to date, in pence, on `taxablePence` of taxable pay when `months` twelfths of
// each band are available. The routine, step for step: taxable pay is rounded DOWN to the
// pound; each band limit for the period is the yearly one x months / 12 to four decimal
// places; the band is chosen by comparing the unrounded pay with the limit rounded UP to
// the pound; the tax is the tax on the bands below plus the rate on the rest, to four
// decimal places, then rounded DOWN to the penny.
function taxOnBandsPence(taxablePence, bands, months) {
  if (taxablePence <= 0) return 0;
  const pounds = Math.floor(taxablePence / 100);
  let widthSoFar = 0, taxSoFar = 0;      // pounds a year; ten-thousandths of a pound a year
  let below = 0, taxBelow = 0;           // the same for this period: where the chosen band starts
  for (const [width, rate] of bands) {
    if (width !== Infinity) {
      const limit = Math.floor(((widthSoFar + width) * 10000 * months) / 12);   // top of this band for the period
      if (taxablePence <= Math.ceil(limit / 10000) * 100) return Math.floor((taxBelow + Math.floor(((pounds * 10000 - below) * rate) / 10000)) / 100);
      widthSoFar += width; taxSoFar += width * rate;
      below = limit; taxBelow = Math.floor((taxSoFar * months) / 12);
    } else return Math.floor((taxBelow + Math.floor(((pounds * 10000 - below) * rate) / 10000)) / 100);
  }
  return 0;
}

/**
 * Tax to date under a tax code, in pounds, for pay to date over `months` tax months.
 * (For a month-1 code pass one month's pay and months = 1.)
 */
function taxToDate(code, payToDate, months, taxYear) {
  const c = typeof code === 'string' ? parseTaxCode(code) : code;
  if (!c || c.kind === 'NT') return 0;
  const t = tables(taxYear), bands = c.region === 'scot' ? t.bands.scot : t.bands.ruk;
  const pay = Math.max(0, pence(payToDate));
  if (c.kind === 'BR' || c.kind === 'D') {
    // Everything at one rate: BR the basic rate, D0 the one above it, D1 the next, and so on
    // (Scotland's basic rate is its second band)
    const basic = c.region === 'scot' ? 1 : 0, at = c.kind === 'BR' ? basic : basic + 1 + c.number;
    const rate = bands[Math.min(at, bands.length - 1)][1];
    return Math.floor((Math.floor(pay / 100) * rate) / 100) / 100;
  }
  const adjust = monthlyAdjustmentPence(c.number) * months;
  return taxOnBandsPence(c.kind === 'K' ? pay + adjust : pay - adjust, bands, months) / 100;
}

/**
 * Tax for one month.
 *   code        the tax code as printed
 *   month1      true for a non-cumulative code (W1/M1): the month is taxed by itself
 *   taxMonth    1 (April) to 12 (March)
 *   pay         taxable pay this month
 *   payBefore   taxable pay earlier in this tax year
 *   taxBefore   tax already paid earlier in this tax year
 * On a cumulative code the answer can be negative: a refund. A month-1 code never refunds.
 * Tax never takes more than half of the month's pay; on a cumulative code anything held
 * back by that is collected in later months.
 */
function taxForMonth({ code, month1, taxMonth, pay, payBefore = 0, taxBefore = 0, taxYear }) {
  const c = typeof code === 'string' ? parseTaxCode(code) : code;
  if (!c) return 0;
  const alone = !!(month1 || c.month1);
  let tax = alone ? pence(taxToDate(c, pay, 1, taxYear)) : pence(taxToDate(c, payBefore + pay, taxMonth, taxYear)) - pence(taxBefore);
  if (tax > 0) tax = Math.min(tax, Math.floor(Math.max(0, pence(pay)) / 2));
  return tax / 100;
}

// ─── National Insurance ──────────────────────────────────────────────────────
// Worked out on each month's pay alone: a rate on the pay between the primary threshold
// and the upper limit, and a lower rate on anything above. HMRC's rounding for payroll
// software: look no further than the third decimal place of the pounds, and round to the
// penny with a 5 there rounded DOWN (so 67.5558 is 67.55).
const niRoundPence = (basePence, rate) => { const mills = Math.floor((basePence * rate) / 1000); return Math.floor(mills / 10) + (mills % 10 >= 6 ? 1 : 0); };
function niEmployee(gross, letter, taxYear) {
  const t = tables(taxYear).ni, rates = NI_EMPLOYEE[String(letter || 'A').toUpperCase()] || NI_EMPLOYEE.A, g = Math.max(0, pence(gross));
  const main = Math.max(0, Math.min(g, t.upper * 100) - t.primary * 100), above = Math.max(0, g - t.upper * 100);
  return (niRoundPence(main, rates[0]) + niRoundPence(above, rates[1])) / 100;
}
// What the company pays on top; shown as a cost, never taken from pay
function niEmployer(gross, letter, taxYear) {
  const t = tables(taxYear).ni, from = NI_EMPLOYER_FROM[String(letter || 'A').toUpperCase()];
  if (!from) return 0;   // category X: no National Insurance
  return niRoundPence(Math.max(0, pence(gross) - t[from] * 100), t.employer) / 100;
}

// ─── Student and postgraduate loans ──────────────────────────────────────────
// 9% (6% postgraduate) of the month's pay above a twelfth of the plan's yearly threshold.
// Two rounding steps and no others: the monthly threshold is rounded DOWN to the penny,
// and the deduction DOWN to a whole pound. Each month stands alone. Payroll runs one plan
// at a time (with more than one, the lowest threshold); a postgraduate loan is a second,
// separate deduction.
const loanPounds = (grossPence, yearlyThreshold, percent) => {
  const threshold = Math.floor((yearlyThreshold * 100) / 12);
  return grossPence > threshold ? Math.floor(((grossPence - threshold) * percent) / 10000) : 0;
};
function studentLoan(gross, plans, taxYear) {
  const t = tables(taxYear).loans, list = (plans || []).map(p => t[String(p)]).filter(v => v > 0);
  return list.length ? loanPounds(pence(gross), Math.min(...list), 9) : 0;
}
function postgradLoan(gross, taxYear) {
  return loanPounds(pence(gross), tables(taxYear).loans.pg, 6);
}

// ─── Workplace pension ───────────────────────────────────────────────────────
// What comes off pay for the pension, learned from a payslip: the scheme takes a round
// percentage of either "qualifying earnings" (the month's pay between a floor and a
// ceiling), all of the pay, or basic pay. Whichever of those gives a round percentage for
// the payslip's own figures is the rule in use. (NEST takes 4% of qualifying earnings from
// pay and claims the fifth percent from HMRC.)
function pensionRule(slip, taxYear) {
  const amount = Number(slip && slip.pension), gross = Number(slip && slip.gross);
  if (!(amount > 0) || !(gross > 0)) return null;
  const t = tables(taxYear).pension, qualifying = Math.min(gross, t.upper) - t.lower, basic = Number(slip.basic);
  const options = [];
  if (qualifying > 0) options.push({ on: 'qualifying', rate: amount / qualifying });
  options.push({ on: 'gross', rate: amount / gross });
  if (basic > 0 && Math.abs(basic - gross) > 0.005) options.push({ on: 'basic', rate: amount / basic });
  const offRound = o => Math.abs(o.rate * 100 - Math.round(o.rate * 400) / 4);   // distance from a quarter of a percent
  const round = options.filter(o => offRound(o) < 0.006 && o.rate < 1);
  const pick = round.length ? { on: round[0].on, rate: Math.round(round[0].rate * 400) / 400 } : { on: 'gross', rate: amount / gross };
  // Taken before tax ("net pay arrangement") when the payslip's taxable pay is pay less the pension
  const taxable = slip.taxable_gross == null ? null : Number(slip.taxable_gross);
  pick.before_tax = taxable !== null && Math.abs(gross - amount - taxable) < 0.011 && Math.abs(gross - taxable) > 0.011;
  return pick;
}
function pensionFor(rule, gross, basic, taxYear) {
  if (!rule || !(gross > 0)) return 0;
  const t = tables(taxYear).pension;
  const base = rule.on === 'qualifying' ? Math.max(0, Math.min(gross, t.upper) - t.lower) : rule.on === 'basic' ? (basic > 0 ? basic : gross) : gross;
  return round2(base * rule.rate);
}

// ─── A person's payroll settings, from a payslip ─────────────────────────────
/**
 * The settings that decide someone's pay, as printed on a payslip (see payslip-read.js
 * for the shape of `slip`). Null when the payslip does not carry enough to work from.
 */
function settingsFrom(slip) {
  if (!slip || !slip.period) return null;
  const code = parseTaxCode(slip.tax_code);
  if (!code) return null;
  const taxYear = taxYearOf(slip.period.year, slip.period.month);
  return {
    tax_code: String(slip.tax_code).toUpperCase(),
    month1: slip.tax_basis === 'month1' || code.month1,
    ni_table: (slip.ni_table || 'A').toUpperCase(),
    student_loan_plans: (slip.student_loan_plans || []).map(String),
    postgrad_loan: !!slip.postgrad_loan,
    pension: pensionRule(slip, taxYear),
  };
}

/**
 * One month's payslip figures.
 *   settings   from settingsFrom()
 *   gross      pay for the month before anything comes off
 *   basic      the basic-pay part of it (matters only to a pension worked out on basic pay)
 *   payBefore, taxBefore   taxable pay and tax earlier in the same tax year
 */
function monthFigures({ settings, year, month, gross, basic, payBefore = 0, taxBefore = 0 }) {
  const taxYear = taxYearOf(year, month), taxMonth = taxMonthOf(month);
  const g = round2(Math.max(0, gross || 0));
  const pension = pensionFor(settings.pension, g, basic, taxYear);
  const taxable = settings.pension && settings.pension.before_tax ? round2(g - pension) : g;
  const tax = taxForMonth({ code: settings.tax_code, month1: settings.month1, taxMonth, pay: taxable, payBefore, taxBefore, taxYear });
  const ni = niEmployee(g, settings.ni_table, taxYear);
  const loan = studentLoan(g, settings.student_loan_plans, taxYear);
  const pg = settings.postgrad_loan ? postgradLoan(g, taxYear) : 0;
  return {
    gross: g, taxable, tax, ni, student_loan: loan, postgrad_loan: pg, pension,
    employer_ni: niEmployer(g, settings.ni_table, taxYear),
    payment: round2(g - tax - ni - loan - pg - pension),
    tax_year: taxYear, tax_month: taxMonth, published: hasTables(taxYear),
  };
}

// Can the calculator arrive at this payslip's own payment from the figures printed on it?
// When it can, the months worked out from it will match the payroll software too. When it
// cannot (a deduction this file does not know about, a company director's National
// Insurance, a tax code operated some special way), they are only an estimate.
function reproduces(slip) {
  const settings = settingsFrom(slip);
  if (!settings || slip.gross == null || slip.tax == null || slip.payment == null) return false;
  if (slip.other_deductions) return false;
  const taxable = slip.taxable_gross != null ? slip.taxable_gross : slip.gross;
  const cumulative = !settings.month1;
  if (cumulative && (!slip.ytd || slip.ytd.gross == null || slip.ytd.tax == null)) return false;
  const figures = monthFigures({ settings, year: slip.period.year, month: slip.period.month, gross: slip.gross, basic: slip.basic,
    payBefore: cumulative ? round2(slip.ytd.gross - taxable) : 0, taxBefore: cumulative ? round2(slip.ytd.tax - slip.tax) : 0 });
  return Math.abs(figures.payment - slip.payment) <= 0.011;
}

// ─── What each month should pay, from the payslips on file ───────────────────
const key = (y, m) => y * 12 + (m - 1);
const unkey = k => ({ year: Math.floor(k / 12), month: (k % 12) + 1 });

/**
 * What a person's payslip should say for each month asked about.
 *
 *   slips      the payslips on file, as read by payslip-read.js (each with .period)
 *   grossFor   (year, month) -> { gross, basic } the person's regular pay for that month
 *              going by their salary, or null for a month they are not employed in
 *   months     [{ year, month }] the months wanted
 *
 * Returns { 'YYYY-MM': { payment, gross, tax, ni, student_loan, postgrad_loan, pension,
 *   source, exact } } where `exact` says the figure should match the payroll software to the
 *   penny (see reproduces()), and source is
 *     'payslip'  the payslip for that very month is on file: these are its figures
 *     'worked'   worked out forward from the latest earlier payslip in the same tax year,
 *                or from the start of a new tax year on the same settings: exact as long
 *                as nothing changes (pay, tax code, pension)
 *     'back'     a month before the first payslip on file: worked out on that payslip's
 *                settings, assuming regular pay in between
 * and nothing at all for a person with no readable payslip (the caller estimates instead).
 */
function payFromPayslips({ slips, grossFor, months }) {
  const byMonth = new Map();
  for (const s of slips || []) if (s && s.period && s.payment != null) byMonth.set(key(s.period.year, s.period.month), s);
  const usable = [...byMonth.entries()].filter(([, s]) => settingsFrom(s)).sort((a, b) => a[0] - b[0]);
  const out = {};
  if (!usable.length) return out;
  const regular = k => { const { year, month } = unkey(k); const g = grossFor(year, month); return g && g.gross > 0 ? g : null; };
  const label = k => { const { year, month } = unkey(k); return `${year}-${String(month).padStart(2, '0')}`; };
  const yearStart = k => { const { year, month } = unkey(k); return key(taxYearOf(year, month), 4); };

  for (const want of months || []) {
    const k = key(want.year, want.month), own = byMonth.get(k);
    if (own) {
      out[label(k)] = { payment: own.payment, gross: own.gross, tax: own.tax, ni: own.ni, student_loan: own.student_loan, postgrad_loan: own.postgrad_loan_amount,
        pension: own.pension, source: 'payslip', exact: true };
      continue;
    }
    if (!regular(k)) continue;
    const start = yearStart(k);
    const before = usable.filter(([sk]) => sk < k), after = usable.filter(([sk]) => sk > k);
    let settings, payBefore = 0, taxBefore = 0, from, source, exact = false;
    const anchor = before.length ? before[before.length - 1] : null;
    if (anchor && anchor[0] >= start && anchor[1].ytd && anchor[1].ytd.gross != null && anchor[1].ytd.tax != null) {
      // Forward from the latest payslip of this tax year: its year-to-date figures are the truth
      settings = settingsFrom(anchor[1]); payBefore = anchor[1].ytd.gross; taxBefore = anchor[1].ytd.tax; from = anchor[0] + 1; source = 'worked';
      exact = reproduces(anchor[1]);
    } else if (anchor) {
      // A new tax year (or a payslip without year-to-date figures): the same settings, starting
      // from nothing in April. A month-1 marker is not carried into a new tax year.
      settings = { ...settingsFrom(anchor[1]) };
      if (anchor[0] < start) settings.month1 = false;
      from = start; source = 'worked';
    } else {
      // Before the first payslip on file: its settings, and the pay it says came before it
      const first = after[0];
      settings = settingsFrom(first[1]); source = 'back';
      if (first[0] >= start && yearStart(first[0]) === start && first[1].ytd && first[1].ytd.gross != null) {
        let earlier = first[1].ytd.gross - (first[1].taxable_gross != null ? first[1].taxable_gross : first[1].gross || 0);
        for (let j = k; j < first[0]; j++) { const s = byMonth.get(j), g = s ? { gross: s.gross } : regular(j); if (g) earlier -= g.gross; }
        payBefore = Math.max(0, round2(earlier));
        taxBefore = settings.month1 ? 0 : taxToDate(settings.tax_code, payBefore, Math.max(1, taxMonthOf(unkey(k).month) - 1), unkey(start).year);
        if (taxMonthOf(unkey(k).month) === 1) { payBefore = 0; taxBefore = 0; }
        from = k;
      } else from = start;
    }
    // Walk month by month up to the one wanted, carrying pay and tax to date
    let figures = null;
    for (let j = from; j <= k; j++) {
      const s = byMonth.get(j), g = s ? { gross: s.gross, basic: s.basic } : regular(j);
      if (!g) continue;
      const { year, month } = unkey(j);
      figures = s && j !== k && s.tax != null
        ? { taxable: s.taxable_gross != null ? s.taxable_gross : s.gross, tax: s.tax }
        : monthFigures({ settings, year, month, gross: g.gross, basic: g.basic, payBefore, taxBefore });
      payBefore = round2(payBefore + figures.taxable); taxBefore = round2(taxBefore + figures.tax);
    }
    if (figures && figures.payment != null) out[label(k)] = { ...figures, source, exact: exact && figures.published };
  }
  return out;
}

module.exports = { taxMonthOf, taxYearOf, taxPeriodOfDate, parseTaxCode, monthlyAdjustment, taxToDate, taxForMonth, niEmployee, niEmployer,
  studentLoan, postgradLoan, pensionRule, pensionFor, settingsFrom, monthFigures, reproduces, payFromPayslips, hasTables, YEARS, LATEST_YEAR };

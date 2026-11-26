'use strict';
// Reads the figures off a payslip PDF from the accountant's payroll software.
//
// A payslip is a page of boxes (EMPLOYEE DETAILS, ADDITIONS, DEDUCTIONS, THIS PAY PERIOD,
// YEAR TO DATE, PAYMENT), each a list of a label and a figure. readPayslip() returns
// those figures by name, so the Salary page can log the payment at the amount that left
// the bank (the PAYMENT figure, which is after pension), and so next month can be worked
// out the way the payroll software does (paye.js) from the tax code and year-to-date
// figures printed here.
//
// Nothing personal is kept: the National Insurance number on the page is never read into
// the result.

const { readPdfText } = require('./pdf-text');

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const round2 = v => Math.round(v * 100) / 100;

const SECTIONS = {
  'EMPLOYEE DETAILS': 'details', 'ADDITIONS': 'additions', 'PAYMENTS': 'additions', 'EARNINGS': 'additions', 'DEDUCTIONS': 'deductions',
  'THIS PAY PERIOD': 'period', 'THIS PERIOD': 'period', 'YEAR TO DATE': 'ytd', 'PAYMENT': 'payment',
};

// "£2,375.00", "-£12.50", "(£12.50)", "2,375.00" -> a number; anything else -> null
function money(text) {
  const t = String(text == null ? '' : text).replace(/\s/g, '');
  const m = /^(-|−|–)?(\()?(-|−)?(?:£|GBP)?(-|−)?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\)?$/.exec(t);
  if (!m) return null;
  const v = parseFloat(m[5].replace(/,/g, '') + '.' + m[6]);
  return m[1] || m[2] || m[3] || m[4] ? -v : v;
}

// A line as a label and what follows it. The reader puts a tab between pieces set apart
// on the page; when a figure sits close to its label there is only a space.
function split(line) {
  const tab = line.indexOf('\t');
  if (tab >= 0) return { label: line.slice(0, tab).trim(), value: line.slice(tab + 1).replace(/\t/g, ' ').trim() };
  // (a pound sign marks where the figure starts even when it is set hard against the label)
  const m = /^(.*?)\s*((?:-|−|\()?\s?£\s?-?[\d,]+\.\d{2}\)?)$/.exec(line);
  return m ? { label: m[1].trim(), value: m[2].trim() } : { label: line.trim(), value: '' };
}

function isoDate(d, m, y) {
  const dd = Number(d), mm = Number(m), yy = Number(y);
  if (!(yy >= 2000 && yy <= 2100) || !(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) return null;
  const date = new Date(Date.UTC(yy, mm - 1, dd));
  if (date.getUTCMonth() !== mm - 1) return null;
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
const monthNumber = word => { const i = MONTH_NAMES.findIndex(n => n.startsWith(String(word).toLowerCase().slice(0, 3))); return i < 0 ? 0 : i + 1; };

// "Payslip for Month Ending 30 Nov 2026" -> { kind: 'month', end: '2026-11-30' }
function periodFrom(text) {
  const m = /payslip\s+for\s+(?:the\s+)?(month|week|fortnight|four weeks|4 weeks|quarter|period)?\s*ending\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/i.exec(text || '');
  if (!m) return null;
  const end = isoDate(m[2], monthNumber(m[3]), m[4]);
  return end ? { kind: (m[1] || 'month').toLowerCase(), end } : null;
}

// What sort of deduction or addition a line is, from its label
function deductionKind(label) {
  const l = label.toLowerCase();
  if (/^(paye\s*)?(income\s*)?tax$|^paye$|^paye tax$/.test(l)) return 'tax';
  if (/national insurance|^n\.?i\.?c?s?\.?$|^employee n\.?i/.test(l)) return 'ni';
  if (/postgraduate|post-graduate|\bpgl\b/.test(l)) return 'postgrad_loan';
  if (/student loan/.test(l)) return 'student_loan';
  if (/nest\b|pension|people'?s|now:|smart pension|aviva|royal london|scottish widows|legal ?(&|and) ?general|standard life|aegon|cushon|true potential|salary sacrifice|\bavc\b/.test(l)) return 'pension';
  return 'other';
}
function additionKind(label) {
  const l = label.toLowerCase();
  if (/^(monthly|basic|weekly)\s+(pay|salary|wage)s?$|^salary$|^basic$|^pay$|^wages?$/.test(l)) return 'basic';
  return 'extra';
}

/**
 * Read a payslip PDF.
 * @param {Buffer} buffer    the PDF file
 * @param {string} fileName  its file name, used only when the page itself does not say whose it is
 * @returns an object: `ok` is true when there is enough to log a payment (the month and the
 *          amount paid); `problems` lists, in plain words, anything that could not be read.
 */
function readPayslip(buffer, fileName = '') {
  const out = {
    ok: false, problems: [], name: '', period: null, paid_on: null,
    tax_code: '', tax_basis: 'cumulative', ni_table: '', student_loan_plans: [], postgrad_loan: false,
    additions: [], deductions: [], additions_total: null, deductions_total: null,
    basic: null, gross: null, taxable_gross: null, tax: null, ni: null, student_loan: null, postgrad_loan_amount: null, pension: null, other_deductions: null,
    employer_ni: null, net_pay: null, payment: null,
    ytd: { gross: null, tax: null, employee_ni: null, employer_ni: null, student_loan: null, postgrad_loan: null, employee_pension: null, employer_pension: null },
    employer: '', paye_ref: '', adds_up: null, several: false,
  };
  const pdf = readPdfText(buffer);
  if (!pdf.ok) {
    out.problems.push(pdf.error === 'password protected' ? 'This PDF is password protected, so it cannot be read.'
      : pdf.error === 'not a PDF' ? 'This file is not a PDF.' : 'No text could be read from this PDF (it may be a scan or a photo).');
  }
  let lines = pdf.lines || [];
  // One file, one payslip. A PDF holding several people's payslips is not read: filing it
  // against one person would show them everybody else's pay.
  const headed = (pdf.pages || []).filter(pg => pg.lines.some(l => /payslip\s+for\b.*\bending\b/i.test(l)));
  if (headed.length > 1 || lines.filter(l => /payslip\s+for\b.*\bending\b/i.test(l)).length > 1) {
    out.several = true;
    out.problems.push('This PDF has more than one payslip in it. Upload one payslip per file, so nobody is shown someone else\u2019s.');
    return out;
  }

  // Whose it is and which month: the heading on the page, else the document title, else the file name
  const titleSources = [pdf.title || '', String(fileName || '').replace(/\.pdf$/i, '').replace(/^[0-9a-f]{6,}-/i, '').replace(/_/g, ' ')];
  let headingAt = lines.findIndex(l => /payslip\s+for\b.*\bending\b/i.test(l));
  let period = headingAt >= 0 ? periodFrom(lines[headingAt]) : null;
  if (headingAt > 0) out.name = lines.slice(0, headingAt).filter(l => !SECTIONS[l.trim().toUpperCase()]).join(' ').replace(/\s+/g, ' ').trim();
  for (const t of titleSources) {
    const m = /^(.*?)\s+[-–—]\s+(payslip\s+for\b.*)$/i.exec(t.trim());
    if (!m) continue;
    if (!out.name) out.name = m[1].trim();
    if (!period) period = periodFrom(m[2]);
  }

  // The boxes
  let section = '';
  const seen = {};
  for (let i = Math.max(0, headingAt + 1); i < lines.length; i++) {
    const raw = lines[i], head = SECTIONS[raw.replace(/\t/g, ' ').trim().toUpperCase()];
    if (head) { section = head; seen[head] = true; continue; }
    const footer = /^(.*?)\s*[·|•-]\s*PAYE\s+ref(?:erence)?\.?:?\s*([0-9]{3}\s*\/\s*[A-Za-z0-9]+)/i.exec(raw.replace(/\t/g, ' '));
    if (footer) { out.employer = footer[1].trim(); out.paye_ref = footer[2].replace(/\s/g, ''); continue; }
    const { label, value } = split(raw);
    const amount = money(value), low = label.toLowerCase();

    if (section === 'details') {
      if (/^tax code/.test(low) && value) {
        const m = /^([A-Za-z0-9]+)\s*(.*)$/.exec(value);
        if (m) {
          out.tax_code = m[1].toUpperCase();
          if (/w1|m1|wk\s*1|mth\s*1|week\s*1|month\s*1|non.?cum|\bx\b/i.test(m[2])) out.tax_basis = 'month1';
          const tail = /^(.*?)(W1M1|W1|M1|X)$/.exec(out.tax_code);   // written without a space
          if (tail && /\d[A-Z]$|^(BR|NT|D\d|0T)$/.test(tail[1])) { out.tax_code = tail[1]; out.tax_basis = 'month1'; }
        }
      } else if (/national insurance (table|category|letter)|^ni (table|category|letter)/.test(low) && value) {
        const m = /^([A-Za-z])\b/.exec(value); if (m) out.ni_table = m[1].toUpperCase();
      } else if (/student loan|postgrad|^plan\s*\d/.test(low + ' ' + value.toLowerCase())) {
        // (a long value wraps onto a line of its own, so the plan may arrive without its label)
        const text = `${label} ${value}`;
        if (/postgrad|post-grad|\bpgl\b/i.test(text) && !/\b(no|none|n\/a)\b/i.test(text)) out.postgrad_loan = true;
        for (const m of text.matchAll(/plan\s*(\d)/gi)) if (!out.student_loan_plans.includes(m[1])) out.student_loan_plans.push(m[1]);
      }
    } else if (section === 'additions' && amount !== null) {
      if (/^total\b/.test(low)) out.additions_total = amount;
      else out.additions.push({ label, amount, kind: additionKind(label) });
    } else if (section === 'deductions' && amount !== null) {
      if (/^total\b/.test(low)) out.deductions_total = amount;
      else out.deductions.push({ label, amount, kind: deductionKind(label) });
    } else if (section === 'period' && amount !== null) {
      if (/taxable (gross )?pay|^gross pay/.test(low)) out.taxable_gross = amount;
      else if (/employer.*national insurance|employer.*\bni\b/.test(low)) out.employer_ni = amount;
      else if (/^net pay/.test(low)) out.net_pay = amount;
    } else if (section === 'ytd' && amount !== null) {
      if (/taxable (gross )?pay|^gross pay/.test(low)) out.ytd.gross = amount;
      else if (/^(paye\s*)?(income\s*)?tax$/.test(low)) out.ytd.tax = amount;
      else if (/employer.*national insurance|employer.*\bni\b/.test(low)) out.ytd.employer_ni = amount;
      else if (/national insurance|\bni\b/.test(low)) out.ytd.employee_ni = amount;
      else if (/postgrad/.test(low)) out.ytd.postgrad_loan = amount;
      else if (/student loan/.test(low)) out.ytd.student_loan = amount;
      else if (/employer.*pension/.test(low)) out.ytd.employer_pension = amount;
      else if (/pension/.test(low)) out.ytd.employee_pension = amount;
    } else if (section === 'payment') {
      const only = money(raw.replace(/\t/g, ' ').trim());
      if (only !== null && out.payment === null) out.payment = only;
      else if (amount !== null && out.payment === null && /^(payment|total|net|amount)/.test(low)) out.payment = amount;
      const paid = /paid\s+on\s+(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/i.exec(raw);
      if (paid) out.paid_on = isoDate(paid[1], paid[2], paid[3]);
    }
  }

  // Totals by kind
  const sumOf = (rows, kind) => { const r = rows.filter(x => x.kind === kind); return r.length ? round2(r.reduce((a, x) => a + x.amount, 0)) : null; };
  out.basic = sumOf(out.additions, 'basic');
  out.gross = out.additions_total !== null ? out.additions_total : (out.additions.length ? round2(out.additions.reduce((a, x) => a + x.amount, 0)) : out.taxable_gross);
  out.tax = sumOf(out.deductions, 'tax');
  out.ni = sumOf(out.deductions, 'ni');
  out.student_loan = sumOf(out.deductions, 'student_loan');
  out.postgrad_loan_amount = sumOf(out.deductions, 'postgrad_loan');
  out.pension = sumOf(out.deductions, 'pension');
  out.other_deductions = sumOf(out.deductions, 'other');
  if (out.postgrad_loan_amount !== null) out.postgrad_loan = true;
  if (out.deductions_total === null && out.deductions.length) out.deductions_total = round2(out.deductions.reduce((a, x) => a + x.amount, 0));

  // The month it is for. A monthly payslip belongs to the month it ends in.
  if (period && period.kind === 'month') out.period = { year: Number(period.end.slice(0, 4)), month: Number(period.end.slice(5, 7)), end: period.end };
  else if (period) out.problems.push('This payslip is not for a calendar month, so pick the month it should count for.');
  else if (pdf.ok) out.problems.push('Could not find which month this payslip is for.');

  // The amount that left the bank: the PAYMENT box, else pay less deductions
  if (out.payment === null && out.gross !== null && out.deductions_total !== null && seen.deductions) out.payment = round2(out.gross - out.deductions_total);
  if (out.payment === null && out.net_pay !== null) out.payment = out.net_pay;
  if (out.payment === null && pdf.ok) out.problems.push('Could not find the amount paid on this payslip.');
  if (out.payment !== null && out.payment < 0) { out.problems.push('The amount paid on this payslip is negative.'); }

  // Does it add up? Pay, less everything taken off, is what was paid.
  if (out.payment !== null && out.gross !== null && out.deductions_total !== null) {
    out.adds_up = Math.abs(round2(out.gross - out.deductions_total) - out.payment) <= 0.011;
    if (!out.adds_up) out.problems.push('The figures on this payslip do not add up to the amount paid, so check the amount before logging it.');
  }
  if (!out.name && pdf.ok) out.problems.push('Could not find whose payslip this is.');

  out.ok = !!out.period && out.payment !== null && out.payment >= 0;
  return out;
}

// ─── Whose payslip is it? ────────────────────────────────────────────────────
const plain = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Match the name on a payslip to one of `people` ([{ id, name }]).
 * Returns { id, sure } for one clear match, { id: null, candidates: [ids] } when more than
 * one person fits, or { id: null, candidates: [] } when nobody does.
 * A payslip often carries a fuller name than the tracker does (a middle name, a second
 * surname), so a person matches when every part of the shorter name appears in the longer.
 */
function matchPerson(name, people) {
  const target = plain(name);
  if (!target) return { id: null, candidates: [] };
  const list = (people || []).map(p => ({ id: p.id, key: plain(p.name) })).filter(p => p.key);
  const exact = list.filter(p => p.key === target);
  if (exact.length === 1) return { id: exact[0].id, sure: true };
  if (exact.length > 1) return { id: null, candidates: exact.map(p => p.id) };
  const words = target.split(' ');
  const fits = list.filter(p => {
    const w = p.key.split(' ');
    const [small, big] = w.length <= words.length ? [w, words] : [words, w];
    return small.length >= 2 && small.every(x => big.includes(x));
  });
  if (fits.length === 1) return { id: fits[0].id, sure: true };
  if (fits.length > 1) return { id: null, candidates: fits.map(p => p.id) };
  // First name and last name agree, whatever is in between (or the surname is doubled up)
  const loose = list.filter(p => {
    const w = p.key.split(' ');
    return w.length >= 2 && words.length >= 2 && w[0] === words[0] && (w[w.length - 1] === words[words.length - 1] || words.includes(w[w.length - 1]) || w.includes(words[words.length - 1]));
  });
  if (loose.length === 1) return { id: loose[0].id, sure: false };
  return { id: null, candidates: loose.map(p => p.id) };
}

// ─── What is kept of a payslip once it has been read ─────────────────────────
/**
 * The figures to store beside the PDF, filed under `year` and `month`: everything that
 * decides pay, and nothing that identifies the person (no name, no NI number; the PDF
 * itself holds those). Null when the amount paid could not be read.
 *
 * A payslip filed under a month other than the one printed on it keeps its payment figure
 * but not its year-to-date figures, which belong to the printed month.
 */
function figuresToKeep(slip, year, month) {
  if (!slip || slip.payment == null) return null;
  const printed = slip.period && slip.period.year === Number(year) && slip.period.month === Number(month);
  const empty = { gross: null, tax: null, employee_ni: null, employer_ni: null, student_loan: null, postgrad_loan: null, employee_pension: null, employer_pension: null };
  return {
    period: { year: Number(year), month: Number(month), end: printed ? slip.period.end : null }, paid_on: slip.paid_on,
    tax_code: slip.tax_code, tax_basis: slip.tax_basis, ni_table: slip.ni_table, student_loan_plans: slip.student_loan_plans, postgrad_loan: slip.postgrad_loan,
    additions: slip.additions, deductions: slip.deductions, additions_total: slip.additions_total, deductions_total: slip.deductions_total,
    basic: slip.basic, gross: slip.gross, taxable_gross: slip.taxable_gross, tax: slip.tax, ni: slip.ni, student_loan: slip.student_loan,
    postgrad_loan_amount: slip.postgrad_loan_amount, pension: slip.pension, other_deductions: slip.other_deductions,
    employer_ni: slip.employer_ni, net_pay: slip.net_pay, payment: slip.payment, ytd: printed ? slip.ytd : empty, adds_up: slip.adds_up,
  };
}

// A name as it is compared and remembered: lower case, no accents or punctuation
const nameKey = plain;

module.exports = { readPayslip, matchPerson, money, figuresToKeep, nameKey };

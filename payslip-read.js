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

// "£2,375.00", "-£12.50", "(£12.50)", "£12.50-", "£12.50 CR", "2,375.00" -> a number; anything else -> null
// (brackets, a minus sign of any kind before or after, and CR all mean it is money back)
const MINUS = '-−–';
const MONEY = new RegExp(`^([${MINUS}])?(\\()?([${MINUS}])?(?:£|GBP)?([${MINUS}])?(\\d{1,3}(?:,\\d{3})*|\\d+)\\.(\\d{2})\\)?([${MINUS}]|CR)?$`, 'i');
function money(text) {
  const m = MONEY.exec(String(text == null ? '' : text).replace(/\s/g, ''));
  if (!m) return null;
  const v = parseFloat(m[5].replace(/,/g, '') + '.' + m[6]);
  return m[1] || m[2] || m[3] || m[4] || m[7] ? -v : v;
}

// A line as a label and what follows it. The reader puts a tab between pieces set apart
// on the page; when a figure sits close to its label there is only a space.
const CLOSE_FIGURE = new RegExp(`^(.*?)\\s*((?:[${MINUS}(]\\s?)?£\\s?[${MINUS}]?[\\d,]+\\.\\d{2}\\)?(?:\\s?(?:[${MINUS}]|CR))?)$`, 'i');
const BARE_FIGURE = new RegExp(`^(.*?\\S)\\s+([${MINUS}(]?[\\d,]+\\.\\d{2}\\)?(?:\\s?(?:[${MINUS}]|CR))?)$`, 'i');
function split(line) {
  const tab = line.indexOf('\t');
  if (tab >= 0) return { label: line.slice(0, tab).trim(), value: line.slice(tab + 1).replace(/\t/g, ' ').trim() };
  // (a pound sign marks where the figure starts even when it is set hard against the label;
  // without one, a figure with pence at the end of the line after a space)
  const m = CLOSE_FIGURE.exec(line) || BARE_FIGURE.exec(line);
  return m && money(m[2]) !== null ? { label: m[1].trim(), value: m[2].trim() } : { label: line.trim(), value: '' };
}

function isoDate(d, m, y) {
  const dd = Number(d), mm = Number(m), yy = Number(y);
  if (!(yy >= 2000 && yy <= 2100) || !(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) return null;
  const date = new Date(Date.UTC(yy, mm - 1, dd));
  if (date.getUTCMonth() !== mm - 1) return null;
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
const monthNumber = word => { const i = MONTH_NAMES.findIndex(n => n.startsWith(String(word).toLowerCase().slice(0, 3))); return i < 0 ? 0 : i + 1; };

// "Payslip for Month Ending 30 Nov 2026" (or "... Ending 30/11/2026") -> { kind: 'month', end: '2026-11-30' }
function periodFrom(text) {
  const m = /payslip\s+for\s+(?:the\s+)?(month|week|fortnight|four weeks|4 weeks|quarter|period)?\s*ending\s+(?:(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})|(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4}))/i.exec(text || '');
  if (!m) return null;
  const end = m[2] ? isoDate(m[2], monthNumber(m[3]), m[4]) : isoDate(m[5], m[6], m[7]);
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

// Box headings with the spaces taken out, so a heading set with its letters spaced apart
// ("D E D U C T I O N S") is still known
const squeeze = text => String(text).replace(/\s+/g, '');
const HEADINGS = {};
for (const [heading, box] of Object.entries(SECTIONS)) HEADINGS[squeeze(heading)] = box;
const FIGURE_BOXES = new Set(['additions', 'deductions', 'period', 'ytd']);

// A tax code as HMRC writes them: 1257L, K475, BR, D0, NT, 0T, with S or C in front for
// Scotland or Wales, and W1, M1 or X on the end when it is not cumulative
const TAX_CODE = /^[SC]?(?:K\d{1,5}|\d{1,5}[A-Z]|BR|NT|D\d)(?:W1M1|W1|M1|X)?$/i;
const NOT_CUMULATIVE = /^\(?\s*(?:(?:w1|wk\s*1|week\s*1)(?:\s*\/?\s*(?:m1|mth\s*1|month\s*1))?|m1|mth\s*1|month\s*1|x\b|non[- ]?cum|emergency)/i;

// The things in the EMPLOYEE DETAILS box, by the words that label them
const DETAIL_LABELS = {
  tax_code: /\btax\s*code\b/i,
  ni_number: /\b(?:national\s+insurance|n\.?i\.?)\s+(?:number|no\b\.?)/i,
  ni_table: /\b(?:national\s+insurance|n\.?i\.?)\s+(?:table|category|letter)(?:\s+letter)?/i,
  student_loan: /\bstudent\s+loans?\b/i,
  postgrad: /\bpost-?\s?graduate(?:\s+loans?)?\b|\bpgl\b/i,
  leave: /\b(?:annual\s+leave|holidays?)\b/i,
};

// The EMPLOYEE DETAILS box. A long label or a long value wraps onto lines of its own (and
// which ones wrap changes with what is printed), so the box is read as one run of text and
// each thing is found by its label. The National Insurance number is never read.
function readDetails(lines, out) {
  const text = lines.join(' ').replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
  const found = Object.entries(DETAIL_LABELS)
    .map(([key, re]) => { const m = re.exec(text); return m ? { key, at: m.index, end: m.index + m[0].length } : null; })
    .filter(Boolean).sort((a, b) => a.at - b.at);
  // What is printed against a label: everything up to the next label
  const valueOf = (key, whole = false) => {
    const f = found.find(x => x.key === key);
    if (!f) return null;
    const next = found.find(x => x.at >= f.end);
    return text.slice(whole ? f.at : f.end, next ? next.at : text.length).replace(/^[\s:]+/, '').trim();
  };

  const code = valueOf('tax_code');
  const m = code === null ? null : /^([A-Za-z0-9]+)\s*(.*)$/.exec(code);
  if (m && TAX_CODE.test(m[1])) {
    out.tax_code = m[1].toUpperCase();
    if (NOT_CUMULATIVE.test(m[2])) out.tax_basis = 'month1';
    const tail = /^(.*?)(W1M1|W1|M1|X)$/.exec(out.tax_code);   // written without a space
    if (tail && /\d[A-Z]$|^[SC]?(BR|NT|D\d|K\d+)$/.test(tail[1])) { out.tax_code = tail[1]; out.tax_basis = 'month1'; }
  }

  const table = valueOf('ni_table'), letter = table === null ? null : /^([A-Za-z])\b/.exec(table);
  if (letter) out.ni_table = letter[1].toUpperCase();

  const loan = valueOf('student_loan', true);
  if (loan !== null) {
    for (const plan of loan.matchAll(/plans?\s*(\d)((?:\s*(?:,|&|and|\+|\/)\s*(?:plans?\s*)?\d)*)/gi)) {
      for (const digit of (plan[1] + plan[2]).match(/\d/g)) if (!out.student_loan_plans.includes(digit)) out.student_loan_plans.push(digit);
    }
  }
  // A postgraduate loan is named (on a row of its own, or after the plan) unless what
  // follows says there is none
  const pg = DETAIL_LABELS.postgrad.exec(text);
  if (pg && !/^[\s:]*(?:no\b|none\b|n\/?a\b|nil\b|not\b|false\b|0\b|-|\u2013|\u2014)/i.test(text.slice(pg.index + pg[0].length))) out.postgrad_loan = true;
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
  const lines = pdf.lines || [];
  // A box heading is the name of a box on a line of its own. This payroll software prints
  // them in capitals, and then only capitals count: a label wraps as its figure grows, and
  // the last word of "Student Loan deductions" on a line of its own is not the start of the
  // DEDUCTIONS box.
  const capitals = lines.some(l => HEADINGS[squeeze(l)]);
  const boxOf = raw => HEADINGS[capitals ? squeeze(raw) : squeeze(raw).toUpperCase()] || '';
  // The payslip's own heading starts its line. (A browser that printed the page adds a
  // header repeating the document's title, which also says "Payslip for ... Ending".)
  const startsLine = l => /^payslip\s+for\b.*\bending\b/i.test(l.trim()), anywhere = l => /payslip\s+for\b.*\bending\b/i.test(l);
  const isHeading = lines.some(startsLine) ? startsLine : anywhere;

  // One file, one payslip. A PDF holding several people's payslips is not read: filing it
  // against one person would show them everybody else's pay.
  const headedPages = (pdf.pages || []).filter(pg => pg.lines.some(isHeading)).length;
  if (headedPages > 1 || lines.filter(isHeading).length > 1 || lines.filter(l => boxOf(l) === 'details').length > 1) {
    out.several = true;
    out.problems.push('This PDF has more than one payslip in it. Upload one payslip per file, so nobody is shown someone else’s.');
    return out;
  }

  // Whose it is and which month: the heading on the page, else the document title, else the file name
  const titleSources = [pdf.title || '', String(fileName || '').replace(/\.pdf$/i, '').replace(/^[0-9a-f]{6,}-/i, '').replace(/_/g, ' ')];
  const headingAt = lines.findIndex(isHeading);
  let period = headingAt >= 0 ? periodFrom(lines[headingAt]) : null;
  if (headingAt > 0) {
    // (a double-barrelled name can be split at its hyphen; a printed page header is not part of the name)
    out.name = lines.slice(0, headingAt).filter(l => !boxOf(l) && !anywhere(l) && !/^(?:file|https?):\/\/|^\d{1,2}\/\d{1,2}\/\d{2,4},/i.test(l.trim()))
      .reduce((name, l) => name + (/[A-Za-z]-$/.test(name) ? '' : ' ') + l.replace(/\t/g, ' '), '').replace(/\s+/g, ' ').trim();
  }
  for (const t of titleSources) {
    const m = /^(.*?)\s+[-–—]\s+(payslip\s+for\b.*)$/i.exec(t.trim());
    if (!m) continue;
    if (!out.name) out.name = m[1].trim();
    if (!period) period = periodFrom(m[2]);
  }

  // The boxes
  let section = '';
  const seen = {};
  const details = [];
  let waiting = [];   // the lines of a wrapped label whose figure has not come yet
  for (let i = Math.max(0, headingAt + 1); i < lines.length; i++) {
    const raw = lines[i], head = boxOf(raw);
    if (head) { section = head; seen[head] = true; waiting = []; continue; }
    const footer = /^(.*?)\s*[·|•-]\s*PAYE\s+ref(?:erence)?\.?:?\s*([0-9]{3}\s*\/\s*[A-Za-z0-9]+)/i.exec(raw.replace(/\t/g, ' '));
    if (footer) { out.employer = footer[1].trim(); out.paye_ref = footer[2].replace(/\s/g, ''); waiting = []; continue; }
    const { label: own, value } = split(raw);
    const amount = money(value);

    if (section === 'details') {
      details.push(raw);
    } else if (FIGURE_BOXES.has(section)) {
      // A long label runs over two or three lines, with its figure after them or beside
      // the last of them
      if (value === '') { waiting.push(own); continue; }
      if (amount === null) { waiting = []; continue; }   // (a row that is not money: hours, a rate)
      const total = /^total\b/i.test(own);
      const label = (total ? own : [...waiting, own].join(' ')).replace(/\s+/g, ' ').trim(), low = label.toLowerCase();
      waiting = [];
      if (section === 'additions') {
        if (total) out.additions_total = amount;
        else out.additions.push({ label, amount, kind: additionKind(own) === 'basic' ? 'basic' : additionKind(label) });
      } else if (section === 'deductions') {
        if (total) out.deductions_total = amount;
        else out.deductions.push({ label, amount, kind: deductionKind(own) !== 'other' ? deductionKind(own) : deductionKind(label) });
      } else if (section === 'period') {
        if (/taxable (gross )?pay|^gross pay/.test(low)) out.taxable_gross = amount;
        else if (/employer.*national insurance|employer.*\bni\b/.test(low)) out.employer_ni = amount;
        else if (/^net pay/.test(low)) out.net_pay = amount;
      } else {
        if (/taxable (gross )?pay|^gross pay/.test(low)) out.ytd.gross = amount;
        else if (/^(paye\s*)?(income\s*)?tax$/.test(low)) out.ytd.tax = amount;
        else if (/employer.*national insurance|employer.*\bni\b/.test(low)) out.ytd.employer_ni = amount;
        else if (/national insurance|\bni\b/.test(low)) out.ytd.employee_ni = amount;
        else if (/postgrad/.test(low)) out.ytd.postgrad_loan = amount;
        else if (/student loan/.test(low)) out.ytd.student_loan = amount;
        else if (/employer.*pension/.test(low)) out.ytd.employer_pension = amount;
        else if (/pension/.test(low)) out.ytd.employee_pension = amount;
      }
    } else if (section === 'payment') {
      const only = money(raw.replace(/\t/g, ' ').trim());
      if (only !== null && out.payment === null) out.payment = only;
      else if (amount !== null && out.payment === null && /^(payment|total|net|amount)/i.test(own)) out.payment = amount;
      const paid = /paid\s+on\s+(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/i.exec(raw);
      if (paid) out.paid_on = isoDate(paid[1], paid[2], paid[3]);
    }
  }
  readDetails(details, out);

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
    // (and each box's lines come to the total printed under them: a line read into the
    // wrong box shows up here)
    const comesTo = (rows, total) => !rows.length || total === null || Math.abs(round2(rows.reduce((a, x) => a + x.amount, 0)) - total) <= 0.011;
    out.adds_up = Math.abs(round2(out.gross - out.deductions_total) - out.payment) <= 0.011
      && comesTo(out.additions, out.additions_total) && comesTo(out.deductions, out.deductions_total);
    if (!out.adds_up) out.problems.push('The figures on this payslip do not add up to the amount paid, so check the amount before logging it.');
  }
  if (!out.name && pdf.ok) out.problems.push('Could not find whose payslip this is.');

  out.ok = !!out.period && out.payment !== null && out.payment >= 0;
  return out;
}

// ─── Whose payslip is it? ────────────────────────────────────────────────────
// A name as it is compared: lower case, without accents or punctuation. Letters that do
// not come apart into a plain letter and an accent are spelled out, joined-up letters
// (fi) are separated, and names in other scripts are kept as they are.
const SPELLED = { '\u0142': 'l', '\u00f8': 'o', '\u0111': 'd', '\u00f0': 'd', '\u00fe': 'th', '\u00df': 'ss', '\u00e6': 'ae', '\u0153': 'oe', '\u0131': 'i' };
const plain = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[\u0142\u00f8\u0111\u00f0\u00fe\u00df\u00e6\u0153\u0131]/g, c => SPELLED[c]).replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

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

/**
 * Whose payslip a file is, for the upload page: `people` are [{ id, name, active }] and
 * `remembered` is the person a payslip printed with this very name was filed under before
 * (an id, or null). Returns what matchPerson() does.
 *
 * A wrong answer here files one person's payslip where another can open it, so only a
 * plain case is `sure`:
 *   - one person has exactly this name: them. With two of that name, the one still
 *     working here is suggested, not assumed (it may be the leaver's final payslip); and
 *     if a payslip with this name was filed under somebody else before, the owner chooses.
 *   - else the person it was filed under before
 *   - else the one person whose name fits (see matchPerson). When several fit and one of
 *     them still works here, that one is suggested, not assumed.
 */
function whosePayslip(name, people, remembered = null) {
  const target = plain(name);
  if (!target) return { id: null, candidates: [] };
  const list = (people || []).map(p => ({ id: p.id, key: plain(p.name), active: !!p.active })).filter(p => p.key);
  const known = remembered != null && list.some(p => p.id === remembered) ? remembered : null;
  const exact = list.filter(p => p.key === target);
  if (exact.length) {
    if (known !== null) return exact.some(p => p.id === known) ? { id: known, sure: true } : { id: null, candidates: [...new Set([...exact.map(p => p.id), known])] };
    if (exact.length === 1) return { id: exact[0].id, sure: true };
    const here = exact.filter(p => p.active), ids = exact.map(p => p.id);
    return here.length === 1 ? { id: here[0].id, sure: false, candidates: ids } : { id: null, candidates: ids };
  }
  if (known !== null) return { id: known, sure: true };
  const match = matchPerson(name, people);
  if (match.id || !(match.candidates || []).length) return match;
  const here = match.candidates.filter(id => list.some(p => p.id === id && p.active));
  return here.length === 1 ? { id: here[0], sure: false, candidates: match.candidates } : match;
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

module.exports = { readPayslip, matchPerson, whosePayslip, money, figuresToKeep, nameKey };

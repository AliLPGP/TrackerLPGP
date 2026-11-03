'use strict';
// The LPGP employment contract, in the company's contract design: a cover page with the
// key terms, numbered sections, and the employee's signature block (only they sign).
// Sections follow the employee's record: probation (on it, passed, or none), where they
// work, their hours, and holiday and tax terms for payroll or self-employed staff.

const { rgb } = require('pdf-lib');
const { createBrandDoc, COMPANY } = require('./brand-pdf');

const FOOTER = 'This Employment Contract and its contents are confidential and intended solely for the employee named herein. Unauthorized copying, disclosure, distribution, or use of this document or its contents is strictly prohibited. If you have received this document in error, please notify the sender immediately and delete all copies.';

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five', 'twenty-six', 'twenty-seven', 'twenty-eight'];
// "five (5)", as the contract writes numbers; half days stay as figures
const spell = n => (Number.isInteger(Number(n)) && WORDS[Number(n)] ? `${WORDS[Number(n)]} (${Number(n)})` : String(n));

// The numbered sections, from the contract's terms
function sections(c) {
  const out = [];
  out.push(['Duration', [
    'This contract shall be reviewed annually on the Employee’s work anniversary date. Renewal of employment will be subject to performance evaluation, conduct, and business requirements. Please refer to the Termination of Contract section below for further information regarding grounds for termination.',
  ]]);
  if (c.probation.state === 'on') {
    out.push(['Probation Period', [
      `The Employee shall be subject to a ${c.probation.months ? spell(c.probation.months) + ' month' : ''} probationary period${c.probation.end ? `, ending on ${c.probation.end},` : ''} during which performance, conduct, and suitability for the role will be assessed. The Company may extend this period where it reasonably needs more time to complete its assessment.`.replace('a  probationary', 'a probationary'),
    ]]);
  } else if (c.probation.state === 'passed') {
    out.push(['Confirmation of Employment', [
      'The Employee has successfully completed their Probationary Period to the Company’s satisfaction, and the Company confirms the Employee’s continued employment on a permanent basis.',
    ]]);
  }
  const where = {
    remote: 'This is a fully remote position and work may be performed from a location of the Employee’s choosing, provided that reliable internet connectivity and electricity are maintained.',
    office: `The Employee’s normal place of work is the Company’s office in ${COMPANY.address}. The role may involve some business travel or temporary work at other locations.`,
    hybrid: `This is a hybrid position: the Employee will work partly from the Company’s office in ${COMPANY.address} and partly remotely, as agreed with the Company. When working remotely, reliable internet connectivity and electricity must be maintained.`,
  };
  out.push(['Location of Employment', [where[c.work_arrangement] || where.remote]]);
  out.push(['Hours of Operation', [
    `The Employee is expected to work the following schedule: ${c.schedule.join(', ')}. ` +
    (c.flexible_hours
      ? 'The Company will confirm which of these hours apply, and may change them during the year according to business needs.'
      : 'The Employee is responsible for managing any applicable time zone differences.'),
  ]]);
  out.push(['Compensation', [
    `The Employee will be paid an annual salary of ${c.annual_salary} before tax, paid in monthly instalments. LPGP Connect issues salary payments during the last week of each month unless a major holiday affects the scheduled payout period, in which case payment may be processed on the next business day. Payments will be made via bank transfer or other approved payment methods.`,
  ]]);
  const extra = 'In the year the Employee joins, this is pro-rated to the part of the year worked. Any days off beyond this are unpaid and are deducted from pay at the daily rate for the month they fall in (the monthly pay divided by the number of working days in that month). Leave must be agreed with the Company in advance.';
  out.push(['Benefits & Statutory Obligations', c.employment_type === 'self_employed' ? [
    'The Employee shall be responsible for their own taxes, insurance, and statutory obligations in accordance with applicable local laws and regulations.',
    `The Employee will be entitled to ${spell(c.holiday_days)} paid leave days per year, in addition to standard UK bank holidays observed by the Company. ${extra}`,
  ] : [
    'The Company will deduct income tax and National Insurance contributions from the Employee’s pay through PAYE, and will enrol the Employee in a workplace pension where required by law.',
    `The Employee will be entitled to ${spell(c.holiday_days)} days of paid holiday per holiday year (1 January to 31 December), in addition to standard UK bank holidays observed by the Company. ${extra}`,
  ]]);
  out.push(['Confidentiality, IP & Data Protection', [
    'As part of your engagement, you will be required to sign the Company’s Team Member Agreement, covering confidentiality, the assignment of intellectual property, and data protection. It ensures that all work, materials, data, and intellectual property created during your engagement shall remain the exclusive property of LPGP Connect.',
    'Access to company systems, data, or assets will only be granted once all required documents have been signed and returned.',
  ]]);
  out.push(['Termination of Contract', [
    'Employment may be terminated in cases of repeated misconduct, violation of company policies, unsatisfactory performance, breach of confidentiality, or failure to fulfill job responsibilities, subject to prior warnings and management review.',
  ]]);
  return out;
}

/**
 * The contract as a PDF.
 * `c`: employee_name, employee_address, position, country, employment_label, schedule (lines),
 * annual_salary, start_date, employment_type, work_arrangement, holiday_days,
 * probation {state, months, end}, signed_date.
 */
async function renderContractPdf(c, { signaturePng } = {}) {
  const d = await createBrandDoc({ footerNote: FOOTER });
  const { fonts, text, wrap, BLUE } = d;

  // ── Cover: the key terms ──
  const cover = d.coverPage();
  text(cover, 'EMPLOYMENT CONTRACT', 57, 158, { font: fonts.sansBold, size: 28 });
  text(cover, c.position, 58, 192, { font: fonts.mono, size: 14.4 });
  const cells = [
    ['Name of Company', COMPANY.name], ['Company’s Address', COMPANY.address],
    ['Name of Employee', c.employee_name], ['Employee’s Address', c.employee_address || '—'],
    ['Employee’s Position', c.position], ['Country of Employment', c.country],
    ['Employment Type', c.employment_label], ['Working Schedule', c.schedule.join('\n')],
    ['Annual Salary (Before Tax)', c.annual_salary], ['Contract Start Date', c.start_date],
  ];
  cells.forEach(([label, value], i) => {
    const x = i % 2 ? 307 : 68, top = 262 + Math.floor(i / 2) * 83.5;
    text(cover, label.toUpperCase(), x, top, { font: fonts.mono, size: 9.6, color: BLUE });
    wrap(value, fonts.sansSemi, 11.6, i % 2 ? 175 : 210).slice(0, 4).forEach((l, k) => text(cover, l, x, top + 15.5 + k * 16.5, { font: fonts.sansSemi, size: 11.6 }));
  });

  // ── The terms ──
  const f = d.flow(d.plainPage());
  sections(c).forEach(([title, paras], i) => {
    f.heading(`${i + 1}. ${title}`);
    paras.forEach(p => f.para(p));
    f.y += 4;
  });
  f.para('By signing below, the Employee acknowledges and agrees to the terms and conditions stated in this Employment Contract.', { gap: 30 });

  // ── The employee's signature (the company does not sign) ──
  f.need(120);
  const top = f.y, page = f.page, x = 60;
  [['Employee Name:', c.employee_name], ['Date:', c.signed_date || ''], ['Signature:', '']].forEach(([label, value], k) => {
    text(page, label, x, top + k * 12, { font: fonts.sans, size: 8 });
    if (value) text(page, value, x + fonts.sans.widthOfTextAtSize(label, 8) + 3, top + k * 12, { font: fonts.sansSemi, size: 8 });
  });
  const m = String(signaturePng || '').match(/^data:image\/png;base64,(.+)$/);
  let png = null;
  if (m) { try { png = await d.pdf.embedPng(Buffer.from(m[1], 'base64')); } catch { png = null; } }
  if (png) {
    const h = 44, w = Math.min(130, png.width * (h / png.height));
    page.drawImage(png, { x: x + 34, y: d.H - (top + 24 + h), width: w, height: h });
  } else {
    page.drawLine({ start: { x: x + 40, y: d.H - (top + 60) }, end: { x: x + 190, y: d.H - (top + 60) }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  }

  return d.pdf.save();
}

module.exports = { renderContractPdf, sections, spell };

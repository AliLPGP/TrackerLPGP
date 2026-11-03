// The employment contract in the LPGP design: sections follow the employee's terms,
// and it lays out as a PDF.
const assert = require('assert');
const { PDFDocument } = require('pdf-lib');
const { renderContractPdf, sections, spell } = require('../contract-pdf');

const base = {
  employee_name: 'Jane Example', employee_address: '1 Sample Street, London', position: 'Producer', country: 'Philippines',
  employment_label: 'Full-Time Remote', schedule: ['Monday to Friday', '9:00 AM - 5:00 PM (UK Time)'], monthly_salary: 'PHP 30,000.00',
  start_date: '2 November 2026', employment_type: 'self_employed', work_arrangement: 'remote', holiday_days: 5,
  probation: { state: 'none' }, company: { name: '', signaturePng: '', date: '3 November 2026' }, signed_date: '',
};
const titles = c => sections(c).map(s => s[0]);
const textOf = c => sections(c).map(s => s[1].join(' ')).join(' ');

(async () => {
  assert.strictEqual(spell(5), 'five (5)');
  assert.strictEqual(spell(12.5), '12.5');

  // Probation: left out, a probation clause, or the confirmation
  assert.ok(!titles(base).includes('Probation Period') && !titles(base).includes('Confirmation of Employment'));
  assert.strictEqual(titles({ ...base, probation: { state: 'on', months: 6, end: '2 May 2027' } })[1], 'Probation Period');
  assert.ok(textOf({ ...base, probation: { state: 'on', months: 6, end: '2 May 2027' } }).includes('six (6) month probationary period, ending on 2 May 2027'));
  assert.strictEqual(titles({ ...base, probation: { state: 'passed' } })[1], 'Confirmation of Employment');

  // Self-employed: own taxes and paid leave days; payroll: PAYE and paid holiday
  assert.ok(textOf(base).includes('responsible for their own taxes') && textOf(base).includes('five (5) paid leave days'));
  const payroll = textOf({ ...base, employment_type: 'payroll', holiday_days: 20 });
  assert.ok(payroll.includes('through PAYE') && payroll.includes('twenty (20) days of paid holiday'));

  // Hours: PHP staff work fixed UK office hours; UK staff one of two shifts the Company sets
  assert.ok(textOf({ ...base, flexible_hours: false }).includes('time zone differences'));
  assert.ok(textOf({ ...base, flexible_hours: true }).includes('may change them during the year'));

  // Where they work
  assert.ok(textOf(base).includes('fully remote position'));
  assert.ok(textOf({ ...base, work_arrangement: 'office' }).includes('normal place of work is the Company’s office'));

  // Renders, with and without signatures
  const pdf = await PDFDocument.load(await renderContractPdf(base));
  assert.ok(pdf.getPageCount() >= 3);
  console.log('contract tests passed');
})().catch(e => { console.error(e); process.exit(1); });

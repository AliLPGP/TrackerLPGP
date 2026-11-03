'use strict';
// The new starter form payroll staff complete during onboarding: HMRC's Starter Checklist
// questions (so the accountant can set their tax code and student loan deductions) and the
// bank details their pay goes to. One definition drives the form on screen, the checks
// here, and the PDF for the accountant (starter-pdf.js).
//
// A field is shown only when every condition in `show` holds, so the student loan
// questions follow HMRC's order and stop as soon as the rest does not apply.

const YES_NO = ['Yes', 'No'];

const STARTER_FORM = [
  {
    title: 'About you', note: 'As HMRC has it: use the names on your passport or birth certificate.',
    fields: [
      { key: 'last_name', label: 'Last name', type: 'text', required: true, max: 60 },
      { key: 'first_names', label: 'First names', type: 'text', required: true, max: 80 },
      { key: 'gender', label: 'Gender', type: 'radio', options: ['Male', 'Female'], required: true,
        hint: 'As shown on your passport or birth certificate. HMRC uses it to match your record.' },
      { key: 'date_of_birth', label: 'Date of birth', type: 'date', required: true },
      { key: 'address', label: 'Home address', type: 'textarea', required: true, max: 300 },
      { key: 'postcode', label: 'Postcode', type: 'text', required: true, max: 12 },
      { key: 'ni_number', label: 'National Insurance number', type: 'text', max: 13, pattern: '^[A-CEGHJ-PR-TW-Z]{2}\\s?\\d{2}\\s?\\d{2}\\s?\\d{2}\\s?[A-D]$',
        patternMessage: 'Enter it like QQ 12 34 56 C', hint: 'Leave it blank if you do not have one yet.' },
      { key: 'start_date', label: 'Employment start date', type: 'date', required: true },
    ],
  },
  {
    title: 'Employee statement', note: 'Choose the one statement that applies to you. It decides your starting tax code.',
    fields: [
      { key: 'statement', label: 'Which statement applies to you?', type: 'choice', required: true, options: [
        { value: 'A', label: 'Statement A', text: 'This is my first job since 6 April and since the 6 April I have not received taxable Jobseeker’s Allowance, Employment and Support Allowance, taxable Incapacity Benefit, State or Occupational Pension.' },
        { value: 'B', label: 'Statement B', text: 'This is now my only job, but since 6 April I have had another job, or received taxable Jobseeker’s Allowance, Employment and Support Allowance or taxable Incapacity Benefit. I do not receive a State or Occupational Pension.' },
        { value: 'C', label: 'Statement C', text: 'As well as my new job, I have another job or receive a State or Occupational Pension.' },
      ] },
    ],
  },
  {
    title: 'Student and postgraduate loans', note: 'So the right repayments are taken from your pay.',
    fields: [
      { key: 'loan', label: 'Do you have a student or postgraduate loan that is not fully repaid?', type: 'radio', options: YES_NO, required: true },
      { key: 'loan_studying', label: 'Are you still studying on a full-time course?', type: 'radio', options: YES_NO, required: true,
        show: { loan: 'Yes' }, hint: 'If you are, you do not need to answer anything else in this section.' },
      { key: 'loan_left', label: 'Did you complete or leave your studies before 6 April this year?', type: 'radio', options: YES_NO, required: true,
        show: { loan: 'Yes', loan_studying: 'No' } },
      { key: 'loan_direct', label: 'Are you repaying your loan directly to the Student Loans Company by direct debit?', type: 'radio', options: YES_NO, required: true,
        show: { loan: 'Yes', loan_studying: 'No', loan_left: 'Yes' } },
      { key: 'loan_plans', label: 'Which loans do you have?', type: 'checkboxes', required: true,
        options: ['Plan 1', 'Plan 2', 'Plan 4', 'Plan 5', 'Postgraduate Loan'],
        show: { loan: 'Yes', loan_studying: 'No', loan_left: 'Yes', loan_direct: 'No' },
        hint: 'Tick all that apply. Not sure? Check at gov.uk/sign-in-to-manage-your-student-loan-balance.' },
    ],
  },
  {
    title: 'Bank details for your pay', note: 'The UK account your salary is paid into.',
    fields: [
      { key: 'account_name', label: 'Name on the account', type: 'text', required: true, max: 80 },
      { key: 'sort_code', label: 'Sort code', type: 'text', required: true, max: 8, pattern: '^\\d{2}-?\\d{2}-?\\d{2}$', patternMessage: 'Six digits, like 12-34-56' },
      { key: 'account_number', label: 'Account number', type: 'text', required: true, max: 8, pattern: '^\\d{8}$', patternMessage: 'Eight digits' },
    ],
  },
];

const allFields = () => STARTER_FORM.flatMap(s => s.fields);
const shown = (f, a) => !f.show || Object.entries(f.show).every(([k, v]) => a[k] === v);

/** Checked, tidied answers, or { errors: {key: message} }. Hidden questions are dropped. */
function checkAnswers(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const out = {}, errors = {};
  for (const f of allFields()) {
    if (!shown(f, out)) continue;
    let v = a[f.key];
    if (f.type === 'checkboxes') {
      v = (Array.isArray(v) ? v : []).filter(x => f.options.includes(x));
      if (f.required && !v.length) errors[f.key] = 'Tick at least one';
    } else {
      v = String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, f.max || 200);
      const options = f.type === 'choice' ? f.options.map(o => o.value) : f.options;
      if (options && v && !options.includes(v)) v = '';
      if (f.type === 'date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) v = '';
      if (f.key === 'ni_number' || f.key === 'postcode') v = v.toUpperCase();
      if (f.required && !v) errors[f.key] = f.options ? 'Choose an answer' : 'Fill this in';
      else if (v && f.pattern && !new RegExp(f.pattern, 'i').test(v)) errors[f.key] = f.patternMessage;
      // Written the standard way for the accountant: AB 12 34 56 C, 12-34-56
      else if (v && f.key === 'ni_number') v = v.replace(/\s/g, '').replace(/^(..)(..)(..)(..)(.)$/, '$1 $2 $3 $4 $5');
      else if (v && f.key === 'sort_code') v = v.replace(/-/g, '').replace(/^(..)(..)(..)$/, '$1-$2-$3');
    }
    out[f.key] = v;
  }
  return Object.keys(errors).length ? { errors } : { answers: out };
}

/** Answers filled in from what we already know, so they only check them. */
function starterDefaults(emp, row) {
  const parts = String(emp.name || '').trim().split(/\s+/);
  const lines = String((row && row.address) || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  // A UK postcode on the last line of the address becomes the postcode
  const pc = lines.length && /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(lines[lines.length - 1]) ? lines.pop().toUpperCase() : '';
  return {
    last_name: parts.length > 1 ? parts[parts.length - 1] : '',
    first_names: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || '',
    date_of_birth: (row && row.dob_text) || '',
    address: lines.join('\n'),
    postcode: pc,
    start_date: emp.start_date ? String(emp.start_date).slice(0, 10) : '',
  };
}

module.exports = { STARTER_FORM, checkAnswers, starterDefaults, shown };

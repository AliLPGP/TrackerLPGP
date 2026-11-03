// The new starter form: answers are checked the way HMRC's checklist flows, and the
// accountant's PDF is made from them.
const assert = require('assert');
const { PDFDocument } = require('pdf-lib');
const { checkAnswers, starterDefaults } = require('../starter-form');
const { renderStarterPdf } = require('../starter-pdf');

const ok = {
  last_name: 'Example', first_names: 'Jane', gender: 'Female', date_of_birth: '1995-04-02', address: '1 Sample Street\nLondon',
  postcode: 'ab1 2cd', ni_number: 'ab 12 34 56 c', start_date: '2026-11-02', statement: 'A', loan: 'No',
  account_name: 'J Example', sort_code: '12-34-56', account_number: '12345678',
};

(async () => {
  const v = checkAnswers(ok);
  assert.ok(v.answers, JSON.stringify(v.errors));
  assert.strictEqual(v.answers.ni_number, 'AB 12 34 56 C');
  assert.strictEqual(checkAnswers({ ...ok, ni_number: 'ab123456c', sort_code: '123456' }).answers.ni_number, 'AB 12 34 56 C');
  assert.strictEqual(checkAnswers({ ...ok, sort_code: '123456' }).answers.sort_code, '12-34-56');
  assert.strictEqual(v.answers.postcode, 'AB1 2CD');
  assert.ok(!('loan_studying' in v.answers), 'no loan: the follow-up questions are not asked');

  // Missing and malformed answers come back by field
  const bad = checkAnswers({ ...ok, statement: 'D', sort_code: '1234', ni_number: 'nope' });
  assert.deepStrictEqual(Object.keys(bad.errors).sort(), ['ni_number', 'sort_code', 'statement']);

  // Student loans follow HMRC's order and stop when the rest does not apply
  assert.ok(checkAnswers({ ...ok, loan: 'Yes', loan_studying: 'Yes' }).answers, 'still studying: nothing more');
  assert.deepStrictEqual(Object.keys(checkAnswers({ ...ok, loan: 'Yes', loan_studying: 'No', loan_left: 'Yes', loan_direct: 'No' }).errors), ['loan_plans']);
  const plans = checkAnswers({ ...ok, loan: 'Yes', loan_studying: 'No', loan_left: 'Yes', loan_direct: 'No', loan_plans: ['Plan 2', 'Postgraduate Loan', 'Plan 9'] });
  assert.deepStrictEqual(plans.answers.loan_plans, ['Plan 2', 'Postgraduate Loan']);

  // What we already know is filled in, a UK postcode on the address's last line included
  const d = starterDefaults({ name: 'Jane Mary Example', start_date: '2026-11-02' }, { address: '1 Sample Street\nLondon\nAB1 2CD', dob_text: '1995-04-02' });
  assert.deepStrictEqual([d.first_names, d.last_name, d.postcode, d.address], ['Jane Mary', 'Example', 'AB1 2CD', '1 Sample Street\nLondon']);

  const pdf = await PDFDocument.load(await renderStarterPdf(plans.answers, { employeeName: 'Jane Example', signedName: 'Jane Example', signedAt: new Date() }));
  assert.ok(pdf.getPageCount() >= 2);
  console.log('starter form tests passed');
})().catch(e => { console.error(e); process.exit(1); });

'use strict';
// Wasteman's built-in answers, against a small made-up company
const assert = require('assert');
const { createLocalWasteman, understand } = require('../wasteman-local');

const emp = (id, name, extra = {}) => ({ id, name, job_title: '', department: '', employment_type: 'payroll', currency: 'GBP', annual_salary: 30000, active: 1,
  email: '', phone: '', working_pattern: 'full-time', start_date: '2024-01-08', termination_date: null, contract_end_date: null, probation_end_date: null, probation_review_done_at: null, ...extra });
const employees = [
  emp(1, 'Ali Example', { department: 'Sales', job_title: 'Sales Executive', email: 'ali@example.test' }),
  emp(2, 'Ali Other', { department: 'Production' }),
  emp(3, 'Sara Sample', { employment_type: 'self_employed', currency: 'AED', annual_salary: 36000, department: 'Sales' }),
  emp(4, 'Fidak Sample', { department: 'Production', annual_salary: 28500 }),
  emp(5, 'Gone Person', { active: 0, termination_date: '2026-06-30' }),
];
const row = (e, extra) => ({ employee_id: e.id, name: e.name, department: e.department, employment_type: e.employment_type, currency: e.currency, annual_salary: e.annual_salary,
  active: e.active, is_terminated: !e.active, start_date: e.start_date, termination_date: e.termination_date, net_monthly: null, total_paid: 0, net_remaining: 0, pct_paid: 0,
  payments: [], pay_months: null, total_days_off: 0, allowance_days: 20, excess_days: 0, excess_deduction: 0, total_office_deductions: 0, ...extra });
const month = (m, due, status) => ({ month: m, due, paid: status === 'paid', status, left: status === 'paid' ? 0 : due, logged: status === 'paid' ? due : 0 });
const paidTo = (upTo, amount) => Array.from({ length: upTo }, (_, i) => ({ payment_month: i + 1, payment_year: 2026, amount }));
const overview = [
  row(employees[0], { net_monthly: 2093.3, total_paid: 20933, net_remaining: 4186.6, pct_paid: 83, payments: paidTo(10, 2093.3),
    pay_months: [...Array.from({ length: 10 }, (_, i) => month(i + 1, 2093.3, 'paid')), month(11, 2093.3, 'due'), month(12, 2093.3, 'due')], total_days_off: 12 }),
  row(employees[1], { net_monthly: 2093.3, total_paid: 25119.6, net_remaining: 0, pct_paid: 100, payments: paidTo(12, 2093.3) }),
  row(employees[2], { total_paid: 30000, net_remaining: 6000, pct_paid: 83, payments: paidTo(10, 3000) }),
  row(employees[3], { net_monthly: 2003.3, total_paid: 22036.3, net_remaining: 2003.3, pct_paid: 92, payments: paidTo(11, 2003.3),
    pay_months: [...Array.from({ length: 11 }, (_, i) => month(i + 1, 2003.3, 'paid')), month(12, 2003.3, 'due')], total_days_off: 21, excess_days: 1, excess_deduction: 109.6 }),
  row(employees[4], {}),
];
const deals = [
  { id: 1, company: 'Northwind Capital', amount: 40000, currency: 'GBP', paid_inc_vat: 0, tax_vat: 0, fiscal_year: 2027, invoice_date: '2026-10-26', events: [{ event_name: 'Ops Summit Miami' }] },
  { id: 2, company: 'Harbour Bank', amount: 12000, currency: 'GBP', paid_inc_vat: 14400, tax_vat: 2400, fiscal_year: 2027, invoice_date: '2026-09-02', events: [{ event_name: 'Ops Summit Miami' }] },
];
const events = [
  { id: 1, name: 'Ops Summit Miami', event_date: '2027-05-06', location: 'Miami', date_tbc: '', programme_year: 2027, revenue_target: 60000, total_pipeline: 52000, total_won: 14400, deal_count: 2 },
  { id: 2, name: 'Private Debt Forum Berlin', event_date: '2027-03-18', location: 'Berlin', date_tbc: '', programme_year: 2027, revenue_target: null, total_pipeline: 0, total_won: 0, deal_count: 0 },
];
const db = {
  getSalaryOverview: async () => overview,
  getPortfolioEvents: async () => events,
  q: async sql => ({ rows: /FROM employees ORDER BY name/.test(sql) ? employees.map(e => ({ ...e }))
    : /FROM deals d/.test(sql) ? deals
    : /FROM hotel_expenses/.test(sql) ? [{ event_name: 'Berlin', hotel: 'Grand', paid_amount: 1000, cur: 'USD', status: 'paid', event_year: 2026 }, { event_name: 'Miami', hotel: 'Sands', paid_amount: 0, cur: 'USD', status: 'pending', event_year: 2026 }]
    : /FROM daily_records/.test(sql) ? [{ name: 'Sara Sample', department: 'Sales', day: '2026-11-17', is_day_off: 1 }]
    : [] }),
};
// rng fixed high: no openers, no quips, so the wording is the same every run
const ask = createLocalWasteman(db, { rng: () => 0.99, now: () => new Date('2026-11-11T10:00:00Z') });
const chat = async (...questions) => {
  const history = [], answers = [];
  for (const question of questions) { history.push({ role: 'user', content: question }); const a = await ask(history); history.push({ role: 'assistant', content: a }); answers.push(a); }
  return answers;
};
const has = (text, ...bits) => bits.forEach(b => assert.ok(text.includes(b), `expected "${b}" in: ${text}`));

(async () => {
  // What a question is about
  const world = { employees: employees.map(e => ({ ...e, active: !!e.active })), departments: ['Sales', 'Production'], today: '2026-11-11' };
  const topic = text => understand(text, world).topic;
  assert.deepStrictEqual(['How much does Sara have left to be paid this year?', "Who hasn't been paid this month?", "What's outstanding on hotel expenses?", 'who is off next week',
    'how many days off does sara have left', 'who still owes us on deals', 'how close are we to our targets', 'who are the highest paid in sales', 'what do we spend a year',
    'who left the company', 'what is sara on'].map(topic),
  ['payLeft', 'unpaid', 'hotels', 'daysoff', 'daysoff', 'deals', 'targets', 'salaryRank', 'spending', 'leavers', 'salary']);

  // Pay left: the months still to pay; follow-ups keep the question and swap the person
  let a = await chat('How much does Fidak have left to be paid this year?', 'and Sara?', 'how much has she been paid', 'what is she on');
  has(a[0], 'Fidak Sample has £2,003.30 left to be paid in 2026', 'December at £2,003.30', 'less £109.60 in deductions');
  has(a[1], 'Sara Sample has AED 6,000 left', 'out of AED 36,000');
  has(a[2], 'Sara Sample has been paid AED 30,000', '10 payments');
  has(a[3], 'AED 36,000 a year (self-employed)', 'AED 3,000 a month');

  // Two people share a first name: it asks, then answers
  a = await chat('how much does ali have left', 'Ali Example');
  has(a[0], 'I know 2 people called Ali', 'Ali Example (Sales Executive)', 'Which one?');
  has(a[1], 'Ali Example has £4,186.60 left', 'November and December at £2,093.30 each');

  // A misheard name is matched and said; an unknown one is not guessed
  has((await chat('how many days off has fidack taken'))[0], 'I took that as Fidak Sample', '21 of 20 days off', '1 over the allowance');
  has((await chat('how much does zorblax have left'))[0], 'could not find a person or a company called Zorblax');

  // Who has not been paid this month, with what each is due
  a = (await chat("Who hasn't been paid this month?"))[0];
  has(a, '2 people have not been paid for November', 'Ali Example: £2,093.30', 'Sara Sample: AED 3,000');
  assert.ok(!a.includes('Fidak'), 'someone paid for November is not listed');

  // Deals, a company and an event by name
  has((await chat('who still owes us on deals'))[0], 'Still to collect: £40,000 across 1 deal', 'Northwind Capital: £40,000');
  has((await chat('how much has harbour bank paid'))[0], 'Harbour Bank: 1 deal worth £12,000', 'nothing owed');
  has((await chat('how is the miami event doing'))[0], 'Ops Summit Miami: 6 May 2027, Miami', 'Target £60,000: 87% there, £8,000 to go');
  has((await chat('when is the next event'))[0], 'Private Debt Forum Berlin on 18 Mar 2027');

  // Staff, by department and by salary
  has((await chat('who are the highest paid in sales'))[0], '1. Ali Example: £30,000', '2. Sara Sample: AED 36,000 (about £7,709)');
  has((await chat('who is off next week'))[0], 'Off next week', '17 Nov 2026: Sara Sample');
  has((await chat("what's ali example's email"))[0], "Ali Example's email is ali@example.test");
  has((await chat("What's outstanding on hotel expenses?"))[0], 'Hotels for 2026: 2 events', '1 event is still to pay', 'Miami (Sands): not paid');

  // Small talk, sums, how-tos and the honest "I don't know"
  has((await chat('what is 20% of 40500'))[0], '8,100');
  has((await chat('how do I add a new employee'))[0], '+ Add employee');
  has((await chat('what is the weather like'))[0], 'could not work out what you are asking', 'Try things like');
  console.log('wasteman tests passed');
})().catch(e => { console.error(e); process.exit(1); });

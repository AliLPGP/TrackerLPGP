'use strict';
const assert = require('assert');
const { addMonths, corporationTax, vatPeriods, hmrcDeadlines } = require('../hmrc-deadlines');

assert.strictEqual(addMonths('2025-10-31', 9), '2026-07-31');
assert.strictEqual(addMonths('2026-02-28', 12), '2027-02-28');
assert.strictEqual(addMonths('2027-02-28', 12), '2028-02-29', 'a month end stays a month end in a leap year');
assert.strictEqual(addMonths('2026-05-15', 9), '2027-02-15');
assert.strictEqual(addMonths('2026-11-30', 3), '2027-02-28');

// Year to 31 October 2025: pay by 1 August 2026, return by 31 October 2026
assert.deepStrictEqual(corporationTax('2025-10-31'), { pay: '2026-08-01', file: '2026-10-31' });
assert.deepStrictEqual(corporationTax('2026-03-31'), { pay: '2027-01-01', file: '2027-03-31' });

// VAT quarters ending Mar/Jun/Sep/Dec: the quarter to 31 December is due 7 February
const q = vatPeriods('1', '2026-11-17');
assert.ok(q.some(p => p.period_end === '2026-12-31' && p.due === '2027-02-07'));
assert.ok(q.some(p => p.period_end === '2026-09-30' && p.due === '2026-11-07'));
assert.ok(vatPeriods('2', '2026-11-17').some(p => p.period_end === '2027-01-31' && p.due === '2027-03-07'));
assert.ok(vatPeriods('3', '2026-11-17').some(p => p.period_end === '2027-02-28' && p.due === '2027-04-07'));
assert.ok(vatPeriods('monthly', '2026-11-17').some(p => p.period_end === '2026-11-30' && p.due === '2027-01-07'));
assert.deepStrictEqual(vatPeriods('', '2026-11-17'), []);

// A company added on 17 November 2026 with a 31 October year end: last year's payment and
// return were due before it was added, so the ones shown are for the year just ended
let d = hmrcDeadlines({ yearEnd: '2025-10-31', since: '2026-11-17' });
assert.deepStrictEqual(d, [
  { kind: 'ct_pay', period_end: '2026-10-31', due: '2027-08-01' },
  { kind: 'ct_return', period_end: '2026-10-31', due: '2027-10-31' },
]);
// Companies House moving its dates on a year changes nothing here
assert.deepStrictEqual(hmrcDeadlines({ yearEnd: '2026-10-31', since: '2026-11-17' }), d);
// One that was due after the company was added stays, overdue, until it is ticked
d = hmrcDeadlines({ yearEnd: '2025-10-31', since: '2026-07-01' });
assert.deepStrictEqual(d.map(x => `${x.kind} ${x.due}`), ['ct_pay 2026-08-01', 'ct_return 2026-10-31']);
d = hmrcDeadlines({ yearEnd: '2025-10-31', since: '2026-07-01', done: new Set(['ct_pay|2026-08-01']) });
assert.deepStrictEqual(d.map(x => `${x.kind} ${x.due}`), ['ct_return 2026-10-31', 'ct_pay 2027-08-01'], 'ticked: the next year shows');
// VAT only when the admin has said which quarters, counted from when they said so
d = hmrcDeadlines({ yearEnd: '2025-10-31', since: '2026-01-01', vat: '1', vatSince: '2026-11-17' });
assert.deepStrictEqual(d.find(x => x.kind === 'vat'), { kind: 'vat', period_end: '2026-12-31', due: '2027-02-07' });
d = hmrcDeadlines({ since: '2026-11-17', vat: '1', done: new Set(['vat|2027-02-07']) });
assert.deepStrictEqual(d, [{ kind: 'vat', period_end: '2027-03-31', due: '2027-05-07' }], 'no year end: VAT alone, and the next quarter once ticked');
assert.deepStrictEqual(hmrcDeadlines({ since: '2026-11-17' }), []);

// A new company whose first accounts run 2 June 2025 to 30 June 2026: tax on the first
// twelve months (to 1 June 2026) is due 2 March 2027, the rest 1 April 2027; one return
d = hmrcDeadlines({ yearEnd: '2026-06-30', firstYearEnd: '2026-06-01', isFirstYear: true, since: '2026-11-17' });
assert.deepStrictEqual(d.map(x => `${x.kind} ${x.due}`), ['ct_pay 2027-03-02', 'ct_return 2027-06-30']);
d = hmrcDeadlines({ yearEnd: '2026-06-30', firstYearEnd: '2026-06-01', since: '2026-11-17', done: new Set(['ct_pay|2027-03-02']) });
assert.strictEqual(d[0].due, '2027-04-01');
// A company formed 21 October 2026 with first accounts to 31 October 2027 has no earlier year
d = hmrcDeadlines({ yearEnd: '2027-10-31', firstYearEnd: '2027-10-20', isFirstYear: true, since: '2026-11-17' });
assert.deepStrictEqual(d.map(x => `${x.kind} ${x.period_end} ${x.due}`), ['ct_pay 2027-10-20 2028-07-21', 'ct_return 2027-10-31 2028-10-31']);

console.log('hmrc deadline tests passed');

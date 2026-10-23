// Pure-function checks for the mid-year promotion maths; no database needed.
const assert = require('assert');
const { selfEmployedYearTarget } = require('../salary-periods');

const h = (from, annual, id) => ({ effective_from: from, annual_salary: annual, id });

// Never promoted: left to the existing calculation
assert.strictEqual(selfEmployedYearTarget({ history: [], year: 2026 }), null);
assert.strictEqual(selfEmployedYearTarget({ history: [h('2026-10-01', 33000, 1)], year: 2026 }), null);

// 30k -> 33k on 1 Oct: 9 x 2,500 + 3 x 2,750
assert.strictEqual(
  selfEmployedYearTarget({ history: [h('2000-01-01', 30000, 1), h('2026-10-01', 33000, 2)], year: 2026, startDate: '2024-03-01' }),
  30750
);

// Promoted before the year began: full year at the new rate
assert.strictEqual(
  selfEmployedYearTarget({ history: [h('2024-01-01', 30000, 1), h('2025-06-01', 33000, 2)], year: 2026, startDate: '2024-01-01' }),
  33000
);

// Mid-month change splits that month by working days (Oct 2026: 22 working days, 12 before the 19th, 10 from it)
const mid = selfEmployedYearTarget({ history: [h('2000-01-01', 30000, 1), h('2026-10-19', 33000, 2)], year: 2026 });
const expected = 9 * 2500 + 2500 * (12 / 22) + 2750 * (10 / 22) + 2 * 2750;
assert.ok(Math.abs(mid - expected) < 0.02, `${mid} vs ${expected}`);

// Started mid-year and promoted later: only months worked count
assert.strictEqual(
  selfEmployedYearTarget({ history: [h('2026-07-01', 24000, 1), h('2026-10-01', 36000, 2)], year: 2026, startDate: '2026-07-01' }),
  3 * 2000 + 3 * 3000
);

console.log('salary tests passed');

// ── Bank holidays and working-day counting ──
const { ukBankHolidays, easterSunday, splitWorkingDays } = require('../holidays');
const dates = y => ukBankHolidays(y).map(h => h.date);

assert.strictEqual(easterSunday(2026), '2026-04-05');
assert.strictEqual(easterSunday(2027), '2027-03-28');
assert.deepStrictEqual(dates(2026), ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28']);
// 25 Dec 2027 is a Saturday: Christmas and Boxing Day both move to the Mon/Tue after
assert.deepStrictEqual(dates(2027), ['2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28']);
// 25 Dec 2022 is a Sunday: Boxing Day stays Monday, Christmas moves to Tuesday
assert.ok(dates(2022).includes('2022-12-26') && dates(2022).includes('2022-12-27'));
// 2022 Jubilee: spring bank holiday moved, extra day, funeral
assert.ok(!dates(2022).includes('2022-05-30') && dates(2022).includes('2022-06-02') && dates(2022).includes('2022-06-03') && dates(2022).includes('2022-09-19'));
assert.ok(dates(2023).includes('2023-05-08'));
// 1 Jan 2028 is a Saturday: New Year's Day moves to Monday the 3rd
assert.ok(dates(2028).includes('2028-01-03'));

// Monday to Monday over Easter 2026 (30 Mar - 6 Apr): Good Friday, the weekend and
// Easter Monday are all left out, so only Mon-Thu count
const bh = Object.fromEntries(ukBankHolidays(2026).map(h => [h.date, h.name]));
const span = splitWorkingDays('2026-03-30', '2026-04-06', bh);
assert.deepStrictEqual(span.working, ['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02']);
assert.strictEqual(span.skipped.length, 4); // Fri bank hol, Sat, Sun, Mon bank hol
// Plain Monday to Monday: 6 working days (Mon-Fri + the closing Monday), weekend skipped
const plain = splitWorkingDays('2026-10-05', '2026-10-12', {});
assert.strictEqual(plain.working.length, 6);
assert.deepStrictEqual(plain.skipped.map(s => s.date), ['2026-10-10', '2026-10-11']);
assert.deepStrictEqual(splitWorkingDays('2026-10-10', '2026-10-11', {}).working, []);
assert.deepStrictEqual(splitWorkingDays('2026-10-12', '2026-10-05', {}).working, []);

console.log('holiday tests passed');

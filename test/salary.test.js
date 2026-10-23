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

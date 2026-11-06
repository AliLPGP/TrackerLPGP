'use strict';
// Payroll: each month owed in full at the salary in force; months not paid are what is left
const assert = require('assert');
const { payrollMonths } = require('../salary-periods');

const net = a => a / 12; // keep the arithmetic readable: take-home = gross / 12
// Started 1 Aug on 18k (probation), 28.5k from 1 Oct
const history = [{ effective_from: '2026-08-01', annual_salary: 18000 }, { effective_from: '2026-10-01', annual_salary: 28500 }];
const months = payrollMonths({ history, year: 2026, startDate: '2026-08-01', endDate: null, annual: 28500, netMonthly: net });
assert.deepStrictEqual(months.map(m => m.month), [8, 9, 10, 11, 12], 'August to December');
assert.deepStrictEqual(months.map(m => m.due), [1500, 1500, 2375, 2375, 2375], 'probation rate, then the new salary');
const paid = new Set([8, 9, 10]);
const left = months.filter(m => !paid.has(m.month)).reduce((a, m) => a + m.due, 0);
assert.strictEqual(left, 4750, 'November and December still to pay, at 28.5k');

// Never changed salary, all year: twelve equal months
const flat = payrollMonths({ history: [], year: 2026, startDate: '2024-05-01', endDate: null, annual: 24000, netMonthly: net });
assert.strictEqual(flat.length, 12); assert.ok(flat.every(m => m.due === 2000));

// Left on 15 May: May is part of a month (by working days); nothing after
const leaver = payrollMonths({ history: [], year: 2026, startDate: '2024-05-01', endDate: '2026-05-15', annual: 24000, netMonthly: net });
assert.deepStrictEqual(leaver.map(m => m.month), [1, 2, 3, 4, 5]);
assert.ok(leaver[4].due > 0 && leaver[4].due < 2000, 'May is part paid');

// Salary changed mid-month: that month is split by working days
const mid = payrollMonths({ history: [{ effective_from: '2025-01-01', annual_salary: 24000 }, { effective_from: '2026-06-15', annual_salary: 36000 }],
  year: 2026, startDate: '2025-01-01', endDate: null, annual: 36000, netMonthly: net });
const june = mid.find(m => m.month === 6).due;
assert.ok(june > 2000 && june < 3000, 'June is between the two monthly amounts');
assert.strictEqual(mid.find(m => m.month === 7).due, 3000);

console.log('payroll months tests passed');

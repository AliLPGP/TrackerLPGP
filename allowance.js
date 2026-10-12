'use strict';
// The day-off allowance for one year, pro-rated to the part of that year the
// person is employed: the annual allowance / 12 for each month (1.6667 a month
// on payroll). A month they only partly work counts to the nearest half month,
// so starting on 12 May counts as half of May plus June-December = 7.5 months
// = 12.5 days. The result is rounded to the nearest half day.
function isoDay(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}
function monthsEmployedIn(year, startIso, endIso) {
  let months = 0;
  for (let m = 1; m <= 12; m++) {
    const dim = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const first = `${year}-${String(m).padStart(2, '0')}-01`;
    const last = `${year}-${String(m).padStart(2, '0')}-${String(dim).padStart(2, '0')}`;
    const from = startIso && startIso > first ? startIso : first;
    const to = endIso && endIso < last ? endIso : last;
    if (from > to) continue;
    const days = Number(to.slice(8, 10)) - Number(from.slice(8, 10)) + 1;
    const frac = days / dim;
    months += frac >= 1 ? 1 : Math.round(frac * 2) / 2;
  }
  return months;
}
function allowanceFor(emp, year, perYear = { payroll: 20, self_employed: 5 }) {
  const annual = perYear[emp.employment_type] || 20;
  const y = parseInt(year, 10);
  if (!Number.isInteger(y)) return annual;
  const months = monthsEmployedIn(y, isoDay(emp.start_date), isoDay(emp.termination_date));
  return Math.round(annual * months / 12 * 2) / 2;
}

module.exports = { allowanceFor, monthsEmployedIn };

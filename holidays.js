'use strict';
// Bank holidays for England & Wales, worked out from the calendar rules so
// nothing needs fetching or yearly updating, plus the working-day counting the
// staff portal uses for holiday requests (weekends and bank holidays never
// count against anyone's allowance).
//
// One-off extra days (a royal event, a company closure) and other countries'
// holidays are added by an admin and merged in by the caller.

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sun
const addDays = (isoDate, n) => new Date(Date.parse(isoDate + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// Anonymous Gregorian algorithm
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

const firstMonday = (y, m) => iso(y, m, 1 + ((8 - dow(y, m, 1)) % 7));
function lastMonday(y, m) {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return iso(y, m, last - ((dow(y, m, last) + 6) % 7));
}

// Days the government moved or added, which the rules above would get wrong
const SPECIAL = {
  2022: {
    drop: ['2022-05-30'],            // spring bank holiday moved for the Jubilee
    add: [['2022-06-02', 'Spring bank holiday (moved)'], ['2022-06-03', 'Platinum Jubilee bank holiday'], ['2022-09-19', 'State Funeral of Queen Elizabeth II']],
  },
  2023: { add: [['2023-05-08', 'Coronation of King Charles III']] },
};

function ukBankHolidays(year) {
  const y = Number(year);
  const list = [];
  // New Year's Day: a weekend falls to the next Monday
  const ny = dow(y, 1, 1);
  list.push([ny === 6 ? iso(y, 1, 3) : ny === 0 ? iso(y, 1, 2) : iso(y, 1, 1), "New Year's Day"]);
  const easter = easterSunday(y);
  list.push([addDays(easter, -2), 'Good Friday']);
  list.push([addDays(easter, 1), 'Easter Monday']);
  list.push([firstMonday(y, 5), 'Early May bank holiday']);
  list.push([lastMonday(y, 5), 'Spring bank holiday']);
  list.push([lastMonday(y, 8), 'Summer bank holiday']);
  // Christmas and Boxing Day: whichever lands on a weekend moves to the next free weekday
  const xmas = dow(y, 12, 25);
  if (xmas === 6) { list.push([iso(y, 12, 27), 'Christmas Day (substitute)'], [iso(y, 12, 28), 'Boxing Day (substitute)']); }
  else if (xmas === 0) { list.push([iso(y, 12, 27), 'Christmas Day (substitute)'], [iso(y, 12, 26), 'Boxing Day']); }
  else if (xmas === 5) { list.push([iso(y, 12, 25), 'Christmas Day'], [iso(y, 12, 28), 'Boxing Day (substitute)']); }
  else { list.push([iso(y, 12, 25), 'Christmas Day'], [iso(y, 12, 26), 'Boxing Day']); }

  const special = SPECIAL[y];
  let out = list;
  if (special) {
    out = out.filter(([d]) => !(special.drop || []).includes(d));
    out = out.concat(special.add || []);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0])).map(([date, name]) => ({ date, name }));
}

// Region an employee's holidays follow, from the currency they are paid in
const REGION_BY_CURRENCY = { GBP: 'GB', AED: 'AE', PHP: 'PH' };
const regionFor = emp => REGION_BY_CURRENCY[emp && emp.currency] || 'GB';

// Built-in holidays for a region and year (only England & Wales is built in)
function builtInHolidays(region, year) {
  return region === 'GB' ? ukBankHolidays(year).map(h => ({ ...h, region: 'GB', builtin: true })) : [];
}

// The working days in [start, end] (inclusive, ISO dates), and the days left out and why.
// holidays: Map or object of ISO date -> name.
function splitWorkingDays(start, end, holidays = {}) {
  const lookup = holidays instanceof Map ? d => holidays.get(d) : d => holidays[d];
  const working = [], skipped = [];
  if (!start || !end || end < start) return { working, skipped };
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const day = new Date(d + 'T00:00:00Z').getUTCDay();
    if (day === 0 || day === 6) skipped.push({ date: d, reason: day === 6 ? 'Saturday' : 'Sunday', weekend: true });
    else if (lookup(d)) skipped.push({ date: d, reason: lookup(d), bank_holiday: true });
    else working.push(d);
    if (working.length + skipped.length > 400) break; // a year and a bit is plenty
  }
  return { working, skipped };
}

module.exports = { ukBankHolidays, easterSunday, builtInHolidays, regionFor, splitWorkingDays, addDays };

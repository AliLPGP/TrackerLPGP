'use strict';
// HMRC deadlines for a company. HMRC publishes nothing about a company, so these are
// worked out from the rules rather than read from anywhere:
//
//   Corporation tax payment   9 months and 1 day after the accounting period ends
//   Company tax return        12 months after the accounting period ends
//   VAT return and payment    1 month and 7 days after the VAT period ends
//
// The accounting period is taken to be the company's accounts year (the "made up to"
// date at Companies House). A new company's first accounts often cover more than twelve
// months; a corporation tax period cannot, so the tax for the first twelve months is due
// earlier, on its own date (`firstYearEnd`), while the return keeps the accounts date. VAT periods depend on the quarters HMRC gave the company,
// which the admin picks (`vat`): quarters ending Mar/Jun/Sep/Dec ('1'), Jan/Apr/Jul/Oct
// ('2') or Feb/May/Aug/Nov ('3'), or 'monthly'.
//
// Nobody can tell from outside whether one was paid or filed, so the admin ticks each
// off (`done`, a set of "kind|due") and the next one then shows. Deadlines from before
// the tracker started watching (`since`) are taken as dealt with, so adding a company
// does not raise alarms about last year.
const day = iso => new Date(iso + 'T00:00:00Z');
const iso = d => d.toISOString().slice(0, 10);
const lastOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();   // m: 0-11, may overflow
const addDays = (date, n) => iso(new Date(day(date).getTime() + n * 86400000));

// n months on. A month end stays a month end (31 Oct + 9 months = 31 Jul, 28 Feb + 12 = 28/29 Feb)
function addMonths(date, n) {
  const d = day(date), y = d.getUTCFullYear(), m = d.getUTCMonth(), dd = d.getUTCDate();
  const end = lastOfMonth(y, m + n);
  return iso(new Date(Date.UTC(y, m + n, dd === lastOfMonth(y, m) ? end : Math.min(dd, end))));
}

const corporationTax = periodEnd => ({ pay: addDays(addMonths(periodEnd, 9), 1), file: addMonths(periodEnd, 12) });

const VAT_MONTHS = { 1: [3, 6, 9, 12], 2: [1, 4, 7, 10], 3: [2, 5, 8, 11], monthly: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] };
// VAT period ends from a year before `from`, oldest first, each with the date it is due by
function vatPeriods(vat, from, count = 30) {
  const months = VAT_MONTHS[vat];
  if (!months) return [];
  const out = [], start = day(from);
  for (let y = start.getUTCFullYear() - 1, m = start.getUTCMonth(); out.length < count; m++) {
    if (!months.includes(((m % 12) + 12) % 12 + 1)) continue;
    const end = iso(new Date(Date.UTC(y, m + 1, 0)));
    out.push({ period_end: end, due: addDays(addMonths(end, 1), 7) });
  }
  return out;
}

// The open HMRC deadlines of one company, soonest first:
// [{ kind: 'ct_pay' | 'ct_return' | 'vat', due, period_end }]
function hmrcDeadlines({ yearEnd, firstYearEnd, isFirstYear, vat, vatSince, since, done = new Set() }) {
  const open = (kind, list, from) => { const d = list.find(x => x.due >= from && !done.has(`${kind}|${x.due}`)); return d ? [{ kind, ...d }] : []; };
  // Years before `yearEnd` are looked at too, in case one is still open, unless there were none (`isFirstYear`)
  const years = yearEnd ? Array.from({ length: 12 }, (_, k) => addMonths(yearEnd, 12 * (k - (isFirstYear ? 0 : 2)))) : [];
  return [
    ...open('ct_pay', [...(firstYearEnd ? [firstYearEnd] : []), ...years].map(e => ({ period_end: e, due: corporationTax(e).pay })).sort((a, b) => a.due.localeCompare(b.due)), since),
    ...open('ct_return', years.map(e => ({ period_end: e, due: corporationTax(e).file })), since),
    ...(vat ? open('vat', vatPeriods(vat, vatSince || since), vatSince || since) : []),
  ].sort((a, b) => a.due.localeCompare(b.due));
}

module.exports = { addMonths, addDays, corporationTax, vatPeriods, hmrcDeadlines, VAT_MONTHS };

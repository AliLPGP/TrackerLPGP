'use strict';
// What a self-employed person is owed for one year when their salary changed
// part-way through it. Each month is paid at the salary in force, and a month
// that holds a change is split by working days (Mon-Fri), so 30k -> 33k from
// 1 October is 9 x 2,500 + 3 x 2,750 = 30,750 for the year: +250 a month from
// the effective date, not 3,000 more for months already worked.
//
// Returns null unless the history shows at least two salaries, so people who
// were never promoted keep the existing calculation untouched.
function iso(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

function workdaysBetween(a, b) {
  let n = 0;
  const end = Date.parse(b + 'T00:00:00Z');
  for (let t = Date.parse(a + 'T00:00:00Z'); t <= end; t += 86400000) {
    const dow = new Date(t).getUTCDay();
    if (dow >= 1 && dow <= 5) n++;
  }
  return n;
}

function periodsFrom(history) {
  const rows = (history || [])
    .filter(h => h && h.effective_from && Number.isFinite(parseFloat(h.annual_salary)))
    .map(h => ({ from: iso(h.effective_from), annual: parseFloat(h.annual_salary), id: h.id || 0 }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.id - b.id);
  // Two entries on one day: the later one wins
  return rows.filter((p, i) => !rows[i + 1] || rows[i + 1].from !== p.from);
}

// The annual salary in force on a given day. With fewer than two salaries on record
// there is no timeline to follow, so the caller's current salary stands.
function salaryOnDate(history, day, fallback) {
  const periods = periodsFrom(history);
  if (periods.length < 2) return fallback;
  let cur = periods[0].annual;
  for (const p of periods) { if (p.from <= day) cur = p.annual; else break; }
  return cur;
}

// The salary bands that make up a year, for showing how a target was worked out:
// [{from, to, annual, monthly}] clipped to the days the person was employed that year.
// Empty unless the salary actually changed within that window.
function payBands({ history, year, startDate, endDate }) {
  const periods = periodsFrom(history);
  if (periods.length < 2) return [];
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const start = iso(startDate), end = iso(endDate);
  const winFrom = start && start > yStart ? start : yStart;
  const winTo = end && end < yEnd ? end : yEnd;
  const bands = [];
  periods.forEach((p, i) => {
    const nextFrom = periods[i + 1] ? addDay(periods[i + 1].from, -1) : '9999-12-31';
    const from = i === 0 ? winFrom : (p.from > winFrom ? p.from : winFrom);
    const to = nextFrom < winTo ? nextFrom : winTo;
    if (from <= to) bands.push({ from, to, annual: p.annual, monthly: parseFloat((p.annual / 12).toFixed(2)) });
  });
  return bands.length > 1 ? bands : [];
}

function addDay(isoDate, n) {
  return new Date(Date.parse(isoDate + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

function selfEmployedYearTarget({ history, year, startDate, endDate }) {
  const periods = periodsFrom(history);
  if (periods.length < 2) return null;

  const salaryOn = day => salaryOnDate(history, day, periods[0].annual);
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const start = iso(startDate), end = iso(endDate);
  const winFrom = start && start > yStart ? start : yStart;
  const winTo = end && end < yEnd ? end : yEnd;
  const changes = periods.slice(1).map(p => p.from);

  let total = 0;
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const dim = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const first = `${year}-${mm}-01`, last = `${year}-${mm}-${String(dim).padStart(2, '0')}`;
    const from = winFrom > first ? winFrom : first;
    const to = winTo < last ? winTo : last;
    if (from > to) continue;
    const monthDays = workdaysBetween(first, last);
    if (!monthDays) continue;
    // Cut the span wherever a salary change lands inside it
    const cuts = changes.filter(c => c > from && c <= to);
    let segFrom = from;
    for (const edge of [...cuts, null]) {
      const segTo = edge ? new Date(Date.parse(edge + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10) : to;
      if (segFrom <= segTo) total += (salaryOn(segFrom) / 12) * (workdaysBetween(segFrom, segTo) / monthDays);
      if (edge) segFrom = edge;
    }
  }
  return parseFloat(total.toFixed(2));
}

module.exports = { selfEmployedYearTarget, periodsFrom, workdaysBetween, salaryOnDate, payBands };

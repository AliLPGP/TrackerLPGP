'use strict';

/**
 * The confirmed 2027 programme.
 *
 * Source: "Events by Producer", the producer allocation for next year's
 * calendar, updated 28 September 2026. 25 events across 5 producer teams.
 * This is the list a deal is allocated against and the list the sales CRM
 * reads over the bridge; it is transcribed here once and nowhere else.
 *
 * Each event carries a stable `key`. Once a portfolio_events row is linked to
 * a key (see /api/programme/2027), renaming, re-dating or re-running the load
 * finds the same row again rather than guessing from its name -- so a deal
 * allocated to "OPS Miami" in September stays allocated after that row becomes
 * "2nd Annual Operating Partners Miami" in October.
 *
 * Dates: an exact day is stored as given. A month with the day still TBC is
 * stored as the 1st of that month with `tbc: 'day'`, and the UI says so
 * rather than showing a made-up 1st. No month at all is `date: null` with
 * `tbc: 'date'`; `year` keeps it filed under 2027 regardless.
 *
 * Series ids match the sales CRM's events catalogue, so the two apps agree on
 * which programme an event belongs to.
 */

const PROGRAMME_YEAR = 2027;

const PRODUCERS = ['Gio & Karam', 'Tara & Maryam', 'Fidak', 'Santos', 'Arj & Leena'];

// One CFO/COO portfolio: the Private Markets, Private Equity and Private Debt
// CFO/COO conferences are one series, not three. The order below is the
// display order in every chart, and it is not the order of importance: it is
// the one order in which each neighbouring pair of series hues stays apart
// under red-green colour blindness (validated with the dataviz palette
// checker on both apps' light and dark card surfaces). Every series keeps the
// hue it had, so nobody has to relearn which colour is which.
const SERIES = {
  'private-debt':       { code: '01', name: 'Private Debt Fundraising Series',      short: 'Private Debt',        chart: 1 },
  'cfo-coo':            { code: '02', name: 'CFO / COO Series',                     short: 'CFO / COO',           chart: 2 },
  'operational-fund':   { code: '03', name: 'Operational Fund Summit Series',       short: 'Operational Fund',    chart: 7 },
  'operating-partners': { code: '04', name: 'Operating Partners Conference Series', short: 'Operating Partners',  chart: 5 },
  'data-tech':          { code: '05', name: 'Data & Technology Forum Series',       short: 'Data & Technology',   chart: 6 },
};

// Ids that earlier versions of both apps stored. They all fold into the one
// CFO/COO series; anything still carrying them reads correctly.
const LEGACY_SERIES = { 'cfo-private-markets': 'cfo-coo', 'cfo-pe-debt': 'cfo-coo', 'cfo-pe': 'cfo-coo' };
function normaliseSeries(id) {
  if (!id) return null;
  if (SERIES[id]) return id;
  return LEGACY_SERIES[id] || null;
}

// key, name, producer, series, location, date (YYYY-MM-DD or null), tbc ('' | 'day' | 'date')
const EVENTS = [
  // Gio & Karam -- 6
  { key: 'ops-miami',           name: '2nd Annual Operating Partners Miami',                                  producer: 'Gio & Karam',   series: 'operating-partners',  location: 'Miami, USA',          date: '2027-02-25', tbc: '' },
  { key: 'dt-new-york',         name: '3rd Annual AI, Data & Technology in Private Markets New York',         producer: 'Gio & Karam',   series: 'data-tech',           location: 'New York, USA',       date: '2027-05-20', tbc: '' },
  { key: 'ops-west-coast',      name: '3rd Annual Operating Partners West Coast - Los Angeles',               producer: 'Gio & Karam',   series: 'operating-partners',  location: 'Los Angeles, USA',    date: '2027-09-01', tbc: 'day' },
  { key: 'dt-london',           name: '3rd Annual AI, Data & Technology in Private Markets London',           producer: 'Gio & Karam',   series: 'data-tech',           location: 'London, UK',          date: '2027-10-06', tbc: '' },
  { key: 'sports-london',       name: '2nd Annual Sports Investing Forum London',                             producer: 'Gio & Karam',   series: 'private-debt',        location: 'London, UK',          date: null,         tbc: 'date' },
  { key: 'sports-new-york',     name: 'Sports Investing Forum New York',                                      producer: 'Gio & Karam',   series: 'private-debt',        location: 'New York, USA',       date: null,         tbc: 'date' },

  // Tara & Maryam -- 5
  { key: 'dt-europe',           name: 'AI, Data & Technology in Private Markets Europe - Amsterdam',          producer: 'Tara & Maryam', series: 'data-tech',           location: 'Amsterdam, Netherlands', date: '2027-04-15', tbc: '' },
  { key: 'ops-new-york',        name: '3rd Annual Operating Partners New York',                               producer: 'Tara & Maryam', series: 'operating-partners',  location: 'New York, USA',       date: '2027-05-19', tbc: '' },
  { key: 'dt-west-coast',       name: 'AI, Data & Technology in Private Markets West Coast - San Francisco',  producer: 'Tara & Maryam', series: 'data-tech',           location: 'San Francisco, USA',  date: '2027-06-24', tbc: '' },
  { key: 'ops-europe',          name: 'Operating Partners Europe - London',                                   producer: 'Tara & Maryam', series: 'operating-partners',  location: 'London, UK',          date: '2027-10-06', tbc: '' },
  { key: 'ops-retreat',         name: 'Operating Partners Retreat',                                           producer: 'Tara & Maryam', series: 'operating-partners',  location: '',                    date: '2027-11-01', tbc: 'day' },

  // Fidak -- 5
  { key: 'cfo-pm-miami',        name: '4th Annual CFO/COO Private Markets Miami',                             producer: 'Fidak',         series: 'cfo-coo', location: 'Miami, USA',          date: '2027-05-01', tbc: 'day' },
  { key: 'cfo-pd-london',       name: '9th Annual CFO/COO Private Debt London',                               producer: 'Fidak',         series: 'cfo-coo',                location: 'London, UK',          date: '2027-07-01', tbc: 'day' },
  { key: 'cfo-pm-los-angeles',  name: '4th Annual CFO/COO Private Markets Los Angeles',                       producer: 'Fidak',         series: 'cfo-coo', location: 'Los Angeles, USA',    date: '2027-10-01', tbc: 'day' },
  { key: 'cfo-pm-chicago',      name: '9th Annual CFO/COO Private Markets Chicago',                           producer: 'Fidak',         series: 'cfo-coo', location: 'Chicago, USA',        date: '2027-10-01', tbc: 'day' },
  { key: 'cfo-pd-new-york',     name: '8th Annual CFO/COO Private Debt New York',                             producer: 'Fidak',         series: 'cfo-coo',                location: 'New York, USA',       date: '2027-11-01', tbc: 'day' },

  // Santos -- 5
  { key: 'cfo-pm-switzerland',  name: '4th Annual CFO/COO Private Markets Switzerland',                       producer: 'Santos',        series: 'cfo-coo', location: 'Switzerland',         date: '2027-03-18', tbc: '' },
  { key: 'cfo-pm-san-francisco',name: '5th Annual CFO/COO Private Markets San Francisco',                     producer: 'Santos',        series: 'cfo-coo', location: 'San Francisco, USA',  date: '2027-06-01', tbc: 'day' },
  { key: 'cfo-pe-london',       name: '9th Annual CFO/COO Private Equity London',                             producer: 'Santos',        series: 'cfo-coo',                location: 'London, UK',          date: '2027-07-01', tbc: 'day' },
  { key: 'cfo-pe-new-york',     name: '8th Annual CFO/COO Private Equity New York',                           producer: 'Santos',        series: 'cfo-coo',                location: 'New York, USA',       date: '2027-11-01', tbc: 'day' },
  { key: 'ofs-luxembourg',      name: 'Operational Fund Summit Luxembourg',                                   producer: 'Santos',        series: 'operational-fund',    location: 'Luxembourg',          date: '2027-11-01', tbc: 'day' },

  // Arj & Leena -- 4
  { key: 'pd-berlin',           name: '11th Annual Private Debt Berlin',                                      producer: 'Arj & Leena',   series: 'private-debt',        location: 'Berlin, Germany',     date: '2027-03-18', tbc: '' },
  { key: 'pd-new-york',         name: '13th Annual Private Debt New York',                                    producer: 'Arj & Leena',   series: 'private-debt',        location: 'New York, USA',       date: '2027-04-01', tbc: 'day' },
  { key: 'pd-london',           name: '13th Annual Private Debt London',                                      producer: 'Arj & Leena',   series: 'private-debt',        location: 'London, UK',          date: '2027-09-01', tbc: 'day' },
  { key: 'pd-chicago',          name: '12th Annual Private Debt Chicago',                                     producer: 'Arj & Leena',   series: 'private-debt',        location: 'Chicago, USA',        date: '2027-10-01', tbc: 'day' },
];

/** Not in next year's programme. Listed so nobody re-creates it by hand. */
const NOT_RUNNING = ['4th Annual Private Debt Los Angeles'];

// Sanity at load: the PDF says 25 across 5 teams with these counts.
const COUNTS = { 'Gio & Karam': 6, 'Tara & Maryam': 5, 'Fidak': 5, 'Santos': 5, 'Arj & Leena': 4 };
(function verify() {
  if (EVENTS.length !== 25) throw new Error(`programme-2027: expected 25 events, have ${EVENTS.length}`);
  const keys = new Set();
  for (const e of EVENTS) {
    if (keys.has(e.key)) throw new Error(`programme-2027: duplicate key ${e.key}`);
    keys.add(e.key);
    if (!PRODUCERS.includes(e.producer)) throw new Error(`programme-2027: unknown producer ${e.producer}`);
    if (!SERIES[e.series]) throw new Error(`programme-2027: unknown series ${e.series}`);
    if (e.date && !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error(`programme-2027: bad date on ${e.key}`);
    if (!e.date && e.tbc !== 'date') throw new Error(`programme-2027: ${e.key} has no date but is not marked tbc`);
  }
  for (const [p, n] of Object.entries(COUNTS)) {
    const have = EVENTS.filter((e) => e.producer === p).length;
    if (have !== n) throw new Error(`programme-2027: ${p} should have ${n} events, has ${have}`);
  }
})();

/** `2027:ops-miami` -- the value stored in portfolio_events.programme_key. */
function programmeKey(e) {
  return `${PROGRAMME_YEAR}:${e.key}`;
}

/**
 * The words a human would use to recognise this event in a shorthand name
 * like "OPS Miami" or "PD NYC (Womens)". Used only to *suggest* an existing
 * row for a canonical event; a person confirms every match.
 */
const CITY_ALIASES = {
  'new york': ['new york', 'nyc', 'ny'],
  'london': ['london', 'ldn'],
  'los angeles': ['los angeles', 'la', 'west coast'],
  'san francisco': ['san francisco', 'sanfran', 'sf', 'west coast'],
  'miami': ['miami'],
  'chicago': ['chicago', 'chi'],
  'berlin': ['berlin'],
  'amsterdam': ['amsterdam', 'europe'],
  'switzerland': ['switzerland', 'zurich', 'geneva', 'swiss'],
  'luxembourg': ['luxembourg', 'lux'],
};
const SERIES_ALIASES = {
  'operating-partners': ['operating partners', 'ops', 'op summit'],
  'data-tech':          ['data', 'tech', 'ai'],
  'private-debt':       ['private debt', 'pd', 'sports'],
  'cfo-coo':            ['cfo', 'coo', 'private markets'],
  'operational-fund':   ['operational fund', 'ofs', 'lux'],
};

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}
function hasPhrase(hay, phrase) {
  const h = ' ' + tokens(hay).join(' ') + ' ';
  return h.includes(' ' + tokens(phrase).join(' ') + ' ');
}

/**
 * How strongly an existing row looks like this canonical event.
 * Month agreement, a recognised city, and a recognised series word each count;
 * a different month in the same year counts against. Purely a ranking aid.
 */
function seriesWords(canon) {
  if (/sports investing/i.test(canon.name)) return ['sports'];
  return SERIES_ALIASES[canon.series] || [];
}

function suggestionScore(canon, row) {
  const name = `${row.name || ''} ${row.location || ''}`;
  let score = 0;

  const cityKey = Object.keys(CITY_ALIASES).find((c) => hasPhrase(canon.location, c) || hasPhrase(canon.name, c));
  if (cityKey && CITY_ALIASES[cityKey].some((a) => hasPhrase(name, a))) score += 3;

  const sWords = seriesWords(canon);
  if (sWords.some((w) => hasPhrase(name, w))) score += 2;

  // Private Debt vs CFO/COO Private Debt: the CFO word decides.
  const canonIsCfo = /\bcfo\b/i.test(canon.name);
  const rowIsCfo = /\bcfo\b/i.test(name);
  if (canonIsCfo !== rowIsCfo) score -= 2;

  if (canon.date && row.event_date) {
    const cm = canon.date.slice(0, 7);
    const rm = String(row.event_date).slice(0, 7);
    if (cm === rm) score += 2;
    else if (cm.slice(0, 4) === rm.slice(0, 4)) score -= 1;
  }
  return score;
}

/**
 * For every canonical event, the existing 2027 row it most likely already is.
 * Rows already linked by programme_key are matched by key and never
 * re-suggested elsewhere. Anything under the score floor gets no suggestion,
 * and the panel offers "create" instead.
 */
function reconcile(existingRows) {
  const SUGGEST_FLOOR = 4;
  const byKey = new Map();
  for (const r of existingRows) if (r.programme_key) byKey.set(r.programme_key, r);

  const candidates = existingRows.filter((r) => {
    if (r.programme_key) return false;
    const y = r.programme_year || (r.event_date ? Number(String(r.event_date).slice(0, 4)) : null);
    return y === PROGRAMME_YEAR;
  });

  // Every (event, row) pair above the floor, best first, then take each pair
  // only if neither side is spoken for. This way "PD NYC" goes to the Private
  // Debt New York event it matches on three counts, not to the Sports forum
  // that merely shares its city and happened to be listed earlier.
  const unlinked = EVENTS.filter((c) => !byKey.has(programmeKey(c)));
  const pairs = [];
  for (const canon of unlinked) {
    for (const r of candidates) {
      const s = suggestionScore(canon, r);
      if (s >= SUGGEST_FLOOR) pairs.push({ canon, row: r, score: s });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const chosen = new Map();   // canon.key -> { row, score }
  const takenRows = new Set();
  for (const pr of pairs) {
    if (chosen.has(pr.canon.key) || takenRows.has(pr.row.id)) continue;
    chosen.set(pr.canon.key, { row: pr.row, score: pr.score });
    takenRows.add(pr.row.id);
  }

  return EVENTS.map((canon) => {
    const key = programmeKey(canon);
    const linked = byKey.get(key);
    if (linked) {
      return { ...canon, programme_key: key, status: 'linked', row: linked, suggestion: null, score: null };
    }
    const best = chosen.get(canon.key) || null;
    return {
      ...canon,
      programme_key: key,
      status: best ? 'suggested' : 'missing',
      row: null,
      suggestion: best ? best.row : null,
      score: best ? best.score : null,
    };
  });
}

module.exports = { PROGRAMME_YEAR, PRODUCERS, SERIES, LEGACY_SERIES, normaliseSeries, EVENTS, NOT_RUNNING, programmeKey, reconcile, suggestionScore };

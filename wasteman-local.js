'use strict';
// Wasteman's built-in brain: answers questions from the tracker's own data, with no AI
// service and no key. It works out what a question is about (pay, days off, staff, deals,
// events, hotels, subscriptions, expenses, spending), who or what it names and which
// period, then reads the same figures the pages show. A follow-up ("and Sara?", "what
// about him?") reuses the question before it. It is not a general AI: when it cannot
// place a question it says so and lists what it can answer.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SYM = { GBP: '£', USD: '$', EUR: '€', AED: 'AED ', PHP: '₱', CHF: 'CHF ' };
const CUR_WORD = { GBP: 'pounds', AED: 'dirhams', PHP: 'pesos', USD: 'dollars', EUR: 'euros' };
// The same rates the pages use (public/app.js: SAL_FX, HOTEL_TO_GBP, SUB_FX), so totals match them
const FX = {
  salary: { GBP: 1, AED: 1 / 4.67, PHP: 0.0138 },
  hotel: { GBP: 1, USD: 0.787, EUR: 0.855, CHF: 0.885, AED: 0.2141, PHP: 0.0138 },
  subscription: { GBP: 1, USD: 0.79, AED: 1 / 4.67, PHP: 0.014 },
};
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, annually: 12, one_off: 0 };

// ── Text ──────────────────────────────────────────────────────────────────────
// Lower case, no accents or punctuation; "Ali's" and "what's" lose their 's
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[’`]/g, "'").replace(/'s\b/g, '').replace(/'/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordIn = (t, w) => new RegExp(`\\b${esc(w)}s?\\b`).test(t);
const num = v => parseFloat(v) || 0;
const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : '');
const addDays = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function money(v, cur = 'GBP') {
  const n = Math.round(num(v) * 100) / 100;
  const pennies = Math.abs(n % 1) > 0.004;
  return (n < 0 ? '-' : '') + (SYM[cur] ?? cur + ' ') + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: pennies ? 2 : 0, maximumFractionDigits: 2 });
}
const pounds = v => '£' + Math.round(num(v)).toLocaleString('en-GB');
const niceDate = day => { const [y, m, d] = iso(day).split('-').map(Number); return y ? `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}` : ''; };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const listOf = items => (items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);
const firstName = name => String(name || '').trim().split(/\s+/)[0];

// ── Personality ───────────────────────────────────────────────────────────────
// A light touch: now and then an opener, and a dry line about the situation (never about
// a person). Nothing is added to answers about warnings, leavers or someone's details.
const OPENERS = ['Right.', 'Okay.', 'Got it.', 'Here you go.', 'Let me see.', 'Easy one.', 'On it.'];
const QUIPS = {
  allPaid: ['Everyone is paid up. The group chat stays quiet tonight.', 'All paid. Employer of the month stuff.', 'Nobody is waiting. Suspiciously organised of you.'],
  unpaid: ['Payday will not run itself, sadly.', 'Nobody has started a petition yet, but give it time.', 'I would pay them myself, but nobody gave me a card.'],
  nothingLeft: ['Nothing left to pay there. Rare and beautiful.', 'All square. Enjoy the feeling.'],
  bigBill: ['Deep breaths.', 'The good news: it is only money.', 'Look away now if you have just had lunch.', 'On the bright side, the team is clearly worth it.'],
  hotelsClear: ['Not one hotel is chasing you. Enjoy it while it lasts.', 'Every hotel settled. You may now use the lobby without hiding.'],
  hotelsDue: ['Hotels do love an invoice.', 'At least the minibar is not on there. I hope.', 'They will remember you at check-in, one way or another.'],
  dealsOwed: ['Might be time for a few polite chasing emails.', 'Money that is owed still counts. Technically.', 'A gentle nudge never hurt a sponsor.'],
  dealsClear: ['Every deal paid. Frame this message.', 'Nothing to chase. Put the kettle on instead.'],
  nobodyOff: ['Full house. Somebody put the kettle on.', 'Everyone is in. No excuses for a quiet office.'],
  subs: ['Subscriptions: easy to start, strangely hard to remember.', 'Somewhere in there is a free trial that never ended.'],
  spending: ['And that is before anyone orders lunch.', 'Cheaper than a Formula 1 team, at least.', 'Money well spent, I am told.'],
  targetHit: ['Target smashed. Whoever set it owes the team a drink.', 'Over the line. Time to move the line.'],
  targetFar: ['Plenty of runway left, to put it kindly.', 'Early days. Very early days.'],
  topEarner: ['No pressure on whoever is at the top.'],
  unknown: ['That one is above my pay grade, and I do not even get paid.', 'I would love to bluff it, but I only deal in real numbers.', 'You have found the edge of my world.'],
};
const QUIP_MARK = '\u0001'; // where a quip joins the answer: same line after a sentence, a new line after a list
const JOKES = [
  'Why did the accountant break up with the calculator? They felt used.',
  'I asked the spreadsheet for a joke. It gave me a circular reference.',
  'Why do sponsors love hotels? Because the lobby does all the work.',
  'I would tell you a payroll joke, but it only lands once a month.',
  'What is an event producer\'s favourite exercise? Running over budget.',
];

// ── Understanding the question ────────────────────────────────────────────────
// Checked in order: a named subject (hotels, deals, days off) wins over general words
// such as "left", "outstanding" or "paid", which only mean pay when nothing else is named.
const TOPICS = [
  ['unpaid', /\b(hasnt|has not|havent|have not|not|didnt|did not) (been|get|got) paid\b|\bwho (still )?(needs?|do (i|we) (still )?need) (to be paid|paying|to pay)\b|\b(unpaid|not paid) (staff|people|employees|this month|yet)\b|\bwho (is|are) (still )?(unpaid|waiting to be paid)\b|\bwho (do|should|must) (i|we) pay\b|\bwho needs paying\b/],
  ['hotels', /\bhotels?\b/],
  ['subscriptions', /\bsubscriptions?\b|\bsubs\b/],
  ['spending', /\bspending\b|\bexpenditure\b|\boutgoings\b|\brunning costs?\b|\b(do|did|are) we spend/],
  ['expenses', /\bexpenses?\b|\breceipts?\b|\bbills? to pay\b/],
  ['warnings', /\bwarnings?\b|\bdisciplinar/],
  ['probation', /\bprobation\b/],
  ['contracts', /\bcontracts? (is |are )?(end|ending|expir|up|run)|\b(expiring|ending) contracts?\b|\bcontract end/],
  ['requests', /\b(day off|days off|holiday|leave|time off) requests?\b|\bpending requests?\b|\brequests? (to approve|pending|waiting)\b|\banything to approve\b/],
  ['daysoff', /\bdays? off\b|\bholidays?\b|\bannual leave\b|\bon leave\b|\ballowance\b|\btime off\b|\b(who|anyone|anybody|is anyone|whos)( is| are)? (off|away|out)\b|\babsent\b|\boff (today|tomorrow|this week|next week)\b/],
  ['leavers', /\bwho (has |have )?left\b|\bleavers?\b|\bterminated\b|\bformer (staff|employees)\b|\bno longer (here|with us)\b/],
  ['targets', /\btargets?\b/],
  ['deals', /\bdeals?\b|\bsponsors?\b|\bsponsorship\b|\brevenue\b|\bcollect(ed|ions?)?\b|\bwho owes\b|\bowes? us\b|\bclients?\b|\binvoices?\b|\bmoney (coming )?in\b|\b(do|did|have) we (make|made|earn|earned|bring in|brought in|take|taken)\b/],
  ['events', /\bevents?\b|\bportfolio\b|\bconferences?\b|\bsummits?\b|\bforums?\b|\bprogramme\b/],
  ['salaryRank', /\b(highest|top|best|most|lowest|least|bottom|worst) (paid|earners?|earning|salary|salaries)\b|\bwho (earns|makes|gets paid|is paid|is on) the (most|least|highest|lowest)\b|\b(biggest|largest|smallest) salar/],
  ['salaryTotal', /\b(total|all|combined|overall) (the )?(salar|payroll|wage)|\b(salary|wage|payroll|wages) (bill|total|cost)\b|\bhow much (do|are) we pay(ing)? (in |on |for |out )?(salar|staff|everyone|wages|a year|a month|per)/],
  ['payLeft', /\bleft\b|\bremaining\b|\bstill (owed?|to pay|to be paid|due)\b|\boutstanding\b|\b(owe|owed|owing)\b|\bbalance\b/],
  ['paid', /\bpaid\b|\bpayments?\b|\blast (payment|paid)\b|\breceived\b/],
  ['salary', /\bsalar(y|ies)\b|\bearns?\b|\bearning\b|\bwages?\b|\btake home\b|\bpay\b|\b(how much|what) (is|are|does|do) .{0,40}\b(on|get|gets|make|makes)\b/],
  ['headcount', /\bhow many (staff|employees|people|of us)\b|\bheadcount\b|\bstaff\b|\bemployees?\b|\bteam\b|\bwho works\b|\bdepartments?\b|\bwho( is| are)? in\b/],
  ['profile', /\bemail\b|\bphone\b|\bnumber\b|\bcontact\b|\bjob\b|\btitle\b|\brole\b|\bposition\b|\bstart(ed|s)?\b|\bjoin(ed)?\b|\bwho is\b|\btell me about\b|\bdetails\b|\bprofile\b/],
];

// Where to do things in the app, for "how do I…" questions
const HOWTO = [
  [/\b(add|create|new) (an? |the )?(new )?(employee|staff|person|team member)/, 'Go to Employees and press "+ Add employee" at the top right.'],
  [/\b(delete|remove) (an? |the )?(employee|staff|person)/, 'Open their profile from Employees and press the red Delete button. If they have left the company, use Terminate instead, which keeps their history.'],
  [/\b(log|record|add|make) (a |the )?(salary )?payment|\bpay (someone|an employee|staff|them|him|her)\b/, 'On the Salary page, find their card and press "+ Pay". To pay everyone on pesos at once, use "Pay all PHP self-employed".'],
  [/\b(add|create|new|log) (a |the )?(new )?deal/, 'Deal Tracker, then "+ Add deal" at the top right.'],
  [/\b(set|add|change|edit) (a |the )?target/, 'Portfolio, in Revenue by series: open a series and press "Set target" on the event.'],
  [/\b(add|log|record) (an? |the )?(new )?(expense|cost|bill)/, 'Use the Expenses page for one-off bills, or the Spending page for yearly costs such as rent and cars.'],
  [/\b(add|log|record|book) (a |the )?(day off|holiday|leave)/, 'Daily Tracking: pick the person, add a record for the date and mark it as a day off. Staff can also request days off from their portal.'],
  [/\b(change|reset|set|add) (a |the |their |his |her )?pin/, 'Open their profile from Employees and press "Change PIN" (or "Add portal PIN").'],
  [/\b(add|give|issue) (a |the )?warning/, 'Open their profile from Employees and press "Add warning" in the Warnings section.'],
  [/\b(change|update|edit|correct) (a |the |their |his |her )?salary/, 'Open their profile, press "Edit details" and change the salary. It asks whether it is a pay change from a date or a correction.'],
];

// First names that are also everyday words: only read as a name when written with a capital
const WORDY_NAMES = new Set(['will', 'may', 'mark', 'art', 'bill', 'sue', 'pat', 'hope', 'joy', 'summer', 'dawn', 'penny', 'june', 'april', 'august', 'rich', 'guy', 'miles',
  'chase', 'faith', 'sky', 'angel', 'christian', 'page', 'cash', 'earl', 'duke', 'king', 'major', 'sunny', 'sandy', 'bud', 'young', 'long', 'short', 'brown', 'black', 'white',
  'green', 'gray', 'grey', 'gold', 'wood', 'stone', 'hill', 'field', 'brook', 'lake', 'land', 'park', 'fox', 'bear', 'best', 'good', 'little', 'small', 'strong', 'wise', 'sharp',
  'swift', 'love', 'day', 'week', 'month', 'year', 'winter', 'spring', 'north', 'south', 'east', 'west', 'sales', 'data', 'event', 'team', 'off', 'pay', 'paid', 'left', 'the',
  'and', 'for', 'has', 'have', 'who', 'how', 'much', 'many', 'does', 'with', 'this', 'that', 'what', 'when', 'where', 'last', 'next', 'all', 'any', 'new', 'old', 'total',
  'deal', 'still', 'most', 'more', 'less', 'top', 'man', 'boy', 'son', 'our', 'out', 'are', 'was', 'not', 'yet', 'get', 'got', 'can', 'did', 'one', 'two',
  'payroll', 'probation', 'self', 'employed', 'staff', 'employee', 'hotel', 'salary', 'target', 'warning', 'holiday', 'leave', 'contract', 'expense']);
// Everyday question words: never guessed to be a misheard name
const QUESTION_WORDS = new Set([...WORDY_NAMES, 'been', 'salaries', 'holidays', 'days', 'owed', 'owes', 'about', 'tell', 'email', 'phone', 'number', 'start', 'started',
  'warnings', 'earn', 'earns', 'taken', 'take', 'their', 'there', 'months', 'today', 'tomorrow', 'payment', 'payments', 'hotels', 'deals', 'events', 'targets', 'spend',
  'years', 'need', 'needs', 'people', 'everyone', 'highest', 'lowest', 'least', 'bill', 'weeks', 'employees', 'please', 'could', 'would', 'should', 'money',
  'from', 'into', 'over', 'under', 'than', 'them', 'they', 'were', 'your', 'yours', 'mine', 'here', 'just', 'like', 'want', 'know', 'show', 'give', 'find',
  'list', 'time', 'date', 'work', 'works', 'working', 'doing', 'going', 'come', 'coming', 'make', 'made', 'weather', 'hello', 'thanks', 'thank', 'joke', 'close',
  'collected', 'outstanding', 'remaining', 'biggest', 'smallest', 'subscriptions', 'subscription', 'expenses', 'spending', 'costs', 'cost', 'worth', 'amount',
  'profile', 'details', 'department', 'departments', 'office', 'company', 'business', 'right', 'okay', 'whats', 'whos', 'hows', 'doesnt', 'hasnt', 'havent',
  'which', 'while', 'without', 'also', 'again', 'another', 'other', 'others', 'each', 'every', 'some', 'none', 'only', 'even', 'ever', 'never', 'always', 'soon',
  'later', 'early', 'late', 'half', 'full', 'part', 'paying', 'unpaid', 'allowance', 'requests', 'request', 'pending', 'approve', 'contracts', 'ending',
  'upcoming', 'portfolio', 'revenue', 'sponsors', 'sponsor', 'clients', 'client', 'invoice', 'invoices', 'wasteman', 'mate', 'question', 'answer',
  'everything', 'anything', 'something', 'nothing', 'anyone', 'someone', 'anybody', 'everybody', 'nobody', 'myself', 'yourself', 'themselves', 'date', 'rent', 'tax',
  'taxes', 'vat', 'bank', 'account', 'cash', 'budget', 'profit', 'loss', 'income', 'bonus', 'bonuses', 'deduction', 'deductions', 'pension', 'overtime', 'hours']);
// Words in company and event names that do not identify one
const FILLER = new Set(['the', 'and', 'of', 'for', 'ltd', 'limited', 'llp', 'llc', 'inc', 'plc', 'group', 'global', 'capital', 'partners', 'private', 'bank', 'company', 'co', 'international', 'annual', 'markets', 'market', 'forum', 'summit', 'series', 'conference', 'event', 'europe', 'usa', 'uk', 'fund', 'funds', 'management', 'services', 'solutions', 'investing', 'investment', 'investments', 'th', 'st', 'nd', 'rd', 'in', 'on', 'at', 'a']);

// People the question names. A first name shared by several people comes back as `unclear`.
function findPeople(t, raw, employees) {
  const capital = w => new RegExp(`(?<!^)(?<![.!?]\\s)\\b${esc(w[0].toUpperCase() + w.slice(1))}`).test(raw);
  const usable = w => w.length >= 2 && (!(WORDY_NAMES.has(w) || w.length < 3) || capital(w));
  const hits = employees.map(e => {
    const parts = norm(e.name).split(' ').filter(Boolean);
    const whole = parts.length > 1 && t.includes(parts.join(' '));
    const matched = whole ? parts : parts.filter(p => usable(p) && wordIn(t, p));
    return { e, matched, whole };
  }).filter(h => h.matched.length);
  if (!hits.length) return { people: [], unclear: [] };
  // For each word of the question that matched, keep the people who match the most of their name
  const tokens = [...new Set(hits.flatMap(h => h.matched))];
  const people = new Map(), unclear = [];
  for (const tok of tokens) {
    const cands = hits.filter(h => h.matched.includes(tok));
    const best = Math.max(...cands.map(h => h.matched.length + (h.whole ? 5 : 0)));
    let top = cands.filter(h => h.matched.length + (h.whole ? 5 : 0) === best).map(h => h.e);
    if (top.length > 1 && top.filter(e => e.active).length === 1) top = top.filter(e => e.active);
    if (top.length === 1) people.set(top[0].id, top[0]);
    else if (!top.some(e => people.has(e.id))) unclear.push({ word: tok, options: top });
  }
  // A word already settled by a fuller match ("Ali Example") is not unclear
  return { people: [...people.values()], unclear: unclear.filter(u => !u.options.some(e => people.has(e.id))) };
}

// Letters to change to turn one word into another
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = keep; }
  }
  return row[b.length];
}
// When no name matched exactly: a word one or two letters off somebody's name (speech
// recognition often mishears names). Only a clear single best match counts.
function nearlyNamed(t, employees) {
  const words = t.split(' ').filter(w => w.length >= 4 && !QUESTION_WORDS.has(w) && !/\d/.test(w));
  let best = null;
  for (const w of words) for (const e of employees) for (const part of norm(e.name).split(' ')) {
    if (part.length < 3 || Math.abs(part.length - w.length) > 2 || part[0] !== w[0]) continue;
    const dist = editDistance(w, part), allowed = Math.min(w.length, part.length) >= 7 ? 2 : 1;
    if (dist === 0 || dist > allowed) continue;
    if (!best || dist < best.dist || (dist === best.dist && e.active && !best.e.active)) best = { e, dist, tie: false };
    else if (dist === best.dist && e.id !== best.e.id && e.active === best.e.active) best.tie = true;
  }
  return best && !best.tie ? best.e : null;
}

// The company (from the deals) or events the question names
function findByName(t, items, nameOf, minScore = 1) {
  const scored = items.map(item => {
    const full = norm(nameOf(item));
    if (full.length >= 4 && t.includes(full)) return { item, score: 100 };
    const words = [...new Set(full.split(' ').filter(w => w.length >= 3 && !FILLER.has(w) && !/^\d+$/.test(w)))];
    return { item, score: words.filter(w => wordIn(t, w)).length, of: words.length };
  }).filter(s => s.score >= minScore);
  if (!scored.length) return [];
  const best = Math.max(...scored.map(s => s.score));
  return scored.filter(s => s.score === best).map(s => s.item);
}

function findPeriod(t, today) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const out = { year: y, month: null, yearGiven: false, range: null };
  const yr = t.match(/\b(20\d\d)\b/);
  if (yr) { out.year = Number(yr[1]); out.yearGiven = true; }
  else if (/\blast year\b/.test(t)) { out.year = y - 1; out.yearGiven = true; }
  else if (/\bnext year\b/.test(t)) { out.year = y + 1; out.yearGiven = true; }
  if (/\bthis month\b/.test(t)) out.month = m;
  else if (/\blast month\b/.test(t)) { out.month = m === 1 ? 12 : m - 1; if (m === 1 && !out.yearGiven) out.year = y - 1; }
  else if (/\bnext month\b/.test(t)) { out.month = m === 12 ? 1 : m + 1; if (m === 12 && !out.yearGiven) out.year = y + 1; }
  else {
    const i = MONTHS.findIndex(name => {
      const n = name.toLowerCase();
      // "may" is only a month after in/for/of or before a year
      return n === 'may' ? /\b(in|for|of|during) may\b|\bmay 20\d\d\b/.test(t) : new RegExp(`\\b(${n}|${n.slice(0, 3)})\\b`).test(t);
    });
    if (i >= 0) out.month = i + 1;
  }
  const dow = new Date(today + 'T12:00:00Z').getUTCDay(), monday = addDays(today, -((dow + 6) % 7));
  if (/\btoday\b|\bright now\b/.test(t)) out.range = { from: today, to: today, label: 'today' };
  else if (/\btomorrow\b/.test(t)) out.range = { from: addDays(today, 1), to: addDays(today, 1), label: 'tomorrow' };
  else if (/\bnext week\b/.test(t)) out.range = { from: addDays(monday, 7), to: addDays(monday, 13), label: 'next week' };
  else if (/\bthis week\b/.test(t)) out.range = { from: monday, to: addDays(monday, 6), label: 'this week' };
  else if (out.month) {
    const last = new Date(Date.UTC(out.year, out.month, 0)).getUTCDate(), mm = String(out.month).padStart(2, '0');
    out.range = { from: `${out.year}-${mm}-01`, to: `${out.year}-${mm}-${String(last).padStart(2, '0')}`, label: `in ${MONTHS[out.month - 1]}` };
  }
  return out;
}

function understand(raw, world) {
  const t = norm(raw);
  const topic = (TOPICS.find(([, re]) => re.test(t)) || [null])[0];
  const { people, unclear } = findPeople(t, String(raw || ''), world.employees);
  const department = world.departments.find(d => wordIn(t, norm(d))) || null;
  const group = /\bpayroll\b/.test(t) ? 'payroll' : /\bself employed\b|\bfreelance/.test(t) ? 'self_employed' : null;
  const currency = /\b(php|pesos?|philippines?)\b/.test(t) ? 'PHP' : /\b(aed|dirhams?|dubai|uae)\b/.test(t) ? 'AED' : null;
  return { raw: String(raw || ''), t, topic, people, unclear, department, group, currency,
    everyone: /\b(everyone|everybody|all (the )?(staff|employees|team|of them)|whole team|in total|overall)\b/.test(t),
    pronoun: /\b(he|she|they|him|her|them|his|hers|their|theirs)\b/.test(t),
    words: t ? t.split(' ').length : 0, ...findPeriod(t, world.today) };
}

// ── Answers ───────────────────────────────────────────────────────────────────
const gbpOf = (v, cur) => num(v) * (FX.salary[cur] || 1);
const typeOf = r => (r.employment_type === 'self_employed' ? 'self-employed' : 'payroll');
const activeRows = rows => rows.filter(r => r.active && !r.is_terminated);
const dealMoney = d => {
  const amount = num(d.amount), paid = num(d.paid_inc_vat), paidEx = Math.max(0, paid - (paid > 0 ? num(d.tax_vat) : 0));
  return { amount, paid, out: Math.max(0, amount - paidEx), status: paid <= 0 ? 'unpaid' : paid >= amount ? 'paid' : 'part paid' };
};
const eventYear = e => e.programme_year || Number(iso(e.event_date).slice(0, 4)) || null;
const eventWhen = e => (e.date_tbc === 'date' || !e.event_date ? 'date to be confirmed'
  : e.date_tbc === 'day' ? `${MONTHS[Number(iso(e.event_date).slice(5, 7)) - 1]} ${iso(e.event_date).slice(0, 4)}` : niceDate(e.event_date));

function narrow(rows, q) {
  return rows.filter(r => (!q.department || (r.department || '') === q.department) && (!q.group || r.employment_type === q.group)
    && (!q.currency || (r.currency || 'GBP') === q.currency));
}
const scopeLabel = q => [q.department, q.group === 'payroll' ? 'payroll' : q.group ? 'self-employed' : '', q.currency ? `paid in ${CUR_WORD[q.currency]}` : ''].filter(Boolean).join(', ');

// What one person is still owed for the year, in words
function payLeftLine(r, year) {
  const cur = r.currency || 'GBP', left = num(r.net_remaining), who = r.name;
  if (!(num(r.annual_salary) > 0)) return `${who} has no salary set yet, so there is nothing to work out.`;
  const gone = r.is_terminated ? ` (left on ${niceDate(r.termination_date)})` : '';
  if (left < -0.5) return `${who}${gone} has nothing left to be paid in ${year}. They are ${money(-left, cur)} ahead of what the year adds up to.`;
  if (left <= 0.5) return num(r.total_paid) > 0 ? `${who}${gone} is fully paid for ${year}: ${money(r.total_paid, cur)} in total.` : `${who}${gone} was not due any pay in ${year}.`;
  const months = (r.pay_months || []).filter(m => !m.paid);
  if (months.length) {
    const full = months.filter(m => m.status !== 'part'), part = months.filter(m => m.status === 'part');
    const sameDue = full.length && full.every(m => Math.abs(m.due - full[0].due) < 0.01);
    const bits = [];
    if (full.length) bits.push(sameDue ? `${listOf(full.map(m => MONTHS[m.month - 1]))} at ${money(full[0].due, cur)}${full.length > 1 ? ' each' : ''}`
      : listOf(full.map(m => `${MONTHS[m.month - 1]} (${money(m.due, cur)})`)));
    part.forEach(m => bits.push(`${money(m.left, cur)} still owed for ${MONTHS[m.month - 1]}`));
    const ded = num(r.excess_deduction) + num(r.total_office_deductions);
    return `${who}${gone} has ${money(left, cur)} left to be paid in ${year}. That is ${bits.join(', plus ')}${ded > 0 ? `, less ${money(ded, cur)} in deductions` : ''}. Paid so far: ${money(r.total_paid, cur)}.`;
  }
  return `${who}${gone} has ${money(left, cur)} left to be paid in ${year}, out of ${money(num(r.total_paid) + left, cur)} for the year. Paid so far: ${money(r.total_paid, cur)} (${r.pct_paid}%).`;
}

const ANSWER = {
  async payLeft(q, d, say) {
    const rows = await d.overview(q.year);
    if (q.people.length) return q.people.map(p => { const r = rows.find(x => x.employee_id === p.id); return r ? payLeftLine(r, q.year) : `I have no pay record for ${p.name} in ${q.year}.`; }).join('\n');
    const scope = narrow(activeRows(rows), q);
    if (!scope.length) return `Nobody matches that, so there is nothing left to pay.`;
    const owed = r => Math.max(0, num(r.net_remaining));
    if (/\b(most|highest|biggest|largest|top)\b/.test(q.t)) {
      const top = [...scope].sort((a, b) => gbpOf(owed(b), b.currency) - gbpOf(owed(a), a.currency)).slice(0, 5).filter(r => owed(r) > 0);
      return top.length ? `The most left to be paid in ${q.year}:\n` + top.map((r, i) => `${i + 1}. ${r.name}: ${money(owed(r), r.currency)}`).join('\n') : `Nobody has anything left to be paid in ${q.year}.` + say.quip('nothingLeft');
    }
    const total = scope.reduce((a, r) => a + gbpOf(owed(r), r.currency), 0);
    const groups = [['Payroll', r => r.employment_type === 'payroll', 'GBP'], ['Self-employed in pounds', r => r.employment_type !== 'payroll' && (r.currency || 'GBP') === 'GBP', 'GBP'],
      ['Self-employed in pesos', r => r.employment_type !== 'payroll' && r.currency === 'PHP', 'PHP'], ['Self-employed in dirhams', r => r.employment_type !== 'payroll' && r.currency === 'AED', 'AED']]
      .map(([label, test, cur]) => { const g = scope.filter(test); const sum = g.reduce((a, r) => a + owed(r), 0); return g.length ? `${label} (${plural(g.length, 'person', 'people')}): ${money(Math.round(sum), cur)}${cur !== 'GBP' ? `, about ${pounds(gbpOf(sum, cur))}` : ''}` : null; }).filter(Boolean);
    const label = scopeLabel(q);
    return `Left to pay in ${q.year}${label ? ` for ${label}` : ''}: about ${pounds(total)} in pounds, across ${plural(scope.length, 'person', 'people')}.\n${groups.join('\n')}` + (total > 50000 ? say.quip('bigBill') : total < 1 ? say.quip('nothingLeft') : '');
  },

  async unpaid(q, d, say) {
    const now = d.today, month = q.month || Number(now.slice(5, 7)), year = q.year;
    const rows = narrow(activeRows(await d.overview(year)), q).filter(r => num(r.annual_salary) > 0
      && !(r.start_date && r.start_date.slice(0, 7) > `${year}-${String(month).padStart(2, '0')}`));
    const due = r => { const pm = (r.pay_months || []).find(m => m.month === month); return pm ? pm.due : num(r.annual_salary) / 12; };
    const none = rows.filter(r => !(r.payments || []).some(p => Number(p.payment_month) === month));
    const part = rows.filter(r => (r.pay_months || []).some(m => m.month === month && m.status === 'part'));
    const mName = `${MONTHS[month - 1]}${year !== Number(now.slice(0, 4)) ? ' ' + year : ''}`;
    if (!none.length && !part.length) return `Everyone has been paid for ${mName}.` + say.quip('allPaid', 0.8);
    const total = none.reduce((a, r) => a + gbpOf(due(r), r.currency), 0);
    let out = none.length ? `${plural(none.length, 'person has', 'people have')} not been paid for ${mName} yet, about ${pounds(total)} in pounds:\n` + none.slice(0, 40).map(r => `${r.name}: ${money(due(r), r.currency)}`).join('\n') + (none.length > 40 ? `\nand ${none.length - 40} more on the Salary page.` : '') : `Nobody is waiting on a full payment for ${mName}.`;
    if (part.length) out += `\nPart paid: ${listOf(part.map(r => `${r.name} (${money(r.pay_months.find(m => m.month === month).left, r.currency)} to go)`))}.`;
    return out + (none.length > 3 ? say.quip('unpaid') : '');
  },

  async paid(q, d) {
    const rows = await d.overview(q.year);
    if (q.people.length) return q.people.map(p => {
      const r = rows.find(x => x.employee_id === p.id);
      if (!r || !(r.payments || []).length) return `Nothing has been logged as paid to ${p.name} in ${q.year}.`;
      const cur = r.currency || 'GBP', pays = q.month ? r.payments.filter(x => Number(x.payment_month) === q.month) : r.payments;
      if (q.month) return pays.length ? `${p.name} was paid ${money(pays.reduce((a, x) => a + num(x.amount), 0), cur)} for ${MONTHS[q.month - 1]} ${q.year}.` : `Nothing is logged for ${p.name} for ${MONTHS[q.month - 1]} ${q.year}.`;
      const last = [...r.payments].sort((a, b) => Number(b.payment_month) - Number(a.payment_month))[0];
      return `${p.name} has been paid ${money(r.total_paid, cur)} in ${q.year} across ${plural(r.payments.length, 'payment')}. The latest was ${money(last.amount, cur)} for ${MONTHS[Number(last.payment_month) - 1]}.`;
    }).join('\n');
    const scope = narrow(rows, q), pays = scope.flatMap(r => (r.payments || []).filter(x => !q.month || Number(x.payment_month) === q.month).map(x => gbpOf(x.amount, r.currency)));
    const when = q.month ? `for ${MONTHS[q.month - 1]} ${q.year}` : `in ${q.year}`;
    return pays.length ? `Paid to staff ${when}: about ${pounds(pays.reduce((a, v) => a + v, 0))} in pounds, across ${plural(pays.length, 'payment')}.` : `No staff payments are logged ${when}.`;
  },

  async salary(q, d, say) {
    if (!q.people.length) return ANSWER.salaryTotal(q, d, say);
    const rows = await d.overview(q.year);
    return q.people.map(p => {
      const r = rows.find(x => x.employee_id === p.id), cur = p.currency || 'GBP', annual = num(p.annual_salary);
      if (!(annual > 0)) return `${p.name} has no salary set yet.`;
      return p.employment_type === 'payroll'
        ? `${p.name} is on ${money(annual, cur)} a year (payroll). Take-home is about ${money(r && r.net_monthly ? r.net_monthly : annual / 12, cur)} a month${r && r.net_monthly ? ' after tax' : ''}.`
        : `${p.name} is paid ${money(annual, cur)} a year (self-employed), which is ${money(annual / 12, cur)} a month${cur !== 'GBP' ? `, about ${pounds(gbpOf(annual, cur))} a year in pounds` : ''}.`;
    }).join('\n');
  },

  async salaryRank(q, d, say) {
    const low = /\b(lowest|least|bottom|smallest|worst)\b/.test(q.t);
    const staff = narrow(d.employees.filter(e => e.active && num(e.annual_salary) > 0), q).sort((a, b) => (gbpOf(b.annual_salary, b.currency) - gbpOf(a.annual_salary, a.currency)) * (low ? -1 : 1)).slice(0, 5);
    if (!staff.length) return 'Nobody matches that.';
    const label = scopeLabel(q);
    return `The ${low ? 'lowest' : 'highest'} salaries${label ? ` (${label})` : ''}, compared in pounds:\n` + staff.map((e, i) => `${i + 1}. ${e.name}: ${money(e.annual_salary, e.currency)}${e.currency && e.currency !== 'GBP' ? ` (about ${pounds(gbpOf(e.annual_salary, e.currency))})` : ''}`).join('\n') + (low ? '' : say.quip('topEarner', 0.35));
  },

  async salaryTotal(q, d, say) {
    const staff = narrow(d.employees.filter(e => e.active && num(e.annual_salary) > 0), q), total = staff.reduce((a, e) => a + gbpOf(e.annual_salary, e.currency), 0);
    const label = scopeLabel(q);
    return `All salaries${label ? ` for ${label}` : ''} together come to about ${pounds(total)} a year, which is ${pounds(total / 12)} a month, for ${plural(staff.length, 'person', 'people')} (other currencies converted to pounds).` + (total > 500000 ? say.quip('bigBill', 0.4) : '');
  },

  async daysoff(q, d, say) {
    if (q.people.length) {
      const rows = await d.overview(q.year);
      const lines = [];
      for (const p of q.people) {
        const r = rows.find(x => x.employee_id === p.id);
        if (!r) { lines.push(`I have no days-off record for ${p.name} in ${q.year}.`); continue; }
        const used = num(r.total_days_off), allow = num(r.allowance_days), over = num(r.excess_days);
        let line = `${p.name} has taken ${used} of ${allow} days off in ${q.year}, so ${over > 0 ? `${over} over the allowance${num(r.excess_deduction) > 0 ? ` (${money(r.excess_deduction, r.currency)} deducted)` : ''}` : `${Math.max(0, allow - used)} left`}.`;
        const next = await d.daysOff(d.today, addDays(d.today, 120), p.id);
        if (next.length) line += ` Booked next: ${listOf(next.slice(0, 4).map(x => niceDate(x.day) + (num(x.is_day_off) === 0.5 ? ' (half day)' : '')))}${next.length > 4 ? ` and ${next.length - 4} more` : ''}.`;
        lines.push(line);
      }
      return lines.join('\n');
    }
    if (/\b(most|over|exceed|above|gone over)\b/.test(q.t)) {
      const rows = narrow(activeRows(await d.overview(q.year)), q);
      if (/\bmost\b/.test(q.t)) {
        const top = [...rows].filter(r => num(r.total_days_off) > 0).sort((a, b) => num(b.total_days_off) - num(a.total_days_off)).slice(0, 5);
        return top.length ? `Most days off in ${q.year}:\n` + top.map((r, i) => `${i + 1}. ${r.name}: ${num(r.total_days_off)} of ${num(r.allowance_days)}`).join('\n') : `Nobody has taken a day off in ${q.year} yet.`;
      }
      const over = rows.filter(r => num(r.excess_days) > 0);
      return over.length ? `Over their allowance in ${q.year}: ${listOf(over.map(r => `${r.name} (${num(r.excess_days)} over)`))}.` : `Nobody is over their allowance in ${q.year}.`;
    }
    const range = q.range || { from: d.today, to: addDays(d.today, 7), label: 'in the next seven days' };
    const off = (await d.daysOff(range.from, range.to)).filter(x => !q.department || x.department === q.department);
    if (!off.length) return `Nobody is off ${range.label}.` + say.quip('nobodyOff', 0.6);
    if (range.from === range.to) return `Off ${range.label}: ${listOf(off.map(x => x.name + (num(x.is_day_off) === 0.5 ? ' (half day)' : '')))}.`;
    const byDay = new Map();
    off.forEach(x => byDay.set(x.day, [...(byDay.get(x.day) || []), x.name + (num(x.is_day_off) === 0.5 ? ' (half day)' : '')]));
    return `Off ${range.label}:\n` + [...byDay].slice(0, 14).map(([day, names]) => `${niceDate(day)}: ${listOf(names)}`).join('\n');
  },

  async requests(q, d) {
    const { rows } = await d.q(`SELECT e.name, r.request_date::TEXT AS day, r.is_day_off, r.reason FROM day_off_requests r JOIN employees e ON e.id = r.employee_id
      WHERE r.status = 'pending' ORDER BY r.request_date LIMIT 40`);
    if (!rows.length) return 'There are no day-off requests waiting for you.';
    const by = new Map();
    rows.forEach(r => by.set(r.name, [...(by.get(r.name) || []), r.day]));
    return `${plural(rows.length, 'day')} waiting for approval, on the Calendar page:\n` + [...by].map(([name, days]) => `${name}: ${days.length > 3 ? `${niceDate(days[0])} to ${niceDate(days[days.length - 1])} (${days.length} days)` : listOf(days.map(niceDate))}`).join('\n');
  },

  async headcount(q, d) {
    const staff = narrow(d.employees.filter(e => e.active), q);
    if (q.department || q.group || q.currency) return staff.length ? `${plural(staff.length, 'person', 'people')} in ${scopeLabel(q)}: ${listOf(staff.map(e => e.name + (e.job_title ? ` (${e.job_title})` : '')))}.` : `Nobody is in ${scopeLabel(q)} right now.`;
    const payroll = staff.filter(e => e.employment_type === 'payroll').length, depts = {};
    staff.forEach(e => { const k = e.department || 'No department'; depts[k] = (depts[k] || 0) + 1; });
    return `${plural(staff.length, 'active person', 'active people')}: ${payroll} on payroll and ${staff.length - payroll} self-employed.\nBy department: ${Object.entries(depts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}.`;
  },

  async leavers(q, d) {
    const gone = d.employees.filter(e => !e.active).sort((a, b) => String(b.termination_date || '').localeCompare(String(a.termination_date || '')));
    return gone.length ? `${plural(gone.length, 'person has', 'people have')} left: ${listOf(gone.slice(0, 15).map(e => e.name + (e.termination_date ? ` (${niceDate(e.termination_date)})` : '')))}.` : 'Nobody has left.';
  },

  async profile(q, d) {
    if (!q.people.length) return null;
    return q.people.map(p => {
      const want = k => new RegExp(`\\b${k}\\b`).test(q.t);
      if (want('email')) return p.email ? `${p.name}'s email is ${p.email}.` : `There is no email on file for ${p.name}.`;
      if (want('phone') || want('number')) return p.phone ? `${p.name}'s number is ${p.phone}.` : `There is no phone number on file for ${p.name}.`;
      if (/\bstart(ed|s)?\b|\bjoin(ed)?\b/.test(q.t)) return p.start_date ? `${p.name} started on ${niceDate(p.start_date)}.` : `There is no start date on file for ${p.name}.`;
      const bits = [[p.job_title, p.department].filter(Boolean).join(', ') || 'no role set',
        `${typeOf(p)}${p.working_pattern === 'part-time' ? ', part-time' : ''}`, p.start_date ? `started ${niceDate(p.start_date)}` : '',
        p.active ? '' : `left${p.termination_date ? ' on ' + niceDate(p.termination_date) : ''}`,
        p.probation_end_date && !p.probation_review_done_at && p.active ? `on probation until ${niceDate(p.probation_end_date)}` : '',
        p.email || '', p.phone || ''].filter(Boolean);
      return `${p.name}: ${bits.join('; ')}.`;
    }).join('\n');
  },

  async probation(q, d) {
    const open = d.employees.filter(e => e.active && e.probation_end_date && !e.probation_review_done_at && (!q.people.length || q.people.some(p => p.id === e.id)));
    if (q.people.length && !open.length) return `${listOf(q.people.map(p => p.name))} ${q.people.length > 1 ? 'are' : 'is'} not on probation.`;
    if (!open.length) return 'Nobody is on probation right now.';
    const left = e => Math.round((Date.parse(e.probation_end_date) - Date.parse(d.today)) / 86400000);
    return `On probation:\n` + open.sort((a, b) => left(a) - left(b)).map(e => `${e.name}: ends ${niceDate(e.probation_end_date)} (${left(e) < 0 ? `review overdue by ${plural(-left(e), 'day')}` : `${plural(left(e), 'day')} to go`})`).join('\n');
  },

  async contracts(q, d) {
    const soon = addDays(d.today, 90);
    const ending = d.employees.filter(e => e.active && e.contract_end_date && e.contract_end_date <= soon).sort((a, b) => a.contract_end_date.localeCompare(b.contract_end_date));
    return ending.length ? `Contracts ending within three months:\n` + ending.map(e => `${e.name}: ${niceDate(e.contract_end_date)}${e.contract_end_date < d.today ? ' (already passed)' : ''}`).join('\n') : 'No contracts end in the next three months.';
  },

  async warnings(q, d) {
    const { rows } = await d.q(`SELECT w.employee_id, e.name, w.issued_on::TEXT AS day, w.level, w.reason FROM employee_warnings w JOIN employees e ON e.id = w.employee_id ORDER BY w.issued_on DESC`);
    if (q.people.length) return q.people.map(p => {
      const mine = rows.filter(w => w.employee_id === p.id);
      return mine.length ? `${p.name} has ${plural(mine.length, 'warning')}:\n` + mine.map(w => `${niceDate(w.day)}, ${w.level}: ${w.reason}`).join('\n') : `${p.name} has no warnings.`;
    }).join('\n');
    if (!rows.length) return 'Nobody has a warning on file.';
    const by = new Map();
    rows.forEach(w => by.set(w.name, (by.get(w.name) || 0) + 1));
    return `${plural(rows.length, 'warning')} on file: ${listOf([...by].map(([name, n]) => `${name} (${n})`))}.`;
  },

  async deals(q, d, say) {
    const all = await d.deals();
    const companies = findByName(q.t, [...new Map(all.map(x => [norm(x.company), x])).values()], x => x.company).map(x => norm(x.company));
    const events = companies.length ? [] : findByName(q.t, await d.events(), e => `${e.name} ${e.location || ''}`);
    if (companies.length && companies.length <= 3) {
      return companies.map(c => {
        const mine = all.filter(x => norm(x.company) === c), cur = mine[0].currency || 'GBP';
        const sum = k => mine.reduce((a, x) => a + dealMoney(x)[k], 0);
        const where = [...new Set(mine.flatMap(x => (x.events || []).map(e => e.event_name)))];
        return `${mine[0].company}: ${plural(mine.length, 'deal')} worth ${money(sum('amount'), cur)}. Paid ${money(sum('paid'), cur)}, ${sum('out') > 0.5 ? `${money(sum('out'), cur)} still owed` : 'nothing owed'}.${where.length ? ` For: ${listOf(where.slice(0, 4))}${where.length > 4 ? ` and ${where.length - 4} more` : ''}.` : ''}`;
      }).join('\n');
    }
    if (events.length && events.length <= 3) return events.map(eventLine).join('\n');
    const scope = q.yearGiven ? all.filter(x => (x.fiscal_year || Number(iso(x.invoice_date).slice(0, 4)) || null) === q.year) : all;
    const tot = { amount: 0, paid: 0, out: 0 }, count = { paid: 0, 'part paid': 0, unpaid: 0 };
    scope.forEach(x => { const m = dealMoney(x); tot.amount += m.amount; tot.paid += m.paid; tot.out += m.out; count[m.status] += 1; });
    const when = q.yearGiven ? ` for ${q.year}` : '';
    if (!scope.length) return `There are no deals${when} yet.`;
    if (/\b(owes?|owed|owing|outstanding|unpaid|collect|chase|chasing|still to)\b/.test(q.t)) {
      const owing = scope.map(x => ({ x, m: dealMoney(x) })).filter(o => o.m.out > 0.5).sort((a, b) => b.m.out - a.m.out);
      return owing.length ? `Still to collect${when}: ${pounds(tot.out)} across ${plural(owing.length, 'deal')}.\n` + owing.slice(0, 8).map(o => `${o.x.company}: ${money(o.m.out, o.x.currency)}${o.m.status === 'part paid' ? ' (part paid)' : ''}`).join('\n') + (owing.length > 8 ? `\nand ${owing.length - 8} more in the Deal Tracker.` : '') + say.quip('dealsOwed', 0.5)
        : `Every deal${when} is paid.` + say.quip('dealsClear', 0.8);
    }
    if (/\b(biggest|largest|top|best)\b/.test(q.t)) return `The biggest deals${when}:\n` + [...scope].sort((a, b) => num(b.amount) - num(a.amount)).slice(0, 5).map((x, i) => `${i + 1}. ${x.company}: ${money(x.amount, x.currency)}`).join('\n');
    return `${plural(scope.length, 'deal')}${when} worth ${pounds(tot.amount)}. Received so far: ${pounds(tot.paid)} including VAT. Still to collect: ${pounds(tot.out)}. That is ${count.paid} paid, ${count['part paid']} part paid and ${count.unpaid} not paid yet.`;
  },

  async events(q, d) {
    const all = await d.events();
    const named = findByName(q.t, all, e => `${e.name} ${e.location || ''}`);
    if (named.length && named.length <= 3) return named.map(eventLine).join('\n');
    const dated = all.filter(e => e.event_date && e.date_tbc !== 'date').sort((a, b) => iso(a.event_date).localeCompare(iso(b.event_date)));
    if (/\bhow many\b/.test(q.t)) { const n = all.filter(e => !q.yearGiven || eventYear(e) === q.year).length; return `There ${n === 1 ? 'is' : 'are'} ${plural(n, 'event')}${q.yearGiven ? ` in ${q.year}` : ' in the portfolio'}.`; }
    const upcoming = dated.filter(e => iso(e.event_date) >= d.today && (!q.yearGiven || eventYear(e) === q.year));
    if (!upcoming.length) return 'There are no upcoming events with a date set.';
    if (/\bnext\b/.test(q.t) && !/\bnext (year|month|week)\b/.test(q.t)) { const e = upcoming[0], days = Math.round((Date.parse(iso(e.event_date)) - Date.parse(d.today)) / 86400000); return `Next up is ${e.name} on ${eventWhen(e)}${e.location ? ' in ' + e.location : ''}, ${days === 0 ? 'today' : `${plural(days, 'day')} away`}.`; }
    return `Coming up:\n` + upcoming.slice(0, 6).map(e => `${eventWhen(e)}: ${e.name}${e.location ? ` (${e.location})` : ''}`).join('\n') + (upcoming.length > 6 ? `\nand ${upcoming.length - 6} more after that.` : '');
  },

  async targets(q, d, say) {
    const all = await d.events();
    const named = findByName(q.t, all, e => `${e.name} ${e.location || ''}`);
    if (named.length && named.length <= 3) return named.map(eventLine).join('\n');
    const set = all.filter(e => num(e.revenue_target) > 0);
    if (!set.length) return 'No targets are set yet. Set them on the Portfolio page: open a series in Revenue by series and press "Set target" on an event.';
    const won = set.reduce((a, e) => a + num(e.total_pipeline), 0), target = set.reduce((a, e) => a + num(e.revenue_target), 0), pct = Math.round(won / target * 100);
    const hit = set.filter(e => num(e.total_pipeline) >= num(e.revenue_target)).length;
    const far = [...set].filter(e => num(e.total_pipeline) < num(e.revenue_target)).sort((a, b) => (num(b.revenue_target) - num(b.total_pipeline)) - (num(a.revenue_target) - num(a.total_pipeline))).slice(0, 4);
    return `Targets are set on ${plural(set.length, 'event')}: ${pounds(won)} won against ${pounds(target)}, so ${pct}% of the way. ${hit} ${hit === 1 ? 'has' : 'have'} hit target.` + (far.length ? `\nFurthest to go: ${listOf(far.map(e => `${e.name} (${pounds(num(e.revenue_target) - num(e.total_pipeline))})`))}.` : '') + (pct >= 100 ? say.quip('targetHit', 0.8) : pct < 40 ? say.quip('targetFar', 0.5) : '');
  },

  async hotels(q, d, say) {
    const { rows } = await d.q(`SELECT event_name, hotel, paid_amount, COALESCE(paid_currency, currency, 'USD') AS cur, status, event_year FROM hotel_expenses ORDER BY sort_order, id`);
    const mine = rows.filter(r => Number(r.event_year) === q.year);
    if (!mine.length) return `There are no hotel bookings filed under ${q.year}.`;
    const paid = mine.reduce((a, r) => a + num(r.paid_amount) * (FX.hotel[r.cur] || FX.hotel.USD), 0), open = mine.filter(r => r.status !== 'paid');
    const head = `Hotels for ${q.year}: ${plural(mine.length, 'event')}, about ${pounds(paid)} paid so far.`;
    return open.length ? `${head} ${plural(open.length, 'event is', 'events are')} still to pay:\n` + open.slice(0, 10).map(r => `${r.event_name}${r.hotel ? ` (${r.hotel})` : ''}: ${r.status === 'partial' ? 'part paid' : 'not paid'}`).join('\n') + say.quip('hotelsDue', 0.4)
      : `${head} Every one is settled.` + say.quip('hotelsClear', 0.8);
  },

  async subscriptions(q, d, say) {
    const { rows } = await d.q(`SELECT name, amount, currency, billing_cycle, COALESCE(quantity, 1) AS quantity FROM subscriptions WHERE active ORDER BY name`);
    if (!rows.length) return 'There are no active subscriptions.';
    const yearly = s => { const once = num(s.amount) * Math.max(1, Number(s.quantity) || 1) * (FX.subscription[s.currency] || 1), m = CYCLE_MONTHS[s.billing_cycle]; return m ? once * 12 / m : once; };
    const total = rows.reduce((a, s) => a + yearly(s), 0), top = [...rows].sort((a, b) => yearly(b) - yearly(a)).slice(0, 5);
    return `${plural(rows.length, 'active subscription')}: about ${pounds(total)} a year, ${pounds(total / 12)} a month.\nThe biggest: ${listOf(top.map(s => `${s.name} (${pounds(yearly(s))} a year)`))}.` + say.quip('subs', 0.4);
  },

  async expenses(q, d) {
    const { rows } = await d.q(`SELECT description, category, amount, currency, expense_date::TEXT AS day, status, due_date::TEXT AS due FROM company_expenses ORDER BY expense_date DESC`);
    const pending = rows.filter(r => r.status === 'pending'), paid = rows.filter(r => r.status !== 'pending' && r.day.startsWith(q.month ? `${q.year}-${String(q.month).padStart(2, '0')}` : String(q.year)));
    const sums = list => { const by = {}; list.forEach(r => { by[r.currency || 'GBP'] = (by[r.currency || 'GBP'] || 0) + num(r.amount); }); return Object.entries(by).map(([c, v]) => money(v, c)).join(' plus ') || '£0'; };
    const when = q.month ? `${MONTHS[q.month - 1]} ${q.year}` : String(q.year);
    let out = `Expenses in ${when}: ${sums(paid)} across ${plural(paid.length, 'item')}.`;
    out += pending.length ? `\nWaiting to be paid: ${plural(pending.length, 'invoice')}, ${sums(pending)}:\n` + pending.slice(0, 8).map(r => `${r.description || r.category}: ${money(r.amount, r.currency)}${r.due ? `, due ${niceDate(r.due)}` : ''}`).join('\n') : '\nNothing is waiting to be paid.';
    return out;
  },

  async spending(q, d, say) {
    const salaries = d.employees.filter(e => e.active).reduce((a, e) => a + gbpOf(e.annual_salary, e.currency), 0);
    const [{ rows: hotels }, { rows: subs }, { rows: items }] = await Promise.all([
      d.q(`SELECT paid_amount, COALESCE(paid_currency, currency, 'USD') AS cur FROM hotel_expenses WHERE event_year = ?`, [q.year]),
      d.q(`SELECT amount, currency, billing_cycle, COALESCE(quantity, 1) AS quantity FROM subscriptions WHERE active`),
      d.q(`SELECT name, annual_amount FROM spending_items ORDER BY annual_amount DESC`).catch(() => ({ rows: [] }))]);
    const hotel = hotels.reduce((a, r) => a + num(r.paid_amount) * (FX.hotel[r.cur] || FX.hotel.USD), 0);
    const sub = subs.reduce((a, s) => { const once = num(s.amount) * Math.max(1, Number(s.quantity) || 1) * (FX.subscription[s.currency] || 1), m = CYCLE_MONTHS[s.billing_cycle]; return a + (m ? once * 12 / m : once); }, 0);
    const lines = [['Staff salaries', salaries], [`Hotels paid for ${q.year}`, hotel], ['Subscriptions', sub], ...items.map(i => [i.name, num(i.annual_amount)])].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const total = lines.reduce((a, [, v]) => a + v, 0);
    return `Total annual spending: about ${pounds(total)}, which is ${pounds(total / 12)} a month.\n` + lines.slice(0, 10).map(([k, v]) => `${k}: ${pounds(v)}`).join('\n') + say.quip('spending', 0.5);
  },
};

function eventLine(e) {
  const won = num(e.total_pipeline), paid = num(e.total_won), target = num(e.revenue_target), n = Number(e.deal_count) || 0;
  let out = `${e.name}: ${eventWhen(e)}${e.location ? ', ' + e.location : ''}. `;
  out += n ? `${plural(n, 'deal')} won worth ${pounds(won)}, ${pounds(paid)} paid and ${pounds(Math.max(0, won - paid))} owed.` : 'No deals won yet.';
  if (target > 0) out += won >= target ? ` Target of ${pounds(target)} hit${won > target ? `, ${pounds(won - target)} over` : ''}.` : ` Target ${pounds(target)}: ${Math.round(won / target * 100)}% there, ${pounds(target - won)} to go.`;
  return out;
}

// "What's outstanding?" with nothing named: the three places money can be outstanding
async function outstandingEverywhere(q, d) {
  const [rows, deals, { rows: hotels }] = await Promise.all([d.overview(q.year), d.deals(),
    d.q(`SELECT status FROM hotel_expenses WHERE event_year = ?`, [q.year])]);
  const staff = activeRows(rows).reduce((a, r) => a + gbpOf(Math.max(0, num(r.net_remaining)), r.currency), 0);
  const owed = deals.reduce((a, x) => a + dealMoney(x).out, 0), open = hotels.filter(h => h.status !== 'paid').length;
  return `Depends which pot you mean.\nStaff pay still to go out in ${q.year}: about ${pounds(staff)}.\nDeals still to collect: ${pounds(owed)}.\nHotels: ${open ? plural(open, 'event') + ' still to pay' : 'all settled'}.`;
}

const HELP = `I answer from what the tracker holds. Try things like:
How much does Ali have left to be paid this year?
Who hasn't been paid this month?
Who is off next week?
Who are the highest paid in Sales?
Who still owes us on deals?
How close are we to our targets?
What's outstanding on hotels?
What do we spend a year?`;

function smallTalk(q, say, today) {
  const t = q.t;
  if (/^(hi|hello|hey|yo|hiya|morning|good morning|afternoon|good afternoon|evening|good evening|sup|whats up|wagwan)( wasteman| mate| bro| there)?$/.test(t)) return say.pick(['Hello. What do you need?', 'Hey. Fire away.', 'Alright. What are we looking at?']);
  if (/^(thanks|thank you|cheers|ta|nice one|legend|perfect|great|brilliant|lovely|ok thanks|okay thanks)\b/.test(t) && q.words <= 4) return say.pick(['Any time.', 'No bother.', 'That is what I am here for.', 'Easy.']);
  if (/^(ok|okay|cool|nice|good|alright|sound|safe|fair enough|got it|i see|right)$/.test(t)) return say.pick(['Anything else?', 'What next?', 'Shout if you need more.']);
  if (/\bhow are you\b|\bhow you doing\b|\byou (alright|ok|okay)\b/.test(t)) return say.pick(['Never better. I do not sleep, eat or take days off, which is suspicious on a time tracker.', 'All good. Running on numbers and optimism.']);
  if (/\bwho are you\b|\bwhat are you\b|\byour name\b/.test(t)) return 'I am Wasteman, the tracker\'s assistant. I read the same figures your pages show and tell you the answer, so you do not have to go digging.';
  if (/\b(tell|give|got|know) (me |us )?(a |any |another )?jokes?\b|\bmake me laugh\b|\bsomething funny\b/.test(t)) return say.pick(JOKES);
  if (/\bwhat can (you|i) (do|ask|answer)\b|\bwhat do you know\b|^help\b|\bhow do (you|i use you) work\b/.test(t)) return HELP;
  if (/\b(what|whats) (is )?(the )?(date|day)( is it)?( today)?\b|\btodays date\b/.test(t)) return `It is ${new Date(today + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} ${niceDate(today)}.`;
  return null;
}

// "20% of 40500", "1200 x 12": worked out directly
function sums(raw) {
  const s = String(raw).toLowerCase().replace(/,/g, '').replace(/£|\$/g, '');
  const pct = s.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)\s*of\s*(\d+(?:\.\d+)?)/);
  if (pct) return `${pct[1]}% of ${Number(pct[2]).toLocaleString('en-GB')} is ${(Number(pct[1]) / 100 * Number(pct[2])).toLocaleString('en-GB', { maximumFractionDigits: 2 })}.`;
  const m = s.match(/^(?:what is|whats|what's|calculate|work out)?\s*(\d+(?:\.\d+)?)\s*(\+|plus|-|minus|x|\*|times|multiplied by|\/|divided by|over)\s*(\d+(?:\.\d+)?)\s*\??$/);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[3]), op = m[2];
  const v = /\+|plus/.test(op) ? a + b : /-|minus/.test(op) ? a - b : /x|\*|times|multiplied/.test(op) ? a * b : b === 0 ? null : a / b;
  return v === null ? 'You cannot divide by zero. Even I have limits.' : `That is ${v.toLocaleString('en-GB', { maximumFractionDigits: 2 })}.`;
}

/**
 * The built-in Wasteman. `db`: q (SQL), getSalaryOverview(year), getPortfolioEvents().
 * Returns answer(messages) where messages is the chat so far ([{role, content}]).
 */
function createLocalWasteman(db, { rng = Math.random, now = () => new Date() } = {}) {
  return async function answer(messages) {
    const asked = (messages || []).filter(m => m && m.role === 'user' && m.content).map(m => String(m.content));
    const question = asked[asked.length - 1] || '';
    const today = now().toISOString().slice(0, 10);
    const pick = list => list[Math.floor(rng() * list.length)];
    const say = { pick, quip: (kind, chance = 0.5) => (QUIPS[kind] && rng() < chance ? QUIP_MARK + pick(QUIPS[kind]) : '') };

    const memo = new Map(), once = (k, fn) => { if (!memo.has(k)) memo.set(k, fn()); return memo.get(k); };
    const { rows: employees } = await db.q(`SELECT id, name, job_title, department, employment_type, currency, annual_salary, active, email, phone, working_pattern,
      start_date::TEXT AS start_date, termination_date::TEXT AS termination_date, contract_end_date::TEXT AS contract_end_date,
      probation_end_date::TEXT AS probation_end_date, probation_review_done_at::TEXT AS probation_review_done_at FROM employees ORDER BY name`);
    employees.forEach(e => { e.active = !!e.active; });
    const world = { employees, today, departments: [...new Set(employees.map(e => e.department).filter(Boolean))] };
    const d = { q: db.q, today, employees,
      overview: year => once('ov' + year, () => db.getSalaryOverview(year)),
      events: () => once('ev', () => db.getPortfolioEvents()),
      deals: () => once('deals', async () => (await db.q(`SELECT d.id, COALESCE(NULLIF(d.company, ''), d.title) AS company, d.amount, d.currency, d.paid_inc_vat, d.tax_vat, d.fiscal_year,
          d.invoice_date::TEXT AS invoice_date, COALESCE(json_agg(json_build_object('event_name', pe.name, 'allocated_amount', de.allocated_amount)) FILTER (WHERE de.event_id IS NOT NULL), '[]') AS events
        FROM deals d LEFT JOIN deal_events de ON de.deal_id = d.id LEFT JOIN portfolio_events pe ON pe.id = de.event_id
        WHERE NOT COALESCE(d.stage_cancelled, false) GROUP BY d.id ORDER BY d.amount DESC`)).rows),
      daysOff: async (from, to, empId) => (await db.q(`SELECT e.name, e.department, r.record_date::TEXT AS day, r.is_day_off FROM daily_records r JOIN employees e ON e.id = r.employee_id
        WHERE r.is_day_off > 0 AND e.active = 1 AND r.record_date >= ? AND r.record_date <= ? ${empId ? 'AND r.employee_id = ?' : ''} ORDER BY r.record_date, e.name`, empId ? [from, to, empId] : [from, to])).rows,
    };

    // What a message asks: its topic, who it names (allowing for a misheard name) and its period
    const PERSONAL = ['payLeft', 'paid', 'salary', 'daysoff', 'profile', 'warnings', 'probation'];
    const scoped = u => u.everyone || u.department || u.group || u.currency;
    const read = text => {
      const u = understand(text, world);
      if (!u.people.length && !u.unclear.length && !scoped(u) && (!u.topic || PERSONAL.includes(u.topic))) {
        const near = nearlyNamed(u.t, employees);
        if (near) { u.people = [near]; u.guessed = near; }
      }
      return u;
    };

    const q = understand(question, world);
    const chat = smallTalk(q, say, today);
    if (chat) return chat;
    if (!q.people.length && !q.topic) { const sum = sums(question); if (sum) return sum; }
    if (/^(how|where) (do|can|would|should) (i|we|you)\b|^how to\b/.test(q.t)) {
      const how = HOWTO.find(([re]) => re.test(q.t));
      if (how) return how[1];
    }

    // A follow-up borrows what it is missing from the questions before it
    const earlier = asked.slice(0, -1).reverse().slice(0, 4).map(read);
    const cue = /^(and|what about|how about|same for|also|or)\b/.test(q.t), names = q.people.length || q.unclear.length;
    // "and Sara?", "what about him", "in 2025", or a bare "days off?" straight after a question about someone
    const bare = q.words <= 3 && PERSONAL.includes(q.topic) && !/^(who|whos|anyone|is anyone|anybody)\b/.test(q.t);
    const followUp = q.words <= 8 && (cue || q.pronoun || bare || ((names || scoped(q) || q.month || q.yearGiven || q.range) && !q.topic));
    if (!q.topic && followUp) q.topic = (earlier.find(e => e.topic) || {}).topic || null;
    if (!names && !scoped(q) && followUp) q.people = (earlier.find(e => e.people.length) || { people: [] }).people;

    // A company or event named with a pay word ("how much has Highspring paid") is about deals
    if (!q.people.length && !q.unclear.length && (!q.topic || ['paid', 'payLeft', 'profile'].includes(q.topic))) {
      if (findByName(q.t, await d.deals(), x => x.company).length) q.topic = 'deals';
      else if (findByName(q.t, await d.events(), e => `${e.name} ${e.location || ''}`, 2).length) q.topic = 'events';
    }

    // Still nobody: a name that was misheard or mistyped, or one the tracker does not know
    if (!q.people.length && !q.unclear.length && !scoped(q) && (!q.topic || PERSONAL.includes(q.topic))) {
      const near = nearlyNamed(q.t, employees);
      if (near) { q.people = [near]; q.guessed = near; }
      else if (q.topic && q.topic !== 'daysoff') {
        const stranger = (q.t.match(/\b(?:does|is|has|did|for|about|of|pay|paid|to) ([a-z]{3,})\b/g) || []).map(m => m.split(' ')[1]).find(w => !QUESTION_WORDS.has(w));
        if (stranger) return `I could not find a person${['paid', 'payLeft'].includes(q.topic) ? ' or a company' : ''} called ${stranger[0].toUpperCase() + stranger.slice(1)}. Check the spelling, or give me the full name.`;
      }
    }

    if (q.unclear.length) {
      const u = q.unclear[0];
      const sameName = u.options.every(e => norm(e.name) === norm(u.options[0].name));
      if (sameName) return `There are ${u.options.length} people called ${u.options[0].name} on the system, so I cannot tell them apart by name. Rename one on the Employees page and ask me again.`;
      return `I know ${u.options.length} people called ${u.word[0].toUpperCase() + u.word.slice(1)}: ${listOf(u.options.slice(0, 6).map(e => e.name + (e.job_title || e.department ? ` (${e.job_title || e.department})` : '') + (e.active ? '' : ', who has left')))}${u.options.length > 6 ? ' and more' : ''}. Which one?`;
    }

    if (q.topic === 'payLeft' && !q.people.length && !scoped(q)
      && /\b(outstanding|owed?|owing)\b/.test(q.t) && !/\b(staff|salar|pay|paid|wages?|payroll|team|employees?)\b/.test(q.t)) return outstandingEverywhere(q, d);
    if (!q.topic && q.people.length) q.topic = 'profile';
    if (q.topic === 'headcount' && q.people.length) q.topic = 'profile';

    const handler = q.topic && ANSWER[q.topic];
    const finish = text => text.replace(new RegExp(`${QUIP_MARK}(.*)$`, 's'), (_, line) => (text.includes('\n') ? '\n' : ' ') + line);
    let text = handler ? await handler(q, d, say) : null;
    if (!text) return finish(`I could not work out what you are asking.${say.quip('unknown', 0.7)}`) + `\n\n${HELP}`;
    if (q.guessed) text = `I took that as ${q.guessed.name}. ${text}`;
    // Personal answers (warnings, leavers, details) stay plain; others sometimes get an opener
    const plain = ['warnings', 'leavers', 'profile', 'probation', 'contracts'].includes(q.topic);
    return finish(!plain && !q.guessed && rng() < 0.3 && !text.includes('\n') ? `${pick(OPENERS)} ${text}` : text);
  };
}

module.exports = { createLocalWasteman, understand, norm };

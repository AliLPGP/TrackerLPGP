// Exercises the bridge's routes against a stubbed DB, so the auth guard,
// grouping, matching and payload shapes are verified without Postgres.
process.env.OPS_BRIDGE_KEY = 'test-secret-key';
const express = require('express');
const { createBridgeRouter } = require('../bridge.js');
const { createProgrammeRouter } = require('../programme-routes');

// Two deals for Barings (one per event cycle), one for BlackRock, one cancelled.
const DEAL_ROWS = [
  { id: 1, title: 'Barings — Berlin', company: 'Barings LLC', contact_name: 'Jane Doe',
    amount: '4000.00', currency: 'GBP', stage: 'Won', notes: '', paid_inc_vat: '4800.00',
    tax_vat: '800.00', invoice_date: '2026-02-01', paid_date: '2026-02-14', bank: 'HSBC',
    invoice_number: 'INV-1042', invoice_agreement_sent: true, signature_received: true,
    initials: 'AB', deal_month: 'Feb', fiscal_year: 2026, stage_cancelled: false,
    is_flagged: false, created_at: '2026-01-05T00:00:00Z',
    invoice1_name: 'INV-1042.pdf', invoice2_name: 'INV-1042-signed.pdf',
    events: [
      { event_id: 10, event_name: 'Berlin', event_date: '2026-05-12', location: 'Waldorf Astoria', allocated_amount: '2000.00', package_label: 'Gold' },
      { event_id: 11, event_name: 'CFO Miami', event_date: '2026-09-02', location: 'Four Seasons', allocated_amount: '2000.00', package_label: '' },
    ] },
  { id: 2, title: 'Barings renewal', company: 'Barings', contact_name: '', amount: '1500.00',
    currency: 'GBP', stage: 'Proposal', notes: '', paid_inc_vat: null, tax_vat: null,
    invoice_date: null, paid_date: null, bank: '', invoice_number: '',
    invoice_agreement_sent: false, signature_received: false, initials: '', deal_month: '',
    fiscal_year: 2027, stage_cancelled: false, is_flagged: false,
    created_at: '2026-03-01T00:00:00Z', invoice1_name: null, invoice2_name: null,
    events: [{ event_id: 12, event_name: 'Ops NYC', event_date: '2027-01-20', location: '', allocated_amount: '1500.00', package_label: 'Silver' }] },
  { id: 3, title: 'BlackRock', company: 'BlackRock', contact_name: '', amount: '9000.00',
    currency: 'USD', stage: 'Won', notes: '', paid_inc_vat: '9000.00', tax_vat: '0',
    invoice_date: null, paid_date: null, bank: '', invoice_number: '',
    invoice_agreement_sent: false, signature_received: false, initials: '', deal_month: '',
    fiscal_year: 2026, stage_cancelled: false, is_flagged: false,
    created_at: '2026-01-01T00:00:00Z', invoice1_name: 'BR-agreement.pdf', invoice2_name: null,
    events: [{ event_id: 10, event_name: 'Berlin', event_date: '2026-05-12', location: '', allocated_amount: '9000.00', package_label: '' }] },
  { id: 4, title: 'Barings cancelled', company: 'Barings', contact_name: '', amount: '500.00',
    currency: 'GBP', stage: 'Lost', notes: '', paid_inc_vat: null, tax_vat: null,
    invoice_date: null, paid_date: null, bank: '', invoice_number: '',
    invoice_agreement_sent: false, signature_received: false, initials: '', deal_month: '',
    fiscal_year: 2026, stage_cancelled: true, is_flagged: false,
    created_at: '2026-01-02T00:00:00Z', events: [] },
];

process.env.OPS_BRIDGE_WRITE_KEY = 'test-write-key';

// Mutable state so writes are observable. Deliberately minimal — it models the
// three tables the bridge touches, not Postgres.
const DB = { deals: [...DEAL_ROWS], allocations: [], nextId: 5, events: [
  { id: 10, name: 'Berlin',        event_date: '2026-05-12', location: 'Waldorf', notes: '', producer: '', date_tbc: '', programme_year: null, programme_key: null, deal_count: 2 },
  { id: 11, name: 'CFO Miami',     event_date: '2026-09-02', location: 'Four Seasons', notes: '', producer: '', date_tbc: '', programme_year: null, programme_key: null, deal_count: 1 },
  { id: 12, name: 'Ops NYC',       event_date: '2027-01-20', location: '', notes: '', producer: '', date_tbc: '', programme_year: null, programme_key: null, deal_count: 1 },
  { id: 13, name: 'PD NYC (Womens)', event_date: '2027-04-15', location: '', notes: 'womens', producer: '', date_tbc: '', programme_year: null, programme_key: null, deal_count: 0 },
], nextEventId: 14 };
const EVENT_IDS = [10, 11, 12];

async function q(sql, params = []) {
  // --- writes ---
  if (/^\s*INSERT INTO deals/i.test(sql)) {
    const [title, company, contact_name, amount, currency, stage, notes,
           paid_inc_vat, tax_vat, invoice_date, paid_date, bank, invoice_number,
           , , , deal_month, fiscal_year] = params;
    const row = {
      ...DEAL_ROWS[0], id: DB.nextId++, title, company, contact_name,
      amount: String(amount), currency, stage, notes, paid_inc_vat, tax_vat,
      invoice_date, paid_date, bank, invoice_number, deal_month: deal_month || '', fiscal_year: fiscal_year ?? null,
      stage_cancelled: false, events: [],
    };
    DB.deals.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (/^\s*INSERT INTO deal_events/i.test(sql)) {
    const [deal_id, event_id, allocated_amount, package_label] = params;
    DB.allocations.push({ deal_id, event_id, allocated_amount, package_label });
    const deal = DB.deals.find((d) => d.id === deal_id);
    if (deal) {
      deal.events.push({ event_id, event_name: `Event ${event_id}`, event_date: null,
        location: '', allocated_amount: String(allocated_amount), package_label });
    }
    return { rows: [] };
  }
  if (/^\s*DELETE FROM deal_events/i.test(sql)) {
    const [deal_id] = params;
    DB.allocations = DB.allocations.filter((a) => a.deal_id !== deal_id);
    const deal = DB.deals.find((d) => d.id === Number(deal_id));
    if (deal) deal.events = [];
    return { rows: [] };
  }
  if (/^\s*UPDATE deals SET\s+title/i.test(sql)) {
    const id = params[params.length - 1];
    const deal = DB.deals.find((d) => d.id === Number(id));
    if (deal) {
      deal.contact_name = params[2]; deal.amount = String(params[3]);
      deal.currency = params[4]; deal.stage = params[5];
      deal.paid_inc_vat = params[7]; deal.invoice_number = params[12];
      if (params[0]) deal.title = params[0];
    }
    return { rows: deal ? [{ id: deal.id }] : [] };
  }
  if (/^\s*UPDATE deals SET invoice\d_name/i.test(sql)) {
    const [name, data, id] = params;
    const deal = DB.deals.find((d) => d.id === Number(id));
    if (deal) { deal.invoice1_name = name; deal.invoice1_data = data; }
    return { rows: deal ? [{ id: deal.id }] : [] };
  }
  // The reconcile read and the bridge's /events read both join deal_events;
  // only the bridge one sums allocations.
  if (/pe\.programme_key,\s*COUNT\(DISTINCT de\.deal_id\)/i.test(sql) && !/allocated_total/i.test(sql)) {
    return { rows: DB.events.map((e) => ({ ...e, deal_count: String(e.deal_count) })) };
  }
  if (/^\s*UPDATE portfolio_events\s+SET name=/i.test(sql)) {
    const [name, event_date, location, producer, date_tbc, programme_year, programme_key, notes, id, year] = params;
    const ev = DB.events.find((e) => e.id === Number(id));
    if (!ev) return { rows: [] };
    // WHERE id=? AND programme_key IS NULL AND COALESCE(programme_year, year(event_date)) = ?
    const evYear = ev.programme_year != null ? Number(ev.programme_year) : (ev.event_date ? Number(String(ev.event_date).slice(0, 4)) : null);
    if (ev.programme_key || evYear !== Number(year)) return { rows: [] };
    Object.assign(ev, { name, event_date, producer, date_tbc, programme_year, programme_key, notes });
    if (!ev.location) ev.location = location;
    return { rows: [{ id: ev.id }] };
  }
  // --- programme merge: three statements, each a no-op when there is nothing left to do ---
  if (/^\s*WITH gone AS \(\s*DELETE FROM deal_events o/i.test(sql)) {
    const [oldId, intoId] = params.map(Number);
    const gone = DB.allocations.filter((a) => Number(a.event_id) === oldId
      && DB.allocations.some((x) => Number(x.event_id) === intoId && x.deal_id === a.deal_id));
    DB.allocations = DB.allocations.filter((a) => !gone.includes(a));
    for (const g of gone) {
      const kept = DB.allocations.find((x) => Number(x.event_id) === intoId && x.deal_id === g.deal_id);
      kept.allocated_amount = Number(kept.allocated_amount) + Number(g.allocated_amount);
      if (!kept.package_label) kept.package_label = g.package_label;
    }
    return { rows: gone.map((g) => ({ deal_id: g.deal_id })) };
  }
  if (/^\s*UPDATE deal_events SET event_id = \? WHERE event_id = \?/i.test(sql)) {
    const [intoId, oldId] = params.map(Number);
    const moved = DB.allocations.filter((a) => Number(a.event_id) === oldId);
    moved.forEach((a) => { a.event_id = intoId; });
    return { rows: moved.map((a) => ({ deal_id: a.deal_id })) };
  }
  if (/^\s*UPDATE portfolio_events\s+SET event_date=\?, date_tbc=\?, location=CASE/i.test(sql)) {
    const [event_date, date_tbc, location, notes, id, programme_key] = params;
    const ev = DB.events.find((e) => e.id === Number(id) && e.programme_key === programme_key);
    if (!ev) return { rows: [] };
    Object.assign(ev, { event_date, date_tbc, notes });
    if (!ev.location) ev.location = location;
    return { rows: [{ id: ev.id }] };
  }
  if (/^\s*DELETE FROM portfolio_events\s+WHERE id = \? AND programme_key IS NULL\s+AND NOT EXISTS/i.test(sql)) {
    const id = Number(params[0]);
    const ev = DB.events.find((e) => e.id === id && !e.programme_key);
    if (!ev || DB.allocations.some((a) => Number(a.event_id) === id)) return { rows: [] };
    DB.events = DB.events.filter((e) => e !== ev);
    return { rows: [{ id }] };
  }
  if (/^\s*UPDATE portfolio_events SET programme_key = NULL/i.test(sql)) {
    const ev = DB.events.find((e) => e.id === Number(params[0]) && e.programme_key);
    if (!ev) return { rows: [] };
    ev.programme_key = null;
    return { rows: [{ id: ev.id }] };
  }
  if (/^\s*INSERT INTO portfolio_events/i.test(sql)) {
    const [name, event_date, location, producer, date_tbc, programme_year, programme_key] = params;
    const ev = { id: DB.nextEventId++, name, event_date, location, notes: '', producer, date_tbc, programme_year, programme_key, deal_count: 0 };
    DB.events.push(ev);
    return { rows: [{ id: ev.id }] };
  }
  if (/SELECT DISTINCT COALESCE\(programme_year, EXTRACT\(YEAR FROM event_date\)::int\) AS y/i.test(sql)) {
    const ids = params.map(Number);
    const ys = new Set(DB.events.filter((e) => ids.includes(e.id)).map((e) =>
      e.programme_year != null ? Number(e.programme_year) : (e.event_date ? Number(String(e.event_date).slice(0, 4)) : null)));
    return { rows: [...ys].map((y) => ({ y })) };
  }
  if (/SELECT id FROM portfolio_events WHERE id IN/i.test(sql)) {
    return { rows: params.filter((p) => EVENT_IDS.includes(Number(p))).map((id) => ({ id })) };
  }
  if (/SELECT id FROM deals WHERE invoice_number/i.test(sql)) {
    const [invoice_number, excludeId] = params;
    const hit = DB.deals.find(
      (d) => d.invoice_number === invoice_number && (excludeId == null || d.id !== Number(excludeId))
    );
    return { rows: hit ? [{ id: hit.id }] : [] };
  }
  if (/^\s*SELECT id FROM deals WHERE id/i.test(sql)) {
    const hit = DB.deals.find((d) => d.id === Number(params[0]));
    return { rows: hit ? [{ id: hit.id }] : [] };
  }
  return readQuery(sql, params);
}

async function readQuery(sql, params = []) {
  if (/FROM deals d/i.test(sql) && /WHERE d\.id/i.test(sql)) {
    const id = Number(params[0] ?? 0);
    const hit = DB.deals.find((d) => d.id === id) || DEAL_ROWS[0];
    return { rows: [hit] };
  }
  if (/FROM deals d/i.test(sql)) return { rows: DB.deals };
  if (/SELECT\s+\(SELECT COUNT/i.test(sql)) return { rows: [{ deals: 4, events: 3, allocations: 4 }] };
  if (/FROM portfolio_events pe/i.test(sql)) {
    return { rows: [{ id: 10, name: 'Berlin', event_date: '2026-05-12', location: 'Waldorf', notes: '', producer: 'Arj & Leena', date_tbc: 'day', programme_year: 2026, programme_key: null, deal_count: 2, allocated_total: '11000.00', allocated_paid: '11000.00' }] };
  }
  if (/FROM deal_events de/i.test(sql)) {
    return { rows: [{ deal_id: 1, company: 'Barings LLC', currency: 'GBP', stage: 'Won', paid_inc_vat: '4800.00', contact_name: 'Jane Doe', initials: 'JS', allocated_amount: '2000.00', package_label: 'Gold' }] };
  }
  throw new Error('unexpected SQL: ' + sql.slice(0, 60));
}

const app = express();
app.use('/api/bridge', createBridgeRouter({ q, ensureDb: async () => {} }));
app.use('/api/programme', createProgrammeRouter({ q, requireAuth: (req, _res, next) => { req.admin = { id: 1 }; next(); }, requireAdminOrManager: null }));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api/bridge`;
  const KEY = { 'x-ops-key': 'test-secret-key' };
  let pass = 0, fail = 0;
  const check = (label, cond, detail) => {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
  };

  console.log('\nAuth');
  check('no key → 401', (await fetch(`${base}/ping`)).status === 401);
  check('wrong key → 401', (await fetch(`${base}/ping`, { headers: { 'x-ops-key': 'nope' } })).status === 401);
  check('bearer form accepted', (await fetch(`${base}/ping`, { headers: { authorization: 'Bearer test-secret-key' } })).status === 200);

  console.log('\nMatch: the Barings scenario');
  const m = await (await fetch(`${base}/match?name=Barings`, { headers: KEY })).json();
  const best = m.best;
  check('finds Barings', best?.company?.startsWith('Barings'), JSON.stringify(best?.company));
  check('exact match confidence', best?.exact === true, `confidence ${best?.confidence}`);
  check('groups both live deals, excludes the cancelled one', best?.deal_count === 2, `deal_count ${best?.deal_count}`);
  check('counts the cancelled deal separately', best?.cancelled_count === 1);
  check('rolls up 3 events', best?.event_count === 3, JSON.stringify(best?.events?.map(e => e.event_name)));
  const berlin = best?.events?.find(e => e.event_name === 'Berlin');
  check('Berlin allocation is 2000 (not BlackRock\'s 9000)', berlin?.allocated_amount === 2000, String(berlin?.allocated_amount));
  check('carries the package label', berlin?.package_labels?.includes('Gold'));
  check('GBP total is 5500 contracted', best?.totals?.[0]?.contracted === 5500, JSON.stringify(best?.totals));
  check('paid flagged', best?.has_payment === true);

  console.log('\nMatch: no false positives');
  const br = await (await fetch(`${base}/match?name=BlackRock`, { headers: KEY })).json();
  check('BlackRock resolves to BlackRock', br.best?.company === 'BlackRock', br.best?.company);
  check('BlackRock does not match Barings', !br.matches.some(x => x.company.startsWith('Barings')));
  const none = await (await fetch(`${base}/match?name=Zzyzx%20Holdings`, { headers: KEY })).json();
  check('unknown name → no matches', none.match_count === 0);
  check('blank name → 400', (await fetch(`${base}/match?name=`, { headers: KEY })).status === 400);

  console.log('\nCurrency handling');
  const all = await (await fetch(`${base}/companies`, { headers: KEY })).json();
  const brc = all.find(c => c.company === 'BlackRock');
  check('USD kept separate from GBP', brc?.totals?.length === 1 && brc.totals[0].currency === 'USD');
  const slim = await (await fetch(`${base}/companies?slim=1`, { headers: KEY })).json();
  check('slim carries deal_ids for reconcile', Array.isArray(slim[0]?.events?.[0]?.deal_ids));
  check('slim omits full deal bodies', slim[0]?.deals === undefined);

  console.log('\nOther routes');
  check('deals/:id returns a shaped deal', (await (await fetch(`${base}/deals/1`, { headers: KEY })).json()).invoice_number === 'INV-1042');
  check('events returns numbers not strings', typeof (await (await fetch(`${base}/events`, { headers: KEY })).json())[0].allocated_total === 'number');
  const evs = await (await fetch(`${base}/events`, { headers: KEY })).json();
  check('events carry the producer team', evs[0].producer === 'Arj & Leena', JSON.stringify(evs[0]));
  check('events say when a day is still TBC', evs[0].date_tbc === 'day');
  check('events carry the programme year as a number', evs[0].programme_year === 2026);
  const sponsors = await (await fetch(`${base}/events/10/sponsors`, { headers: KEY })).json();
  check('event sponsors listed', sponsors[0].company === 'Barings LLC');
  check('sponsor carries the signer\'s initials', sponsors[0].initials === 'JS', JSON.stringify(sponsors[0]));

  const WKEY = { 'x-ops-key': 'test-secret-key', 'x-ops-write-key': 'test-write-key', 'content-type': 'application/json' };
  const post = (path, body, headers = WKEY) =>
    fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const patch = (path, body) =>
    fetch(`${base}${path}`, { method: 'PATCH', headers: WKEY, body: JSON.stringify(body) });

  console.log('\nAgreement status');
  const allDeals = await (await fetch(`${base}/deals?include_cancelled=1`, { headers: KEY })).json();
  const byId = Object.fromEntries(allDeals.map((d) => [d.id, d]));
  check('signed when the signature is in', byId[1]?.agreement_status === 'signed', byId[1]?.agreement_status);
  check(
    'need_invoice when nothing is on file',
    byId[2]?.agreement_status === 'need_invoice',
    byId[2]?.agreement_status
  );
  check(
    'awaiting_signature once the agreement is filed',
    byId[3]?.agreement_status === 'awaiting_signature',
    byId[3]?.agreement_status
  );
  check('carries the agreement file name', byId[1]?.agreement_file === 'INV-1042.pdf');

  console.log('\nListing deals');
  const live = await (await fetch(`${base}/deals`, { headers: KEY })).json();
  check('cancelled excluded by default', !live.some((d) => d.cancelled), String(live.length));
  const mine = await (await fetch(`${base}/deals?initials=ab`, { headers: KEY })).json();
  check('filters by initials, case and dots ignored', mine.length === 1 && mine[0].id === 1, JSON.stringify(mine.map((d) => d.id)));
  const chasing = await (await fetch(`${base}/deals?status=need_invoice`, { headers: KEY })).json();
  check('filters by agreement status', chasing.every((d) => d.agreement_status === 'need_invoice') && chasing.length > 0);
  const byCompany = await (await fetch(`${base}/deals?company=${encodeURIComponent('Barings LLC')}`, { headers: KEY })).json();
  check('company filter uses the match key', byCompany.length === 2, JSON.stringify(byCompany.map((d) => d.id)));

  console.log('\nWrite auth');
  check(
    'write with only the read key → 401',
    (await post('/deals', { company: 'X' }, { ...KEY, 'content-type': 'application/json' })).status === 401
  );
  check(
    'wrong write key → 401',
    (await post('/deals', { company: 'X' }, { ...WKEY, 'x-ops-write-key': 'nope' })).status === 401
  );

  console.log('\nCreating a deal');
  const createRes = await post('/deals', {
    company: 'Apex Group',
    contact_name: 'Sam Patel',
    amount: 9000,
    currency: 'GBP',
    stage: 'Won',
    invoice_number: 'INV-2001',
    paid_inc_vat: 10800,
    tax_vat: 1800,
    invoice_date: '2027-01-15',
    event_packages: [
      { event_id: 10, amount: 5000, package_label: 'Gold' },
      { event_id: 11, amount: 4000, package_label: '' },
    ],
  });
  const created = await createRes.json();
  check('returns 201', createRes.status === 201, String(createRes.status));
  check('deal carries the company', created.company === 'Apex Group', created.company);
  check('both allocations written', created.events?.length === 2, JSON.stringify(created.events));
  check(
    'allocations keep their split',
    created.events?.[0]?.allocated_amount === 5000 && created.events?.[1]?.allocated_amount === 4000,
    JSON.stringify(created.events?.map((e) => e.allocated_amount))
  );
  check('package label preserved', created.events?.[0]?.package_label === 'Gold');
  check('programme year taken from the events (both 2026)', created.fiscal_year === 2026, String(created.fiscal_year));

  const forNext = await (await post('/deals', {
    company: 'Highspring', amount: 40000, currency: 'GBP', stage: 'Won', deal_month: '26 - Sep',
    event_ids: [12],
  })).json();
  check('a deal signed in 2026 for a 2027 event is a 2027 deal', forNext.fiscal_year === 2027, String(forNext.fiscal_year));
  check('...while its signed month stays Sep 2026', forNext.deal_month === '26 - Sep', forNext.deal_month);
  const explicit = await (await post('/deals', {
    company: 'Explicit Ltd', amount: 100, currency: 'GBP', stage: 'Won', fiscal_year: 2028, event_ids: [12],
  })).json();
  check('an explicit programme year wins over the events', explicit.fiscal_year === 2028, String(explicit.fiscal_year));
  const spread = await (await post('/deals', {
    company: 'Spread Ltd', amount: 100, currency: 'GBP', stage: 'Won', event_ids: [10, 12],
  })).json();
  check('events in two years leave the year unset', spread.fiscal_year == null, String(spread.fiscal_year));

  console.log('\nValidation refuses bad writes');
  check('no company → 400', (await post('/deals', { amount: 1 })).status === 400);
  check('unknown stage → 400', (await post('/deals', { company: 'X', stage: 'Bananas' })).status === 400);
  check('negative amount → 400', (await post('/deals', { company: 'X', amount: -5 })).status === 400);
  check(
    'unknown event id → 400',
    (await post('/deals', { company: 'X', event_packages: [{ event_id: 999, amount: 1 }] })).status === 400
  );
  const dupe = await post('/deals', { company: 'Other', invoice_number: 'INV-2001' });
  check('duplicate invoice number → 409', dupe.status === 409, String(dupe.status));

  console.log('\nUpdating a deal');
  const patched = await patch(`/deals/${created.id}`, {
    company: 'Apex Group',
    amount: 9000,
    stage: 'Won',
    paid_inc_vat: 10800,
    paid_date: '2027-02-01',
    event_packages: [{ event_id: 12, amount: 9000, package_label: 'Platinum' }],
  });
  const after = await patched.json();
  check('patch returns 200', patched.status === 200, String(patched.status));
  check('allocations replaced wholesale', after.events?.length === 1, JSON.stringify(after.events));
  check('new allocation is the one sent', after.events?.[0]?.event_id === 12);
  check('missing deal → 404', (await patch('/deals/99999', { amount: 1 })).status === 404);

  console.log('\nAttaching an invoice');
  const inv = await post(`/deals/${created.id}/invoice/1`, { name: 'INV-2001.pdf', data: 'JVBERi0x' });
  check('invoice attaches', inv.status === 200 && (await inv.json()).name === 'INV-2001.pdf');
  check(
    'invalid slot → 400',
    (await post(`/deals/${created.id}/invoice/3`, { name: 'a', data: 'b' })).status === 400
  );
  check('missing data → 400', (await post(`/deals/${created.id}/invoice/1`, { name: 'a' })).status === 400);

  console.log('\nProgramme reconcile');
  const pbase = `http://127.0.0.1:${server.address().port}/api/programme/2027`;
  let prog = await (await fetch(pbase)).json();
  check('all 25 confirmed events listed', prog.items.length === 25, String(prog.items.length));
  const opsNy = prog.items.find((i) => i.key === 'ops-new-york');
  const pdNy  = prog.items.find((i) => i.key === 'pd-new-york');
  const sports = prog.items.find((i) => i.key === 'sports-new-york');
  check('shorthand "Ops NYC" suggested for Operating Partners New York', opsNy?.suggestion?.id === 12, JSON.stringify(opsNy?.suggestion));
  check('"PD NYC (Womens)" suggested for Private Debt New York', pdNy?.suggestion?.id === 13, JSON.stringify(pdNy?.suggestion));
  check('Sports Investing does not steal the PD row', sports?.suggestion == null, JSON.stringify(sports?.suggestion));
  check('the 2026 Berlin row is never suggested', !prog.items.some((i) => i.suggestion?.id === 10));
  check('nothing is applied by merely reading', DB.events.find((e) => e.id === 12).name === 'Ops NYC');

  const applied = await (await fetch(`${pbase}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decisions: [
      { key: 'ops-new-york', action: 'rename', row_id: 12 },
      { key: 'pd-berlin',    action: 'create' },
      { key: 'sports-new-york', action: 'skip' },
    ] }) })).json();
  const renamed = DB.events.find((e) => e.id === 12);
  check('rename keeps the id and the deals', renamed.name === '3rd Annual Operating Partners New York' && renamed.deal_count === 1, JSON.stringify(renamed));
  check('rename records the old name', /Previously "Ops NYC"/.test(renamed.notes), renamed.notes);
  check('rename links the programme key', renamed.programme_key === '2027:ops-new-york');
  check('rename carries producer and date', renamed.producer === 'Tara & Maryam' && renamed.event_date === '2027-05-19');
  check('create inserts a linked row', DB.events.some((e) => e.programme_key === '2027:pd-berlin' && e.producer === 'Arj & Leena'));
  // The list says "April TBC"; the row knows it is 15 April. The row wins.
  const keepDay = await (await fetch(`${pbase}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decisions: [{ key: 'pd-new-york', action: 'rename', row_id: 13 }] }) })).json();
  const pdNyRow = DB.events.find((e) => e.id === 13);
  check('rename keeps a real day the list only calls TBC', keepDay.results[0].outcome === 'renamed' && pdNyRow.event_date === '2027-04-15' && pdNyRow.date_tbc === '', JSON.stringify(pdNyRow));
  check('...and still takes the confirmed name and team', pdNyRow.name === '13th Annual Private Debt New York' && pdNyRow.producer === 'Arj & Leena');
  check('skip does nothing', applied.results.find((r) => r.key === 'sports-new-york').outcome === 'skipped');

  const again = await (await fetch(`${pbase}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decisions: [{ key: 'ops-new-york', action: 'rename', row_id: 12 }, { key: 'pd-berlin', action: 'create' }] }) })).json();
  check('re-applying is a no-op', again.results.every((r) => r.outcome === 'already-linked'), JSON.stringify(again.results));
  check('no duplicate row from the second create', DB.events.filter((e) => e.programme_key === '2027:pd-berlin').length === 1);
  prog = await (await fetch(pbase)).json();
  check('linked rows report as linked', prog.items.find((i) => i.key === 'ops-new-york').status === 'linked');

  // The guards a client cannot talk its way past.
  const wrongYear = await (await fetch(`${pbase}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decisions: [{ key: 'pd-chicago', action: 'rename', row_id: 10 }] }) })).json();
  check('a 2026 row cannot be renamed into the 2027 programme', wrongYear.results[0].outcome === 'row-wrong-year', JSON.stringify(wrongYear.results));
  check('...and the 2026 row is untouched', DB.events.find((e) => e.id === 10).name === 'Berlin' && DB.events.find((e) => e.id === 10).programme_key == null);
  const rePoint = await (await fetch(`${pbase}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decisions: [{ key: 'ops-europe', action: 'rename', row_id: 12 }] }) })).json();
  check('a linked row cannot be re-pointed at another event', rePoint.results[0].outcome === 'row-already-linked', JSON.stringify(rePoint.results));
  check('...and keeps its original key', DB.events.find((e) => e.id === 12).programme_key === '2027:ops-new-york');

  // Undo: unlink clears the key and nothing else.
  const rowBefore = { ...DB.events.find((e) => e.id === 12) };
  const unlinked = await (await fetch(`${pbase}/unlink`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ row_id: 12 }) })).json();
  const rowAfter = DB.events.find((e) => e.id === 12);
  check('unlink succeeds', unlinked.ok === true, JSON.stringify(unlinked));
  check('unlink clears only the key', rowAfter.programme_key == null && rowAfter.name === rowBefore.name && rowAfter.event_date === rowBefore.event_date && rowAfter.deal_count === rowBefore.deal_count);
  prog = await (await fetch(pbase)).json();
  check('an unlinked row becomes a suggestion again', prog.items.find((i) => i.key === 'ops-new-york').suggestion?.id === 12);
  check('unlinking an unlinked row is a 404', (await fetch(`${pbase}/unlink`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ row_id: 11 }) })).status === 404);

  console.log('\nProgramme merge');
  const decide = async (decisions) => (await fetch(`${pbase}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decisions }) })).json();
  // The state a panel user can end up in: the confirmed event was created
  // rather than renamed, so the old shorthand row still sits beside it with
  // the deals on it.
  await decide([{ key: 'ops-new-york', action: 'rename', row_id: 12 }]);   // re-link after the unlink check above
  DB.events.push({ id: 30, name: 'OPS NYC', event_date: '2027-05-20', location: 'Convene', notes: '', producer: '', date_tbc: '', programme_year: null, programme_key: null, deal_count: 2 });
  DB.allocations.push(
    { deal_id: 2, event_id: 12, allocated_amount: 1500, package_label: 'Silver' },   // already on the linked row
    { deal_id: 2, event_id: 30, allocated_amount: 500, package_label: '' },          // ...and on the old one too
    { deal_id: 3, event_id: 30, allocated_amount: 2000, package_label: 'Gold' },
  );
  const sumAlloc = () => DB.allocations.reduce((a, x) => a + Number(x.allocated_amount), 0);
  const allocBefore = sumAlloc();
  prog = await (await fetch(pbase)).json();
  const opsNyLinked = prog.items.find((i) => i.key === 'ops-new-york');
  check('an older row beside a linked event is offered as its duplicate', opsNyLinked.status === 'linked' && opsNyLinked.duplicate?.id === 30, JSON.stringify(opsNyLinked.duplicate));
  check('...and counted', prog.counts.duplicates === 1, String(prog.counts.duplicates));
  check('...and not also suggested as a rename for another event', !prog.items.some((i) => i.suggestion?.id === 30));
  check('reading changes nothing', DB.events.some((e) => e.id === 30) && sumAlloc() === allocBefore);

  const merged = await decide([{ key: 'ops-new-york', action: 'merge', row_id: 30 }]);
  const mergeRes = merged.results[0];
  check('merge reports what moved', mergeRes.outcome === 'merged' && mergeRes.id === 12 && mergeRes.from_id === 30 && mergeRes.deals_moved === 2, JSON.stringify(mergeRes));
  check('the old row is gone', !DB.events.some((e) => e.id === 30));
  const survivor = DB.events.find((e) => e.id === 12);
  check('the linked row keeps its id, name and key', survivor.programme_key === '2027:ops-new-york' && survivor.name === '3rd Annual Operating Partners New York');
  const d2 = DB.allocations.filter((a) => a.deal_id === 2);
  check('a deal on both rows becomes one allocation with the amounts added', d2.length === 1 && Number(d2[0].event_id) === 12 && Number(d2[0].allocated_amount) === 2000 && d2[0].package_label === 'Silver', JSON.stringify(d2));
  const d3 = DB.allocations.find((a) => a.deal_id === 3);
  check('a deal only on the old row moves as it is', Number(d3.event_id) === 12 && Number(d3.allocated_amount) === 2000 && d3.package_label === 'Gold', JSON.stringify(d3));
  check('not a penny lost or invented', sumAlloc() === allocBefore, `${sumAlloc()} vs ${allocBefore}`);
  check('the survivor keeps its confirmed date and its own location', survivor.event_date === '2027-05-19' && survivor.date_tbc === '' && survivor.location === 'New York, USA', JSON.stringify(survivor));
  check('...and remembers the old name', /Merged "OPS NYC" \(#30, 2 deals\)/.test(survivor.notes), survivor.notes);
  check('applying the same merge again finds nothing to do', (await decide([{ key: 'ops-new-york', action: 'merge', row_id: 30 }])).results[0].outcome === 'row-not-found');
  check('no repeat of the merge note', (survivor.notes.match(/Merged "OPS NYC"/g) || []).length === 1, survivor.notes);

  // The confirmed entry only says "May TBC"; the old row knew it was the 5th.
  const createdMiami = (await decide([{ key: 'cfo-pm-miami', action: 'create' }])).results[0];
  DB.events.push({ id: 31, name: 'CFO/COO Private Markets Miami', event_date: '2027-05-05', location: '', notes: '', producer: '', date_tbc: '', programme_year: null, programme_key: null, deal_count: 1 });
  DB.allocations.push({ deal_id: 4, event_id: 31, allocated_amount: 3000, package_label: '' });
  prog = await (await fetch(pbase)).json();
  check('the shorthand Miami row is the created event\'s duplicate', prog.items.find((i) => i.key === 'cfo-pm-miami').duplicate?.id === 31);
  const miami = (await decide([{ key: 'cfo-pm-miami', action: 'merge', row_id: 31 }])).results[0];
  const miamiRow = DB.events.find((e) => e.id === createdMiami.id);
  check('merge keeps the real day the list only calls TBC', miami.outcome === 'merged' && miamiRow.event_date === '2027-05-05' && miamiRow.date_tbc === '', JSON.stringify(miamiRow));
  check('...and its deal came with it', Number(DB.allocations.find((a) => a.deal_id === 4).event_id) === createdMiami.id);

  const guards = await decide([
    { key: 'pd-london', action: 'merge', row_id: 11 },       // pd-london has no linked row
    { key: 'cfo-pm-miami', action: 'merge', row_id: 11 },    // row 11 is a 2026 row
    { key: 'cfo-pm-miami', action: 'merge', row_id: 12 },    // row 12 is itself linked
  ]);
  check('merging into an event with no linked row is refused', guards.results[0].outcome === 'not-linked', JSON.stringify(guards.results[0]));
  check('a 2026 row is never merged into the 2027 programme', guards.results[1].outcome === 'row-wrong-year' && DB.events.some((e) => e.id === 11), JSON.stringify(guards.results[1]));
  check('a linked row is never merged away', guards.results[2].outcome === 'row-already-linked' && DB.events.some((e) => e.id === 12), JSON.stringify(guards.results[2]));

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
});

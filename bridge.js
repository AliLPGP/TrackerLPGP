// ─────────────────────────────────────────────────────────────────────────────
// Ops-panel bridge
//
// The JSON surface the Sales CRM (LPGP-CRM) calls server-to-server. It answers
// "does this company already exist as a deal here, and which events is it
// sponsoring?", and — when explicitly enabled — lets the CRM record deals
// without the tracker ceasing to be the single source of truth for money.
//
// Two secrets, two postures:
//   OPS_BRIDGE_KEY        (x-ops-key)       reads. Always required.
//   OPS_BRIDGE_WRITE_KEY  (x-ops-write-key) writes. Absent ⇒ every write 503s.
//
// They are deliberately separate: a leaked read key must never be able to
// create a financial record. Neither is the admin session cookie, because the
// caller is another service rather than a logged-in browser.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const crypto = require('crypto');

// Legal-entity suffixes only. Deliberately conservative: stripping words like
// "Capital" or "Partners" would collapse genuinely different firms
// ("Apollo Global Management" vs "Apollo Capital") into one match.
const LEGAL_SUFFIXES = new Set([
  'ltd', 'limited', 'llc', 'llp', 'lp', 'inc', 'incorporated', 'corp',
  'corporation', 'co', 'plc', 'gmbh', 'ag', 'sa', 'sas', 'nv', 'bv', 'ab',
  'as', 'oy', 'spa', 'srl', 'pte', 'pty', 'kk', 'kg', 'mbh', 'sarl', 'aps',
]);

/** Lowercase, de-accent, strip punctuation, collapse whitespace. */
function normalizeName(raw) {
  return String(raw || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Normalized name with trailing legal-entity words removed. */
function matchKey(raw) {
  const tokens = normalizeName(raw).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Score how confidently `query` refers to `candidate`. 1 = certain, 0 = no.
 * Tiers are ordered so an exact hit never loses to a fuzzy one.
 */
function scoreMatch(query, candidate) {
  const qn = normalizeName(query);
  const cn = normalizeName(candidate);
  if (!qn || !cn) return 0;
  if (qn === cn) return 1;

  const qk = matchKey(query);
  const ck = matchKey(candidate);
  if (qk && qk === ck) return 0.96;

  // "Barings" vs "Barings Real Estate" — a prefix match is strong, but the
  // shorter name has to be a meaningful chunk of the longer one.
  const [shortKey, longKey] = qk.length <= ck.length ? [qk, ck] : [ck, qk];
  if (shortKey && longKey.startsWith(shortKey + ' ')) {
    const ratio = shortKey.length / longKey.length;
    if (ratio >= 0.4) return 0.88;
    if (ratio >= 0.25) return 0.78;
  }
  if (shortKey.length >= 5 && longKey.includes(shortKey)) return 0.72;

  const j = jaccard(qk.split(' ').filter(Boolean), ck.split(' ').filter(Boolean));
  if (j >= 0.5) return 0.5 + j * 0.3;
  return j > 0 ? j * 0.5 : 0;
}

function timingSafeCompare(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, so compare digests instead —
  // equal-length inputs regardless of the secrets' real lengths.
  const ah = crypto.createHash('sha256').update(ab).digest();
  const bh = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Where a deal stands on paperwork.
 *
 *   need_invoice        nothing on file to send — the admin still owes the
 *                       client an agreement/invoice
 *   awaiting_signature  sent, but the signed copy hasn't come back
 *   signed              signature received
 *
 * Keyed off the FILE, not the "sent" tick: a deal can be marked sent with
 * nothing filed, and that still means someone has to produce the document.
 */
function agreementStatus(row) {
  if (row.signature_received) return 'signed';
  if (!row.invoice1_name) return 'need_invoice';
  return 'awaiting_signature';
}

/**
 * Shape one DB row into the deal payload the CRM consumes. Keeps the contract
 * explicit so tracker-side column changes don't silently leak through.
 */
function shapeDeal(row) {
  const events = Array.isArray(row.events) ? row.events : [];
  return {
    id: row.id,
    title: row.title || '',
    company: row.company || row.title || '',
    contact_name: row.contact_name || '',
    amount: toNum(row.amount) ?? 0,
    currency: row.currency || 'GBP',
    stage: row.stage || 'Prospect',
    cancelled: Boolean(row.stage_cancelled),
    flagged: Boolean(row.is_flagged),
    paid_inc_vat: toNum(row.paid_inc_vat),
    tax_vat: toNum(row.tax_vat),
    invoice_number: row.invoice_number || '',
    invoice_date: row.invoice_date || null,
    paid_date: row.paid_date || null,
    bank: row.bank || '',
    initials: row.initials || '',
    fiscal_year: row.fiscal_year ?? null,
    deal_month: row.deal_month || '',
    invoice_agreement_sent: Boolean(row.invoice_agreement_sent),
    signature_received: Boolean(row.signature_received),
    agreement_status: agreementStatus(row),
    // Names only — the files themselves stream from the tracker on demand.
    agreement_file: row.invoice1_name || '',
    signed_file: row.invoice2_name || '',
    notes: row.notes || '',
    created_at: row.created_at,
    events: events
      .filter((e) => e && e.event_id != null)
      .map((e) => ({
        event_id: e.event_id,
        event_name: e.event_name || '',
        event_date: e.event_date || null,
        location: e.location || '',
        producer: e.producer || '',
        date_tbc: e.date_tbc || '',
        allocated_amount: toNum(e.allocated_amount) ?? 0,
        package_label: e.package_label || '',
      })),
  };
}

/** Roll a set of deals for one company into the headline numbers the CRM shows. */
function summarizeCompany(companyName, deals) {
  const live = deals.filter((d) => !d.cancelled);
  const eventMap = new Map();
  for (const d of live) {
    for (const e of d.events) {
      const prev = eventMap.get(e.event_id);
      if (prev) {
        prev.allocated_amount += e.allocated_amount;
        if (e.package_label && !prev.package_labels.includes(e.package_label)) {
          prev.package_labels.push(e.package_label);
        }
        prev.deal_ids.push(d.id);
      } else {
        eventMap.set(e.event_id, {
          event_id: e.event_id,
          event_name: e.event_name,
          event_date: e.event_date,
          location: e.location,
          producer: e.producer || '',
          date_tbc: e.date_tbc || '',
          allocated_amount: e.allocated_amount,
          package_labels: e.package_label ? [e.package_label] : [],
          deal_ids: [d.id],
          currency: d.currency,
        });
      }
    }
  }

  // Totals are per-currency: summing GBP and USD into one number would lie.
  const byCurrency = {};
  for (const d of live) {
    const c = d.currency || 'GBP';
    const b = (byCurrency[c] ||= { currency: c, contracted: 0, paid: 0, vat: 0 });
    b.contracted += d.amount || 0;
    b.paid += d.paid_inc_vat || 0;
    b.vat += d.paid_inc_vat ? d.tax_vat || 0 : 0;
  }

  const events = [...eventMap.values()].sort((a, b) => {
    if (a.event_date && b.event_date) return a.event_date < b.event_date ? -1 : 1;
    return String(a.event_name).localeCompare(String(b.event_name));
  });

  return {
    company: companyName,
    normalized: matchKey(companyName),
    deal_count: live.length,
    cancelled_count: deals.length - live.length,
    event_count: events.length,
    totals: Object.values(byCurrency),
    has_payment: live.some((d) => (d.paid_inc_vat || 0) > 0),
    events,
    deals,
  };
}

const DEAL_SELECT = `
  SELECT d.id, d.title, d.company, d.contact_name, d.amount, d.currency, d.stage,
         d.notes, d.paid_inc_vat, d.tax_vat, d.invoice_date, d.paid_date, d.bank,
         d.invoice_number, d.invoice_agreement_sent, d.signature_received,
         d.initials, d.deal_month, d.fiscal_year, d.stage_cancelled, d.is_flagged,
         d.created_at, d.invoice1_name, d.invoice2_name,
         COALESCE(json_agg(
           json_build_object(
             'event_id', pe.id,
             'event_name', pe.name,
             'event_date', pe.event_date,
             'location', pe.location,
             'producer', pe.producer,
             'date_tbc', pe.date_tbc,
             'allocated_amount', de.allocated_amount,
             'package_label', de.package_label
           ) ORDER BY pe.event_date NULLS LAST, pe.name
         ) FILTER (WHERE pe.id IS NOT NULL), '[]') AS events
  FROM deals d
  LEFT JOIN deal_events de ON de.deal_id = d.id
  LEFT JOIN portfolio_events pe ON pe.id = de.event_id
`;

const DEAL_STAGES = ['Prospect', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'];

function cleanText(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function parseMoney(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseDate(v) {
  if (!v) return null;
  // Accept YYYY-MM-DD only — anything looser risks a silent wrong date.
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? String(v).trim() : null;
}

/**
 * @param {object} deps
 * @param {(sql: string, params?: any[]) => Promise<{rows: any[]}>} deps.q
 * @param {() => Promise<void>} deps.ensureDb
 * @param {(dealId: number, amount: any, eventIds: any, packages: any) => Promise<void>} [deps.insertDealEvents]
 *   The tracker's own allocation writer, passed in so there is exactly one
 *   implementation of "how a deal's money is split across events".
 */
function createBridgeRouter({ q, ensureDb, insertDealEvents }) {
  const router = express.Router();

  function requireBridgeKey(req, res, next) {
    const expected = process.env.OPS_BRIDGE_KEY;
    if (!expected) {
      return res.status(503).json({
        error: 'Ops bridge is not configured. Set OPS_BRIDGE_KEY on the tracker.',
      });
    }
    const header = req.get('x-ops-key') || '';
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const supplied = header || bearer;
    if (!supplied || !timingSafeCompare(supplied, expected)) {
      return res.status(401).json({ error: 'Invalid ops bridge key' });
    }
    return next();
  }

  // Wrap every handler so a DB cold start or query blow-up returns JSON rather
  // than Express's HTML error page (the CRM only ever parses JSON).
  const handle = (fn) => async (req, res) => {
    try {
      await ensureDb();
      await fn(req, res);
    } catch (e) {
      console.error('[bridge]', e);
      res.status(500).json({ error: e.message });
    }
  };

  async function loadCompanyIndex() {
    const { rows } = await q(`${DEAL_SELECT} GROUP BY d.id`);
    const deals = rows.map(shapeDeal);
    const groups = new Map();
    for (const d of deals) {
      const name = (d.company || d.title || '').trim();
      if (!name) continue;
      const key = matchKey(name);
      if (!key) continue;
      const g = groups.get(key);
      if (g) {
        g.deals.push(d);
        // Keep the longest spelling as the display name — "Barings LLC" reads
        // better than a truncated variant when both exist.
        if (name.length > g.name.length) g.name = name;
      } else {
        groups.set(key, { name, deals: [d] });
      }
    }
    return [...groups.values()].map((g) => summarizeCompany(g.name, g.deals));
  }

  // Parse JSON here so the router works wherever it's mounted. When the host
  // app already parsed the body, express.json() sees that and skips.
  router.use(express.json({ limit: '15mb' }));
  router.use(requireBridgeKey);

  // Health / handshake — lets the CRM settings page verify the key works.
  router.get(
    '/ping',
    handle(async (_req, res) => {
      const { rows } = await q(
        `SELECT
           (SELECT COUNT(*) FROM deals) AS deals,
           (SELECT COUNT(*) FROM portfolio_events) AS events,
           (SELECT COUNT(*) FROM deal_events) AS allocations`
      );
      res.json({
        ok: true,
        service: 'trackerlpgp-ops-bridge',
        version: 1,
        counts: {
          deals: Number(rows[0].deals),
          events: Number(rows[0].events),
          allocations: Number(rows[0].allocations),
        },
      });
    })
  );

  // Every portfolio event with its allocated + paid revenue.
  router.get(
    '/events',
    handle(async (_req, res) => {
      const { rows } = await q(`
        SELECT pe.id, pe.name, pe.event_date, pe.location, pe.notes,
               pe.producer, pe.date_tbc, pe.programme_year, pe.programme_key,
               COUNT(DISTINCT de.deal_id) AS deal_count,
               COALESCE(SUM(de.allocated_amount), 0) AS allocated_total,
               COALESCE(SUM(CASE WHEN COALESCE(d.paid_inc_vat, 0) > 0
                                 THEN de.allocated_amount ELSE 0 END), 0) AS allocated_paid
        FROM portfolio_events pe
        LEFT JOIN deal_events de ON de.event_id = pe.id
        LEFT JOIN deals d ON d.id = de.deal_id AND COALESCE(d.stage_cancelled, false) = false
        GROUP BY pe.id
        ORDER BY pe.event_date DESC NULLS LAST, pe.name
      `);
      res.json(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          event_date: r.event_date,
          location: r.location || '',
          notes: r.notes || '',
          // Programme fields. date_tbc is '' | 'day' | 'date': the CRM must
          // never print a made-up 1st of the month as if it were confirmed.
          producer: r.producer || '',
          date_tbc: r.date_tbc || '',
          programme_year: r.programme_year == null ? null : Number(r.programme_year),
          programme_key: r.programme_key || null,
          deal_count: Number(r.deal_count),
          allocated_total: toNum(r.allocated_total) ?? 0,
          allocated_paid: toNum(r.allocated_paid) ?? 0,
        }))
      );
    })
  );

  // Sponsors on one event — powers the CRM's event drill-down.
  router.get(
    '/events/:id/sponsors',
    handle(async (req, res) => {
      const { rows } = await q(
        `SELECT d.id AS deal_id,
                COALESCE(NULLIF(d.company, ''), d.title) AS company,
                d.currency, d.stage, d.paid_inc_vat, d.contact_name, d.initials,
                de.allocated_amount, de.package_label
         FROM deal_events de
         JOIN deals d ON d.id = de.deal_id
         WHERE de.event_id = ? AND COALESCE(d.stage_cancelled, false) = false
         ORDER BY de.allocated_amount DESC NULLS LAST`,
        [req.params.id]
      );
      res.json(
        rows.map((r) => ({
          deal_id: r.deal_id,
          company: r.company || '',
          contact_name: r.contact_name || '',
          currency: r.currency || 'GBP',
          stage: r.stage,
          allocated_amount: toNum(r.allocated_amount) ?? 0,
          package_label: r.package_label || '',
          paid: (toNum(r.paid_inc_vat) ?? 0) > 0,
          paid_inc_vat: toNum(r.paid_inc_vat),
          // Who signed it — the CRM resolves these to a person.
          initials: r.initials || '',
        }))
      );
    })
  );

  // Full company index — the CRM caches this for typeahead and bulk reconcile.
  router.get(
    '/companies',
    handle(async (req, res) => {
      const index = await loadCompanyIndex();
      const slim = req.query.slim === '1';
      index.sort((a, b) => a.company.localeCompare(b.company));
      // Slim drops the full deal payloads (notes, invoice metadata) but keeps
      // the event rollup and its deal ids, which is all a bulk reconcile needs.
      res.json(
        slim
          ? index.map((c) => ({
              company: c.company,
              normalized: c.normalized,
              deal_count: c.deal_count,
              event_count: c.event_count,
              totals: c.totals,
              has_payment: c.has_payment,
              events: c.events.map((e) => ({
                event_id: e.event_id,
                event_name: e.event_name,
                event_date: e.event_date,
                producer: e.producer || '',
                date_tbc: e.date_tbc || '',
                allocated_amount: e.allocated_amount,
                currency: e.currency,
                deal_ids: e.deal_ids,
              })),
            }))
          : index
      );
    })
  );

  // ── The one that matters ──────────────────────────────────────────────────
  // GET /api/bridge/match?name=Barings
  // Answers "is this already a deal in the ops panel?" with enough detail for
  // the CRM to show the notice and pre-fill the pipeline form.
  router.get(
    '/match',
    handle(async (req, res) => {
      const name = String(req.query.name || '').trim();
      if (!name) return res.status(400).json({ error: 'A ?name= query is required' });

      const threshold = Math.min(Math.max(Number(req.query.threshold) || 0.6, 0), 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 25);

      const index = await loadCompanyIndex();
      const scored = index
        .map((c) => ({ score: scoreMatch(name, c.company), company: c }))
        .filter((m) => m.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const matches = scored.map((m) => ({
        confidence: Number(m.score.toFixed(3)),
        exact: m.score >= 0.96,
        ...m.company,
      }));

      res.json({
        query: name,
        normalized: matchKey(name),
        match_count: matches.length,
        best: matches[0] ?? null,
        matches,
      });
    })
  );

  // Deals, filterable. Powers the CRM's "my deals" (by the initials the signer
  // is stamped with) and its paperwork chase (by agreement status).
  router.get(
    '/deals',
    handle(async (req, res) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
      const { rows } = await q(`${DEAL_SELECT} GROUP BY d.id ORDER BY d.created_at DESC`);
      let deals = rows.map(shapeDeal);

      const initials = cleanText(req.query.initials).toUpperCase();
      if (initials) {
        // Compare on letters alone — the tracker holds "J.S.", "js" and "JS".
        const want = initials.replace(/[^A-Z]/g, '');
        deals = deals.filter((d) => d.initials.toUpperCase().replace(/[^A-Z]/g, '') === want);
      }

      const company = cleanText(req.query.company);
      if (company) {
        const key = matchKey(company);
        deals = deals.filter((d) => matchKey(d.company) === key);
      }

      const status = cleanText(req.query.status);
      if (status) deals = deals.filter((d) => d.agreement_status === status);

      if (req.query.include_cancelled !== '1') deals = deals.filter((d) => !d.cancelled);

      res.json(deals.slice(0, limit));
    })
  );

  // One deal in full, by tracker id — used when the CRM re-checks a saved link.
  router.get(
    '/deals/:id',
    handle(async (req, res) => {
      const { rows } = await q(`${DEAL_SELECT} WHERE d.id = ? GROUP BY d.id`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Deal not found' });
      res.json(shapeDeal(rows[0]));
    })
  );

  // ── WRITES ────────────────────────────────────────────────────────────────
  // Off by default. Enabling them is a deliberate act: set OPS_BRIDGE_WRITE_KEY
  // to a DIFFERENT secret from the read key, so a leaked read key can never
  // create financial records. Everything above stays read-only regardless.
  function requireWriteKey(req, res, next) {
    const expected = process.env.OPS_BRIDGE_WRITE_KEY;
    if (!expected) {
      return res.status(503).json({
        error:
          'Writes are not enabled on this tracker. Set OPS_BRIDGE_WRITE_KEY to allow the sales CRM to record deals.',
      });
    }
    const supplied =
      req.get('x-ops-write-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!supplied || !timingSafeCompare(supplied, expected)) {
      return res.status(401).json({ error: 'Invalid ops bridge write key' });
    }
    return next();
  }

  /** Shared validation for create and update. Returns { error } or { fields }. */
  function readDealBody(body, { requireCompany }) {
    const company = cleanText(body.company);
    if (requireCompany && !company) return { error: 'A company name is required.' };

    const stage = cleanText(body.stage) || 'Prospect';
    if (!DEAL_STAGES.includes(stage)) {
      return { error: `stage must be one of: ${DEAL_STAGES.join(', ')}` };
    }

    const amount = parseMoney(body.amount) ?? 0;
    if (amount < 0) return { error: 'amount cannot be negative.' };

    const packages = Array.isArray(body.event_packages) ? body.event_packages : null;
    if (packages) {
      for (const p of packages) {
        if (!Number.isInteger(Number(p?.event_id))) {
          return { error: 'Each event allocation needs a numeric event_id.' };
        }
        if ((parseMoney(p.amount) ?? 0) < 0) {
          return { error: 'An event allocation cannot be negative.' };
        }
      }
    }

    return {
      fields: {
        title: cleanText(body.title) || company,
        company,
        contact_name: cleanText(body.contact_name),
        amount,
        currency: (cleanText(body.currency) || 'GBP').toUpperCase().slice(0, 3),
        stage,
        notes: cleanText(body.notes),
        paid_inc_vat: parseMoney(body.paid_inc_vat),
        tax_vat: parseMoney(body.tax_vat),
        invoice_date: parseDate(body.invoice_date),
        paid_date: parseDate(body.paid_date),
        bank: cleanText(body.bank),
        invoice_number: cleanText(body.invoice_number),
        invoice_agreement_sent: Boolean(body.invoice_agreement_sent),
        signature_received: Boolean(body.signature_received),
        initials: cleanText(body.initials),
        deal_month: cleanText(body.deal_month),
        fiscal_year: Number.isInteger(Number(body.fiscal_year)) ? Number(body.fiscal_year) : null,
        event_ids: Array.isArray(body.event_ids) ? body.event_ids : null,
        event_packages: packages,
      },
    };
  }

  /**
   * The programme year the allocated events agree on, or null. Each event's
   * year is its programme_year, else the year of its date; dated events that
   * disagree, or no dated events, give null and the caller keeps what it had.
   */
  async function programmeYearForEvents(fields) {
    const ids = [
      ...(fields.event_packages ?? []).map((p) => Number(p.event_id)),
      ...(fields.event_ids ?? []).map(Number),
    ].filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return null;
    const { rows } = await q(
      `SELECT DISTINCT COALESCE(programme_year, EXTRACT(YEAR FROM event_date)::int) AS y
         FROM portfolio_events WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const years = [...new Set(rows.map((r) => (r.y == null ? null : Number(r.y))).filter((y) => y != null))];
    return years.length === 1 ? years[0] : null;
  }

  /** Every referenced event must exist, or the allocation would dangle. */
  async function assertEventsExist(fields) {
    const ids = [
      ...(fields.event_packages ?? []).map((p) => Number(p.event_id)),
      ...(fields.event_ids ?? []).map(Number),
    ].filter(Number.isInteger);
    if (!ids.length) return null;
    const unique = [...new Set(ids)];
    const { rows } = await q(
      `SELECT id FROM portfolio_events WHERE id IN (${unique.map(() => '?').join(',')})`,
      unique
    );
    const found = new Set(rows.map((r) => Number(r.id)));
    const missing = unique.filter((id) => !found.has(id));
    return missing.length ? `Unknown event id(s): ${missing.join(', ')}` : null;
  }

  async function writeAllocations(dealId, fields) {
    if (!fields.event_packages && !fields.event_ids) return;
    if (typeof insertDealEvents === 'function') {
      await insertDealEvents(dealId, fields.amount, fields.event_ids, fields.event_packages);
      return;
    }
    // Fallback for a router constructed without the tracker's own writer.
    for (const p of fields.event_packages ?? []) {
      await q(
        'INSERT INTO deal_events (deal_id, event_id, allocated_amount, package_label) VALUES (?,?,?,?)',
        [dealId, p.event_id, parseMoney(p.amount) ?? 0, cleanText(p.package_label)]
      );
    }
  }

  // POST /api/bridge/deals — record a deal from the sales CRM.
  router.post(
    '/deals',
    requireWriteKey,
    handle(async (req, res) => {
      const parsed = readDealBody(req.body || {}, { requireCompany: true });
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const f = parsed.fields;

      const eventError = await assertEventsExist(f);
      if (eventError) return res.status(400).json({ error: eventError });

      // Refuse a duplicate invoice number outright — two deals sharing one is
      // an accounting problem that is painful to unpick later.
      if (f.invoice_number) {
        const { rows: clash } = await q(
          'SELECT id FROM deals WHERE invoice_number = ? LIMIT 1',
          [f.invoice_number]
        );
        if (clash.length) {
          return res
            .status(409)
            .json({ error: `Invoice ${f.invoice_number} is already on deal #${clash[0].id}.` });
        }
      }

      if (f.fiscal_year == null) f.fiscal_year = await programmeYearForEvents(f);

      const { rows } = await q(
        `INSERT INTO deals (title, company, contact_name, amount, currency, stage, notes,
           paid_inc_vat, tax_vat, invoice_date, paid_date, bank, invoice_number,
           invoice_agreement_sent, signature_received, initials, deal_month, fiscal_year,
           invoice1_name, invoice1_data)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [
          f.title, f.company, f.contact_name, f.amount, f.currency, f.stage, f.notes,
          f.paid_inc_vat, f.tax_vat, f.invoice_date, f.paid_date, f.bank, f.invoice_number,
          f.invoice_agreement_sent, f.signature_received, f.initials, f.deal_month, f.fiscal_year,
          cleanText(req.body.invoice1_name) || null,
          typeof req.body.invoice1_data === 'string' ? req.body.invoice1_data : null,
        ]
      );
      const dealId = rows[0].id;
      await writeAllocations(dealId, f);

      const { rows: created } = await q(`${DEAL_SELECT} WHERE d.id = ? GROUP BY d.id`, [dealId]);
      res.status(201).json(shapeDeal(created[0]));
    })
  );

  // PATCH /api/bridge/deals/:id — update a deal, e.g. recording a payment.
  router.patch(
    '/deals/:id',
    requireWriteKey,
    handle(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid deal id' });

      const { rows: existing } = await q('SELECT id FROM deals WHERE id = ?', [id]);
      if (!existing.length) return res.status(404).json({ error: 'Deal not found' });

      const parsed = readDealBody(req.body || {}, { requireCompany: false });
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const f = parsed.fields;

      const eventError = await assertEventsExist(f);
      if (eventError) return res.status(400).json({ error: eventError });

      if (f.invoice_number) {
        const { rows: clash } = await q(
          'SELECT id FROM deals WHERE invoice_number = ? AND id <> ? LIMIT 1',
          [f.invoice_number, id]
        );
        if (clash.length) {
          return res
            .status(409)
            .json({ error: `Invoice ${f.invoice_number} is already on deal #${clash[0].id}.` });
        }
      }

      if (f.fiscal_year == null && (f.event_packages || f.event_ids)) {
        f.fiscal_year = await programmeYearForEvents(f);
      }

      await q(
        `UPDATE deals SET
           title = COALESCE(NULLIF(?,''), title),
           company = COALESCE(NULLIF(?,''), company),
           contact_name = ?, amount = ?, currency = ?, stage = ?, notes = ?,
           paid_inc_vat = ?, tax_vat = ?, invoice_date = ?, paid_date = ?,
           bank = ?, invoice_number = ?, invoice_agreement_sent = ?,
           signature_received = ?, initials = ?, deal_month = ?,
           fiscal_year = COALESCE(?, fiscal_year)
         WHERE id = ?`,
        [
          f.title, f.company, f.contact_name, f.amount, f.currency, f.stage, f.notes,
          f.paid_inc_vat, f.tax_vat, f.invoice_date, f.paid_date, f.bank, f.invoice_number,
          f.invoice_agreement_sent, f.signature_received, f.initials, f.deal_month,
          f.fiscal_year, id,
        ]
      );

      // Allocations are replaced wholesale, and only when the caller sent some
      // — omitting them leaves the existing split untouched.
      if (f.event_packages || f.event_ids) {
        await q('DELETE FROM deal_events WHERE deal_id = ?', [id]);
        await writeAllocations(id, f);
      }

      const { rows: updated } = await q(`${DEAL_SELECT} WHERE d.id = ? GROUP BY d.id`, [id]);
      res.json(shapeDeal(updated[0]));
    })
  );

  // POST /api/bridge/deals/:id/invoice/:n — attach an invoice file (1 or 2).
  router.post(
    '/deals/:id/invoice/:n',
    requireWriteKey,
    handle(async (req, res) => {
      const id = Number(req.params.id);
      const n = Number(req.params.n);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid deal id' });
      if (n !== 1 && n !== 2) return res.status(400).json({ error: 'Invoice slot must be 1 or 2' });

      const name = cleanText(req.body?.name);
      const data = typeof req.body?.data === 'string' ? req.body.data : '';
      if (!name || !data) return res.status(400).json({ error: 'name and data are required.' });

      const { rows } = await q(
        `UPDATE deals SET invoice${n}_name = ?, invoice${n}_data = ? WHERE id = ? RETURNING id`,
        [name, data, id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Deal not found' });
      res.json({ ok: true, deal_id: id, slot: n, name });
    })
  );

  return router;
}

module.exports = { createBridgeRouter, normalizeName, matchKey, scoreMatch };

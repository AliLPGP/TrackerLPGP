'use strict';

const express = require('express');
const programme = require('./programme-2027');

/**
 * The confirmed programme, reconciled against what the tracker already holds.
 *
 *   GET  /api/programme/2027        every canonical event with its status:
 *                                   linked (row carries the programme key),
 *                                   suggested (an existing 2027 row looks like
 *                                   it -- a person decides), or missing.
 *   POST /api/programme/2027/apply  the person's decisions, one per event:
 *                                   { key, action: 'rename' | 'create' | 'skip', row_id? }
 *
 * Nothing is ever renamed without a decision in the request body. A rename
 * keeps the row's id, so every deal allocated to it stays allocated; that is
 * the whole reason this is a reconcile and not a reload. Re-running with the
 * same decisions is a no-op: a row that already carries the key is left alone.
 */
function createProgrammeRouter({ q, requireAuth, requireAdminOrManager }) {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  const guards = [requireAuth, requireAdminOrManager].filter(Boolean);

  // The year a row belongs to: its programme year when set, else the year of
  // its date. A row with neither belongs to no year and can never be renamed
  // into the programme -- only created rows and dated rows can.
  function rowYear(row) {
    if (row.programme_year != null) return Number(row.programme_year);
    if (row.event_date) return Number(String(row.event_date).slice(0, 4));
    return null;
  }

  async function loadRows() {
    const { rows } = await q(`
      SELECT pe.id, pe.name, pe.event_date, pe.location, pe.notes, pe.producer,
             pe.date_tbc, pe.programme_year, pe.programme_key,
             COUNT(DISTINCT de.deal_id) AS deal_count
      FROM portfolio_events pe
      LEFT JOIN deal_events de ON de.event_id = pe.id
      GROUP BY pe.id
      ORDER BY pe.event_date NULLS LAST, pe.name`);
    return rows.map((r) => ({ ...r, deal_count: Number(r.deal_count) || 0 }));
  }

  router.get('/2027', ...guards, async (_req, res) => {
    try {
      const rows = await loadRows();
      const items = programme.reconcile(rows);
      res.json({
        year: programme.PROGRAMME_YEAR,
        producers: programme.PRODUCERS,
        series: programme.SERIES,
        not_running: programme.NOT_RUNNING,
        counts: {
          linked: items.filter((i) => i.status === 'linked').length,
          suggested: items.filter((i) => i.status === 'suggested').length,
          missing: items.filter((i) => i.status === 'missing').length,
        },
        items,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/2027/apply', ...guards, async (req, res) => {
    const decisions = Array.isArray(req.body && req.body.decisions) ? req.body.decisions : null;
    if (!decisions) return res.status(400).json({ error: 'decisions[] is required' });

    const byKey = new Map(programme.EVENTS.map((e) => [e.key, e]));
    const results = [];
    try {
      const existing = await loadRows();
      const linked = new Set(existing.filter((r) => r.programme_key).map((r) => r.programme_key));

      for (const d of decisions) {
        const canon = byKey.get(d && d.key);
        if (!canon) { results.push({ key: d && d.key, outcome: 'unknown-key' }); continue; }
        const pkey = programme.programmeKey(canon);
        if (linked.has(pkey)) { results.push({ key: canon.key, outcome: 'already-linked' }); continue; }

        const fields = [
          canon.name, canon.date, canon.location, canon.producer, canon.tbc,
          programme.PROGRAMME_YEAR, pkey,
        ];

        if (d.action === 'rename') {
          const rowId = Number.parseInt(d.row_id, 10);
          const row = existing.find((r) => r.id === rowId);
          if (!row) { results.push({ key: canon.key, outcome: 'row-not-found' }); continue; }
          if (row.programme_key) { results.push({ key: canon.key, outcome: 'row-already-linked' }); continue; }
          // Only a row from the programme's own year can become one of its
          // events. A 2026 row carries 2026 deals; renaming it would move
          // last year's money into next year's programme.
          if (rowYear(row) !== programme.PROGRAMME_YEAR) {
            results.push({ key: canon.key, outcome: 'row-wrong-year', id: rowId });
            continue;
          }
          // The old name is kept in notes, so nobody has to remember that
          // "OPS Miami" is what this event used to be called.
          const note = row.name && row.name !== canon.name
            ? [row.notes, `Previously "${row.name}"`].filter(Boolean).join(' · ')
            : row.notes || '';
          // The same two guards again, inside the statement: a row that was
          // linked or re-dated since this request's snapshot is left alone,
          // and zero rows back means exactly that.
          const { rows } = await q(
            `UPDATE portfolio_events
               SET name=?, event_date=?, location=CASE WHEN COALESCE(location,'')='' THEN ? ELSE location END,
                   producer=?, date_tbc=?, programme_year=?, programme_key=?, notes=?
             WHERE id=? AND programme_key IS NULL
               AND COALESCE(programme_year, EXTRACT(YEAR FROM event_date)::int) = ?
             RETURNING id`,
            [fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6], note, rowId, programme.PROGRAMME_YEAR]
          );
          if (!rows.length) { results.push({ key: canon.key, outcome: 'row-changed-underneath', id: rowId }); continue; }
          linked.add(pkey);
          results.push({ key: canon.key, outcome: 'renamed', id: rows[0].id, deals_kept: row.deal_count });
        } else if (d.action === 'create') {
          const { rows } = await q(
            `INSERT INTO portfolio_events (name, event_date, location, producer, date_tbc, programme_year, programme_key, created_by)
             VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
            [...fields, req.admin ? req.admin.id : null]
          );
          linked.add(pkey);
          results.push({ key: canon.key, outcome: 'created', id: rows[0] && rows[0].id });
        } else {
          results.push({ key: canon.key, outcome: 'skipped' });
        }
      }
      res.json({ ok: true, results });
    } catch (e) {
      // Partial progress is reported rather than hidden: each decision is its
      // own statement, so whatever ran before the failure has really run.
      res.status(500).json({ error: e.message, results });
    }
  });

  // Undo a link. Clears programme_key only: the name, date, producer and every
  // allocation stay exactly as they are, and the row goes back to being a
  // candidate the panel can suggest again.
  router.post('/2027/unlink', ...guards, async (req, res) => {
    const rowId = Number.parseInt(req.body && req.body.row_id, 10);
    if (!Number.isInteger(rowId)) return res.status(400).json({ error: 'row_id is required' });
    try {
      const { rows } = await q(
        `UPDATE portfolio_events SET programme_key = NULL WHERE id = ? AND programme_key IS NOT NULL RETURNING id`,
        [rowId]
      );
      if (!rows.length) return res.status(404).json({ error: 'That row is not linked to the programme' });
      res.json({ ok: true, id: rows[0].id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createProgrammeRouter };

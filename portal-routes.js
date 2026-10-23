'use strict';

const crypto = require('crypto');
const express = require('express');
const { builtInHolidays, regionFor, splitWorkingDays, addDays } = require('./holidays');

/**
 * Everything the staff portal needs beyond the original day-off buttons.
 *
 *   Onboarding   first login: personal details, an ID document, a signed NDA.
 *   Payslips     one PDF per person per month, uploaded by an admin.
 *   Holidays     bank holidays, and requests counted in working days that an
 *                employee can edit or cancel while they are still pending.
 *   Probation    who is due a probation review.
 *
 * Personal data lives in employee_onboarding, not on `employees`: that table is
 * sent to every logged-in user by the directory, so nothing private goes there.
 */

const MAX_FILE_BYTES = 3 * 1024 * 1024; // Vercel caps a request body at 4.5 MB and base64 adds a third
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REGIONS = ['ALL', 'GB', 'AE', 'PH'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const DEFAULT_NDA = `CONFIDENTIALITY AND NON-DISCLOSURE AGREEMENT

This agreement is between LPGP (the "Company") and the person signing below (the "Employee").

1. Confidential Information means all non-public information the Employee learns through their work for the Company, including client, sponsor and delegate lists, pricing, deals, contracts, invoices, event plans, financial information, software, processes and anything marked or reasonably understood to be confidential.

2. The Employee will keep Confidential Information secret, use it only to do their work for the Company, and will not copy, share, publish or pass it to anyone outside the Company without written permission.

3. This does not apply to information that is public through no fault of the Employee, or that the law requires them to disclose (in which case they will tell the Company first where the law allows).

4. The Employee will return or delete all Company materials when asked and when their work for the Company ends.

5. These obligations continue after the Employee stops working for the Company.

6. This agreement is governed by the laws of England and Wales.

By signing, the Employee confirms they have read, understood and agree to these terms.`;

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isoDay = v => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);
const today = () => new Date().toISOString().slice(0, 10);

// What kind of file a base64 string is, from its first bytes; null if it is none we accept
function sniff(base64) {
  const head = Buffer.from(String(base64).slice(0, 16), 'base64');
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return { ext: 'png', mime: 'image/png' };
  return null;
}
const byteLength = base64 => Math.floor(String(base64).length * 3 / 4) - (String(base64).endsWith('==') ? 2 : String(base64).endsWith('=') ? 1 : 0);
const safeName = (name, fallback) => String(name || '').replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '').slice(0, 200) || fallback;

function createPortalRouter({ q, requireAuth, requireAdmin, requireAdminOrManager, allowanceFor, notifyAdmin }) {
  const router = express.Router();
  const staffOnly = (req, res, next) => (req.user && req.user.role === 'employee'
    ? next() : res.status(403).json({ error: 'Employees only' }));
  const fail = (res, e) => res.status(500).json({ error: e.message });

  async function getEmployee(id) {
    const { rows } = await q(
      `SELECT id, name, email, phone, currency, employment_type, start_date::TEXT AS start_date,
              termination_date::TEXT AS termination_date
       FROM employees WHERE id = ?`, [id]);
    return rows[0] || null;
  }

  async function ndaText() {
    const { rows } = await q(`SELECT value FROM app_settings WHERE key = 'nda_text'`);
    return rows[0] && rows[0].value.trim() ? rows[0].value : DEFAULT_NDA;
  }

  // ISO date -> name for a region across the given range: built-in plus admin-added
  async function holidayMap(region, from, to) {
    const map = new Map();
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
      for (const h of builtInHolidays(region, y)) map.set(h.date, h.name);
    }
    const { rows } = await q(
      `SELECT holiday_date::TEXT AS d, name FROM bank_holidays
       WHERE region IN ('ALL', ?) AND holiday_date BETWEEN ? AND ?`, [region, from, to]);
    rows.forEach(r => map.set(r.d, r.name));
    return map;
  }

  // ═══ BANK HOLIDAYS ═══════════════════════════════════════════════════════

  router.get('/employee/bank-holidays', requireAuth, staffOnly, async (req, res) => {
    try {
      const year = parseInt(req.query.year, 10) || new Date().getFullYear();
      const emp = await getEmployee(req.user.employee_id);
      if (!emp) return res.status(404).json({ error: 'Not found' });
      const map = await holidayMap(regionFor(emp), `${year}-01-01`, `${year}-12-31`);
      res.json([...map].map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date)));
    } catch (e) { fail(res, e); }
  });

  // Admin view: every region, with ids for the ones that can be removed
  router.get('/bank-holidays', requireAuth, requireAdminOrManager, async (req, res) => {
    try {
      const year = parseInt(req.query.year, 10) || new Date().getFullYear();
      const { rows } = await q(
        `SELECT id, holiday_date::TEXT AS date, name, region FROM bank_holidays
         WHERE holiday_date BETWEEN ? AND ? ORDER BY holiday_date`, [`${year}-01-01`, `${year}-12-31`]);
      const all = [...builtInHolidays('GB', year).map(h => ({ ...h, id: null })), ...rows.map(r => ({ ...r, builtin: false }))];
      res.json(all.sort((a, b) => a.date.localeCompare(b.date)));
    } catch (e) { fail(res, e); }
  });

  router.post('/bank-holidays', requireAuth, requireAdmin, async (req, res) => {
    try {
      const date = String(req.body.date || '');
      const name = String(req.body.name || '').trim().slice(0, 80);
      const region = REGIONS.includes(req.body.region) ? req.body.region : 'ALL';
      if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(date))) return res.status(400).json({ error: 'A valid date is required' });
      if (!name) return res.status(400).json({ error: 'A name is required' });
      const { rows } = await q(
        `INSERT INTO bank_holidays (holiday_date, name, region) VALUES (?, ?, ?)
         ON CONFLICT (holiday_date, region) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [date, name, region]);
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });

  router.delete('/bank-holidays/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      await q('DELETE FROM bank_holidays WHERE id = ?', [req.params.id]);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  // ═══ HOLIDAY REQUESTS ════════════════════════════════════════════════════

  const KEY = /^[A-Za-z0-9_-]{1,40}$/;
  const groupKey = r => r.group_id || `r${r.id}`;

  // Validates the body shared by create and edit and works out which days it really books
  async function planRequest(emp, body) {
    const start = String(body.start || ''), end = String(body.end || body.start || '');
    if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) return { error: 'Choose a start and end date' };
    if (end < start) return { error: 'The end date is before the start date' };
    if (Date.parse(end) - Date.parse(start) > 366 * 86400000) return { error: 'A request can cover at most a year' };
    const perDay = parseFloat(body.is_day_off) === 0.5 ? 0.5 : 1;
    const map = await holidayMap(regionFor(emp), start, end);
    const { working, skipped } = splitWorkingDays(start, end, map);
    return { start, end, perDay, working, skipped };
  }

  // Days in the plan the person already has booked (any non-declined request, or a day off on record)
  async function findClashes(empId, dates, ignoreKey) {
    if (!dates.length) return [];
    const { rows } = await q(
      `SELECT request_date::TEXT AS d, group_id, id FROM day_off_requests
       WHERE employee_id = ? AND status <> 'declined' AND request_date BETWEEN ? AND ?`,
      [empId, dates[0], dates[dates.length - 1]]);
    const { rows: recs } = await q(
      `SELECT record_date::TEXT AS d FROM daily_records
       WHERE employee_id = ? AND is_day_off > 0 AND record_date BETWEEN ? AND ?`,
      [empId, dates[0], dates[dates.length - 1]]);
    const taken = new Set(rows.filter(r => !ignoreKey || groupKey(r) !== ignoreKey).map(r => r.d));
    recs.forEach(r => taken.add(r.d));
    return dates.filter(d => taken.has(d));
  }

  async function allowanceSummary(emp, year, excludeKey) {
    const allowed = allowanceFor(emp, year);
    const { rows: used } = await q(
      `SELECT COALESCE(SUM(is_day_off), 0) AS n FROM daily_records
       WHERE employee_id = ? AND is_day_off > 0 AND EXTRACT(YEAR FROM record_date) = ?`, [emp.id, year]);
    const { rows: pend } = await q(
      `SELECT id, group_id, is_day_off FROM day_off_requests
       WHERE employee_id = ? AND status = 'pending' AND EXTRACT(YEAR FROM request_date) = ?`, [emp.id, year]);
    const pending = pend.filter(r => !excludeKey || groupKey(r) !== excludeKey)
      .reduce((a, r) => a + parseFloat(r.is_day_off), 0);
    const usedN = parseFloat(used[0].n);
    return { year, allowed, used: usedN, pending, remaining: allowed - usedN - pending };
  }

  router.get('/employee/holiday-preview', requireAuth, staffOnly, async (req, res) => {
    try {
      const emp = await getEmployee(req.user.employee_id);
      if (!emp) return res.status(404).json({ error: 'Not found' });
      const plan = await planRequest(emp, { start: req.query.start, end: req.query.end, is_day_off: req.query.is_day_off });
      if (plan.error) return res.status(400).json({ error: plan.error });
      const exclude = KEY.test(req.query.exclude || '') ? req.query.exclude : null;
      const days = plan.working.length * plan.perDay;
      const clashes = await findClashes(emp.id, plan.working, exclude);
      const allowance = await allowanceSummary(emp, Number(plan.start.slice(0, 4)), exclude);
      res.json({
        working_days: plan.working, skipped: plan.skipped, days, clashes, allowance,
        spans_years: plan.start.slice(0, 4) !== plan.end.slice(0, 4),
        over_by: Math.max(0, days - Math.max(0, allowance.remaining)),
      });
    } catch (e) { fail(res, e); }
  });

  router.get('/employee/holiday-requests', requireAuth, staffOnly, async (req, res) => {
    try {
      const { rows } = await q(
        `SELECT id, group_id, request_date::TEXT AS d, is_day_off, status, reason, decline_reason, created_at
         FROM day_off_requests WHERE employee_id = ? ORDER BY request_date`, [req.user.employee_id]);
      const groups = new Map();
      for (const r of rows) {
        const k = groupKey(r);
        if (!groups.has(k)) groups.set(k, { key: k, rows: [] });
        groups.get(k).rows.push(r);
      }
      const out = [...groups.values()].map(({ key, rows: rs }) => {
        const statuses = new Set(rs.map(r => r.status));
        const status = statuses.size === 1 ? rs[0].status : 'mixed';
        const declined = rs.find(r => r.decline_reason);
        return {
          key,
          start: rs[0].d, end: rs[rs.length - 1].d,
          dates: rs.map(r => r.d),
          days: rs.reduce((a, r) => a + parseFloat(r.is_day_off), 0),
          is_day_off: parseFloat(rs[0].is_day_off),
          reason: rs[0].reason || '',
          decline_reason: declined ? declined.decline_reason : '',
          status,
          can_edit: status === 'pending',
          can_cancel: rs.some(r => r.status === 'pending'),
          created_at: rs[0].created_at,
        };
      }).sort((a, b) => b.start.localeCompare(a.start));
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  async function insertDays(empId, plan, reason, key, withCte) {
    const values = plan.working.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const params = [];
    plan.working.forEach(d => params.push(empId, d, plan.perDay, reason, key));
    const insert = `INSERT INTO day_off_requests (employee_id, request_date, is_day_off, reason, group_id) VALUES ${values}`;
    if (!withCte) return q(insert, params);
    // Replace in ONE statement so a failure can never leave the old days deleted and the new ones missing
    return q(
      `WITH del AS (DELETE FROM day_off_requests
                    WHERE employee_id = ? AND status = 'pending' AND COALESCE(group_id, 'r' || id::text) = ?)
       ${insert}`, [empId, withCte, ...params]);
  }

  router.post('/employee/holiday-requests', requireAuth, staffOnly, async (req, res) => {
    try {
      const emp = await getEmployee(req.user.employee_id);
      if (!emp) return res.status(404).json({ error: 'Not found' });
      const reason = String(req.body.reason || '').trim().slice(0, 500);
      if (!reason) return res.status(400).json({ error: 'Please add a reason for your request' });
      const plan = await planRequest(emp, req.body);
      if (plan.error) return res.status(400).json({ error: plan.error });
      if (!plan.working.length) return res.status(400).json({ error: 'Those dates are all weekends or bank holidays, so there is nothing to book' });
      const clashes = await findClashes(emp.id, plan.working);
      if (clashes.length) return res.status(409).json({ error: `You already have time off booked on ${clashes.slice(0, 5).join(', ')}${clashes.length > 5 ? '…' : ''}`, clashes });
      const key = crypto.randomBytes(6).toString('hex');
      await insertDays(emp.id, plan, reason, key);
      res.json({ key, days: plan.working.length * plan.perDay, booked: plan.working, skipped: plan.skipped, status: 'pending' });
    } catch (e) { fail(res, e); }
  });

  async function ownGroup(empId, key) {
    const { rows } = await q(
      `SELECT id, group_id, status FROM day_off_requests
       WHERE employee_id = ? AND COALESCE(group_id, 'r' || id::text) = ?`, [empId, key]);
    return rows;
  }

  router.put('/employee/holiday-requests/:key', requireAuth, staffOnly, async (req, res) => {
    try {
      if (!KEY.test(req.params.key)) return res.status(400).json({ error: 'Bad request key' });
      const emp = await getEmployee(req.user.employee_id);
      if (!emp) return res.status(404).json({ error: 'Not found' });
      const rows = await ownGroup(emp.id, req.params.key);
      if (!rows.length) return res.status(404).json({ error: 'Request not found' });
      if (rows.some(r => r.status !== 'pending')) return res.status(409).json({ error: 'Only requests that are still pending can be edited' });
      const reason = String(req.body.reason || '').trim().slice(0, 500);
      if (!reason) return res.status(400).json({ error: 'Please add a reason for your request' });
      const plan = await planRequest(emp, req.body);
      if (plan.error) return res.status(400).json({ error: plan.error });
      if (!plan.working.length) return res.status(400).json({ error: 'Those dates are all weekends or bank holidays, so there is nothing to book' });
      const clashes = await findClashes(emp.id, plan.working, req.params.key);
      if (clashes.length) return res.status(409).json({ error: `You already have time off booked on ${clashes.slice(0, 5).join(', ')}${clashes.length > 5 ? '…' : ''}`, clashes });
      const key = crypto.randomBytes(6).toString('hex');
      await insertDays(emp.id, plan, reason, key, req.params.key);
      res.json({ key, days: plan.working.length * plan.perDay, booked: plan.working, skipped: plan.skipped, status: 'pending' });
    } catch (e) { fail(res, e); }
  });

  router.delete('/employee/holiday-requests/:key', requireAuth, staffOnly, async (req, res) => {
    try {
      if (!KEY.test(req.params.key)) return res.status(400).json({ error: 'Bad request key' });
      const rows = await ownGroup(req.user.employee_id, req.params.key);
      if (!rows.length) return res.status(404).json({ error: 'Request not found' });
      if (!rows.some(r => r.status === 'pending')) return res.status(409).json({ error: 'Only requests that are still pending can be cancelled' });
      await q(
        `DELETE FROM day_off_requests
         WHERE employee_id = ? AND status = 'pending' AND COALESCE(group_id, 'r' || id::text) = ?`,
        [req.user.employee_id, req.params.key]);
      res.json({ success: true, cancelled: rows.filter(r => r.status === 'pending').length });
    } catch (e) { fail(res, e); }
  });

  // ═══ ONBOARDING ══════════════════════════════════════════════════════════

  const onboardingRow = async id => (await q('SELECT *, date_of_birth::TEXT AS dob_text FROM employee_onboarding WHERE employee_id = ?', [id])).rows[0] || null;

  function onboardingState(row, emp) {
    const steps = {
      details: !!(row && row.dob_text && String(row.address || '').trim() && String(emp.phone || '').trim()),
      id: !!(row && row.id_doc_name),
      nda: !!(row && row.nda_signed_at),
    };
    const completed = !!(row && row.completed_at);
    return { steps, completed, required: !!(row && row.required) && !completed };
  }

  // Once all three steps are in, stamp it complete and tell the admin
  async function finishIfDone(empId) {
    const emp = await getEmployee(empId);
    const row = await onboardingRow(empId);
    const st = onboardingState(row, emp);
    if (st.completed || !(st.steps.details && st.steps.id && st.steps.nda)) return st.completed;
    await q('UPDATE employee_onboarding SET completed_at = NOW(), updated_at = NOW() WHERE employee_id = ? AND completed_at IS NULL', [empId]);
    if (notifyAdmin) {
      notifyAdmin(`${emp.name} completed onboarding`,
        `<p><strong>${esc(emp.name)}</strong> has entered their details, uploaded ID and signed the NDA.</p><p>Open their profile in the tracker to review.</p>`);
    }
    return true;
  }

  router.get('/employee/onboarding', requireAuth, staffOnly, async (req, res) => {
    try {
      const emp = await getEmployee(req.user.employee_id);
      if (!emp) return res.status(404).json({ error: 'Not found' });
      const row = await onboardingRow(emp.id);
      const st = onboardingState(row, emp);
      res.json({
        ...st,
        details: {
          date_of_birth: row ? row.dob_text : null,
          phone: emp.phone || '',
          address: row ? row.address : '',
          emergency_contact_name: row ? row.emergency_contact_name : '',
          emergency_contact_phone: row ? row.emergency_contact_phone : '',
        },
        id_doc: row && row.id_doc_name ? { type: row.id_doc_type, name: row.id_doc_name } : null,
        nda: {
          text: row && row.nda_signed_at && row.nda_text ? row.nda_text : await ndaText(),
          signed_name: row ? row.nda_signed_name : null,
          signed_at: row ? row.nda_signed_at : null,
        },
      });
    } catch (e) { fail(res, e); }
  });

  // Also how a member of staff edits these details later from My Profile
  router.put('/employee/onboarding/details', requireAuth, staffOnly, async (req, res) => {
    try {
      const b = req.body || {};
      const dob = String(b.date_of_birth || '');
      if (!ISO_DATE.test(dob) || Number.isNaN(Date.parse(dob))) return res.status(400).json({ error: 'Enter your date of birth' });
      if (dob > today() || dob < '1900-01-01') return res.status(400).json({ error: 'That date of birth does not look right' });
      const phone = String(b.phone || '').trim().slice(0, 40);
      const address = String(b.address || '').trim().slice(0, 400);
      if (!phone) return res.status(400).json({ error: 'Enter a phone number' });
      if (!address) return res.status(400).json({ error: 'Enter your address' });
      const empId = req.user.employee_id;
      await q(
        `INSERT INTO employee_onboarding (employee_id, date_of_birth, address, emergency_contact_name, emergency_contact_phone)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (employee_id) DO UPDATE SET date_of_birth = EXCLUDED.date_of_birth, address = EXCLUDED.address,
           emergency_contact_name = EXCLUDED.emergency_contact_name,
           emergency_contact_phone = EXCLUDED.emergency_contact_phone, updated_at = NOW()`,
        [empId, dob, address, String(b.emergency_contact_name || '').trim().slice(0, 100), String(b.emergency_contact_phone || '').trim().slice(0, 40)]);
      await q('UPDATE employees SET phone = ? WHERE id = ?', [phone, empId]);
      const completed = await finishIfDone(empId);
      res.json({ ok: true, completed });
    } catch (e) { fail(res, e); }
  });

  router.post('/employee/onboarding/id', requireAuth, staffOnly, async (req, res) => {
    try {
      const { file_name, file_data } = req.body || {};
      if (!file_data) return res.status(400).json({ error: 'Choose a file to upload' });
      if (!sniff(file_data)) return res.status(400).json({ error: 'Upload a PDF, JPG or PNG' });
      if (byteLength(file_data) > MAX_FILE_BYTES) return res.status(413).json({ error: 'The file must be under 3 MB' });
      const type = ['passport', 'driving_licence'].includes(req.body.id_doc_type) ? req.body.id_doc_type : 'other';
      const empId = req.user.employee_id;
      await q(
        `INSERT INTO employee_onboarding (employee_id, id_doc_type, id_doc_name, id_doc_data, id_uploaded_at)
         VALUES (?, ?, ?, ?, NOW())
         ON CONFLICT (employee_id) DO UPDATE SET id_doc_type = EXCLUDED.id_doc_type, id_doc_name = EXCLUDED.id_doc_name,
           id_doc_data = EXCLUDED.id_doc_data, id_uploaded_at = NOW(), updated_at = NOW()`,
        [empId, type, safeName(file_name, 'id-document'), file_data]);
      const completed = await finishIfDone(empId);
      res.json({ ok: true, completed });
    } catch (e) { fail(res, e); }
  });

  router.post('/employee/onboarding/sign', requireAuth, staffOnly, async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.signed_name || '').trim().slice(0, 120);
      if (name.length < 3) return res.status(400).json({ error: 'Type your full name to sign' });
      if (b.agree !== true) return res.status(400).json({ error: 'Tick the box to confirm you agree' });
      let signature = null;
      if (b.signature) {
        // Only a plain PNG data URL is stored, so it is safe to put straight into a page later
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.signature) || b.signature.length > 300000) {
          return res.status(400).json({ error: 'The drawn signature could not be read, please draw it again' });
        }
        signature = b.signature;
      }
      const empId = req.user.employee_id;
      const text = await ndaText();
      await q(
        `INSERT INTO employee_onboarding (employee_id, nda_text, nda_signed_name, nda_signature, nda_signed_at)
         VALUES (?, ?, ?, ?, NOW())
         ON CONFLICT (employee_id) DO UPDATE SET nda_text = EXCLUDED.nda_text, nda_signed_name = EXCLUDED.nda_signed_name,
           nda_signature = EXCLUDED.nda_signature, nda_signed_at = NOW(), updated_at = NOW()`,
        [empId, text, name, signature]);
      const completed = await finishIfDone(empId);
      res.json({ ok: true, completed });
    } catch (e) { fail(res, e); }
  });

  router.get('/nda-text', requireAuth, async (req, res) => {
    try { res.json({ text: await ndaText(), is_default: (await ndaText()) === DEFAULT_NDA }); } catch (e) { fail(res, e); }
  });

  router.put('/nda-text', requireAuth, requireAdmin, async (req, res) => {
    try {
      const text = String(req.body.text || '').trim().slice(0, 20000);
      await q(
        `INSERT INTO app_settings (key, value) VALUES ('nda_text', ?)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [text]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Admin: how far along someone is, and what they gave us
  router.get('/employees/:id/onboarding', requireAuth, requireAdmin, async (req, res) => {
    try {
      const emp = await getEmployee(req.params.id);
      if (!emp) return res.status(404).json({ error: 'Not found' });
      const row = await onboardingRow(emp.id);
      res.json({
        ...onboardingState(row, emp),
        started: !!row,
        date_of_birth: row ? row.dob_text : null,
        address: row ? row.address : '',
        emergency_contact_name: row ? row.emergency_contact_name : '',
        emergency_contact_phone: row ? row.emergency_contact_phone : '',
        id_doc: row && row.id_doc_name ? { type: row.id_doc_type, name: row.id_doc_name, uploaded_at: row.id_uploaded_at } : null,
        nda: row && row.nda_signed_at ? { signed_name: row.nda_signed_name, signed_at: row.nda_signed_at } : null,
        completed_at: row ? row.completed_at : null,
      });
    } catch (e) { fail(res, e); }
  });

  router.get('/employees/:id/onboarding/id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { rows } = await q('SELECT id_doc_name, id_doc_data FROM employee_onboarding WHERE employee_id = ?', [req.params.id]);
      const r = rows[0];
      if (!r || !r.id_doc_data) return res.status(404).json({ error: 'No ID uploaded' });
      const kind = sniff(r.id_doc_data) || { mime: 'application/octet-stream' };
      res.setHeader('Content-Type', kind.mime);
      res.setHeader('Content-Disposition', `inline; filename="${safeName(r.id_doc_name, 'id-document')}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(Buffer.from(r.id_doc_data, 'base64'));
    } catch (e) { fail(res, e); }
  });

  // A printable copy of exactly what was signed; "Print > Save as PDF" makes the file
  router.get('/employees/:id/onboarding/nda', requireAuth, requireAdmin, async (req, res) => {
    try {
      const emp = await getEmployee(req.params.id);
      const row = emp && await onboardingRow(emp.id);
      if (!row || !row.nda_signed_at) return res.status(404).send('This person has not signed the NDA yet.');
      const when = new Date(row.nda_signed_at).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/London' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signed NDA – ${esc(emp.name)}</title>
<style>body{font:15px/1.6 Georgia,serif;max-width:720px;margin:40px auto;padding:0 20px;color:#111}
pre{white-space:pre-wrap;font:inherit}.sig{margin-top:36px;border-top:1px solid #999;padding-top:14px}
.sig img{display:block;max-width:320px;max-height:120px;margin:8px 0}.meta{color:#555;font-size:13px}
@media print{.noprint{display:none}}</style></head><body>
<p class="noprint meta"><a href="#" onclick="window.print();return false">Print or save as PDF</a></p>
<pre>${esc(row.nda_text)}</pre>
<div class="sig"><strong>Signed by:</strong> ${esc(row.nda_signed_name)}
${row.nda_signature ? `<img alt="Signature" src="${row.nda_signature}">` : ''}
<div class="meta">Employee record: ${esc(emp.name)} · Signed ${esc(when)}</div></div></body></html>`);
    } catch (e) { fail(res, e); }
  });

  // Make someone onboard (again): clears the signature so they re-sign, keeps their details
  router.post('/employees/:id/onboarding/require', requireAuth, requireAdmin, async (req, res) => {
    try {
      const emp = await getEmployee(req.params.id);
      if (!emp) return res.status(404).json({ error: 'Not found' });
      await q(
        `INSERT INTO employee_onboarding (employee_id, required) VALUES (?, true)
         ON CONFLICT (employee_id) DO UPDATE SET required = true, completed_at = NULL,
           nda_signed_at = NULL, nda_signed_name = NULL, nda_signature = NULL, nda_text = NULL, updated_at = NOW()`,
        [emp.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ═══ PAYSLIPS ════════════════════════════════════════════════════════════

  router.get('/employees/:id/payslips', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { rows } = await q(
        `SELECT id, pay_year, pay_month, file_name, file_size, uploaded_by, created_at
         FROM employee_payslips WHERE employee_id = ? ORDER BY pay_year DESC, pay_month DESC`, [req.params.id]);
      res.json(rows);
    } catch (e) { fail(res, e); }
  });

  router.post('/employees/:id/payslips', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { file_name, file_data } = req.body || {};
      const year = parseInt(req.body.pay_year, 10), month = parseInt(req.body.pay_month, 10);
      if (!(year >= 2000 && year <= 2100) || !(month >= 1 && month <= 12)) return res.status(400).json({ error: 'Choose the month this payslip is for' });
      if (!file_data) return res.status(400).json({ error: 'file_data required' });
      const kind = sniff(file_data);
      if (!kind || kind.ext !== 'pdf') return res.status(400).json({ error: 'Only PDF files can be uploaded' });
      const size = byteLength(file_data);
      if (size > MAX_FILE_BYTES) return res.status(413).json({ error: 'PDF must be under 3 MB' });
      const emp = await getEmployee(req.params.id);
      if (!emp) return res.status(404).json({ error: 'Employee not found' });
      const { rows } = await q(
        `INSERT INTO employee_payslips (employee_id, pay_year, pay_month, file_name, file_data, file_size, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (employee_id, pay_year, pay_month) DO UPDATE SET file_name = EXCLUDED.file_name,
           file_data = EXCLUDED.file_data, file_size = EXCLUDED.file_size, uploaded_by = EXCLUDED.uploaded_by, created_at = NOW()
         RETURNING id, pay_year, pay_month, file_name, file_size, uploaded_by, created_at`,
        [emp.id, year, month, safeName(file_name, 'payslip.pdf'), file_data, size, req.admin.username || null]);
      await q('INSERT INTO emp_notifications (employee_id, message, type) VALUES (?, ?, ?)',
        [emp.id, `Your payslip for ${MONTH_NAMES[month - 1]} ${year} is now available in Payslips.`, 'info']);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });

  router.delete('/payslips/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      await q('DELETE FROM employee_payslips WHERE id = ?', [req.params.id]);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  // Admins can open any; staff only their own
  router.get('/payslips/:id/file', requireAuth, async (req, res) => {
    try {
      const { rows } = await q('SELECT employee_id, file_name, file_data FROM employee_payslips WHERE id = ?', [req.params.id]);
      const r = rows[0];
      const allowed = r && (req.user.role === 'admin' || (req.user.role === 'employee' && Number(req.user.employee_id) === Number(r.employee_id)));
      if (!r || !allowed) return res.status(404).json({ error: 'Payslip not found' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${safeName(r.file_name, 'payslip.pdf')}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(Buffer.from(r.file_data, 'base64'));
    } catch (e) { fail(res, e); }
  });

  router.get('/employee/payslips', requireAuth, staffOnly, async (req, res) => {
    try {
      const { rows } = await q(
        `SELECT id, pay_year, pay_month, file_name, file_size, created_at FROM employee_payslips
         WHERE employee_id = ? ORDER BY pay_year DESC, pay_month DESC`, [req.user.employee_id]);
      res.json(rows);
    } catch (e) { fail(res, e); }
  });

  // ═══ PROBATION ═══════════════════════════════════════════════════════════

  // Everyone whose probation review has not been marked done, soonest first
  router.get('/probation', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { rows } = await q(
        `SELECT id, name, job_title, department, start_date::TEXT AS start_date,
                probation_end_date::TEXT AS probation_end_date
         FROM employees WHERE active = 1 AND probation_end_date IS NOT NULL AND probation_review_done_at IS NULL
         ORDER BY probation_end_date, name`);
      const now = Date.parse(today() + 'T00:00:00Z');
      res.json(rows.map(r => ({ ...r, days_left: Math.round((Date.parse(r.probation_end_date + 'T00:00:00Z') - now) / 86400000) })));
    } catch (e) { fail(res, e); }
  });

  router.post('/employees/:id/probation/complete', requireAuth, requireAdmin, async (req, res) => {
    try {
      const date = ISO_DATE.test(req.body && req.body.date) ? req.body.date : today();
      const { rows } = await q('UPDATE employees SET probation_review_done_at = ? WHERE id = ? RETURNING id', [date, req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  return router;
}

module.exports = { createPortalRouter, DEFAULT_NDA, sniff, byteLength, addDays };

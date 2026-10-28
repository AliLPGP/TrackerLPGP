'use strict';

const crypto = require('crypto');
const express = require('express');
const { PDFDocument } = require('pdf-lib');
const { builtInHolidays, regionFor, splitWorkingDays, addDays } = require('./holidays');
const { readFormFields, fillForm, imageToPdf, appendSignaturePage } = require('./pdf-sign');
const contractGen = require('./contract-gen');

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

const fs = require('fs');
const path = require('path');

// The standard agreement every new team member signs (employees and contractors alike),
// used until an admin uploads a replacement under Onboarding files.
const BUILTIN_AGREEMENT = { file_name: 'Team Member Agreement.pdf', title: 'Team Member IP, Confidentiality and Non-Compete Agreement' };
let builtinAgreementBytes = null;
try { builtinAgreementBytes = fs.readFileSync(path.join(__dirname, 'assets', 'team-member-agreement.pdf')); }
catch (e) { console.warn('Built-in team member agreement missing:', e.message); }

const MAX_FILE_BYTES = 3 * 1024 * 1024; // Vercel caps a request body at 4.5 MB and base64 adds a third
const MAX_COMPLETED_BYTES = 2.5 * 1024 * 1024; // a completed form travels with a signature in one request
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
              termination_date::TEXT AS termination_date, job_title, annual_salary
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

  // The company files staff are asked to read and sign (see onboarding_templates)
  // `contract` is the Word template employment contracts are made from (the others are PDFs)
  const TEMPLATE_KEYS = ['nda', 'starter', 'contract'];
  async function templateMeta() {
    const { rows } = await q('SELECT key, file_name, file_size, uploaded_by, updated_at FROM onboarding_templates');
    const out = { nda: null, starter: null, contract: null };
    rows.forEach(r => { out[r.key] = { file_name: r.file_name, file_size: r.file_size, uploaded_by: r.uploaded_by, updated_at: r.updated_at }; });
    if (!out.nda && builtinAgreementBytes) out.nda = { file_name: BUILTIN_AGREEMENT.file_name, file_size: builtinAgreementBytes.length, builtin: true };
    if (!out.contract) out.contract = { file_name: contractGen.BUILTIN_TEMPLATE_NAME, file_size: contractGen.builtinTemplate().length, builtin: true };
    return out;
  }
  async function templateBytes(key) {
    const { rows } = await q('SELECT file_data FROM onboarding_templates WHERE key = ?', [key]);
    if (rows[0]) return Buffer.from(rows[0].file_data, 'base64');
    if (key === 'contract') return contractGen.builtinTemplate();
    return key === 'nda' ? builtinAgreementBytes : null;
  }

  // ── Contracts made from the Word template ──
  const longDate = iso => (iso && ISO_DATE.test(String(iso).slice(0, 10))
    ? new Date(String(iso).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    : '');
  const money = n => Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // What the admin sets when sending one, pre-filled from the employee's record
  function defaultContractFields(emp) {
    const start = isoDay(emp.start_date);
    const year = start && start > today() ? Number(start.slice(0, 4)) : new Date().getFullYear();
    return {
      job_title: emp.job_title || '',
      employment_basis: 'permanent, full-time',
      start_date: start || '',
      annual_salary: Number(emp.annual_salary) > 0 ? Number(emp.annual_salary) : '',
      salary_effective_date: start || '',
      // A full year's allowance, not the part-year figure for the year they join
      holiday_days: allowanceFor ? allowanceFor({ ...emp, start_date: null, termination_date: null }, year) : 20,
    };
  }
  function readContractFields(b) {
    const f = {
      job_title: String(b.job_title || '').trim().slice(0, 120),
      employment_basis: String(b.employment_basis || '').trim().slice(0, 120),
      start_date: String(b.start_date || ''),
      annual_salary: Number(String(b.annual_salary == null ? '' : b.annual_salary).replace(/[^0-9.]/g, '')),
      salary_effective_date: String(b.salary_effective_date || ''),
      holiday_days: Number(b.holiday_days),
    };
    if (!f.job_title) return { error: 'Enter the job title' };
    if (!f.employment_basis) return { error: 'Enter the basis, e.g. permanent, full-time' };
    if (!ISO_DATE.test(f.start_date)) return { error: 'Choose the start date' };
    if (!(f.annual_salary > 0)) return { error: 'Enter the annual salary' };
    if (!ISO_DATE.test(f.salary_effective_date)) return { error: 'Choose the date the salary applies from' };
    if (!(f.holiday_days >= 0 && f.holiday_days <= 60)) return { error: 'Enter the number of paid holiday days' };
    return { fields: f };
  }
  // Everything the template can show. Name and address are read when it is shown,
  // so the contract carries what the person entered at onboarding.
  function contractData(emp, row, f, signedAt) {
    return {
      employee_name: emp.name,
      employee_address: String((row && row.address) || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).join(', '),
      date_of_birth: longDate(row && row.dob_text),
      job_title: f.job_title,
      employment_basis: f.employment_basis,
      start_date: longDate(f.start_date),
      annual_salary: money(f.annual_salary),
      salary_effective_date: longDate(f.salary_effective_date),
      holiday_days: String(f.holiday_days),
      today: longDate(today()),
      signed_date: signedAt ? longDate(isoDay(signedAt)) : '',
    };
  }
  async function renderTemplateContract(empId, fields, { signaturePng, signedAt } = {}) {
    const emp = await getEmployee(empId);
    const row = await onboardingRow(empId);
    return contractGen.renderContract(await templateBytes('contract'), contractData(emp, row, fields, signedAt), { signaturePng });
  }
  const sendPdf = (res, bytes, name, download) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${safeName(name, 'contract.pdf')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(bytes));
  };

  // steps.starter is null when it does not apply (self-employed staff, or no starter sheet uploaded)
  // The newest contract sent to this person to sign (without the file itself)
  async function latestContract(empId) {
    const { rows } = await q(
      `SELECT id, file_name, file_size, uploaded_by, created_at, signed_at, signed_name, signed_doc_id, source, fields
       FROM employee_contracts WHERE employee_id = ? ORDER BY id DESC LIMIT 1`, [empId]);
    return rows[0] || null;
  }

  // steps.contract is null when no contract has been sent to them
  function onboardingState(row, emp, tpl = { nda: null, starter: null }, contract = null) {
    const needsStarter = emp.employment_type === 'payroll' && !!tpl.starter;
    const steps = {
      contract: contract ? !!contract.signed_at : null,
      details: !!(row && row.dob_text && String(row.address || '').trim() && String(emp.phone || '').trim()),
      id: !!(row && row.id_doc_name),
      starter: needsStarter ? !!(row && row.starter_done_at) : null,
      nda: !!(row && row.nda_signed_at),
    };
    const completed = !!(row && row.completed_at);
    return { steps, completed, needs_starter: needsStarter, required: !!(row && row.required) && !completed };
  }
  // The ID upload is asked for last and can be skipped for now, so it does not hold up completion
  const allStepsDone = st => st.steps.details && st.steps.starter !== false && st.steps.contract !== false && st.steps.nda;

  // Once every step is in, stamp it complete and tell the admin
  async function finishIfDone(empId) {
    const emp = await getEmployee(empId);
    const row = await onboardingRow(empId);
    const st = onboardingState(row, emp, await templateMeta(), await latestContract(empId));
    if (st.completed || !allStepsDone(st)) return st.completed;
    await q('UPDATE employee_onboarding SET completed_at = NOW(), updated_at = NOW() WHERE employee_id = ? AND completed_at IS NULL', [empId]);
    if (notifyAdmin) {
      notifyAdmin(`${emp.name} completed onboarding`,
        `<p><strong>${esc(emp.name)}</strong> has entered their details${st.steps.contract ? ', signed their contract' : ''}${st.needs_starter ? ', completed the starter sheet' : ''} and signed the team member agreement.${st.steps.id ? '' : ' They have not uploaded their ID yet.'}</p><p>The signed documents are in their file in the tracker.</p>`);
    }
    return true;
  }

  // A PDF stored on the employee's file; returns its id
  async function storeEmployeeDoc(empId, docType, fileName, bytes, uploadedBy) {
    const buf = Buffer.from(bytes);
    const { rows } = await q(
      `INSERT INTO employee_documents (employee_id, doc_type, file_name, file_data, file_size, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      [empId, docType, safeName(fileName, 'document.pdf'), buf.toString('base64'), buf.length, uploadedBy]);
    return rows[0].id;
  }

  // The name, drawn signature and agreement every signing step needs
  function readSigning(b) {
    const name = String((b && b.signed_name) || '').trim().slice(0, 120);
    if (name.length < 3) return { error: 'Type your full name to sign' };
    if (!b || b.agree !== true) return { error: 'Tick the box to confirm you agree' };
    let signature = null;
    if (b.signature) {
      // Only a plain PNG data URL is accepted, so it is safe to put straight into a page or PDF later
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.signature) || b.signature.length > 300000) {
        return { error: 'The drawn signature could not be read, please draw it again' };
      }
      signature = b.signature;
    }
    return { name, signature };
  }

  router.get('/employee/onboarding', requireAuth, staffOnly, async (req, res) => {
    try {
      const emp = await getEmployee(req.user.employee_id);
      if (!emp) return res.status(404).json({ error: 'Not found' });
      const row = await onboardingRow(emp.id);
      const tpl = await templateMeta();
      const contract = await latestContract(emp.id);
      const st = onboardingState(row, emp, tpl, contract);

      // Someone who already had a login is not forced through onboarding; they get a
      // one-off notification asking them to complete their profile (the portal also shows a banner)
      if (!st.required && !st.completed && !(row && row.prompted_at)) {
        await q(
          `INSERT INTO employee_onboarding (employee_id, prompted_at) VALUES (?, NOW())
           ON CONFLICT (employee_id) DO UPDATE SET prompted_at = NOW()`, [emp.id]);
        await q('INSERT INTO emp_notifications (employee_id, message, type) VALUES (?, ?, ?)',
          [emp.id, 'Please complete your profile: add your details, upload your ID and sign your documents. It only takes a few minutes.', 'info']);
      }

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
        documents: {
          nda: tpl.nda ? { mode: 'pdf', file_name: tpl.nda.file_name } : { mode: 'text' },
          starter: st.needs_starter ? { file_name: tpl.starter.file_name } : null,
          contract: contract ? { id: contract.id, file_name: contract.file_name, sent_at: contract.created_at, signed_at: contract.signed_at, generated: contract.source === 'template' } : null,
        },
        signed: { nda: !!(row && row.nda_doc_id), starter: !!(row && row.starter_doc_id), contract: !!(contract && contract.signed_doc_id) },
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
      const empId = req.user.employee_id;
      // A phone number is optional here only when one is already on file
      const phone = b.phone != null ? String(b.phone).trim().slice(0, 40) : String((await getEmployee(empId) || {}).phone || '').trim();
      const address = String(b.address || '').trim().slice(0, 400);
      if (!phone) return res.status(400).json({ error: 'Enter a phone number' });
      if (!address) return res.status(400).json({ error: 'Enter your address' });
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

  // Documents are only taken once the agreement is signed
  async function agreementSigned(empId) {
    const row = await onboardingRow(empId);
    return !!(row && row.nda_signed_at);
  }

  router.post('/employee/onboarding/id', requireAuth, staffOnly, async (req, res) => {
    try {
      if (!await agreementSigned(req.user.employee_id)) return res.status(409).json({ error: 'Please sign the team member agreement first' });
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
      const sig = readSigning(req.body);
      if (sig.error) return res.status(400).json({ error: sig.error });
      const empId = req.user.employee_id;
      const emp = await getEmployee(empId);
      const signedAt = new Date();
      // If an NDA file has been uploaded, they sign that file: it is kept with a signature page
      // on their record. Otherwise they sign the NDA wording.
      const pdf = await templateBytes('nda');
      let docId = null, text = null;
      if (pdf) {
        const signed = await appendSignaturePage(pdf, { title: BUILTIN_AGREEMENT.title, signerName: sig.name, signaturePng: sig.signature, signedAt });
        docId = await storeEmployeeDoc(empId, 'nda', `Team Member Agreement (signed) - ${emp.name}.pdf`, signed, `${emp.name} (portal)`);
      } else {
        text = await ndaText();
      }
      await q(
        `INSERT INTO employee_onboarding (employee_id, nda_text, nda_signed_name, nda_signature, nda_signed_at, nda_doc_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (employee_id) DO UPDATE SET nda_text = EXCLUDED.nda_text, nda_signed_name = EXCLUDED.nda_signed_name,
           nda_signature = EXCLUDED.nda_signature, nda_signed_at = EXCLUDED.nda_signed_at, nda_doc_id = EXCLUDED.nda_doc_id, updated_at = NOW()`,
        [empId, text, sig.name, sig.signature, signedAt.toISOString(), docId]);
      const completed = await finishIfDone(empId);
      res.json({ ok: true, completed });
    } catch (e) { fail(res, e); }
  });

  // The starter sheet: where its fillable fields are, so the browser can lay inputs over each page
  router.get('/employee/onboarding/starter/fields', requireAuth, staffOnly, async (req, res) => {
    try {
      const bytes = await templateBytes('starter');
      if (!bytes) return res.status(404).json({ error: 'No starter sheet has been set up' });
      res.json(await readFormFields(bytes));
    } catch (e) { fail(res, e); }
  });

  // Complete the starter sheet: either answers for its fillable fields, or their own completed copy
  // (a PDF or a photo). Either way it is signed and filed on their record.
  router.post('/employee/onboarding/starter', requireAuth, staffOnly, async (req, res) => {
    try {
      const b = req.body || {};
      const sig = readSigning(b);
      if (sig.error) return res.status(400).json({ error: sig.error });
      const empId = req.user.employee_id;
      if (!await agreementSigned(empId)) return res.status(409).json({ error: 'Please sign the team member agreement first' });
      const emp = await getEmployee(empId);
      const tpl = await templateMeta();
      if (emp.employment_type !== 'payroll' || !tpl.starter) return res.status(400).json({ error: 'There is no starter sheet for you to complete' });

      let base;
      if (b.file_data) {
        const kind = sniff(b.file_data);
        if (!kind) return res.status(400).json({ error: 'Upload a PDF, JPG or PNG' });
        if (byteLength(b.file_data) > MAX_COMPLETED_BYTES) return res.status(413).json({ error: 'The file must be under 2.5 MB' });
        const raw = Buffer.from(b.file_data, 'base64');
        base = kind.ext === 'pdf' ? raw : await imageToPdf(raw, kind.ext);
      } else {
        const template = await templateBytes('starter');
        const info = await readFormFields(template);
        if (!info.fillable) return res.status(400).json({ error: 'This starter sheet cannot be filled in on screen. Upload your completed copy instead.' });
        base = await fillForm(template, b.values && typeof b.values === 'object' ? b.values : {});
      }
      const signedAt = new Date();
      const signed = await appendSignaturePage(base, { title: 'Starter sheet', signerName: sig.name, signaturePng: sig.signature, signedAt });
      const docId = await storeEmployeeDoc(empId, 'starter_form', `Starter sheet - ${emp.name}.pdf`, signed, `${emp.name} (portal)`);
      await q(
        `INSERT INTO employee_onboarding (employee_id, starter_done_at, starter_doc_id) VALUES (?, ?, ?)
         ON CONFLICT (employee_id) DO UPDATE SET starter_done_at = EXCLUDED.starter_done_at, starter_doc_id = EXCLUDED.starter_doc_id, updated_at = NOW()`,
        [empId, signedAt.toISOString(), docId]);
      const completed = await finishIfDone(empId);
      res.json({ ok: true, completed });
    } catch (e) { fail(res, e); }
  });

  // A member of staff can always get their own signed copies back
  router.get('/employee/onboarding/signed/:which', requireAuth, staffOnly, async (req, res) => {
    try {
      const col = req.params.which === 'nda' ? 'nda_doc_id' : req.params.which === 'starter' ? 'starter_doc_id' : null;
      let docId = null;
      if (req.params.which === 'contract') docId = ((await latestContract(req.user.employee_id)) || {}).signed_doc_id || null;
      else if (col) docId = ((await onboardingRow(req.user.employee_id)) || {})[col] || null;
      else return res.status(404).json({ error: 'Not found' });
      if (!docId) return res.status(404).json({ error: 'Not signed yet' });
      const { rows } = await q('SELECT file_name, file_data FROM employee_documents WHERE id = ? AND employee_id = ?', [docId, req.user.employee_id]);
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${safeName(rows[0].file_name, 'signed.pdf')}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(Buffer.from(rows[0].file_data, 'base64'));
    } catch (e) { fail(res, e); }
  });

  // ── Contracts: one person's contract to sign ──
  // The original as uploaded (admin, or the person it was sent to)
  router.get('/contracts/:id/file', requireAuth, async (req, res) => {
    try {
      const { rows } = await q('SELECT employee_id, file_name, file_data, source, fields FROM employee_contracts WHERE id = ?', [req.params.id]);
      const r = rows[0];
      const allowed = r && (req.user.role === 'admin' || (req.user.role === 'employee' && Number(req.user.employee_id) === Number(r.employee_id)));
      if (!allowed) return res.status(404).json({ error: 'Contract not found' });
      // Made from the template and not signed yet: drawn now, with their latest details
      if (!r.file_data && r.source === 'template') return sendPdf(res, await renderTemplateContract(r.employee_id, r.fields), r.file_name, req.query.download);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${safeName(r.file_name, 'contract.pdf')}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(Buffer.from(r.file_data, 'base64'));
    } catch (e) { fail(res, e); }
  });

  // Admin: every contract sent to this person, newest first
  router.get('/employees/:id/contracts', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { rows } = await q(
        `SELECT id, file_name, file_size, uploaded_by, created_at, signed_at, signed_name, signed_doc_id, source, fields
         FROM employee_contracts WHERE employee_id = ? ORDER BY id DESC`, [req.params.id]);
      res.json(rows);
    } catch (e) { fail(res, e); }
  });

  // Puts a contract in someone's onboarding to sign. Replaces one still waiting for a
  // signature; after a signed one it starts a new signing. Reopens their onboarding and lets them know.
  async function sendContract(emp, c, by) {
    const pending = await latestContract(emp.id);
    let id;
    if (pending && !pending.signed_at) {
      await q(`UPDATE employee_contracts SET file_name = ?, file_data = ?, file_size = ?, uploaded_by = ?, source = ?, fields = ?, created_at = NOW() WHERE id = ?`,
        [c.file_name, c.file_data, c.file_size, by || null, c.source, c.fields ? JSON.stringify(c.fields) : null, pending.id]);
      id = pending.id;
    } else {
      id = (await q(`INSERT INTO employee_contracts (employee_id, file_name, file_data, file_size, uploaded_by, source, fields) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [emp.id, c.file_name, c.file_data, c.file_size, by || null, c.source, c.fields ? JSON.stringify(c.fields) : null])).rows[0].id;
    }
    // Someone who already finished onboarding is asked (banner + notification), not forced
    // through it again; someone still on their first onboarding stays as they were.
    await q(`INSERT INTO employee_onboarding (employee_id) VALUES (?)
             ON CONFLICT (employee_id) DO UPDATE SET
               required = CASE WHEN employee_onboarding.completed_at IS NOT NULL THEN false ELSE employee_onboarding.required END,
               completed_at = NULL, updated_at = NOW()`, [emp.id]);
    await q('INSERT INTO emp_notifications (employee_id, message, type) VALUES (?, ?, ?)',
      [emp.id, 'You have a new contract to sign. Open your profile checklist to read and sign it.', 'info']);
    return { id, replaced: !!(pending && !pending.signed_at) };
  }

  // Admin: the terms a template contract would be sent with, from their record
  router.get('/employees/:id/contracts/defaults', requireAuth, requireAdmin, async (req, res) => {
    try {
      const emp = await getEmployee(req.params.id);
      if (!emp) return res.status(404).json({ error: 'Employee not found' });
      const row = await onboardingRow(emp.id);
      const cur = await latestContract(emp.id);
      const fields = cur && !cur.signed_at && cur.source === 'template' && cur.fields ? cur.fields : defaultContractFields(emp);
      res.json({ fields, currency: emp.currency || 'GBP', has_address: !!(row && String(row.address || '').trim()) });
    } catch (e) { fail(res, e); }
  });

  // Admin: the contract as it would read with these terms (their address shows once they enter it)
  router.post('/employees/:id/contracts/preview', requireAuth, requireAdmin, async (req, res) => {
    try {
      const emp = await getEmployee(req.params.id);
      if (!emp) return res.status(404).json({ error: 'Employee not found' });
      const v = readContractFields(req.body || {});
      if (v.error) return res.status(400).json({ error: v.error });
      sendPdf(res, await renderTemplateContract(emp.id, v.fields), `Employment contract - ${emp.name}.pdf`, false);
    } catch (e) { fail(res, e); }
  });

  // Admin: send a contract made from the template. It is drawn with their details when they open it.
  router.post('/employees/:id/contracts/generate', requireAuth, requireAdmin, async (req, res) => {
    try {
      const emp = await getEmployee(req.params.id);
      if (!emp) return res.status(404).json({ error: 'Employee not found' });
      const v = readContractFields(req.body || {});
      if (v.error) return res.status(400).json({ error: v.error });
      const out = await sendContract(emp, { file_name: `Employment contract - ${emp.name}.pdf`, file_data: null, file_size: 0, source: 'template', fields: v.fields }, req.admin.username);
      res.json({ ok: true, ...out });
    } catch (e) { fail(res, e); }
  });

  // Admin: send a contract to sign. Replaces one still waiting for a signature; after a
  // signed one it starts a new signing. Reopens their onboarding and lets them know.
  router.post('/employees/:id/contracts', requireAuth, requireAdmin, async (req, res) => {
    try {
      const emp = await getEmployee(req.params.id);
      if (!emp) return res.status(404).json({ error: 'Employee not found' });
      const { file_name, file_data } = req.body || {};
      if (!file_data) return res.status(400).json({ error: 'file_data required' });
      const kind = sniff(file_data);
      if (!kind || kind.ext !== 'pdf') return res.status(400).json({ error: 'Only PDF files can be uploaded' });
      const size = byteLength(file_data);
      if (size > MAX_FILE_BYTES) return res.status(413).json({ error: 'The PDF must be under 3 MB' });
      try { await PDFDocument.load(Buffer.from(file_data, 'base64')); }
      catch { return res.status(400).json({ error: 'That PDF could not be read. If it is password protected, remove the password and try again.' }); }
      const out = await sendContract(emp, { file_name: safeName(file_name, 'contract.pdf'), file_data, file_size: size, source: 'upload', fields: null }, req.admin.username);
      res.json({ ok: true, ...out });
    } catch (e) { fail(res, e); }
  });

  // Admin: withdraw a contract that has not been signed yet
  router.delete('/contracts/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { rows } = await q('DELETE FROM employee_contracts WHERE id = ? AND signed_at IS NULL RETURNING employee_id', [req.params.id]);
      if (!rows.length) return res.status(409).json({ error: 'Only a contract that has not been signed can be withdrawn' });
      await finishIfDone(rows[0].employee_id);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Staff: sign the contract sent to them; the signed copy goes on their file
  router.post('/employee/onboarding/contract', requireAuth, staffOnly, async (req, res) => {
    try {
      const sig = readSigning(req.body);
      if (sig.error) return res.status(400).json({ error: sig.error });
      const empId = req.user.employee_id;
      if (!await agreementSigned(empId)) return res.status(409).json({ error: 'Please sign the team member agreement first' });
      const c = await latestContract(empId);
      if (!c || c.signed_at) return res.status(400).json({ error: 'There is no contract waiting for your signature' });
      const emp = await getEmployee(empId);
      const signedAt = new Date();
      let original;
      if (c.source === 'template') {
        // Their name and address go into the contract, so those come first
        const row = await onboardingRow(empId);
        if (!row || !String(row.address || '').trim()) return res.status(409).json({ error: 'Please add your details (including your address) first' });
        // The copy they read, kept as the original; the signed one carries their signature and the date
        const unsigned = await renderTemplateContract(empId, c.fields);
        await q('UPDATE employee_contracts SET file_data = ?, file_size = ? WHERE id = ?', [Buffer.from(unsigned).toString('base64'), unsigned.length, c.id]);
        original = await renderTemplateContract(empId, c.fields, { signaturePng: sig.signature, signedAt });
      } else {
        const { rows } = await q('SELECT file_data FROM employee_contracts WHERE id = ?', [c.id]);
        original = Buffer.from(rows[0].file_data, 'base64');
      }
      const signed = await appendSignaturePage(original,
        { title: 'Contract: ' + c.file_name.replace(/\.pdf$/i, ''), signerName: sig.name, signaturePng: sig.signature, signedAt });
      const docId = await storeEmployeeDoc(empId, 'contract_signed', `Contract (signed) - ${emp.name}.pdf`, signed, `${emp.name} (portal)`);
      await q('UPDATE employee_contracts SET signed_at = ?, signed_name = ?, signed_doc_id = ? WHERE id = ? AND signed_at IS NULL',
        [signedAt.toISOString(), sig.name, docId, c.id]);
      const completed = await finishIfDone(empId);
      res.json({ ok: true, completed });
    } catch (e) { fail(res, e); }
  });

  // ── Admin: the NDA and starter sheet files ──
  router.get('/onboarding/templates', requireAuth, requireAdmin, async (req, res) => {
    try { res.json(await templateMeta()); } catch (e) { fail(res, e); }
  });

  router.post('/onboarding/templates/:key', requireAuth, requireAdmin, async (req, res) => {
    try {
      const key = req.params.key;
      if (!TEMPLATE_KEYS.includes(key)) return res.status(404).json({ error: 'Unknown file' });
      const { file_name, file_data } = req.body || {};
      if (!file_data) return res.status(400).json({ error: 'file_data required' });
      if (key === 'contract') return saveContractTemplate(req, res, file_name, file_data);
      const kind = sniff(file_data);
      if (!kind || kind.ext !== 'pdf') return res.status(400).json({ error: 'Only PDF files can be uploaded' });
      const size = byteLength(file_data);
      if (size > MAX_FILE_BYTES) return res.status(413).json({ error: 'The PDF must be under 3 MB' });
      const bytes = Buffer.from(file_data, 'base64');
      let pages;
      try { pages = (await PDFDocument.load(bytes)).getPageCount(); }
      catch { return res.status(400).json({ error: 'That PDF could not be read. If it is password protected, remove the password and try again.' }); }
      const info = key === 'starter' ? await readFormFields(bytes).catch(() => ({ fillable: false, fields: [] })) : null;
      await q(
        `INSERT INTO onboarding_templates (key, file_name, file_data, file_size, uploaded_by, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON CONFLICT (key) DO UPDATE SET file_name = EXCLUDED.file_name, file_data = EXCLUDED.file_data,
           file_size = EXCLUDED.file_size, uploaded_by = EXCLUDED.uploaded_by, updated_at = NOW()`,
        [key, safeName(file_name, `${key}.pdf`), file_data, size, req.admin.username || null]);
      res.json({ ok: true, pages, fillable: info ? !!info.fillable : undefined, fields: info ? info.fields.length : undefined });
    } catch (e) { fail(res, e); }
  });

  // A new Word template: it must open, use only fields we can fill, and lay out
  async function saveContractTemplate(req, res, fileName, fileData) {
    const size = byteLength(fileData);
    if (size > MAX_FILE_BYTES) return res.status(413).json({ error: 'The Word file must be under 3 MB' });
    const bytes = Buffer.from(fileData, 'base64');
    let info;
    try { info = contractGen.templateTags(bytes); }
    catch { return res.status(400).json({ error: 'Upload the contract as a Word document (.docx)' }); }
    if (info.unknown.length) return res.status(400).json({ error: `These fields are not ones we can fill: ${info.unknown.map(t => `{{${t}}}`).join(', ')}` });
    try {
      await contractGen.renderContract(bytes, { employee_name: 'Test', job_title: 'Test', annual_salary: '1.00' });
    } catch (e) {
      return res.status(400).json({ error: 'That Word file could not be used: ' + String(e.message || e).slice(0, 200) + '. Check every field is written as {{field_name}}.' });
    }
    await q(
      `INSERT INTO onboarding_templates (key, file_name, file_data, file_size, uploaded_by, updated_at)
       VALUES ('contract', ?, ?, ?, ?, NOW())
       ON CONFLICT (key) DO UPDATE SET file_name = EXCLUDED.file_name, file_data = EXCLUDED.file_data,
         file_size = EXCLUDED.file_size, uploaded_by = EXCLUDED.uploaded_by, updated_at = NOW()`,
      [safeName(fileName, 'contract-template.docx'), fileData, size, req.admin.username || null]);
    res.json({ ok: true, fields: info.tags });
  }

  router.delete('/onboarding/templates/:key', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!TEMPLATE_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'Unknown file' });
      await q('DELETE FROM onboarding_templates WHERE key = ?', [req.params.key]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Staff read these in the wizard, so any signed-in user may fetch them
  router.get('/onboarding/templates/:key/file', requireAuth, async (req, res) => {
    try {
      if (!TEMPLATE_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'Unknown file' });
      // The contract template is for admins only, and is a Word file
      if (req.params.key === 'contract') {
        if (req.user.role !== 'admin') return res.status(404).json({ error: 'Not found' });
        const meta = (await templateMeta()).contract;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName(meta.file_name, 'contract-template.docx')}"`);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.send(await templateBytes('contract'));
      }
      const { rows } = await q('SELECT file_name, file_data FROM onboarding_templates WHERE key = ?', [req.params.key]);
      const builtin = !rows[0] && req.params.key === 'nda' && builtinAgreementBytes;
      if (!rows[0] && !builtin) return res.status(404).json({ error: 'Not set up' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${safeName(builtin ? BUILTIN_AGREEMENT.file_name : rows[0].file_name, 'document.pdf')}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(builtin ? builtinAgreementBytes : Buffer.from(rows[0].file_data, 'base64'));
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
        ...onboardingState(row, emp, await templateMeta(), await latestContract(emp.id)),
        started: !!row,
        date_of_birth: row ? row.dob_text : null,
        address: row ? row.address : '',
        emergency_contact_name: row ? row.emergency_contact_name : '',
        emergency_contact_phone: row ? row.emergency_contact_phone : '',
        id_doc: row && row.id_doc_name ? { type: row.id_doc_type, name: row.id_doc_name, uploaded_at: row.id_uploaded_at } : null,
        nda: row && row.nda_signed_at ? { signed_name: row.nda_signed_name, signed_at: row.nda_signed_at, doc_id: row.nda_doc_id || null } : null,
        starter: row && row.starter_done_at ? { signed_at: row.starter_done_at, doc_id: row.starter_doc_id || null } : null,
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
      if (row.nda_doc_id) return res.redirect(`/api/employee-documents/${row.nda_doc_id}`);
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
           nda_signed_at = NULL, nda_signed_name = NULL, nda_signature = NULL, nda_text = NULL, nda_doc_id = NULL,
           starter_done_at = NULL, starter_doc_id = NULL, updated_at = NOW()`,
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
      if (emp.employment_type !== 'payroll') return res.status(400).json({ error: 'Payslips are only for payroll staff' });
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

  // ═══ WARNINGS ════════════════════════════════════════════════════════════

  const WARNING_LEVELS = { verbal: 'Verbal warning', written: 'Written warning', final: 'Final written warning' };
  const warningCols = `id, issued_on::TEXT AS issued_on, level, reason, issued_by, created_at`;

  router.get('/employees/:id/warnings', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { rows } = await q(`SELECT ${warningCols} FROM employee_warnings WHERE employee_id = ? ORDER BY issued_on DESC, id DESC`, [req.params.id]);
      res.json(rows);
    } catch (e) { fail(res, e); }
  });

  router.post('/employees/:id/warnings', requireAuth, requireAdmin, async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').replace(/\r/g, '').trim().slice(0, 2000);
      const level = WARNING_LEVELS[req.body.level] ? req.body.level : 'written';
      const issuedOn = /^\d{4}-\d{2}-\d{2}$/.test(req.body.issued_on || '') ? req.body.issued_on : new Date().toISOString().slice(0, 10);
      if (!reason) return res.status(400).json({ error: 'Give the reason for the warning' });
      const emp = await getEmployee(req.params.id);
      if (!emp) return res.status(404).json({ error: 'Employee not found' });
      const { rows } = await q(
        `INSERT INTO employee_warnings (employee_id, issued_on, level, reason, issued_by) VALUES (?, ?, ?, ?, ?) RETURNING ${warningCols}`,
        [emp.id, issuedOn, level, reason, req.admin.username || null]);
      await q('INSERT INTO emp_notifications (employee_id, message, type) VALUES (?, ?, ?)',
        [emp.id, `You have received a ${WARNING_LEVELS[level].toLowerCase()}: ${reason}`, 'warning']);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });

  // Removing one (e.g. issued by mistake) takes it off their portal too
  router.delete('/warnings/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      await q('DELETE FROM employee_warnings WHERE id = ?', [req.params.id]);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  router.get('/employee/warnings', requireAuth, staffOnly, async (req, res) => {
    try {
      const { rows } = await q(`SELECT id, issued_on::TEXT AS issued_on, level, reason FROM employee_warnings WHERE employee_id = ? ORDER BY issued_on DESC, id DESC`, [req.user.employee_id]);
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

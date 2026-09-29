const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// Create an HTTP-based SQL client — no persistent TCP connections, no stale TLS issues
const rawSql = connectionString ? neon(connectionString) : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Neon's HTTP endpoint occasionally drops a request while a branch wakes from
// idle. It surfaces as a bare "fetch failed" with no SQL error attached — the
// statement never reached Postgres.
function isTransientDbError(err) {
  const msg = `${err && err.message} ${err && err.cause && err.cause.message}`;
  // Deliberately narrow: an HTTP status from Neon (403 not-in-allowlist, 429
  // quota) means the request arrived and was refused, so replaying it is futile.
  if (/HTTP status/i.test(msg)) return false;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|terminated unexpectedly|Connection terminated/i.test(msg);
}

// Only replay statements that are safe to run twice. A dropped connection gives
// no way to know whether Postgres already applied the statement, so retrying an
// INSERT or UPDATE risks duplicating a time record or a payment — those failures
// are surfaced to the caller instead.
function isReplayable(statement) {
  return /^\s*(select|with)\b/i.test(statement) || /\bif\s+(not\s+)?exists\b/i.test(statement);
}

async function sql(statement, params) {
  if (!rawSql) throw new Error('DATABASE_URL or POSTGRES_URL environment variable is not set');

  const attempts = isReplayable(statement) ? 3 : 1;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return params === undefined ? await rawSql(statement) : await rawSql(statement, params);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isTransientDbError(err)) throw err;
      console.warn(`Transient DB error (attempt ${attempt}/${attempts}): ${err.message} — retrying`);
      await sleep(attempt * 300);
    }
  }
  throw lastErr;
}

async function initDb() {
  if (!rawSql) throw new Error('DATABASE_URL or POSTGRES_URL environment variable is not set');

  // Retry up to 4 times with backoff — handles Neon cold-start wake-up delays
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await runMigrations();
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`DB init attempt ${attempt} failed: ${err.message}`);
      if (attempt < 4) await sleep(attempt * 1500);
    }
  }
  throw lastErr;
}

async function runMigrations() {

  await sql(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'manager',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      daily_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
      active INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS employment_type TEXT NOT NULL DEFAULT 'payroll',
      ADD COLUMN IF NOT EXISTS annual_salary NUMERIC(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'GBP',
      ADD COLUMN IF NOT EXISTS start_date DATE,
      ADD COLUMN IF NOT EXISTS termination_date DATE,
      ADD COLUMN IF NOT EXISTS termination_reason TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2),
      ADD COLUMN IF NOT EXISTS pension_rate NUMERIC(5,2) DEFAULT 0
  `);

  await sql(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS job_title TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS department TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS email TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS contract_end_date DATE
  `);

  await sql(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS portal_pin TEXT DEFAULT NULL`);

  await sql(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS email TEXT DEFAULT NULL`);

  await sql(`
    CREATE TABLE IF NOT EXISTS holiday_requests (
      id SERIAL PRIMARY KEY,
      employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      request_date DATE NOT NULL,
      day_type TEXT NOT NULL DEFAULT 'full' CHECK (day_type IN ('full','half')),
      note TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
      reviewed_by INT REFERENCES admins(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS daily_records (
      id SERIAL PRIMARY KEY,
      employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      record_date DATE NOT NULL,
      break_minutes INT NOT NULL DEFAULT 0,
      phone_minutes INT NOT NULL DEFAULT 0,
      wasted_minutes INT NOT NULL DEFAULT 0,
      late_minutes INT NOT NULL DEFAULT 0,
      is_day_off NUMERIC(3,1) NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_by INT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(employee_id, record_date)
    )
  `);

  // Day-off rows flagged with no_deduction are still counted as days taken,
  // but are never charged against salary (e.g. director / approved paid leave).
  await sql(`ALTER TABLE daily_records ADD COLUMN IF NOT EXISTS no_deduction BOOLEAN NOT NULL DEFAULT false`);

  await sql(`
    DO $$ BEGIN
      IF (SELECT data_type FROM information_schema.columns
          WHERE table_name='daily_records' AND column_name='is_day_off') = 'integer' THEN
        ALTER TABLE daily_records
          ALTER COLUMN is_day_off TYPE NUMERIC(3,1)
          USING is_day_off::NUMERIC(3,1);
      END IF;
    END $$
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS manual_adjustments (
      id SERIAL PRIMARY KEY,
      employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      record_date DATE NOT NULL,
      adjustment_minutes INT NOT NULL,
      reason TEXT NOT NULL,
      created_by INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS monthly_payments (
      id SERIAL PRIMARY KEY,
      employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      payment_year INT NOT NULL,
      payment_month INT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      notes TEXT DEFAULT '',
      created_by INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS office_deductions (
      id SERIAL PRIMARY KEY,
      employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      deduction_date DATE NOT NULL DEFAULT CURRENT_DATE,
      notes TEXT DEFAULT '',
      created_by INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS salary_history (
      id SERIAL PRIMARY KEY,
      employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      annual_salary NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'GBP',
      effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
      reason TEXT DEFAULT '',
      created_by INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS bonuses (
      id SERIAL PRIMARY KEY,
      employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      bonus_date DATE NOT NULL DEFAULT CURRENT_DATE,
      reason TEXT NOT NULL DEFAULT '',
      notes TEXT DEFAULT '',
      created_by INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS calendar_reminders (
      id            SERIAL PRIMARY KEY,
      title         TEXT NOT NULL,
      reminder_date DATE NOT NULL,
      recurrence    TEXT NOT NULL DEFAULT 'none'
                      CHECK (recurrence IN ('none','monthly','yearly')),
      category      TEXT NOT NULL DEFAULT 'other'
                      CHECK (category IN ('rent','subscription','deposit','utility','other')),
      amount        NUMERIC(12,2),
      currency      TEXT NOT NULL DEFAULT 'GBP',
      notes         TEXT DEFAULT '',
      created_by    INT REFERENCES admins(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS employee_notes (
      id SERIAL PRIMARY KEY,
      employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      note_type TEXT NOT NULL DEFAULT 'general'
                 CHECK (note_type IN ('general','performance','hr','warning')),
      created_by INT REFERENCES admins(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS hotel_expenses (
      id SERIAL PRIMARY KEY,
      event_name TEXT NOT NULL,
      hotel TEXT NOT NULL DEFAULT '',
      cost TEXT NOT NULL DEFAULT '',
      av_amount NUMERIC(12,2),
      av_currency TEXT NOT NULL DEFAULT 'USD',
      av_billing TEXT NOT NULL DEFAULT 'separate',
      paid_amount NUMERIC(12,2),
      paid_currency TEXT NOT NULL DEFAULT 'USD',
      staff_hotel NUMERIC(12,2),
      flights NUMERIC(12,2),
      printing NUMERIC(12,2),
      status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','partial','paid')),
      notes TEXT NOT NULL DEFAULT '',
      sort_order INT NOT NULL DEFAULT 0,
      created_by INT REFERENCES admins(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`ALTER TABLE hotel_expenses ADD COLUMN IF NOT EXISTS av_billing TEXT NOT NULL DEFAULT 'separate'`);
  await sql(`ALTER TABLE hotel_expenses ADD COLUMN IF NOT EXISTS invoice_name TEXT DEFAULT NULL`);
  await sql(`ALTER TABLE hotel_expenses ADD COLUMN IF NOT EXISTS invoice_data TEXT DEFAULT NULL`);
  await sql(`ALTER TABLE hotel_expenses ADD COLUMN IF NOT EXISTS event_year INT`);
  await sql(`ALTER TABLE hotel_expenses ADD COLUMN IF NOT EXISTS total_cost_num NUMERIC(12,2)`);

  // One-time: move 2025 invoice_dates to 2026 (deals were for 2026 events, signed in 2025)
  await sql(`UPDATE deals SET invoice_date = invoice_date + INTERVAL '1 year' WHERE EXTRACT(YEAR FROM invoice_date) = 2025 AND invoice_date IS NOT NULL`);

  // ── Subscriptions ──────────────────────────────────────────────────────────
  await sql(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      vendor TEXT DEFAULT '',
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'GBP' CHECK (currency IN ('GBP','USD','AED','PHP')),
      billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','quarterly','annually','one_off')),
      renewal_date DATE,
      notes TEXT DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT true,
      created_by INT REFERENCES admins(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Portfolio Events ───────────────────────────────────────────────────────
  await sql(`
    CREATE TABLE IF NOT EXISTS portfolio_events (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      event_date DATE,
      location TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_by INT REFERENCES admins(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The confirmed programme (programme-2027.js) carries more than a name and
  // a date: which producer team runs the event, whether the day is still to be
  // confirmed (so the UI never shows a made-up 1st of the month), the year it
  // is filed under even when no date exists yet, and a stable key that links
  // the row to its entry in the programme so re-running the load renames in
  // place instead of creating a duplicate.
  await sql(`ALTER TABLE portfolio_events
    ADD COLUMN IF NOT EXISTS producer TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS date_tbc TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS programme_year INT,
    ADD COLUMN IF NOT EXISTS programme_key TEXT`);
  await sql(`CREATE UNIQUE INDEX IF NOT EXISTS portfolio_events_programme_key
    ON portfolio_events (programme_key) WHERE programme_key IS NOT NULL`);

  // ── Deals ──────────────────────────────────────────────────────────────────
  await sql(`
    CREATE TABLE IF NOT EXISTS deals (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      company TEXT DEFAULT '',
      contact_name TEXT DEFAULT '',
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'GBP',
      stage TEXT NOT NULL DEFAULT 'Prospect'
        CHECK (stage IN ('Prospect','Qualified','Proposal','Negotiation','Won','Lost')),
      notes TEXT DEFAULT '',
      invoice1_name TEXT,
      invoice1_data TEXT,
      invoice2_name TEXT,
      invoice2_data TEXT,
      created_by INT REFERENCES admins(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS deal_events (
      deal_id INT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      event_id INT NOT NULL REFERENCES portfolio_events(id) ON DELETE CASCADE,
      allocated_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      PRIMARY KEY (deal_id, event_id)
    )
  `);

  // Migrations: add new deal columns (safe on existing installs)
  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS paid_inc_vat NUMERIC(12,2)`);
  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS tax_vat NUMERIC(12,2)`);
  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS invoice_date DATE`);
  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS paid_date DATE`);
  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS bank TEXT DEFAULT ''`);
  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS invoice_number TEXT DEFAULT ''`);
  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS invoice_agreement_sent BOOLEAN DEFAULT false`);
  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS signature_received BOOLEAN DEFAULT false`);
  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS initials TEXT DEFAULT ''`);
  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS row_status TEXT NOT NULL DEFAULT 'none'`);

  // Seed initial hotel expense rows if table is empty
  const heCount = await sql('SELECT COUNT(*) AS c FROM hotel_expenses');
  if (parseInt(heCount[0].c) === 0) {
    const seedRows = [
      { event: 'Ops Miami',               hotel: 'Eden Roc Miami Beach Hotel',                          cost: '$11500 ++',                                              av_a: 6888.00,  av_c: 'USD', paid_a: 23896.90, paid_c: 'USD', sh: 1000, fl: 4000, pr: 550,  status: 'paid', ord: 1 },
      { event: 'Berlin',                  hotel: 'Waldorf Astoria',                                     cost: '€11500 + anticipated revenue reception €1,125.00',       av_a: 4189.40,  av_c: 'EUR', paid_a: 11964.60, paid_c: 'EUR', sh: null, fl: 300,  pr: 800,  status: 'partial', ord: 2 },
      { event: 'Switzerland',             hotel: 'Park Hyatt Zurich',                                   cost: 'CHF 19300',                                              av_a: 1140.00,  av_c: 'CHF', paid_a: 17230.50, paid_c: 'CHF', sh: 250,  fl: 600,  pr: 550,  status: 'paid', ord: 3 },
      { event: 'NYC Fundraising/DL',      hotel: 'Marriott Marquis',                                    cost: '$34K approx',                                            av_a: 10765.00, av_c: 'USD', paid_a: 39463.08, paid_c: 'USD', sh: null, fl: null, pr: null, status: 'paid', ord: 4 },
      { event: 'Ops NYC / Data tech NYC', hotel: 'RENAISSANCE NEW YORK MIDTOWN HOTEL',                  cost: '40++',                                                   av_a: 8359.47,  av_c: 'USD', paid_a: 24435.00, paid_c: 'USD', sh: null, fl: null, pr: null, status: 'pending', ord: 5 },
      { event: 'CFO Miami',               hotel: 'Four Seasons Hotel Miami',                            cost: '$18k ++',                                                av_a: 13057.46, av_c: 'USD', paid_a: 53566.50, paid_c: 'USD', sh: null, fl: null, pr: null, status: 'paid', ord: 6 },
      { event: 'CFO Sanfran',             hotel: 'Hyatt Regency San Francisco',                         cost: '$18k ++',                                                av_a: null,     av_c: 'USD', paid_a: 5400.00,  paid_c: 'USD', sh: null, fl: null, pr: null, status: 'pending', ord: 7 },
      { event: 'CFO London',              hotel: 'Park Plaza Victoria',                                 cost: '£23076',                                                 av_a: null,     av_c: 'GBP', paid_a: 20768.40, paid_c: 'GBP', sh: null, fl: null, pr: null, status: 'pending', ord: 8 },
      { event: 'London Fundraising / Sports', hotel: 'Park Plaza Victoria',                            cost: '£22140',                                                 av_a: null,     av_c: 'GBP', paid_a: 14391.00, paid_c: 'GBP', sh: null, fl: null, pr: null, status: 'pending', ord: 9 },
      { event: 'Data Tech London 6th Oct',hotel: 'ME London',                                           cost: '£7480',                                                  av_a: null,     av_c: 'GBP', paid_a: 2992.00,  paid_c: 'GBP', sh: null, fl: null, pr: null, status: 'pending', ord: 10 },
      { event: 'Chicago',                 hotel: 'DoubleTree by Hilton Chicago – Magnificent Mile',     cost: '$23500 ++ ($31020)',                                      av_a: null,     av_c: 'USD', paid_a: 13000.00, paid_c: 'USD', sh: null, fl: null, pr: null, status: 'pending', ord: 11 },
      { event: 'PD/CFO LA',              hotel: 'Sofitel',                                             cost: '$19k ++',                                                av_a: null,     av_c: 'USD', paid_a: 10000.00, paid_c: 'USD', sh: null, fl: null, pr: 850,  status: 'pending', ord: 12 },
      { event: 'OPS LA',                  hotel: 'Regent',                                              cost: '$13k ++',                                                av_a: null,     av_c: 'USD', paid_a: null,     paid_c: 'USD', sh: null, fl: null, pr: null, status: 'pending', ord: 13 },
      { event: 'CFO NYC',                 hotel: '',                                                    cost: '',                                                       av_a: null,     av_c: 'USD', paid_a: null,     paid_c: 'USD', sh: null, fl: null, pr: null, status: 'pending', ord: 14 },
      { event: 'Lux',                     hotel: 'Le Royal',                                            cost: '€8170',                                                  av_a: null,     av_c: 'EUR', paid_a: null,     paid_c: 'EUR', sh: null, fl: null, pr: null, status: 'pending', ord: 15 },
    ];
    for (const r of seedRows) {
      await sql(
        `INSERT INTO hotel_expenses (event_name, hotel, cost, av_amount, av_currency, paid_amount, paid_currency, staff_hotel, flights, printing, status, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [r.event, r.hotel, r.cost, r.av_a, r.av_c, r.paid_a, r.paid_c, r.sh, r.fl, r.pr, r.status, r.ord]
      );
    }
  }

  const rows = await sql('SELECT COUNT(*) AS c FROM admins');
  if (parseInt(rows[0].c) === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await sql(`INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, 'admin')`,
      ['admin', hash]);
    console.log('Default admin created: username=admin password=admin123');
  }

  await sql('ALTER TABLE employees ADD COLUMN IF NOT EXISTS portal_pin TEXT DEFAULT NULL');

  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS cancelled_reason TEXT DEFAULT ''`);
  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS stage_cancelled BOOLEAN NOT NULL DEFAULT false`);
  await sql(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN NOT NULL DEFAULT false`);

  // Single row-level currency for hotel expenses (replaces separate av_currency / paid_currency)
  await sql(`ALTER TABLE hotel_expenses ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD'`);
  // Migrate: set currency from paid_currency where available
  await sql(`UPDATE hotel_expenses SET currency = paid_currency WHERE currency IS NULL AND paid_currency IS NOT NULL`);

  // Tag pre-existing hotel expenses as 2026 — ONE TIME ONLY.
  // This used to run on every boot, which silently dragged newly added 2027 rows
  // back to 2026 whenever they were saved without a year. The marker table keeps
  // it to a single run so a row's year is only ever changed by the user.
  await sql(`CREATE TABLE IF NOT EXISTS app_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const heYearDone = await sql(`SELECT 1 FROM app_migrations WHERE name = 'hotel_expenses_year_backfill_2026'`);
  if (!heYearDone.length) {
    await sql(`UPDATE hotel_expenses SET event_year = 2026 WHERE event_year IS NULL`);
    await sql(`INSERT INTO app_migrations (name) VALUES ('hotel_expenses_year_backfill_2026') ON CONFLICT DO NOTHING`);
  }

  await sql(`CREATE TABLE IF NOT EXISTS day_off_requests (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL,
  request_date DATE NOT NULL,
  is_day_off NUMERIC(3,1) NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  decline_reason TEXT,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  reviewed_at TIMESTAMP,
  reviewed_by TEXT
)`);
  await sql(`ALTER TABLE day_off_requests ADD COLUMN IF NOT EXISTS reason TEXT`);

  await sql(`CREATE TABLE IF NOT EXISTS emp_notifications (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
)`);

  await sql(`CREATE TABLE IF NOT EXISTS employee_portfolio_events (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  event_date DATE,
  notes TEXT NOT NULL DEFAULT '',
  added_by TEXT NOT NULL DEFAULT 'employee',
  allocated_by INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
}

module.exports = { sql, initDb };

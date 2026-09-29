-- ===========================================================================
-- LPGP Connect -- 2027 programme
--
-- The confirmed programme (25 events across 5 producer teams, "Events by
-- Producer", updated 28 September 2026) is NOT loaded by this file any more.
--
-- It is applied from inside the tracker: Portfolio -> "2027 programme". That
-- panel shows every confirmed event beside the existing row it most likely
-- already is (your "OPS Miami", "PD NYC (Womens)" and so on), and you confirm
-- each one. A confirmed match renames the row in place, so its id -- and every
-- deal allocated to it -- is untouched. Loading the list by SQL would create a
-- second copy of each event next to the one your deals point at, which is the
-- exact mistake the panel exists to prevent.
--
-- If that copy already exists (a confirmed event was created rather than
-- renamed, and the old "OPS Miami" row still sits under "Other events" with
-- its deals), the same panel offers a merge: the old row's deals move onto the
-- linked row, a deal on both becomes one allocation with the amounts added,
-- and the old row is removed. The linked row keeps its id.
--
-- What this file still does is safe to run on its own: it adds the columns the
-- panel needs, for a database that has not started the app since they were
-- introduced. The app adds them itself on boot; running this first is optional.
-- Idempotent.
-- ===========================================================================

ALTER TABLE portfolio_events
  ADD COLUMN IF NOT EXISTS producer        TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS date_tbc        TEXT NOT NULL DEFAULT '',   -- '' | 'day' | 'date'
  ADD COLUMN IF NOT EXISTS programme_year  INT,
  ADD COLUMN IF NOT EXISTS programme_key   TEXT;                       -- e.g. '2027:ops-miami'

CREATE UNIQUE INDEX IF NOT EXISTS portfolio_events_programme_key
  ON portfolio_events (programme_key) WHERE programme_key IS NOT NULL;

-- The list itself lives in programme-2027.js, with the sales CRM's copy in
-- lib/events-catalogue.ts. If you need it as data outside the app:
--
--   node -e "console.table(require('./programme-2027').EVENTS)"

# Ops bridge

The JSON surface the **Sales CRM** (`LPGP-CRM`) calls server-to-server. It
answers:

> Does this company already exist as a deal here, and which events is it
> sponsoring?

and, when you enable it, lets the CRM record deals — without this tracker
ceasing to be the single source of truth for money.

## Enabling it

```bash
openssl rand -hex 32     # generate each secret separately
```

| Variable | Grants | Required |
| --- | --- | --- |
| `OPS_BRIDGE_KEY` | Reads | Yes — unset, every route returns `503` |
| `OPS_BRIDGE_WRITE_KEY` | Writes | No — unset, every write returns `503` |

Set the same values on the sales CRM. **Use two different secrets**: a leaked
read key must never be able to create a financial record.

Read-only is the default posture. You get the match notice, the account
allocations and the Event Performance page without enabling writes at all.

## Auth

Reads send `x-ops-key`; writes send `x-ops-write-key` as well. Both are compared
over SHA-256 digests, so the check is timing-safe for unequal-length inputs.
Neither is the admin session cookie — the caller is another server, not a
browser.

## Routes

### Reads — `x-ops-key`

| Route | Returns |
| --- | --- |
| `GET /api/bridge/ping` | Handshake + deal/event/allocation counts |
| `GET /api/bridge/match?name=Barings` | Scored company matches with their event allocations |
| `GET /api/bridge/companies[?slim=1]` | Every company with deals, grouped |
| `GET /api/bridge/events` | Portfolio events with allocated and paid revenue |
| `GET /api/bridge/events/:id/sponsors` | Who's sponsoring one event, for how much, and the signer's initials |
| `GET /api/bridge/deals/:id` | One deal in full |

Every event -- on `/events` and inside a deal's, a match's or a company's
`events[]` -- carries the programme fields:

| Field | Meaning |
| --- | --- |
| `producer` | The producer team running it (`"Gio & Karam"`, `"Fidak"`, ...), or `""` |
| `date_tbc` | `""` the day is confirmed · `"day"` month known, day TBC (`event_date` is the 1st as a placeholder, never a booking) · `"date"` no date at all |
| `programme_year` | The year it is filed under even when `event_date` is null (`/events` only) |
| `programme_key` | `"2027:ops-miami"` when the row is linked to the confirmed programme, else null (`/events` only) |

Never print `event_date` raw: a `"day"` row's 1st-of-the-month is not a date.

### Writes — also `x-ops-write-key`

| Route | Does |
| --- | --- |
| `POST /api/bridge/deals` | Record a deal with its event allocations |
| `PATCH /api/bridge/deals/:id` | Update a deal (e.g. record a payment) |
| `POST /api/bridge/deals/:id/invoice/:n` | Attach an invoice file (slot 1 or 2) |

Writes reuse the tracker's own allocation writer — passed into the router — so
there is exactly one implementation of how a deal's money is split across
events, whoever creates it.

They refuse rather than guess:

- a missing company, an unknown stage, or a negative amount → `400`
- an allocation pointing at an event that doesn't exist → `400`
- an invoice number already on another deal → `409`

`PATCH` replaces a deal's allocations wholesale, and only when the caller sends
some — omitting them leaves the existing split untouched.

**Programme year.** A deal's `fiscal_year` is the year tab it files under, and
it is a different fact from the month it was signed (`deal_month`). When a
write allocates events and sends no `fiscal_year`, the tracker sets it to the
year those events belong to (their `programme_year`, else the year of their
date) -- so a deal recorded in September 2026 for a 2027 event is a 2027 deal.
An explicit `fiscal_year` always wins; events spanning two years leave it as
it was.

## How matching works

Company names are grouped in JS over a single query rather than via `pg_trgm`,
so it works on any Neon branch without an extension. Scoring is tiered so an
exact hit never loses to a fuzzy one:

| Tier | Score | Example |
| --- | --- | --- |
| Identical once normalised | `1.00` | `Kirkland and Ellis` ↔ `Kirkland & Ellis` |
| Same with legal suffixes stripped | `0.96` | `Barings` ↔ `Barings LLC` |
| Prefix, meaningful share of the name | `0.88` / `0.78` | `Barings` ↔ `Barings Real Estate` |
| Substring (5+ chars) | `0.72` | |
| Token overlap | `≤ 0.75` | |

Only legal-entity suffixes (`ltd`, `llc`, `gmbh`, …) are stripped. Words like
*Capital* and *Partners* are kept deliberately — stripping them would collapse
`Apollo Global Management` and `Apollo Capital` into one match.

`Barings` vs `BlackRock` scores `0`.

## Money

Totals are returned **per currency**, never cross-summed — the tracker holds
GBP, USD, EUR and CHF deals. Cancelled deals are excluded from totals and
counted separately.

## Tests

```bash
npm test
```

Runs the bridge against a stubbed database — no Postgres needed. 41 checks
covering the auth guards (including that a read key cannot write), company
grouping, the match tiers, per-currency totals, every payload shape (including
the signer's initials on sponsor rows), and the
write paths: allocations landing with their split intact, wholesale replacement
on update, and each refusal above.

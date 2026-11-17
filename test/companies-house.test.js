'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { companyNumber, isoDate, parseCompanyPage } = require('../companies-house');

assert.strictEqual(companyNumber('1234567'), '01234567', 'short numbers are padded');
assert.strictEqual(companyNumber(' 0123 4567 '), '01234567');
assert.strictEqual(companyNumber('sc123456'), 'SC123456', 'Scottish and other prefixed numbers');
assert.strictEqual(companyNumber('Example Ltd'), null);
assert.strictEqual(companyNumber(''), null);
assert.strictEqual(companyNumber('123456789'), null, 'too long');

assert.strictEqual(isoDate('5 September 2027'), '2027-09-05');
assert.strictEqual(isoDate('31 december 2026'), '2026-12-31');
assert.strictEqual(isoDate('soon'), null);

const page = fs.readFileSync(path.join(__dirname, 'fixtures', 'companies-house-page.html'), 'utf8');
assert.deepStrictEqual(parseCompanyPage(page), {
  name: 'EXAMPLE & SONS TRADING LTD', status: 'Active', incorporated_on: '2021-03-03',
  accounts_made_up_to: '2026-03-31', accounts_due: '2026-12-31', last_accounts: '2025-03-31',
  statement_date: '2027-03-02', statement_due: '2027-03-16', last_statement: '2026-03-02',
});

// A company that has not filed anything yet: "First accounts", "First statement", no "Last"
const fresh = parseCompanyPage(page.replace('Next accounts', 'First accounts').replace('Next statement', 'First statement')
  .replace(/Last accounts made up to\s*<strong>[^<]*<\/strong>/, '').replace(/Last statement dated <strong>[^<]*<\/strong>/, ''));
assert.strictEqual(fresh.accounts_due, '2026-12-31'); assert.strictEqual(fresh.statement_due, '2027-03-16');
assert.strictEqual(fresh.last_accounts, null); assert.strictEqual(fresh.last_statement, null);

// A dissolved company shows no deadlines; anything that is not a company page is refused
const gone = parseCompanyPage(page.replace(/<div class="grid-row">[\s\S]*$/, '').replace('Active', 'Dissolved'));
assert.strictEqual(gone.status, 'Dissolved'); assert.strictEqual(gone.accounts_due, null); assert.strictEqual(gone.statement_due, null);
assert.strictEqual(parseCompanyPage('<html><body><h1>Page not found</h1></body></html>'), null);

console.log('companies house tests passed');

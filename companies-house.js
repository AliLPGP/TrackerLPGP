'use strict';
// A company's filing deadlines, read off its public Companies House page
// (find-and-update.company-information.service.gov.uk/company/<number>), which needs no
// account or key. The page states the next accounts and the next confirmation statement
// with the date each is due by, so the admin only has to give a company number.
//
// COMPANIES_HOUSE_URL points this somewhere else (the tests use a stand-in).
const SITE = 'https://find-and-update.company-information.service.gov.uk';
const base = () => (process.env.COMPANIES_HOUSE_URL || SITE).replace(/\/+$/, '');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// "12766341", "sc 123456" -> the eight characters Companies House uses, or null
function companyNumber(v) {
  const n = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^\d{1,8}$/.test(n)) return n.padStart(8, '0');
  return /^[A-Z]{2}\d{6}$/.test(n) ? n : null;
}

// "5 September 2027" -> "2027-09-05"
function isoDate(text) {
  const m = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(String(text || '').trim());
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  return month < 0 ? null : `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const plain = html => String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// The company page -> what we keep. Null when the page is not a company's overview.
// A new company's first filings read "First accounts made up to" and "First statement date".
function parseCompanyPage(html) {
  const inside = re => { const m = re.exec(html); return m ? plain(m[1]) : null; };
  const name = inside(/<h1[^>]*class="[^"]*heading-xlarge[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  if (!name) return null;
  const text = plain(html), D = '(\\d{1,2} [A-Za-z]+ \\d{4})';
  const find = (re, i = 1) => { const m = new RegExp(re, 'i').exec(text); return m ? isoDate(m[i]) : null; };
  return {
    name,
    status: inside(/id="company-status"[^>]*>([\s\S]*?)<\/dd>/i) || '',
    incorporated_on: isoDate(inside(/id="company-creation-date"[^>]*>([\s\S]*?)<\/dd>/i)),
    accounts_made_up_to: find(`(?:Next|First) accounts made up to ${D}`),
    accounts_due: find(`(?:Next|First) accounts made up to ${D} due by ${D}`, 2),
    last_accounts: find(`Last accounts made up to ${D}`),
    statement_date: find(`(?:Next|First) statement date ${D}`),
    statement_due: find(`(?:Next|First) statement date ${D} due by ${D}`, 2),
    last_statement: find(`Last statement dated ${D}`),
  };
}

// Looks a company up. Resolves to its details, or null when Companies House has no such
// company; throws when the site cannot be reached or its page cannot be read.
async function lookupCompany(number) {
  const res = await fetch(`${base()}/company/${encodeURIComponent(number)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; filing-deadlines)', Accept: 'text/html' },
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Companies House answered ${res.status}`);
  const found = parseCompanyPage(await res.text());
  if (!found) throw new Error('The Companies House page could not be read');
  return found;
}

const companyUrl = number => `${SITE}/company/${number}`;

module.exports = { companyNumber, isoDate, parseCompanyPage, lookupCompany, companyUrl };

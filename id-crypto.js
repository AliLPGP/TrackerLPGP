'use strict';
// Passport and driving licence files are encrypted before they reach the database
// (AES-256-GCM), so a copy of the database alone does not expose them.
//
// The key comes from the ID_ENCRYPTION_KEY environment variable (any long random
// string; `openssl rand -base64 32` makes one). Until that is set, a key derived from
// JWT_SECRET is used instead. Each stored value records which key sealed it, and
// reencryptAll() moves older values onto the current key, so adding ID_ENCRYPTION_KEY
// later needs nothing else. Keep the key safe: without it the files cannot be opened.

const crypto = require('crypto');

const PREFIX = 'enc1';

function keys() {
  const out = {};
  if (process.env.ID_ENCRYPTION_KEY) out.k = crypto.createHash('sha256').update(process.env.ID_ENCRYPTION_KEY).digest();
  const jwt = process.env.JWT_SECRET || 'lpgp-tracker-jwt-2024';
  out.j = Buffer.from(crypto.hkdfSync('sha256', jwt, 'lpgp-id-documents', 'id-encryption', 32));
  return out;
}
const currentTag = () => (process.env.ID_ENCRYPTION_KEY ? 'k' : 'j');

const isSealed = v => typeof v === 'string' && v.startsWith(PREFIX + ':');

/** Encrypt base64 file data; returns the string to store. */
function seal(base64) {
  const tag = currentTag();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys()[tag], iv);
  const body = Buffer.concat([cipher.update(Buffer.from(base64, 'base64')), cipher.final()]);
  return [PREFIX, tag, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

/** The file bytes from a stored value (older unencrypted values are returned as they are). */
function open(stored) {
  if (!isSealed(stored)) return Buffer.from(String(stored || ''), 'base64');
  const [, tag, iv, authTag, body] = stored.split(':');
  const key = keys()[tag];
  if (!key) throw new Error('The key this ID was encrypted with is not configured (ID_ENCRYPTION_KEY)');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]);
}

/** True when a stored value should be re-sealed: not encrypted, or under an older key. */
const needsResealing = stored => !!stored && (!isSealed(stored) || stored.split(':')[1] !== currentTag());

/** Encrypt any ID still stored in plain form, or under an older key. Returns how many changed. */
async function reencryptAll(q) {
  const { rows } = await q(`SELECT employee_id, id_doc_data FROM employee_onboarding WHERE id_doc_data IS NOT NULL`);
  let n = 0;
  for (const r of rows) {
    if (!needsResealing(r.id_doc_data)) continue;
    const sealed = seal(open(r.id_doc_data).toString('base64'));
    await q('UPDATE employee_onboarding SET id_doc_data = ? WHERE employee_id = ? AND id_doc_data = ?', [sealed, r.employee_id, r.id_doc_data]);
    n++;
  }
  return n;
}

module.exports = { seal, open, isSealed, reencryptAll };

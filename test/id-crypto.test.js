// ID documents are encrypted at rest: round trip, tamper detection, older plain values,
// and moving onto a new key.
const assert = require('assert');
const crypto = require('crypto');

delete process.env.ID_ENCRYPTION_KEY;
process.env.JWT_SECRET = 'test-jwt-secret';
const idc = require('../id-crypto');

(async () => {
  const file = crypto.randomBytes(5000).toString('base64');
  const sealed = idc.seal(file);
  assert.ok(idc.isSealed(sealed) && !sealed.includes(file.slice(0, 40)), 'stored value is not the file');
  assert.strictEqual(idc.open(sealed).toString('base64'), file, 'round trip');
  assert.notStrictEqual(idc.seal(file), sealed, 'a fresh IV each time');

  // Any change to the stored value is detected, not silently opened
  const parts = sealed.split(':');
  const body = Buffer.from(parts[4], 'base64'); body[10] ^= 1; parts[4] = body.toString('base64');
  assert.throws(() => idc.open(parts.join(':')), 'tampering detected');

  // Older plain values still open
  assert.strictEqual(idc.open(file).toString('base64'), file);

  // Plain and JWT-keyed values move onto ID_ENCRYPTION_KEY once it is set
  const rows = [{ employee_id: 1, id_doc_data: file }, { employee_id: 2, id_doc_data: sealed }];
  const q = async (sql, params) => {
    if (/^SELECT/.test(sql)) return { rows: rows.map(r => ({ ...r })) };
    const r = rows.find(x => x.employee_id === params[1] && x.id_doc_data === params[2]);
    if (r) r.id_doc_data = params[0];
    return { rows: [] };
  };
  assert.strictEqual(await idc.reencryptAll(q), 1, 'the plain one is encrypted');
  process.env.ID_ENCRYPTION_KEY = 'a-long-random-test-key';
  assert.strictEqual(await idc.reencryptAll(q), 2, 'both move to the new key');
  assert.ok(rows.every(r => r.id_doc_data.split(':')[1] === 'k'));
  assert.ok(rows.every(r => idc.open(r.id_doc_data).toString('base64') === file), 'still the same file');
  assert.strictEqual(await idc.reencryptAll(q), 0, 'nothing left to do');
  console.log('id encryption tests passed');
})().catch(e => { console.error(e); process.exit(1); });

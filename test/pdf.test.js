// The PDF helpers behind onboarding: field reading, filling, photo-to-PDF and signature pages.
const assert = require('assert');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { readFormFields, fillForm, imageToPdf, appendSignaturePage, sha256 } = require('../pdf-sign');

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function makeForm() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595, 842]);
  p1.drawText('Starter checklist', { x: 50, y: 780, size: 18, font });
  const form = doc.getForm();
  const full = form.createTextField('full_name'); full.addToPage(p1, { x: 50, y: 700, width: 240, height: 22 });
  const ni = form.createTextField('ni_number'); ni.addToPage(p1, { x: 50, y: 660, width: 140, height: 22 }); ni.setMaxLength(9);
  const notes = form.createTextField('notes'); notes.enableMultiline(); notes.addToPage(p1, { x: 50, y: 560, width: 300, height: 70 });
  const loan = form.createCheckBox('student_loan'); loan.addToPage(p1, { x: 50, y: 520, width: 16, height: 16 });
  const radio = form.createRadioGroup('statement');
  radio.addOptionToPage('A', p1, { x: 50, y: 480, width: 14, height: 14 });
  radio.addOptionToPage('B', p1, { x: 90, y: 480, width: 14, height: 14 });
  const dd = form.createDropdown('plan'); dd.addOptions(['Plan 1', 'Plan 2']); dd.addToPage(p1, { x: 50, y: 440, width: 120, height: 20 });
  const p2 = doc.addPage([595, 842]);
  const second = form.createTextField('page_two'); second.addToPage(p2, { x: 60, y: 700, width: 200, height: 22 });
  return doc.save();
}

(async () => {
  const bytes = await makeForm();

  // fields are found with page and position (from the top of the page)
  const info = await readFormFields(bytes);
  assert.strictEqual(info.fillable, true);
  assert.strictEqual(info.pages.length, 2);
  const byName = Object.fromEntries(info.fields.map(f => [f.name, f]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['full_name', 'ni_number', 'notes', 'page_two', 'plan', 'statement', 'student_loan']);
  assert.strictEqual(byName.full_name.type, 'text');
  assert.strictEqual(byName.full_name.widgets[0].page, 0);
  assert.ok(Math.abs(byName.full_name.widgets[0].y - (842 - 700 - 22)) < 1, 'y measured from the top');
  assert.strictEqual(byName.page_two.widgets[0].page, 1);
  assert.strictEqual(byName.ni_number.maxLength, 9);
  assert.strictEqual(byName.notes.multiline, true);
  assert.strictEqual(byName.student_loan.type, 'checkbox');
  assert.deepStrictEqual(byName.statement.options, ['A', 'B']);
  assert.strictEqual(byName.statement.widgets.length, 2);
  assert.deepStrictEqual(byName.plan.options, ['Plan 1', 'Plan 2']);

  // filling: answers become part of the page; unknown names and odd characters are harmless
  const filled = await fillForm(bytes, { full_name: 'Zoë ☃ Smith', ni_number: 'QQ123456CXTRA', student_loan: true, statement: 'B', plan: 'Plan 2', ghost: 'x' });
  const after = await readFormFields(filled);
  assert.strictEqual(after.fields.length, 0, 'flattened: no fields left to edit');
  assert.strictEqual((await PDFDocument.load(filled)).getPageCount(), 2);

  // a flat PDF is reported as not fillable
  const flat = await PDFDocument.create(); flat.addPage();
  assert.strictEqual((await readFormFields(await flat.save())).fillable, false);

  // signature page: original pages kept, one added, hash recorded
  const signed = await appendSignaturePage(filled, { title: 'Starter sheet', signerName: 'Zoë Smith', signaturePng: 'data:image/png;base64,' + PNG.toString('base64'), signedAt: '2026-10-24T10:30:00Z' });
  assert.strictEqual((await PDFDocument.load(signed)).getPageCount(), 3);
  assert.ok(sha256(filled).length === 64);
  // a bad signature image does not stop the page being made
  const noSig = await appendSignaturePage(filled, { title: 'NDA', signerName: 'A B', signaturePng: 'data:image/png;base64,AAAA' });
  assert.strictEqual((await PDFDocument.load(noSig)).getPageCount(), 3);

  // a photo becomes a one-page PDF
  const fromPhoto = await imageToPdf(PNG, 'png');
  assert.strictEqual((await PDFDocument.load(fromPhoto)).getPageCount(), 1);

  console.log('pdf tests passed');
})().catch(e => { console.error('FAIL', e); process.exit(1); });

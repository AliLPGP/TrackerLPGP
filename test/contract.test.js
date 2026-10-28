// The employment contract template: every field it uses can be filled, filling leaves
// no {{field}} behind, and the result lays out as a PDF.
const assert = require('assert');
const PizZip = require('pizzip');
const { PDFDocument } = require('pdf-lib');
const cg = require('../contract-gen');

(async () => {
  const tpl = cg.builtinTemplate();
  const { tags, unknown } = cg.templateTags(tpl);
  assert.deepStrictEqual(unknown, []);
  for (const t of ['employee_name', 'employee_address', 'job_title', 'employment_basis', 'start_date', 'annual_salary', 'holiday_terms']) assert.ok(tags.includes(t), t);

  const data = { employee_name: 'Jane Example', employee_address: '1 Sample Street, London, AB1 2CD', job_title: 'Events Coordinator',
    employment_basis: 'permanent, part-time', start_date: '11 May 2026', annual_salary: '35,000.00', salary_effective_date: '28 August 2026', holiday_days: '5',
    holiday_terms: 'Under the scheme you may take up to 5 days off in each holiday year.' };
  const xml = cg.fillTemplate(tpl, data).file('word/document.xml').asText();
  const text = (xml.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('');
  assert.ok(!text.includes('{{'), 'no field left unfilled');
  assert.ok(text.includes('Jane Example, of 1 Sample Street, London, AB1 2CD'));
  assert.ok(text.includes('£35,000.00 per year before tax, effective from 28 August 2026'));
  assert.ok(text.includes('Events Coordinator'));
  assert.ok(text.includes('on a permanent, part-time basis'));
  assert.ok(text.includes('Under the scheme you may take up to 5 days off'), 'holiday clause filled');

  const pdf = await PDFDocument.load(await cg.renderContract(tpl, data));
  assert.ok(pdf.getPageCount() >= 2, 'contract runs to at least two pages');

  // A field we cannot fill is reported, so a bad template is refused
  const zip = new PizZip(tpl);
  zip.file('word/document.xml', zip.file('word/document.xml').asText().replace('{{job_title}}', '{{job_titel}}'));
  assert.deepStrictEqual(cg.templateTags(zip.generate({ type: 'nodebuffer' })).unknown, ['job_titel']);
  console.log('contract tests passed');
})().catch(e => { console.error(e); process.exit(1); });

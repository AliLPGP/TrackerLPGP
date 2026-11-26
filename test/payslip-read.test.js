'use strict';
// Reading payslip PDFs. Every payslip here is made up and built by the test itself:
// one the way the accountant's software writes them (each letter placed on its own, in a
// flipped coordinate space, with an embedded font that only maps codes to letters), one
// drawn with pdf-lib and an embedded font, and one with a standard font.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { readPdfText } = require('../pdf-text');
const { readPayslip, matchPerson, money } = require('../payslip-read');

// ── A made-up payslip, as boxes of [label, figure] ──
const SLIP = {
  name: 'Jane Example', heading: 'Payslip for Month Ending 30 Nov 2026',
  boxes: [
    ['EMPLOYEE DETAILS', [['Tax code', '1257L'], ['National Insurance number', 'QQ 12 34 56 C'], ['National Insurance table', 'A'], ['Student Loan plan', 'Plan 2'], ['Annual leave remaining', '12.5 days']]],
    ['ADDITIONS', [['Monthly pay', '£2,500.00'], ['Total', '£2,500.00']]],
    ['DEDUCTIONS', [['Tax', '£290.20'], ['National Insurance', '£116.16'], ['Student Loan deductions', '£4.00'], ['NEST', '£79.20'], ['Total', '£489.56']]],
    ['THIS PAY PERIOD', [['Taxable gross pay', '£2,500.00'], ['Employer National Insurance', '£312.45'], ['Net pay', '£2,089.64']]],
    ['YEAR TO DATE', [['Taxable gross pay', '£20,000.00'], ['Tax', '£2,322.60'], ['Employee National Insurance', '£929.28'], ['Employer National Insurance', '£2,499.60'],
      ['Student Loan deductions', '£32.00'], ['Employee pension', '£633.60'], ['Employer pension', '£475.20']]],
    ['PAYMENT', [['£2,010.44', ''], ['Paid on 30/11/2026', '']]],
  ],
  footer: 'EXAMPLE TRADING LTD · PAYE ref 123/AB45678',
};

// ── 1. The accountant's software: one glyph per instruction, y axis flipped ──
// A hand-made PDF: a Type0 font whose only useful part is its code-to-letter table.
function skiaStylePdf(slip, { title = `${slip.name} - ${slip.heading}` } = {}) {
  const chars = [];
  const cid = ch => { let i = chars.indexOf(ch); if (i < 0) { chars.push(ch); i = chars.length - 1; } return i + 3; };
  const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');
  const W = 6;   // every glyph 6 units wide at size 12 (500/1000 of the size)
  const run = (text, x, y, size = 12) => {
    let out = `BT\n/F1 ${size} Tf\n1 0 0 -1 ${x} ${y} Tm\n`;
    [...text].forEach((ch, i) => { out += `${i ? `${(W * size) / 12} 0 Td ` : ''}<${hex4(cid(ch))}> Tj\n`; });
    return out + 'ET\n';
  };
  // Three boxes across, two rows of boxes, as on the real thing. Units before the page
  // transform: the page is 2480 wide, drawn at 0.24.
  let ops = '.24 0 0 -.24 0 420 cm\nq\n3.125 0 0 3.125 116 116 cm\n';
  ops += run(slip.name, 0, 22, 27) + run(slip.heading, 0, 46, 21);
  slip.boxes.forEach(([head, rows], b) => {
    const left = (b % 3) * 240, top = 70 + Math.floor(b / 3) * 250;
    ops += `q\n1 0 0 1 ${left} ${top} cm\n` + run(head, 60, 7);
    rows.forEach(([label, value], r) => {
      const y = 31 + r * 15;
      ops += run(label, 8.5, y);
      if (value) ops += run(value, 220 - value.length * W, y);   // right-aligned
    });
    ops += 'Q\n';
  });
  ops += run(slip.footer, 220, 600) + 'Q\n';
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n`
    + chars.map((ch, i) => `<${hex4(i + 3)}> <${hex4(ch.charCodeAt(0))}>`).join('\n') + '\nendbfchar\nendcmap\nend\nend';
  const stream = (dict, data) => { const z = zlib.deflateSync(Buffer.from(data, 'latin1')); return Buffer.concat([Buffer.from(`<<${dict}/Filter/FlateDecode/Length ${z.length}>>stream\n`, 'latin1'), z, Buffer.from('\nendstream', 'latin1')]); };
  const objects = [
    `<</Title(${title})/Producer(Test)>>`,
    '<</Type/Catalog/Pages 3 0 R>>',
    '<</Type/Pages/Count 1/Kids[4 0 R]>>',
    '<</Type/Page/Parent 3 0 R/MediaBox[0 0 595 420]/Contents 5 0 R/Resources<</Font<</F1 6 0 R>>>>>>',
    stream('', ops),
    '<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Made/Encoding/Identity-H/DescendantFonts[7 0 R]/ToUnicode 8 0 R>>',
    '<</Type/Font/Subtype/CIDFontType2/BaseFont/AAAAAA+Made/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 500>>',
    stream('', cmap),
  ];
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')], offsets = [];
  let at = parts[0].length;
  objects.forEach((o, i) => {
    const body = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(at); at += body.length; parts.push(body);
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<</Size ${objects.length + 1}/Root 2 0 R/Info 1 0 R>>\nstartxref\n${at}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(xref, 'latin1')]);
}

// ── 2 and 3. Drawn with pdf-lib: an embedded font, or a standard one ──
async function pdfLibPdf(slip, embedded) {
  const pdf = await PDFDocument.create();
  let font;
  if (embedded) { pdf.registerFontkit(fontkit); font = await pdf.embedFont(fs.readFileSync(path.join(__dirname, '..', 'assets', 'fonts', 'Geist-Regular.ttf')), { subset: true }); }
  else font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 420]);
  const text = (t, x, y, size = 9) => page.drawText(t, { x, y, size, font });
  text(slip.name, 28, 380, 18); text(slip.heading, 28, 362, 13);
  slip.boxes.forEach(([head, rows], b) => {
    const left = 28 + (b % 3) * 185, top = 335 - Math.floor(b / 3) * 190;
    text(head, left + 40, top);
    rows.forEach(([label, value], r) => {
      const y = top - 18 - r * 12;
      text(label, left + 4, y);
      if (value) text(value, left + 175 - font.widthOfTextAtSize(value, 9), y);
    });
  });
  text(slip.footer, 180, 20);
  pdf.setTitle(`${slip.name} - ${slip.heading}`);
  return Buffer.from(await pdf.save());
}

function checkFigures(r, where) {
  assert.strictEqual(r.ok, true, `${where}: readable`);
  assert.deepStrictEqual(r.problems, [], `${where}: no problems`);
  assert.strictEqual(r.name, 'Jane Example', `${where}: name`);
  assert.deepStrictEqual(r.period, { year: 2026, month: 11, end: '2026-11-30' }, `${where}: month`);
  assert.strictEqual(r.paid_on, '2026-11-30');
  assert.strictEqual(r.tax_code, '1257L');
  assert.strictEqual(r.tax_basis, 'cumulative');
  assert.strictEqual(r.ni_table, 'A');
  assert.deepStrictEqual(r.student_loan_plans, ['2']);
  assert.deepStrictEqual(r.additions, [{ label: 'Monthly pay', amount: 2500, kind: 'basic' }]);
  assert.deepStrictEqual(r.deductions.map(d => [d.label, d.amount, d.kind]), [['Tax', 290.2, 'tax'], ['National Insurance', 116.16, 'ni'], ['Student Loan deductions', 4, 'student_loan'], ['NEST', 79.2, 'pension']]);
  assert.strictEqual(r.gross, 2500); assert.strictEqual(r.basic, 2500); assert.strictEqual(r.taxable_gross, 2500);
  assert.strictEqual(r.tax, 290.2); assert.strictEqual(r.ni, 116.16); assert.strictEqual(r.student_loan, 4); assert.strictEqual(r.pension, 79.2);
  assert.strictEqual(r.deductions_total, 489.56); assert.strictEqual(r.net_pay, 2089.64); assert.strictEqual(r.employer_ni, 312.45);
  assert.strictEqual(r.payment, 2010.44, `${where}: the amount paid is the PAYMENT figure, not net pay`);
  assert.deepStrictEqual(r.ytd, { gross: 20000, tax: 2322.6, employee_ni: 929.28, employer_ni: 2499.6, student_loan: 32, postgrad_loan: null, employee_pension: 633.6, employer_pension: 475.2 });
  assert.strictEqual(r.employer, 'EXAMPLE TRADING LTD'); assert.strictEqual(r.paye_ref, '123/AB45678');
  assert.strictEqual(r.adds_up, true);
  assert.ok(!JSON.stringify(r).includes('QQ 12'), `${where}: the National Insurance number is never read into the result`);
}

(async () => {
  // The accountant's software
  const skia = skiaStylePdf(SLIP);
  const text = readPdfText(skia);
  assert.strictEqual(text.ok, true);
  assert.strictEqual(text.title, 'Jane Example - Payslip for Month Ending 30 Nov 2026');
  assert.strictEqual(text.lines[0], 'Jane Example');
  assert.ok(text.lines.includes('Tax code\t1257L'), 'a label and its figure are one line, tab between');
  checkFigures(readPayslip(skia, 'Jane Example - Payslip for Month Ending 30 Nov 2026.pdf'), 'payroll software layout');

  // pdf-lib with an embedded font, and with a standard font (no code-to-letter table at all)
  checkFigures(readPayslip(await pdfLibPdf(SLIP, true)), 'embedded font');
  checkFigures(readPayslip(await pdfLibPdf(SLIP, false)), 'standard font');

  // A month-1 tax code, a postgraduate loan, a bonus on top, and no pension
  const other = JSON.parse(JSON.stringify(SLIP));
  other.name = 'Sam Sample-Smith';
  other.boxes[0][1] = [['Tax code', '1257L w1m1'], ['National Insurance table', 'A'], ['Student Loan plan', 'Plan 1 and Postgraduate']];
  other.boxes[1][1] = [['Monthly pay', '£2,000.00'], ['Bonus', '£500.00'], ['Total', '£2,500.00']];
  other.boxes[2][1] = [['Tax', '£290.20'], ['National Insurance', '£116.16'], ['Total', '£406.36']];
  other.boxes[5][1] = [['£2,093.64', ''], ['Paid on 01/12/2026', '']];
  const o = readPayslip(skiaStylePdf(other));
  assert.strictEqual(o.ok, true);
  assert.strictEqual(o.name, 'Sam Sample-Smith');
  assert.strictEqual(o.tax_basis, 'month1'); assert.strictEqual(o.tax_code, '1257L');
  assert.deepStrictEqual(o.student_loan_plans, ['1']); assert.strictEqual(o.postgrad_loan, true);
  assert.strictEqual(o.basic, 2000); assert.strictEqual(o.gross, 2500);
  assert.deepStrictEqual(o.additions.map(a => a.kind), ['basic', 'extra']);
  assert.strictEqual(o.pension, null); assert.strictEqual(o.payment, 2093.64); assert.strictEqual(o.paid_on, '2026-12-01');
  assert.deepStrictEqual(o.period, { year: 2026, month: 11, end: '2026-11-30' }, 'the month it ends in, not the month it was paid');

  // Figures that do not add up are still read, with a warning
  const wrong = JSON.parse(JSON.stringify(SLIP));
  wrong.boxes[5][1] = [['£2,110.44', ''], ['Paid on 30/11/2026', '']];
  const w = readPayslip(skiaStylePdf(wrong));
  assert.strictEqual(w.ok, true); assert.strictEqual(w.adds_up, false); assert.strictEqual(w.payment, 2110.44);
  assert.ok(w.problems.some(p => /do not add up/.test(p)));

  // No PAYMENT box: pay less deductions
  const noBox = JSON.parse(JSON.stringify(SLIP)); noBox.boxes.pop();
  assert.strictEqual(readPayslip(skiaStylePdf(noBox)).payment, 2010.44);

  // The month and the name can come from the document title or the file name when the page has no heading
  const bare = JSON.parse(JSON.stringify(SLIP)); bare.heading = 'Pay advice';
  const viaTitle = readPayslip(skiaStylePdf(bare, { title: 'Jane Example - Payslip for Month Ending 31 Oct 2026' }));
  assert.deepStrictEqual(viaTitle.period, { year: 2026, month: 10, end: '2026-10-31' }); assert.strictEqual(viaTitle.name, 'Jane Example');
  const viaFile = readPayslip(skiaStylePdf(bare, { title: 'Untitled' }), 'Jane_Example_-_Payslip_for_Month_Ending_30_Sep_2026.pdf');
  assert.deepStrictEqual(viaFile.period, { year: 2026, month: 9, end: '2026-09-30' }); assert.strictEqual(viaFile.name, 'Jane Example');

  // A weekly payslip is read but not placed in a month
  const weekly = JSON.parse(JSON.stringify(SLIP)); weekly.heading = 'Payslip for Week Ending 27 Nov 2026';
  const wk = readPayslip(skiaStylePdf(weekly));
  assert.strictEqual(wk.ok, false); assert.strictEqual(wk.period, null); assert.strictEqual(wk.payment, 2010.44);

  // Things that are not payslips never throw
  for (const junk of [Buffer.alloc(0), Buffer.from('hello'), Buffer.from('%PDF-1.4\n%%EOF'), Buffer.from('%PDF-1.7\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\ntrailer<</Root 1 0 R/Encrypt 9 0 R>>'), skia.subarray(0, 900), null]) {
    const r = readPayslip(junk);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.length >= 1 && r.problems.every(p => typeof p === 'string' && p.length > 10));
  }
  assert.ok(/password/.test(readPayslip(Buffer.from('%PDF-1.7\n1 0 obj\n<</Type/Catalog>>\nendobj\ntrailer<</Root 1 0 R/Encrypt 9 0 R>>')).problems[0]));

  // Amounts
  assert.strictEqual(money('£2,375.00'), 2375); assert.strictEqual(money('£0.00'), 0); assert.strictEqual(money('-£12.50'), -12.5);
  assert.strictEqual(money('(£12.50)'), -12.5); assert.strictEqual(money('£-12.50'), -12.5); assert.strictEqual(money('1,234,567.89'), 1234567.89);
  assert.strictEqual(money('1257L'), null); assert.strictEqual(money('12.5 days'), null); assert.strictEqual(money(''), null); assert.strictEqual(money('£12'), null);

  // Whose payslip: the tracker often holds a shorter name than the payslip prints
  const people = [{ id: 1, name: 'Jane Example' }, { id: 2, name: 'Sam Sample' }, { id: 3, name: 'José Peña Ruiz' }, { id: 4, name: 'Alex Stone' }, { id: 5, name: 'Alex Stone-Hart' }];
  assert.deepStrictEqual(matchPerson('Jane Example', people), { id: 1, sure: true });
  assert.deepStrictEqual(matchPerson('JANE  EXAMPLE', people), { id: 1, sure: true });
  assert.deepStrictEqual(matchPerson('Jane Mary Example', people), { id: 1, sure: true }, 'a middle name on the payslip');
  assert.deepStrictEqual(matchPerson('Jose Pena Ruiz', people), { id: 3, sure: true }, 'accents do not matter');
  assert.deepStrictEqual(matchPerson('Jose Pena', people), { id: 3, sure: true }, 'the payslip has the shorter name');
  assert.deepStrictEqual(matchPerson('Sam Sample-Smith', people), { id: 2, sure: true });
  assert.deepStrictEqual(matchPerson('Alex Stone', people), { id: 4, sure: true }, 'an exact match wins over a longer name');
  assert.deepStrictEqual(matchPerson('Alex Stone Hart', people), { id: 5, sure: true });
  assert.deepStrictEqual(matchPerson('Jane', people), { id: null, candidates: [] }, 'a first name alone is not enough');
  assert.deepStrictEqual(matchPerson('Nobody Here', people), { id: null, candidates: [] });
  assert.deepStrictEqual(matchPerson('', people), { id: null, candidates: [] });
  const twins = [{ id: 7, name: 'Pat Lee' }, { id: 8, name: 'Pat Lee' }];
  assert.deepStrictEqual(matchPerson('Pat Lee', twins), { id: null, candidates: [7, 8] }, 'two people with the same name: ask');

  console.log('payslip reading tests passed');
})().catch(e => { console.error(e); process.exit(1); });

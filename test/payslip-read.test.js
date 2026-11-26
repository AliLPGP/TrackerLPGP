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
const { readPayslip, matchPerson, whosePayslip, nameKey, money } = require('../payslip-read');

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
// A label or a figure holding "\n" is drawn over several lines, as the real thing does
// when a figure grows and its label no longer fits beside it.
//   figureOn   'first' draws a wrapped label's figure level with its first line, after the
//              label's lines (how the payroll software does it); 'last' beside its last line;
//              'close' one space after the label, where the page has run out of room;
//              'before' draws each figure first and its label after it, to its left
//   headGap    extra space between the letters of the box headings
//   before, after   extra lines drawn before the name or after the footer (a browser's
//              printed page header)
//   type3      embed the font as a Type 3 font, whose widths are in the font's own units
function skiaStylePdf(slip, { title = `${slip.name} - ${slip.heading}`.replace(/\n/g, ' '), figureOn = 'first', headGap = 0, before = [], after = [], type3 = false } = {}) {
  const chars = [];
  const cid = ch => { let i = chars.indexOf(ch); if (i < 0) { chars.push(ch); i = chars.length - 1; } return i + 3; };
  const hex = n => n.toString(16).toUpperCase().padStart(type3 ? 2 : 4, '0');
  const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');
  const W = 6;   // every glyph 6 units wide at size 12 (500/1000 of the size)
  const run = (text, x, y, size = 12, gap = 0) => {
    let out = `BT\n/F1 ${size} Tf\n1 0 0 -1 ${x} ${y} Tm\n`;
    [...text].forEach((ch, i) => { out += `${i ? `${(W * size) / 12 + gap} 0 Td ` : ''}<${hex(cid(ch))}> Tj\n`; });
    return out + 'ET\n';
  };
  // Three boxes across, two rows of boxes, as on the real thing. Units before the page
  // transform: the page is 2480 wide, drawn at 0.24.
  let ops = '.24 0 0 -.24 0 420 cm\nq\n3.125 0 0 3.125 116 116 cm\n';
  before.forEach((line, i) => { ops += run(line, 0, -60 + i * 12, 8); });
  const nameLines = slip.name.split('\n');
  nameLines.forEach((line, i) => { ops += run(line, 0, 22 - (nameLines.length - 1 - i) * 30, 27); });
  ops += run(slip.heading, 0, 46, 21);
  slip.boxes.forEach(([head, rows], b) => {
    const left = (b % 3) * 240, top = 70 + Math.floor(b / 3) * 250;
    ops += `q\n1 0 0 1 ${left} ${top} cm\n` + run(head, 60, 7, 12, headGap);
    let y = 31;
    rows.forEach(([label, value]) => {
      const labelLines = label.split('\n'), valueLines = String(value || '').split('\n');
      if (figureOn === 'before' && value) ops += run(valueLines[0], 220 - valueLines[0].length * W, y);
      labelLines.forEach((part, k) => {
        ops += run(part, 8.5, y + k * 15);
        if (figureOn === 'last' && k === labelLines.length - 1 && value) ops += run(valueLines[0], 220 - valueLines[0].length * W, y + k * 15);
        if (figureOn === 'close' && k === labelLines.length - 1 && value) ops += run(valueLines[0], 8.5 + (part.length + 1) * W, y + k * 15);
      });
      if (value) valueLines.forEach((part, k) => { if (!['last', 'close', 'before'].includes(figureOn) || k > 0) ops += run(part, 220 - part.length * W, y + k * 15); });   // right-aligned
      y += Math.max(labelLines.length, valueLines.length) * 15;
    });
    ops += 'Q\n';
  });
  ops += run(slip.footer, 220, 600);
  after.forEach((line, i) => { ops += run(line, 0, 640 + i * 12, 8); });
  ops += 'Q\n';
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n${type3 ? '<00> <FF>' : '<0000> <FFFF>'}\nendcodespacerange\n${chars.length} beginbfchar\n`
    + chars.map((ch, i) => `<${hex(i + 3)}> <${hex4(ch.charCodeAt(0))}>`).join('\n') + '\nendbfchar\nendcmap\nend\nend';
  const stream = (dict, data) => { const z = zlib.deflateSync(Buffer.from(data, 'latin1')); return Buffer.concat([Buffer.from(`<<${dict}/Filter/FlateDecode/Length ${z.length}>>stream\n`, 'latin1'), z, Buffer.from('\nendstream', 'latin1')]); };
  const objects = [
    `<</Title(${title})/Producer(Test)>>`,
    '<</Type/Catalog/Pages 3 0 R>>',
    '<</Type/Pages/Count 1/Kids[4 0 R]>>',
    '<</Type/Page/Parent 3 0 R/MediaBox[0 0 595 420]/Contents 5 0 R/Resources<</Font<</F1 6 0 R>>>>>>',
    stream('', ops),
    // (a Type 3 font 2048 units to the em: each glyph 1024 units wide is the same half an em)
    type3 ? `<</Type/Font/Subtype/Type3/FontBBox[0 0 2048 2048]/FontMatrix[.00048828125 0 0 -.00048828125 0 0]/CharProcs<<>>/Encoding<</Type/Encoding/Differences[]>>/FirstChar 0/LastChar 255/Widths[${Array(256).fill(1024).join(' ')}]/ToUnicode 8 0 R>>`
      : '<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Made/Encoding/Identity-H/DescendantFonts[7 0 R]/ToUnicode 8 0 R>>',
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

  // Labels wrap onto two or three lines as the figures beside them grow, and which ones
  // wrap changes from month to month. Every figure still lands in its own box: the
  // "deductions" that ends "Student Loan deductions" is not the DEDUCTIONS heading, and the
  // "payment" that ends "Statutory redundancy payment" is not the PAYMENT box.
  const wrapped = JSON.parse(JSON.stringify(SLIP));
  wrapped.boxes[0][1] = [['Tax\ncode', 'K475 (Week 1/Month\n1)'], ['National\nInsurance\nnumber', 'QQ 12 34 56 C'], ['National\nInsurance table', 'A'], ['Student Loan\nplan', 'Plan 2'], ['Annual leave\nremaining', '12.5 days']];
  wrapped.boxes[1][1] = [['Monthly pay', '£2,500.00'], ['Statutory redundancy\npayment', '£1,000.00'], ['Total', '£3,500.00']];
  wrapped.boxes[2][1] = [['Tax', '£290.20'], ['National\nInsurance', '£116.16'], ['Student Loan\ndeductions', '£4.00'], ['NEST', '£79.20'], ['Total', '£489.56']];
  wrapped.boxes[3][1][1] = ['Employer National\nInsurance', '£312.45'];
  wrapped.boxes[4][1] = [['Taxable gross pay', '£20,000.00'], ['Tax', '£2,322.60'], ['Employee National\nInsurance', '£929.28'], ['Employer National\nInsurance', '£2,499.60'],
    ['Student Loan\ndeductions', '£1,032.00'], ['Employee pension', '£633.60'], ['Employer pension', '£475.20']];
  wrapped.boxes[5][1] = [['£3,010.44', ''], ['Paid on 30/11/2026', '']];
  for (const figureOn of ['first', 'last']) {
    const r = readPayslip(skiaStylePdf(wrapped, { figureOn })), where = `wrapped labels, figure beside the ${figureOn} line`;
    assert.strictEqual(r.ok, true, where); assert.deepStrictEqual(r.problems, [], where);
    assert.strictEqual(r.tax_code, 'K475', where); assert.strictEqual(r.tax_basis, 'month1', where);
    assert.strictEqual(r.ni_table, 'A', where); assert.deepStrictEqual(r.student_loan_plans, ['2'], where); assert.strictEqual(r.postgrad_loan, false, where);
    assert.deepStrictEqual(r.additions, [{ label: 'Monthly pay', amount: 2500, kind: 'basic' }, { label: 'Statutory redundancy payment', amount: 1000, kind: 'extra' }], where);
    assert.deepStrictEqual(r.deductions.map(d => [d.label, d.amount, d.kind]),
      [['Tax', 290.2, 'tax'], ['National Insurance', 116.16, 'ni'], ['Student Loan deductions', 4, 'student_loan'], ['NEST', 79.2, 'pension']], where);
    assert.strictEqual(r.gross, 3500, where); assert.strictEqual(r.basic, 2500, where); assert.strictEqual(r.pension, 79.2, where); assert.strictEqual(r.other_deductions, null, where);
    assert.strictEqual(r.employer_ni, 312.45, where); assert.strictEqual(r.net_pay, 2089.64, where); assert.strictEqual(r.payment, 3010.44, where);
    assert.deepStrictEqual(r.ytd, { gross: 20000, tax: 2322.6, employee_ni: 929.28, employer_ni: 2499.6, student_loan: 1032, postgrad_loan: null, employee_pension: 633.6, employer_pension: 475.2 }, where);
    assert.strictEqual(r.adds_up, true, where);
    assert.ok(!JSON.stringify(r).includes('QQ 12'), `${where}: the National Insurance number is never read into the result`);
  }

  // Box headings with their letters spaced apart, and a font embedded the other way
  // (Type 3, whose widths are in its own units rather than thousandths)
  assert.ok(readPdfText(skiaStylePdf(SLIP, { headGap: 2.6 })).lines.includes('D E D U C T I O N S'), 'the headings really are spaced out in this one');
  checkFigures(readPayslip(skiaStylePdf(SLIP, { headGap: 2.6 })), 'letter-spaced headings');
  assert.strictEqual(readPdfText(skiaStylePdf(SLIP, { type3: true })).lines[0], 'Jane Example', 'a Type 3 font reads as words, not letter by letter');
  checkFigures(readPayslip(skiaStylePdf(SLIP, { type3: true })), 'Type 3 font');

  // A layout this reader cannot pair up (every figure drawn before its label) is not
  // taken on trust: the amount paid is still read, and the page is told to check it
  const scrambled = readPayslip(skiaStylePdf(SLIP, { figureOn: 'before' }));
  assert.deepStrictEqual([scrambled.payment, scrambled.adds_up], [2010.44, false]);

  // Printed from a browser, the page gains a header that repeats the document's title:
  // still one payslip, and the header is no part of the name
  const header = ['26/11/2026, 16:46\tJane Example - Payslip for Month Ending 30 Nov 2026', 'https://payroll.example.com/payslips/view\t1/1'];
  checkFigures(readPayslip(skiaStylePdf(SLIP, { after: header })), 'browser header after the page');
  checkFigures(readPayslip(skiaStylePdf(SLIP, { before: header })), 'browser header before the page');

  // Names: letters a font joins into one character ("fi", "ffi"), and a double-barrelled
  // name split at its hyphen
  const joined = JSON.parse(JSON.stringify(SLIP)); joined.name = 'Soﬁa Griﬃn';
  assert.strictEqual(readPayslip(skiaStylePdf(joined)).name, 'Sofia Griffin');
  const long = JSON.parse(JSON.stringify(SLIP)); long.name = 'Maximiliana Featherstonehaugh-\nCholmondeley Example';
  assert.strictEqual(readPayslip(skiaStylePdf(long)).name, 'Maximiliana Featherstonehaugh-Cholmondeley Example');

  // A postgraduate loan row that says there is none
  for (const [value, has] of [['—', false], ['None', false], ['No', false], ['Yes', true]]) {
    const pg = JSON.parse(JSON.stringify(SLIP)); pg.boxes[0][1].splice(4, 0, ['Postgraduate Loan', value]);
    const r = readPayslip(skiaStylePdf(pg));
    assert.strictEqual(r.postgrad_loan, has, `Postgraduate Loan: ${value}`); assert.deepStrictEqual(r.student_loan_plans, ['2']); assert.strictEqual(r.tax_code, '1257L');
  }
  // Something that is not a tax code beside "Tax code" is not taken for one
  const noCode = JSON.parse(JSON.stringify(SLIP)); noCode.boxes[0][1][0] = ['Tax code', ''];
  assert.strictEqual(readPayslip(skiaStylePdf(noCode)).tax_code, '');
  for (const [printed, code, basis] of [['1257L', '1257L', 'cumulative'], ['1257L X', '1257L', 'month1'], ['1257LM1', '1257L', 'month1'], ['S1257L', 'S1257L', 'cumulative'], ['BR', 'BR', 'cumulative'],
    ['0T W1/M1', '0T', 'month1'], ['K475X', 'K475', 'month1'], ['D0', 'D0', 'cumulative'], ['NT', 'NT', 'cumulative'], ['1257M', '1257M', 'cumulative'], ['C1257L (Month 1)', 'C1257L', 'month1']]) {
    const t = JSON.parse(JSON.stringify(SLIP)); t.boxes[0][1][0] = ['Tax code', printed];
    const r = readPayslip(skiaStylePdf(t));
    assert.strictEqual(r.tax_code, code, `tax code printed as ${printed}`); assert.strictEqual(r.tax_basis, basis, `basis of ${printed}`);
  }

  // A box whose lines do not come to the total printed under them is flagged, even when
  // the totals themselves agree with the amount paid
  const lines = JSON.parse(JSON.stringify(SLIP)); lines.boxes[2][1][3] = ['NEST', '£89.20'];
  const off = readPayslip(skiaStylePdf(lines));
  assert.strictEqual(off.payment, 2010.44); assert.strictEqual(off.adds_up, false); assert.ok(off.problems.some(p => /do not add up/.test(p)));

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

  // The month written as figures, day first
  const figuresDate = JSON.parse(JSON.stringify(SLIP)); figuresDate.heading = 'Payslip for Month Ending 31/10/2026';
  assert.deepStrictEqual(readPayslip(skiaStylePdf(figuresDate)).period, { year: 2026, month: 10, end: '2026-10-31' });

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
  // (money back is written many ways)
  for (const refund of ['-£52.40', '\u2212£52.40', '\u2013£52.40', '(£52.40)', '£52.40-', '£52.40 CR', '£-52.40', '- £52.40', '-52.40']) assert.strictEqual(money(refund), -52.4, refund);
  assert.strictEqual(money('£52.40 DR'), null); assert.strictEqual(money('QQ 12 34 56 C'), null);
  // A tax refund set far from its label or hard against it, however it is written
  for (const refund of ['-£52.40', '\u2013£52.40', '(£52.40)', '£52.40-', '£52.40 CR', '-52.40']) {
    for (const figureOn of ['first', 'close']) {
      const back = JSON.parse(JSON.stringify(SLIP));
      back.boxes[2][1] = [['Tax', refund], ['National Insurance', '£176.16'], ['NEST', '£79.20'], ['Total', '£202.96']];
      back.boxes[5][1] = [['£2,297.04', ''], ['Paid on 30/11/2026', '']];
      const r = readPayslip(skiaStylePdf(back, { figureOn }));
      assert.deepStrictEqual([r.tax, r.ni, r.pension, r.other_deductions, r.payment, r.adds_up], [-52.4, 176.16, 79.2, null, 2297.04, true], `a refund written ${refund}, figure ${figureOn}`);
    }
  }

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

  // Names that do not come apart into plain letters, joined-up letters, and other scripts
  assert.strictEqual(nameKey('\u0141ukasz \u017b\u00f3\u0142\u0107'), 'lukasz zolc');
  assert.strictEqual(nameKey('S\u00f8ren Wei\u00df'), 'soren weiss');
  assert.strictEqual(nameKey('Sofia Gri\ufb03n'), 'sofia griffin');
  assert.strictEqual(nameKey('\u674e \u96f7'), '\u674e \u96f7');
  assert.deepStrictEqual(matchPerson('\u0141ukasz \u017b\u00f3\u0142\u0107', [{ id: 1, name: 'Lukasz Zolc' }]), { id: 1, sure: true });

  // On the upload page a wrong answer would file one person's payslip where another can
  // open it, so only a plain case is taken as certain
  const staff = [{ id: 4, name: 'Alex Stone', active: false }, { id: 5, name: 'Alex Stone-Hart', active: true }, { id: 7, name: 'Pat Lee', active: true }, { id: 9, name: 'Chris New', active: true }];
  assert.deepStrictEqual(whosePayslip('Alex Stone', staff), { id: 4, sure: true }, 'the exact name wins, even a leaver over someone current with a longer name');
  assert.deepStrictEqual(whosePayslip('Alex Stone-Hart', staff), { id: 5, sure: true });
  assert.deepStrictEqual(whosePayslip('Patricia Lee', staff, 7), { id: 7, sure: true }, 'a name filed under someone before is remembered');
  assert.deepStrictEqual(whosePayslip('Chris New', staff, 7), { id: null, candidates: [9, 7] }, 'remembered for one person, but somebody else now has exactly that name: ask');
  assert.deepStrictEqual(whosePayslip('Chris New', staff, 9), { id: 9, sure: true });
  assert.deepStrictEqual(whosePayslip('Chris New', staff, 99), { id: 9, sure: true }, 'a remembered person who is no longer on payroll is ignored');
  assert.deepStrictEqual(whosePayslip('Nobody Here', staff), { id: null, candidates: [] });
  assert.deepStrictEqual(whosePayslip('', staff, 7), { id: null, candidates: [] });
  // Two people of the same name: the one still here is suggested, never assumed; memory settles it
  const namesakes = [{ id: 1, name: 'Pat Lee', active: true }, { id: 2, name: 'Pat Lee', active: false }];
  assert.deepStrictEqual(whosePayslip('Pat Lee', namesakes), { id: 1, sure: false, candidates: [1, 2] });
  assert.deepStrictEqual(whosePayslip('Pat Lee', namesakes, 2), { id: 2, sure: true });
  assert.deepStrictEqual(whosePayslip('Pat Lee', namesakes.map(p => ({ ...p, active: true }))), { id: null, candidates: [1, 2] });
  // A longer name that fits two people, one of whom has left
  assert.deepStrictEqual(whosePayslip('Sam Lee Carter Jones', [{ id: 1, name: 'Sam Lee', active: true }, { id: 2, name: 'Sam Lee Carter', active: false }]), { id: 1, sure: false, candidates: [1, 2] });

  console.log('payslip reading tests passed');
})().catch(e => { console.error(e); process.exit(1); });

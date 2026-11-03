'use strict';
// The completed new starter form as a PDF for the accountant, in the LPGP document style:
// the employee's details on the cover, then their tax statement, student loan answers,
// bank details and signed declaration.

const { rgb } = require('pdf-lib');
const { createBrandDoc, COMPANY } = require('./brand-pdf');
const { STARTER_FORM, shown } = require('./starter-form');

const FOOTER = 'This form contains personal and financial information about the employee named herein, provided for payroll purposes only. It is confidential and must not be shared beyond those who process payroll for the Company. If you have received it in error, please notify the sender immediately and delete all copies.';

const ukDate = iso => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)
  ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : (iso || ''));

/** `a`: answers from checkAnswers(); `meta`: employee name, signed name, date, and the drawn signature. */
async function renderStarterPdf(a, { employeeName, signedName, signedAt, signaturePng, employer = COMPANY.name }) {
  const d = await createBrandDoc({ footerNote: FOOTER });
  const { fonts, text, wrap, BLUE, MUTED } = d;
  const val = (f) => {
    const v = a[f.key];
    if (f.type === 'date') return ukDate(v);
    if (f.type === 'checkboxes') return (v || []).join(', ');
    if (f.key === 'ni_number' && a.no_ni === 'Yes') return 'Not issued yet';
    return v;
  };

  // ── Cover: who this is, for payroll ──
  const cover = d.coverPage();
  text(cover, 'NEW STARTER FORM', 57, 158, { font: fonts.sansBold, size: 28 });
  text(cover, `${employeeName} · for payroll`, 58, 192, { font: fonts.mono, size: 14.4 });
  const about = STARTER_FORM[0].fields;
  // Name in one block; the employee statement is on the next page with its wording
  const fullName = [a.first_names, a.last_name].filter(Boolean).join(' ');
  const cells = [['Employer', employer], ['Full name', fullName || '\u2014'],
    ...about.filter(f => !['first_names', 'last_name', 'no_ni'].includes(f.key) && (f.key !== 'gender' || a.gender)).map(f => [f.label, val(f) || '\u2014'])];
  cells.forEach(([label, value], i) => {
    const x = i % 2 ? 307 : 68, top = 250 + Math.floor(i / 2) * 76;
    text(cover, label.toUpperCase(), x, top, { font: fonts.mono, size: 9.6, color: BLUE });
    wrap(value, fonts.sansSemi, 11.6, 210).slice(0, 4).forEach((l, k) => text(cover, l, x, top + 15.5 + k * 16.5, { font: fonts.sansSemi, size: 11.6 }));
  });

  // ── The answers ──
  const f = d.flow(d.plainPage());
  const statement = STARTER_FORM[1].fields[0];
  f.heading('1. Employee statement');
  for (const o of statement.options) {
    const chosen = a.statement === o.value;
    f.need(30);
    // A ticked or empty box beside each statement, as on HMRC's checklist
    const page = f.page, y = d.H - f.y - 10;
    page.drawRectangle({ x: 60, y, width: 10, height: 10, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 0.8, color: chosen ? BLUE : undefined });
    if (chosen) page.drawLine({ start: { x: 62, y: y + 5 }, end: { x: 64.5, y: y + 2.5 }, thickness: 1.4, color: rgb(1, 1, 1) }), page.drawLine({ start: { x: 64.5, y: y + 2.5 }, end: { x: 68.5, y: y + 8 }, thickness: 1.4, color: rgb(1, 1, 1) });
    f.para(`${o.label}${chosen ? ' (applies)' : ''}`, { font: chosen ? fonts.sansSemi : fonts.sans, gap: 2, indent: 20 });
    f.para(o.text, { gap: 10, indent: 20, color: chosen ? d.INK : MUTED });
  }

  f.heading('2. Student and postgraduate loans');
  for (const q of STARTER_FORM[2].fields) {
    if (!shown(q, a)) continue;
    f.para(q.label, { gap: 1, color: MUTED, size: 9.4 });
    f.para(val(q) || '—', { font: fonts.sansSemi, gap: 10 });
  }

  f.heading('3. Bank details');
  for (const q of STARTER_FORM[3].fields) {
    f.para(q.label, { gap: 1, color: MUTED, size: 9.4 });
    f.para(val(q) || '—', { font: fonts.sansSemi, gap: 10 });
  }

  f.heading('4. Declaration');
  f.para('I confirm that the information I have given on this form is correct.', { gap: 18 });
  f.need(90);
  const top = f.y, page = f.page;
  const row = (label, value, k) => {
    text(page, label, 60, top + k * 12, { font: fonts.sans, size: 8 });
    text(page, value, 60 + fonts.sans.widthOfTextAtSize(label, 8) + 3, top + k * 12, { font: fonts.sansSemi, size: 8 });
  };
  row('Signed by:', signedName, 0);
  row('Date:', ukDate(new Date(signedAt || Date.now()).toISOString().slice(0, 10)), 1);
  text(page, 'Signature:', 60, top + 24, { font: fonts.sans, size: 8 });
  const m = String(signaturePng || '').match(/^data:image\/png;base64,(.+)$/);
  if (m) {
    try {
      const png = await d.pdf.embedPng(Buffer.from(m[1], 'base64'));
      const h = 44, w = Math.min(150, png.width * (h / png.height));
      page.drawImage(png, { x: 94, y: d.H - (top + 24 + h), width: w, height: h });
    } catch { /* an unreadable drawing leaves the line blank; the typed name still stands */ }
  }
  return d.pdf.save();
}

module.exports = { renderStarterPdf };

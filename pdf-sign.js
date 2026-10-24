'use strict';
// PDF work for onboarding: read the fillable fields of a starter sheet, fill them in,
// turn a photo into a PDF, and stamp a signature page onto a finished document.
// Originals are never edited in place; every function returns new bytes.

const crypto = require('crypto');
const {
  PDFDocument, StandardFonts, rgb, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList,
} = require('pdf-lib');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Keep only characters the built-in PDF font can draw, so a stray emoji can't break filling
function safeText(font, text) {
  const ok = new Set(font.getCharacterSet());
  return Array.from(String(text == null ? '' : text)).map(c => (ok.has(c.codePointAt(0)) ? c : (c === '\n' ? '\n' : '?'))).join('');
}

// Which page (0-based) each widget sits on
function pageIndexOf(pdfDoc, widget) {
  const pages = pdfDoc.getPages();
  const ref = widget.P && widget.P();
  if (ref) {
    const i = pages.findIndex(p => p.ref === ref);
    if (i >= 0) return i;
  }
  // Some files omit /P on the widget; find the page whose annotations list it
  for (let i = 0; i < pages.length; i++) {
    const annots = pages[i].node.Annots();
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k++) {
      if (pdfDoc.context.lookup(annots.get(k)) === widget.dict) return i;
    }
  }
  return 0;
}

/**
 * The fillable fields of a PDF with where each one sits, in PDF points from the
 * top-left of its page, so a browser can lay inputs over a rendering of the page.
 * `fillable` is false for a flat PDF with no form fields.
 */
async function readFormFields(bytes) {
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages().map(p => { const { width, height } = p.getSize(); return { width, height }; });
  const out = [];
  let form;
  try { form = pdfDoc.getForm(); } catch { return { pages, fields: [], fillable: false }; }
  for (const field of form.getFields()) {
    let type = null;
    if (field instanceof PDFTextField) type = 'text';
    else if (field instanceof PDFCheckBox) type = 'checkbox';
    else if (field instanceof PDFRadioGroup) type = 'radio';
    else if (field instanceof PDFDropdown) type = 'dropdown';
    else if (field instanceof PDFOptionList) type = 'dropdown';
    if (!type) continue; // buttons, signatures: not for the person to fill
    const widgets = field.acroField.getWidgets().map((w, i) => {
      const r = w.getRectangle();
      const page = pageIndexOf(pdfDoc, w);
      return { page, x: r.x, y: pages[page].height - r.y - r.height, w: r.width, h: r.height, index: i };
    });
    if (!widgets.length) continue;
    const info = { name: field.getName(), type, readOnly: field.isReadOnly(), required: field.isRequired(), widgets };
    if (type === 'text') {
      info.multiline = field.isMultiline();
      const max = field.getMaxLength();
      if (max) info.maxLength = max;
    }
    if (type === 'radio' || type === 'dropdown') info.options = field.getOptions();
    out.push(info);
  }
  return { pages, fields: out, fillable: out.some(f => !f.readOnly) };
}

/**
 * Fill a form from {fieldName: value} and flatten it so the answers are part of the page.
 * Unknown names are ignored; values are coerced to what each field type accepts.
 */
async function fillForm(bytes, values) {
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const form = pdfDoc.getForm();
  for (const field of form.getFields()) {
    const name = field.getName();
    if (!Object.prototype.hasOwnProperty.call(values || {}, name) || field.isReadOnly()) continue;
    const v = values[name];
    try {
      if (field instanceof PDFTextField) {
        const text = safeText(font, v).slice(0, field.getMaxLength() || 2000);
        field.setText(text || undefined);
      } else if (field instanceof PDFCheckBox) {
        if (v === true || v === 'true' || v === 'on' || v === 1) field.check(); else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (field.getOptions().includes(v)) field.select(v);
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        if (field.getOptions().includes(v)) field.select(v);
      }
    } catch { /* one odd field must not lose the rest of the answers */ }
  }
  try { form.updateFieldAppearances(font); } catch { /* keep going without regenerated appearances */ }
  try { form.flatten(); } catch { /* a few files cannot be flattened; the filled fields stay editable */ }
  return pdfDoc.save();
}

// A photo or scan as a one-page PDF (A4, scaled to fit)
async function imageToPdf(bytes, kind) {
  const pdfDoc = await PDFDocument.create();
  const img = kind === 'png' ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
  const W = 595.28, H = 841.89, margin = 28;
  const scale = Math.min((W - 2 * margin) / img.width, (H - 2 * margin) / img.height, 1);
  const w = img.width * scale, h = img.height * scale;
  const page = pdfDoc.addPage([W, H]);
  page.drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
  return pdfDoc.save();
}

// A line of text broken into lines that fit a width
function wrap(font, text, size, maxWidth) {
  const words = String(text).split(/\s+/), lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) { lines.push(line); line = word; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The original document followed by a signature page: who signed, their drawn
 * signature, when (UK time) and the SHA-256 of the document as it was when signed,
 * so the record shows what was agreed to.
 */
async function appendSignaturePage(bytes, { title, signerName, signaturePng, signedAt, company = 'LPGP' }) {
  const originalHash = sha256(bytes);
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage([595.28, 841.89]);
  const left = 56, width = 595.28 - 112;
  let y = 770;
  const text = (t, o = {}) => { page.drawText(safeText(font, t), { x: left, y, size: o.size || 11, font: o.bold ? bold : font, color: o.color || rgb(0.1, 0.1, 0.1) }); y -= (o.gap || (o.size || 11) + 8); };

  text('Electronic signature', { size: 22, bold: true, gap: 34 });
  text(title, { size: 14, bold: true, gap: 24 });
  text(`This page records that the person named below read and signed the document above on the ${company} staff portal.`, { size: 10, color: rgb(0.35, 0.35, 0.35), gap: 30 });

  text('Signed by', { size: 9, color: rgb(0.45, 0.45, 0.45), gap: 14 });
  text(signerName, { size: 16, bold: true, gap: 26 });

  text('Signature', { size: 9, color: rgb(0.45, 0.45, 0.45), gap: 8 });
  const boxH = 110;
  page.drawRectangle({ x: left, y: y - boxH, width: 260, height: boxH, borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 1 });
  if (signaturePng) {
    try {
      const png = await pdfDoc.embedPng(Buffer.from(String(signaturePng).replace(/^data:image\/png;base64,/, ''), 'base64'));
      const s = Math.min(240 / png.width, (boxH - 16) / png.height, 1);
      page.drawImage(png, { x: left + 10, y: y - boxH + 8, width: png.width * s, height: png.height * s });
    } catch { /* an unreadable signature image leaves the box empty; the typed name above still stands */ }
  }
  y -= boxH + 26;

  const when = new Date(signedAt || Date.now()).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/London' });
  text('Date and time (UK)', { size: 9, color: rgb(0.45, 0.45, 0.45), gap: 14 });
  text(when, { size: 13, gap: 30 });

  text('Document fingerprint (SHA-256) of the pages above', { size: 9, color: rgb(0.45, 0.45, 0.45), gap: 14 });
  for (const l of wrap(font, originalHash, 9, width)) text(l, { size: 9, gap: 13 });
  return pdfDoc.save();
}

module.exports = { readFormFields, fillForm, imageToPdf, appendSignaturePage, sha256 };

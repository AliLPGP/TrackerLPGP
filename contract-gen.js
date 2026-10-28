'use strict';
// Employment contracts made from a Word template: the {{fields}} are filled from the
// employee's record and what they entered at onboarding, and the document is laid out
// as a PDF here (serverless hosting has no Word or LibreOffice to convert it).
//
// The layout covers what contract templates use: the Title and Heading styles, bold,
// italic, underline, colour and size, numbered and bulleted lists, alignment, spacing,
// tabs, line and page breaks. Headers, footers, tables and images are not drawn
// (a table's text still appears, one cell after another).

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const BUILTIN_TEMPLATE_PATH = path.join(__dirname, 'assets', 'employment-contract-template.docx');
const BUILTIN_TEMPLATE_NAME = 'Employment contract template.docx';

// The fields a template can use. `admin` ones are set when the contract is sent;
// the rest come from the employee's record and onboarding when it is shown or signed.
const CONTRACT_FIELDS = [
  { key: 'employee_name', label: 'Employee name' },
  { key: 'employee_address', label: 'Home address (entered at onboarding)' },
  { key: 'date_of_birth', label: 'Date of birth (entered at onboarding)' },
  { key: 'job_title', label: 'Job title', admin: true },
  { key: 'employment_basis', label: 'Basis, e.g. permanent, full-time', admin: true },
  { key: 'working_pattern', label: 'Full-time or part-time', admin: true },
  { key: 'start_date', label: 'Start date', admin: true },
  { key: 'annual_salary', label: 'Annual salary', admin: true },
  { key: 'salary_effective_date', label: 'Salary effective from', admin: true },
  { key: 'holiday_days', label: 'Holiday days a year', admin: true },
  { key: 'holiday_terms', label: 'The holiday clause: paid holiday (payroll) or the holiday scheme (self-employed)' },
  { key: 'probation_section', label: 'Wrap the probation section in {{#probation_section}} ... {{/probation_section}}: it is left out for anyone not on probation' },
  { key: 'probation_heading', label: 'Probationary Period, or Confirmation of Employment once they have passed' },
  { key: 'probation_text', label: 'The probation clause, or the confirmation once they have passed' },
  { key: 'probation_end_date', label: 'Probation end date' },
  { key: 'today', label: "Today's date" },
  { key: 'signature', label: 'Their drawn signature (once signed)' },
  { key: 'signed_date', label: 'Date signed (once signed)' },
];
const KNOWN_TAGS = new Set(CONTRACT_FIELDS.map(f => f.key));
const SIGNATURE_MARK = '[[signature]]';

function builtinTemplate() {
  return fs.readFileSync(BUILTIN_TEMPLATE_PATH);
}

const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attr = (xml, tag, name) => {
  const m = xml.match(new RegExp('<w:' + tag + '\\b[^>]*\\bw:' + name + '="([^"]*)"'));
  return m ? m[1] : null;
};
// <w:b/> is on, <w:b w:val="0"/> or "false" is off
const flag = (xml, tag) => {
  const m = xml.match(new RegExp('<w:' + tag + '(?:\\s[^>]*)?/?>'));
  if (!m) return null;
  const v = (m[0].match(/w:val="([^"]*)"/) || [])[1];
  return !(v === '0' || v === 'false' || v === 'none');
};

/** The {{fields}} a template uses, and any it uses that we cannot fill. */
function templateTags(buf) {
  const zip = new PizZip(buf);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('That is not a Word document (.docx)');
  const text = (doc.asText().match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g) || []).map(t => decodeXml(t.replace(/<[^>]+>/g, ''))).join('');
  const tags = [...new Set((text.match(/\{\{\s*([a-z_]+)\s*\}\}/gi) || []).map(t => t.replace(/[{}\s]/g, '')))];
  return { tags, unknown: tags.filter(t => !KNOWN_TAGS.has(t)) };
}

/** The template with every {{field}} filled in; returns the docx zip. Unknown or empty fields come out blank. */
function fillTemplate(buf, data) {
  const doc = new Docxtemplater(new PizZip(buf), {
    delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true, nullGetter: () => '',
  });
  doc.render(data);
  return doc.getZip();
}

// ── Reading the parts of the document the layout needs ──

function readStyles(zip) {
  const xml = (zip.file('word/styles.xml') || { asText: () => '' }).asText();
  const defaults = (xml.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/) || [''])[0];
  const styles = {};
  for (const s of xml.match(/<w:style\b[\s\S]*?<\/w:style>/g) || []) {
    const id = (s.match(/w:styleId="([^"]*)"/) || [])[1];
    if (!id) continue;
    const pPr = (s.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    const rPr = (s.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    styles[id] = { basedOn: attr(s, 'basedOn', 'val'), pPr, rPr, heading: /<w:outlineLvl\b/.test(pPr) || /^(Heading\d|Title)$/.test(id) };
  }
  return { styles, defaults };
}

function readNumbering(zip) {
  const xml = (zip.file('word/numbering.xml') || { asText: () => '' }).asText();
  const abstract = {};
  for (const a of xml.match(/<w:abstractNum\b[\s\S]*?<\/w:abstractNum>/g) || []) {
    const id = (a.match(/w:abstractNumId="(\d+)"/) || [])[1];
    const levels = {};
    for (const l of a.match(/<w:lvl\b[\s\S]*?<\/w:lvl>/g) || []) {
      const ilvl = Number((l.match(/w:ilvl="(\d+)"/) || [])[1] || 0);
      levels[ilvl] = {
        fmt: attr(l, 'numFmt', 'val') || 'decimal',
        text: attr(l, 'lvlText', 'val') || '',
        start: Number(attr(l, 'start', 'val') || 1),
        left: Number(attr(l, 'ind', 'left') || attr(l, 'ind', 'start') || 0) / 20,
        hanging: Number(attr(l, 'ind', 'hanging') || 0) / 20,
      };
    }
    abstract[id] = levels;
  }
  const nums = {};
  for (const n of xml.match(/<w:num\b[\s\S]*?<\/w:num>/g) || []) {
    const id = (n.match(/w:numId="(\d+)"/) || [])[1];
    const abs = attr(n, 'abstractNumId', 'val');
    if (id && abstract[abs]) nums[id] = abstract[abs];
  }
  return nums;
}

const roman = n => {
  const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of t) while (n >= v) { out += s; n -= v; }
  return out;
};
const letter = n => { let s = ''; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };
function formatNumber(fmt, n) {
  switch (fmt) {
    case 'lowerLetter': return letter(n);
    case 'upperLetter': return letter(n).toUpperCase();
    case 'lowerRoman': return roman(n);
    case 'upperRoman': return roman(n).toUpperCase();
    default: return String(n);
  }
}
// Bullet glyphs the built-in PDF fonts can draw
function bulletChar(text) {
  if (text === 'o' || text === '○' || text === '◦') return 'o';
  if (text === '-' || text === '–') return '–';
  return '•';
}

// ── Layout ──

async function docxToPdf(zip, { signaturePng } = {}) {
  const pdf = await PDFDocument.create();
  const fonts = {
    serif: {
      r: await pdf.embedFont(StandardFonts.TimesRoman), b: await pdf.embedFont(StandardFonts.TimesRomanBold),
      i: await pdf.embedFont(StandardFonts.TimesRomanItalic), bi: await pdf.embedFont(StandardFonts.TimesRomanBoldItalic),
    },
    sans: {
      r: await pdf.embedFont(StandardFonts.Helvetica), b: await pdf.embedFont(StandardFonts.HelveticaBold),
      i: await pdf.embedFont(StandardFonts.HelveticaOblique), bi: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    },
  };
  const charset = new Set(fonts.serif.r.getCharacterSet());
  const safe = s => Array.from(s).map(c => (charset.has(c.codePointAt(0)) ? c : (c === ' ' ? ' ' : '?'))).join('');
  let sigImage = null;
  if (signaturePng) {
    try { sigImage = await pdf.embedPng(Buffer.from(String(signaturePng).replace(/^data:image\/png;base64,/, ''), 'base64')); } catch { sigImage = null; }
  }

  const docXml = zip.file('word/document.xml').asText();
  const { styles, defaults } = readStyles(zip);
  const numbering = readNumbering(zip);
  const sect = (docXml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g) || ['']).pop();
  const pageW = Number(attr(sect, 'pgSz', 'w') || 11906) / 20;
  const pageH = Number(attr(sect, 'pgSz', 'h') || 16838) / 20;
  const mTop = Number(attr(sect, 'pgMar', 'top') || 1440) / 20;
  const mBottom = Number(attr(sect, 'pgMar', 'bottom') || 1440) / 20;
  const mLeft = Number(attr(sect, 'pgMar', 'left') || 1440) / 20;
  const mRight = Number(attr(sect, 'pgMar', 'right') || 1440) / 20;
  const contentW = pageW - mLeft - mRight;

  const defaultFamily = /arial|helvetica|calibri|aptos|verdana|segoe|sans/i.test(attr(defaults, 'rFonts', 'ascii') || 'Times New Roman') ? 'sans' : 'serif';
  const defaultSize = Number(attr(defaults, 'sz', 'val') || 20) / 2;
  const defaultAfter = Number(attr(defaults, 'spacing', 'after') || 0) / 20;

  // Style properties, following basedOn
  const styleChain = id => {
    const out = [];
    for (let s = id, guard = 0; s && styles[s] && guard < 10; s = styles[s].basedOn, guard++) out.unshift(styles[s]);
    if (!id && styles.Normal) out.unshift(styles.Normal);
    return out;
  };
  const runProps = (xmlList) => {
    const p = { bold: false, italic: false, underline: false, size: defaultSize, color: null, family: defaultFamily };
    for (const x of xmlList) {
      if (!x) continue;
      const b = flag(x, 'b'); if (b !== null) p.bold = b;
      const i = flag(x, 'i'); if (i !== null) p.italic = i;
      const u = attr(x, 'u', 'val'); if (u) p.underline = u !== 'none';
      const sz = attr(x, 'sz', 'val'); if (sz) p.size = Number(sz) / 2;
      const c = attr(x, 'color', 'val'); if (c && c !== 'auto') p.color = c;
      const f = attr(x, 'rFonts', 'ascii'); if (f) p.family = /arial|helvetica|calibri|aptos|verdana|segoe|sans/i.test(f) ? 'sans' : 'serif';
    }
    return p;
  };
  const fontFor = p => fonts[p.family][p.bold && p.italic ? 'bi' : p.bold ? 'b' : p.italic ? 'i' : 'r'];
  const colorOf = hex => (hex && /^[0-9a-f]{6}$/i.test(hex)
    ? rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255)
    : rgb(0, 0, 0));

  let page = pdf.addPage([pageW, pageH]);
  let y = pageH - mTop;
  let atTop = true;
  const newPage = () => { page = pdf.addPage([pageW, pageH]); y = pageH - mTop; atTop = true; };
  const counters = {};

  const paragraphs = (docXml.match(/<w:body>[\s\S]*<\/w:body>/) || [''])[0]
    .match(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];

  for (const p of paragraphs) {
    const pPr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    const styleId = attr(pPr, 'pStyle', 'val');
    const chain = styleChain(styleId || 'Normal');
    const isHeading = chain.some(s => s.heading);
    const pick = (tag, name) => {
      let v = attr(pPr, tag, name);
      for (let k = chain.length - 1; v == null && k >= 0; k--) v = attr(chain[k].pPr, tag, name);
      return v;
    };
    const before = Number(pick('spacing', 'before') || 0) / 20;
    const afterRaw = pick('spacing', 'after');
    const after = afterRaw != null ? Number(afterRaw) / 20 : defaultAfter;
    const lineRule = pick('spacing', 'lineRule');
    const lineVal = Number(pick('spacing', 'line') || 240);
    const lineFactor = (!lineRule || lineRule === 'auto') ? lineVal / 240 : null;
    const jc = pick('jc', 'val') || 'left';
    const pRunXml = (pPr.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];

    // Numbering: label and indents
    let label = null, left = Number(pick('ind', 'left') || pick('ind', 'start') || 0) / 20, hanging = Number(pick('ind', 'hanging') || 0) / 20;
    const numId = attr(pPr, 'numId', 'val') || chain.map(s => attr(s.pPr, 'numId', 'val')).filter(Boolean).pop();
    if (numId && numId !== '0' && numbering[numId]) {
      const ilvl = Number(attr(pPr, 'ilvl', 'val') || 0);
      const lv = numbering[numId][ilvl] || numbering[numId][0];
      const c = counters[numId] = counters[numId] || {};
      c[ilvl] = (c[ilvl] == null ? lv.start - 1 : c[ilvl]) + 1;
      Object.keys(c).forEach(k => { if (Number(k) > ilvl) delete c[k]; });
      label = lv.fmt === 'bullet' ? bulletChar(lv.text)
        : lv.text.replace(/%(\d)/g, (_, d) => {
          const l = Number(d) - 1, lvl = numbering[numId][l] || lv;
          return formatNumber(lvl.fmt, c[l] == null ? lvl.start : c[l]);
        });
      if (!attr(pPr, 'ind', 'left') && !attr(pPr, 'ind', 'start')) { left = lv.left; hanging = lv.hanging; }
    }

    // Runs -> styled pieces of text
    const pieces = [];
    for (const r of p.match(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g) || []) {
      const rPr = (r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
      const props = runProps([...chain.map(s => s.rPr), rPr]);
      const body = r.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '');
      for (const tok of body.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>/g) || []) {
        if (tok.startsWith('<w:tab')) pieces.push({ text: '    ', props });
        else if (tok.startsWith('<w:br')) pieces.push({ brk: /w:type="page"/.test(tok) ? 'page' : 'line' });
        else if (tok.startsWith('<w:cr')) pieces.push({ brk: 'line' });
        else pieces.push({ text: decodeXml(tok.replace(/<[^>]+>/g, '')), props });
      }
    }
    const paraSize = pieces.find(x => x.props) ? pieces.find(x => x.props).props.size : runProps([...chain.map(s => s.rPr), pRunXml]).size; // an empty paragraph is as tall as its mark

    // Split into words (keeping spaces), the signature mark becomes an image
    const words = [];
    for (const pc of pieces) {
      if (pc.brk) { words.push({ brk: pc.brk }); continue; }
      const parts = pc.text.split(/(\[\[signature\]\]|\s+)/).filter(s => s !== '');
      for (const part of parts) {
        if (part === SIGNATURE_MARK) {
          const h = sigImage ? 34 : 0;
          const w = sigImage ? Math.min(160, sigImage.width * (h / sigImage.height)) : 0;
          if (w) words.push({ image: true, w, h, props: pc.props, space: false });
          continue;
        }
        const t = safe(part);
        const font = fontFor(pc.props);
        words.push({ text: t, font, props: pc.props, w: font.widthOfTextAtSize(t, pc.props.size), space: /^\s+$/.test(part) });
      }
    }

    // Lines
    const textLeft = mLeft + left;
    // A numbered line starts its text at the indent (the number hangs to its left);
    // otherwise the first line moves by any first-line or hanging indent
    const firstLeft = label ? textLeft : textLeft + Number(pick('ind', 'firstLine') || 0) / 20 - hanging;
    const lines = [];
    let line = [], lineW = 0;
    const maxW = (first) => contentW - left - (first ? firstLeft - textLeft : 0);
    const push = () => {
      while (line.length && line[line.length - 1].space) { lineW -= line.pop().w; }
      lines.push({ items: line, w: lineW });
      line = []; lineW = 0;
    };
    for (const wd of words) {
      if (wd.brk) { push(); if (wd.brk === 'page') lines.push({ page: true }); continue; }
      if (wd.space && !line.length) continue;
      if (!wd.space && line.length && lineW + wd.w > maxW(lines.length === 0)) push();
      line.push(wd); lineW += wd.w;
    }
    if (line.length || !lines.length) push();

    const lineHeight = it => {
      const tallest = Math.max(paraSize, ...it.items.filter(x => !x.image).map(x => x.props.size));
      const textH = lineFactor ? tallest * 1.15 * lineFactor : Math.max(tallest * 1.15, lineVal / 20);
      const img = Math.max(0, ...it.items.filter(x => x.image).map(x => x.h + 4));
      return Math.max(textH, img);
    };

    // Keep a heading with the start of what follows it
    const needed = (atTop ? 0 : before) + lines.slice(0, isHeading ? 1 : 2).reduce((s, l) => s + (l.page ? 0 : lineHeight(l)), 0) + (isHeading ? paraSize * 3 : 0);
    if (y - needed < mBottom && !atTop) newPage();
    if (!atTop) y -= before;

    lines.forEach((ln, idx) => {
      if (ln.page) { newPage(); return; }
      const lh = lineHeight(ln);
      if (y - lh < mBottom) newPage();
      const base = y - lh + (lh - paraSize * 1.15) / 2 + paraSize * 0.25;
      const startX = idx === 0 ? firstLeft : textLeft;
      const avail = contentW - (startX - mLeft);
      let x = jc === 'center' ? startX + (avail - ln.w) / 2 : jc === 'right' ? startX + avail - ln.w : startX;
      if (idx === 0 && label) {
        const lp = (ln.items.find(i => i.props) || {}).props || runProps(chain.map(s => s.rPr));
        page.drawText(safe(label), { x: textLeft - hanging, y: base, size: lp.size, font: fontFor({ ...lp, underline: false }), color: colorOf(lp.color) });
      }
      for (const it of ln.items) {
        if (it.image) {
          page.drawImage(sigImage, { x, y: base - 6, width: it.w, height: it.h });
        } else if (!it.space || it !== ln.items[ln.items.length - 1]) {
          page.drawText(it.text, { x, y: base, size: it.props.size, font: it.font, color: colorOf(it.props.color) });
          if (it.props.underline && !it.space) page.drawLine({ start: { x, y: base - 1.5 }, end: { x: x + it.w, y: base - 1.5 }, thickness: 0.6, color: colorOf(it.props.color) });
        }
        x += it.w;
      }
      y -= lh;
      atTop = false;
    });
    y -= after;
  }
  return pdf.save();
}

/** Fill a template and lay it out: the PDF someone reads and signs. */
async function renderContract(templateBuf, data, opts = {}) {
  const zip = fillTemplate(templateBuf, { ...data, signature: opts.signaturePng ? SIGNATURE_MARK : '' });
  return docxToPdf(zip, opts);
}

module.exports = { CONTRACT_FIELDS, BUILTIN_TEMPLATE_NAME, builtinTemplate, templateTags, fillTemplate, renderContract };

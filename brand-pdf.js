'use strict';
// The LPGP document style, for PDFs the app makes (employment contracts, the starter form):
// a black cover band with the logo, a light header on later pages, numbered blue section
// headings in Geist Mono, body text in Geist, and the contact footer with the three bars.
// Measurements follow the LPGP contract design (A4, points from the top-left).

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const A4 = [595.5, 842.25];
const W = A4[0], H = A4[1];
const MARGIN_L = 60, MARGIN_R = 60;
const BODY_TOP = 100;        // first line of body text on a page with the light header
const BODY_BOTTOM = 700;     // body text stops above the footer
const BLUE = rgb(31 / 255, 63 / 255, 235 / 255);
const INK = rgb(0.07, 0.07, 0.07);
const MUTED = rgb(0.38, 0.38, 0.38);

const asset = (...p) => path.join(__dirname, 'assets', ...p);
const COMPANY = {
  name: 'LPGPCONNECT.COM LTD',
  address: 'Surbiton, England KT9 1BD, United Kingdom',
  phone: '+44 203 044 2790',
  email: 'info@lpgpconnect.com',
  web: 'www.lpgpconnect.com',
};

async function createBrandDoc({ footerNote }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = async f => pdf.embedFont(fs.readFileSync(asset('fonts', f)), { subset: true });
  const fonts = {
    sans: await font('Geist-Regular.ttf'), sansMedium: await font('Geist-Medium.ttf'),
    sansSemi: await font('Geist-SemiBold.ttf'), sansBold: await font('Geist-Bold.ttf'),
    mono: await font('GeistMono-Regular.ttf'), monoMedium: await font('GeistMono-Medium.ttf'), monoSemi: await font('GeistMono-SemiBold.ttf'),
  };
  const png = async f => pdf.embedPng(fs.readFileSync(asset('brand', f)));
  const img = { logoDark: await png('logo-dark.png'), logoLight: await png('logo-light.png'),
    phone: await png('ic-phone.png'), mail: await png('ic-mail.png'), web: await png('ic-web.png') };

  // Characters the fonts cannot draw become '?', so unusual input never breaks a document
  const charset = new Set(fonts.sans.getCharacterSet());
  const clean = s => Array.from(String(s == null ? '' : s)).map(c => (c === '\n' || charset.has(c.codePointAt(0)) ? c : (c === ' ' ? ' ' : '?'))).join('');

  // Text helpers, with y measured from the top of the page
  const text = (page, s, x, top, { font = fonts.sans, size = 9, color = INK, align = 'left', width } = {}) => {
    const t = clean(s);
    let dx = x;
    if (align !== 'left') { const w = font.widthOfTextAtSize(t, size); dx = align === 'center' ? x + (width - w) / 2 : x + width - w; }
    page.drawText(t, { x: dx, y: H - top - size * 0.78, size, font, color });
  };
  const wrap = (s, font, size, width) => {
    const out = [];
    for (const raw of clean(s).split('\n')) {
      let line = '';
      for (const word of raw.split(/\s+/).filter(Boolean)) {
        const t = line ? line + ' ' + word : word;
        if (line && font.widthOfTextAtSize(t, size) > width) { out.push(line); line = word; } else line = t;
      }
      out.push(line);
    }
    return out;
  };

  // The cover's contact line is in Geist Mono, later pages' in Geist, as in the design
  function footer(page, cover) {
    const note = wrap(footerNote, fonts.sans, 7.1, W - 120);
    note.forEach((l, i) => text(page, l, 60, 719 + i * 11.2, { size: 7.1, color: MUTED, align: 'center', width: W - 120 }));
    const row = 776, items = [[img.phone, COMPANY.phone, 58], [img.mail, COMPANY.email, 216], [img.web, COMPANY.web, 401]];
    for (const [ic, label, x] of items) {
      page.drawImage(ic, { x, y: H - row - 17, width: 17 * ic.width / ic.height, height: 17 });
      text(page, label, x + 24, row + (cover ? 4.2 : 3.4), cover ? { font: fonts.mono, size: 9.2 } : { font: fonts.sans, size: 10.6 });
    }
    for (const x of [193, 380]) page.drawLine({ start: { x, y: H - 768 }, end: { x, y: H - 794 }, thickness: 0.7, color: rgb(0.2, 0.2, 0.2) });
    page.drawRectangle({ x: 0, y: 0, width: 381, height: 24, color: rgb(0, 0, 0) });
    page.drawRectangle({ x: 381, y: 0, width: 124.4, height: 24, color: rgb(38 / 255, 38 / 255, 38 / 255) });
    page.drawRectangle({ x: 505.4, y: 0, width: W - 505.4, height: 24, color: rgb(102 / 255, 102 / 255, 102 / 255) });
  }

  // The first page: black band with the white logo
  function coverPage() {
    const page = pdf.addPage(A4);
    page.drawRectangle({ x: 12, y: H - 95.3, width: W - 24, height: 95.3 - 15.6, color: rgb(0, 0, 0) });
    const lh = 34, lw = img.logoLight.width * (lh / img.logoLight.height);
    page.drawImage(img.logoLight, { x: 59, y: H - 72.5, width: lw, height: lh });
    text(page, COMPANY.web, 0, 47, { font: fonts.mono, size: 13.6, color: rgb(1, 1, 1), align: 'right', width: W - 58 });
    footer(page, true);
    return page;
  }

  // Every later page: the logo on white
  function plainPage() {
    const page = pdf.addPage(A4);
    const lh = 34, lw = img.logoDark.width * (lh / img.logoDark.height);
    page.drawImage(img.logoDark, { x: 59, y: H - 72, width: lw, height: lh });
    text(page, COMPANY.web, 0, 46, { font: fonts.mono, size: 13.6, align: 'right', width: W - 58 });
    footer(page);
    return page;
  }

  // Running body text that moves on to a new page when it reaches the footer
  function flow(startPage, top = BODY_TOP) {
    const f = { page: startPage, y: top };
    f.need = h => { if (f.y + h > BODY_BOTTOM) { f.page = plainPage(); f.y = BODY_TOP; } };
    f.heading = (s) => {
      f.need(40);
      text(f.page, s.toUpperCase(), MARGIN_L, f.y, { font: fonts.monoSemi, size: 10.4, color: BLUE });
      f.y += 21;
    };
    f.para = (s, { size = 10.2, gap = 13, font = fonts.sans, lead = 1.42, color = INK, indent = 0 } = {}) => {
      const lines = wrap(s, font, size, W - MARGIN_L - MARGIN_R - indent);
      lines.forEach(l => { f.need(size * lead); text(f.page, l, MARGIN_L + indent, f.y, { font, size, color }); f.y += size * lead; });
      f.y += gap;
    };
    return f;
  }

  return { pdf, fonts, img, text, wrap, clean, coverPage, plainPage, flow, BLUE, INK, MUTED, W, H, MARGIN_L, MARGIN_R };
}

module.exports = { createBrandDoc, COMPANY };

// The invoice preview shows the Terms & Conditions word for word; this fails
// if invoice_template.docx changes and the preview in app.js is not updated.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const root = path.join(__dirname, '..');
const xml = new PizZip(fs.readFileSync(path.join(root, 'public/invoice_template.docx'))).file('word/document.xml').asText();
const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const norm = s => decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const paras = (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [])
  .map(p => norm((p.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) || []).map(t => t.replace(/<\/?w:t[^>]*>/g, '')).join('')));
const start = paras.findIndex(t => /Terms & Conditions/.test(t));
const end = paras.findIndex((t, i) => i > start && t.includes('{{client_name}}'));
assert.ok(start >= 0 && end > start, 'terms found in the template');
// Paragraphs the template splits mid-sentence are joined so they match the preview's prose
const terms = paras.slice(start + 1, end).filter(Boolean).join(' ');

const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const block = app.slice(app.indexOf('<ol class="ig-tc">'), app.indexOf('</ol>', app.indexOf('<ol class="ig-tc">')));
const preview = norm(block.replace(/<span>3\.\d\)<\/span>/g, ''));
assert.strictEqual(preview, terms);
console.log('invoice terms tests passed');

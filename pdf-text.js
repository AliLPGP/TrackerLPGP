'use strict';
// Reads the text out of a PDF, in the order it was written to the page, using nothing
// but Node's own zlib. It exists to read payslips (payslip-read.js), so it covers what
// payroll software produces: text drawn with ordinary or embedded (subset) fonts, in
// one or more compressed content streams. It never runs anything found in the file,
// and a file it cannot make sense of gives back no text rather than an error.
//
//   readPdfText(buffer) -> { ok, title, pages: [{ lines: [string] }], lines: [string], error? }
//
// A "line" is the text drawn on one baseline, left to right as it was written. Pieces
// set well apart on the same baseline (a label and its figure) are joined with a tab.

const zlib = require('zlib');

const MAX_OBJECTS = 20000;
const MAX_STREAM = 32 * 1024 * 1024;   // no decompressed stream may be bigger than this
const MAX_DEPTH = 8;                   // forms inside forms, page-tree levels
const MAX_OPS = 2000000;               // drawing instructions read from one page

// ─── PDF syntax ──────────────────────────────────────────────────────────────
const isWs = c => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = c => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

class Name { constructor(n) { this.name = n; } }
class Ref { constructor(n) { this.ref = n; } }
class Str { constructor(bytes) { this.bytes = bytes; } }   // bytes as a latin1 string
class Op { constructor(op) { this.op = op; } }

// One value at a time out of a latin1 string (a whole file, or one stream)
class Lexer {
  constructor(s, at = 0) { this.s = s; this.i = at; }
  skip() {
    const s = this.s;
    for (;;) {
      const c = s.charCodeAt(this.i);
      if (isWs(c)) this.i++;
      else if (c === 37) { while (this.i < s.length && s.charCodeAt(this.i) !== 10 && s.charCodeAt(this.i) !== 13) this.i++; }
      else break;
    }
  }
  atEnd() { this.skip(); return this.i >= this.s.length; }
  // A value, or an Op for a bare word (an operator or keyword), or undefined at the end
  next(depth = 0) {
    this.skip();
    const s = this.s;
    if (this.i >= s.length) return undefined;
    if (depth > 64) throw new Error('nested too deeply');
    const c = s.charCodeAt(this.i);
    if (c === 47) return this.name();
    if (c === 40) return this.literal();
    if (c === 60) {
      if (s.charCodeAt(this.i + 1) === 60) return this.dict(depth);
      return this.hex();
    }
    if (c === 91) {
      this.i++;
      const out = [];
      for (;;) {
        this.skip();
        if (this.i >= s.length) break;
        if (s.charCodeAt(this.i) === 93) { this.i++; break; }
        const v = this.next(depth + 1);
        if (v === undefined) break;
        out.push(v);
      }
      return out;
    }
    if (c === 93 || c === 62 || c === 41 || c === 123 || c === 125) { this.i++; return new Op(s[this.i - 1]); }   // stray closer
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      const m = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(s.slice(this.i, this.i + 40));
      if (m) {
        this.i += m[0].length;
        const num = parseFloat(m[0]);
        // "12 0 R" is a reference to object 12
        if (/^\d+$/.test(m[0])) {
          const r = /^[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+R(?![A-Za-z0-9])/.exec(s.slice(this.i, this.i + 30));
          if (r) { this.i += r[0].length; return new Ref(num); }
        }
        return num;
      }
    }
    // A bare word
    const from = this.i;
    while (this.i < s.length) { const d = s.charCodeAt(this.i); if (isWs(d) || isDelim(d)) break; this.i++; }
    if (this.i === from) { this.i++; return new Op(s[from]); }
    const w = s.slice(from, this.i);
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return new Op(w);
  }
  name() {
    const s = this.s;
    const from = ++this.i;
    while (this.i < s.length) { const d = s.charCodeAt(this.i); if (isWs(d) || isDelim(d)) break; this.i++; }
    return new Name(s.slice(from, this.i).replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  }
  literal() {
    const s = this.s;
    let out = '', depth = 1;
    this.i++;
    while (this.i < s.length) {
      const ch = s[this.i++];
      if (ch === '\\') {
        const e = s[this.i++];
        if (e === 'n') out += '\n'; else if (e === 'r') out += '\r'; else if (e === 't') out += '\t';
        else if (e === 'b') out += '\b'; else if (e === 'f') out += '\f';
        else if (e >= '0' && e <= '7') {
          let oct = e;
          for (let k = 0; k < 2 && s[this.i] >= '0' && s[this.i] <= '7'; k++) oct += s[this.i++];
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else if (e === '\r') { if (s[this.i] === '\n') this.i++; }
        else if (e === '\n') { /* line continuation */ }
        else if (e !== undefined) out += e;
      } else if (ch === '(') { depth++; out += ch; }
      else if (ch === ')') { if (--depth === 0) break; out += ch; }
      else out += ch;
    }
    return new Str(out);
  }
  hex() {
    const s = this.s;
    const end = s.indexOf('>', this.i);
    const body = (end < 0 ? s.slice(this.i + 1) : s.slice(this.i + 1, end)).replace(/[^0-9A-Fa-f]/g, '');
    this.i = end < 0 ? s.length : end + 1;
    let out = '';
    for (let k = 0; k < body.length; k += 2) out += String.fromCharCode(parseInt((body + '0').slice(k, k + 2), 16));
    return new Str(out);
  }
  dict(depth) {
    const s = this.s;
    this.i += 2;
    const out = {};
    for (;;) {
      this.skip();
      if (this.i >= s.length) break;
      if (s.charCodeAt(this.i) === 62 && s.charCodeAt(this.i + 1) === 62) { this.i += 2; break; }
      const k = this.next(depth + 1);
      if (!(k instanceof Name)) { if (k === undefined) break; continue; }   // not a key: skip it
      this.skip();
      if (s.charCodeAt(this.i) === 62 && s.charCodeAt(this.i + 1) === 62) { this.i += 2; break; }
      const v = this.next(depth + 1);
      if (v === undefined) break;
      out[k.name] = v;
    }
    return out;
  }
}

// ─── Streams ─────────────────────────────────────────────────────────────────
function inflate(bytes) {
  const opts = { maxOutputLength: MAX_STREAM };
  try { return zlib.inflateSync(bytes, opts); } catch (e) { /* try the forgiving ways */ }
  try { return zlib.inflateSync(bytes, { ...opts, finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (e) { /* next */ }
  try { return zlib.inflateRawSync(bytes, { ...opts, finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (e) { return null; }
}

// PNG and TIFF predictors (used on cross-reference and object streams)
function unpredict(data, parms) {
  const predictor = num(parms && parms.Predictor, 1);
  if (predictor < 2) return data;
  const colors = num(parms.Colors, 1), bpc = num(parms.BitsPerComponent, 8), columns = num(parms.Columns, 1);
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8)), rowLen = Math.ceil(colors * bpc * columns / 8);
  if (!(rowLen > 0) || rowLen > 1 << 20) return data;
  if (predictor === 2) {
    const out = Buffer.from(data);
    for (let r = 0; r + rowLen <= out.length; r += rowLen) for (let k = bpp; k < rowLen; k++) out[r + k] = (out[r + k] + out[r + k - bpp]) & 255;
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)], src = r * (rowLen + 1) + 1, dst = r * rowLen;
    for (let k = 0; k < rowLen; k++) {
      const x = data[src + k];
      const a = k >= bpp ? out[dst + k - bpp] : 0, b = r > 0 ? out[dst - rowLen + k] : 0, c = r > 0 && k >= bpp ? out[dst - rowLen + k - bpp] : 0;
      let v = x;
      if (type === 1) v = x + a; else if (type === 2) v = x + b; else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[dst + k] = v & 255;
    }
  }
  return out;
}

function ascii85(bytes) {
  const s = bytes.toString('latin1').replace(/[\x00\t\n\f\r ]/g, '').replace(/^<~/, '').replace(/~>[\s\S]*$/, '');
  const out = [];
  for (let i = 0; i < s.length;) {
    if (s[i] === 'z') { out.push(0, 0, 0, 0); i++; continue; }
    const chunk = s.slice(i, i + 5); i += 5;
    const pad = 5 - chunk.length;
    let v = 0;
    for (let k = 0; k < 5; k++) v = v * 85 + ((k < chunk.length ? chunk.charCodeAt(k) : 117) - 33);
    const four = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...four.slice(0, 4 - pad));
  }
  return Buffer.from(out);
}

// The decoded bytes of a stream object, or null when it uses something this reader does not do
function streamBytes(doc, obj) {
  if (!obj || !obj.stream) return null;
  if (obj.decoded !== undefined) return obj.decoded;
  let data = obj.stream;
  const dict = obj.value || {};
  let filters = doc.get(dict.Filter), parms = doc.get(dict.DecodeParms);
  filters = filters == null ? [] : Array.isArray(filters) ? filters : [filters];
  parms = parms == null ? [] : Array.isArray(parms) ? parms : [parms];
  for (let i = 0; i < filters.length && data; i++) {
    const f = filters[i] instanceof Name ? filters[i].name : '';
    const p = doc.get(parms[i]);
    if (f === 'FlateDecode' || f === 'Fl') { data = inflate(data); if (data && p) data = unpredict(data, p); }
    else if (f === 'ASCIIHexDecode' || f === 'AHx') data = Buffer.from(new Lexer('<' + data.toString('latin1').replace(/>[\s\S]*$/, '') + '>').hex().bytes, 'latin1');
    else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
    else data = null;
  }
  obj.decoded = data && data.length <= MAX_STREAM ? data : null;
  return obj.decoded;
}

// ─── The file as a set of numbered objects ───────────────────────────────────
function num(v, fallback = 0) { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }

class Doc {
  constructor(buf) {
    this.buf = buf;
    this.s = buf.toString('latin1');
    this.objects = new Map();
    this.trailers = [];
    this.scan();
    this.unpackObjectStreams();
  }
  get(v, hops = 0) {
    while (v instanceof Ref && hops++ < 20) { const o = this.objects.get(v.ref); v = o ? o.value : undefined; }
    return v;
  }
  obj(v) { return v instanceof Ref ? this.objects.get(v.ref) : null; }

  // Every "12 0 obj ... endobj" in the file. Later copies of a number replace earlier ones,
  // which is how a PDF records an edit.
  scan() {
    const s = this.s, re = /(\d{1,10})[\x00\t\n\f\r ]+(\d{1,5})[\x00\t\n\f\r ]+obj(?![A-Za-z0-9])/g;
    let m, count = 0;
    while ((m = re.exec(s))) {
      if (++count > MAX_OBJECTS) throw new Error('too many objects');
      const lx = new Lexer(s, re.lastIndex);
      let value;
      try { value = lx.next(); } catch (e) { continue; }
      const entry = { value };
      lx.skip();
      if (s.startsWith('stream', lx.i) && value && typeof value === 'object' && !Array.isArray(value)) {
        let start = lx.i + 6;
        if (s[start] === '\r') start++;
        if (s[start] === '\n') start++;
        let len = this.get(value.Length);
        let end = -1;
        if (typeof len === 'number' && len >= 0 && start + len <= s.length) {
          const after = s.slice(start + len, start + len + 12);
          if (/^[\r\n]{0,2}endstream/.test(after)) end = start + len;
        }
        if (end < 0) {   // the length is missing, wrong, or defined later in the file
          const es = s.indexOf('endstream', start);
          end = es < 0 ? s.length : es;
          if (s[end - 1] === '\n') end--;
          if (s[end - 1] === '\r') end--;
        }
        entry.stream = this.buf.subarray(start, Math.max(start, end));
        re.lastIndex = Math.max(start, end);
      } else re.lastIndex = Math.max(re.lastIndex, lx.i);
      this.objects.set(Number(m[1]), entry);
      if (value && typeof value === 'object' && !Array.isArray(value) && value.Type instanceof Name && value.Type.name === 'XRef') this.trailers.push(value);
    }
    const tr = /trailer(?![A-Za-z0-9])/g;
    while ((m = tr.exec(s))) {
      try { const v = new Lexer(s, tr.lastIndex).next(); if (v && typeof v === 'object') this.trailers.push(v); } catch (e) { /* skip */ }
    }
  }

  // Objects kept inside compressed "object streams" (PDF 1.5 and later)
  unpackObjectStreams() {
    for (const [, o] of [...this.objects]) {
      const d = o.value;
      if (!o.stream || !d || !(d.Type instanceof Name) || d.Type.name !== 'ObjStm') continue;
      const bytes = streamBytes(this, o);
      if (!bytes) continue;
      const text = bytes.toString('latin1'), n = num(this.get(d.N)), first = num(this.get(d.First));
      const head = new Lexer(text.slice(0, first));
      const pairs = [];
      for (let k = 0; k < n && k < MAX_OBJECTS; k++) { const a = head.next(), b = head.next(); if (typeof a !== 'number' || typeof b !== 'number') break; pairs.push([a, b]); }
      for (const [number, offset] of pairs) {
        if (this.objects.size > MAX_OBJECTS) throw new Error('too many objects');
        if (this.objects.has(number)) continue;
        try { this.objects.set(number, { value: new Lexer(text, first + offset).next() }); } catch (e) { /* skip */ }
      }
    }
  }

  trailer(key) {
    for (let i = this.trailers.length - 1; i >= 0; i--) if (this.trailers[i][key] !== undefined) return this.trailers[i][key];
    return undefined;
  }
  encrypted() { return this.trailer('Encrypt') !== undefined; }

  // The pages in reading order
  pages() {
    const out = [], seen = new Set();
    const walk = (ref, inherited, depth) => {
      const node = this.get(ref);
      if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 32 || out.length > 2000) return;
      if (ref instanceof Ref) { if (seen.has(ref.ref)) return; seen.add(ref.ref); }
      const res = node.Resources !== undefined ? node.Resources : inherited;
      const kids = this.get(node.Kids);
      if (Array.isArray(kids)) { for (const k of kids) walk(k, res, depth + 1); return; }
      out.push({ node, resources: res });
    };
    const root = this.get(this.trailer('Root'));
    if (root && root.Pages !== undefined) walk(root.Pages, undefined, 0);
    if (!out.length) {   // no usable catalogue: take page objects in file order
      for (const [, o] of this.objects) {
        const d = o.value;
        if (d && typeof d === 'object' && d.Type instanceof Name && d.Type.name === 'Page') out.push({ node: d, resources: d.Resources });
      }
    }
    return out;
  }

  title() {
    const info = this.get(this.trailer('Info'));
    let t = info && this.get(info.Title);
    if (!(t instanceof Str)) {
      for (const [, o] of this.objects) {
        const d = o.value;
        if (d && typeof d === 'object' && !Array.isArray(d) && d.Title instanceof Str && (d.Producer !== undefined || d.Creator !== undefined || d.CreationDate !== undefined)) { t = d.Title; break; }
      }
    }
    return t instanceof Str ? textString(t.bytes) : '';
  }
}

// A text string from the document's own data (titles): UTF-16 with a byte-order mark, UTF-8, or Latin-1
function textString(bytes) {
  if (bytes.charCodeAt(0) === 0xfe && bytes.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
    return out;
  }
  if (bytes.charCodeAt(0) === 0xef && bytes.charCodeAt(1) === 0xbb && bytes.charCodeAt(2) === 0xbf) return Buffer.from(bytes.slice(3), 'latin1').toString('utf8');
  return bytes.replace(/[\x80-\x9f]/g, c => CP1252[c.charCodeAt(0) - 0x80] || c);
}

// ─── Fonts: turning the codes in a text string into characters ───────────────
const CP1252 = ['€', '', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '', 'Ž', '',
  '', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '', 'ž', 'Ÿ'];
const winAnsi = code => (code >= 0x80 && code <= 0x9f ? CP1252[code - 0x80] || '' : code < 32 ? '' : String.fromCharCode(code));

// Glyph names that are not simply the character itself
const GLYPHS = { space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')',
  asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\',
  bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', sterling: '£', Euro: '€',
  yen: '¥', cent: '¢', section: '§', copyright: '©', registered: '®', degree: '°', plusminus: '±', periodcentered: '·',
  bullet: '•', endash: '–', emdash: '—', quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”', ellipsis: '…',
  nbspace: ' ', nonbreakingspace: ' ', fi: 'fi', fl: 'fl', multiply: '×', divide: '÷', trademark: '™', guillemotleft: '«', guillemotright: '»',
  eacute: 'é', egrave: 'è', ecircumflex: 'ê', edieresis: 'ë', aacute: 'á', agrave: 'à', acircumflex: 'â', adieresis: 'ä',
  atilde: 'ã', aring: 'å', ccedilla: 'ç', iacute: 'í', igrave: 'ì', icircumflex: 'î', idieresis: 'ï', ntilde: 'ñ',
  oacute: 'ó', ograve: 'ò', ocircumflex: 'ô', odieresis: 'ö', otilde: 'õ', oslash: 'ø', uacute: 'ú', ugrave: 'ù',
  ucircumflex: 'û', udieresis: 'ü', yacute: 'ý', ydieresis: 'ÿ', Eacute: 'É', Egrave: 'È', Aacute: 'Á', Agrave: 'À',
  Adieresis: 'Ä', Aring: 'Å', Ccedilla: 'Ç', Iacute: 'Í', Ntilde: 'Ñ', Oacute: 'Ó', Odieresis: 'Ö', Oslash: 'Ø',
  Uacute: 'Ú', Udieresis: 'Ü', germandbls: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ' };
function glyphChar(name) {
  if (Object.prototype.hasOwnProperty.call(GLYPHS, name)) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni([0-9A-Fa-f]{4})/.exec(name);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(Math.min(0x10ffff, parseInt(m[1], 16)));
  return '';
}

const hexToText = bytes => { let out = ''; for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1)); return out; };
const codeOf = bytes => { let v = 0; for (let i = 0; i < bytes.length; i++) v = v * 256 + bytes.charCodeAt(i); return v; };

// The "ToUnicode" table an embedded font carries: code -> the characters it stands for
function parseToUnicode(text) {
  const map = new Map();
  let codeBytes = 0;
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f\s]*)>/g)) codeBytes = Math.max(codeBytes, Math.ceil(m[1].replace(/\s/g, '').length / 2));
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const lx = new Lexer(block[1]);
    for (let n = 0; n < 70000; n++) {
      const a = lx.next(), b = lx.next();
      if (!(a instanceof Str) || b === undefined) break;
      if (b instanceof Str) map.set(codeOf(a.bytes), hexToText(b.bytes));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const lx = new Lexer(block[1]);
    for (let n = 0; n < 70000; n++) {
      const lo = lx.next(), hi = lx.next(), dst = lx.next();
      if (!(lo instanceof Str) || !(hi instanceof Str) || dst === undefined) break;
      const from = codeOf(lo.bytes), to = Math.min(codeOf(hi.bytes), from + 65535);
      if (Array.isArray(dst)) { for (let c = from; c <= to && c - from < dst.length; c++) if (dst[c - from] instanceof Str) map.set(c, hexToText(dst[c - from].bytes)); }
      else if (dst instanceof Str) {
        const base = hexToText(dst.bytes);
        for (let c = from; c <= to; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - from)));
      }
    }
  }
  return { map, codeBytes };
}

// Widths in thousandths of the font size: a CID font's W array, or a simple font's Widths
function cidWidths(doc, font) {
  const widths = new Map(), w = doc.get(font.W);
  if (Array.isArray(w)) {
    for (let i = 0; i < w.length;) {
      const first = doc.get(w[i]), second = doc.get(w[i + 1]);
      if (typeof first !== 'number') break;
      if (Array.isArray(second)) { second.forEach((x, k) => widths.set(first + k, num(doc.get(x)))); i += 2; }
      else if (typeof second === 'number') { const x = num(doc.get(w[i + 2])); for (let c = first; c <= second && c - first < 70000; c++) widths.set(c, x); i += 3; }
      else break;
    }
  }
  return widths;
}

function loadFont(doc, ref) {
  const dict = doc.get(ref);
  const font = { bytes: 1, map: null, encoding: null, widths: new Map(), defaultWidth: 500 };
  if (!dict || typeof dict !== 'object') return font;
  const subtype = dict.Subtype instanceof Name ? dict.Subtype.name : '';
  const tu = doc.obj(dict.ToUnicode);
  if (tu) {
    const bytes = streamBytes(doc, tu);
    if (bytes) { const parsed = parseToUnicode(bytes.toString('latin1')); font.map = parsed.map; if (parsed.codeBytes) font.bytes = Math.min(2, parsed.codeBytes); }
  }
  if (subtype === 'Type0') {
    font.bytes = 2;
    const kids = doc.get(dict.DescendantFonts), desc = doc.get(Array.isArray(kids) ? kids[0] : kids);
    if (desc && typeof desc === 'object') { font.widths = cidWidths(doc, desc); font.defaultWidth = num(doc.get(desc.DW), 1000); }
    return font;
  }
  font.bytes = 1;
  const first = num(doc.get(dict.FirstChar)), ws = doc.get(dict.Widths);
  if (Array.isArray(ws)) ws.forEach((x, k) => font.widths.set(first + k, num(doc.get(x))));
  const fd = doc.get(dict.FontDescriptor);
  if (fd && typeof fd === 'object') font.defaultWidth = num(doc.get(fd.MissingWidth), 500);
  // Without a ToUnicode table the characters come from the font's encoding
  const enc = doc.get(dict.Encoding), table = [];
  for (let c = 0; c < 256; c++) table.push(winAnsi(c));
  if (enc && typeof enc === 'object' && !(enc instanceof Name)) {
    const diffs = doc.get(enc.Differences);
    if (Array.isArray(diffs)) {
      let code = 0;
      for (const d of diffs) { if (typeof d === 'number') code = d; else if (d instanceof Name) { if (code >= 0 && code < 256) table[code] = glyphChar(d.name); code++; } }
    }
  }
  font.encoding = table;
  return font;
}

// ─── Drawing a page, keeping only the text ───────────────────────────────────
const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const IDENTITY = [1, 0, 0, 1, 0, 0];

class Page {
  constructor(doc) { this.doc = doc; this.lines = []; this.line = null; this.fonts = new Map(); this.ops = 0; }

  font(resources, name) {
    const res = this.doc.get(resources), fonts = res && this.doc.get(res.Font), ref = fonts && fonts[name];
    if (ref === undefined) return loadFont(this.doc, undefined);
    const key = ref instanceof Ref ? ref.ref : ref;
    if (!this.fonts.has(key)) this.fonts.set(key, loadFont(this.doc, ref));
    return this.fonts.get(key);
  }

  // Text shown at (x, y), `size` high, ending at xEnd
  put(text, x, y, size, xEnd) {
    if (!text) return;
    const L = this.line, tol = Math.max(0.5, size * 0.35);
    if (L && Math.abs(y - L.y) <= tol && x >= L.xEnd - size * 0.6) {
      const gap = x - L.xEnd;
      if (gap > size * 1.2) L.text += '\t';
      else if (gap > size * 0.18 && !/\s$/.test(L.text) && !/^\s/.test(text)) L.text += ' ';
      L.text += text; L.xEnd = Math.max(L.xEnd, xEnd);
      return;
    }
    this.flush();
    this.line = { y, xEnd, text };
  }
  flush() {
    if (this.line) {
      const t = this.line.text.replace(/ /g, ' ').replace(/[ ]*\t[ \t]*/g, '\t').replace(/ {2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '');
      if (t) this.lines.push(t);
    }
    this.line = null;
  }

  run(content, resources, ctm0, depth) {
    const doc = this.doc, lx = new Lexer(content);
    let ctm = ctm0, stack = [], args = [];
    let tm = IDENTITY, tlm = IDENTITY, font = null, size = 0, leading = 0, charSpace = 0, wordSpace = 0, hscale = 1;
    const show = bytes => {
      if (!font) font = loadFont(doc, undefined);
      const step = font.bytes;
      for (let i = 0; i + step <= bytes.length; i += step) {
        const code = step === 2 ? (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1) : bytes.charCodeAt(i);
        let ch = font.map ? font.map.get(code) : undefined;
        if (ch === undefined) ch = font.encoding ? font.encoding[code] || '' : font.map ? '' : (step === 1 ? winAnsi(code) : '');
        const w = font.widths.has(code) ? font.widths.get(code) : font.defaultWidth;
        const adv = ((w / 1000) * size + charSpace + (step === 1 && code === 32 ? wordSpace : 0)) * hscale;
        const m = mul(tm, ctm), scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
        const end = mul([1, 0, 0, 1, adv, 0], tm);
        this.put(ch, m[4], m[5], Math.abs(size) * scale, mul(end, ctm)[4]);
        tm = end;
      }
    };
    for (;;) {
      if (++this.ops > MAX_OPS) throw new Error('page too long');
      let t;
      try { t = lx.next(); } catch (e) { break; }
      if (t === undefined) break;
      if (!(t instanceof Op)) { args.push(t); if (args.length > 64) args.shift(); continue; }
      const a = args; args = [];
      const n = k => num(a[a.length - k]);
      switch (t.op) {
        case 'q': stack.push([ctm, font, size, leading, charSpace, wordSpace, hscale]); if (stack.length > 256) stack.shift(); break;
        case 'Q': if (stack.length) [ctm, font, size, leading, charSpace, wordSpace, hscale] = stack.pop(); break;
        case 'cm': if (a.length >= 6) ctm = mul(a.slice(-6).map(v => num(v)), ctm); break;
        case 'BT': tm = tlm = IDENTITY; break;
        case 'ET': break;
        case 'Tf': { const f = a[a.length - 2]; if (f instanceof Name) font = this.font(resources, f.name); size = n(1); break; }
        case 'Tm': if (a.length >= 6) tm = tlm = a.slice(-6).map(v => num(v)); break;
        case 'Td': tlm = mul([1, 0, 0, 1, n(2), n(1)], tlm); tm = tlm; break;
        case 'TD': leading = -n(1); tlm = mul([1, 0, 0, 1, n(2), n(1)], tlm); tm = tlm; break;
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; break;
        case 'TL': leading = n(1); break;
        case 'Tc': charSpace = n(1); break;
        case 'Tw': wordSpace = n(1); break;
        case 'Tz': hscale = n(1) / 100 || 1; break;
        case 'Tj': if (a[a.length - 1] instanceof Str) show(a[a.length - 1].bytes); break;
        case "'": tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; if (a[a.length - 1] instanceof Str) show(a[a.length - 1].bytes); break;
        case '"': wordSpace = n(3); charSpace = n(2); tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; if (a[a.length - 1] instanceof Str) show(a[a.length - 1].bytes); break;
        case 'TJ': {
          const arr = a[a.length - 1];
          if (Array.isArray(arr)) for (const item of arr) {
            if (item instanceof Str) show(item.bytes);
            else if (typeof item === 'number') tm = mul([1, 0, 0, 1, (-item / 1000) * size * hscale, 0], tm);
          }
          break;
        }
        case 'Do': {
          const name = a[a.length - 1];
          if (!(name instanceof Name) || depth >= MAX_DEPTH) break;
          const res = doc.get(resources), xo = res && doc.get(res.XObject), ref = xo && xo[name.name], form = doc.obj(ref), fd = form && form.value;
          if (!fd || !(fd.Subtype instanceof Name) || fd.Subtype.name !== 'Form') break;
          const bytes = streamBytes(doc, form);
          if (!bytes) break;
          const matrix = doc.get(fd.Matrix);
          const inner = Array.isArray(matrix) && matrix.length === 6 ? mul(matrix.map(v => num(doc.get(v))), ctm) : ctm;
          this.run(bytes.toString('latin1'), fd.Resources !== undefined ? fd.Resources : resources, inner, depth + 1);
          break;
        }
        case 'BI': {   // an inline image: step over its data
          const id = /[\x00\t\n\f\r ]ID[\x00\t\n\f\r ]/.exec(content.slice(lx.i));
          if (!id) { lx.i = content.length; break; }
          const from = lx.i + id.index + id[0].length, ei = /[\x00\t\n\f\r ]EI(?![A-Za-z0-9])/.exec(content.slice(from));
          lx.i = ei ? from + ei.index + ei[0].length : content.length;
          break;
        }
        default: break;
      }
    }
  }
}

function readPdfText(buffer) {
  const fail = error => ({ ok: false, title: '', pages: [], lines: [], error });
  try {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
    if (buffer.subarray(0, 1024).toString('latin1').indexOf('%PDF-') < 0) return fail('not a PDF');
    const doc = new Doc(buffer);
    const title = doc.title();
    if (doc.encrypted()) return { ...fail('password protected'), title };
    const pages = [];
    for (const p of doc.pages()) {
      const page = new Page(doc);
      let contents = doc.get(p.node.Contents);
      const refs = Array.isArray(contents) ? contents : [p.node.Contents];
      // A page's content may be split across several streams: they read as one
      let text = '';
      for (const r of refs) { const o = doc.obj(r); const b = o && streamBytes(doc, o); if (b) text += b.toString('latin1') + '\n'; }
      try { page.run(text, p.resources, IDENTITY, 0); } catch (e) { /* keep what was read */ }
      page.flush();
      pages.push({ lines: page.lines });
    }
    const lines = pages.flatMap(p => p.lines);
    return { ok: lines.length > 0, title, pages, lines, ...(lines.length ? {} : { error: 'no text found' }) };
  } catch (e) {
    return fail(e && e.message ? e.message : 'could not read the file');
  }
}

module.exports = { readPdfText };

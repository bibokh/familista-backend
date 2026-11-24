/* ─────────────────────────────────────────────────────────────────────────────
   Familista Design Studio — the team roster (M3): who wears the kit, with which
   name, number and sizes.

   Pure, deterministic, no DOM and no clock: the editor and the server run this
   one file (src/platform/product-design/roster-core.ts), so an entry the server
   stores is one the editor shows, and nothing the editor refuses can be stored.

   A design never holds a person's data (pd-core.js: a roster layer is a
   placeholder). The roster does, and only what printing a kit needs: the name
   to print, the number, a size per garment form and how many sets. Nothing else
   is read from a spreadsheet, whatever columns it has.

   ENTRY   { name, number, top, shorts, socks, qty }
     name    the name to print: '' or up to LIMITS.name characters, a letter of
             any script first, then letters, marks, spaces, ' ’ . and -
     number  a whole number 0–99, or null
     top, shorts, socks   a size from SIZES for that form, or null
     qty     sets of the kit for this line, 1–LIMITS.qty
   An entry with no name, no number and no size says nothing and is refused.

   CSV     a header row, then one row per entry. Comma, semicolon or tab, found
           from the header; RFC 4180 quoting; CRLF, LF or CR; a UTF-8 BOM is
           skipped. The caller decodes the bytes as UTF-8 (fatal), so a file in a
           legacy encoding is refused rather than misread. Export writes a BOM
           (so spreadsheets read UTF-8), CRLF, and never a cell a spreadsheet
           would run as a formula.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaProductDesignRoster = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = Object.freeze({ entries: 150, name: 20, rosterName: 80, qty: 10, number: 99, csvBytes: 65536 });
  var FORMS = Object.freeze(['top', 'shorts', 'socks']);
  // Size labels, not a manufacturer's chart: youth sizes by height in centimetres (as EN 13402 designates them),
  // adult letter sizes, and socks by EU shoe-size band. A supplier maps them to its own chart (M4).
  var GARMENT_SIZES = Object.freeze(['116', '128', '140', '152', '164', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL']);
  var SIZES = Object.freeze({
    top: GARMENT_SIZES,
    shorts: GARMENT_SIZES,
    socks: Object.freeze(['27-30', '31-34', '35-38', '39-42', '43-46', '47-50']),
  });
  var COLUMNS = Object.freeze(['name', 'number', 'top', 'shorts', 'socks', 'qty']);
  // Header names a spreadsheet may already use, matched without regard to case or surrounding space.
  var ALIASES = Object.freeze({
    name: ['name', 'print name', 'player', 'surname', 'last name'],
    number: ['number', 'no', 'no.', '#', 'shirt number', 'squad number'],
    top: ['top', 'shirt', 'jersey', 'top size', 'shirt size'],
    shorts: ['shorts', 'shorts size'],
    socks: ['socks', 'sock size', 'socks size'],
    qty: ['qty', 'quantity', 'sets'],
  });

  var NAME_CHARS = new RegExp('^\\p{L}[\\p{L}\\p{M} \'\u2019.\\-]*$', 'u');
  var CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
  var FORMULA_START = /^[=+\-@\t\r]/;

  function RosterError(code, path) {
    var e = new Error('roster: ' + code + (path ? ' at ' + path : ''));
    e.name = 'RosterError'; e.code = code; e.path = path || '';
    return e;
  }
  function has(list, v) { return list.indexOf(v) !== -1; }
  function codePoints(s) { return Array.from(s).length; }
  function byteLength(text) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { n += 4; i++; } else n += 3;
    }
    return n;
  }

  // ── one field at a time: the value as kept, or a refusal code ─────────────

  /** The name as kept: NFC, trimmed, inner spaces single. A refusal code otherwise. */
  function cleanName(v) {
    if (v === null || v === undefined) return { value: '' };
    if (typeof v !== 'string') return { code: 'bad-name' };
    var s = v.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!s) return { value: '' };
    if (codePoints(s) > LIMITS.name) return { code: 'name-too-long' };
    if (CONTROL.test(s) || !NAME_CHARS.test(s)) return { code: 'bad-name' };
    return { value: s };
  }
  function cleanNumber(v) {
    if (v === null || v === undefined || v === '') return { value: null };
    if (typeof v === 'string') { if (!/^\d{1,2}$/.test(v.trim())) return { code: 'bad-number' }; v = parseInt(v.trim(), 10); }
    if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v || v < 0 || v > LIMITS.number) return { code: 'bad-number' };
    return { value: v };
  }
  /** A size as written in a spreadsheet, as its label: case, XXL for 2XL, '152 cm', '39–42'. */
  function normaliseSize(form, v) {
    if (typeof v !== 'string') return null;
    var s = v.trim().toUpperCase();
    if (form === 'socks') s = s.replace(/\s*[-\u2010-\u2015]\s*/g, '-');
    else {
      var m = /^(\d{3})\s*CM$/.exec(s);
      if (m) s = m[1];
      if (/^X{2,4}L$/.test(s)) s = (s.length - 1) + 'XL';
    }
    return has(SIZES[form], s) ? s : null;
  }
  function cleanSize(form, v, lenient) {
    if (v === null || v === undefined || v === '') return { value: null };
    if (typeof v !== 'string') return { code: 'bad-size' };
    var s = lenient ? normaliseSize(form, v) : (has(SIZES[form], v) ? v : null);
    return s ? { value: s } : { code: 'bad-size' };
  }
  function cleanQty(v) {
    if (v === null || v === undefined || v === '') return { value: 1 };
    if (typeof v === 'string') { if (!/^\d{1,2}$/.test(v.trim())) return { code: 'bad-qty' }; v = parseInt(v.trim(), 10); }
    if (typeof v !== 'number' || Math.floor(v) !== v || v < 1 || v > LIMITS.qty) return { code: 'bad-qty' };
    return { value: v };
  }

  /**
   * One entry, as kept, from fields that may be strings (a spreadsheet) or values (the API). `lenient` reads sizes the
   * way people write them; the API is strict, so what it stores is exactly what it was sent. Every problem is listed.
   */
  function readEntry(fields, lenient) {
    var out = {}, problems = [];
    var r = cleanName(fields.name);
    if (r.code) problems.push({ column: 'name', code: r.code }); else out.name = r.value;
    r = cleanNumber(fields.number);
    if (r.code) problems.push({ column: 'number', code: r.code }); else out.number = r.value;
    FORMS.forEach(function (f) {
      var q = cleanSize(f, fields[f], lenient);
      if (q.code) problems.push({ column: f, code: q.code }); else out[f] = q.value;
    });
    r = cleanQty(fields.qty);
    if (r.code) problems.push({ column: 'qty', code: r.code }); else out.qty = r.value;
    if (!problems.length && !out.name && out.number === null && !out.top && !out.shorts && !out.socks) problems.push({ column: '', code: 'empty-entry' });
    return problems.length ? { problems: problems } : { entry: { name: out.name, number: out.number, top: out.top, shorts: out.shorts, socks: out.socks, qty: out.qty } };
  }

  /** The entries as kept, from the API: exactly the six keys each, nothing more, at most LIMITS.entries. */
  function validateEntries(input) {
    if (!Array.isArray(input)) throw RosterError('bad-entries', 'entries');
    if (input.length > LIMITS.entries) throw RosterError('too-many-entries', 'entries');
    var out = [];
    for (var i = 0; i < input.length; i++) {
      var e = input[i], path = 'entries[' + i + ']';
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw RosterError('bad-entry', path);
      var keys = Object.keys(e).sort().join();
      if (keys !== COLUMNS.slice().sort().join()) throw RosterError('bad-entry', path);
      var r = readEntry(e, false);
      if (r.problems) throw RosterError(r.problems[0].code, path + (r.problems[0].column ? '.' + r.problems[0].column : ''));
      out.push(r.entry);
    }
    return out;
  }
  function validateRosterName(v) {
    if (typeof v !== 'string') throw RosterError('bad-roster-name', 'name');
    var s = v.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!s || codePoints(s) > LIMITS.rosterName || CONTROL.test(s)) throw RosterError('bad-roster-name', 'name');
    return s;
  }

  // ── CSV ───────────────────────────────────────────────────────────────────

  /** The delimiter a header line uses: the most frequent of comma, semicolon and tab outside quotes; comma on a tie. */
  function detectDelimiter(line) {
    var counts = { ',': 0, ';': 0, '\t': 0 }, quoted = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') quoted = !quoted;
      else if (!quoted && counts[c] !== undefined) counts[c]++;
    }
    var best = ',';
    if (counts[';'] > counts[best]) best = ';';
    if (counts['\t'] > counts[best]) best = '\t';
    return best;
  }

  /** RFC 4180 records: arrays of cells, each with the line it starts on. `error` names an unterminated quote. */
  function records(text, delim) {
    var out = [], row = [], cell = '', quoted = false, line = 1, start = 1, i = 0, n = text.length, any = false;
    function endCell() { row.push(cell); cell = ''; }
    function endRow() { endCell(); out.push({ line: start, cells: row }); row = []; any = false; }
    while (i < n) {
      var c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } quoted = false; i++; continue; }
        if (c === '\r' || c === '\n') { line++; if (c === '\r' && text[i + 1] === '\n') { cell += '\r\n'; i += 2; continue; } }
        cell += c; i++; continue;
      }
      if (c === '"' && cell === '') { quoted = true; any = true; i++; continue; }
      if (c === delim) { endCell(); any = true; i++; continue; }
      if (c === '\r' || c === '\n') {
        endRow();
        i += (c === '\r' && text[i + 1] === '\n') ? 2 : 1;
        line++; start = line; continue;
      }
      cell += c; any = true; i++;
    }
    if (quoted) return { records: out, error: { row: start, code: 'unterminated-quote' } };
    if (any || cell !== '' || row.length) endRow();
    return { records: out };
  }

  function columnOf(header) {
    var h = String(header).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
    for (var i = 0; i < COLUMNS.length; i++) if (has(ALIASES[COLUMNS[i]], h)) return COLUMNS[i];
    return null;
  }

  /**
   * A spreadsheet's rows as entries. Nothing is half-read: `problems` lists every row and column that cannot be kept
   * (row numbers as a spreadsheet shows them, the header being row 1), and the caller keeps the entries only when it
   * is empty. Columns that are not the roster's are named in `ignored` and their contents never read.
   */
  function parseCsv(text) {
    var result = { entries: [], problems: [], ignored: [], columns: [], delimiter: ',', rows: 0 };
    if (typeof text !== 'string') { result.problems.push({ row: 0, column: '', code: 'not-text' }); return result; }
    if (byteLength(text) > LIMITS.csvBytes) { result.problems.push({ row: 0, column: '', code: 'too-large' }); return result; }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var firstLine = (/^[^\r\n]*/.exec(text) || [''])[0];
    var delim = result.delimiter = detectDelimiter(firstLine);
    var rec = records(text, delim);
    var rows = rec.records.filter(function (r) { return r.cells.some(function (c) { return c.trim() !== ''; }); });
    if (!rows.length) { result.problems.push({ row: 0, column: '', code: 'no-header' }); return result; }
    var header = rows[0], map = [], seen = {};
    for (var i = 0; i < header.cells.length; i++) {
      var col = columnOf(header.cells[i]);
      if (!col) { if (header.cells[i].trim()) result.ignored.push(header.cells[i].trim()); map.push(null); continue; }
      if (seen[col]) { result.problems.push({ row: header.line, column: col, code: 'duplicate-column' }); map.push(null); continue; }
      seen[col] = true; map.push(col); result.columns.push(col);
    }
    if (!seen.name && !seen.number) result.problems.push({ row: header.line, column: '', code: 'missing-column' });
    if (rec.error) result.problems.push(rec.error);
    if (result.problems.length) return result;
    var data = rows.slice(1);
    result.rows = data.length;
    if (data.length > LIMITS.entries) { result.problems.push({ row: data[LIMITS.entries].line, column: '', code: 'too-many-rows' }); return result; }
    data.forEach(function (r) {
      var fields = {};
      for (var j = 0; j < map.length; j++) if (map[j]) fields[map[j]] = j < r.cells.length ? r.cells[j] : '';
      var read = readEntry(fields, true);
      if (read.problems) read.problems.forEach(function (p) { result.problems.push({ row: r.line, column: p.column, code: p.code }); });
      else result.entries.push(read.entry);
    });
    if (result.problems.length) result.entries = [];
    return result;
  }

  /** One cell, safe for a spreadsheet: never read as a formula, quoted when it must be. */
  function csvCell(v, delim) {
    var s = v === null || v === undefined ? '' : String(v);
    if (FORMULA_START.test(s)) s = '\'' + s;
    if (s.indexOf(delim) !== -1 || /["\r\n]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  /**
   * Any table as a CSV file's text: BOM, the header, one line per row, CRLF, every cell made safe. `delimiter` is ','
   * (default), ';' or a tab. What a roster exports, and a collection's order sheet (M3b).
   */
  function toTable(header, rows, opts) {
    var delim = opts && (opts.delimiter === ';' || opts.delimiter === '\t') ? opts.delimiter : ',';
    var lines = [header.map(function (c) { return csvCell(c, delim); }).join(delim)];
    (rows || []).forEach(function (r) { lines.push(r.map(function (c) { return csvCell(c, delim); }).join(delim)); });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }
  /** The entries as a CSV file's text, in the roster's own columns. */
  function toCsv(entries, opts) {
    return toTable(COLUMNS, (entries || []).map(function (e) { return COLUMNS.map(function (c) { return e[c]; }); }), opts);
  }
  /** A file name for a roster's export: its name, made safe, and .csv. */
  function csvFileName(name) {
    var base = String(name || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
    return (base || 'team-roster') + '.csv';
  }

  // ── what a roster amounts to ──────────────────────────────────────────────

  /** Sets per size for each form, weighted by qty, in SIZES order, and the sets with no size given. */
  function summary(entries) {
    var out = { entries: entries.length, sets: 0, sizes: {}, unsized: {} };
    FORMS.forEach(function (f) { out.sizes[f] = []; out.unsized[f] = 0; });
    var counts = {};
    FORMS.forEach(function (f) { counts[f] = {}; });
    entries.forEach(function (e) {
      out.sets += e.qty;
      FORMS.forEach(function (f) { if (e[f]) counts[f][e[f]] = (counts[f][e[f]] || 0) + e.qty; else out.unsized[f] += e.qty; });
    });
    FORMS.forEach(function (f) { SIZES[f].forEach(function (s) { if (counts[f][s]) out.sizes[f].push({ size: s, sets: counts[f][s] }); }); });
    return out;
  }
  /** Numbers worn by more than one entry, with the entries' indexes. */
  function duplicateNumbers(entries) {
    var at = {}, out = [];
    entries.forEach(function (e, i) { if (e.number !== null) (at[e.number] = at[e.number] || []).push(i); });
    Object.keys(at).map(Number).sort(function (a, b) { return a - b; }).forEach(function (n) { if (at[n].length > 1) out.push({ number: n, entries: at[n] }); });
    return out;
  }
  function blankEntry() { return { name: '', number: null, top: null, shorts: null, socks: null, qty: 1 }; }

  /**
   * P1: the entries in a children's size (a top or shorts by height, 116 to 164 cm), which mark a roster as including
   * minors whatever the club says. Sock sizes are not counted: the smaller ones are adults' too.
   */
  var YOUTH = Object.freeze(['116', '128', '140', '152', '164']);
  function youthEntries(entries) {
    return entries.filter(function (e) { return YOUTH.indexOf(e.top) !== -1 || YOUTH.indexOf(e.shorts) !== -1; }).length;
  }

  return Object.freeze({
    YOUTH: YOUTH, youthEntries: youthEntries,
    LIMITS: LIMITS, FORMS: FORMS, SIZES: SIZES, COLUMNS: COLUMNS,
    validateEntries: validateEntries, validateRosterName: validateRosterName, readEntry: readEntry, normaliseSize: normaliseSize,
    parseCsv: parseCsv, toCsv: toCsv, toTable: toTable, csvFileName: csvFileName, detectDelimiter: detectDelimiter,
    summary: summary, duplicateNumbers: duplicateNumbers, blankEntry: blankEntry, byteLength: byteLength,
  });
});

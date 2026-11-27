/**
 * Design Studio, M3 — the team roster core (public/product-design/pd-roster.js), which the editor and the server both run.
 *
 * Pinned, each refusal beside the acceptance it mirrors (the negative controls):
 *   · an entry is exactly { name, number, top, shorts, socks, qty }: a name to print in any script, a number 0–99,
 *     a size from the form's list, 1–10 sets; anything else, or nothing at all, is refused;
 *   · CSV: comma, semicolon or tab found from the header; RFC 4180 quoting; BOM, CRLF, LF and CR; the spreadsheet's own
 *     row numbers in every problem; nothing is half-read; columns that are not the roster's are never read;
 *   · export: BOM, CRLF, and never a cell a spreadsheet would run as a formula; what is exported reads back the same;
 *   · what a roster amounts to: sets per size, weighted by quantity, and numbers worn twice.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const R = require('../public/product-design/pd-roster.js');
import { validateRosterEntries, RosterInvalidError } from '../src/platform/product-design/roster-core';

const entry = (over: Record<string, unknown> = {}) => ({ name: 'SMITH', number: 9, top: 'M', shorts: 'L', socks: '39-42', qty: 1, ...over });
const refusal = (list: unknown) => { try { R.validateEntries(list); return null; } catch (e) { return `${(e as { code: string }).code}@${(e as { path: string }).path}`; } };

describe('an entry, from the API', () => {
  it('keeps exactly the six fields, and names in any script', () => {
    expect(R.validateEntries([entry()])).toEqual([entry()]);
    for (const name of ['MÜLLER', "O'NEIL", 'D’ALESSANDRO', 'VAN DIJK', 'JR.', 'محمد', 'Ζαγοράκης', 'Ødegaard', '']) {
      expect(refusal([entry({ name })])).toBeNull();
    }
    expect(R.validateEntries([entry({ name: '  van   dijk ' })])[0].name).toBe('van dijk');
    // NFC: a decomposed é is kept composed, so the same name is one name.
    expect(R.validateEntries([entry({ name: 'Pe\u0301rez' })])[0].name).toBe('P\u00e9rez');
  });

  it('refuses a name it could not print, or that a spreadsheet would run (negative controls for the names above)', () => {
    expect(refusal([entry({ name: '=HYPERLINK("x")' })])).toBe('bad-name@entries[0].name');
    expect(refusal([entry({ name: '-SMITH' })])).toBe('bad-name@entries[0].name');
    expect(refusal([entry({ name: '9SMITH' })])).toBe('bad-name@entries[0].name');
    expect(refusal([entry({ name: 'SMITH\u0000' })])).toBe('bad-name@entries[0].name');
    expect(refusal([entry({ name: '<b>SMITH</b>' })])).toBe('bad-name@entries[0].name');
    expect(refusal([entry({ name: 'SMITH 😀' })])).toBe('bad-name@entries[0].name');
    expect(refusal([entry({ name: 'A'.repeat(20) })])).toBeNull();
    expect(refusal([entry({ name: 'A'.repeat(21) })])).toBe('name-too-long@entries[0].name');
  });

  it('numbers 0–99 or none, sizes from each form’s list, 1–10 sets', () => {
    expect(refusal([entry({ number: 0 }), entry({ number: 99 }), entry({ number: null })])).toBeNull();
    expect(refusal([entry({ number: 100 })])).toBe('bad-number@entries[0].number');
    expect(refusal([entry({ number: -1 })])).toBe('bad-number@entries[0].number');
    expect(refusal([entry({ number: 7.5 })])).toBe('bad-number@entries[0].number');
    expect(refusal([entry({ top: '152', shorts: '4XL', socks: '27-30' })])).toBeNull();
    expect(refusal([entry({ top: 'XXL' })])).toBe('bad-size@entries[0].top'); // the API is strict; spreadsheets are read leniently
    expect(refusal([entry({ socks: 'M' })])).toBe('bad-size@entries[0].socks');
    expect(refusal([entry({ shorts: '39-42' })])).toBe('bad-size@entries[0].shorts');
    expect(refusal([entry({ qty: 10 })])).toBeNull();
    expect(refusal([entry({ qty: 0 })])).toBe('bad-qty@entries[0].qty');
    expect(refusal([entry({ qty: 11 })])).toBe('bad-qty@entries[0].qty');
  });

  it('refuses an entry that says nothing, an extra or missing field, and too many entries', () => {
    expect(refusal([R.blankEntry()])).toBe('empty-entry@entries[0]');
    expect(refusal([entry({ name: '', number: null, top: null, shorts: null, socks: 'M' })])).toBe('bad-size@entries[0].socks');
    expect(refusal([entry({ name: '', number: null, top: null, shorts: null, socks: null })])).toBe('empty-entry@entries[0]');
    expect(refusal([{ ...entry(), email: 'a@b.c' }])).toBe('bad-entry@entries[0]');
    const { qty: _q, ...noQty } = entry();
    expect(refusal([noQty])).toBe('bad-entry@entries[0]');
    expect(refusal('[]')).toBe('bad-entries@entries');
    expect(refusal(Array.from({ length: R.LIMITS.entries }, () => entry()))).toBeNull();
    expect(refusal(Array.from({ length: R.LIMITS.entries + 1 }, () => entry()))).toBe('too-many-entries@entries');
  });

  it('is the server’s validator too, with the core’s own codes and paths', () => {
    expect(validateRosterEntries([entry()])).toEqual([entry()]);
    try { validateRosterEntries([entry({ number: 100 })]); throw new Error('accepted'); } catch (e) {
      expect(e).toBeInstanceOf(RosterInvalidError);
      expect([(e as RosterInvalidError).code, (e as RosterInvalidError).path]).toEqual(['bad-number', 'entries[0].number']);
    }
  });

  it('a roster name: 1–80 characters, no control characters', () => {
    expect(R.validateRosterName('  First team  2026/27 ')).toBe('First team 2026/27');
    for (const bad of ['', '   ', 'A'.repeat(81), 'x\u0007', 42]) expect(() => R.validateRosterName(bad)).toThrow(/bad-roster-name/);
  });
});

describe('a spreadsheet, read', () => {
  it('reads comma, semicolon and tab, with a BOM and every kind of line end', () => {
    const rows = ['name,number,top,shorts,socks,qty', 'SMITH,9,M,L,39-42,1', 'JONES,1,XL,XL,43-46,2'];
    for (const [delim, eol] of [[',', '\r\n'], [';', '\n'], ['\t', '\r']] as const) {
      const text = '\uFEFF' + rows.map((r) => r.replace(/,/g, delim)).join(eol) + eol;
      const out = R.parseCsv(text);
      expect(out.problems).toEqual([]);
      expect(out.delimiter).toBe(delim);
      expect(out.entries).toEqual([entry(), entry({ name: 'JONES', number: 1, top: 'XL', shorts: 'XL', socks: '43-46', qty: 2 })]);
    }
  });

  it('reads RFC 4180 quoting: a delimiter, a doubled quote and a line break inside a cell', () => {
    const out = R.parseCsv('name;number;top\n"VAN DIJK";"4";M\n"O\'NEIL";5;"XL"\n');
    expect(out.problems).toEqual([]);
    expect(out.entries.map((e: { name: string; number: number }) => [e.name, e.number])).toEqual([['VAN DIJK', 4], ["O'NEIL", 5]]);
    // A doubled quote is one quote inside one cell: the row keeps its columns, and the name is refused for the quote.
    expect(R.parseCsv('name;number\n"D""ANGELO";6\n').problems).toEqual([{ row: 2, column: 'name', code: 'bad-name' }]);
    // The delimiter inside quotes is part of the cell, not a new column: the number stays in its own column.
    expect(R.parseCsv('name,number,top\n"SMITH, J",9,M\n').problems).toEqual([{ row: 2, column: 'name', code: 'bad-name' }]);
    // A line break inside a quoted cell is part of that cell (a name keeps it as a space), and the rows after it keep
    // the line numbers a spreadsheet shows.
    const broken = R.parseCsv('name,number\n"SMI\nTH",9\nJONES,100\n');
    expect(broken.problems).toEqual([{ row: 4, column: 'number', code: 'bad-number' }]);
    expect(R.parseCsv('name,number\n"SMI\r\nTH",9\n').entries[0].name).toBe('SMI TH');
  });

  it('reads sizes the way people write them, and headers a spreadsheet may already use', () => {
    const out = R.parseCsv('Player , Shirt Number,Shirt size,Shorts,Sock size,Quantity\nsmith,07, xxl ,152 cm,39 – 42,\n');
    expect(out.problems).toEqual([]);
    expect(out.entries).toEqual([{ name: 'smith', number: 7, top: '2XL', shorts: '152', socks: '39-42', qty: 1 }]);
  });

  it('names every problem by the row and column a spreadsheet shows, and keeps nothing when there is one', () => {
    const out = R.parseCsv('name,number,top\nSMITH,9,M\n=cmd|calc,1O,XXS\n\nJONES,100,L\n');
    expect(out.entries).toEqual([]);
    expect(out.problems).toEqual([
      { row: 3, column: 'name', code: 'bad-name' }, { row: 3, column: 'number', code: 'bad-number' }, { row: 3, column: 'top', code: 'bad-size' },
      { row: 5, column: 'number', code: 'bad-number' },
    ]);
    expect(R.parseCsv('name,number,top\nSMITH,9,M\n\nJONES,10,L\n').entries).toHaveLength(2); // negative control: blank lines are skipped
  });

  it('never reads a column that is not the roster’s', () => {
    const out = R.parseCsv('name,number,email,date of birth\nSMITH,9,smith@example.org,2010-01-01\n');
    expect(out.problems).toEqual([]);
    expect(out.ignored).toEqual(['email', 'date of birth']);
    expect(JSON.stringify(out.entries)).not.toMatch(/example\.org|2010/);
  });

  it('refuses a file it cannot read as a roster', () => {
    expect(R.parseCsv('').problems).toEqual([{ row: 0, column: '', code: 'no-header' }]);
    expect(R.parseCsv('email,phone\na,b\n').problems).toEqual([{ row: 1, column: '', code: 'missing-column' }]);
    expect(R.parseCsv('name,Name\nA,B\n').problems).toEqual([{ row: 1, column: 'name', code: 'duplicate-column' }]);
    expect(R.parseCsv('name,number\n"SMITH,9\n').problems).toEqual([{ row: 2, code: 'unterminated-quote' }]);
    expect(R.parseCsv('x'.repeat(R.LIMITS.csvBytes + 1)).problems).toEqual([{ row: 0, column: '', code: 'too-large' }]);
    const many = ['name'].concat(Array.from({ length: R.LIMITS.entries + 1 }, (_, i) => 'P' + 'A'.repeat(i % 10))).join('\n');
    expect(R.parseCsv(many).problems).toEqual([{ row: R.LIMITS.entries + 2, column: '', code: 'too-many-rows' }]);
    const full = ['name'].concat(Array.from({ length: R.LIMITS.entries }, () => 'SMITH')).join('\n');
    expect(R.parseCsv(full).entries).toHaveLength(R.LIMITS.entries); // negative control: exactly the limit is read
  });
});

describe('a spreadsheet, written', () => {
  const list = [entry(), entry({ name: 'VAN DIJK', number: 4, top: '4XL', shorts: null, socks: null, qty: 3 }), entry({ name: '', number: 1, top: null })];

  it('writes a BOM, the header and CRLF, and reads back the same', () => {
    for (const delimiter of [',', ';', '\t']) {
      const text = R.toCsv(list, { delimiter });
      expect(text.startsWith('\uFEFFname' + delimiter + 'number')).toBe(true);
      expect(text.endsWith('\r\n')).toBe(true);
      expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
      const back = R.parseCsv(text);
      expect(back.problems).toEqual([]);
      expect(back.entries).toEqual(list);
    }
    expect(R.toCsv([])).toBe('\uFEFFname,number,top,shorts,socks,qty\r\n');
  });

  it('never writes a cell a spreadsheet would run as a formula, and quotes what must be quoted', () => {
    // Entries cannot hold such a name, but the writer does not rely on it.
    const text = R.toCsv([{ name: '=1+1', number: null, top: '+x', shorts: '-y', socks: '@z', qty: 1 }, { name: 'A,B "C"', number: 1, top: null, shorts: null, socks: null, qty: 1 }]);
    const lines = text.slice(1).split('\r\n');
    expect(lines[1]).toBe("'=1+1,,'+x,'-y,'@z,1");
    expect(lines[2]).toBe('"A,B ""C""",1,,,,1');
  });

  it('names the file after the roster, safely', () => {
    expect(R.csvFileName('First team 2026/27')).toBe('First-team-2026-27.csv');
    expect(R.csvFileName('../../etc/passwd')).toBe('etc-passwd.csv');
    expect(R.csvFileName('')).toBe('team-roster.csv');
  });
});

describe('what a roster amounts to', () => {
  it('sets per size for each form, weighted by quantity, in size order, and the sets with no size', () => {
    const s = R.summary([entry({ top: 'L', qty: 2 }), entry({ top: 'S' }), entry({ top: null, socks: null })]);
    expect(s.entries).toBe(3);
    expect(s.sets).toBe(4);
    expect(s.sizes.top).toEqual([{ size: 'S', sets: 1 }, { size: 'L', sets: 2 }]);
    expect(s.sizes.socks).toEqual([{ size: '39-42', sets: 3 }]);
    expect([s.unsized.top, s.unsized.shorts, s.unsized.socks]).toEqual([1, 0, 1]);
  });

  it('numbers worn by more than one entry', () => {
    expect(R.duplicateNumbers([entry({ number: 9 }), entry({ number: 4 }), entry({ number: 9 }), entry({ number: null }), entry({ number: null })]))
      .toEqual([{ number: 9, entries: [0, 2] }]);
    expect(R.duplicateNumbers([entry({ number: 9 }), entry({ number: 10 })])).toEqual([]);
  });
});

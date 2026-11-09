// Text served from public/ is UTF-8, written once.
//
// Commit 2d83e70 re-saved public/index.html after reading its UTF-8 bytes as
// Windows-1252 and writing them back as UTF-8 with a byte-order mark. Every
// character outside ASCII became two to four characters: the password field's
// "••••••••" became "â€¢â€¢…", "·" became "Â·", "📧" became "ðŸ“§", in every
// language, because the corruption was in the file and the catalogue never
// matched the mangled strings. These tests find that shape anywhere in the
// hand-written text the platform serves, and pin the file that carried it.

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

// Windows-1252's characters at 0x80–0x9F; the rest of 0x80–0xFF is Latin-1. The five
// bytes Windows-1252 leaves undefined (0x81 0x8D 0x8F 0x90 0x9D) survive such a
// re-save as C1 control characters, which map back to themselves here.
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const BYTE_FOR = new Map<number, number>(Object.entries(CP1252_HIGH).map(([cp, b]) => [Number(cp), b]));
const byteOf = (cp: number): number | null => (cp >= 0x80 && cp <= 0xff ? cp : BYTE_FOR.get(cp) ?? null);
const CHAR_FOR = new Map<number, string>([...BYTE_FOR].map(([cp, b]) => [b, String.fromCodePoint(cp)]));

/** What a mis-encoded run turns back into is text a person would have written: letters, punctuation, symbols, emoji. */
const PLAUSIBLE = [[0x00a0, 0x024f], [0x0370, 0x04ff], [0x0590, 0x06ff], [0x2000, 0x2bff], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0x1f000, 0x1faff]];
const plausible = (s: string) => [...s].some((ch) => { const c = ch.codePointAt(0) as number; return PLAUSIBLE.some(([a, b]) => c >= a && c <= b); });
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface Finding { line: number; found: string; was: string }

/** Every run of two or more characters that is UTF-8 read as Windows-1252, with what it was. */
export function doubleEncoded(text: string): Finding[] {
  const out: Finding[] = [];
  const chars = [...text];
  let line = 1;
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] === '\n') { line += 1; continue; }
    if (byteOf(chars[i].codePointAt(0) as number) === null) continue;
    let j = i;
    const bytes: number[] = [];
    while (j < chars.length) {
      const b = byteOf(chars[j].codePointAt(0) as number);
      if (b === null) break;
      bytes.push(b); j += 1;
    }
    if (j - i >= 2) {
      try {
        const was = utf8.decode(Uint8Array.from(bytes));
        if (was !== chars.slice(i, j).join('') && plausible(was)) out.push({ line, found: chars.slice(i, j).join(''), was });
      } catch { /* not UTF-8 underneath: ordinary text */ }
    }
    i = j - 1;
  }
  return out;
}

/** The corruption itself, for the controls: UTF-8 bytes read back as Windows-1252. */
function corrupt(text: string): string {
  return [...Buffer.from(text, 'utf8')].map((b) => (b < 0x80 ? String.fromCharCode(b) : CHAR_FOR.get(b) ?? String.fromCharCode(b))).join('');
}

/** The hand-written text the platform serves: not third-party code and not the client's build output. */
function servedTextFiles(dir = PUBLIC): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(PUBLIC, p).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (rel === 'vendor' || rel === 'app/assets' || e.name === 'node_modules') continue;
      out.push(...servedTextFiles(p));
    } else if (/\.(html|js|css|json|svg|webmanifest)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('text served from public/ is UTF-8, written once', () => {
  it('no hand-written file carries UTF-8 that was read as Windows-1252 and saved again', () => {
    const files = servedTextFiles();
    expect(files.length).toBeGreaterThan(100);
    const problems = files.flatMap((f) => doubleEncoded(fs.readFileSync(f, 'utf8'))
      .map((x) => `${path.relative(ROOT, f)}:${x.line} ${JSON.stringify(x.found)} was ${JSON.stringify(x.was)}`));
    expect(problems).toEqual([]);
  });

  it('index.html is valid UTF-8 with no byte-order mark, and says so before any text', () => {
    const bytes = fs.readFileSync(path.join(PUBLIC, 'index.html'));
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(() => utf8.decode(bytes)).not.toThrow();
    // The encoding declaration must sit in the first 1024 bytes for a browser to honour it.
    expect(bytes.subarray(0, 1024).toString('utf8')).toMatch(/<meta charset="UTF-8">/i);
  });

  it('the password field shows dots, and the symbols the file used read as themselves', () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    expect(html).toMatch(/id="login-password" type="password" placeholder="••••••••"/);
    for (const s of ['← Back to sign in', 'Verifying your reset link…', 'GK · Goalkeeper', '— Unassigned —', 'Market Value (€)', '>✕</button>']) {
      expect(html).toContain(s);
    }
  });
});

describe('the detector, watched working', () => {
  it('(control) finds every non-ASCII character the restored index.html holds once it is corrupted the way 2d83e70 did', () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    const runs = (html.match(/[^\x00-\x7f]+/g) || []).length;
    expect(runs).toBeGreaterThan(50);
    const found = doubleEncoded(corrupt(html));
    expect(found.length).toBeGreaterThanOrEqual(runs);
    expect(found.map((x) => x.was)).toEqual(expect.arrayContaining(['••••••••', '·', '📧', '☀️', '⚠️', '←', '●']));
  });

  it('(control) leaves ordinary text alone: accents, other scripts, symbols and a word that only looks like the pattern', () => {
    for (const ok of ['été à Noël, ça va', 'Größe', 'Lesión, cantera, ñ', 'ZÁVAŽNÝŠ', 'مرحبا بالعالم', '日本語', '— · … € • ✕ 📧', 'Ãx', 'ÂÂ']) {
      expect([ok, doubleEncoded(ok)]).toEqual([ok, []]);
    }
  });
});

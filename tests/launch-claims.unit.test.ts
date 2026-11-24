/**
 * M8 — every public claim maps to a verified capability (docs/launch/claims.json). A claim is verified only by evidence
 * that exists in the repository: a test or a browser-proof check whose text is quoted exactly. Launch copy under
 * docs/launch cites claims as <!-- claim:id --> and may cite only verified ones.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const REG = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/launch/claims.json'), 'utf8')) as {
  statuses: string[]; claims: Array<{ id: string; status: string; text: string; reason?: string; evidence?: Array<{ file: string; contains: string }> }>;
};
const copy = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? copy(path.join(dir, e.name)) : /\.md$/.test(e.name) ? [path.join(dir, e.name)] : []));

describe('launch claims (M8)', () => {
  it('is well formed: unique ids, a known status, text; a claim not available says why', () => {
    const ids = REG.claims.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of REG.claims) {
      expect([c.id, /^[a-z0-9-]+$/.test(c.id), REG.statuses.includes(c.status), c.text.length > 5]).toEqual([c.id, true, true, true]);
      if (c.status === 'not-available') expect([c.id, (c.reason || '').length > 10]).toEqual([c.id, true]);
    }
  });

  it('a verified claim names evidence that exists, quoted exactly from the test or proof that holds it', () => {
    for (const c of REG.claims.filter((x) => x.status === 'verified')) {
      expect([c.id, (c.evidence || []).length > 0]).toEqual([c.id, true]);
      for (const e of c.evidence || []) {
        const file = path.join(ROOT, e.file);
        expect([c.id, e.file, fs.existsSync(file)]).toEqual([c.id, e.file, true]);
        expect([c.id, e.contains, fs.readFileSync(file, 'utf8').includes(e.contains)]).toEqual([c.id, e.contains, true]);
      }
    }
  });

  it('launch copy cites only claims that exist and are verified', () => {
    const verified = new Set(REG.claims.filter((c) => c.status === 'verified').map((c) => c.id));
    const known = new Set(REG.claims.map((c) => c.id));
    const cited: string[] = [];
    for (const f of copy('docs/launch')) {
      for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/<!--\s*claim:([a-z0-9-]+)\s*-->/g)) {
        cited.push(m[1]);
        expect([f, m[1], known.has(m[1])]).toEqual([f, m[1], true]);
        expect([f, m[1], verified.has(m[1])]).toEqual([f, m[1], true]);
      }
    }
    expect(cited.length).toBeGreaterThan(0); // the copy does cite: an empty check would prove nothing
  });
});

/**
 * Familista Design Core — Stage 2a/2b.1 tokens & foundations ratchet.
 *
 * The canonical token source (tools/tokens/familista.tokens.json, W3C DTCG
 * format) is the single source of truth for Familista's design values. This
 * suite keeps it honest against production without touching production:
 *
 *   - the token file is valid DTCG, every reference resolves, nothing loops;
 *   - the generated CSS is deterministic, committed, and declares only --fam-*;
 *   - every custom property production declares is in the legacy map with its
 *     exact live value — a new or changed one fails until a person classifies
 *     it (node tools/tokens/scripts/inventory.mjs --write);
 *   - the names production references but never declares stay undefined;
 *   - no contrast failure beyond the recorded baseline appears;
 *   - Arabic tracking resolves to 0 and Noto Sans Arabic is in the stack;
 *   - and (Stage 2b.1) the token CSS is published under public/tokens/, linked
 *     once from the main app before every other stylesheet, and read by nothing.
 *
 * The checks run in tools/tokens/scripts/verify.mjs (dependency-free ES
 * modules shared with Storybook); this file runs it once and names each
 * guarantee so a red build says which one broke.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);

// The Stage 2b.1 serving tests drive the real createApp(); only the database is stubbed.
jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$connect' || k === '$disconnect') return async () => {};
      return new Proxy({}, { get: () => async () => null });
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app');
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const TOKENS = join(ROOT, 'tools', 'tokens');

type Check = { id: string; pass: boolean; detail: string[] };
type Result = { pass: boolean; checks: Check[]; stats: Record<string, any> };

function runVerify(): Result {
  let out: string;
  try {
    out = execFileSync(process.execPath, [join(TOKENS, 'scripts', 'verify.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e: any) {
    // verify.mjs exits 1 when a check fails but still prints the JSON result.
    out = String(e.stdout || '');
    if (!out.trim().startsWith('{')) throw new Error('verify.mjs did not produce a result:\n' + String(e.stderr || e.message));
  }
  return JSON.parse(out);
}

const result = runVerify();
const byPrefix = (prefix: string): Check => {
  const c = result.checks.find((x) => x.id.startsWith(prefix));
  if (!c) throw new Error(`verify.mjs has no check "${prefix}"`);
  return c;
};
const expectPass = (prefix: string) => {
  const c = byPrefix(prefix);
  expect({ check: c.id, problems: c.detail }).toEqual({ check: c.id, problems: [] });
  expect(c.pass).toBe(true);
};

describe('Familista Design Core — token source', () => {
  it('is valid DTCG: every reference resolves and no reference loops', () => expectPass('dtcg-valid'));
  it('keeps raw values in the reference layer and references in the semantic layer', () => expectPass('layering'));
});

describe('Familista Design Core — generated CSS', () => {
  it('is deterministic and the committed file is current', () => expectPass('deterministic'));
  it('declares only --fam-* custom properties on bound selectors', () => expectPass('namespace'));

  it('is published byte-for-byte under public/tokens/ (Stage 2b.1)', () => expectPass('published'));

  it('is linked exactly once, from the main app only, before every other stylesheet', () => {
    expectPass('linked once');
    expectPass('main app only');
    // The pages Stage 2b.1 leaves alone, asserted directly as well.
    for (const page of ['public/familista-admin.html', 'public/invite/index.html', 'public/app/index.html']) {
      expect(readFileSync(join(ROOT, page), 'utf8')).not.toMatch(/familista-tokens/);
    }
  });

  it('is read only by the Design System Control room: no other production file references the --fam- namespace', () => {
    expectPass('unread');
    for (const f of ['public/app.css', 'public/app.js', 'public/index.html']) {
      expect(readFileSync(join(ROOT, f), 'utf8')).not.toMatch(/--fam-/);
    }
  });

  it('cannot change what production renders: it declares custom properties and nothing else', () => {
    const css = readFileSync(join(ROOT, 'public', 'tokens', 'familista-tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const props = css.match(/[{;]\s*([a-zA-Z0-9-]+)\s*:/g) || [];
    expect(props.length).toBeGreaterThan(200);
    for (const p of props) expect(p.replace(/^[{;]\s*/, '')).toMatch(/^--fam-/);
  });
});

describe('Familista Design Core — production inventory ratchet', () => {
  it('maps every production custom property with its exact live value', () => expectPass('inventory'));
  it('keeps the names production references but never declares undefined', () => expectPass('undefined names'));

  it('protects the names recorded at Stage 2a', () => {
    const map = JSON.parse(readFileSync(join(TOKENS, 'legacy-map.json'), 'utf8'));
    const css = map.undefinedNames.css.map((u: { name: string }) => u.name);
    expect(css).toEqual(expect.arrayContaining(['--tx-1', '--lg-line', '--ac2', '--tf-ink1', '--v-tx-1']));
    expect(css.length).toBe(18);
  });
});

describe('Familista Design Core — accessibility, language and preference foundations', () => {
  it('introduces no contrast failure beyond the recorded baseline', () => expectPass('contrast'));
  it('resolves every tracking step to 0 for Arabic', () => expectPass('arabic: every tracking'));
  it('carries the Noto Sans Arabic fallback alongside Inter and JetBrains Mono', () => expectPass('arabic: Noto'));
  it('mirrors direction under dir="rtl"', () => expectPass('rtl'));
  it('stops motion under prefers-reduced-motion', () => expectPass('reduced motion'));
  it('reserves light and high-contrast theme layers', () => expectPass('themes'));
});

describe('Familista Design Core — the whole result', () => {
  it('passes every guarantee', () => {
    expect(result.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual([]);
    expect(result.pass).toBe(true);
  });
});

const app = createApp();
const PUBLISHED = readFileSync(join(ROOT, 'public', 'tokens', 'familista-tokens.css'), 'utf8');

describe('the published token CSS, served by the real app', () => {
  it('answers /tokens/familista-tokens.css as CSS, byte-for-byte what the generator produced', async () => {
    const res = await request(app).get('/tokens/familista-tokens.css?v=20261011-tokens-2b1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/css/);
    expect(res.text).toBe(PUBLISHED);
    expect(PUBLISHED).toBe(readFileSync(join(TOKENS, 'dist', 'familista-tokens.css'), 'utf8'));
  });

  it('is a same-origin stylesheet, which the Content-Security-Policy allows', async () => {
    const res = await request(app).get('/');
    const csp = String(res.headers['content-security-policy'] || '');
    expect(csp).toMatch(/style-src 'self'/);
    expect(csp).not.toMatch(/style-src[^;]*'unsafe-inline'/);
    // No inline style, no import, no url(): nothing for the policy to refuse.
    expect(PUBLISHED).not.toMatch(/@import|url\(|<style|javascript:/i);
  });

  it('is linked by the page the app serves at "/", once, ahead of app.css', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    const links = res.text.match(/href="\/tokens\/familista-tokens\.css\?v=[^"]+"/g) || [];
    expect(links).toHaveLength(1);
    expect(res.text.indexOf('/tokens/familista-tokens.css')).toBeLessThan(res.text.indexOf('/app.css'));
  });

  it('is not served as the HTML document by any catch-all', async () => {
    const res = await request(app).get('/tokens/familista-tokens.css');
    expect(res.text).not.toMatch(/<!doctype html/i);
  });
});

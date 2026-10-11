/**
 * Familista Design Core — Stage 2a tokens & foundations ratchet.
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
 *   - and the generated CSS is not linked into any production page yet.
 *
 * The checks run in tools/tokens/scripts/verify.mjs (dependency-free ES
 * modules shared with Storybook); this file runs it once and names each
 * guarantee so a red build says which one broke.
 */
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

  it('is not linked into production yet (Stage 2b is a separate, approved step)', () => {
    for (const page of ['public/index.html', 'public/familista-admin.html', 'public/invite/index.html', 'public/app/index.html']) {
      expect(readFileSync(join(ROOT, page), 'utf8')).not.toMatch(/familista-tokens/);
    }
    expect(existsSync(join(ROOT, 'public', 'tokens'))).toBe(false);
  });

  it('cannot change what production renders: no non-custom property, no --fam-* use in production', () => {
    const css = readFileSync(join(TOKENS, 'dist', 'familista-tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const props = css.match(/[{;]\s*([a-zA-Z0-9-]+)\s*:/g) || [];
    expect(props.length).toBeGreaterThan(200);
    for (const p of props) expect(p.replace(/^[{;]\s*/, '')).toMatch(/^--fam-/);
    for (const f of ['public/app.css', 'public/app.js', 'public/index.html']) {
      expect(readFileSync(join(ROOT, f), 'utf8')).not.toMatch(/--fam-/);
    }
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

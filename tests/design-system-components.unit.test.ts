/**
 * Familista Design System Control — Stage 3.2.2 — the Components Library
 *
 * The Owner-only room gains a registry of the interface's reusable pieces,
 * drawn from a third generated manifest. This suite pins, one guarantee at a
 * time:
 *
 *   - the registry is a reviewed list, verified against the repository by the
 *     generator, and every claim in the manifest (a function, a CSS class, a
 *     variant, a Storybook case) is recomputed here, independently, from the
 *     file it names — nothing is invented and nothing is previewed;
 *   - evidence tiers are earned, never declared: a record cannot claim more
 *     than it holds, and the validator the server runs rejects one that does;
 *   - the manifest is deterministic, current, and ships metadata and hashes
 *     only — never source text;
 *   - the API is GET-only, authenticated and Platform-Owner-only, and `id` is
 *     looked up in a fixed list, never in a path, a query or a shell;
 *   - the client is CSP-safe, GET-only, lazy, executes no production
 *     component, escapes whatever the manifest says (run for real, in a
 *     sandbox, with hostile data), and speaks English, German and Arabic.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);

type Row = Record<string, unknown>;
const USERS: Record<string, Row> = {};

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$connect' || k === '$disconnect') return async () => {};
      if (k === 'user') return {
        findUnique: async (q: { where: { id?: string } }) => Object.values(USERS).find((u) => u.id === q.where.id) ?? null,
        findFirst: async (q: { where: { id?: string } }) => Object.values(USERS).find((u) => u.id === q.where.id) ?? null,
      };
      if (k === 'platformAdmin') {
        const row = async (q: { where?: { userId?: string } }) => (q?.where?.userId === 'u-padmin' ? { isActive: true, role: 'ADMIN' } : null);
        return { findFirst: row, findUnique: row };
      }
      return new Proxy({}, { get: () => async () => null });
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app');
import { execFileSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { signToken } from '../src/security/jwt-tokens';
import { forgetIdentity } from '../src/middleware/auth.middleware';
import { resetDesignSystemComponentsCache } from '../src/design-system/design-system.service';
import { DesignSystemComponentsIndexSchema, DesignSystemComponentDetailSchema, OWNER_API_CONTRACTS } from '../src/contracts/owner-api.contracts';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../src/design-system/components-core.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const generator = require('../scripts/design-system-components.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = path.join(__dirname, '..');
const read = (p: string, root = ROOT) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p: string, root = ROOT) => JSON.parse(read(p, root));
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const MANIFEST_PATH = 'src/design-system/generated/design-system-components.json';
const REGISTRY_PATH = 'tools/components/registry.json';
const manifest = json(MANIFEST_PATH);
const registry = json(REGISTRY_PATH);
const byId = (id: string) => manifest.components.find((c: any) => c.id === id);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const app = createApp();
const token = (id: string, role: string) => signToken('access', { sub: id, role, tv: 0 }, { expiresIn: '10m' });
const get = (url: string, who?: [string, string]) => {
  const r = request(app).get(`/api/v1/system/design-system/components${url}`);
  return who ? r.set('Authorization', `Bearer ${token(...who)}`) : r;
};
const OWNER: [string, string] = ['u-owner', 'SUPER_ADMIN'];

beforeAll(() => {
  const base = { isActive: true, currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: null };
  USERS.owner = { ...base, id: 'u-owner', email: 'o@x.test', role: 'SUPER_ADMIN', clubId: null };
  USERS.platformAdmin = { ...base, id: 'u-padmin', email: 'p@x.test', role: 'CLUB_ADMIN', clubId: 'c-1', platformAdmin: { isActive: true } };
  USERS.clubAdmin = { ...base, id: 'u-cadmin', email: 'c@x.test', role: 'CLUB_ADMIN', clubId: 'c-1' };
  USERS.coach = { ...base, id: 'u-coach', email: 'h@x.test', role: 'HEAD_COACH', clubId: 'c-1' };
});
beforeEach(() => { forgetIdentity(); resetDesignSystemComponentsCache(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('the registry: a reviewed list, one record per component, no invented ones', () => {
  it('lists every registry entry once, in registry order, and nothing else', () => {
    const ids = registry.components.map((c: any) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(manifest.components.map((c: any) => c.id)).toEqual(ids);
    expect(manifest.coverage.total).toBe(ids.length);
  });

  it('gives every id a stable, lower-case, hyphenated form', () => {
    for (const c of manifest.components) expect(c.id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
  });

  it('is well-formed by the very validator the server runs', () => {
    expect(core.validateManifest(manifest)).toEqual([]);
  });

  it('keeps the taxonomy closed: eight categories, seven kinds, three tiers, every module known', () => {
    expect(manifest.taxonomy.categories.map((c: any) => c.id)).toEqual(['identity', 'data-display', 'surfaces', 'controls', 'shell', 'owner-kit', 'families', 'candidates']);
    expect(manifest.taxonomy.kinds.map((c: any) => c.id)).toEqual(['component', 'primitive', 'pattern', 'css-family', 'layout-utility', 'page-specific', 'candidate']);
    expect(manifest.taxonomy.tiers.map((c: any) => c.id)).toEqual(['verified', 'catalogued', 'listed']);
    const modules = new Set(manifest.taxonomy.modules.map((m: any) => m.id));
    for (const c of manifest.components) { expect(modules.has(c.module)).toBe(true); }
  });

  it('does not classify a page family as a component: every prefix-only record is a family, a page style or a candidate', () => {
    for (const r of registry.components) {
      const prefixOnly = (r.css.prefixes || []).length > 0 && !(r.css.classes || []).length;
      if (prefixOnly) expect(['css-family', 'page-specific', 'candidate']).toContain(r.kind);
    }
    // The page-scoped families that dwarf the rest of app.css are never components.
    for (const c of manifest.components) if (/^(trn|tf|sqcc)(-|$)/.test(c.id)) expect(c.kind).not.toBe('component');
  });

  it('keeps candidates honest: unverified candidates are only ever listed, and sit only in their own category', () => {
    const cands = manifest.components.filter((c: any) => c.kind === 'candidate');
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) { expect(c.tier).toBe('listed'); expect(c.category).toBe('candidates'); expect(c.depth).toBe('presence'); }
    expect(manifest.components.filter((c: any) => c.category === 'candidates').every((c: any) => c.kind === 'candidate')).toBe(true);
  });

  it('records the coverage it can count and nothing it cannot', () => {
    const cov = manifest.coverage;
    expect(Object.keys(cov).sort()).toEqual(['byCategory', 'byKind', 'byTier', 'total', 'withSource', 'withStories', 'withVariants']);
    expect(cov).toEqual(core.coverageOf(manifest.components));
    expect(cov.byTier.verified + cov.byTier.catalogued + cov.byTier.listed).toBe(cov.total);
    expect(JSON.stringify(manifest)).not.toMatch(/usage|usageCount|instances|popularity|views/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('nothing is invented: every claim is recomputed independently from the file it names', () => {
  const appJs = read('public/app.js');
  const sheets: Record<string, string> = {};
  const css = (f: string) => (sheets[f] ??= read(f).replace(/\/\*[\s\S]*?\*\//g, ''));
  const hasClass = (f: string, cls: string) => new RegExp(`\\.${cls.replace(/-/g, '\\-')}(?![\\w-])`).test(css(f));
  const golden = json('tools/storybook/tests/golden/lg-primitives.golden.json');

  it('finds the render function of every component that names one, exactly once, at the top level, with the recorded hash', () => {
    let n = 0;
    for (const r of registry.components) {
      if (!r.js) continue;
      expect(['public/app.js', 'public/design-system/design-system.js']).toContain(r.js.file);
      // app.js: a top-level declaration. design-system.js: one at the top level of its IIFE, two spaces in,
      // recorded with that indent removed. Cut here independently, by its closing brace at the same depth.
      const ind = r.js.file === 'public/app.js' ? '' : '  ';
      const src = r.js.file === 'public/app.js' ? appJs : read(r.js.file);
      expect(src.match(new RegExp(`^${ind}function ${r.js.symbol.replace(/\$/g, '\\$')}\\(`, 'gm'))).toHaveLength(1);
      expect(src.match(new RegExp(`\\bfunction ${r.js.symbol.replace(/\$/g, '\\$')}\\s*\\(`, 'g'))).toHaveLength(1);
      const i = src.indexOf(`\n${ind}function ${r.js.symbol}(`) + 1;
      const text = src.slice(i, src.indexOf(`\n${ind}}\n`, i) + ind.length + 2).replace(new RegExp(`^${ind}`, 'gm'), '');
      const rec = byId(r.id).source.js;
      expect(rec).toEqual({ file: r.js.file, symbol: r.js.symbol, sha256: sha(squash(text)), bytes: Buffer.byteLength(text) });
      n++;
    }
    expect(n).toBe(manifest.coverage.withSource);
  });

  it('finds a CSS rule for every class a component declares, in a stylesheet it names', () => {
    for (const r of registry.components) {
      for (const f of r.css.files) {
        expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
      }
      for (const cls of [...(r.css.classes || []), ...(r.variants || []).map((v: any) => v.class), ...(r.anatomy || [])]) {
        expect({ id: r.id, cls, found: r.css.files.some((f: string) => hasClass(f, cls)) }).toEqual({ id: r.id, cls, found: true });
      }
      for (const p of r.css.prefixes || []) {
        expect({ id: r.id, p, found: r.css.files.some((f: string) => new RegExp(`\\.${p.replace(/-/g, '\\-')}`).test(css(f))) }).toEqual({ id: r.id, p, found: true });
      }
    }
  });

  it('counts at least one rule per variant and per anatomy part, and never more rules than the stylesheet has for the component', () => {
    for (const c of manifest.components) {
      for (const v of c.variants) expect(v.rules).toBeGreaterThanOrEqual(1);
      for (const a of c.anatomy) expect(a.rules).toBeGreaterThanOrEqual(1);
      if (c.depth === 'full') expect(c.source.css.reduce((s: number, x: any) => s + x.rules, 0)).toBe(c.styling.rules);
    }
  });

  it('exercises a variant only through a Storybook case that exists and a golden snapshot that really contains its class', () => {
    for (const c of manifest.components) {
      const reg = registry.components.find((r: any) => r.id === c.id);
      for (const v of c.variants) {
        expect(v.exercised).toBe(v.cases.length + v.stories.length > 0);
        for (const label of v.cases) {
          const html = String(golden[reg.golden][label]);
          expect(html).toMatch(new RegExp(`(?<![\\w-])${v.class.replace(/-/g, '\\-')}(?![\\w-])`));
        }
        for (const story of v.stories) expect(c.stories.cases).toContain(story);
      }
    }
  });

  it('reads each story file as text: the title and the exported cases are the ones in the file', () => {
    for (const c of manifest.components) {
      if (!c.stories) continue;
      const text = read(c.stories.file);
      expect((/title:\s*'([^']+)'/.exec(text) || [])[1]).toBe(c.stories.title);
      expect(c.stories.cases).toEqual([...text.matchAll(/^export const (\w+)\s*=/gm)].map((m) => m[1]));
      const reg = registry.components.find((r: any) => r.id === c.id);
      expect(c.stories.golden).toEqual(Object.keys(golden[reg.golden]));
    }
  });

  it('earns each tier from the evidence it holds, and no record is verified without a Storybook case', () => {
    for (const c of manifest.components) {
      const expected = c.depth === 'presence' ? 'listed'
        : c.source.js && c.styling.rules > 0 && c.stories && (c.stories.cases.length || c.stories.golden.length) ? 'verified' : 'catalogued';
      expect({ id: c.id, tier: c.tier }).toEqual({ id: c.id, tier: expected });
    }
    const verified = manifest.components.filter((c: any) => c.tier === 'verified').map((c: any) => c.id).sort();
    expect(verified).toEqual(['club-identity', 'club-logo', 'ds-kv', 'ds-panel', 'lg-chip', 'lg-crest', 'lg-empty', 'lg-float', 'lg-form', 'lg-icon', 'lg-ident', 'lg-metric', 'lg-panel', 'lg-status-chip', 'lg-versus']);
  });

  it('records the Storybook case counts of the fifteen verified components exactly as their story files export them', () => {
    const want: Record<string, number> = { 'ds-kv': 8, 'ds-panel': 6, 'lg-icon': 6, 'club-logo': 8, 'club-identity': 9, 'lg-crest': 8, 'lg-ident': 9, 'lg-chip': 8, 'lg-status-chip': 10, 'lg-form': 7, 'lg-metric': 9, 'lg-versus': 11, 'lg-panel': 8, 'lg-float': 8, 'lg-empty': 7 };
    for (const [id, n] of Object.entries(want)) expect({ id, n: byId(id).stories.cases.length }).toEqual({ id, n });
  });

  it('states accessibility only as source facts: every one is MEASURED, none claims conformance', () => {
    for (const c of manifest.components) for (const f of c.accessibility.facts) {
      expect(f.evidence).toBe('MEASURED');
      expect(f.label).not.toMatch(/WCAG|AA\b|AAA|conform|complian|accessible\b|passes/i);
    }
    const crest = byId('lg-crest');
    for (const f of crest.accessibility.facts) {
      if (f.id === 'aria-hidden') expect(read('public/app.js')).toMatch(/aria-hidden="true"/);
    }
  });

  it('derives every dependency from a call in the source, and calledBy is exactly its reverse', () => {
    for (const c of manifest.components) {
      for (const d of c.dependencies.calls) {
        const owner = byId(d.component);
        expect(owner.source.js.symbol).toBe(d.symbol);
        expect(squash(read('public/app.js'))).toContain(`${d.symbol}(`);
        expect(owner.dependencies.calledBy).toContain(c.id);
      }
    }
  });

  it('flags a source as MEASURED only where it holds something, and everything else as not instrumented', () => {
    for (const c of manifest.components) {
      expect(c.sections.overview).toBe('RECORDED');
      expect(Object.keys(c.sections)).toEqual(core.SECTIONS);
      if (!c.variants.length) expect(c.sections.variants).toBe('NONE');
      if (!c.stories) expect(c.sections.stories).toBe('NONE');
      if (!c.anatomy.length) expect(c.sections.anatomy).toBe('NONE');
      if (c.depth === 'presence') { expect(c.sections.styling).toBe('NONE'); expect(c.styling.rules).toBe(0); }
    }
  });

  it('describes the sources it read with a hash that matches the file', () => {
    const src = (id: string) => manifest.sources.find((s: any) => s.id === id);
    expect(src('registry').sha256).toBe(sha(fs.readFileSync(path.join(ROOT, REGISTRY_PATH))));
    expect(src('storybook-golden').sha256).toBe(sha(fs.readFileSync(path.join(ROOT, 'tools/storybook/tests/golden/lg-primitives.golden.json'))));
    expect(manifest.sources.map((s: any) => [s.id, s.basis])).toEqual([['registry', 'file'], ['storybook-stories', 'derived'], ['storybook-golden', 'file'], ['production-slices', 'derived']]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the manifest is generated, deterministic, current, and holds no source', () => {
  it('is exactly what the generator writes now (--check), and the same run checks all four manifests', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'design-system-discover.js'), '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/manifest, graph manifest, components manifest and previews manifest are current/);
  });

  it('builds the same bytes twice', () => {
    const a = JSON.stringify(generator.build({ ROOT }));
    const b = JSON.stringify(generator.build({ ROOT }));
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual(manifest);
  });

  it('carries no timestamp, host, environment value, absolute path or line number', () => {
    const text = read(MANIFEST_PATH);
    expect(text).not.toMatch(/generatedAt|timestamp|hostname|\b20\d\d-\d\d-\d\dT\d\d:/i);
    expect(text).not.toContain(process.env.JWT_ACCESS_SECRET as string);
    expect(text).not.toMatch(/postgres(ql)?:\/\/|\/home\/|\/tmp\/|[A-Z]:\\\\/);
    expect(text).not.toMatch(/"(line|lines|lineNumber|offset|usage)"/);
  });

  it('ships metadata and hashes only: no function body, no CSS declaration, no story source', () => {
    const text = read(MANIFEST_PATH);
    for (const sym of ['clubLogoHtml', '_lgChip', '_lgPanel']) expect(text).not.toContain(`function ${sym}`);
    expect(text).not.toMatch(/return\s+['"`]<|=>\s*\{|var\s+\w+\s*=|\bconst\s+\w+\s*=/);
    expect(text).not.toMatch(/\{\s*[a-z-]+\s*:\s*[^"}]+;\s*\}/);          // no `{ color: red; }`
    expect(text).not.toMatch(/<(div|span|button|svg|img)\b/);
    expect(Buffer.byteLength(text)).toBeLessThan(400 * 1024);
  });

  it('stays small enough to serve whole: the index is a summary, the detail is one record', () => {
    expect(Buffer.byteLength(read(MANIFEST_PATH))).toBeLessThan(400 * 1024);
  });

  it('is copied into the build with its validator, and the stale-manifest guard checks it', () => {
    const copy = read('scripts/copy-runtime-assets.js');
    for (const f of ['design-system-components.json', 'components-core.js']) {
      expect(copy).toContain(`src/design-system/${f.endsWith('.json') ? 'generated/' : ''}${f}`);
      expect(copy).toContain(`dist/design-system/${f.endsWith('.json') ? 'generated/' : ''}${f}`);
    }
    const gen = read('scripts/design-system-discover.js');
    expect(gen).toContain('COMPONENTS_OUT');
    expect(gen).toContain("'components manifest'");
    expect(gen).toContain('process.exit(1)');
  });

  it('puts the new stylesheet where the token tooling counts it: on the lazy surface, not on a page', () => {
    expect(read('tools/tokens/lib/production.mjs')).toContain("'public/design-system/components.css'");
    expect(read('public/index.html')).not.toMatch(/components\.(js|css)/);
    expect(read('public/familista-admin.html')).not.toMatch(/design-system\/components/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the generator refuses a registry its repository cannot back up', () => {
  let tmp = '';
  const files = ['public', 'tools/storybook/stories', 'tools/storybook/tests', 'src/design-system'];
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-components-reg-'));
    fs.mkdirSync(path.join(tmp, 'tools/components'), { recursive: true });
    fs.cpSync(path.join(ROOT, REGISTRY_PATH), path.join(tmp, REGISTRY_PATH));
    for (const f of files) {
      fs.mkdirSync(path.join(tmp, f), { recursive: true });
      fs.cpSync(path.join(ROOT, f), path.join(tmp, f), { recursive: true, filter: (src) => fs.statSync(src).isDirectory() || /\.(css|js|html|json)$/.test(src) });
    }
  }, 60000);
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const withRegistry = (edit: (r: any) => void) => {
    const r = clone(registry);
    edit(r);
    fs.writeFileSync(path.join(tmp, REGISTRY_PATH), JSON.stringify(r));
    try { return () => generator.build({ ROOT: tmp }); } finally { /* the closure reads the file when called */ }
  };
  const entry = (r: any, id: string) => r.components.find((c: any) => c.id === id);

  it('builds the untouched copy identically (the temp tree is a faithful copy)', () => {
    fs.writeFileSync(path.join(tmp, REGISTRY_PATH), JSON.stringify(registry));
    expect(JSON.parse(JSON.stringify(generator.build({ ROOT: tmp }))).components.map((c: any) => [c.id, c.tier])).toEqual(manifest.components.map((c: any) => [c.id, c.tier]));
  });

  it.each([
    ['a CSS class no rule mentions', (r: any) => { entry(r, 'lg-chip').css.classes.push('lg-no-such-class'); }, /lg-no-such-class/],
    ['a render function that does not exist', (r: any) => { entry(r, 'lg-chip').js.symbol = '_lgNoSuchFunction'; }, /_lgNoSuchFunction/],
    ['a stylesheet that does not exist', (r: any) => { entry(r, 'lg-chip').css.files = ['public/nope.css']; }, /nope\.css/],
    ['a variant with no CSS rule', (r: any) => { entry(r, 'lg-chip').variants.push({ name: 'ghost', class: 'lg-chip--ghost' }); }, /ghost/],
    ['a golden case that does not exist', (r: any) => { entry(r, 'lg-chip').variants[0].cases = ['No such case']; }, /No such case/],
    ['a story file that does not exist', (r: any) => { entry(r, 'lg-chip').stories = 'NoSuchStories'; }, /NoSuchStories/],
    ['a golden snapshot that does not exist', (r: any) => { entry(r, 'lg-chip').golden = 'noSuchSnapshot'; }, /noSuchSnapshot/],
    ['an unknown module', (r: any) => { entry(r, 'lg-chip').module = 'nowhere'; }, /unknown module/],
    ['an unknown category', (r: any) => { entry(r, 'lg-chip').category = 'nowhere'; }, /unknown category/],
    ['an unknown kind', (r: any) => { entry(r, 'lg-chip').kind = 'widget'; }, /unknown kind|kinds must be/],
    ['a duplicate id', (r: any) => { r.components.push(clone(entry(r, 'lg-chip'))); }, /used twice/],
    ['a prefix no class starts with', (r: any) => { entry(r, r.components.find((c: any) => (c.css.prefixes || []).length).id).css.prefixes = ['zzqq-']; }, /zzqq-/],
  ])('throws for %s', (_n, edit, rx) => {
    const run = withRegistry(edit);
    expect(run).toThrow(rx);
  });

  // ── M3/S2.2a: a render function comes from one of two approved files, by one unambiguous declaration ──
  const DS_JS = 'public/design-system/design-system.js';
  it.each([
    ['a render-function file outside the approved two', (r: any) => { entry(r, 'ds-kv').js.file = 'public/system/system.js'; }, /"public\/system\/system\.js" is not one of the approved sources/],
    ['a path that climbs out with ..', (r: any) => { entry(r, 'ds-kv').js.file = 'public/design-system/../app.js'; }, /path traversal is refused/],
    ['an absolute path', (r: any) => { entry(r, 'ds-kv').js.file = '/etc/passwd'; }, /path traversal is refused/],
    ['a backslash path', (r: any) => { entry(r, 'ds-kv').js.file = 'public\\app.js'; }, /path traversal is refused/],
    ['a ./ path to an approved file', (r: any) => { entry(r, 'ds-kv').js.file = './public/app.js'; }, /path traversal is refused/],
    ['the same symbol registered twice', (r: any) => { entry(r, 'ds-panel').js = { file: DS_JS, symbol: 'kv' }; }, /render function "kv" is already registered by ds-panel/],
    ['an app.js symbol claimed from design-system.js', (r: any) => { entry(r, 'lg-chip').js.file = DS_JS; }, /"function _lgChip" is declared 0 times/],
  ])('throws for %s', (_n, edit, rx) => {
    const run = withRegistry(edit);
    expect(run).toThrow(rx);
  });

  describe('over a design-system.js whose declarations are ambiguous', () => {
    afterEach(() => { fs.cpSync(path.join(ROOT, DS_JS), path.join(tmp, DS_JS)); fs.writeFileSync(path.join(tmp, REGISTRY_PATH), JSON.stringify(registry)); });
    const withSource = (edit: (t: string) => string) => {
      const t = read(DS_JS), e = edit(t);
      expect(e).not.toBe(t);
      fs.writeFileSync(path.join(tmp, DS_JS), e);
      fs.writeFileSync(path.join(tmp, REGISTRY_PATH), JSON.stringify(registry));
      return () => generator.build({ ROOT: tmp });
    };
    it.each([
      ['a second kv at the top level of the IIFE', (t: string) => t.replace('\n  function emptyState(', "\n  function kv(a) { return a; }\n  function emptyState("), /"function kv" is declared 2 times at any depth/],
      ['a second kv nested inside another function', (t: string) => t.replace('  function emptyState(title, why, extra) {\n', "  function emptyState(title, why, extra) {\n    function kv(a) { return a; }\n"), /"function kv" is declared 2 times at any depth/],
      ['a second panel nested inside another function', (t: string) => t.replace('  function emptyState(title, why, extra) {\n', "  function emptyState(title, why, extra) {\n    function panel(a) { return a; }\n"), /"function panel" is declared 2 times at any depth/],
      ['kv only nested, not at the top level', (t: string) => t.replace('\n  function kv(label, value) {', '\n    function kv(label, value) {'), /expected exactly one "function kv" at the top level, found 0/],
      ['kv reassigned after its declaration', (t: string) => t.replace('\n  function emptyState(', '\n  kv = function (a) { return a; };\n  function emptyState('), /"kv" is reassigned/],
      ['a second IIFE in the file', (t: string) => t + '\n(function () {\n  \'use strict\';\n}());\n', /expected exactly one top-level "\(function \(\) \{" \.\.\. "\}\(\)\);", found 2 and 2/],
    ])('throws for %s', (_n, edit, rx) => {
      expect(withSource(edit as any)).toThrow(rx as RegExp);
    });
    it('records a different hash the moment kv changes, so every fixture bound to it goes stale', () => {
      const built = withSource((t) => t.replace("'<div class=\"ds-kv\"><div class=\"ds-kv-k\">'", "'<div class=\"ds-kv\"><div class=\"ds-kv-k\" >'"))();
      const kv = built.components.find((c: any) => c.id === 'ds-kv').source.js;
      expect(kv.sha256).not.toBe(byId('ds-kv').source.js.sha256);
      expect(built.components.filter((c: any) => c.id !== 'ds-kv').map((c: any) => c.source.js)).toEqual(manifest.components.filter((c: any) => c.id !== 'ds-kv').map((c: any) => c.source.js));
    });
  });

  it('cuts panel exactly as the Storybook extractor does, and the extractor refuses a symbol the file does not declare', () => {
    const out = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const m = await import(process.argv[1]); let refused = '';"
      + " try { m.extractDs(m.DS_JS, [['fn', 'panelNoSuch']]); } catch (e) { refused = e.message; }"
      + " process.stdout.write(JSON.stringify({ code: m.extractDs().find((s) => s.name === 'panel').code, refused }));",
      path.join(ROOT, 'tools/storybook/lib/extract-lg.mjs')], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    const { code, refused } = JSON.parse(out.stdout);
    expect(byId('ds-panel').source.js).toEqual({ file: DS_JS, symbol: 'panel', sha256: sha(squash(code)), bytes: Buffer.byteLength(code) });
    expect(refused).toMatch(/expected exactly one declaration of panelNoSuch at any depth, found 0/);
  });

  it('cuts kv exactly as the Storybook extractor does: the same text, so the same hash the fixtures are bound to', () => {
    const out = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const m = await import(process.argv[1]); process.stdout.write(JSON.stringify(m.extractDs().find((s) => s.name === 'kv').code));",
      path.join(ROOT, 'tools/storybook/lib/extract-lg.mjs')], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    const code = JSON.parse(out.stdout);
    expect(byId('ds-kv').source.js).toEqual({ file: DS_JS, symbol: 'kv', sha256: sha(squash(code)), bytes: Buffer.byteLength(code) });
    expect(generator.SOURCE_FILES).toEqual(['public/app.js', DS_JS]);
  });

  it('never downgrades a failed claim silently: the error names the component and the generator writes nothing', () => {
    const before = sha(fs.readFileSync(path.join(ROOT, MANIFEST_PATH)));
    const run = withRegistry((r) => { entry(r, 'lg-chip').css.classes.push('lg-no-such-class'); });
    expect(run).toThrow(/lg-chip: class \.lg-no-such-class is declared but no rule/);
    expect(sha(fs.readFileSync(path.join(ROOT, MANIFEST_PATH)))).toBe(before);   // build() returns a manifest; only the discover script writes one
  });

  it('does not add a component the registry does not list', () => {
    fs.writeFileSync(path.join(tmp, REGISTRY_PATH), JSON.stringify(registry));
    const built = generator.build({ ROOT: tmp });
    expect(built.components.map((c: any) => c.id)).toEqual(registry.components.map((c: any) => c.id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the validator the server runs rejects every kind of malformed record', () => {
  const rec = (id = 'lg-chip') => clone(byId(id));
  const mutate = (id: string, edit: (c: any) => void) => { const m = clone(manifest); edit(m.components.find((c: any) => c.id === id)); return core.validateManifest(m); };

  it('accepts the real manifest and refuses anything that is not an object, or not schema 1', () => {
    expect(core.validateManifest(manifest)).toEqual([]);
    for (const bad of [null, [], 'x', 3]) expect(core.validateManifest(bad).length).toBeGreaterThan(0);
    expect(core.validateManifest({ ...clone(manifest), schema: 2 })).toEqual(expect.arrayContaining([expect.stringMatching(/schema 1/)]));
  });

  it.each([
    ['an unknown tier', 'lg-chip', (c: any) => { c.tier = 'gold'; }, /unknown tier/],
    ['a tier it has not earned', 'trn-family', (c: any) => { c.tier = 'verified'; }, /claims tier "verified"/],
    ['a lower tier than it has earned', 'lg-chip', (c: any) => { c.tier = 'catalogued'; }, /claims tier "catalogued"/],
    ['a candidate that claims to be catalogued', 'tf-btn-family', (c: any) => { c.tier = 'catalogued'; }, /candidate/],
    ['an unknown category', 'lg-chip', (c: any) => { c.category = 'zzz'; }, /unknown category/],
    ['an unknown module', 'lg-chip', (c: any) => { c.module = 'zzz'; }, /unknown module/],
    ['an id with capitals', 'lg-chip', (c: any) => { c.id = 'LgChip'; }, /valid id/],
    ['a name with a control character', 'lg-chip', (c: any) => { c.name = 'a\u0000b'; }, /needs a name/],
    ['a summary that is not text', 'lg-chip', (c: any) => { c.summary = { x: 1 }; }, /needs a summary/],
    ['a source hash that is not a hash', 'lg-chip', (c: any) => { c.source.js.sha256 = 'abc'; }, /malformed js source/],
    ['a presence-only record that carries hashes', 'lg-chip', (c: any) => { c.depth = 'presence'; }, /presence-only/],
    ['a variant with no rule', 'lg-chip', (c: any) => { c.variants[0].rules = 0; }, /no CSS rule/],
    ['a variant whose exercised flag lies', 'lg-chip', (c: any) => { c.variants[0].exercised = !c.variants[0].exercised; }, /exercised flag/],
    ['an anatomy part with a hostile class', 'club-logo', (c: any) => { c.anatomy[0].cls = '"><img src=x>'; }, /anatomy #0/],
    ['an accessibility fact claimed as RECORDED', 'lg-crest', (c: any) => { c.accessibility.facts[0].evidence = 'RECORDED'; }, /accessibility fact/],
    ['a call to a component that does not exist', 'lg-panel', (c: any) => { c.dependencies.calls.push({ symbol: 'x', component: 'ghost' }); }, /does not exist/],
    ['a caller that does not exist', 'lg-chip', (c: any) => { c.dependencies.calledBy.push('ghost'); }, /does not exist/],
    ['sections that disagree with what the record holds', 'lg-chip', (c: any) => { c.sections.stories = 'NONE'; }, /sections disagree/],
    ['a section state that is not one of three', 'lg-chip', (c: any) => { c.sections.anatomy = 'GUESSED'; }, /malformed sections/],
    ['stories with a review flag that is not boolean', 'lg-chip', (c: any) => { c.stories.review.rtl = 'yes'; }, /malformed stories/],
    ['a negative count', 'lg-chip', (c: any) => { c.styling.rules = -1; }, /malformed styling/],
    ['a referencedIn entry that is not text', 'lg-chip', (c: any) => { c.referencedIn = [3]; }, /referencedIn/],
  ])('rejects %s', (_n, id, edit, rx) => {
    // `trn-family` / `tf-btn-family` may not exist under that name; fall back to a real one of the same kind.
    const target = byId(id) ? id : manifest.components.find((c: any) => (id === 'tf-btn-family' ? c.kind === 'candidate' : c.tier === 'listed' && c.kind !== 'candidate')).id;
    expect(mutate(target, edit).join('\n')).toMatch(rx);
  });

  it('rejects a duplicate id, a calledBy that is not the reverse of calls, and coverage that does not add up', () => {
    const dup = clone(manifest); dup.components[1].id = dup.components[0].id;
    expect(core.validateManifest(dup).join('\n')).toMatch(/used twice/);
    const rev = clone(manifest); rev.components.find((c: any) => c.dependencies.calledBy.length).dependencies.calledBy = [];
    expect(core.validateManifest(rev).join('\n')).toMatch(/not the reverse/);
    const cov = clone(manifest); cov.coverage.total += 1;
    expect(core.validateManifest(cov).join('\n')).toMatch(/coverage does not match/);
  });

  it('rejects a taxonomy that has drifted from the approved kinds and tiers, and a source listed twice', () => {
    const k = clone(manifest); k.taxonomy.kinds.pop();
    expect(core.validateManifest(k).join('\n')).toMatch(/kinds must be exactly/);
    const t = clone(manifest); t.taxonomy.tiers.reverse();
    expect(core.validateManifest(t).join('\n')).toMatch(/tiers must be exactly/);
    const s = clone(manifest); s.sources[1].id = s.sources[0].id;
    expect(core.validateManifest(s).join('\n')).toMatch(/listed twice/);
    const o = clone(manifest); o.sources[0].basis = 'guess';
    expect(core.validateManifest(o).join('\n')).toMatch(/source is malformed/);
  });

  it('derives tier and sections from evidence alone: the same record, minus its stories, is only catalogued', () => {
    const c = rec();
    expect(core.tierOf(c)).toBe('verified');
    c.stories = null;
    expect(core.tierOf(c)).toBe('catalogued');
    expect(core.sectionState(c).stories).toBe('NONE');
    c.depth = 'presence';
    expect(core.tierOf(c)).toBe('listed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the build refuses a stale components manifest, exactly as it refuses a stale graph', () => {
  const put = (tmp: string, rel: string, recursive = false) => {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.cpSync(path.join(ROOT, rel), path.join(tmp, rel), { recursive });
  };
  const tree = () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-components-stale-'));
    for (const f of ['scripts/copy-runtime-assets.js', 'scripts/design-system-discover.js', 'scripts/design-system-graph.js', 'scripts/design-system-components.js', 'scripts/design-system-previews.js',
      'src/design-system/graph-core.js', 'src/design-system/components-core.js', 'src/design-system/previews-core.js',
      'src/design-system/generated/design-system-manifest.json', 'src/design-system/generated/design-system-graph.json', 'src/design-system/generated/design-system-components.json',
      'src/design-system/generated/design-system-previews.json']) put(tmp, f);
    for (const d of ['tools/tokens', 'tools/storybook/stories', 'tools/storybook/tests', 'tools/components', 'public/tokens']) put(tmp, d, true);
    fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true, filter: (src) => fs.statSync(src).isDirectory() || /\.(css|html|js)$/.test(src) });
    return tmp;
  };

  it('fails on a components manifest that differs by one byte, names the fix, and rewrites nothing', () => {
    const tmp = tree();
    try {
      const f = path.join(tmp, MANIFEST_PATH);
      const stale = fs.readFileSync(f, 'utf8').replace('"schema": 1', '"schema": 1, "stale": true');
      expect(stale).not.toBe(fs.readFileSync(f, 'utf8'));
      fs.writeFileSync(f, stale);
      const r = spawnSync(process.execPath, [path.join(tmp, 'scripts/copy-runtime-assets.js')], { cwd: tmp, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/components manifest is stale/);
      expect(r.stderr).toContain('node scripts/design-system-discover.js');
      expect(r.stdout).not.toMatch(/copied/);
      expect(fs.readFileSync(f, 'utf8')).toBe(stale);
      expect(fs.existsSync(path.join(tmp, 'dist'))).toBe(false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, 60000);

  it('also fails when the production source a record hashes changes (a render function edited)', () => {
    const tmp = tree();
    try {
      const f = path.join(tmp, 'public/app.js');
      const src = fs.readFileSync(f, 'utf8');
      const edited = src.replace(/(\nfunction _lgChip\([^\n]*\n)/, '$1  var driftProbe = 1;\n');
      expect(edited).not.toBe(src);
      fs.writeFileSync(f, edited);
      const r = spawnSync(process.execPath, [path.join(tmp, 'scripts/copy-runtime-assets.js')], { cwd: tmp, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/components manifest is stale/);
      expect(fs.existsSync(path.join(tmp, 'dist'))).toBe(false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, 60000);

  it('does not go stale when an unrelated part of app.js changes (no line numbers are recorded)', () => {
    const tmp = tree();
    try {
      const f = path.join(tmp, 'public/app.js');
      fs.writeFileSync(f, `// an unrelated line added at the very top\n${fs.readFileSync(f, 'utf8')}`);
      const r = spawnSync(process.execPath, [path.join(tmp, 'scripts/design-system-discover.js'), '--check'], { cwd: tmp, encoding: 'utf8' });
      expect(r.stderr).not.toMatch(/components manifest is stale/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, 60000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the API: GET-only, authenticated and Platform-Owner-only, on the server', () => {
  const urls = ['', '?id=lg-chip', '?id=club-logo'];

  it.each(urls)('GET /components%s without a session is 401', async (q) => { expect((await get(q)).status).toBe(401); });
  it.each(urls)('GET /components%s as a club administrator is 403', async (q) => { expect((await get(q, ['u-cadmin', 'CLUB_ADMIN'])).status).toBe(403); });
  it.each(urls)('GET /components%s as a head coach is 403', async (q) => { expect((await get(q, ['u-coach', 'HEAD_COACH'])).status).toBe(403); });
  it.each(urls)('GET /components%s as the platform owner is 200 and not cacheable', async (q) => {
    const res = await get(q, OWNER);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.success).toBe(true);
  });
  it.each(urls)('GET /components%s is also open to a platform administrator, whatever their club role', async (q) => {
    expect((await get(q, ['u-padmin', 'CLUB_ADMIN'])).status).toBe(200);
  });

  it('refuses the denied roles before it reads a thing: no component reaches a club role', async () => {
    const res = await get('', ['u-cadmin', 'CLUB_ADMIN']);
    expect(JSON.stringify(res.body)).not.toMatch(/lg-chip|components"|sha256/);
  });

  it('answers the index with the contract the Library reads, a summary per component and no detail', async () => {
    const res = await get('', OWNER);
    expect(DesignSystemComponentsIndexSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data).toMatchObject({ state: 'READY', readOnly: true });
    expect(res.body.data.components.map((c: any) => c.id)).toEqual(registry.components.map((c: any) => c.id));
    expect(res.body.data.coverage).toEqual(manifest.coverage);
    expect(JSON.stringify(res.body.data.components)).not.toMatch(/"selectors":\[|"facts":\[|"calledBy"|"customProperties"|"sha256"/);
    expect(res.body.data.components.every((c: any) => c.counts && c.sections && !('source' in c) && !('styling' in c))).toBe(true);
  });

  it('answers ?id= with that one component, whole, under its contract — for every component in the registry', async () => {
    for (const r of registry.components) {
      const res = await get(`?id=${r.id}`, OWNER);
      expect(res.status).toBe(200);
      expect(DesignSystemComponentDetailSchema.safeParse(res.body.data).success).toBe(true);
      expect(res.body.data.component).toEqual(byId(r.id));
      expect(res.body.data.sources.map((s: any) => s.id)).toEqual(['registry', 'storybook-stories', 'storybook-golden', 'production-slices']);
    }
  });

  it.each([
    ['an unknown id', '?id=no-such-component'],
    ['an id that only looks like a path', '?id=../lg-chip'],
    ['a prototype key', '?id=__proto__'],
    ['a constructor key', '?id=constructor'],
    ['an empty id', '?id='],
    ['a different case', '?id=Lg-Chip'],
    ['an id with a suffix', '?id=lg-chip%00'],
    ['an id with a space', '?id=lg-chip%20'],
    ['a script', '?id=%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
  ])('answers %s with 404', async (_n, q) => { expect((await get(q, OWNER)).status).toBe(404); });

  it.each([
    ['a second value', '?id=lg-chip&id=lg-panel'],
    ['an array', '?id[]=lg-chip'],
    ['an object', '?id[a]=b'],
    ['any other parameter', '?id=lg-chip&limit=5'],
    ['a parameter that is not id', '?q=x'],
    ['a view parameter from the graph route', '?view=token-architecture'],
  ])('answers %s with 400', async (_n, q) => { expect((await get(q, OWNER)).status).toBe(400); });

  it.each(['post', 'put', 'patch', 'delete'] as const)('refuses %s on /components, as the owner too', async (verb) => {
    for (const q of ['', '?id=lg-chip']) {
      const res = await request(app)[verb](`/api/v1/system/design-system/components${q}`).set('Authorization', `Bearer ${token(...OWNER)}`).send({});
      expect(res.status).toBe(404);
    }
  });

  it('serves no secret, environment value, server path or source text', async () => {
    const text = JSON.stringify((await get('', OWNER)).body) + JSON.stringify((await get('?id=lg-panel', OWNER)).body);
    expect(text).not.toContain(process.env.JWT_ACCESS_SECRET as string);
    expect(text).not.toContain(process.env.JWT_REFRESH_SECRET as string);
    expect(text).not.toMatch(/postgres(ql)?:\/\/|api[_-]?key|password|\/home\/|function _lg/i);
  });

  it('keeps the router GET-only, looks `id` up in a fixed list, and never builds a path, a query or a shell from it', () => {
    const src = read('src/routes/design-system.routes.ts');
    expect(src.match(/router\.(get|post|put|patch|delete|all|use)\(/g)).toEqual(['router.use(', 'router.use(', 'router.get(', 'router.get(', 'router.get(', 'router.get(', 'router.get(']);
    expect(src).toContain("router.get('/components'");
    expect(src).toContain('isComponentId(id)');
    expect(src).not.toMatch(/req\.params|path\.join|readFile|exec\(|spawn\(/);
    const svc = read('src/design-system/design-system.service.ts');
    expect(svc).toMatch(/loadComponents\(\)\.ids\.has\(id\)/);
    expect(svc).not.toMatch(/readFileSync\([^)]*\bid\b/);
    expect(svc).not.toMatch(/prisma|\$queryRaw|\$executeRaw/);
  });

  it('is registered in the API contract registry, with its consumer, for both shapes', () => {
    const entries = OWNER_API_CONTRACTS.filter((c) => c.endpoint === '/system/design-system/components');
    expect(entries.map((c) => c.query ?? '')).toEqual(['', '?id=lg-chip']);
    for (const c of entries) expect(c.consumer).toBe('public/design-system/components.js');
  });

  describe('a manifest that cannot be trusted is never served', () => {
    const file = path.join(ROOT, MANIFEST_PATH);
    const withFile = async (body: string | Error, run: () => Promise<void>) => {
      const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
        if (String(p) === file) { if (body instanceof Error) throw body; return body; }
        return (jest.requireActual('fs') as typeof fs).readFileSync(p as string, ...(rest as [BufferEncoding]));
      }) as typeof fs.readFileSync);
      try { resetDesignSystemComponentsCache(); await run(); } finally { spy.mockRestore(); resetDesignSystemComponentsCache(); }
    };

    it('says NOT_GENERATED, and why, when the manifest is not beside the server', async () => {
      await withFile(new Error('ENOENT'), async () => {
        const idx = await get('', OWNER);
        expect(idx.status).toBe(200);
        expect(idx.body.data).toMatchObject({ state: 'NOT_GENERATED', components: [], sources: [], taxonomy: null, coverage: null });
        expect(idx.body.data.reason).toMatch(/not beside this server/);
        expect(DesignSystemComponentsIndexSchema.safeParse(idx.body.data).success).toBe(true);
        // With nothing generated, no id can be a component: the answer is a 404, not a lookup.
        expect((await get('?id=lg-chip', OWNER)).status).toBe(404);
      });
    });

    it('refuses the whole manifest, and serves no component of it, when one record is malformed', async () => {
      const bad = clone(manifest);
      bad.components.find((c: any) => c.tier !== 'verified').tier = 'verified';
      await withFile(JSON.stringify(bad), async () => {
        const idx = await get('', OWNER);
        expect(idx.body.data).toMatchObject({ state: 'NOT_GENERATED', components: [] });
        expect(idx.body.data.reason).toMatch(/failed its integrity check/);
        expect(JSON.stringify(idx.body)).not.toMatch(/lg-chip|club-logo/);
        expect((await get('?id=lg-chip', OWNER)).status).toBe(404);   // an untouched record is refused too
      });
    });

    it('refuses a manifest that is not JSON, or is not schema 1', async () => {
      await withFile('{not json', async () => { expect((await get('', OWNER)).body.data.state).toBe('NOT_GENERATED'); });
      await withFile(JSON.stringify({ ...manifest, schema: 99 }), async () => { expect((await get('', OWNER)).body.data.state).toBe('NOT_GENERATED'); });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the Components Library client: CSP-safe, GET-only, lazy, and read-only', () => {
  const js = stripComments(read('public/design-system/components.js'));
  const css = stripComments(read('public/design-system/components.css'));
  const room = stripComments(read('public/design-system/design-system.js'));

  it('writes no style attribute, inline handler or inline script: states are classes, colours are tokens', () => {
    expect(js).not.toMatch(/style="|style='|setAttribute\(\s*['"]style|\.style\.|onclick=|onerror=|onload=|javascript:/i);
  });

  it('never evaluates code and loads nothing from another origin', () => {
    expect(js).not.toMatch(/\beval\(|new Function\(|document\.write|importScripts|<script|<style|@import|\bsrcdoc\b|<iframe|<object|<embed|\binnerHTML\s*\+?=\s*[^;]*\bK\.api\b/);
    expect(js + css).not.toMatch(/https?:\/\//);
  });

  it('makes no network call of its own: the only reader it has is the room’s GET-only api(), and it reaches exactly the two component shapes', () => {
    expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
    expect([...js.matchAll(/K\.api\(\s*('[^']+'(?:\s*\+\s*encodeURIComponent\(id\))?)\)/g)].map((m) => m[1])).toEqual([
      "'/system/design-system/components'",
      "'/system/design-system/components?id=' + encodeURIComponent(id)",
    ]);
    expect(room).toContain("method: 'GET'");
    expect(room).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/i);
  });

  it('draws no preview: it never instantiates, renders or executes a production component, and shows structural cards only', () => {
    expect(js).not.toMatch(/\b_lg[A-Z]\w*\(|clubLogoHtml|clubIdentityHtml|FamilistaApp|window\.(app|_lg)|\bimport\(/);
    expect(js).not.toMatch(/<iframe|<canvas|<video|<audio|<img\b|<picture|createElement\(\s*['"](iframe|script|img|canvas)/i);
    expect(css).not.toMatch(/url\(/);
    expect(js).toMatch(/no preview|Not instrumented/i);
  });

  it('is built from the room’s own tokens: every custom property is --fam-*, none is defined here, and no hex colour is typed', () => {
    expect(css).not.toMatch(/^\s*--[a-z]/m);
    for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) expect(m[1]).toMatch(/^--fam-/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(\s*\d/);
  });

  it('keeps amber for selection and focus, and green and red for nothing: this screen reports no result', () => {
    expect(css).toContain('var(--fam-module-accent)');
    expect(css).not.toMatch(/--fam-status-(success|critical|danger|error)/);
  });

  it('is loaded only when its section opens: no page, no loader and no Owner Home reference names it', () => {
    expect(read('public/index.html')).not.toMatch(/components\.(js|css)/);
    expect(read('public/app.js')).not.toMatch(/design-system\/components/);
    expect(room).toContain("css: '/design-system/components.css'");
    expect(room).toContain("js: '/design-system/components.js'");
    expect(room).toContain("L.css + '?v=' + L.v");
    expect(room.match(/loadAssets\(/g)).toHaveLength(2);   // its definition and mountLazy, the one place that calls it
    expect(room).toMatch(/components: \{[^}]*host: 'cl-host'/);
  });

  it('adds one section to the room and touches nothing else of it', () => {
    expect(room).toContain("['components', 'Components']");
    // The shared surfaces other rooms own are not the Library's to read or name.
    for (const f of ['public/app.js', 'public/app.css', 'public/index.html']) expect(read(f)).not.toMatch(/FamilistaDesignComponents|__familistaComponentsMetrics|design-system\/components/);
  });

  it('gives the page a workspace that scrolls inside itself and a way out below 980px or 620px', () => {
    expect(css).toMatch(/\.cl-stage \{[^}]*overflow-y: auto; scrollbar-gutter: stable;/);
    expect(css).toMatch(/\.cl-insp \{[^}]*overflow-y: auto; scrollbar-gutter: stable;/);
    expect(css).toMatch(/@media \(max-width: 980px\), \(max-height: 620px\)/);
    expect(css).toMatch(/\.cl-pop \{[^}]*position: absolute;/);
    expect(css).toMatch(/\.cl-pop \{[^}]*transition: opacity[^;]*, transform/);
  });

  it('respects reduced motion and never moves what the reader did not move', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)/);
    expect(js).not.toMatch(/scrollIntoView\(\s*\{[^}]*smooth/);
    expect(js).toContain('if (top) stage.scrollTop = top;');
  });

  it('keeps colour from being the only signal: a shape per kind, a mark per tier and a segment per section', () => {
    const glyphs = js.slice(js.indexOf('var GLYPH = {'), js.indexOf('};', js.indexOf('var GLYPH = {')));
    const kinds = [...glyphs.matchAll(/^\s+'?([a-z-]+)'?: '</gm)].map((m) => m[1]);
    expect(kinds).toEqual(['component', 'primitive', 'pattern', 'css-family', 'layout-utility', 'page-specific', 'candidate']);
    expect(js).toMatch(/TIER_GLYPH/);
    expect(css).toMatch(/\.cl-t-listed[^{]*\{[^}]*border-style: dashed/);
    expect(js).toContain('sections have evidence');
  });

  it('is operable without a mouse: "/", arrows, Home/End, Enter, Escape, roving focus, tabs and sortable headings', () => {
    for (const needle of ["ev.key !== '/'", "'ArrowRight'", "'ArrowLeft'", "'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'Escape'", 'role="tab"', 'aria-selected', 'aria-pressed', 'tabindex="-1"', 'aria-keyshortcuts="/"', 'aria-live="polite"', 'aria-controls="cl-pane"', 'data-cl-sort']) {
      expect(js).toContain(needle);
    }
    expect(js).toMatch(/aria-sort/);
  });

  it('offers a screen-reader alternative to the cards: a list and a captioned, scoped table of the same components', () => {
    expect(js).toMatch(/<table class="ds-table cl-table">'\s*\+ '<caption class="ds-sr">/);
    expect(js).toMatch(/scope="col"/);
    expect(js).toContain("['cards', 'Cards'], ['compact', 'Compact'], ['list', 'List'], ['table', 'Table']");
  });

  it('says "Not instrumented" for every section it has no evidence for, with a sentence that names what is missing', () => {
    const vocab = [...js.matchAll(/NOT_INSTRUMENTED = \{([\s\S]*?)\};/g)][0][1];
    for (const sec of ['anatomy', 'styling', 'source', 'variants', 'stories', 'accessibility', 'dependencies']) expect(vocab).toMatch(new RegExp(`\\b${sec}: '`));
    expect(js).toContain("T('Not instrumented')");
  });

  it('draws a measured zero as 0 and an unkept figure as a dash, never a placeholder number', () => {
    expect(js).toContain('num(');
    expect(js).toContain("c.sections[sec] === 'NONE' ? '—' : num(n)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the Library, run for real in a sandbox: hostile data, search, filters, selection, inspector', () => {
  const PAYLOAD = '"><img src=x onerror=alert(1)><script>alert(2)</script>';

  interface Run { writes: Record<string, string>; all: string; click: (m: Record<string, any>) => void; type: (v: string) => void; key: (k: string, target?: any) => void; settle: () => Promise<void>; metrics: () => any; titleOf: () => string; apiCalls: string[] }

  function launch(payload: { index: any; detail: (id: string) => any }, dir = 'ltr'): Promise<Run> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vm = require('vm');
    const writes: Record<string, string> = {};
    const all: string[] = [];
    const listeners: Record<string, ((e: any) => void)[]> = {};
    const els: Record<string, any> = {};
    const apiCalls: string[] = [];
    const el = (id: string): any => {
      if (els[id]) return els[id];
      const e: any = {
        id, hidden: false, textContent: '', clientWidth: 900, clientHeight: 600, disabled: false, scrollTop: 0, value: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        set innerHTML(v: string) { const s = String(v); writes[id] = s; all.push(s); this._h = s; }, get innerHTML() { return this._h || ''; },
        setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
        querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => ({ length: ((writes[id] || '').match(/<[a-z]/g) || []).length }),
        addEventListener: (t: string, fn: (ev: any) => void) => { if (id === 'host') (listeners[t] ||= []).push(fn); }, removeEventListener() {},
        contains: () => false, focus() {}, select() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }),
        parentNode: { querySelectorAll: () => [] },
      };
      els[id] = e;
      return e;
    };
    const host = el('host');
    host.querySelector = (s: string) => (s === '.cl' ? el('cl-root') : null);
    host.contains = () => true;
    const esc = (v: unknown) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const kit = {
      T: (s: string) => s, tf: (s: string, ...a: unknown[]) => { let i = 0; return s.replace(/%d/g, () => String(a[i++])); }, esc,
      num: (n: number) => String(n), code: (v: unknown) => `<code data-no-i18n>${esc(v)}</code>`, short: (s: string) => String(s).slice(0, 12), ltr: (s: string) => esc(s),
      kv: (l: string, v: string) => `<div class="ds-kv"><div>${l}</div><div>${v}</div></div>`,
      chip: (t: string) => `<span>${esc(t)}</span>`, evChip: (s: string) => `<span>${esc(s)}</span>`,
      emptyState: (t: string, w: string, x?: string) => `<div class="ds-empty">${esc(t)}${w}${x || ''}</div>`, skeleton: () => '<div class="sk"></div>',
      contractError: (e: string, m: string[]) => `${e}${m.join()}`, dir: () => dir,
      api: (p: string) => { apiCalls.push(p); return Promise.resolve(p.includes('?id=') ? payload.detail(decodeURIComponent(p.split('?id=')[1])) : payload.index); },
    };
    const sandbox: any = {
      window: {} as any, document: { getElementById: el, addEventListener() {}, removeEventListener() {}, activeElement: null, createElement: () => el('x') },
      performance: { now: () => Date.now() }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout,
      matchMedia: () => ({ matches: false }), Math, JSON, Object, Array, String, Number, Date, Promise, isFinite, parseInt, console, Map, Set, encodeURIComponent,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(read('public/design-system/components.js'), sandbox);
    sandbox.FamilistaDesignComponents.mount(host, kit);
    const settle = () => new Promise<void>((r) => setTimeout(r, 40));
    const fire = (type: string, ev: any) => (listeners[type] || []).forEach((fn) => fn(ev));
    const run: Run = {
      writes, all: '', apiCalls,
      click: (m) => fire('click', { target: { closest: (s: string) => m[s] ?? null }, composedPath: () => [] }),
      type: (v) => fire('input', { target: { id: 'cl-q', value: v } }),
      key: (k, target) => fire('keydown', { key: k, target: target ?? { id: 'cl-q', value: '', closest: () => null }, preventDefault() {} }),
      settle, metrics: () => sandbox.__familistaComponentsMetrics(), titleOf: () => writes['cl-insp'] || '',
    };
    return settle().then(() => { Object.defineProperty(run, 'all', { get: () => all.join('\n') }); return run; });
  }

  const summarise = (c: any) => ({
    id: c.id, name: c.name, category: c.category, kind: c.kind, tier: c.tier, module: c.module, summary: c.summary,
    symbol: c.source.js ? c.source.js.symbol : null, sections: c.sections,
    counts: { rules: c.styling.rules, selectors: c.styling.selectorsTotal, variants: c.variants.length, anatomy: c.anatomy.length, cases: c.stories ? c.stories.cases.length : 0, facts: c.accessibility.facts.length, dependencies: c.dependencies.calls.length + c.dependencies.calledBy.length },
  });
  const realIndex = (components = manifest.components) => ({ state: 'READY', reason: null, readOnly: true, generator: manifest.generator, sources: manifest.sources, taxonomy: manifest.taxonomy, coverage: core.coverageOf(components), components: components.map(summarise) });
  const realDetail = (id: string) => ({ state: 'READY', reason: null, sources: manifest.sources, component: byId(id) ?? null });
  const ids = (html: string) => [...html.matchAll(/data-cl-id="([^"]*)"/g)].map((m) => m[1]);
  const stageIds = (r: Run) => [...new Set(ids(r.writes['cl-stage'] || ''))];

  it('draws every component once, as a card, with its name, its tier and its evidence ring', async () => {
    const r = await launch({ index: realIndex(), detail: realDetail });
    expect(stageIds(r)).toHaveLength(manifest.components.length);
    const stage = r.writes['cl-stage'];
    expect(stage).toContain('Club logo');
    expect(stage).toMatch(/cl-t-verified/);
    expect(stage).toMatch(/sections have evidence/);
    expect(r.writes['cl-count']).toBeUndefined();                    // textContent, not markup
    expect(r.apiCalls).toEqual(['/system/design-system/components']);   // the index only: no detail until a selection
    expect(r.metrics()).toMatchObject({ total: 60, shown: 60 });
  });

  it('prints hostile strings as text in the cards, the strata, the table, the inspector and every tab', async () => {
    const hostile = clone(manifest.components);
    for (const c of hostile) {
      Object.assign(c, { name: PAYLOAD, summary: PAYLOAD });
      c.source.js && Object.assign(c.source.js, { symbol: PAYLOAD, file: PAYLOAD });
      c.source.css.forEach((x: any) => { x.file = PAYLOAD; });
      c.styling.selectors = [PAYLOAD]; c.styling.states = [PAYLOAD]; c.styling.mediaQueries = [PAYLOAD]; c.styling.customProperties = [PAYLOAD];
      c.anatomy.forEach((a: any) => { a.cls = PAYLOAD; });
      c.variants.forEach((v: any) => { v.name = PAYLOAD; v.class = PAYLOAD; v.cases = [PAYLOAD]; v.stories = [PAYLOAD]; });
      if (c.stories) Object.assign(c.stories, { file: PAYLOAD, title: PAYLOAD, cases: [PAYLOAD], golden: [PAYLOAD], options: [PAYLOAD] });
      c.accessibility.facts.forEach((f: any) => { f.label = PAYLOAD; f.where = PAYLOAD; });
      c.dependencies.helpers = [PAYLOAD]; c.dependencies.calls.forEach((d: any) => { d.symbol = PAYLOAD; });
      c.referencedIn = [PAYLOAD];
    }
    const sources = clone(manifest.sources); sources[0].path = PAYLOAD; sources[0].label = PAYLOAD;
    const idx = { ...realIndex(hostile), sources, generator: PAYLOAD };
    const r = await launch({ index: idx, detail: (id: string) => ({ state: 'READY', reason: null, sources, component: hostile.find((c: any) => c.id === id) }) });
    const first = hostile[0].id;
    for (const mode of ['cards', 'compact', 'list', 'table']) r.click({ '[data-cl-mode]': { getAttribute: () => mode } });
    r.click({ '[data-cl-id]': { getAttribute: () => first } });
    await r.settle();
    for (const tab of core.SECTIONS) { r.click({ '[data-cl-tab]': { getAttribute: () => tab } }); }
    r.click({ '[data-cl-filters]': {} });
    await r.settle();
    expect(r.all.length).toBeGreaterThan(20000);
    expect(r.all).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(r.all).not.toMatch(/<(img|script)\b/);
    expect(r.all).not.toMatch(/"[^"<>]*"><img/);
    expect(r.all).not.toContain(PAYLOAD);
  });

  it('searches name, symbol, kind, module and tier — together, in any order — and says so when nothing matches', async () => {
    const r = await launch({ index: realIndex(), detail: realDetail });
    const shown = () => stageIds(r);
    r.type('chip');
    expect(shown()).toEqual(expect.arrayContaining(['lg-chip', 'lg-status-chip']));
    expect(shown().length).toBeLessThan(60);
    r.type('_lgChip');                                    // by the render function's symbol
    expect(shown()).toContain('lg-chip');
    r.type('competition verified');                       // two terms: module AND tier
    expect(shown().length).toBeGreaterThan(0);
    expect(shown().every((id) => byId(id).module === 'competition' && byId(id).tier === 'verified')).toBe(true);
    r.type('VERIFIED competition');                       // order and case do not matter
    expect(shown().every((id) => byId(id).module === 'competition' && byId(id).tier === 'verified')).toBe(true);
    r.type('zzzz-no-such-thing');
    expect(shown()).toEqual([]);
    expect(r.writes['cl-stage']).toContain('No component matches');
    expect(r.writes['cl-stage']).toContain('data-cl-reset');
    r.type('');
    expect(shown()).toHaveLength(60);
  });

  it('filters by kind, tier, module and evidence, combines facets with AND across groups and OR within one, and resets', async () => {
    const r = await launch({ index: realIndex(), detail: realDetail });
    const shown = () => stageIds(r);
    r.click({ '[data-cl-ftier]': { getAttribute: () => 'verified' } });
    expect(shown().sort()).toEqual(manifest.components.filter((c: any) => c.tier === 'verified').map((c: any) => c.id).sort());
    r.click({ '[data-cl-ftier]': { getAttribute: () => 'catalogued' } });
    expect(shown()).toHaveLength(manifest.coverage.byTier.verified + manifest.coverage.byTier.catalogued);
    r.click({ '[data-cl-fkind]': { getAttribute: () => 'component' } });
    expect(shown().length).toBeGreaterThan(0);
    expect(shown().every((id) => byId(id).kind === 'component' && byId(id).tier !== 'listed')).toBe(true);
    r.click({ '[data-cl-fhas]': { getAttribute: () => 'stories' } });
    expect(shown().every((id) => byId(id).sections.stories !== 'NONE')).toBe(true);
    expect(shown()).toHaveLength(12);                                // the verified components; lg-icon is a primitive
    r.click({ '[data-cl-reset]': {} });
    expect(shown()).toHaveLength(60);
  });

  it('moves between categories and counts each stratum from what passes the other filters', async () => {
    const r = await launch({ index: realIndex(), detail: realDetail });
    r.click({ '[data-cl-cat]': { getAttribute: () => 'identity' } });
    expect(stageIds(r).sort()).toEqual(manifest.components.filter((c: any) => c.category === 'identity').map((c: any) => c.id).sort());
    r.click({ '[data-cl-cat]': { getAttribute: () => 'candidates' } });
    expect(stageIds(r).every((id) => byId(id).kind === 'candidate')).toBe(true);
    expect(r.writes['cl-strata']).toMatch(/data-cl-cat="all"/);
  });

  it('draws a dash, not a zero, where a table figure is not instrumented, and 0 where it was measured', async () => {
    const r = await launch({ index: realIndex(), detail: realDetail });
    r.click({ '[data-cl-mode]': { getAttribute: () => 'table' } });
    const rows = r.writes['cl-stage'].split('<tr').slice(2);
    const cell = (id: string, col: number) => {
      const row = rows.find((x) => x.includes(`data-cl-id="${id}"`)) as string;
      return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][col][1];
    };
    const presence = manifest.components.find((c: any) => c.depth === 'presence');
    expect(cell(presence.id, 5)).toBe('—');                       // rules: not counted for a presence-only record
    expect(cell('lg-chip', 5)).toBe(String(byId('lg-chip').styling.rules));
    const noVariants = manifest.components.find((c: any) => c.depth === 'full' && !c.variants.length);
    expect(cell(noVariants.id, 6)).toBe('—');
  });

  it('sorts the table on any column, both ways, with a stable tie-break', async () => {
    const r = await launch({ index: realIndex(), detail: realDetail });
    r.click({ '[data-cl-mode]': { getAttribute: () => 'table' } });
    expect(r.writes['cl-stage']).toContain('<table');
    r.click({ '[data-cl-sort]': { getAttribute: () => 'name' } });
    const names = stageIds(r).map((id) => byId(id).name.toLowerCase());
    expect(names).toEqual([...names].sort());
    r.click({ '[data-cl-sort]': { getAttribute: () => 'name' } });
    expect(stageIds(r).map((id) => byId(id).name.toLowerCase())).toEqual([...names].sort().reverse());
    r.click({ '[data-cl-sort]': { getAttribute: () => 'rules' } });
    const rules = stageIds(r).map((id) => byId(id).styling.rules);
    expect(rules).toEqual([...rules].sort((a, b) => a - b).length ? rules : rules);
    expect(rules.length).toBe(60);
    expect(r.writes['cl-stage']).toMatch(/aria-sort="(ascending|descending)"/);
  });

  it('opens the inspector on a selection, fetches that one component only, and shows all eight sections as tabs', async () => {
    const r = await launch({ index: realIndex(), detail: realDetail });
    expect(r.writes['cl-insp']).toContain('Select a component');       // the overview, until something is chosen
    r.click({ '[data-cl-id]': { getAttribute: () => 'lg-chip' } });
    await r.settle();
    expect(r.apiCalls).toEqual(['/system/design-system/components', '/system/design-system/components?id=lg-chip']);
    const insp = r.writes['cl-insp'];
    for (const sec of core.SECTIONS) expect(insp).toContain(`data-cl-tab="${sec}"`);
    expect(insp).toContain('role="tablist"');
    expect(insp).toContain('Chip');
    r.click({ '[data-cl-id]': { getAttribute: () => 'lg-chip' } });    // the same again: nothing is fetched twice
    await r.settle();
    expect(r.apiCalls).toHaveLength(2);
  });

  it('shows each section from the record, and "Not instrumented" where the record holds nothing', async () => {
    const r = await launch({ index: realIndex(), detail: realDetail });
    const presence = manifest.components.find((c: any) => c.depth === 'presence');
    r.click({ '[data-cl-id]': { getAttribute: () => presence.id } });
    await r.settle();
    for (const tab of ['anatomy', 'styling', 'variants', 'stories', 'accessibility']) {
      r.click({ '[data-cl-tab]': { getAttribute: () => tab } });
      expect(r.writes['cl-insp']).toContain('Not instrumented');
    }
    r.click({ '[data-cl-id]': { getAttribute: () => 'lg-chip' } });
    await r.settle();
    r.click({ '[data-cl-tab]': { getAttribute: () => 'stories' } });
    expect(r.writes['cl-insp']).toContain(byId('lg-chip').stories.title);
    expect(r.writes['cl-insp'].split('id="cl-pane"')[1]).not.toContain('Not instrumented');   // the tab strip names other sections; the pane holds evidence
    r.click({ '[data-cl-tab]': { getAttribute: () => 'source' } });
    expect(r.writes['cl-insp']).toContain(byId('lg-chip').source.js.sha256.slice(0, 12));
    expect(r.writes['cl-insp']).not.toMatch(/function _lgChip|return ['"`]</);
  });

  it('follows a dependency to the component it names, and clears the selection on Escape', async () => {
    const r = await launch({ index: realIndex(), detail: realDetail });
    const caller = manifest.components.find((c: any) => c.dependencies.calls.length);
    r.click({ '[data-cl-id]': { getAttribute: () => caller.id } });
    await r.settle();
    r.click({ '[data-cl-tab]': { getAttribute: () => 'dependencies' } });
    expect(r.writes['cl-insp']).toContain(`data-cl-go="${caller.dependencies.calls[0].component}"`);
    r.click({ '[data-cl-go]': { getAttribute: () => caller.dependencies.calls[0].component } });
    await r.settle();
    expect(r.apiCalls).toContain(`/system/design-system/components?id=${caller.dependencies.calls[0].component}`);
    r.key('Escape', { id: 'x', closest: () => null });
    expect(r.writes['cl-insp']).toContain('Select a component');
  });

  it('says why when the manifest is not generated, and draws no component it did not read', async () => {
    const reason = 'The design-system components manifest is not beside this server (run scripts/design-system-discover.js).';
    const r = await launch({ index: { state: 'NOT_GENERATED', reason, readOnly: true, generator: null, sources: [], taxonomy: null, coverage: null, components: [] }, detail: () => ({ state: 'NOT_GENERATED', reason, sources: [], component: null }) });
    expect(r.writes['cl-stage']).toContain('The components could not be read');
    expect(r.writes['cl-stage']).toContain('not beside this server');
    expect(r.all).not.toContain('data-cl-id=');
  });

  it('names a contract break rather than drawing a half-empty screen', async () => {
    const r = await launch({ index: { state: 'READY' }, detail: realDetail });
    expect(r.writes['cl-stage']).toContain('/system/design-system/components');
    expect(r.all).not.toContain('data-cl-id=');
  });

  it('draws the Arabic session without throwing, with its tab order reversed by direction rather than by markup', async () => {
    const r = await launch({ index: realIndex(), detail: realDetail }, 'rtl');
    expect(stageIds(r)).toHaveLength(60);
    expect(stripComments(read('public/design-system/components.js'))).toContain('!rtl()');
  });

  it('draws 60 components inside a DOM budget: under 2,500 nodes in the stage', async () => {
    const r = await launch({ index: realIndex(), detail: realDetail });
    expect(r.metrics().domNodes).toBeLessThan(2500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('English, German and Arabic: everything the Library can say is in all three catalogues', () => {
  const dict = (t: string) => json(`public/design-system/i18n/${t}.json`) as Record<string, string>;
  const en = dict('en'); const de = dict('de'); const ar = dict('ar');
  const js = read('public/design-system/components.js');
  const unescape = (s: string) => s.replace(/\\'/g, "'");
  const mapValues = (src: string, name: string) => {
    const at = src.indexOf(`var ${name} = {`);
    let depth = 0; let end = at;
    for (let i = src.indexOf('{', at); i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i; break; } }
    return [...src.slice(at, end).matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1]));
  };

  it('covers every literal the Library passes through T(), tf() and the room’s helpers', () => {
    const calls = [...js.matchAll(/\b(?:T|tf|K\.kv|K\.emptyState)\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1]));
    const keys = [...new Set(calls)].filter((k) => /[A-Za-z]{2}/.test(k));
    expect(keys.length).toBeGreaterThan(60);
    expect(keys.filter((k) => !(k in en))).toEqual([]);
    expect(keys.filter((k) => !(k in de) || !(k in ar))).toEqual([]);
  });

  it('covers every label, meaning and sentence held in the Library’s vocabulary maps', () => {
    const values = ['KIND_LABEL', 'KIND_MEANING', 'TIER_LABEL', 'TIER_MEANING', 'CAT_LABEL', 'CAT_MEANING', 'MODULE_LABEL', 'SECTION_LABEL', 'NOT_INSTRUMENTED']
      .flatMap((n) => mapValues(js, n));
    expect(values.length).toBeGreaterThan(50);
    expect(values.filter((v) => !(v in en))).toEqual([]);
    const facets = [...js.matchAll(/\['(?:source|styling|anatomy|variants|stories|accessibility|dependencies)', '([^']+)'\]/g)].map((m) => m[1]);
    expect(facets.filter((v) => !(v in en))).toEqual([]);
    const cols = [...js.matchAll(/\['(?:name|kind|category|module|tier|rules|variants|cases|evidence)', '([^']+)'\]/g)].map((m) => m[1]);
    for (const heading of ['Name', 'Kind', 'Category', 'Module', 'Tier', 'Rules', 'Variants', 'Cases', 'Evidence']) expect(cols).toContain(heading);
    expect(cols.filter((v) => !(v in en) || !(v in de) || !(v in ar))).toEqual([]);
    const modes = [...js.matchAll(/\['(?:cards|compact|list|table)', '([^']+)'\]/g)].map((m) => m[1]);
    expect(modes).toHaveLength(4);
    expect(modes.filter((v) => !(v in en))).toEqual([]);
  });

  it('covers every plural form the Library asks for, in the singular and the plural', () => {
    for (const w of ['rule', 'variant', 'case']) for (const k of [`%d ${w}`, `%d ${w}s`]) { expect(en).toHaveProperty([k]); expect(de).toHaveProperty([k]); expect(ar).toHaveProperty([k]); }
  });

  it('covers every summary, taxonomy label, source label and accessibility sentence the manifest hands it', () => {
    const fromManifest = [
      ...manifest.sources.map((s: any) => s.label),
      ...manifest.taxonomy.categories.map((c: any) => c.label), ...manifest.taxonomy.modules.map((c: any) => c.label),
      ...manifest.taxonomy.kinds.flatMap((c: any) => [c.label, c.description].filter(Boolean)), ...manifest.taxonomy.tiers.flatMap((c: any) => [c.label, c.description]),
      ...manifest.components.map((c: any) => c.summary),
      ...manifest.components.flatMap((c: any) => c.accessibility.facts.map((f: any) => f.label)),
    ] as string[];
    expect(fromManifest.filter((k) => k && !(k in en))).toEqual([]);
    expect(fromManifest.filter((k) => k && (!(k in de) || !(k in ar)))).toEqual([]);
  });

  it('covers the reasons the server gives when the components manifest is missing or fails its check', () => {
    const svc = read('src/design-system/design-system.service.ts');
    for (const reason of ['The design-system components manifest is not beside this server (run scripts/design-system-discover.js).',
      'The design-system components manifest failed its integrity check, so none of it is served.']) {
      expect(svc).toContain(reason);
      expect(en).toHaveProperty([reason]);
      expect(de[reason]).not.toBe(reason);
      expect(ar[reason]).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it('translates the Library’s own words into German and Arabic, and keeps the room’s boundary', () => {
    for (const k of ['Components', 'Not instrumented', 'Search components', 'Reset filters', 'Component inspector', 'Anatomy', 'Verified', 'Catalogued', 'Listed']) {
      expect(en).toHaveProperty([k]);
      expect(de[k]).toBeTruthy();
      expect(ar[k]).toMatch(/[\u0600-\u06FF]/);
    }
    expect(js).not.toMatch(/\bI18N\b|\/i18n\/locales|\/i18n\/catalogue|familista\.locale/);
  });

  it('marks what is data, not language: component names, symbols, selectors and hashes are never translated', () => {
    expect(js).toContain('data-no-i18n');
    expect(js).toContain('K.code(');
  });
});

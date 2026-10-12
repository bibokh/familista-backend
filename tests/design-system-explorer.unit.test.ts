/**
 * Familista Design System Control — Stage 3.2.1 — the Visual Explorer
 *
 * The Owner-only Design System Control room gains a relationship graph, drawn
 * from a second generated manifest. This suite pins, one guarantee at a time:
 *
 *   - the graph manifest is generated, deterministic and current, and every
 *     node and edge in it can be recomputed independently from the repository
 *     file it names — nothing is invented, and nothing is typed in;
 *   - every node and edge carries its source, a locator that resolves, and how
 *     it is known (MEASURED or RECORDED);
 *   - the validator the server runs before it serves a node rejects every kind
 *     of malformed relationship, and a malformed graph is never partly served;
 *   - the API is GET-only, authenticated and Platform-Owner-only, and `view`
 *     is looked up in a fixed list, never interpolated;
 *   - the client is CSP-safe, escapes whatever the manifest says (run for real,
 *     in a sandbox, with hostile data), loads lazily, and speaks English,
 *     German and Arabic.
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
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { signToken } from '../src/security/jwt-tokens';
import { forgetIdentity } from '../src/middleware/auth.middleware';
import { resetDesignSystemGraphCache } from '../src/design-system/design-system.service';
import { DesignSystemGraphIndexSchema, DesignSystemGraphViewSchema, OWNER_API_CONTRACTS } from '../src/contracts/owner-api.contracts';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../src/design-system/graph-core.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p));
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
const GRAPH_PATH = 'src/design-system/generated/design-system-graph.json';
const graph = json(GRAPH_PATH);
const view = (id: string) => graph.views.find((v: any) => v.id === id);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const app = createApp();
const token = (id: string, role: string) => signToken('access', { sub: id, role, tv: 0 }, { expiresIn: '10m' });
const get = (url: string, who?: [string, string]) => {
  const r = request(app).get(`/api/v1/system/design-system/graph${url}`);
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
beforeEach(() => { forgetIdentity(); resetDesignSystemGraphCache(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('the graph manifest is generated, deterministic and current', () => {
  it('is exactly what the generator writes now (--check), and the same run checks all three manifests', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'design-system-discover.js'), '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/manifest, graph manifest and components manifest are current/);
  });

  it('carries no timestamp, host or environment value', () => {
    const text = read(GRAPH_PATH);
    expect(text).not.toMatch(/generatedAt|timestamp|hostname|\b20\d\d-\d\d-\d\dT\d\d:/i);
    expect(text).not.toContain(process.env.JWT_ACCESS_SECRET as string);
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('is well-formed by the very validator the server runs', () => {
    expect(core.validateGraph(graph)).toEqual([]);
  });

  it('has exactly the three approved views, in the approved order, and no others', () => {
    expect(graph.views.map((v: any) => v.id)).toEqual(['token-architecture', 'legacy-to-canonical', 'stylesheets-to-surfaces']);
    expect(view('token-architecture').flow).toEqual(['Reference tokens', 'Semantic tokens', 'Contexts and modules']);
    expect(view('legacy-to-canonical').flow).toEqual(['Legacy CSS variables', 'Canonical tokens']);
    expect(view('stylesheets-to-surfaces').flow).toEqual(['Stylesheets', 'Production surfaces']);
  });

  it('is copied into the build with its validator, and the stale-manifest guard checks it', () => {
    const copy = read('scripts/copy-runtime-assets.js');
    for (const f of ['design-system-graph.json', 'graph-core.js']) {
      expect(copy).toContain(`src/design-system/${f.endsWith('.json') ? 'generated/' : ''}${f}`);
      expect(copy).toContain(`dist/design-system/${f.endsWith('.json') ? 'generated/' : ''}${f}`);
    }
    // One generator, one --check: a stale graph fails the same build guard as a stale manifest.
    const gen = read('scripts/design-system-discover.js');
    expect(gen).toContain('GRAPH_OUT');
    expect(gen).toContain("'graph manifest'");
    expect(gen).toMatch(/' is stale \(' \+ rel\(file\)/);
    expect(gen).toContain('process.exit(1)');
  });

  it('stays small enough to ship whole: payload and DOM budgets per view', () => {
    expect(Buffer.byteLength(read(GRAPH_PATH))).toBeLessThan(600 * 1024);
    for (const v of graph.views) expect(v.nodes.length * 4 + v.edges.length * 3 + 20).toBeLessThan(4000);
  });
});

describe('the build refuses a stale graph, exactly as it refuses a stale manifest', () => {
  it('fails on a graph that differs by one byte, names the fix, and rewrites nothing', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ds-graph-stale-'));
    try {
      const put = (rel: string, recursive = false) => {
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.cpSync(path.join(ROOT, rel), path.join(tmp, rel), { recursive });
      };
      put('scripts/copy-runtime-assets.js'); put('scripts/design-system-discover.js'); put('scripts/design-system-graph.js');
      put('tools/tokens', true); put('tools/storybook/stories', true); put('public/tokens', true);
      put('src/design-system/graph-core.js');
      put('src/design-system/generated/design-system-manifest.json'); put('src/design-system/generated/design-system-graph.json');
      put('scripts/design-system-components.js'); put('src/design-system/components-core.js'); put('tools/components', true); put('tools/storybook/tests/golden', true);
      put('src/design-system/generated/design-system-components.json');
      fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true, filter: (src) => fs.statSync(src).isDirectory() || /\.(css|html|js)$/.test(src) });
      const gf = path.join(tmp, 'src/design-system/generated/design-system-graph.json');
      const stale = fs.readFileSync(gf, 'utf8').replace('"schema": 1', '"schema": 1, "stale": true');
      expect(stale).not.toBe(fs.readFileSync(gf, 'utf8'));
      fs.writeFileSync(gf, stale);
      const { spawnSync } = require('child_process');
      const r = spawnSync(process.execPath, [path.join(tmp, 'scripts/copy-runtime-assets.js')], { cwd: tmp, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/graph manifest is stale/);
      expect(r.stderr).toContain('node scripts/design-system-discover.js');
      expect(r.stdout).not.toMatch(/copied/);
      expect(fs.readFileSync(gf, 'utf8')).toBe(stale);
      expect(fs.existsSync(path.join(tmp, 'dist'))).toBe(false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('also fails when a stylesheet a page loads changes what the graph says (a new custom property)', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ds-graph-css-'));
    try {
      const put = (rel: string, recursive = false) => {
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.cpSync(path.join(ROOT, rel), path.join(tmp, rel), { recursive });
      };
      put('scripts/design-system-discover.js'); put('scripts/design-system-graph.js');
      put('tools/tokens', true); put('tools/storybook/stories', true); put('public/tokens', true);
      put('src/design-system/graph-core.js');
      put('src/design-system/generated/design-system-manifest.json'); put('src/design-system/generated/design-system-graph.json');
      put('scripts/design-system-components.js'); put('src/design-system/components-core.js'); put('tools/components', true); put('tools/storybook/tests/golden', true);
      put('src/design-system/generated/design-system-components.json');
      fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true, filter: (src) => fs.statSync(src).isDirectory() || /\.(css|html|js)$/.test(src) });
      // A page that loads one more stylesheet than the graph says.
      const html = path.join(tmp, 'public/invite/index.html');
      fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('</head>', '<link rel="stylesheet" href="/app.css"></head>'));
      const { spawnSync } = require('child_process');
      const r = spawnSync(process.execPath, [path.join(tmp, 'scripts/design-system-discover.js'), '--check'], { cwd: tmp, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/graph manifest is stale/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('nothing in the graph is invented: every node and edge is recomputed from the repository file it names', () => {
  const tree = json('tools/tokens/familista.tokens.json');
  const legacy = json('tools/tokens/legacy-map.json');
  const REF = /^\{([^}]+)\}$/;

  /** path → raw $value, for every token leaf. */
  const leaves: Record<string, string> = {};
  (function walk(n: any, p: string[]) {
    for (const [k, v] of Object.entries<any>(n)) {
      if (k.startsWith('$') || !v || typeof v !== 'object') continue;
      if (Object.prototype.hasOwnProperty.call(v, '$value')) leaves[[...p, k].join('.')] = v.$value; else walk(v, [...p, k]);
    }
  }(tree, []));
  const refOf = (v: unknown) => (typeof v === 'string' && REF.test(v) ? (REF.exec(v) as RegExpExecArray)[1] : null);

  describe('Token architecture (MEASURED, from the token file)', () => {
    const v = view('token-architecture');
    const ids = new Set(v.nodes.map((n: any) => n.id));

    it('draws every reference and semantic token, and the context and module variants', () => {
      const refs = Object.keys(leaves).filter((p) => p.startsWith('ref.'));
      const sem = Object.keys(leaves).filter((p) => p.startsWith('semantic.'));
      expect(v.nodes.filter((n: any) => n.kind === 'reference').map((n: any) => n.id)).toEqual(refs);
      expect(v.nodes.filter((n: any) => n.kind === 'semantic').map((n: any) => n.id)).toEqual(sem);
      const variants = ['context', 'module'].flatMap((l) => Object.keys(tree[l]).filter((k) => !k.startsWith('$')).map((k) => `${l}.${k}`));
      expect(v.nodes.filter((n: any) => n.kind === 'context' || n.kind === 'module').map((n: any) => n.id)).toEqual(variants);
      // The other layers are not part of this view, and the view says so.
      expect([...ids].some((i) => /^(theme|lang|dir|media)\./.test(i as string))).toBe(false);
      expect(v.notes.join(' ')).toMatch(/theme, language, direction and media layers are not drawn/);
    });

    it('has an alias edge for each token whose value is a reference, and for no other', () => {
      const expected = new Set<string>();
      for (const [p, val] of Object.entries(leaves)) {
        const target = refOf(val);
        if (target && p.startsWith('semantic.')) expected.add(`${target} > ${p} : alias`);
      }
      const aliasToBase = v.edges.filter((e: any) => e.kind === 'alias' && e.to.startsWith('semantic.')).map((e: any) => e.id);
      expect(new Set(aliasToBase)).toEqual(expected);
      expect(aliasToBase).toHaveLength(expected.size);
    });

    it('has an override edge for each token a context or module re-declares, and an alias edge for each reference it uses', () => {
      const overrides = new Set<string>();
      const supplies = new Map<string, number>();
      for (const layer of ['context', 'module']) {
        const base = tree[layer].$extensions['com.familista'].overrides as string;
        for (const [p, val] of Object.entries(leaves)) {
          if (!p.startsWith(`${layer}.`)) continue;
          const [, variant, ...rest] = p.split('.');
          overrides.add(`${base}.${rest.join('.')} > ${layer}.${variant} : override`);
          const r = refOf(val);
          if (r) supplies.set(`${r} > ${layer}.${variant} : alias`, (supplies.get(`${r} > ${layer}.${variant} : alias`) || 0) + 1);
        }
      }
      expect(new Set(v.edges.filter((e: any) => e.kind === 'override').map((e: any) => e.id))).toEqual(overrides);
      const aliases = v.edges.filter((e: any) => e.kind === 'alias' && /^(context|module)\./.test(e.to));
      expect(new Map(aliases.map((e: any) => [e.id, e.count]))).toEqual(supplies);
    });

    it('classifies everything MEASURED, names the token file, and every locator is a token that exists', () => {
      for (const x of [...v.nodes, ...v.edges]) {
        expect(x.evidence).toBe('MEASURED');
        expect(x.source.id).toBe('tokens');
        const loc = String(x.source.locator).split(' → ')[0];
        const isVariant = ['context', 'module'].some((l) => Object.keys(tree[l]).some((k) => !k.startsWith('$') && loc === `${l}.${k}`));
        expect(Object.prototype.hasOwnProperty.call(leaves, loc) || isVariant).toBe(true);
      }
    });

    it('lists tokens with no relationship as such, and draws them apart from the graph', () => {
      const degree = new Map<string, number>();
      for (const e of v.edges) for (const k of [e.from, e.to]) degree.set(k, (degree.get(k) || 0) + 1);
      const alone = v.nodes.filter((n: any) => !degree.has(n.id));
      expect(v.stats.isolated).toBe(alone.length);
      expect(alone.every((n: any) => n.isolated === true)).toBe(true);
      expect(v.nodes.filter((n: any) => !n.isolated).every((n: any) => degree.has(n.id))).toBe(true);
      const lowestParked = Math.min(...alone.map((n: any) => n.y));
      const lowestGraph = Math.max(...v.nodes.filter((n: any) => !n.isolated).map((n: any) => n.y + n.h));
      expect(lowestParked).toBeGreaterThan(lowestGraph);
    });
  });

  describe('Legacy to canonical (RECORDED, from the legacy map)', () => {
    const v = view('legacy-to-canonical');

    it('has one node per declared name and one per mapped token', () => {
      const names = [...new Set(legacy.entries.map((e: any) => e.name))];
      const targets = [...new Set(legacy.entries.filter((e: any) => e.target).map((e: any) => e.target))];
      expect(v.nodes.filter((n: any) => n.kind === 'legacy').map((n: any) => n.label)).toEqual(names);
      expect(new Set(v.nodes.filter((n: any) => n.kind === 'semantic').map((n: any) => n.id))).toEqual(new Set(targets));
      for (const t of targets) expect(Object.keys(leaves)).toContain(t);
    });

    it('has one edge per mapped (name, token) pair, counting the declarations behind it', () => {
      const pairs = new Map<string, number>();
      for (const e of legacy.entries) if (e.target) pairs.set(`legacy:${e.name} > ${e.target} : maps-to`, (pairs.get(`legacy:${e.name} > ${e.target} : maps-to`) || 0) + 1);
      expect(new Map(v.edges.map((e: any) => [e.id, e.count]))).toEqual(pairs);
      expect(v.stats.edges).toBe(pairs.size);
    });

    it('draws a name the map leaves unmapped as a node with no edge, not as a guess', () => {
      const unmapped = [...new Set(legacy.entries.map((e: any) => e.name))].filter((n) => !legacy.entries.some((e: any) => e.name === n && e.target));
      const apart = v.nodes.filter((n: any) => n.kind === 'legacy' && n.isolated).map((n: any) => n.label);
      expect(apart.sort()).toEqual([...unmapped].sort());
      expect(v.nodes.filter((n: any) => n.kind === 'legacy' && n.isolated).every((n: any) => n.props.mapped === false)).toBe(true);
    });

    it('classifies a person’s mapping RECORDED and the token it points at MEASURED', () => {
      expect(v.edges.every((e: any) => e.evidence === 'RECORDED' && e.source.id === 'legacy-map')).toBe(true);
      expect(v.nodes.filter((n: any) => n.kind === 'legacy').every((n: any) => n.evidence === 'RECORDED' && n.source.id === 'legacy-map')).toBe(true);
      expect(v.nodes.filter((n: any) => n.kind === 'semantic').every((n: any) => n.evidence === 'MEASURED' && n.source.id === 'tokens')).toBe(true);
      const names = new Set(legacy.entries.map((e: any) => e.name));
      for (const n of v.nodes.filter((x: any) => x.kind === 'legacy')) expect(names.has(n.source.locator)).toBe(true);
    });
  });

  describe('Stylesheets to surfaces (MEASURED from the pages, RECORDED where a person listed it)', () => {
    const v = view('stylesheets-to-surfaces');
    const hrefs = (html: string) => [...read(html).matchAll(/<link\b[^>]*>/gi)].map((m) => m[0])
      .filter((t) => /rel=["']?stylesheet/i.test(t))
      .map((t) => (/href=["']([^"']+)["']/i.exec(t) || [])[1])
      .filter((h) => h && !/^(https?:)?\/\//i.test(h))
      .map((h) => h.split('?')[0]);
    const onDisk = (h: string, page: string) => (h.startsWith('/') ? `public${h}` : path.posix.join(path.posix.dirname(page), h));
    const edgesTo = (surface: string) => v.edges.filter((e: any) => e.to === `surface:${surface}`).sort((a: any, b: any) => a.props.loadOrder - b.props.loadOrder);
    const key = (f: string) => f.replace(/-[A-Za-z0-9_-]{8}\.css$/, '-[hash].css');

    it.each([['main', 'public/index.html'], ['admin', 'public/familista-admin.html'], ['invite', 'public/invite/index.html']])(
      '%s loads exactly the stylesheets its page links, in order, each MEASURED', (surface, page) => {
        const expected = hrefs(page).map((h) => `css:${onDisk(h, page)}`);
        expect(edgesTo(surface).map((e: any) => e.from)).toEqual(expected);
        for (const e of edgesTo(surface)) { expect(e.evidence).toBe('MEASURED'); expect(e.props.how).toBe('link'); }
        for (const f of expected) expect(fs.existsSync(path.join(ROOT, f.slice(4)))).toBe(true);
      });

    it('react loads every stylesheet in its built assets, and the lazy rooms exactly the ones the tooling lists (RECORDED)', () => {
      const built = fs.readdirSync(path.join(ROOT, 'public/app/assets')).filter((f) => f.endsWith('.css')).sort().map((f) => `css:${key(`public/app/assets/${f}`)}`);
      expect(edgesTo('react').map((e: any) => e.from)).toEqual(built);
      expect(edgesTo('react').every((e: any) => e.evidence === 'MEASURED' && e.props.how === 'directory')).toBe(true);
      const listed = edgesTo('lazy').map((e: any) => e.from);
      expect(listed).toEqual(['css:public/design-system/design-system.css', 'css:public/design-system/explorer.css', 'css:public/design-system/components.css']);
      expect(edgesTo('lazy').every((e: any) => e.evidence === 'RECORDED' && e.props.how === 'declared')).toBe(true);
      expect(read('tools/tokens/lib/production.mjs')).toContain("files: ['public/design-system/design-system.css', 'public/design-system/explorer.css', 'public/design-system/components.css']");
    });

    it('draws a stylesheet two pages load once, with an edge to each', () => {
      const from = v.edges.map((e: any) => e.from);
      const shared = [...new Set(from)].filter((f) => from.filter((x: string) => x === f).length > 1);
      for (const f of shared) expect(v.nodes.filter((n: any) => n.id === f)).toHaveLength(1);
      expect(new Set(v.nodes.map((n: any) => n.id)).size).toBe(v.nodes.length);
    });

    it('names a file for every stylesheet node, and the file exists', () => {
      for (const n of v.nodes.filter((x: any) => x.kind === 'stylesheet')) {
        const loc = String(n.source.locator);
        const real = loc.includes('[hash]') ? fs.readdirSync(path.join(ROOT, 'public/app/assets')).some((f) => key(`public/app/assets/${f}`) === loc) : fs.existsSync(path.join(ROOT, loc));
        expect(real).toBe(true);
      }
    });

    it('counts the custom properties each stylesheet declares', () => {
      const n = v.nodes.find((x: any) => x.id === 'css:public/tokens/familista-tokens.css');
      const css = read('public/tokens/familista-tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(n.props.customProperties).toBe((css.match(/^\s*--fam-[a-z0-9-]+\s*:/gm) || []).length);
      expect(n.props.canonicalTokenCss).toBe(true);
      const ex = v.nodes.find((x: any) => x.id === 'css:public/design-system/explorer.css');
      expect(ex.props.customProperties).toBe(0);   // the Explorer declares no custom property of its own
    });
  });

  it('names a source for everything, and each file source is the SHA-256 of the file it names', () => {
    expect(graph.sources.map((s: any) => s.id)).toEqual(['tokens', 'legacy-map', 'surface-loads']);
    for (const s of graph.sources.filter((x: any) => x.basis === 'file')) {
      const buf = fs.readFileSync(path.join(ROOT, s.path));
      expect(crypto.createHash('sha256').update(buf).digest('hex')).toBe(s.sha256);
      expect(buf.length).toBe(s.bytes);
    }
    expect(graph.sources.find((s: any) => s.id === 'surface-loads').basis).toBe('derived');
    for (const v of graph.views) for (const x of [...v.nodes, ...v.edges]) expect(graph.sources.map((s: any) => s.id)).toContain(x.source.id);
  });

  it('is laid out identically on every run: a second generation changes no byte', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'design-system-discover.js'), '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/current/);
  });

  it('puts every node on the canvas, none on another, and keeps a node on its column', () => {
    for (const v of graph.views) {
      for (const n of v.nodes) {
        expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
        expect(n.x).toBeGreaterThanOrEqual(0); expect(n.y).toBeGreaterThanOrEqual(0);
        expect(n.x + n.w).toBeLessThanOrEqual(v.layout.width); expect(n.y + n.h).toBeLessThanOrEqual(v.layout.height);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the validator rejects every kind of malformed relationship', () => {
  const problems = (mutate: (g: any) => void) => { const g = clone(graph); mutate(g); return core.validateGraph(g); };
  const A = (g: any) => g.views[0];

  it('accepts the committed graph', () => { expect(core.validateGraph(graph)).toEqual([]); });

  it.each([
    ['an edge to a node that does not exist', (g: any) => { A(g).edges[0].to = 'nope'; }, /does not exist/],
    ['an edge from a node that does not exist', (g: any) => { A(g).edges[0].from = 'nope'; }, /does not exist/],
    ['an edge joining a node to itself', (g: any) => { const e = A(g).edges[0]; e.to = e.from; }, /itself|not allowed/],
    ['an unknown edge kind', (g: any) => { A(g).edges[0].kind = 'depends-on'; }, /unknown kind/],
    ['an edge kind this view does not allow', (g: any) => { A(g).edges[0].kind = 'maps-to'; }, /not allowed/],
    ['an edge between kinds the table forbids (semantic → reference)', (g: any) => {
      const e = A(g).edges.find((x: any) => x.kind === 'alias' && x.from.startsWith('ref.') && x.to.startsWith('semantic.'));
      const [f, t] = [e.from, e.to]; e.from = t; e.to = f; e.id = `${t} > ${f} : alias`;
    }, /not allowed|against the flow/],
    ['an edge whose id is not from > to : kind', (g: any) => { A(g).edges[0].id = 'x'; }, /id is not/],
    ['two edges with one id', (g: any) => { A(g).edges[1].id = A(g).edges[0].id; }, /used twice/],
    ['two nodes with one id', (g: any) => { A(g).nodes[1].id = A(g).nodes[0].id; }, /used twice/],
    ['a node with no source', (g: any) => { delete A(g).nodes[0].source; }, /no source/],
    ['an edge with no source', (g: any) => { delete A(g).edges[0].source; }, /no source/],
    ['a source that is not listed', (g: any) => { A(g).nodes[0].source.id = 'elsewhere'; }, /not a listed source/],
    ['a node with no evidence state', (g: any) => { delete A(g).nodes[0].evidence; }, /no evidence/],
    ['an evidence state that is not MEASURED or RECORDED', (g: any) => { A(g).edges[0].evidence = 'INFERRED'; }, /no evidence/],
    ['a node of a kind this view does not draw', (g: any) => { A(g).nodes[0].kind = 'surface'; }, /does not draw/],
    ['an unknown node kind', (g: any) => { A(g).nodes[0].kind = 'component'; }, /unknown kind/],
    ['a node with no label', (g: any) => { A(g).nodes[0].label = ''; }, /label and a group/],
    ['an edge with no count', (g: any) => { A(g).edges[0].count = 0; }, /no count/],
    ['props that are not short scalars', (g: any) => { A(g).nodes[0].props = { deep: { nested: true } }; }, /short scalar/],
    ['a string over the length limit', (g: any) => { A(g).nodes[0].props = { long: 'x'.repeat(500) }; }, /short scalar/],
    ['a node outside the canvas', (g: any) => { A(g).nodes[0].x = 1e6; }, /outside the canvas/],
    ['a node with a non-finite coordinate', (g: any) => { A(g).nodes[0].y = Infinity; }, /no y|outside/],
    ['two nodes on one another', (g: any) => { const [a, b] = A(g).nodes; b.x = a.x; b.y = a.y; }, /overlap/],
    ['an isolated flag that disagrees with the edges', (g: any) => { A(g).nodes[0].isolated = !A(g).nodes[0].isolated; }, /isolated flag/],
    ['stats that disagree with the nodes', (g: any) => { A(g).stats.nodes += 1; }, /stats/],
    ['a changed title', (g: any) => { A(g).title = 'Something else'; }, /title or summary/],
    ['a changed flow', (g: any) => { A(g).flow = ['A', 'B']; }, /flow differs/],
    ['an extra view', (g: any) => { g.views.push(clone(g.views[0])); }, /listed twice|exactly/],
    ['a missing view', (g: any) => { g.views.pop(); }, /exactly/],
    ['an unknown view', (g: any) => { g.views[0].id = 'components'; }, /unknown view|exactly/],
    ['a wrong schema', (g: any) => { g.schema = 2; }, /schema/],
    ['a malformed source (no digest)', (g: any) => { g.sources[0].sha256 = 'abc'; }, /source is malformed/],
    ['a source listed twice', (g: any) => { g.sources[1].id = g.sources[0].id; }, /listed twice/],
    ['no views at all', (g: any) => { g.views = 'none'; }, /arrays/],
  ])('%s', (_name, mutate, expected) => {
    const found = problems(mutate as (g: any) => void);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join('\n')).toMatch(expected as RegExp);
  });

  it('rejects a non-object', () => {
    expect(core.validateGraph(null)).not.toEqual([]);
    expect(core.validateGraph('graph')).not.toEqual([]);
    expect(core.validateGraph([])).not.toEqual([]);
  });

  it('the generator refuses to write a graph that does not validate', () => {
    const src = read('scripts/design-system-graph.js');
    expect(src).toMatch(/core\.validateGraph\(graph\)/);
    expect(src).toMatch(/throw new Error\('the design-system graph is malformed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the API: GET-only, authenticated and Platform-Owner-only, on the server', () => {
  const urls = ['', '?view=token-architecture', '?view=legacy-to-canonical', '?view=stylesheets-to-surfaces'];

  it.each(urls)('GET /graph%s without a session is 401', async (q) => { expect((await get(q)).status).toBe(401); });
  it.each(urls)('GET /graph%s as a club administrator is 403', async (q) => { expect((await get(q, ['u-cadmin', 'CLUB_ADMIN'])).status).toBe(403); });
  it.each(urls)('GET /graph%s as a head coach is 403', async (q) => { expect((await get(q, ['u-coach', 'HEAD_COACH'])).status).toBe(403); });
  it.each(urls)('GET /graph%s as the platform owner is 200 and not cacheable', async (q) => {
    const res = await get(q, OWNER);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.success).toBe(true);
  });
  it.each(urls)('GET /graph%s is also open to a platform administrator, whatever their club role', async (q) => {
    expect((await get(q, ['u-padmin', 'CLUB_ADMIN'])).status).toBe(200);
  });

  it('refuses the denied roles before it reads a thing: no node reaches a club role', async () => {
    const res = await get('?view=token-architecture', ['u-cadmin', 'CLUB_ADMIN']);
    expect(JSON.stringify(res.body)).not.toMatch(/semantic\.surface|nodes|edges/);
  });

  it('answers the index with the contract the Explorer reads, and no nodes', async () => {
    const res = await get('', OWNER);
    expect(DesignSystemGraphIndexSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data).toMatchObject({ state: 'READY', readOnly: true });
    expect(res.body.data.views.map((v: any) => v.id)).toEqual(['token-architecture', 'legacy-to-canonical', 'stylesheets-to-surfaces']);
    expect(JSON.stringify(res.body)).not.toMatch(/"nodes":\[|"edges":\[/);
    expect(res.body.data.views.every((v: any) => v.stats.nodes > 0)).toBe(true);
  });

  it.each(['token-architecture', 'legacy-to-canonical', 'stylesheets-to-surfaces'])('answers ?view=%s with that view, whole, under its contract', async (id) => {
    const res = await get(`?view=${id}`, OWNER);
    expect(DesignSystemGraphViewSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data.view.id).toBe(id);
    expect(res.body.data.view.nodes).toHaveLength(view(id).nodes.length);
    expect(res.body.data.view.edges).toHaveLength(view(id).edges.length);
    expect(res.body.data.sources.map((s: any) => s.id)).toEqual(['tokens', 'legacy-map', 'surface-loads']);
  });

  it.each([
    ['an unknown view', '?view=components'],
    ['a view that only looks like a path', '?view=../token-architecture'],
    ['a prototype key', '?view=__proto__'],
    ['an empty view', '?view='],
    ['a different case', '?view=Token-Architecture'],
    ['a view with a suffix', '?view=token-architecture%00'],
  ])('answers %s with 404', async (_n, q) => { expect((await get(q, OWNER)).status).toBe(404); });

  it.each([
    ['a second value', '?view=token-architecture&view=legacy-to-canonical'],
    ['an array', '?view[]=token-architecture'],
    ['an object', '?view[a]=b'],
    ['any other parameter', '?view=token-architecture&limit=5'],
    ['a parameter that is not view', '?q=x'],
  ])('answers %s with 400', async (_n, q) => { expect((await get(q, OWNER)).status).toBe(400); });

  it.each(['post', 'put', 'patch', 'delete'] as const)('refuses %s on /graph, as the owner too', async (verb) => {
    for (const q of ['', '?view=token-architecture']) {
      const res = await request(app)[verb](`/api/v1/system/design-system/graph${q}`).set('Authorization', `Bearer ${token(...OWNER)}`).send({});
      expect(res.status).toBe(404);
    }
  });

  it('exposes no environment value, secret or connection string', async () => {
    const text = JSON.stringify([(await get('', OWNER)).body, ...(await Promise.all(urls.slice(1).map((q) => get(q, OWNER)))).map((r) => r.body)]);
    expect(text).not.toContain(process.env.JWT_ACCESS_SECRET as string);
    expect(text).not.toContain(process.env.JWT_REFRESH_SECRET as string);
    expect(text).not.toMatch(/postgres(ql)?:\/\/|api[_-]?key|password/i);
  });

  it('keeps the router GET-only and looks `view` up in a fixed list, never in a path, a query or a shell', () => {
    const src = read('src/routes/design-system.routes.ts');
    expect(src.match(/router\.(get|post|put|patch|delete|all|use)\(/g)).toEqual(['router.use(', 'router.use(', 'router.get(', 'router.get(', 'router.get(', 'router.get(']);
    expect(src).toContain("router.get('/graph'");
    expect(src).toContain('isGraphViewId(view)');
    expect(src).not.toMatch(/req\.params|path\.join|readFile|exec\(|spawn\(/);
    const svc = read('src/design-system/design-system.service.ts');
    expect(svc).toMatch(/graphCore\.VIEW_IDS\.indexOf\(id\) >= 0/);
    expect(svc).not.toMatch(/readFileSync\([^)]*\bid\b/);
  });

  it('is registered in the API contract registry, with its consumer, for both shapes', () => {
    const entries = OWNER_API_CONTRACTS.filter((c) => c.endpoint === '/system/design-system/graph');
    expect(entries.map((c) => c.query ?? '')).toEqual(['', '?view=token-architecture']);
    for (const c of entries) expect(c.consumer).toBe('public/design-system/explorer.js');
  });

  describe('a graph that cannot be trusted is never served', () => {
    const file = path.join(ROOT, GRAPH_PATH);
    const withFile = async (body: string | Error, run: () => Promise<void>) => {
      const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
        if (String(p) === file) { if (body instanceof Error) throw body; return body; }
        return (jest.requireActual('fs') as typeof fs).readFileSync(p as string, ...(rest as [BufferEncoding]));
      }) as typeof fs.readFileSync);
      try { resetDesignSystemGraphCache(); await run(); } finally { spy.mockRestore(); resetDesignSystemGraphCache(); }
    };

    it('says NOT_GENERATED, and why, when the graph manifest is not beside the server', async () => {
      await withFile(new Error('ENOENT'), async () => {
        const idx = await get('', OWNER);
        expect(idx.status).toBe(200);
        expect(idx.body.data).toMatchObject({ state: 'NOT_GENERATED', views: [], sources: [] });
        expect(idx.body.data.reason).toMatch(/not beside this server/);
        expect(DesignSystemGraphIndexSchema.safeParse(idx.body.data).success).toBe(true);
        const one = await get('?view=token-architecture', OWNER);
        expect(one.body.data).toMatchObject({ state: 'NOT_GENERATED', view: null });
        expect(DesignSystemGraphViewSchema.safeParse(one.body.data).success).toBe(true);
      });
    });

    it('refuses the whole graph, and serves no node of it, when one relationship is malformed', async () => {
      const bad = clone(graph);
      bad.views[0].edges[0].to = 'a node that does not exist';
      await withFile(JSON.stringify(bad), async () => {
        const idx = await get('', OWNER);
        expect(idx.body.data).toMatchObject({ state: 'NOT_GENERATED', views: [] });
        expect(idx.body.data.reason).toMatch(/failed its integrity check/);
        const other = await get('?view=stylesheets-to-surfaces', OWNER);   // an untouched view is refused too
        expect(other.body.data).toMatchObject({ state: 'NOT_GENERATED', view: null });
        expect(JSON.stringify(other.body)).not.toMatch(/css:public/);
      });
    });

    it('refuses a graph that is not JSON, or is not schema 1', async () => {
      await withFile('{not json', async () => { expect((await get('', OWNER)).body.data.state).toBe('NOT_GENERATED'); });
      await withFile(JSON.stringify({ ...graph, schema: 99 }), async () => { expect((await get('', OWNER)).body.data.state).toBe('NOT_GENERATED'); });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the Explorer client: CSP-safe, GET-only, lazy, and read-only', () => {
  const js = stripComments(read('public/design-system/explorer.js'));
  const css = stripComments(read('public/design-system/explorer.css'));
  const room = stripComments(read('public/design-system/design-system.js'));

  it('writes no style attribute, inline handler or inline script: positions are SVG attributes, states are classes', () => {
    expect(js).not.toMatch(/style="|style='|setAttribute\(\s*['"]style|\.style\.|onclick=|onerror=|onload=|javascript:/i);
  });

  it('never evaluates code and loads nothing from another origin', () => {
    expect(js).not.toMatch(/\beval\(|new Function\(|document\.write|importScripts|<script|<style|@import|\bsrcdoc\b|<iframe|<object|<embed/);
    expect(js + css).not.toMatch(/https?:\/\//);
  });

  it('makes no network call of its own: the only reader it has is the room’s GET-only api(), and it reaches exactly the two graph shapes', () => {
    expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
    expect([...js.matchAll(/K\.api\(\s*('[^']+'(?:\s*\+\s*encodeURIComponent\(id\))?)\)/g)].map((m) => m[1])).toEqual([
      "'/system/design-system/graph'",
      "'/system/design-system/graph?view=' + encodeURIComponent(id)",
    ]);
    expect(room).toContain("method: 'GET'");
    expect(room).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/i);
  });

  it('has no control that changes anything: it holds no write verb, no save, no edit, no generate', () => {
    expect(js).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b|localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(js).not.toMatch(/contenteditable|<textarea|type="file"|FileReader|download=/i);
  });

  it('consumes canonical tokens and declares none of its own', () => {
    expect(css).not.toMatch(/^\s*--[a-z]/m);
    for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) expect(m[1]).toMatch(/^--fam-/);
    // Amber is the selection; green and red are results, and this screen reports none.
    expect(css).toContain('var(--fam-module-accent)');
    expect(css).not.toMatch(/--fam-status-(success|critical)/);
  });

  it('is loaded only when its section opens: no page, no loader and no Owner Home reference names it', () => {
    expect(read('public/index.html')).not.toMatch(/explorer\.(js|css)/);
    expect(read('public/app.js')).not.toMatch(/design-system\/explorer/);
    expect(room).toContain("css: '/design-system/explorer.css'");
    expect(room).toContain("js: '/design-system/explorer.js'");
    expect(room).toContain("L.css + '?v=' + L.v");
    expect(room).toContain("L.js + '?v=' + L.v");
    // The loader is reached from exactly one place: mounting the section.
    expect(room.match(/loadAssets\(/g)).toHaveLength(2);         // its definition and mountLazy, the one place that calls it
    expect(room).toMatch(/function mountLazy\(host\) \{\s*var key = DS\.section, L = LAZY\[key\];/);
    expect(room).toMatch(/explorer: \{[^}]*host: 'ex-host'/);
  });

  it('leaves Owner Home alone: the room’s only change there is a section of its own', () => {
    expect(room).toContain("['explorer', 'Visual Explorer']");
    expect(read('public/app.js')).toContain('data-page="design-system"');
  });

  it('gives the page a workspace that scrolls inside itself and a way out below 980px or 620px', () => {
    expect(css).toMatch(/\.ds-body--workspace \{ overflow: hidden;/);
    expect(css).toMatch(/\.ex-insp \{[^}]*overflow-y: auto; scrollbar-gutter: stable;/);
    expect(css).toMatch(/\.ex-tbl \{[^}]*overflow: auto; scrollbar-gutter: stable;/);
    expect(css).toMatch(/@media \(max-width: 980px\), \(max-height: 620px\)/);
    expect(css).toMatch(/\.ex-pop \{[^}]*position: absolute;/);
    expect(css).toMatch(/\.ex-over \{ position: absolute;/);
    expect(css).toMatch(/\.ex-pop \{[^}]*transition: opacity[^;]*, transform/);
  });

  it('respects reduced motion: no animation of its own, and the camera does not tween', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*\.ex-pop \{ transition: none; \}/);
    expect(js).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(js).toMatch(/if \(!animate \|\| reduced\(\)\)/);
  });

  it('keeps colour from being the only signal: a shape per kind, a heading per column, a dash per kind of edge and per evidence', () => {
    const shapes = [...js.matchAll(/^\s+(circle|square|diamond|hexagon|triangle|page|ring): '/gm)].map((m) => m[1]);
    expect(new Set(shapes).size).toBe(7);
    const kinds = Object.keys(JSON.parse(JSON.stringify(Object.fromEntries(core.NODE_KINDS.map((k: string) => [k, 1])))));
    for (const k of kinds) expect(js).toMatch(new RegExp(`\\b${k.replace('-', '\\-')}: \\{ label: '[^']+', glyph: '[a-z]+', tone: '[abcn]' \\}`));
    expect(css).toContain('.ex-e-override .ex-eline { stroke-dasharray');
    expect(css).toContain('.ex-e.is-rec .ex-eline { stroke-dasharray');
    expect(css).toContain('.ex-n.is-rec .ex-nb { stroke-dasharray');
    // Layers use the chart tokens that pass 3:1 on the canvas; categorical-7 does not and is not used.
    expect(css).toMatch(/var\(--fam-chart-categorical-1\)[\s\S]*var\(--fam-chart-categorical-3\)[\s\S]*var\(--fam-chart-categorical-5\)/);
    expect(css).not.toContain('categorical-7');
  });

  it('is operable without a mouse: roving focus, arrows, Enter, Shift+arrows, + − 0, Escape, and zoom buttons', () => {
    for (const needle of ['ArrowRight:', 'ArrowLeft:', 'ArrowDown:', 'ArrowUp:', "'Enter'", "ev.key === '0'", "ev.key === '+'", "'Escape'", 'data-ex-zoom="in"', 'data-ex-zoom="out"', 'data-ex-zoom="fit"', 'role="button"', 'aria-pressed', 'tabindex="-1"']) {
      expect(js).toContain(needle);
    }
    expect(js).toContain('aria-describedby="ex-help"');
    expect(js).toContain('aria-live="polite"');
  });

  it('offers a screen-reader table of exactly the same nodes and relationships', () => {
    expect(js).toContain('<table class="ds-table ex-table"><caption class="ds-sr">');
    expect(js).toMatch(/scope="col"/);
    expect(js).toContain("m.vis[n.id]");
    expect(js).toContain("m.visEdge[e.id]");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the Explorer escapes whatever the manifest says (run for real, in a sandbox, with hostile data)', () => {
  const PAYLOAD = '"><img src=x onerror=alert(1)><script>alert(2)</script>';

  /** A DOM just big enough to run the client: every element records what is written to it. */
  function runExplorer(payload: any): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vm = require('vm');
    const written: string[] = [];
    const listeners: Record<string, (e: unknown) => void> = {};
    const els: Record<string, any> = {};
    const el = (id: string): any => {
      if (els[id]) return els[id];
      const e: any = {
        id, hidden: false, textContent: '', clientWidth: 900, clientHeight: 600, disabled: false, scrollTop: 0, value: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        set innerHTML(v: string) { written.push(String(v)); this._h = String(v); }, get innerHTML() { return this._h || ''; },
        setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
        querySelector: (s: string) => (s === '.ex' ? el('ex-root') : null), querySelectorAll: () => [], getElementsByTagName: () => [],
        addEventListener: (t: string, fn: (ev: unknown) => void) => { if (id === 'host') listeners[t] = fn; }, removeEventListener() {},
        contains: () => false, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }),
        parentNode: { querySelectorAll: () => [] }, setPointerCapture() {},
      };
      els[id] = e;
      return e;
    };
    const host = el('host');
    const kit = {
      T: (s: string) => s, tf: (s: string, ...a: unknown[]) => { let i = 0; return s.replace(/%d/g, () => String(a[i++])); },
      esc: (v: unknown) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)),
      num: (n: number) => String(n), code: (v: unknown) => `<code data-no-i18n>${String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))}</code>`,
      kv: (l: string, v: string) => `<div class="ds-kv"><div>${l}</div><div>${v}</div></div>`,
      evChip: (s: string) => `<span>${s}</span>`, emptyState: (t: string, w: string) => `<div>${t}${w}</div>`, skeleton: () => '<div></div>',
      contractError: (e: string, m: string[]) => `${e}${m.join()}`, dir: () => 'ltr',
      api: (p: string) => Promise.resolve(p.includes('?view=') ? payload.view : payload.index),
    };
    const sandbox: any = {
      window: {} as any, document: { getElementById: el, addEventListener() {}, removeEventListener() {}, activeElement: null, createElement: () => el('x') },
      performance: { now: () => Date.now() }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout,
      matchMedia: () => ({ matches: false }), Math, JSON, Object, Array, String, Number, Date, Promise, isFinite, parseInt, console, Map, Set,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(read('public/design-system/explorer.js'), sandbox);
    sandbox.FamilistaDesignExplorer.mount(host, kit);
    const settle = () => new Promise((r) => setTimeout(r, 40));
    const click = (closest: Record<string, any>) => listeners.click({ target: { closest: (s: string) => closest[s] ?? null } });
    return settle().then(() => {
      // Select the first node by clicking it, then a relationship, then open the table in both of its tabs.
      const v = payload.view.view;
      if (v) {
        click({ '#ex-canvas': {}, '[data-n]': { getAttribute: () => v.nodes[0].id } });
        click({ '#ex-canvas': {}, '[data-e]': { getAttribute: () => v.edges[0].id } });
      }
      click({ '[data-ex-mode]': { getAttribute: () => 'table' } });
      click({ '[data-ex-tab]': { getAttribute: () => 'edges' } });
      click({ '[data-ex-tab]': { getAttribute: () => 'nodes' } });
      click({ '[data-ex-filters]': {} });
      return settle();
    }).then(() => written.join('\n'));
  }

  const hostile = () => {
    const v = clone(view('token-architecture'));
    const n = v.nodes[0];
    Object.assign(n, { id: PAYLOAD, label: PAYLOAD, group: PAYLOAD });
    n.props = { cssName: PAYLOAD, value: PAYLOAD, description: PAYLOAD, anything: PAYLOAD };
    n.source = { id: 'tokens', locator: PAYLOAD };
    // Every edge that touched the first node now touches the hostile id.
    const old = view('token-architecture').nodes[0].id;
    for (const e of v.edges) { if (e.from === old) e.from = PAYLOAD; if (e.to === old) e.to = PAYLOAD; e.id = `${e.from} > ${e.to} : ${e.kind}`; e.source.locator = PAYLOAD; e.props = { note: PAYLOAD }; }
    v.title = PAYLOAD; v.summary = PAYLOAD; v.flow = [PAYLOAD, PAYLOAD, PAYLOAD]; v.notes = [PAYLOAD];
    v.columns[0].label = PAYLOAD;
    const sources = clone(graph.sources); sources[0].path = PAYLOAD; sources[0].label = PAYLOAD;
    return {
      index: { state: 'READY', reason: null, readOnly: true, generator: PAYLOAD, sources, views: graph.views.map((g: any) => ({ id: g.id, title: g.title, summary: g.summary, flow: g.flow, sources: g.sources, notes: g.notes, layout: g.layout, stats: g.stats })) },
      view: { state: 'READY', reason: null, sources, view: v },
    };
  };

  it('prints hostile strings as text in the graph, the inspector, the breadcrumb, the legend, the filters and both tables', async () => {
    const out = await runExplorer(hostile());
    expect(out.length).toBeGreaterThan(5000);
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).not.toMatch(/<(img|script)\b/);
    expect(out).not.toMatch(/"[^"<>]*"><img/);
    expect(out).not.toContain(PAYLOAD);
  });

  it('draws a normal view into every part of the screen without throwing, and says 0 where it measured 0', async () => {
    const v = clone(view('token-architecture'));
    const sources = graph.sources;
    const out = await runExplorer({
      index: { state: 'READY', reason: null, readOnly: true, generator: graph.generator, sources, views: [] },
      view: { state: 'READY', reason: null, sources, view: v },
    });
    expect(out).toContain('data-n="ref.color.navy.950"');
    expect(out).toContain('class="ex-colhead"');
    expect(out).toContain('ds-table ex-table');
    expect(out).toContain('Where it comes from');
    expect(out).toMatch(/tools\/tokens\/familista\.tokens\.json/);
  });

  it('says why when the graph could not be generated, and draws nothing it did not read', async () => {
    const out = await runExplorer({
      index: { state: 'NOT_GENERATED', reason: 'The design-system graph manifest is not beside this server (run scripts/design-system-discover.js).', readOnly: true, generator: null, sources: [], views: [] },
      view: { state: 'NOT_GENERATED', reason: 'not here', sources: [], view: null },
    });
    expect(out).toContain('The graph could not be read');
    expect(out).toContain('not beside this server');
    expect(out).not.toContain('data-n=');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('English, German and Arabic: everything the Explorer can say is in all three catalogues', () => {
  const dict = (t: string) => json(`public/design-system/i18n/${t}.json`) as Record<string, string>;
  const en = dict('en'); const de = dict('de'); const ar = dict('ar');
  const js = read('public/design-system/explorer.js');
  const room = read('public/design-system/design-system.js');
  const unescape = (s: string) => s.replace(/\\'/g, "'");
  const mapValues = (src: string, name: string) => {
    const at = src.indexOf(`var ${name} = {`);
    let depth = 0; let end = at;
    for (let i = src.indexOf('{', at); i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i; break; } }
    return [...src.slice(at, end).matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1]));
  };

  it('covers every literal the Explorer passes through T(), tf() and the room’s helpers', () => {
    const calls = [...js.matchAll(/\b(?:T|tf|K\.kv|K\.emptyState)\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1]));
    const keys = [...new Set(calls)].filter((k) => /[A-Za-z]{2}/.test(k));
    expect(keys.length).toBeGreaterThan(50);
    expect(keys.filter((k) => !(k in en))).toEqual([]);
    expect(keys.filter((k) => !(k in de) || !(k in ar))).toEqual([]);
  });

  it('covers every label, meaning and heading held in the Explorer’s vocabulary maps', () => {
    const values = ['KIND', 'EDGE', 'PROP', 'HOW', 'VIEW_TAB', 'BASIS'].flatMap((n) => mapValues(js, n))
      .filter((v) => !/^(circle|square|diamond|hexagon|triangle|page|ring|[abcn])$/.test(v) && !/^M[-\d]/.test(v));
    expect(values.length).toBeGreaterThan(30);
    expect(values.filter((v) => !(v in en))).toEqual([]);
  });

  it('covers every title, summary, heading, note and source label the graph manifest hands it', () => {
    const fromGraph = [
      ...graph.sources.map((s: any) => s.label),
      ...graph.views.flatMap((v: any) => [v.title, v.summary, ...v.flow, ...v.notes, ...v.columns.map((c: any) => c.label)]),
    ] as string[];
    expect(fromGraph.filter((k) => !(k in en))).toEqual([]);
    expect(fromGraph.filter((k) => !(k in de) || !(k in ar))).toEqual([]);
  });

  it('covers the reasons the server and the room give when the graph is missing or cannot load', () => {
    const svc = read('src/design-system/design-system.service.ts');
    for (const reason of ['The design-system graph manifest is not beside this server (run scripts/design-system-discover.js).',
      'The design-system graph manifest failed its integrity check, so none of it is served.']) {
      expect(svc).toContain(reason);
      expect(en).toHaveProperty([reason]);
    }
    for (const k of ['The Visual Explorer could not be loaded', 'Reload the page and try again.']) {
      expect(room).toContain(k);
      expect(en).toHaveProperty([k]);
    }
  });

  it('translates every new key into German and Arabic, with every %d slot kept and Arabic in Arabic script', () => {
    const slots = (s: string) => (s.match(/%d/g) || []).length;
    const SAME = new Set(['Alias', 'Details', 'Graph', 'Name', 'Stylesheet', 'Stylesheets', 'Zoom']);   // the Components Library's own SAME set lives in its suite
    for (const k of Object.keys(en)) {
      expect(slots(de[k])).toBe(slots(k));
      // A singular form ("one rule") may spell the number as a word, as Arabic does.
      if (!/^%d (rule|variant|case)$/.test(k)) expect(slots(ar[k])).toBe(slots(k));
    }
    for (const k of ['Visual Explorer', 'Token architecture', 'Legacy to canonical', 'Stylesheets to surfaces', 'Focus neighbourhood', 'Show nodes with no relationship']) {
      expect(de[k]).not.toBe(k);
      expect(ar[k]).toMatch(/[\u0600-\u06FF]/);
    }
    expect([...SAME].every((k) => ar[k] !== k && /[\u0600-\u06FF]/.test(ar[k]))).toBe(true);
  });

  it('keeps the room’s own boundary: no entry into the club product’s language registry, bundles or catalogue', () => {
    expect(js).not.toMatch(/\bI18N\b|\/i18n\/locales|\/i18n\/catalogue|familista\.locale/);
    expect(read('public/app.js')).toContain('id="pg-design-system" data-no-i18n');
  });
});

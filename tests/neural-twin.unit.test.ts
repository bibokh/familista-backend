/**
 * tests/neural-twin.unit.test.ts
 *
 * Familista Neural Digital Twin, Phase 1: the graph, its API and its room.
 *
 *   1. The composer is deterministic and its graph keeps every invariant, with
 *      negative controls showing each invariant can fail.
 *   2. The graph exposes nothing it must not (addresses, hosts, credentials,
 *      environment variable names, e-mail addresses), with negative controls.
 *   3. Accuracy, checked independently of the composer: every authority's items
 *      appear as it states them, and sampled import and data edges are re-read
 *      from the source line they cite (a fabricated edge is caught).
 *   4. The API is owner-only on the server: anonymous 401, a club account 403,
 *      the owner 200, never cached, and the body keeps its contract.
 *   5. The room keeps the owner-room rules: its own catalogue in three languages,
 *      no inline style or handler, tokens only, the escape hatch, the vendored
 *      Babylon.js only, and the shell's wiring.
 */
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);

const OWNER = {
  id: 'u-owner', email: 'owner@familista.test', role: 'SUPER_ADMIN', clubId: null, isActive: true,
  currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: { isActive: true },
};
const MEMBER = {
  id: 'u-member', email: 'coach@club.test', role: 'COACH', clubId: 'c1', isActive: true,
  currentClubId: 'c1', currentTeamId: null, tokenVersion: 0, platformAdmin: null,
};
let CURRENT: typeof OWNER | typeof MEMBER = OWNER;

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$transaction') return async (fns: unknown) => (Array.isArray(fns) ? [] : (fns as (tx: unknown) => unknown)({}));
      if (k === '$connect' || k === '$disconnect') return async () => {};
      if (k === 'user') return { findFirst: async () => CURRENT, findUnique: async () => CURRENT, count: async () => 1 };
      return new Proxy({}, { get: (_x, op: string) => async () => (op === 'count' ? 0 : op === 'findFirst' || op === 'findUnique' ? null : []) });
    },
  }),
}));

import { composeTwin, TWIN_PATHS } from '../src/platform/neural-twin/compose';
import { twinExposureProblems, twinGraphProblems, type TwinGraph } from '../src/platform/neural-twin/model';
import { resetTwinGraphCache } from '../src/platform/neural-twin/store';
import { PLATFORM_AGENT_MANIFESTS } from '../src/platform/agents/catalog';
import { SYSTEM_MODULES } from '../src/platform/system-modules';
import { NeuralTwinGraphSchema } from '../src/contracts/owner-api.contracts';
import { signToken } from '../src/security/jwt-tokens';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));
const json = (p: string) => JSON.parse(read(p));
const G: TwinGraph = composeTwin(ROOT);
const byId = new Map(G.nodes.map((n) => [n.id, n]));
const clone = (): TwinGraph => JSON.parse(JSON.stringify(G));

describe('1. the composer: deterministic, and every invariant holds', () => {
  it('composes the same graph twice, byte for byte', () => {
    expect(JSON.stringify(composeTwin(ROOT))).toBe(JSON.stringify(G));
  });

  it('keeps every invariant, and every evidence path exists in the repository', () => {
    expect(twinGraphProblems(G, exists)).toEqual([]);
  });

  it('holds every kind of architecture the task names', () => {
    for (const k of ['system', 'component', 'module', 'file', 'api', 'model', 'agent', 'boundary']) expect(G.counts.nodes[k]).toBeGreaterThan(0);
    for (const k of ['IMPORTS', 'DATA', 'DEPENDS_ON', 'INFRA', 'IMPLEMENTED_BY', 'IN_BOUNDARY', 'USES_TOOLS']) expect(G.counts.edges[k]).toBeGreaterThan(0);
    expect(G.nodes.length).toBe(Object.values(G.counts.nodes).reduce((a, b) => a + b, 0));
    expect(G.edges.length).toBe(Object.values(G.counts.edges).reduce((a, b) => a + b, 0));
  });

  it.each([
    ['a duplicate id', (g: TwinGraph) => { g.nodes.push({ ...g.nodes[1] }); }, /duplicate node id/],
    ['an edge to a node that does not exist', (g: TwinGraph) => { g.edges.push({ ...g.edges[0], to: 'file:src/nowhere.ts' }); }, /edge to a missing node/],
    ['a node whose parent does not exist', (g: TwinGraph) => { g.nodes.find((n) => n.kind === 'file')!.parent = 'module:nowhere'; }, /parent module:nowhere does not exist/],
    ['a node with no evidence', (g: TwinGraph) => { g.nodes.find((n) => n.kind === 'api')!.evidence = []; }, /no evidence/],
    ['an edge with no evidence', (g: TwinGraph) => { g.edges[0].evidence = []; }, /has no evidence/],
    ['IMPLEMENTED on a composer rule alone', (g: TwinGraph) => { const n = g.nodes.find((x) => x.kind === 'module')!; n.evidence = [{ a: 'composer-rule', p: 'src' }]; }, /IMPLEMENTED without evidence from an authority/],
    ['a planned node citing code as its own', (g: TwinGraph) => { g.nodes.find((n) => n.kind === 'planned')!.evidence.push({ a: 'repository', p: 'src/app.ts' }); }, /planned node cites code/],
    ['an evidence path outside the repository', (g: TwinGraph) => { g.nodes[0].evidence[0].p = '/etc/passwd'; }, /not a repository path/],
    ['an evidence path that is a URL', (g: TwinGraph) => { g.nodes[0].evidence[0].p = 'https:x'; }, /not a repository path/],
    ['an evidence path that does not exist', (g: TwinGraph) => { g.nodes[0].evidence[0].p = 'src/does-not-exist.ts'; }, /does not exist/],
    ['a parent chain that loops', (g: TwinGraph) => { const s = g.nodes.find((n) => n.id === 'system:devices')!; s.parent = 'module:vision'; }, /a system nests under nothing|loops/],
  ])('negative control: %s is refused', (_name, mutate, msg) => {
    const g = clone();
    mutate(g);
    expect(twinGraphProblems(g, exists).join('\n')).toMatch(msg);
  });
});

describe('2. exposure: the graph carries no address, host, credential, environment name or e-mail', () => {
  const envNames = Object.keys(json(TWIN_PATHS.coverage).components.envVars);
  it('passes the exposure scan over everything the API sends', () => {
    expect(envNames.length).toBeGreaterThan(20);
    expect(twinExposureProblems(JSON.stringify(G), envNames)).toEqual([]);
  });
  it('carries no field the composer does not allow-list (no provider, region, version or runtime of a component)', () => {
    for (const n of G.nodes.filter((x) => x.kind === 'component')) {
      for (const k of ['provider', 'region', 'version', 'runtime']) expect(n.facts && k in n.facts).toBeFalsy();
    }
  });
  it.each([
    ['a URL', 'https://familista-backend.example/x'],
    ['a hosted address', 'familista-backend.onrender.com'],
    ['an IP address', '10.0.0.12'],
    ['an e-mail address', 'owner@familista.test'],
    // Assembled at runtime so the repository never holds a secret-shaped literal.
    ['a secret-shaped value', ['sk', 'live', '0123456789abcdef'].join('_')],
    ['an environment variable name', 'DATABASE_URL'],
  ])('negative control: %s is caught', (_name, value) => {
    const g = clone();
    g.nodes[0].summary = 'leak: ' + value;
    expect(twinExposureProblems(JSON.stringify(g), envNames).length).toBeGreaterThan(0);
  });
});

describe('3. accuracy, checked against the authorities and the source, not against the composer', () => {
  const infra = json(TWIN_PATHS.infra), sec = json(TWIN_PATHS.security), cov = json(TWIN_PATHS.coverage);

  it('every district is a system and every component sits in its district', () => {
    for (const d of infra.districts) expect(byId.get('system:' + d.id)?.label).toBe(d.name);
    for (const c of infra.components) expect(byId.get('component:' + c.id)?.parent).toBe('system:' + c.district);
    for (const f of infra.future) expect(byId.get('planned:' + f.id)?.maturity).toBe('PLANNED');
  });

  it('every mounted router is an API node with its mount and handler count from the security manifest', () => {
    for (const m of sec.apiSurface.mounts) {
      const n = byId.get('api:' + m.module);
      expect(n?.facts?.mount).toBe('/api/v1' + m.path);
      expect(n?.facts?.handlers).toBe(m.handlers);
    }
    expect(G.counts.nodes.api).toBe(sec.apiSurface.mounts.length);
  });

  it('every registry agent is an agent node with its own tools, and every SYSTEM module keeps its readiness', () => {
    for (const a of PLATFORM_AGENT_MANIFESTS) expect(byId.get('agent:' + a.id)?.facts?.tools).toEqual([...a.tools]);
    expect(G.counts.nodes.agent).toBe(PLATFORM_AGENT_MANIFESTS.length);
    for (const m of SYSTEM_MODULES) expect(byId.get('sysmodule:' + m.key)?.facts?.readiness).toBe(m.readiness);
  });

  it('every trust boundary is a node with the coverage the map records', () => {
    for (const [row, b] of Object.entries(cov.boundaries as Record<string, { coverage: string }>)) expect(byId.get('boundary:' + row)?.facts?.coverage).toBe(b.coverage);
  });

  // An import edge is re-read from the line it cites: the line must import a path that resolves to the target file.
  const resolveSpec = (from: string, spec: string) => {
    const base = spec.startsWith('@/') ? 'src/' + spec.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    return [base + '.ts', base + '/index.ts', base].find((c) => exists(c) && c.endsWith('.ts')) || null;
  };
  const fileOf = (id: string) => (id.startsWith('file:') ? id.slice(5) : id.startsWith('api:') ? 'src/routes/' + id.slice(4) + '.ts' : null);
  const importHolds = (e: { from: string; to: string; evidence: Array<{ p: string; l?: number }> }) => {
    const ev = e.evidence[0];
    const line = read(ev.p).split('\n')[(ev.l || 1) - 1] || '';
    const specs = [...line.matchAll(/(?:from\s+|require\(\s*|import\(\s*|import\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    return specs.some((s) => resolveSpec(ev.p, s) === fileOf(e.to));
  };
  it('sampled import edges are real: the cited line imports the target', () => {
    const imports = G.edges.filter((e) => e.kind === 'IMPORTS');
    const sample = imports.filter((_e, i) => i % Math.ceil(imports.length / 40) === 0);
    expect(sample.length).toBeGreaterThanOrEqual(35);
    const wrong = sample.filter((e) => !importHolds(e)).map((e) => e.from + ' -> ' + e.to + ' @ ' + e.evidence[0].p + ':' + e.evidence[0].l);
    expect(wrong).toEqual([]);
  });
  it('negative control: a fabricated import edge is caught by the same check', () => {
    const real = G.edges.find((e) => e.kind === 'IMPORTS' && e.from.startsWith('file:') && e.to.startsWith('file:'))!;
    expect(importHolds(real)).toBe(true);
    expect(importHolds({ ...real, to: 'file:src/app.ts' })).toBe(false);
  });

  it('sampled data edges are real: the cited line calls a Prisma model of the target section', () => {
    const schema = read(TWIN_PATHS.schema);
    const data = G.edges.filter((e) => e.kind === 'DATA');
    const sample = data.filter((_e, i) => i % Math.ceil(data.length / 30) === 0);
    const wrong = sample.filter((e) => {
      const models = (byId.get(e.to)!.facts!.models as string[]).map((m) => m.charAt(0).toLowerCase() + m.slice(1));
      const ev = e.evidence[0];
      const line = read(ev.p).split('\n')[(ev.l || 1) - 1] || '';
      return !models.some((d) => new RegExp('\\.\\s*' + d + '\\s*\\.').test(line)) || !models.every((m) => new RegExp('^model ' + m.charAt(0).toUpperCase() + m.slice(1) + '\\b', 'm').test(schema));
    }).map((e) => e.from + ' -> ' + e.to);
    expect(wrong).toEqual([]);
  });

  it('the Vision walk-through: src/vision sits in Devices & Edge because camera-ingest is implemented there, and opens to its real files', () => {
    const vision = byId.get('module:vision')!;
    expect(vision.parent).toBe('system:devices');
    expect(vision.evidence.some((e) => /camera-ingest/.test(e.n || ''))).toBe(true);
    const files = G.nodes.filter((n) => n.parent === 'module:vision').map((n) => n.id.replace('file:', '')).sort();
    const onDisk = fs.readdirSync(path.join(ROOT, 'src/vision')).filter((f) => f.endsWith('.ts')).map((f) => 'src/vision/' + f).sort();
    expect(files).toEqual(onDisk);
    expect(G.edges.some((e) => e.from === 'component:camera-ingest' && e.to === 'file:src/vision/vision-ingest.service.ts' && e.kind === 'IMPLEMENTED_BY')).toBe(true);
  });

  it('a module is placed in a system only where a component points into it; the rest are in "No district evidence", not guessed', () => {
    const inside = (m: string) => infra.components.some((c: { repositoryPath: string | null }) => {
      const p = (c.repositoryPath || '').replace(/\/$/, '');
      return p === 'src/' + m || p.startsWith('src/' + m + '/');
    });
    for (const n of G.nodes.filter((x) => x.kind === 'module' && x.id !== 'module:src-root')) {
      const m = n.id.slice('module:'.length);
      expect({ m, unplaced: n.parent === 'system:unplaced' }).toEqual({ m, unplaced: !inside(m) });
    }
  });

  it('records where the authorities disagree instead of choosing (the route-mount count, D5)', () => {
    const d = G.discrepancies.find((x) => x.id === 'route-mounts');
    expect(d?.detail).toMatch(/security manifest mounts \d+ routers; the infrastructure manifest lists \d+ mounts/);
  });
});

describe('4. the API: owner-only on the server, never cached, and the body keeps its contract', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createApp } = require('../src/app');
  const app = createApp();
  const token = (u: typeof OWNER | typeof MEMBER) => signToken('access', { sub: u.id, role: u.role }, { expiresIn: '10m' });
  beforeEach(() => { CURRENT = OWNER; resetTwinGraphCache(); });

  it('refuses a request without a session (401)', async () => {
    const res = await request(app).get('/api/v1/system/neural-twin');
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/"nodes"/);
  });
  it('refuses a club account (403), and sends no part of the graph', async () => {
    CURRENT = MEMBER;
    const res = await request(app).get('/api/v1/system/neural-twin').set('Authorization', 'Bearer ' + token(MEMBER));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/"nodes"|"edges"|module:|file:src/);
  });
  it('serves the owner the graph, uncached, and the body matches its contract and the composer', async () => {
    const res = await request(app).get('/api/v1/system/neural-twin').set('Authorization', 'Bearer ' + token(OWNER));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(NeuralTwinGraphSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data.nodes.length).toBe(G.nodes.length);
    expect(res.body.data.edges.length).toBe(G.edges.length);
  });
  it('is read-only: no other verb is routed', async () => {
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[verb]('/api/v1/system/neural-twin').set('Authorization', 'Bearer ' + token(OWNER));
      expect([404, 405]).toContain(res.status);
    }
  });
  it('is pinned owner-only in the posture policy, in the coverage map and in the control plane', () => {
    expect(json(TWIN_PATHS.posture).ownerRooms['neural-twin.routes']).toEqual({ mount: '/system/neural-twin' });
    expect(json(TWIN_PATHS.coverage).components.routers['neural-twin.routes']).toEqual([4, 5, 6, 7]);
    expect(read('src/cyber-defense/control-plane/registry.ts')).toMatch(/routers: \['infrastructure\.routes', 'neural-twin\.routes'(, '[a-z-]+\.routes')*\]/);
    expect(read('src/routes/neural-twin.routes.ts')).toMatch(/router\.use\(authenticate\);[\s\S]*assertPlatformOwner[\s\S]*no-store/);
  });
  it('is built with the release: the build composes the graph after tsc, and production never loads the compiler', () => {
    expect(JSON.parse(read('package.json')).scripts.build).toMatch(/&& tsc && node scripts\/copy-runtime-assets\.js && node scripts\/neural-twin-build\.js( &&|$)/);
    const store = read('src/platform/neural-twin/store.ts');
    expect(store).toMatch(/process\.env\.NODE_ENV !== 'production'[\s\S]*require\('\.\/compose'\)/);
    expect(store).not.toMatch(/^import .*['"]\.\/compose['"]/m);
    expect(read('src/routes/neural-twin.routes.ts')).not.toMatch(/from ['"][^'"]*\/compose['"]|require\(['"][^'"]*\/compose['"]/);
  });
});

describe('5. the room keeps the owner-room rules', () => {
  const JS = read('public/neural-twin/neural-twin.js');
  const CSS = read('public/neural-twin/neural-twin.css');
  const APP = read('public/app.js');
  const cat = (l: string) => json('public/neural-twin/i18n/' + l + '.json') as Record<string, string>;
  const keysAsked = () => {
    const keys = new Set<string>();
    for (const m of JS.matchAll(/\b(?:T|tf)\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
    for (const m of JS.matchAll(/\b(?:name|plural|out|inc):\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
    for (const block of ['MATURITY', 'AUTHORITY', 'FACTS', 'ROOMS', 'ZONE_NAMES']) {
      const b = JS.slice(JS.indexOf('var ' + block + ' = {'));
      for (const m of b.slice(0, b.indexOf('};')).matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
    }
    keys.delete('');
    return keys;
  };

  it('has one catalogue per language with the same keys, English as itself, and every %d kept', () => {
    const en = cat('en'), de = cat('de'), ar = cat('ar');
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en)) {
      expect(en[k]).toBe(k);
      expect((de[k].match(/%d/g) || []).length).toBe((k.match(/%d/g) || []).length);
      expect((ar[k].match(/%d/g) || []).length).toBe((k.match(/%d/g) || []).length);
      expect(de[k]).not.toBe('');
      expect(ar[k]).not.toBe('');
    }
  });
  it('every string the room or the composer can show is in the catalogue', () => {
    const en = cat('en');
    const missing = [...keysAsked()].filter((k) => !(k in en));
    expect(missing).toEqual([]);
    const composer = read('src/platform/neural-twin/compose.ts');
    const sentences = G.nodes.flatMap((n) => n.unknown || []).concat(G.nodes.filter((n) => n.id === 'system:unplaced').map((n) => n.summary!));
    for (const s of new Set(sentences)) { expect(en[s]).toBe(s); expect(composer.includes(s.replace(/'/g, "\\'")) || composer.includes(s)).toBe(true); }
  });
  it('writes no inline style, no inline handler, and loads nothing from outside the application', () => {
    expect(JS).not.toMatch(/style="/);
    expect(JS).not.toMatch(/\son[a-z]+="/);
    expect(JS).not.toMatch(/https?:\/\//);
    expect(JS).not.toMatch(/\beval\(|new Function\(/);
    expect(JS).toMatch(/s\.src = '\/vendor\/babylon\.js'/);
  });
  it('reads the design tokens and declares none of its own, with no raw colour', () => {
    expect(CSS).not.toMatch(/^\s*--[a-z0-9-]+\s*:/m);
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(CSS).toMatch(/@media \(max-width: 980px\), \(max-height: 620px\)/);
    expect(CSS).toMatch(/scrollbar-gutter: stable/);
  });
  it('reads only tokens that exist (in its stylesheet and in the scene\'s colours), and is a declared consumer of them', () => {
    const declared = new Set([...read('public/tokens/familista-tokens.css').matchAll(/(--fam-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    const scene = [...JS.matchAll(/tok: '(--[a-z0-9-]+)'|tokenRGB\('(--[a-z0-9-]+)'\)/g)].map((m) => m[1] || m[2]);
    expect(used.length).toBeGreaterThan(60);
    expect(scene.length).toBeGreaterThan(10);
    expect([...used, ...scene].filter((v) => !v.startsWith('--fam-') || !declared.has(v))).toEqual([]);
    expect(read('tools/tokens/scripts/verify.mjs')).toMatch(/const CONSUMERS = \[[^\]]*'public\/neural-twin\/'[^\]]*\];/);
    expect(read('tools/tokens/lib/production.mjs')).toContain("files: ['public/neural-twin/neural-twin.css']");
  });
  it('is wired into the shell like the other owner rooms, outside every Club Workspace', () => {
    expect(APP).toMatch(/'neural-twin': 1,/);
    expect(APP).toMatch(/function _loadNeuralTwin\(done\)[\s\S]*?_isPlatformOwner\(\)/);
    expect(APP).toMatch(/document\.body\.classList\.toggle\('nt-twin-open', page === 'neural-twin'\)[\s\S]*?window\.teardownFamilistaNeuralTwin\(\)/);
    expect(APP).toMatch(/<div class="page" id="pg-neural-twin" data-no-i18n data-fam-context="owner"><div id="nt-root"><\/div><\/div>/);
    expect(APP).not.toMatch(/data-page="neural-twin"/);   // no card on Owner Control's map: its layout is unchanged
    // reached from the Platform Owner navigation, the one list the top bar and both owner rooms draw
    expect(APP).toMatch(/var OWNER_NAV = \[\s*\{ page: 'neural-twin', label: 'Neural Digital Twin',/);
  });
});

describe('6. the layout: position says nesting, and nothing overlaps', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Lay = require('../public/neural-twin/neural-twin-layout.js');
  const ROOM = read('public/neural-twin/neural-twin.js');
  const SIZE: Record<string, number> = {};
  for (const m of ROOM.matchAll(/^\s{4}(\w+):\s*\{ name: [^\n]*?size: ([\d.]+)/gm)) SIZE[m[1]] = Number(m[2]);
  const OPEN_SYSTEM = Number((ROOM.match(/var OPEN_SYSTEM = ([\d.]+);/) || [])[1]);
  const kids = new Map<string, string[]>();
  for (const n of G.nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) || []), n.id]);
  const systemsSorted = G.nodes.filter((n) => n.kind === 'system').sort((a, b) => (a.label < b.label ? -1 : 1));
  const zoneOf = (id: string) => String((byId.get(id)!.facts as Record<string, unknown> | undefined)?.zone ?? '');
  const MODES: Record<string, (id: string) => boolean> = {
    closed: () => false,
    'systems open': (id) => byId.get(id)!.kind === 'system',
    'everything open': (id) => (kids.get(id) || []).length > 0,
  };
  const run = (open: (id: string) => boolean) => Lay.layout({
    roots: systemsSorted.map((s) => ({ id: s.id, zone: zoneOf(s.id) })),
    kids: (id: string) => kids.get(id) || [],
    open,
    body: (id: string) => SIZE[byId.get(id)!.kind] * (open(id) && (kids.get(id) || []).length ? OPEN_SYSTEM : 1),
  });
  const flat = (p: number[]) => [p[0], p[2]];
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  /** Every pair of siblings whose footprints overlap. */
  const overlaps = (pos: Record<string, number[]>, bubble: Record<string, number>) => {
    const groups = new Map<string, string[]>();
    for (const id of Object.keys(pos)) { const p = byId.get(id)!.parent || '(root)'; groups.set(p, [...(groups.get(p) || []), id]); }
    const bad: string[] = [];
    for (const ids of groups.values()) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      if (dist(flat(pos[ids[i]]), flat(pos[ids[j]])) < bubble[ids[i]] + bubble[ids[j]] - 1e-6) bad.push(ids[i] + ' × ' + ids[j]);
    }
    return bad;
  };

  it('reads every kind\'s size from the room, so the test lays out what the room draws', () => {
    expect(Object.keys(SIZE).sort()).toEqual(['agent', 'api', 'boundary', 'component', 'file', 'model', 'module', 'planned', 'sysmodule', 'system']);
    expect(OPEN_SYSTEM).toBeGreaterThan(0);
  });

  it('packs circles without overlap, outside the hole, the same way every time', () => {
    const circles = Array.from({ length: 140 }, (_, i) => ({ id: 'c' + i, r: 0.5 + ((i * 37) % 11) / 4 }));
    const a = Lay.pack(circles, 3), b = Lay.pack(circles, 3);
    expect(a).toEqual(b);
    for (let i = 0; i < circles.length; i++) {
      expect(Math.hypot(a['c' + i][0], a['c' + i][1])).toBeGreaterThanOrEqual(3 + circles[i].r - 1e-6);
      for (let j = i + 1; j < circles.length; j++) expect(dist(a['c' + i], a['c' + j])).toBeGreaterThanOrEqual(circles[i].r + circles[j].r - 1e-6);
    }
  });

  for (const [mode, open] of Object.entries(MODES)) {
    it(`${mode}: no two siblings overlap, everything sits on its parent's platform, and the zones keep apart`, () => {
      const t0 = Date.now();
      const L = run(open);
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(run(open)).toEqual(L);                                    // deterministic
      expect(overlaps(L.pos, L.bubble)).toEqual([]);
      // what is shown: the systems, and the children of every open node, all of them placed
      const expected = new Set<string>();
      const walk = (id: string) => { expected.add(id); if (open(id)) (kids.get(id) || []).forEach(walk); };
      systemsSorted.forEach((s) => walk(s.id));
      expect(Object.keys(L.pos).sort()).toEqual([...expected].sort());
      // containment: a child's whole footprint is inside its parent's footprint
      for (const id of Object.keys(L.pos)) {
        const p = byId.get(id)!.parent;
        if (!p) continue;
        expect(dist(flat(L.pos[id]), flat(L.pos[p])) + L.bubble[id]).toBeLessThanOrEqual(L.bubble[p] + 1e-6);
        expect(L.pos[id][1]).toBeGreaterThan(L.pos[p][1]);           // each level floats above the one it sits on
      }
      // zones: no two touch; unclassified systems stand clear of every zone by the declared gap
      for (let i = 0; i < L.zones.length; i++) for (let j = i + 1; j < L.zones.length; j++) {
        const a = L.zones[i], b = L.zones[j], gap = a.unplaced || b.unplaced ? Lay.SPACE.unplacedGap : Lay.SPACE.zoneGap;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(a.r + b.r + gap - 1e-6);
      }
      // each system sits inside its own zone's boundary
      for (const s of systemsSorted) {
        const z = L.zones.find((x: { zone: string }) => x.zone === (['centre', 'north', 'east', 'south', 'west'].includes(zoneOf(s.id)) ? zoneOf(s.id) : ''));
        expect(dist(flat(L.pos[s.id]), [z.x, z.z]) + L.bubble[s.id]).toBeLessThanOrEqual(z.r + 1e-6);
      }
    });
  }

  it('keeps the manifest\'s compass, and puts what has no district evidence apart, marked as such', () => {
    const L = run(MODES['systems open']);
    const at = (z: string) => L.zones.find((x: { zone: string }) => x.zone === z);
    expect(at('north').z).toBeGreaterThan(at('centre').z);
    expect(at('south').z).toBeLessThan(at('centre').z);
    expect(at('east').x).toBeGreaterThan(at('centre').x);
    expect(at('west').x).toBeLessThan(at('centre').x);
    const un = L.zones.filter((z: { unplaced: boolean }) => z.unplaced);
    expect(un.map((z: { zone: string }) => z.zone)).toEqual(['']);
    expect(dist(flat(L.pos['system:unplaced']), [un[0].x, un[0].z])).toBeLessThan(un[0].r);
    // and the overview is compact: the whole closed map fits in a circle a fraction of the old 120-unit ring
    expect(run(MODES.closed).extent).toBeLessThan(80);
  });

  it('lifts edges without inventing one: every drawn line is made of real edges, and they add up', () => {
    for (const open of Object.values(MODES)) {
      const visible: Record<string, boolean> = {};
      const walk = (id: string) => { visible[id] = true; if (open(id)) (kids.get(id) || []).forEach(walk); };
      systemsSorted.forEach((s) => walk(s.id));
      const parentOf = (id: string) => byId.get(id)?.parent || null;
      const lifted = Lay.lift(G.edges, visible, parentOf, (k: string) => k !== 'IN_BOUNDARY');
      const rep = (id: string) => { let c: string | null = id; while (c && !visible[c]) c = parentOf(c); return c; };
      const real = new Map<string, number>();
      for (const e of G.edges) {
        if (e.kind === 'IN_BOUNDARY') continue;
        const a = rep(e.from), b = rep(e.to);
        if (a && b && a !== b) real.set(a + '|' + b + '|' + e.kind, (real.get(a + '|' + b + '|' + e.kind) || 0) + 1);
      }
      expect(lifted.length).toBe(real.size);
      for (const l of lifted) {
        expect(l.from).not.toBe(l.to);
        expect(visible[l.from] && visible[l.to]).toBe(true);
        expect(real.get(l.from + '|' + l.to + '|' + l.kind)).toBe(l.n);   // the count is the real edges it stands for
      }
      // negative control: a fabricated line is caught by the same mapping
      expect(real.get('system:frontend|system:testing|DEPENDS_ON')).toBeUndefined();
    }
  });

  it('finds the fewest hops along the edges\' own direction, and says when it had to read them backwards', () => {
    const lifted = [
      { from: 'a', to: 'b', kind: 'IMPORTS', weight: 1, n: 1 }, { from: 'b', to: 'c', kind: 'IMPORTS', weight: 1, n: 1 },
      { from: 'a', to: 'c', kind: 'DATA', weight: 1, n: 1 }, { from: 'c', to: 'd', kind: 'IMPORTS', weight: 1, n: 1 }, { from: 'x', to: 'y', kind: 'IMPORTS', weight: 1, n: 1 },
    ];
    expect(Lay.shortestPath(lifted, 'a', 'd')).toEqual({ nodes: ['a', 'c', 'd'], edges: [2, 3], reversed: false });
    expect(Lay.shortestPath(lifted, 'd', 'a')).toEqual({ nodes: ['a', 'c', 'd'], edges: [2, 3], reversed: true });
    expect(Lay.shortestPath(lifted, 'a', 'y')).toBeNull();               // no path is reported as none, never a guess
    expect(Lay.shortestPath(lifted, 'a', 'a')).toBeNull();
  });

  it('keeps labels apart: no two kept boxes overlap, and the more important label wins', () => {
    const boxes = Array.from({ length: 400 }, (_, i) => ({ id: 'l' + i, x: (i * 53) % 900, y: (i * 29) % 500, w: 60 + (i % 5) * 20, h: 18, pri: i % 7 }));
    const keep = Lay.declutter(boxes, 3);
    const kept = boxes.filter((b) => keep[b.id]);
    expect(kept.length).toBeGreaterThan(20);
    for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) {
      const a = kept[i], b = kept[j];
      expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    }
    const two = Lay.declutter([{ id: 'low', x: 0, y: 0, w: 100, h: 20, pri: 5 }, { id: 'high', x: 10, y: 5, w: 100, h: 20, pri: 0 }], 0);
    expect(two).toEqual({ high: true });
    expect(Lay.declutter(boxes, 3)).toEqual(keep);
  });

  it('is pure, and the room loads it before itself', () => {
    const src = read('public/neural-twin/neural-twin-layout.js');
    expect(src).not.toMatch(/\bdocument\b|\blocalStorage\b|Math\.random|Date\.now|performance\.now|fetch\(/);
    expect(read('public/app.js')).toMatch(/\['\/neural-twin\/neural-twin-layout\.js', '\/neural-twin\/neural-twin\.js'\]/);
    expect(ROOM).toMatch(/window\.FamilistaTwinLayout/);
    // one line builder in the room; relationship lines are built only from the lifted edges (the rest are
    // platform and zone boundaries and the selection's ring), and no other kind of line exists
    expect(ROOM.match(/CreateGreasedLine\(/g)).toHaveLength(1);
    expect(ROOM).not.toMatch(/CreateLineSystem|CreateLines\(|CreateDashedLines/);
    expect(ROOM).toMatch(/var e = S\.lifted\[i\]; \(groups\[e\.kind\]/);
  });
});

describe('7. the twin\'s browser proof runs inside the required CI jobs, and cannot pass empty', () => {
  const CI = read('.github/workflows/ci.yml');
  const PROOF = read('tools/components/twin-browser-proof.cjs');
  const job = CI.slice(CI.indexOf('  browser-proof:'), CI.indexOf('  secret-scan:'));
  const code = job.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  it('is a tool beside the Lab proof, with the same pinned tools, and pairs its proofs with negative controls', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(require('child_process').spawnSync(process.execPath, ['--check', path.join(ROOT, 'tools/components/twin-browser-proof.cjs')]).status).toBe(0);
    expect(PROOF).toContain("require(process.env.PLAYWRIGHT_CORE || 'playwright-core')");
    expect(PROOF).toContain("tools/components/node_modules/axe-core/axe.min.js");
    for (const claim of ['a fabricated one is caught', 'twin path (control)', 'twin owner only (control)', 'twin owner only: a club coach is answered 403', 'without a session the graph is answered 401', 'twin accessibility (control)', 'no two shown labels overlap', 'no two nodes of the graph collide', 'no smaller than the Phase 1 graph of 921 and 3,656'])
      expect(PROOF).toContain(claim);
    expect(PROOF).toMatch(/console\.log\(`SUMMARY \$\{[^`]+\} passed, \$\{failed\} failed, \$\{[^`]+\} skipped`\)/);
  });

  it('runs in both required browser-proof shards, every section once, with a floor, and nothing in it can fail quietly', () => {
    expect([...code.matchAll(/^ {10}- shard: (.+)$/gm)].map((m) => m[1])).toEqual(['isolation', 'accessibility and focus']);
    const twin = [...code.matchAll(/twin:\s*'([^']+)'/g)].map((m) => m[1].split(',')).flat().sort();
    expect(twin).toEqual(['T1', 'T2', 'T3', 'T4']);
    const floors = [...code.matchAll(/twin_floor:\s*'(\d+)'/g)].map((m) => Number(m[1]));
    expect(floors.length).toBe(2);
    expect(floors.every((n) => n >= 30)).toBe(true);
    expect(code).toContain('PROOF_ONLY="$TWIN_SECTIONS" node tools/components/twin-browser-proof.cjs "$out" "${args[@]}"');
    expect(code).toContain('TWIN_FLOOR:         ${{ matrix.twin_floor }}');
    const gate = code.slice(code.indexOf('- name: The Neural Digital Twin proof must have run'));
    expect(gate).toContain("grep -Eq ', 0 failed, 0 skipped$'");
    expect(gate).toMatch(/test "\$passed" -ge "\$TWIN_FLOOR"/);
    expect(code).not.toMatch(/continue-on-error|\|\|\s*true|playwright install|secrets\./);
    // inside the required jobs: ci.yml still has exactly its three jobs, and the twin's steps come before the report step
    expect([...CI.slice(CI.indexOf('\njobs:')).matchAll(/^  ([a-z-]+):\s*$/gm)].map((m) => m[1])).toEqual(['validate', 'browser-proof', 'secret-scan']);
    expect(code.indexOf('- name: Neural Digital Twin browser proof')).toBeLessThan(code.indexOf('- name: Performance budget report'));
    expect(code.indexOf('- name: The proof must have run, in full')).toBeLessThan(code.indexOf('- name: Neural Digital Twin browser proof'));
  });
});

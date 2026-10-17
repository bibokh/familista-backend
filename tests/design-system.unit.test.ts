/**
 * Familista Design System Control — Stage 3.1
 *
 * An Owner-only global room, read-only, drawn from a manifest generated from
 * the Design Core (tools/tokens/). This suite pins, one guarantee at a time:
 *
 *   - the manifest is deterministic, current, and every figure in it can be
 *     recomputed independently from the repository (nothing is typed in);
 *   - the API is GET-only, authenticated and Platform-Owner-only on the server
 *     (anonymous 401, club roles 403, platform owner 200, every write refused);
 *   - the room is wired into the app lazily, behind the owner check, without
 *     touching the Owner Home grid or any other page;
 *   - it consumes the canonical --fam-* tokens and declares none of its own;
 *   - it is CSP-safe, responsive, RTL-aware and carries no confidential data in
 *     public assets;
 *   - its English, German and Arabic catalogues cover everything it can say.
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
import path from 'path';
import { signToken } from '../src/security/jwt-tokens';
import { forgetIdentity } from '../src/middleware/auth.middleware';
import { resetDesignSystemCache } from '../src/design-system/design-system.service';
import { DesignSystemOverviewSchema, DesignSystemTokensSchema } from '../src/contracts/owner-api.contracts';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p));
/** Source without comments, so a rule written in prose is not read as code. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
/** The text of `var NAME = { … };` by matching braces, whatever the layout. */
function objectLiteral(src: string, name: string): string {
  const at = src.indexOf(`var ${name} = {`);
  if (at < 0) throw new Error(`no var ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
/** Every rule's selector, at any nesting depth, skipping at-rule preludes. */
function selectorsOf(css: string): string[] {
  const out: string[] = []; let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') { const t = css.slice(start, i).trim(); if (!t.startsWith('@')) out.push(t); start = i + 1; }
    else if (css[i] === '}') start = i + 1;
  }
  return out;
}
const MANIFEST_PATH = 'src/design-system/generated/design-system-manifest.json';
const manifest = json(MANIFEST_PATH);
const app = createApp();
const token = (id: string, role: string) => signToken('access', { sub: id, role, tv: 0 }, { expiresIn: '10m' });
const get = (url: string, who?: [string, string]) => {
  const r = request(app).get(`/api/v1/system/design-system${url}`);
  return who ? r.set('Authorization', `Bearer ${token(...who)}`) : r;
};

beforeAll(() => {
  const base = { isActive: true, currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: null };
  USERS.owner = { ...base, id: 'u-owner', email: 'o@x.test', role: 'SUPER_ADMIN', clubId: null };
  USERS.platformAdmin = { ...base, id: 'u-padmin', email: 'p@x.test', role: 'CLUB_ADMIN', clubId: 'c-1', platformAdmin: { isActive: true } };
  USERS.clubAdmin = { ...base, id: 'u-cadmin', email: 'c@x.test', role: 'CLUB_ADMIN', clubId: 'c-1' };
  USERS.coach = { ...base, id: 'u-coach', email: 'h@x.test', role: 'HEAD_COACH', clubId: 'c-1' };
});
beforeEach(() => { forgetIdentity(); resetDesignSystemCache(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('the manifest is generated, deterministic and current', () => {
  it('is exactly what the generator writes now (--check)', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'design-system-discover.js'), '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/current/);
  });

  it('carries no timestamp, host or environment value', () => {
    const text = read(MANIFEST_PATH);
    expect(text).not.toMatch(/generatedAt|timestamp|hostname|\b20\d\d-\d\d-\d\dT\d\d:/i);
    expect(text).not.toContain(process.env.JWT_ACCESS_SECRET as string);
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('lists every source with the SHA-256 of the file it names', () => {
    expect(manifest.sources.map((s: { id: string }) => s.id)).toEqual(
      ['tokens', 'web-target', 'token-css', 'token-css-published', 'legacy-map', 'contrast-baseline']);
    for (const s of manifest.sources as { path: string; sha256: string; bytes: number }[]) {
      const buf = fs.readFileSync(path.join(ROOT, s.path));
      expect(crypto.createHash('sha256').update(buf).digest('hex')).toBe(s.sha256);
      expect(buf.length).toBe(s.bytes);
    }
  });

  it('is generated by the one module the server reads, and is copied into the build', () => {
    expect(read('scripts/copy-runtime-assets.js')).toContain("'src/design-system/generated/design-system-manifest.json'");
    expect(read('scripts/copy-runtime-assets.js')).toContain("'dist/design-system/generated/design-system-manifest.json'");
  });
});

describe('the build refuses a stale manifest (scripts/copy-runtime-assets.js)', () => {
  const script = read('scripts/copy-runtime-assets.js');

  it('checks the manifest before it copies anything, read-only, with the same generator CI uses', () => {
    expect(script).toContain("'design-system-discover.js'");
    expect(script).toContain("'--check'");
    expect(script.indexOf("'--check'")).toBeLessThan(script.indexOf('const ASSETS'));
    expect(script).toContain('process.exit(1)');
    // It must never write the manifest itself.
    expect(script).not.toMatch(/design-system-discover\.js'?\s*\]\s*[,)]/);
    expect(script).not.toMatch(/writeFileSync/);
  });

  it('passes on the committed manifest', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'copy-runtime-assets.js')], { cwd: ROOT, encoding: 'utf8' });
    expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
    expect(r.stdout).toMatch(/\[assets\] copied \d+ runtime file/);
  });

  it('fails the build on a stale manifest, names the fix, and does not rewrite the manifest', () => {
    // A throwaway copy of exactly what the generator reads, with one byte of the manifest changed.
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ds-stale-'));
    try {
      const put = (rel: string, recursive = false) => {
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.cpSync(path.join(ROOT, rel), path.join(tmp, rel), { recursive });
      };
      put('scripts/copy-runtime-assets.js'); put('scripts/design-system-discover.js'); put('scripts/design-system-graph.js'); put('scripts/design-system-components.js'); put('scripts/design-system-previews.js');
      put('tools/tokens', true); put('tools/storybook/stories', true); put('tools/storybook/tests', true); put('tools/components', true); put('public/tokens', true);
      put('src/design-system/graph-core.js'); put('src/design-system/components-core.js'); put('src/design-system/previews-core.js');
      put('src/design-system/generated/design-system-manifest.json'); put('src/design-system/generated/design-system-graph.json'); put('src/design-system/generated/design-system-components.json'); put('src/design-system/generated/design-system-previews.json');
      // The graph and the registry read the pages, the stylesheets and the scripts, nothing else of public/.
      fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true, filter: (src) => fs.statSync(src).isDirectory() || /\.(css|html|js)$/.test(src) });
      const mf = path.join(tmp, 'src/design-system/generated/design-system-manifest.json');
      const stale = fs.readFileSync(mf, 'utf8').replace('"schema": 1', '"schema": 1,\n "stale": true');
      expect(stale).not.toBe(fs.readFileSync(mf, 'utf8'));
      fs.writeFileSync(mf, stale);

      const r = spawnSync(process.execPath, [path.join(tmp, 'scripts/copy-runtime-assets.js')], { cwd: tmp, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Design System manifest is stale/);
      expect(r.stderr).toContain('node scripts/design-system-discover.js');
      expect(r.stdout).not.toMatch(/copied/);
      expect(fs.readFileSync(mf, 'utf8')).toBe(stale);           // not silently regenerated
      expect(fs.existsSync(path.join(tmp, 'dist'))).toBe(false); // nothing was copied
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('nothing in the manifest is typed in: every figure is recomputed from the repository', () => {
  const o = manifest.overview;
  const tree = json('tools/tokens/familista.tokens.json');
  const leaves = (n: Record<string, unknown>): number =>
    Object.entries(n).reduce((a, [k, v]) => {
      if (k.startsWith('$') || !v || typeof v !== 'object') return a;
      return a + (Object.prototype.hasOwnProperty.call(v, '$value') ? 1 : leaves(v as Record<string, unknown>));
    }, 0);

  it('counts the tokens in the token file', () => {
    expect(o.tokens.total.value).toBe(leaves(tree));
    expect(manifest.tokens.length).toBe(leaves(tree));
    expect(Object.values(o.tokens.byLayer.value).reduce((a: number, b) => a + (b as number), 0)).toBe(leaves(tree));
    expect(o.tokens.total.state).toBe('MEASURED');
  });

  it('counts the declarations in the published token CSS, which is the dist file byte for byte', () => {
    const css = read('public/tokens/familista-tokens.css');
    expect(css).toBe(read('tools/tokens/dist/familista-tokens.css'));
    const declared = (css.replace(/\/\*[\s\S]*?\*\//g, '').match(/^\s*--fam-[a-z0-9-]+\s*:/gm) || []).length;
    expect(o.css.declarations.value).toBe(declared);
    expect(o.css.bytes.value).toBe(Buffer.byteLength(css));
    expect(o.css.publishedIdentical.value).toBe(true);
    expect(o.css.version).toBe(json('tools/tokens/targets/web.json').version);
  });

  it('reports the legacy map and the contrast baseline as RECORDED, with their committed numbers', () => {
    const legacy = json('tools/tokens/legacy-map.json');
    const base = json('tools/tokens/contrast-baseline.json');
    expect(o.legacyMap.declarations.value).toBe(legacy.entries.length);
    expect(o.legacyMap.byStatus.state).toBe('RECORDED');
    expect(o.legacyMap.undefinedNames.value).toEqual({ css: legacy.undefinedNames.css.length, appJs: legacy.undefinedNames.appJs.length });
    expect(o.contrast.baselineFailures).toMatchObject({ state: 'RECORDED', value: base.failures.length });
    expect(o.contrast.pairs.value).toBe(base.pairs.length);
    expect(manifest.contrast).toHaveLength(base.pairs.length);
  });

  it('introduces no contrast failure beyond the recorded baseline, and says so as a measured 0', () => {
    expect(o.contrast.newFailures.value).toBe(0);
    expect(manifest.contrast.filter((p: { role: string; pass: boolean; baseline: boolean }) => p.role !== 'exempt' && !p.pass && !p.baseline)).toEqual([]);
  });

  it('counts story FILES, not stories', () => {
    const walk = (d: string): string[] => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.stories\.js$/.test(e.name) ? [e.name] : []));
    expect(o.storybook.storyFiles.value).toBe(walk('tools/storybook/stories').length);
  });

  it('says what the platform does not keep, with the reason, and invents no figure for it', () => {
    expect(o.unavailable.map((u: { id: string }) => u.id).sort())
      .toEqual(['component-adoption', 'runtime-accessibility', 'test-results', 'usage-telemetry']);
    for (const u of o.unavailable) {
      expect(u.reason.length).toBeGreaterThan(20);
      expect(Object.keys(u).sort()).toEqual(['id', 'reason']);
    }
  });

  it('labels every figure MEASURED or RECORDED and names its source', () => {
    const states = new Set<string>();
    const walkEv = (n: unknown) => {
      if (!n || typeof n !== 'object') return;
      const e = n as Record<string, unknown>;
      if ('state' in e && 'value' in e) {
        states.add(String(e.state));
        expect(manifest.sources.map((s: { id: string }) => s.id).concat(['tools/storybook/stories', 'tools/storybook/stories/foundations'])).toContain(e.source);
        return;
      }
      Object.values(e).forEach(walkEv);
    };
    walkEv({ ...o, unavailable: undefined });
    expect([...states].sort()).toEqual(['MEASURED', 'RECORDED']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the API: GET-only, authenticated and Platform-Owner-only, on the server', () => {
  const both = ['', '/tokens'];

  it.each(both)('GET %s without a session is 401', async (url) => {
    expect((await get(url)).status).toBe(401);
  });

  it.each(both)('GET %s as a club administrator is 403', async (url) => {
    expect((await get(url, ['u-cadmin', 'CLUB_ADMIN'])).status).toBe(403);
  });

  it.each(both)('GET %s as a head coach is 403', async (url) => {
    expect((await get(url, ['u-coach', 'HEAD_COACH'])).status).toBe(403);
  });

  it.each(both)('GET %s as the platform owner (SUPER_ADMIN) is 200 and not cacheable', async (url) => {
    const res = await get(url, ['u-owner', 'SUPER_ADMIN']);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.success).toBe(true);
  });

  it.each(both)('GET %s is also open to a platform administrator, whatever their club role', async (url) => {
    expect((await get(url, ['u-padmin', 'CLUB_ADMIN'])).status).toBe(200);
  });

  it('answers with the contract the room reads, and nothing outside it', async () => {
    const o = await get('', ['u-owner', 'SUPER_ADMIN']);
    expect(DesignSystemOverviewSchema.safeParse(o.body.data).success).toBe(true);
    expect(o.body.data.state).toBe('READY');
    expect(o.body.data.readOnly).toBe(true);
    const t = await get('/tokens', ['u-owner', 'SUPER_ADMIN']);
    expect(DesignSystemTokensSchema.safeParse(t.body.data).success).toBe(true);
    expect(t.body.data.tokens).toHaveLength(manifest.tokens.length);
  });

  it('exposes no environment value, secret or connection string', async () => {
    const text = JSON.stringify([(await get('', ['u-owner', 'SUPER_ADMIN'])).body, (await get('/tokens', ['u-owner', 'SUPER_ADMIN'])).body]);
    expect(text).not.toContain(process.env.JWT_ACCESS_SECRET as string);
    expect(text).not.toContain(process.env.JWT_REFRESH_SECRET as string);
    expect(text).not.toMatch(/postgres(ql)?:\/\/|api[_-]?key|password/i);
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)('refuses %s on every path, as the owner too', async (verb) => {
    for (const url of both) {
      const res = await request(app)[verb](`/api/v1/system/design-system${url}`).set('Authorization', `Bearer ${token('u-owner', 'SUPER_ADMIN')}`).send({});
      expect(res.status).toBe(404);
    }
  });

  it('has only GET handlers in its router, behind authenticate and assertPlatformOwner', () => {
    const src = read('src/routes/design-system.routes.ts');
    expect(src.match(/router\.(get|post|put|patch|delete|all|use)\(/g)).toEqual(['router.use(', 'router.use(', 'router.get(', 'router.get(', 'router.get(', 'router.get(', 'router.get(']);
    expect(src).toContain('router.use(authenticate)');
    expect(src).toContain('assertPlatformOwner');
    expect(src).toMatch(/assertPlatformOwner[\s\S]*router\.get\('\/'/);
  });

  it('says NOT_GENERATED, and why, when the manifest is not beside the server', async () => {
    const file = path.join(ROOT, 'src/design-system/generated/design-system-manifest.json');
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (String(p) === file) throw new Error('ENOENT');
      return (jest.requireActual('fs') as typeof fs).readFileSync(p as string, ...(rest as [BufferEncoding]));
    }) as typeof fs.readFileSync);
    try {
      resetDesignSystemCache();
      const res = await get('', ['u-owner', 'SUPER_ADMIN']);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ state: 'NOT_GENERATED', overview: null, sources: [], layers: [] });
      expect(res.body.data.reason).toMatch(/not beside this server/);
      expect(DesignSystemOverviewSchema.safeParse(res.body.data).success).toBe(true);
    } finally { spy.mockRestore(); resetDesignSystemCache(); }
  });
});

describe('the Owner-room registrations the platform pins', () => {
  it('is mounted at /system/design-system, declared a platform-owner room, covered and mapped', () => {
    expect(read('src/routes/index.ts')).toContain("router.use('/system/design-system', designSystemRoutes)");
    expect(json('src/cyber-defense/posture-policy.json').ownerRooms['design-system.routes']).toEqual({ mount: '/system/design-system' });
    const cov = json('src/cyber-defense/coverage-map.json').components;
    expect(cov.routers['design-system.routes']).toEqual(expect.arrayContaining([4, 5, 6, 7]));
    expect(cov.srcDomains['design-system']).toBeDefined();
    // Registered under the existing System area: it adds no area of its own to the Command Center.
    const reg = read('src/cyber-defense/control-plane/registry.ts');
    expect(reg).toContain("routers: ['system.routes', 'owner-trace.routes', 'observability.routes', 'design-system.routes']");
    expect(reg).not.toMatch(/id: 'design-system'/);
    const sec = json('src/cyber-defense/generated/security-manifest.json');
    expect(JSON.stringify(sec)).toContain('GET /system/design-system/tokens');
  });

  it('declares both endpoints in the owner API contract, read by the room', () => {
    const c = read('src/contracts/owner-api.contracts.ts');
    expect(c).toContain("endpoint: '/system/design-system'");
    expect(c).toContain("endpoint: '/system/design-system/tokens'");
    expect(c).toContain("consumer: 'public/design-system/design-system.js'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the room, wired into the application', () => {
  const app_js = read('public/app.js');
  const html = read('public/index.html');

  it('is NOT loaded at startup: index.html links none of its assets and app.js mounts it lazily', () => {
    expect(html).not.toMatch(/design-system\//);
    const eager = app_js.match(/var _EAGER_PAGES = \[([\s\S]*?)\];/);
    expect(eager).not.toBeNull();
    expect(eager![1]).not.toContain('design-system');
  });

  it('loads its two same-origin assets on demand, only after /system/whoami names the platform owner', () => {
    const loader = app_js.slice(app_js.indexOf('function _loadDesignSystemRoom'), app_js.indexOf('// ── NAVIGATION ──'));
    expect(loader).toContain("link.href = '/design-system/design-system.css?v=");
    expect(loader).toContain("script.src = '/design-system/design-system.js?v=");
    expect(loader).toContain('_isPlatformOwner()');
    expect(loader).toMatch(/if \(!yes\) \{ finish\(false\); return; \}/);
    expect(loader).not.toMatch(/https?:\/\//);
    expect(app_js).toMatch(/if \(page === 'design-system' && !\(_DS_ROOM && _DS_ROOM\.state === 'ready'\)\)/);
  });

  it('registers the page in the allow-list, the title map and the template map', () => {
    expect(app_js).toContain("'design-system': 1,");
    expect(app_js).toContain("'design-system':'Design System'");
    expect(app_js).toContain("'design-system':               renderDesignSystemHTML,");
    expect(app_js).toContain("case 'pg-design-system':");
    expect(app_js).toContain('<div class="page" id="pg-design-system" data-no-i18n><div id="ds-root"></div></div>');
    expect(app_js).toContain("document.body.classList.toggle('ds-design-open', page === 'design-system')");
  });

  it('keeps the eight existing cards, in their order, with their destinations; the ninth is Design System Control', () => {
    const at = app_js.indexOf('<div class="oh-cards oh-cards--core">');
    expect(at).toBeGreaterThan(0);
    const block = app_js.slice(at, at + 11000);
    const cards = [...block.matchAll(/<button class="oh-card oh-card--([a-z]+)" data-action="navTo" data-page="([a-z-]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(cards).toEqual(['system:system', 'cyber:cybersecurity', 'clubs:clubs', 'algo:algorithms', 'vault:data-vault', 'city:infrastructure-city', 'core:source-core', 'vision:familista-vision', 'ds:design-system']);
  });

  it('is reachable from the Owner Home card and from the #design-system link', () => {
    expect(app_js).toContain('Reached by the #design-system link');
    expect(app_js).toContain('data-page="design-system"');
  });

  it('does not touch Club Workspace or Familista Vision code paths', () => {
    const room = read('public/design-system/design-system.js') + read('public/design-system/design-system.css');
    expect(room).not.toMatch(/club-home|pg-squad|familista-vision|\.fv-|\.vx-|mountFamilistaVision/);
  });
});

describe('the room reads the canonical tokens and declares none of its own', () => {
  const css = read('public/design-system/design-system.css');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('declares no custom property and reads only --fam-* tokens that exist', () => {
    expect(code).not.toMatch(/(^|[;{\s])--[a-z0-9-]+\s*:/m);
    const tokenCss = read('public/tokens/familista-tokens.css');
    const used = new Set([...code.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(40);
    for (const name of used) {
      expect(name.startsWith('--fam-')).toBe(true);
      expect(tokenCss).toContain(`${name}:`);
    }
  });

  it('hard-codes no colour', () => {
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it('is scoped to the room: every rule is under #pg-design-system, #ds-root, .ds-* or the shell-takeover body class', () => {
    const sels = selectorsOf(code);
    expect(sels.length).toBeGreaterThan(100);
    for (const sel of sels) {
      for (const part of sel.split(',').map((x) => x.trim()).filter(Boolean)) {
        expect(part).toMatch(/^(#pg-design-system|#ds-root|\.ds-|body\.ds-design-open|:is\(\.ds-)/);
      }
    }
  });

  it('is owned by the Owner context: #pg-design-system is bound to the owner tokens, nothing else added', () => {
    const web = json('tools/tokens/targets/web.json');
    expect(web.selectors.context.owner).toContain('#pg-design-system');
    expect(web.selectors.module['design-system']).toBeUndefined();
    expect(read('public/tokens/familista-tokens.css')).toContain('#pg-design-system');
  });

  it('is the only consumer: the token verifier allows --fam- under public/design-system/ and nowhere else', () => {
    const v = read('tools/tokens/scripts/verify.mjs');
    expect(v).toContain("const CONSUMERS = 'public/design-system/'");
    expect(json('tools/tokens/targets/web.json').version).toBe(/tokens\.css\?v=([^"]+)"/.exec(read('public/index.html'))![1]);
  });
});

describe('CSP, safety and public assets', () => {
  const js = stripComments(read('public/design-system/design-system.js'));
  const css = stripComments(read('public/design-system/design-system.css'));

  it('never writes a style attribute, inline handler or inline script: values go through the CSSOM', () => {
    expect(js).not.toMatch(/style="|style='|setAttribute\(\s*['"]style|onclick=|onerror=|onload=|javascript:/i);
    expect(js).toContain('el.style.setProperty(prop, v)');
  });

  it('never evaluates code and loads nothing from another origin', () => {
    expect(js).not.toMatch(/\beval\(|new Function\(|document\.write|importScripts|<script|<style|@import/);
    expect(js + css).not.toMatch(/https?:\/\//);
    expect([...js.matchAll(/fetch\(\s*((?:[^,()]|\(\))*)/g)].map((m) => m[1].trim())).toEqual([
      "'/design-system/i18n/' + tag + '.json'",
      'apiBase() + path',
    ]);
  });

  it('calls the API with GET only, and reaches exactly the two read endpoints', () => {
    expect(js).toContain("method: 'GET'");
    expect(js).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/i);
    expect([...js.matchAll(/api\('([^']+)'\)/g)].map((m) => m[1]).sort()).toEqual(['/system/design-system', '/system/design-system/tokens']);
  });

  it('ships nothing confidential: no manifest data, hash, token value table or environment name in public assets', () => {
    const everything = [js, css, read('public/design-system/i18n/en.json'), read('public/design-system/i18n/de.json'), read('public/design-system/i18n/ar.json')].join('\n');
    expect(everything).not.toMatch(/\b[0-9a-f]{64}\b/);
    expect(everything).not.toMatch(/process\.env|JWT_|DATABASE_URL|RENDER_|ANTHROPIC|password|secret/i);
    expect(fs.existsSync(path.join(ROOT, 'public/design-system/design-system-manifest.json'))).toBe(false);
    // The Visual Explorer's (3.2.1) and the Components Library's (3.2.2) two files each, and the Specimen Lab's (3.2.3), loaded only when their section opens.
    expect(fs.readdirSync(path.join(ROOT, 'public/design-system')).sort()).toEqual(['components.css', 'components.js', 'design-system.css', 'design-system.js', 'explorer.css', 'explorer.js', 'i18n', 'lab-sanitize.js', 'lab-view.js', 'lab.css', 'lab.js']);
  });

  it('serves its assets from the real app as static files, with the strict CSP unchanged', async () => {
    const res = await request(app).get('/design-system/design-system.css?v=x');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/css/);
    const csp = String((await request(app).get('/')).headers['content-security-policy'] || '');
    expect(csp).toMatch(/style-src 'self'/);
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
    const js = await request(app).get('/design-system/design-system.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    for (const tag of ['en', 'de', 'ar']) expect((await request(app).get(`/design-system/i18n/${tag}.json`)).status).toBe(200);
  });
});

describe('the room escapes whatever the manifest says (run for real, in a sandbox, with hostile data)', () => {
  const PAYLOAD = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function runRoom(data: Record<string, unknown>, tokens: Record<string, unknown>): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vm = require('vm');
    const src = read('public/design-system/design-system.js');
    const html: string[] = [];
    const listeners: Record<string, (e: unknown) => void> = {};
    const host: any = {
      set innerHTML(v: string) { html.push(v); }, get innerHTML() { return html[html.length - 1] || ''; },
      setAttribute() {}, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; },
    };
    const reply = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: body }) });
    const sandbox: any = {
      window: {} as any, document: { getElementById: () => host }, localStorage: { getItem: () => null, setItem: () => {} },
      fetch: (u: string) => (String(u).endsWith('/tokens') ? reply(tokens) : String(u).includes('/i18n/') ? Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) : reply(data)),
      Intl, console, Promise, Object, Array, String, Number, Date, Math, JSON, isFinite,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(src, sandbox);
    sandbox.renderFamilistaDesignSystem(host);
    const settle = () => new Promise((r) => setTimeout(r, 30));
    return settle().then(() => {
      listeners.click({ target: { closest: (sel: string) => (sel === '[data-ds-nav]' ? { getAttribute: () => 'tokens' } : null) } });
      return settle();
    }).then(() => html.join('\n'));
  }

  it('prints hostile strings as text in every place the manifest reaches the page', async () => {
    const hostile = JSON.parse(JSON.stringify(manifest));
    hostile.sources[0].path = PAYLOAD; hostile.sources[0].label = PAYLOAD;
    hostile.layers[0].description = PAYLOAD; hostile.layers[0].selectors = [PAYLOAD]; hostile.layers[0].base = PAYLOAD; hostile.layers[0].media = PAYLOAD;
    hostile.overview.css.version = PAYLOAD; hostile.overview.css.prefix = PAYLOAD;
    hostile.overview.unavailable[0] = { id: PAYLOAD, reason: PAYLOAD };
    const t0 = hostile.tokens[0];
    Object.assign(t0, { cssName: PAYLOAD, path: PAYLOAD, resolved: PAYLOAD, declared: PAYLOAD, aliasOf: PAYLOAD, source: PAYLOAD, type: PAYLOAD, layer: PAYLOAD });
    hostile.contrast[0] = { ...hostile.contrast[0], fg: PAYLOAD, bg: PAYLOAD, context: PAYLOAD, module: PAYLOAD };
    const overview = { state: 'READY', reason: null, readOnly: true, build: { commit: PAYLOAD }, generator: PAYLOAD, sources: hostile.sources, overview: hostile.overview, layers: hostile.layers };
    const tokens = { state: 'READY', reason: null, tokens: hostile.tokens, layers: hostile.layers, contrast: hostile.contrast };
    const out = await runRoom(overview, tokens);
    expect(out.length).toBeGreaterThan(5000);
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).not.toMatch(/<(img|script)\b/);
    expect(out).not.toMatch(/"[^"<>]*"><img/);
    expect(out).not.toContain(PAYLOAD);
  });

  it('draws a normal manifest into every section without throwing', async () => {
    const overview = { state: 'READY', reason: null, readOnly: true, build: { commit: null }, generator: manifest.generator, sources: manifest.sources, overview: manifest.overview, layers: manifest.layers };
    const tokens = { state: 'READY', reason: null, tokens: manifest.tokens, layers: manifest.layers, contrast: manifest.contrast };
    const out = await runRoom(overview, tokens);
    expect(out).toContain('ds-metric-value');
    expect(out).toContain('id="ds-rows"');
    expect(out).toContain('ds-table--tokens');
    // A measured zero is drawn as 0 (the reserved Theme layer), and an absent commit as an em dash.
    expect(out).toMatch(/<bdi dir="ltr">0 \/ 259<\/bdi>/);
    expect(out).toMatch(/ds-foot-at"[^>]*>—<\/span>/);
  });
});

describe('responsive, stable layout and accessibility, as the product pins them', () => {
  const css = read('public/design-system/design-system.css');
  const js = read('public/design-system/design-system.js');

  it('carries the escape hatch every workspace carries', () => {
    expect(css).toMatch(/@media \(max-width: 980px\), \(max-height: 620px\)/);
    expect(css).toMatch(/\.ds-shell \{ display: block; height: auto; overflow: visible; \}/);
  });

  it('is a fixed-height flex column whose body scrolls inside itself with a stable gutter', () => {
    expect(css).toMatch(/\.ds-shell \{ display: flex; height: 100vh;[^}]*overflow: hidden; \}/);
    expect(css).toMatch(/\.ds-body \{[^}]*scrollbar-gutter: stable/);
    expect(css).toMatch(/\.ds-body \{[^}]*overflow-y: auto/);
  });

  it('floats nothing in the flow: the language menu is out of flow and animates opacity and transform only', () => {
    const menu = css.match(/\.ds-lang-menu \{[^}]*\}/)![0];
    expect(menu).toMatch(/position: absolute/);
    expect(menu).toMatch(/transition: opacity[^;]*, transform[^;]*, visibility/);
    expect(menu).not.toMatch(/(height|width|top|margin)[^;]*transition/);
  });

  it('keeps a fixed minimum width on the button whose label changes, and sizes every skeleton', () => {
    expect(css).toMatch(/\.ds-btn \{[^}]*min-width: 112px/);
    for (const s of ['ds-skel-row--row', 'ds-skel-intro', 'ds-skel-strip', 'ds-skel-grid']) expect(css).toMatch(new RegExp(`\\.${s} \\{ height: \\d+px; \\}`));
  });

  it('repaints the rows, not the shell, when a filter changes', () => {
    expect(js).toMatch(/function repaintRows\(host\)/);
    expect(js).toMatch(/if \(t && t\.id === 'ds-q'\) \{ DS\.q = t\.value; repaintRows\(host\); \}/);
  });

  it('uses logical properties so the room mirrors in right-to-left: no physical left/right', () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/(^|[;{\s])(left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right)\s*:/m);
    expect(code).not.toMatch(/text-align:\s*(left|right)/);
    expect(js).toContain("host.setAttribute('dir', DS_DIR)");
    expect(js).toContain("host.setAttribute('lang', DS_LANG)");
  });

  it('is operable and announced: landmarks, tabs, labelled controls, a live count, a visible focus ring', () => {
    expect(js).toContain('role="tablist"');
    expect(js).toContain('aria-selected');
    expect(js).toContain('aria-current="page"');
    expect(js).toContain('aria-live="polite"');
    expect(js).toContain('<nav class="ds-rail-body"');
    expect(js).toContain("ev.key === 'Escape'");
    expect(js).toMatch(/ArrowRight[\s\S]*rtl/);
    expect(css).toMatch(/:focus-visible \{\s*outline: var\(--fam-border-width-strong\) solid var\(--fam-focus-ring\)/);
    expect(css).toMatch(/\.ds-sr \{/);
  });

  it('draws measured, recorded and not-recorded differently, and draws absence as an em dash', () => {
    expect(js).toContain("var EV_KIND = { MEASURED: 'info', RECORDED: 'rec', NONE: 'none' }");
    expect(js).toMatch(/function num\(n, digits\) \{\s*if \(typeof n !== 'number' \|\| !isFinite\(n\)\) return '—';/);
    expect(css).toMatch(/\.ds-chip--none \{[^}]*border-style: dotted/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('English, German and Arabic — one catalogue each, in step', () => {
  const dict = (t: string) => json(`public/design-system/i18n/${t}.json`) as Record<string, string>;
  const en = dict('en'); const de = dict('de'); const ar = dict('ar');
  const js = read('public/design-system/design-system.js');
  const slots = (s: string) => (s.match(/%d/g) || []).length;
  // Identifiers, product names and technical terms that are the same in every language.
  const SAME = new Set(['Dimension', 'Storybook', 'Text', 'Version', 'Theme', 'Token', 'Tokens', 'prefers-reduced-motion: reduce',
    'Alias', 'Details', 'Graph', 'Name', 'Stylesheet', 'Stylesheets', 'Zoom',
    // Stage 3.2.2: product names and technical terms that read the same in every language.
    'SHA-256', 'Symbol', 'System', 'Tablet', 'Stories', 'Data Vault', 'Infrastructure City', 'Source Core', 'Familista Vision',
    // Stage 3.2.3: terms that read the same in German.
    'Build', 'Bytes', 'Server']);

  it('has the same keys in all three, and English maps each key to itself', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(en)) expect(v).toBe(k);
  });

  it('translates every key: no blank, no English left behind, every %d slot kept', () => {
    for (const k of Object.keys(en)) {
      for (const d of [de, ar]) {
        expect(d[k].trim().length).toBeGreaterThan(0);
        // A singular form ("one rule") may spell the number as a word, as Arabic does.
        if (!/^%d (rule|variant|case|fixture|element|node)$/.test(k)) expect(slots(d[k])).toBe(slots(k));
      }
      if (!SAME.has(k)) {
        expect(de[k]).not.toBe(k);
        expect(ar[k]).not.toBe(k);
      }
    }
  });

  it('writes Arabic in Arabic script', () => {
    for (const [k, v] of Object.entries(ar)) if (!SAME.has(k) && !/^%d new$/.test(k)) expect(v).toMatch(/[\u0600-\u06FF]/);
  });

  it('covers every literal the room passes through T(), tf() and its helpers', () => {
    const calls = [...js.matchAll(/\b(?:T|tf|panel|kv|metric|emptyState|chip\([^,]+,|bars)\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
    const keys = [...new Set(calls)].filter((k) => /[A-Za-z]{2}/.test(k));
    expect(keys.length).toBeGreaterThan(60);
    const missing = keys.filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  it('covers every label, meaning and reason held in the room’s vocabulary maps', () => {
    const names = ['EV_LABEL', 'EV_MEANING', 'LAYER_LABEL', 'LAYER_MEANING', 'STATUS_LABEL', 'ROLE_LABEL', 'TYPE_LABEL', 'CTX_LABEL', 'UNAVAILABLE_LABEL', 'UNAVAILABLE_WHY'];
    const values = names.flatMap((n) => [...objectLiteral(js, n).matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\'/g, "'")));
    expect(values.length).toBeGreaterThan(50);
    expect(values.filter((v) => !(v in en))).toEqual([]);
  });

  it('covers every label, description and reason the manifest hands it', () => {
    const fromManifest = [
      ...manifest.sources.map((s: { label: string }) => s.label),
      ...manifest.overview.unavailable.map((u: { reason: string }) => u.reason),
      ...manifest.layers.map((l: { description: string | null }) => l.description).filter(Boolean),
    ] as string[];
    expect(fromManifest.filter((k) => !(k in en))).toEqual([]);
  });

  it('covers the reasons the server gives when it cannot read the manifest', () => {
    const svc = read('src/design-system/design-system.service.ts');
    expect(svc).toContain('const MISSING = ');
    expect(en).toHaveProperty(['The design-system manifest is not beside this server (run scripts/design-system-discover.js).']);
    expect(en).toHaveProperty(['The design-system manifest is not schema 1.']);
  });

  it('is limited to English, German and Arabic, with Arabic right-to-left, behind the page’s own boundary', () => {
    expect(js).toContain("var DS_LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']]");
    expect(read('public/app.js')).toContain('id="pg-design-system" data-no-i18n');
    expect(fs.readdirSync(path.join(ROOT, 'public/design-system/i18n')).sort()).toEqual(['ar.json', 'de.json', 'en.json']);
  });

  it('leaves the platform’s language registry, bundles and validation alone', () => {
    expect(js).not.toMatch(/\bI18N\b|\/i18n\/locales|\/i18n\/catalogue|familista\.locale/);
    for (const t of ['en-GB', 'de-DE', 'ar']) expect(read('src/i18n/locales.ts')).toContain(`'${t}'`);
  });

  it('falls back to English, never to a key path or undefined', () => {
    expect(js).toMatch(/Object\.prototype\.hasOwnProperty\.call\(DS_DICT, s\) \? DS_DICT\[s\] : s/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Owner Home: the ninth card, DESIGN SYSTEM CONTROL', () => {
  const appJs = read('public/app.js');
  const appCss = read('public/app.css');
  const platform = appJs.slice(appJs.indexOf('function _ownerHomeForPlatformOwner'), appJs.indexOf('function _ownerHomeForClubMember'));
  const member = appJs.slice(appJs.indexOf('function _ownerHomeForClubMember'), appJs.indexOf('function renderOwnerHome'));
  const card = platform.slice(platform.indexOf('<button class="oh-card oh-card--ds"'), platform.indexOf('</button>', platform.indexOf('<button class="oh-card oh-card--ds"')) + 9);

  it('exists only in the Platform Owner landing, which is built only after /system/whoami says so', () => {
    expect(card).toContain('data-page="design-system"');
    expect(member).not.toMatch(/design-system|oh-card--ds|DESIGN SYSTEM/);
    expect(appJs).toMatch(/Promise\.all\(\[_isPlatformOwner\(\), _famContextReady\]\)[\s\S]{0,400}yes\s*\n?\s*\?\s*_ownerHomeForPlatformOwner/);
    // The status read is made only inside the owner branch.
    expect(appJs).toMatch(/if \(yes\) \{[\s\S]{0,700}_fillDesignSystemStatus\(\)/);
  });

  it('is the last card in the markup, so the reading order is the grid order', () => {
    const order = [...platform.matchAll(/<button class="oh-card oh-card--(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['system', 'cyber', 'clubs', 'algo', 'vault', 'city', 'core', 'vision', 'ds']);
  });

  it('is a labelled, keyboard-reachable button: a real <button>, a decorative icon, a visible name', () => {
    expect(card).toMatch(/^<button class="oh-card oh-card--ds" data-action="navTo" data-page="design-system" type="button">/);
    expect(card).toContain('<div class="oh-card-icon" aria-hidden="true">');
    expect(card).toContain('<div class="oh-card-title">DESIGN SYSTEM CONTROL</div>');
    expect(card).toContain('<div class="oh-card-cta">Enter Design System <span>→</span></div>');
    expect(card).not.toMatch(/tabindex|onclick|style=/);
  });

  describe('its status line is read from the Overview API and says only what was measured', () => {
    const src = appJs.slice(appJs.indexOf('function _fillDesignSystemStatus'), appJs.indexOf('function _fillSourceCoreStatus'));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vm = require('vm');
    type Reply = { ok: boolean; status: number; body?: unknown } | 'reject';
    async function run(reply: Reply) {
      const writes: string[] = []; const calls: { url: string; opts: Record<string, any> }[] = [];
      const slot = { set outerHTML(v: string) { writes.push(v); } };
      const sandbox: any = {
        window: { State: { token: 'tok' } }, localStorage: { getItem: () => null },
        document: { getElementById: () => slot },
        fetch: (url: string, opts: Record<string, any>) => { calls.push({ url, opts }); return reply === 'reject' ? Promise.reject(new Error('net')) : Promise.resolve({ ok: reply.ok, status: reply.status, json: () => Promise.resolve(reply.body) }); },
        _vaultStatusHTML: (state: string, text: string) => `<span class="oh-card-state oh-card-state--${state}">${text}</span>`,
        Promise, Error, Object, Number, JSON, String,
      };
      sandbox.window.localStorage = sandbox.localStorage;
      vm.runInNewContext(`${src}\n_fillDesignSystemStatus();`, sandbox);
      await new Promise((r) => setTimeout(r, 20));
      return { out: writes.join(''), calls };
    }
    const ready = (tokens: unknown, fresh: unknown) => ({ ok: true, status: 200, body: { success: true, data: { state: 'READY', overview: { tokens: { total: { value: tokens } }, contrast: { newFailures: { value: fresh } } } } } });

    it('is green, with a measured 0 printed as 0, when no contrast failure is beyond the recorded baseline', async () => {
      const r = await run(ready(259, 0));
      expect(r.out).toContain('oh-card-state--ok');
      expect(r.out).toContain('Design tokens: 259 · new contrast failures: 0');
      expect(r.out).toContain('id="oh-design-state"');
    });

    it('asks the room’s overview endpoint, with GET, carrying the session and nothing else', async () => {
      const r = await run(ready(259, 0));
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].url).toBe('/api/v1/system/design-system');
      expect(r.calls[0].opts).toMatchObject({ method: 'GET', credentials: 'include', headers: { Authorization: 'Bearer tok' } });
      expect(r.calls[0].opts.body).toBeUndefined();
    });

    it('is red when a contrast failure beyond the baseline exists', async () => {
      const r = await run(ready(259, 2));
      expect(r.out).toContain('oh-card-state--bad');
      expect(r.out).toContain('new contrast failures: 2');
    });

    it('is amber when the manifest has not been generated, and invents no figure', async () => {
      const r = await run({ ok: true, status: 200, body: { data: { state: 'NOT_GENERATED', overview: null } } });
      expect(r.out).toContain('oh-card-state--warn');
      expect(r.out).toContain('Design System manifest not generated');
      expect(r.out).not.toMatch(/\d/);
    });

    it('says unreachable on a refusal or a network failure, and draws no number for an answer it cannot read', async () => {
      for (const reply of [{ ok: false, status: 403 }, 'reject'] as Reply[]) {
        const r = await run(reply);
        expect(r.out).toContain('oh-card-state--bad');
        expect(r.out).toContain('Design System unreachable');
      }
      const malformed = await run({ ok: true, status: 200, body: { data: { state: 'READY', overview: { tokens: {} } } } });
      expect(malformed.out).toContain('oh-card-state--idle');
      expect(malformed.out).not.toMatch(/Design tokens:/);
    });

    it('never fabricates a figure', () => {
      expect(src).not.toMatch(/Math\.random|\|\|\s*0\b/);
    });
  });

  describe('the 3×3 grid', () => {
    it('is three columns and three rows of equal cards, in reading order', () => {
      expect(appCss).toMatch(/body\.club-theme \.oh-cards--core\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);\s*grid-auto-rows: 1fr;\s*grid-template-areas:\s*"system cyber  clubs"\s*"algo   vault  city"\s*"core   vision design";\s*\}/);
      expect(appCss).toContain('body.club-theme .oh-cards--core .oh-card--ds{     grid-area: design; }');
    });

    it('is two columns from 1339px down, with the ninth centred at the width of every other card', () => {
      const m = appCss.match(/@media \(max-width: 1339px\)\{\s*body\.club-theme \.oh-cards--core\{([\s\S]*?)\n  \}\n\}/);
      expect(m).not.toBeNull();
      expect(m![1]).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));');
      expect(m![1]).toMatch(/"system system clubs  clubs"\s*"cyber  cyber  algo   algo "\s*"core   core   vision vision"\s*"vault  vault  city   city"\s*"\.      design design \."/);
    });

    it('is one column from 900px down, the ninth last, as it was', () => {
      expect(appCss).toContain('grid-template-areas: "system" "cyber" "clubs" "algo" "core" "vision" "vault" "city" "design";');
      expect(appCss).toMatch(/@media \(max-width: 900px\)\{\s*body\.club-theme \.oh-cards--core\{\s*grid-template-columns: 1fr; max-width: 560px; margin-inline: auto;\s*grid-auto-rows: auto;/);
    });

    it('is the old eight-track grid no longer', () => {
      expect(appCss).not.toContain('grid-template-columns: repeat(8, minmax(0, 1fr));');
      expect(appCss).not.toMatch(/@media \(max-width: 1560px\)\{\s*body\.club-theme \.oh-cards--core/);
    });

    it('draws the ninth card’s identity as an edge, a hairline and a whisper of tint, in literal colours', () => {
      const block = appCss.slice(appCss.indexOf('body.club-theme .oh-cards--core .oh-card--ds{'), appCss.indexOf('body.club-theme .oh-card--ds .oh-card-cta{'));
      expect(block).toContain('body.club-theme .oh-cards--core .oh-card--ds::before{');
      expect(block).toContain('body.club-theme .oh-cards--core .oh-card--ds:hover{');
      expect(block).toContain('linear-gradient(90deg, #fbbf24, #fde68a, #fbbf24)');
      expect(block).toMatch(/border-color: rgba\(251,191,36,0\.26\)/);
      expect(block).not.toMatch(/background:\s*#|background-color:\s*#/);
      // The new card's detail line meets 4.5:1 on #131826 (#7a889e is 4.93:1); the shared tertiary colour is not touched.
      expect(appCss).toContain('body.club-theme .oh-card--ds .oh-card-list{ color: #7a889e; }');
      expect(appCss).toContain('body.club-theme .oh-card-list{\n  font-size: 12.5px; color: var(--t-tertiary);');
      // app.css reads no design token: only the Design System Control room does.
      expect(appCss).not.toMatch(/--fam-/);
    });

    it('does not change a single rule of the other cards’ identities', () => {
      for (const c of ['system', 'cyber', 'clubs', 'algo', 'vault', 'city', 'core', 'vision']) {
        expect(appCss).toContain(`.oh-card--${c}`);
      }
      expect(appCss).toContain("body.club-theme .oh-card--algo .oh-card-cta{ color: #efc3ff; }");
      expect(appCss).toContain('body.club-theme .oh-card--vision .oh-card-cta{ color: #22d3ee; }');
    });
  });

  it('is drawn on entry and never by club data, which it does not read (M3 / S1)', () => {
    // Listed among the club-data pages, every club-data change redrew the room and mounted the Lab again under the reader,
    // losing the click they were making and their scroll, and club data was read for a room that never shows it.
    const app = read('public/app.js');
    const registry = app.slice(app.indexOf('var _FAM_PAGE_RENDER = {'), app.indexOf('var _FAM_GIS_PAGES'));
    expect(registry.length).toBeGreaterThan(0);
    expect(registry).not.toMatch(/^\s*'design-system'\s*:\s*\[/m);
    // Drawn by navTo on every real entry (leaving tears its Lab down), after the page is mounted and activated, and again when
    // the root on the page is not the one drawn; the root is marked when the draw starts, so two routes a moment apart draw once.
    const nav = app.slice(app.indexOf('function navTo(page, el, _opts) {'));
    const hook = nav.indexOf("if (page === 'design-system' && typeof window.renderFamilistaDesignSystem === 'function'");
    expect(hook).toBeGreaterThan(nav.indexOf("_ensurePageMounted(page); } catch (_) {}"));
    expect(hook).toBeGreaterThan(nav.indexOf("_famRenderPage(page); } catch (_) {}"));
    const guard = nav.slice(hook, hook + 400);
    expect(guard).toContain("&& _dsRoot && (_leaving !== 'pg-design-system' || !_dsRoot.__famDrawn)) {");
    expect(guard).toContain('_dsRoot.__famDrawn = true;');
    expect(guard).toContain('window.renderFamilistaDesignSystem(_dsRoot);');
  });

  it('is shipped with fresh asset versions, so no browser mixes the old script with the new stylesheet', () => {
    const html = read('public/index.html');
    expect(html).toContain('/app.css?v=20261012-owner-home-ds');
    expect(html).toContain('/app.js?v=20261017-design-system-room');
    expect(html).not.toContain('/app.js?v=20261012-owner-home-ds');
    expect(html).not.toMatch(/\/app\.(css|js)\?v=20261004-algorithms/);
  });

  it('loads the design system under a version no older than any section it lazy-loads, so no cached loader can hide a new stage', () => {
    // Each lazy section's version lives inside design-system.js, which app.js fetches at a fixed URL. If that URL
    // stays put while a section moves on, a cached loader keeps requesting the previous section's script.
    const day = (v: string) => Number((/^(\d{8})/.exec(v) ?? [])[1]);
    const loaderVersions = (src: string) => [...src.matchAll(/\/design-system\/design-system\.(?:css|js)\?v=([\w-]+)/g)].map((m) => m[1]);
    const sectionVersions = (src: string) => [...objectLiteral(src, 'LAZY').matchAll(/\bv: '([\w-]+)'/g)].map((m) => m[1]);
    const behind = (appSrc: string, dsSrc: string) => {
      const loader = loaderVersions(appSrc);
      const newest = sectionVersions(dsSrc).sort((a, b) => day(b) - day(a))[0];
      return loader.filter((v) => !(day(v) >= day(newest))).map((v) => `${v} < ${newest}`);
    };
    const appSrc = read('public/app.js');
    const dsSrc = read('public/design-system/design-system.js');

    // One version for the stylesheet and the script, so neither is ever fetched without the other.
    const loader = loaderVersions(appSrc);
    expect(loader).toHaveLength(2);
    expect(new Set(loader).size).toBe(1);
    expect(sectionVersions(dsSrc).length).toBeGreaterThanOrEqual(3);
    expect(sectionVersions(dsSrc).every((v) => day(v) > 0)).toBe(true);
    expect(behind(appSrc, dsSrc)).toEqual([]);

    // The guard bites, whatever the current versions are: a loader left on the version that hid M2 / S3 is reported, and so is
    // a section that moves a day past today's loader.
    const newest = sectionVersions(dsSrc).sort((a, b) => day(b) - day(a))[0];
    expect(behind(appSrc.split(loader[0]).join('20261012-design-system'), dsSrc)).toEqual([
      `20261012-design-system < ${newest}`, `20261012-design-system < ${newest}`]);
    const next = String(day(loader[0]) + 1) + '-lab-next';
    expect(day(next)).toBeGreaterThan(day(loader[0]));
    expect(behind(appSrc, dsSrc.replace(`v: '${newest}'`, `v: '${next}'`))).toEqual([`${loader[0]} < ${next}`, `${loader[0]} < ${next}`]);
  });

  describe('translation', () => {
    const N = '\u0000';
    const KEYS = ['DESIGN SYSTEM CONTROL', 'Design Tokens, Contrast, Provenance & Evidence', 'Enter Design System',
      'Overview · Design Tokens · Layers · Contrast · Provenance', 'Reading design system evidence…',
      `Design tokens: ${N} · new contrast failures: ${N}`, 'Design System manifest not generated', 'Design System unreachable'];
    const dir = path.join(ROOT, 'public/i18n/catalogue');
    // en-US is an empty overlay on en-GB; every other file is a full catalogue.
    const tags = fs.readdirSync(dir).filter((f) => /^[a-z]{2,3}(-[A-Z]{2})?\.json$/.test(f)).map((f) => f.replace('.json', '')).filter((t) => t !== 'en-US');
    const cat = (t: string) => JSON.parse(fs.readFileSync(path.join(dir, `${t}.json`), 'utf8')) as Record<string, string>;
    const pending = JSON.parse(read('public/i18n/_pending-translation.json'));

    it('is in every locale the platform ships, with the card’s eight strings', () => {
      expect(tags.length).toBeGreaterThanOrEqual(30);
      for (const t of tags) for (const k of KEYS) expect(`${t} ${JSON.stringify(k)}: ${typeof cat(t)[k]}`).toBe(`${t} ${JSON.stringify(k)}: string`);
    });

    it('is genuinely translated into German and Arabic, with the same number slots', () => {
      for (const t of ['de-DE', 'ar']) {
        for (const k of KEYS) {
          expect(cat(t)[k]).not.toBe(k);
          expect((cat(t)[k].match(/\u0000/g) || []).length).toBe((k.match(/\u0000/g) || []).length);
        }
      }
      for (const k of KEYS) expect(cat('ar')[k]).toMatch(/[؀-ۿ]/);
    });

    it('marks every other locale’s English stand-in as pending, and presents none as a translation', () => {
      const inPending = (t: string) => Array.isArray(pending.locales[t]) && pending.locales[t].length > 0;
      for (const t of tags) {
        if (t === 'de-DE' || t === 'ar' || t.startsWith('en-')) continue;
        const placeholders = KEYS.filter((k) => cat(t)[k] === k);
        if (placeholders.length) expect(`${t} pending: ${inPending(t)}`).toBe(`${t} pending: true`);
      }
    });

    it('keeps English the key, so the English screen is unchanged', () => {
      for (const k of KEYS) expect(cat('en-GB')[k]).toBe(k);
    });
  });
});

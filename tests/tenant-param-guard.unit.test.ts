/**
 * tests/tenant-param-guard.unit.test.ts
 *
 * Cyber Defense, R2 — an id in the URL is checked against the caller's club
 * before the handler runs.
 *
 * Before: eight routers said `router.use(tenantGuard)`. Express fills
 * req.params in only after a route matches, so mounted that way the guard saw
 * an empty object and checked nothing. Where a service forgot its own check,
 * nothing else stood in the way — and seven did forget: another club's device
 * calibration, firmware and health, camera calibration, invoice lines, match
 * statistics (read and rebuild), competition entrants, and simulation state
 * (a write) were all reachable with nothing but the id.
 *
 * After: the route names the resource its parameter is —
 * `tenantParam('device')` — and the guard resolves that row's club. Driven here
 * through the real routers.
 */

import express from 'express';
import request from 'supertest';

const CLUB_A = '11111111-1111-4111-8111-111111111111';
const CLUB_B = '22222222-2222-4222-8222-222222222222';
const OWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GLOBAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// Every model answers findUnique by id from this table; everything else is an
// inert stub, so a request that passes the guard reaches its handler and fails
// (or not) there — which is not what these tests measure.
const rows: Record<string, Record<string, Record<string, unknown>>> = {
  device:                      { [OWN]: { clubId: CLUB_A }, [FOREIGN]: { clubId: CLUB_B } },
  camera:                      { [OWN]: { clubId: CLUB_A }, [FOREIGN]: { clubId: CLUB_B } },
  match:                       { [OWN]: { clubId: CLUB_A, teamId: null }, [FOREIGN]: { clubId: CLUB_B, teamId: null } },
  edgeNode:                    { [OWN]: { clubId: CLUB_A }, [FOREIGN]: { clubId: CLUB_B } },
  edgeVisionRuntime:           { [OWN]: { clubId: CLUB_A }, [FOREIGN]: { clubId: CLUB_B } },
  decisionCouncil:             { [OWN]: { clubId: CLUB_A }, [FOREIGN]: { clubId: CLUB_B } },
  cryptographicGraphAnchor:    { [OWN]: { clubId: CLUB_A }, [FOREIGN]: { clubId: CLUB_B } },
  aIApprovalRequest:           { [OWN]: { clubId: CLUB_A }, [FOREIGN]: { clubId: CLUB_B } },
  twinSimulationSession:       { [OWN]: { clubId: CLUB_A }, [FOREIGN]: { clubId: CLUB_B } },
  competition:                 { [OWN]: { clubId: CLUB_A }, [FOREIGN]: { clubId: CLUB_B }, [GLOBAL]: { clubId: null } },
  cameraRig:                   { 'rig-a': { clubId: CLUB_A }, 'rig-b': { clubId: CLUB_B } },
  cameraSyncSession:           { [OWN]: { rigId: 'rig-a' }, [FOREIGN]: { rigId: 'rig-b' } },
  billingAccount:              { 'acct-a': { clubId: CLUB_A }, 'acct-b': { clubId: CLUB_B } },
  invoiceDraft:                { [OWN]: { billingAccountId: 'acct-a' }, [FOREIGN]: { billingAccountId: 'acct-b' } },
};
let failLookups = false;
const reached: string[] = [];

jest.mock('../src/config/database', () => {
  const model = (name: string) => new Proxy({}, {
    get: (_t, op: string) => async (args: { where?: { id?: string } } = {}) => {
      if (op === 'findUnique') {
        if (failLookups) throw new Error('database unavailable');
        const id = args.where?.id;
        const r = id ? rows[name]?.[id] : undefined;
        if (r !== undefined) return { ...r };
      }
      reached.push(`${name}.${op}`);
      if (op === 'findMany' || op === 'groupBy') return [];
      if (op === 'count') return 0;
      return null;
    },
  });
  const prisma = new Proxy({}, { get: (_t, name: string) => (name.startsWith('$') ? async () => [] : model(name)) });
  return { prisma };
});

const events: Array<{ kind: string; severity: string; payload?: Record<string, unknown> }> = [];
jest.mock('../src/security/security-event.service', () => ({
  logSecurityEvent: (e: { kind: string; severity: string; payload?: Record<string, unknown> }) => { events.push(e); },
  logSecurityEventAsync: async (e: { kind: string; severity: string }) => { events.push(e); },
}));

jest.mock('../src/middleware/auth.middleware', () => {
  const actual = jest.requireActual('../src/middleware/auth.middleware');
  return {
    ...actual,
    authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      const role = String(req.headers['x-role'] ?? 'CLUB_ADMIN');
      (req as unknown as { user: unknown }).user = { id: 'user-a', email: 'a@test.invalid', role, clubId: CLUB_A };
      next();
    },
  };
});

import { tenantGuard, tenantParam, TENANT_RESOURCES } from '../src/middleware/tenant-guard.middleware';

function appWith(mount: string, router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  // Anything that got past the guard ends here, whatever the handler did.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(599).json({ reachedHandler: true, err: err.message });
  });
  return app;
}

const TENANT_REFUSAL = { success: false, message: 'Forbidden — tenant mismatch' };

beforeEach(() => { events.length = 0; reached.length = 0; failLookups = false; });

describe('the old wiring: router.use(tenantGuard) checks nothing', () => {
  it('lets another club\'s match id straight through, because req.params is empty when it runs', async () => {
    const r = express.Router();
    r.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: 'u', clubId: CLUB_A, role: 'CLUB_ADMIN' }; next(); });
    r.use(tenantGuard);
    r.get('/matches/:matchId', (_req, res) => res.json({ handler: 'ran' }));
    const res = await request(appWith('/x', r)).get(`/x/matches/${FOREIGN}`);
    expect(res.body).toEqual({ handler: 'ran' });
    expect(events).toEqual([]);
  });

  it('the same guard as a route parameter check refuses it', async () => {
    const r = express.Router();
    r.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: 'u', clubId: CLUB_A, role: 'CLUB_ADMIN' }; next(); });
    r.get('/matches/:matchId', tenantParam('match', 'matchId'), (_req, res) => res.json({ handler: 'ran' }));
    const res = await request(appWith('/x', r)).get(`/x/matches/${FOREIGN}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(TENANT_REFUSAL);
  });
});

// [router module, mount, method, path template] — every route below is a real
// route on a real router. `:x` is replaced by the row id under test.
const GUARDED: Array<[string, string, 'get' | 'post', string]> = [
  // Confirmed cross-club reads/writes before R2 (service took only the id).
  ['device-infra.routes', '/device-infra', 'get',  '/devices/:x/calibration'],
  ['device-infra.routes', '/device-infra', 'get',  '/devices/:x/calibration/history'],
  ['device-infra.routes', '/device-infra', 'get',  '/devices/:x/firmware'],
  ['vision.routes',       '/vision',       'get',  '/cameras/:x/calibration'],
  ['observability.routes', '/observability', 'get', '/devices/:x/health'],
  ['phase-o.routes',      '/phase-o',      'get',  '/ops/invoices/:x/lines'],
  ['phase-q.routes',      '/phase-q',      'get',  '/stats/matches/:x'],
  ['phase-q.routes',      '/phase-q',      'post', '/stats/matches/:x/rebuild'],
  ['phase-q.routes',      '/phase-q',      'get',  '/competitions/:x/teams'],
  ['phase-l.routes',      '/phase-l',      'post', '/simulation/sessions/:x/state'],
  // The five routers whose router-wide guard checked nothing.
  ['edge.routes',         '/edge',         'get',  '/nodes/:x'],
  ['security.routes',     '/security',     'post', '/approvals/:x/approve'],
  ['phase-m.routes',      '/phase-m',      'get',  '/councils/:x'],
  ['phase-n.routes',      '/phase-n',      'get',  '/kg/anchors/:x/verify'],
  ['neuro.routes',        '/neuro',        'post', '/runtimes/:x/health'],
  ['neuro.routes',        '/neuro',        'post', '/rigs/sync-sessions/:x/observations'],
];

describe.each(GUARDED)('%s %s %s %s', (mod, mount, method, template) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require(`../src/routes/${mod}`).default as express.Router;
  const app = appWith(mount, router);
  const call = (id: string, role = 'CLUB_ADMIN') => request(app)[method](`${mount}${template.replace(':x', id)}`).set('x-role', role).send({});

  it('refuses another club\'s row with 403 before the handler, and records a CRITICAL TENANT_MISMATCH', async () => {
    const res = await call(FOREIGN);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(TENANT_REFUSAL);
    expect(events).toEqual([expect.objectContaining({ kind: 'TENANT_MISMATCH', severity: 'CRITICAL' })]);
    expect(events[0].payload).toMatchObject({ scope: 'CLUB', attemptedClub: CLUB_B });
  });

  it('lets the caller\'s own row through to the handler', async () => {
    const res = await call(OWN);
    expect(res.body).not.toEqual(TENANT_REFUSAL);
    expect(events.filter((e) => e.kind === 'TENANT_MISMATCH')).toEqual([]);
  });

  it('lets the platform administrator through, and still records it', async () => {
    const res = await call(FOREIGN, 'SUPER_ADMIN');
    expect(res.body).not.toEqual(TENANT_REFUSAL);
    expect(events).toEqual([expect.objectContaining({ kind: 'TENANT_MISMATCH', severity: 'INFO' })]);
  });
});

describe('tenantParam itself', () => {
  const guarded = (resource: Parameters<typeof tenantParam>[0], role = 'CLUB_ADMIN') => {
    const r = express.Router();
    r.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: 'u', clubId: CLUB_A, role }; next(); });
    r.get('/:id', tenantParam(resource), (_req, res) => res.json({ handler: 'ran' }));
    return appWith('/t', r);
  };

  it('passes an unknown id on to the handler (which answers 404)', async () => {
    expect((await request(guarded('device')).get('/t/nope')).body).toEqual({ handler: 'ran' });
  });

  it('treats a row with no club as platform-wide (a global competition)', async () => {
    expect((await request(guarded('competition')).get(`/t/${GLOBAL}`)).body).toEqual({ handler: 'ran' });
  });

  it('resolves the club through the parent where the row has none', async () => {
    expect((await request(guarded('cameraSyncSession')).get(`/t/${FOREIGN}`)).status).toBe(403);
    expect((await request(guarded('invoiceDraft')).get(`/t/${FOREIGN}`)).status).toBe(403);
    expect((await request(guarded('invoiceDraft')).get(`/t/${OWN}`)).body).toEqual({ handler: 'ran' });
  });

  it('fails closed: a lookup that throws is an error, never a pass', async () => {
    failLookups = true;
    const res = await request(guarded('device')).get(`/t/${OWN}`);
    expect(res.status).toBe(599);
    expect(res.body.err).toMatch(/database unavailable/);
  });

  it('leaves an unauthenticated request to authenticate', async () => {
    const r = express.Router();
    r.get('/:id', tenantParam('device'), (_req, res) => res.json({ handler: 'ran' }));
    expect((await request(appWith('/t', r)).get(`/t/${FOREIGN}`)).body).toEqual({ handler: 'ran' });
  });

  it('covers exactly the resources the scanner accepts', () => {
    const scannerSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/middleware/tenant-guard.middleware.ts'), 'utf8') as string;
    const block = scannerSrc.slice(scannerSrc.indexOf('export const TENANT_RESOURCES'), scannerSrc.indexOf('} as const;'));
    expect([...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort()).toEqual(Object.keys(TENANT_RESOURCES).sort());
  });
});

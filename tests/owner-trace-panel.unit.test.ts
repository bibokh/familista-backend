/**
 * tests/owner-trace-panel.unit.test.ts
 *
 * A diagnostic that can see everything is a diagnostic that must be reachable
 * by almost nobody, and must record almost nothing.
 *
 * This is the platform owner's live trace: one request, from the click to the
 * paint, with the guards it passed and the queries it ran. Two properties make
 * it safe to run in production, and both are tested here rather than asserted
 * in a comment.
 *
 * WHO. The router's own guard is `assertPlatformOwner` — the same function
 * SYSTEM has always used. There is no second authorization system: a club
 * president and a head coach are refused by the function that already refuses
 * them everywhere else, and no route below it is reachable by any other means.
 *
 * WHAT. It records SHAPES. A stage is a category, a short name, a duration and
 * an outcome. Everything that leaves goes through one redaction function, and a
 * key that looks sensitive is DROPPED rather than masked — a mask still says the
 * field was there and how long it was. A password, a JWT, a refresh token, an
 * invitation token, a reset token, an address, a photograph: none of them can
 * reach a subscriber, and the tests below try each one.
 *
 * And it is OFF. Until the owner turns it on, `emit` is a boolean test and a
 * return; after thirty minutes it turns itself off again.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { UserRole } from '@prisma/client';

type Row = Record<string, any>;

const state = { users: [] as Row[], platformAdmins: [] as Row[] };

const db: Row = {
  user: { findUnique: async ({ where }: Row) => state.users.find((u) => u.id === where.id) ?? null },
  platformAdmin: {
    findUnique: async ({ where }: Row) =>
      state.platformAdmins.find((a) => a.userId === where.userId) ?? null,
  },
  securityEvent: { create: async () => ({}) },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};
jest.mock('../src/config/database', () => ({ prisma: db }));

jest.mock('../src/middleware/auth.middleware', () => {
  const actual = jest.requireActual('../src/middleware/auth.middleware');
  return {
    ...actual,
    authenticate: (req: Row, res: Row, next: () => void) => {
      const id = req.headers['x-test-user'];
      const u = id ? state.users.find((x) => x.id === id) : null;
      if (!u) { res.status(401).json({ success: false, message: 'Authentication required' }); return; }
      req.user = { id: u.id, email: u.email, role: u.role, clubId: u.clubId, isActive: true };
      next();
    },
  };
});

import traceRoutes from '../src/routes/owner-trace.routes';
import { errorHandler } from '../src/middleware/error.middleware';
import {
  emit, beginTrace, endTrace, enableTracing, disableTracing, isTracing,
  recentTraces, safeDetail, safeRoute, speedOf, subscribe,
  TRACE_CONFIG, _resetTracing,
} from '../src/observability/trace-bus';

const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as Row).requestId = 'fam-test'; next(); });
app.use('/system/trace', traceRoutes);
app.use(errorHandler);

const OWNER = 'u-owner';
const PRESIDENT = 'u-president';
const COACH = 'u-coach';

beforeEach(() => {
  _resetTracing();
  state.users = [
    { id: OWNER, email: 'o@familista.test', role: UserRole.CLUB_ADMIN, clubId: 'c1' },
    { id: PRESIDENT, email: 'p@familista.test', role: UserRole.CLUB_ADMIN, clubId: 'c1' },
    { id: COACH, email: 'c@familista.test', role: UserRole.HEAD_COACH, clubId: 'c1' },
  ];
  // Platform authority is a PlatformAdmin row, never a club role. The president
  // below carries the same account role as the owner deliberately: if the guard
  // read that, this suite would not be able to tell them apart.
  state.platformAdmins = [{ userId: OWNER, isActive: true, role: 'OWNER' }];
});
afterEach(() => { _resetTracing(); });

const as = (user: string) => request(app).get('/system/trace/status').set('x-test-user', user);

// ─────────────────────────────────────────────────────────────────────────────
describe('1-5 · the platform owner, and nobody else', () => {
  it('the owner reads the status and turns tracing on', async () => {
    const before = await as(OWNER);
    expect(before.status).toBe(200);
    expect(before.body.data.enabled).toBe(false);

    const on = await request(app).post('/system/trace/enable').set('x-test-user', OWNER).send({});
    expect(on.status).toBe(200);
    expect(on.body.data.enabled).toBe(true);
    expect(isTracing()).toBe(true);
    // And it expires on its own.
    expect(on.body.data.remainingMs).toBeGreaterThan(0);
    expect(on.body.data.remainingMs).toBeLessThanOrEqual(TRACE_CONFIG.MAX_ENABLED_MS);
  });

  it('a club president is refused every route, including the stream', async () => {
    for (const [method, url] of [
      ['get', '/system/trace/status'], ['get', '/system/trace/recent'],
      ['get', '/system/trace/stream'], ['post', '/system/trace/enable'],
      ['post', '/system/trace/disable'], ['post', '/system/trace/client'],
    ] as Array<['get' | 'post', string]>) {
      const res = await (request(app) as Row)[method](url).set('x-test-user', PRESIDENT).send({});
      expect(`${method.toUpperCase()} ${url} → ${res.status}`).toBe(`${method.toUpperCase()} ${url} → 403`);
    }
  });

  it('a head coach is refused the same way', async () => {
    for (const url of ['/system/trace/status', '/system/trace/recent', '/system/trace/stream']) {
      const res = await request(app).get(url).set('x-test-user', COACH);
      expect(`${url} → ${res.status}`).toBe(`${url} → 403`);
    }
    const on = await request(app).post('/system/trace/enable').set('x-test-user', COACH).send({});
    expect(on.status).toBe(403);
    expect(isTracing()).toBe(false);
  });

  it('and typing the URL is exactly as far as they get', async () => {
    // There is no query parameter, header or body that opens it: the guard runs
    // before every handler and reads only the PlatformAdmin table.
    const tries = [
      request(app).get('/system/trace/stream?owner=1').set('x-test-user', PRESIDENT),
      request(app).get('/system/trace/recent?limit=200').set('x-test-user', COACH),
      request(app).post('/system/trace/enable').set('x-test-user', PRESIDENT)
        .set('x-platform-owner', 'true').send({ owner: true, role: 'SUPER_ADMIN' }),
    ];
    for (const t of tries) expect((await t).status).toBe(403);
  });

  it('the stream requires a session at all', async () => {
    for (const url of ['/system/trace/stream', '/system/trace/status', '/system/trace/recent']) {
      const res = await request(app).get(url);
      expect(`${url} anonymous → ${res.status}`).toBe(`${url} anonymous → 401`);
    }
  });

  it('and the guard is the one SYSTEM already uses, not a second one', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/owner-trace.routes.ts'), 'utf8');
    expect(src).toContain("import { assertPlatformOwner } from '../platform/system.service'");
    expect(src).toContain('await assertPlatformOwner(');
    // No role name is compared anywhere in the router.
    expect(src).not.toMatch(/CLUB_OWNER|CLUB_ADMIN|HEAD_COACH|=== 'SUPER_ADMIN'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('6-9 · nothing sensitive can leave', () => {
  const SECRETS: Array<[string, unknown]> = [
    ['password', 'hunter2'],
    ['passwordHash', '$2b$10$abcdefghijklmnopqrstuv'],
    ['token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aaaaaaaaaaaa'],
    ['accessToken', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.bbbbbbbbbbbb'],
    ['refreshToken', 'r'.repeat(64)],
    ['invitationToken', 'i'.repeat(48)],
    ['resetToken', 'z'.repeat(40)],
    ['tokenHash', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'],
    ['authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y'],
    ['cookie', 'sid=abcdef; Path=/'],
    ['apiKey', 'sk-live-0123456789abcdefghijklmnop'],
    ['avatar', 'data:image/jpeg;base64,AAAAAAAAAAAA'],
    ['email', 'somebody@example.com'],
    ['medicalStatus', 'INJURED'],
    ['dateOfBirth', '2009-04-01'],
    ['parentEmail', 'parent@example.com'],
    ['weeklyWage', '48000'],
    ['body', '{"firstName":"Ada"}'],
  ];

  it('every sensitive key is dropped, not masked', () => {
    for (const [key, value] of SECRETS) {
      const out = safeDetail({ [key]: value, model: 'Player' });
      expect(`${key} present: ${!!(out && key in out)}`).toBe(`${key} present: false`);
      // The safe neighbour survives, so this is redaction and not a blanket
      // refusal that would make the panel useless.
      expect(out && out.model).toBe('Player');
    }
  });

  it('and a credential smuggled under an innocent name is caught by its shape', () => {
    for (const value of [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.cccccccccccc',
      'Bearer abc.def.ghi',
      'data:image/png;base64,iVBORw0KGgo=',
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      'k'.repeat(48),
      'coach@club.example',
    ]) {
      const out = safeDetail({ note: value, ok: 'plain' });
      expect(`${value.slice(0, 12)} kept: ${!!(out && 'note' in out)}`)
        .toBe(`${value.slice(0, 12)} kept: false`);
    }
  });

  it('a whole emitted stage carries only what redaction let through', () => {
    enableTracing(OWNER);
    beginTrace('r1', { method: 'POST', route: '/api/v1/invitations' });
    emit('r1', 'SERVICE', 'invitation created', {
      detail: {
        password: 'hunter2',
        token: 'eyJhbGciOiJIUzI1NiJ9.a.b',
        refreshToken: 'r'.repeat(64),
        email: 'x@y.test',
        clubId: 'club-1',
        role: 'HEAD_COACH',
      },
    });
    const wire = JSON.stringify(recentTraces(1));
    for (const bad of ['hunter2', 'eyJhbGciOi', 'rrrrrrrr', 'x@y.test']) {
      expect(`${bad} on the wire: ${wire.includes(bad)}`).toBe(`${bad} on the wire: false`);
    }
    // What a diagnostic actually needs is still there.
    expect(wire).toContain('club-1');
    expect(wire).toContain('HEAD_COACH');
  });

  it('a route is a shape, never an address of somebody', () => {
    expect(safeRoute('/api/v1/players/3f2a1b4c-1111-2222-3333-444455556666/stats'))
      .toBe('/api/v1/players/:id/stats');
    expect(safeRoute('/api/v1/memberships/123456/suspend')).toBe('/api/v1/memberships/:id/suspend');
    // And a query string never travels at all.
    expect(safeRoute('/api/v1/players?search=Ada&token=abc')).toBe('/api/v1/players');
  });

  it('the database says which model and which verb, and no value', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/observability/prisma-trace.ts'), 'utf8');
    expect(src).toContain('`${model} ${verb}`');
    // The arguments Prisma hands it are never read beyond model and action.
    expect(src).not.toMatch(/params\.(args|data|where|select|include)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('10-13 · off by default, bounded, and unable to break anything', () => {
  it('nothing is recorded until the owner turns it on', () => {
    expect(isTracing()).toBe(false);
    beginTrace('r-off', { method: 'GET', route: '/x' });
    emit('r-off', 'DB', 'Player SELECT', { durationMs: 5 });
    endTrace('r-off', { status: 200 });
    expect(recentTraces(50)).toHaveLength(0);
  });

  it('and turning it off again forgets what it held', () => {
    enableTracing(OWNER);
    beginTrace('r2', { method: 'GET', route: '/x' });
    emit('r2', 'API', 'route matched');
    expect(recentTraces(50).length).toBe(1);
    disableTracing();
    expect(isTracing()).toBe(false);
    expect(recentTraces(50)).toHaveLength(0);
  });

  it('the buffer is bounded, and the oldest goes first', () => {
    enableTracing(OWNER);
    for (let i = 0; i < TRACE_CONFIG.BUFFER + 50; i++) {
      beginTrace(`r-${i}`, { method: 'GET', route: '/x' });
    }
    const held = recentTraces(TRACE_CONFIG.BUFFER);
    expect(held.length).toBe(TRACE_CONFIG.BUFFER);
    expect(held[held.length - 1].id).toBe(`r-${TRACE_CONFIG.BUFFER + 49}`);
    expect(held.find((t) => t.id === 'r-0')).toBeUndefined();
  });

  it('and one request cannot grow without limit either', () => {
    enableTracing(OWNER);
    beginTrace('r3', { method: 'GET', route: '/x' });
    for (let i = 0; i < TRACE_CONFIG.MAX_STAGES + 100; i++) emit('r3', 'DB', 'Player SELECT');
    expect(recentTraces(1)[0].stages.length).toBe(TRACE_CONFIG.MAX_STAGES);
  });

  it('a subscriber that throws cannot take a request down with it', () => {
    enableTracing(OWNER);
    const off = subscribe(() => { throw new Error('a broken pipe'); });
    expect(() => {
      beginTrace('r4', { method: 'GET', route: '/x' });
      emit('r4', 'API', 'route matched');
      endTrace('r4', { status: 200 });
    }).not.toThrow();
    off();
    expect(recentTraces(1)[0].status).toBe(200);
  });

  it('and a malformed stage is refused rather than stored', () => {
    enableTracing(OWNER);
    beginTrace('r5', { method: 'GET', route: '/x' });
    emit('r5', 'NOT_A_CATEGORY' as never, 'nonsense');
    emit(undefined, 'API', 'no id');
    emit('no-such-trace', 'API', 'unknown trace');
    expect(recentTraces(1)[0].stages).toHaveLength(0);
  });

  it('the middleware calls through whatever happens inside it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/observability/trace.middleware.ts'), 'utf8');
    // Every entry point wrapped, and next() outside the try.
    expect(src).toMatch(/catch \(_\) \{ \/\* tracing never stands between a request and its handler \*\/ \}\n  next\(\);/);
    const bus = fs.readFileSync(path.join(__dirname, '..', 'src/observability/trace-bus.ts'), 'utf8');
    for (const fn of ['export function emit(', 'export function beginTrace(', 'export function endTrace(']) {
      const at = bus.indexOf(fn);
      expect(bus.slice(at, bus.indexOf('\n}', at))).toContain('catch (_)');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('11 · one request, one timeline', () => {
  it('a browser stage and a server stage meet under the same id', async () => {
    await request(app).post('/system/trace/enable').set('x-test-user', OWNER).send({});
    // The click happens first, and is reported by the browser.
    const posted = await request(app).post('/system/trace/client').set('x-test-user', OWNER)
      .send({ stages: [{ id: 'req-A', category: 'UI', name: '"Invite Staff" clicked' }] });
    expect(posted.body.data.accepted).toBe(1);
    // Then the server's own stages, under the id the browser sent.
    emit('req-A', 'API', 'route matched');
    emit('req-A', 'DB', 'ClubInvitation INSERT', { durationMs: 6 });
    endTrace('req-A', { status: 201 });

    const res = await request(app).get('/system/trace/recent').set('x-test-user', OWNER);
    const trace = (res.body.data.traces as Row[]).find((t) => t.id === 'req-A') as Row;
    expect(trace).toBeTruthy();
    expect(trace.stages.map((s: Row) => s.category)).toEqual(['UI', 'API', 'DB']);
    expect(trace.status).toBe(201);
    expect(typeof trace.totalMs).toBe('number');
  });

  it('and the grading is one table, read by both sides', () => {
    expect(speedOf(100)).toBe('FAST');
    expect(speedOf(TRACE_CONFIG.SPEED.NORMAL)).toBe('NORMAL');
    expect(speedOf(TRACE_CONFIG.SPEED.SLOW)).toBe('SLOW');
    expect(speedOf(TRACE_CONFIG.SPEED.SLOW + 1)).toBe('CRITICAL');
    // And the panel reads those same numbers rather than keeping a second copy:
    // its grading function contains comparisons and no thresholds of its own.
    const panel = fs.readFileSync(path.join(__dirname, '..', 'public/owner-trace.js'), 'utf8');
    const fn = panel.slice(panel.indexOf('function speedOf(ms) {'), panel.indexOf('\n  }', panel.indexOf('function speedOf(ms) {')));
    expect(fn).toContain('OT.CONFIG && OT.CONFIG.SPEED');
    expect(fn).toContain('C.FAST');
    expect(fn).toContain('C.NORMAL');
    expect(fn).toContain('C.SLOW');
    expect(fn).not.toMatch(/\d{3,}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('16-17 · and the panel does not disturb what it watches', () => {
  const PANEL = fs.readFileSync(path.join(__dirname, '..', 'public/owner-trace.js'), 'utf8');
  const APP = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public/app.css'), 'utf8');
  const decomment = (x: string) =>
    x.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  it('the stream is one long-lived request, and never a poll', () => {
    const code = decomment(PANEL);
    expect(code).toContain("fetch(base + '/system/trace/stream'");
    expect(code).toContain('res.body.getReader()');
    // No interval anywhere: a diagnostic that polls is a diagnostic that adds
    // the load it is measuring.
    expect(code).not.toContain('setInterval');
  });

  it('and it carries the token in a header, never in the URL', () => {
    const code = decomment(PANEL);
    expect(code).toContain("Authorization: 'Bearer ' + token");
    expect(code).not.toMatch(/[?&]token=/);
    // EventSource is what would have forced a credential into the query string.
    expect(code).not.toContain('new EventSource');
  });

  it('a burst of frames paints at most once a frame', () => {
    const code = decomment(PANEL);
    expect(code).toContain('if (painting || !OT.open) return;');
    expect(code).toContain('requestAnimationFrame(function () { painting = false; paintList(); });');
  });

  it('and the browser reports its stages in batches, not one call each', () => {
    const code = decomment(PANEL);
    expect(code).toContain("API().request('POST', '/system/trace/client'");
    expect(code).toContain('pending.splice(0, 40)');
    expect(code).toContain('if (flushing || !pending.length || !OT.on)');
  });

  it('the drawer is fixed and animates on transform, so the page cannot move', () => {
    const at = CSS.indexOf('.ot-drawer{');
    expect(at).toBeGreaterThan(-1);
    const r = CSS.slice(at, CSS.indexOf('}', at));
    expect(r).toContain('position:fixed');
    expect(r).toContain('transform:translate3d(100%,0,0)');
    expect(r).not.toMatch(/transition:[^;]*(width|height|top|left|margin|padding)/);
    // Its own scroll region, with the gutter reserved.
    const list = CSS.slice(CSS.indexOf('.ot-list{'), CSS.indexOf('}', CSS.indexOf('.ot-list{')));
    expect(list).toContain('scrollbar-gutter:stable');
  });

  it('opening it navigates nothing and repaints no application page', () => {
    const code = decomment(PANEL);
    expect(code).not.toContain('navTo(');
    expect(code).not.toMatch(/render[A-Z]\w*Page\(/);
    expect(code).not.toContain('renderAllPages');
    // It writes into its own three regions and nothing else.
    for (const id of ['ot-head', 'ot-filters', 'ot-list']) {
      expect(`${id} written: ${code.includes(`getElementById('${id}')`)}`).toBe(`${id} written: true`);
    }
  });

  it('typing a filter repaints the list only, so the field keeps its focus', () => {
    const code = decomment(PANEL);
    const handler = code.slice(code.indexOf("document.addEventListener('input'"));
    expect(handler.slice(0, 400)).toContain('paintList();');
    expect(handler.slice(0, 400)).not.toContain('paintFilters()');
  });

  it('and the application sends ONE call per action, with a correlation id on it', () => {
    // The id rides on the request that was already going out. No second call
    // is made to announce it, and none is made when tracing is off.
    expect(APP).toContain("'X-Request-Id': _corrId");
    expect(APP).toContain('const _corrId = opts.requestId || _famNextRequestId();');
    const trace = APP.slice(APP.indexOf('if (typeof window.famTrace ===') - 200, APP.indexOf("window.famTrace(_corrId") + 200);
    expect(trace).toContain('window.famTrace(_corrId');
    // famTrace is inert unless the server said tracing is on.
    expect(decomment(PANEL)).toContain('if (!OT.on || !id) return;');
  });

  it('and the header the browser now sends is allowed through CORS', () => {
    // Without this the preflight would refuse every cross-origin call the
    // moment the client started sending it.
    const app = fs.readFileSync(path.join(__dirname, '..', 'src/app.ts'), 'utf8');
    expect(app).toContain("allowedHeaders: ['Content-Type', 'Authorization', 'x-club-id', 'x-request-id'],");
  });

  it('the control is drawn in SYSTEM only, and never in a club workspace', () => {
    const sys = fs.readFileSync(path.join(__dirname, '..', 'public/system/system.js'), 'utf8');
    expect(sys).toContain('data-sy-trace');
    expect(sys).toContain('who.isPlatformOwner');
    // Nothing in the club shell opens it.
    const clubNav = APP.slice(APP.indexOf('var CLUB_NAV_ITEMS = ['), APP.indexOf('function _access(capability)'));
    expect(clubNav).not.toContain('trace');
    expect(APP).not.toContain('openOwnerTrace');
    const pa = fs.readFileSync(path.join(__dirname, '..', 'public/people-access.js'), 'utf8');
    expect(pa).not.toContain('Trace');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('14-15 · and it grants nothing and changes nothing', () => {
  it('the guards report their decision and do not alter it', () => {
    const tenant = fs.readFileSync(path.join(__dirname, '..', 'src/middleware/tenant.middleware.ts'), 'utf8');
    // The rank comparison is untouched, and the trace call sits beside it.
    expect(tenant).toContain('if (max < minRank) {');
    expect(tenant).toContain("throw new ForbiddenError(`Insufficient membership role (need ${minRole} or higher)`)");
    expect(tenant).toContain("traceAuthz(req, 'requireMembership', true");
    expect(tenant).toContain("traceAuthz(req, 'requireMembership', false");

    const scope = fs.readFileSync(path.join(__dirname, '..', 'src/middleware/team-scope.middleware.ts'), 'utf8');
    expect(scope).toContain('await teamAccess.assertClubWideManageAuthority(actorOfRequest(req));');
    expect(scope).toContain('await enforce(actorOfRequest(req), player.teamId, write ? \'manage\' : \'private\');');
  });

  it('and the club routes still carry exactly the guards they carried', () => {
    const players = fs.readFileSync(path.join(__dirname, '..', 'src/routes/player.routes.ts'), 'utf8');
    expect(players).toContain("router.patch('/:id',            authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updatePlayer);");
    const tm = fs.readFileSync(path.join(__dirname, '..', 'src/routes/transfer-market.routes.ts'), 'utf8');
    expect(tm).toContain('const tradeGuard = [requireMembership(MembershipRole.HEAD_COACH), requireClubWideManage()];');
    const sm = fs.readFileSync(path.join(__dirname, '..', 'src/routes/staff-market.routes.ts'), 'utf8');
    expect(sm).toContain('const recruitGuard = [requireMembership(MembershipRole.HEAD_COACH), requireClubWideManage()];');
  });

  it('the ambient store carries an id and nothing that could be authorized from', () => {
    const ctx = fs.readFileSync(path.join(__dirname, '..', 'src/observability/trace-context.ts'), 'utf8');
    expect(ctx).toContain('AsyncLocalStorage<{ requestId: string }>');
    // Checked against the code, not the prose that explains why.
    const code = ctx.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    expect(code).not.toMatch(/userId|clubId|role|token/);
  });
});

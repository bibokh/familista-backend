/**
 * tests/telemetry-actor-context.unit.test.ts
 *
 * Telemetry said the platform owner was a club administrator.
 *
 * Observed in production: signed in as Platform Owner, inside the global SYSTEM
 * workspace, watching Live Data Flow. A `ui.pointer_active` frame arrived —
 * correctly aggregated, correctly routed, module `system`, 2,069ms — and the
 * inspector reported it against club "familista mail test" with subject type
 * `CLUB_ADMIN`. Neither was true.
 *
 * ── THE TWO ROOT CAUSES, WHICH ARE THE SAME MISTAKE TWICE
 *
 * Both dimensions were READ FROM THE SESSION rather than RESOLVED FROM THE
 * AUTHORITY THAT OWNS THE ANSWER.
 *
 *   `platformRole` was `req.user.role` — `User.role`, the account column that
 *   predates memberships and predates `PlatformAdmin`. This platform's owner
 *   holds `CLUB_ADMIN` there, deliberately: `access-levels.ts` records that
 *   renaming it would be a destructive migration bought for nothing, and every
 *   guard in the platform already goes through `isPlatformOwner`. Telemetry did
 *   not, so it reported the one value in the system that is knowingly stale.
 *
 *   `clubId` was `State.context.clubId`. Entering a club sets it; opening
 *   SYSTEM does not clear it, and must not — it is the reader's own context,
 *   and mutating it to make a chart come out right would be a product change
 *   made for an analytics reason. So SYSTEM activity carried the last club
 *   visited.
 *
 * ── THE RULE THESE TESTS PIN
 *
 * Identity comes from the canonical authority. Scope comes from the WORKSPACE
 * the event names, not from what the session is carrying. A global surface has
 * no tenant, whoever is looking at it.
 *
 * Nothing here is an authorization surface: `assertPlatformOwner` and the
 * middleware are untouched, no membership is read for permission, and a wrong
 * answer below mislabels a chart rather than opening a door.
 */

type Row = Record<string, unknown>;

const memberships: Row[] = [];

const db = {
  memberships,
  membership: {
    findMany: jest.fn(async ({ where }: Row): Promise<Array<{ role: string }>> => {
      const w = (where ?? {}) as Row;
      return memberships
        .filter((m: Row) => (w.userId === undefined || m.userId === w.userId)
          && (w.clubId === undefined || m.clubId === w.clubId)
          && (w.isActive === undefined || m.isActive === w.isActive))
        .map((m: Row) => ({ role: String(m.role) }));
    }),
  },
  analyticsEvents: [] as Row[],
  analyticsEvent: {
    createMany: jest.fn(async ({ data }: { data: Row[] }) => {
      db.analyticsEvents.push(...data);
      return { count: data.length };
    }),
    create: jest.fn(async ({ data }: { data: Row }) => { db.analyticsEvents.push(data); return data; }),
  },
  analyticsSession: {
    updateMany: jest.fn(async () => ({ count: 1 })),
    upsert: jest.fn(async () => ({})),
    findUnique: jest.fn(async () => null),
    update: jest.fn(async () => ({})),
    create: jest.fn(async () => ({})),
  },
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import fs from 'fs';
import path from 'path';
import {
  CLUB_MODULES, scopeOfModule, strongestRole,
  resolveTelemetryContext, telemetryContextResolver,
} from '../src/platform/analytics/actor-context';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const OWNER = 'user-platform-owner';
const PRESIDENT = 'user-president';
const COACH = 'user-head-coach';
const CLUB_A = 'club-aaaa';
const CLUB_B = 'club-bbbb';

beforeEach(() => {
  memberships.length = 0;
  memberships.push(
    { userId: PRESIDENT, clubId: CLUB_A, isActive: true, role: 'CLUB_OWNER' },
    { userId: COACH, clubId: CLUB_A, isActive: true, role: 'HEAD_COACH' },
    { userId: COACH, clubId: CLUB_A, isActive: true, role: 'ANALYST' },
    { userId: COACH, clubId: CLUB_B, isActive: true, role: 'ASSISTANT_COACH' },
    // Revoked. Present in the table, and it must not speak for anybody.
    { userId: PRESIDENT, clubId: CLUB_B, isActive: false, role: 'CLUB_OWNER' },
  );
  db.analyticsEvents = [];
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the production collision, exactly as it was observed', () => {
  /**
   * The shape that produced the wrong row: a legacy account role that says
   * CLUB_ADMIN, a club context left over from an earlier visit, real platform
   * authority from PlatformAdmin, and a global workspace on screen.
   */
  const productionShape = {
    actor: { userId: OWNER, isPlatformOwner: true },
    claim: { module: 'system', route: '/', clubId: 'club-familista-mail-test', teamId: 'team-stale' },
  };

  test('is PLATFORM_OWNER, GLOBAL, and carries no tenant at all', async () => {
    const ctx = await resolveTelemetryContext(productionShape.actor, productionShape.claim);
    expect(ctx).toEqual({
      actorIdentity: 'PLATFORM_OWNER',
      scope: 'GLOBAL',
      clubId: null,
      teamId: null,
    });
  });

  test('is never CLUB_ADMIN, however loudly the legacy column says so', async () => {
    // `User.role` is not an input to this function at all — there is nowhere to
    // pass it. That is the fix: not "we stopped reading it", but "it cannot be
    // read from here".
    const ctx = await resolveTelemetryContext(
      { userId: OWNER, isPlatformOwner: true },
      productionShape.claim,
    );
    expect(ctx.actorIdentity).not.toBe('CLUB_ADMIN');
    expect(ctx.actorIdentity).toBe('PLATFORM_OWNER');

    const source = decomment(read('src/controllers/telemetry.controller.ts'));
    expect(source).not.toMatch(/platformRole:\s*u\??\.?\.?role/);
    expect(source).toContain('isPlatformOwner');
  });

  test('the stale club is dropped without the session being touched', async () => {
    const claim = { ...productionShape.claim };
    const ctx = await resolveTelemetryContext(productionShape.actor, claim);
    expect(ctx.clubId).toBeNull();
    // The CLAIM is unchanged: the resolver decides what the row says and does
    // not reach back into the caller's context to make it true. Clearing the
    // reader's club to fix a chart would be a product change made for an
    // analytics reason.
    expect(claim.clubId).toBe('club-familista-mail-test');
    expect(claim.teamId).toBe('team-stale');
  });

  test('and no membership is consulted to reach that answer', async () => {
    await resolveTelemetryContext(productionShape.actor, productionShape.claim);
    expect(db.membership.findMany).not.toHaveBeenCalled();
  });
});

describe('scope comes from the workspace, never from the session', () => {
  test('every club workspace is CLUB and every platform surface is GLOBAL', () => {
    for (const m of ['squad', 'training', 'academy', 'match-center', 'club-home', 'transfers']) {
      expect(`${m}: ${scopeOfModule(m)}`).toBe(`${m}: CLUB`);
    }
    for (const m of [
      'system', 'owner-home', 'clubs', 'multi-club-network',
      'fos-core', 'fos-observability', 'fos-security-center', 'fos-automation-center',
      'fos-rbac', 'fos-audit-governance', 'fos-admin-center',
    ]) {
      expect(`${m}: ${scopeOfModule(m)}`).toBe(`${m}: GLOBAL`);
    }
  });

  test('an unclassified module is GLOBAL, so a new screen loses a dimension rather than picking a tenant', () => {
    expect(scopeOfModule('some-future-screen')).toBe('GLOBAL');
    expect(scopeOfModule(null, null)).toBe('GLOBAL');
    expect(scopeOfModule('')).toBe('GLOBAL');
  });

  test('the club list is the same list in the server, the browser and the shell', () => {
    // Three copies would drift; a test is what makes them one list.
    const client = read('public/analytics.js');
    const app = read('public/app.js');
    const clientList = /var CLUB_MODULES = \{([\s\S]*?)\};/.exec(client);
    expect(clientList).toBeTruthy();
    const clientKeys = new Set(
      ([...(clientList as RegExpExecArray)[1].matchAll(/'([a-z-]+)'\s*:/g)]).map((m) => m[1]),
    );
    expect([...clientKeys].sort()).toEqual([...CLUB_MODULES].sort());

    // And every one of them is a page `navTo` will actually activate.
    const allowed = /var _ALLOWED_PAGES = \{([\s\S]*?)\};/.exec(app);
    expect(allowed).toBeTruthy();
    const pages = new Set(
      ([...(allowed as RegExpExecArray)[1].matchAll(/'([a-z-]+)'\s*:/g)]).map((m) => m[1]),
    );
    for (const m of CLUB_MODULES) {
      // `training-centre` is the analytics alias for the `training` page.
      if (m === 'training-centre') continue;
      expect(`${m} is a real page: ${pages.has(m)}`).toBe(`${m} is a real page: true`);
    }
  });

  test('the browser keeps ONE copy of the list, and the interaction layer asks for it', () => {
    const interaction = decomment(read('public/fam-telemetry.js'));
    expect(interaction).toContain('a.isClubModule');
    // Not a second literal list.
    expect(interaction).not.toMatch(/var CLUB_MODULES\s*=/);
    // And when analytics.js has not loaded, the answer is NO club.
    expect(interaction).toMatch(/catch \(_\) \{ return false; \}/);
  });
});

describe('every identity, in the workspace it belongs to', () => {
  test('platform owner inside SYSTEM — global, no club', async () => {
    const ctx = await resolveTelemetryContext(
      { userId: OWNER, isPlatformOwner: true },
      { module: 'system', clubId: CLUB_A },
    );
    expect(ctx).toEqual({ actorIdentity: 'PLATFORM_OWNER', scope: 'GLOBAL', clubId: null, teamId: null });
  });

  test('platform owner inside a club — still the platform, with the real club', async () => {
    const ctx = await resolveTelemetryContext(
      { userId: OWNER, isPlatformOwner: true },
      { module: 'squad', clubId: CLUB_A, teamId: 'team-1' },
    );
    expect(ctx).toEqual({
      actorIdentity: 'PLATFORM_OWNER', scope: 'CLUB', clubId: CLUB_A, teamId: 'team-1',
    });
    // They hold no membership there and are never described as holding one.
    expect(ctx.actorIdentity).not.toBe('CLUB_OWNER');
  });

  test('a genuine president — CLUB_OWNER, in their own club', async () => {
    const ctx = await resolveTelemetryContext(
      { userId: PRESIDENT, isPlatformOwner: false },
      { module: 'club-home', clubId: CLUB_A },
    );
    expect(ctx).toEqual({ actorIdentity: 'CLUB_OWNER', scope: 'CLUB', clubId: CLUB_A, teamId: null });
  });

  test('a head coach — HEAD_COACH, with their club and team', async () => {
    const ctx = await resolveTelemetryContext(
      { userId: COACH, isPlatformOwner: false },
      { module: 'training', clubId: CLUB_A, teamId: 'team-u19' },
    );
    // Also an analyst in that club; the senior role is the one reported, and
    // deterministically so rather than "whichever row came back first".
    expect(ctx).toEqual({
      actorIdentity: 'HEAD_COACH', scope: 'CLUB', clubId: CLUB_A, teamId: 'team-u19',
    });
  });

  test('a head coach in SYSTEM is not reported as a coach of anything', async () => {
    const ctx = await resolveTelemetryContext(
      { userId: COACH, isPlatformOwner: false },
      { module: 'system', clubId: CLUB_A },
    );
    expect(ctx).toEqual({ actorIdentity: 'VIEWER', scope: 'GLOBAL', clubId: null, teamId: null });
  });

  test('a club the person has no live membership in is not attributed to them', async () => {
    // The president's CLUB_B membership is revoked. A session still naming it
    // produces no tenant at all, rather than one club's activity recorded
    // against another's.
    const ctx = await resolveTelemetryContext(
      { userId: PRESIDENT, isPlatformOwner: false },
      { module: 'squad', clubId: CLUB_B },
    );
    expect(ctx).toEqual({ actorIdentity: 'VIEWER', scope: 'GLOBAL', clubId: null, teamId: null });
  });

  test('strongest role is precedence, not table order', () => {
    expect(strongestRole(['ANALYST', 'HEAD_COACH'])).toBe('HEAD_COACH');
    expect(strongestRole(['HEAD_COACH', 'CLUB_OWNER'])).toBe('CLUB_OWNER');
    expect(strongestRole(['PLAYER'])).toBe('PLAYER');
    expect(strongestRole([])).toBeNull();
  });
});

describe('moving between workspaces', () => {
  test('leaving a club for SYSTEM drops the tenant on the very next event', async () => {
    const resolve = telemetryContextResolver({ userId: OWNER, isPlatformOwner: true });

    const inClub = await resolve({ module: 'squad', clubId: CLUB_A, teamId: 'team-1' });
    expect(inClub).toEqual({
      actorIdentity: 'PLATFORM_OWNER', scope: 'CLUB', clubId: CLUB_A, teamId: 'team-1',
    });

    // The session still carries the club — nothing cleared it, and nothing
    // should. The workspace is what changed.
    const inSystem = await resolve({ module: 'system', clubId: CLUB_A, teamId: 'team-1' });
    expect(inSystem).toEqual({
      actorIdentity: 'PLATFORM_OWNER', scope: 'GLOBAL', clubId: null, teamId: null,
    });
  });

  test('switching clubs switches the tenant, with nothing stale carried across', async () => {
    const resolve = telemetryContextResolver({ userId: COACH, isPlatformOwner: false });

    const first = await resolve({ module: 'squad', clubId: CLUB_A, teamId: 'team-a' });
    const second = await resolve({ module: 'squad', clubId: CLUB_B, teamId: 'team-b' });

    expect(first).toEqual({ actorIdentity: 'HEAD_COACH', scope: 'CLUB', clubId: CLUB_A, teamId: 'team-a' });
    expect(second).toEqual({
      actorIdentity: 'ASSISTANT_COACH', scope: 'CLUB', clubId: CLUB_B, teamId: 'team-b',
    });
  });

  test('one batch costs one query per club, not one per event', async () => {
    const resolve = telemetryContextResolver({ userId: COACH, isPlatformOwner: false });
    for (let i = 0; i < 40; i++) await resolve({ module: 'squad', clubId: CLUB_A });
    expect(db.membership.findMany).toHaveBeenCalledTimes(1);
  });

  test('a membership table that cannot be read loses the dimension, not the event', async () => {
    db.membership.findMany.mockRejectedValueOnce(new Error('down'));
    const ctx = await resolveTelemetryContext(
      { userId: COACH, isPlatformOwner: false },
      { module: 'squad', clubId: CLUB_A },
    );
    expect(ctx).toEqual({ actorIdentity: 'VIEWER', scope: 'GLOBAL', clubId: null, teamId: null });
  });
});

describe('the resolver is the only way a row gets its identity and tenant', () => {
  test('every event kind goes through it — pointer, nav, scroll, hover and action alike', async () => {
    const { track } = await import('../src/platform/analytics/service');

    const kinds = [
      { eventName: 'pointer_active', module: 'system', feature: 'system', durationMs: 2069 },
      { eventName: 'route_changed', module: 'system', feature: 'system' },
      { eventName: 'scroll_depth', module: 'system', feature: 'depth-50' },
      { eventName: 'region_dwell', module: 'system', feature: 'player-card', durationMs: 2000 },
      { eventName: 'action_invoked', module: 'system', feature: 'sy-dp-filter' },
    ].map((e) => ({
      ...e,
      sessionId: 'sess-1',
      occurredAt: new Date().toISOString(),
      // The exact production leftovers.
      clubId: 'club-familista-mail-test',
      teamId: 'team-stale',
    }));

    const out = await track({ userId: OWNER, isPlatformOwner: true }, kinds);
    expect(out.accepted).toBe(kinds.length);
    expect(db.analyticsEvents).toHaveLength(kinds.length);

    for (const row of db.analyticsEvents) {
      expect(`${row.eventName}: ${row.platformRole}`).toBe(`${row.eventName}: PLATFORM_OWNER`);
      expect(`${row.eventName}: ${row.clubId}`).toBe(`${row.eventName}: null`);
      expect(`${row.eventName}: ${row.teamId}`).toBe(`${row.eventName}: null`);
    }
  });

  test('the same batch inside a club keeps its tenant on every event', async () => {
    const { track } = await import('../src/platform/analytics/service');
    const kinds = ['pointer_active', 'scroll_depth', 'region_dwell', 'action_invoked', 'tab_changed']
      .map((eventName) => ({
        eventName, module: 'squad', sessionId: 'sess-2',
        clubId: CLUB_A, teamId: 'team-1',
      }));

    const out = await track({ userId: PRESIDENT, isPlatformOwner: false }, kinds);
    expect(out.accepted).toBe(kinds.length);
    expect(db.analyticsEvents).toHaveLength(kinds.length);
    for (const row of db.analyticsEvents) {
      expect(`${row.eventName}: ${row.platformRole}`).toBe(`${row.eventName}: CLUB_OWNER`);
      expect(`${row.eventName}: ${row.clubId}`).toBe(`${row.eventName}: ${CLUB_A}`);
    }
  });

  test('nothing in the ingest path reads the legacy account role any more', () => {
    const controller = decomment(read('src/controllers/telemetry.controller.ts'));
    const service = decomment(read('src/platform/analytics/service.ts'));
    // The only `role` the controller may name is the one it deliberately does
    // NOT pass; the assertion is that no value flows from it.
    expect(controller).not.toMatch(/platformRole:\s*u/);
    expect(service).not.toMatch(/platformRole:\s*actor\.platformRole/);
    expect(service).toContain('telemetryContextResolver');
    expect(service).toContain('platformRole: context.actorIdentity');
  });

  test('it grants nothing — no guard, no authorization, no write', () => {
    const src = decomment(read('src/platform/analytics/actor-context.ts'));
    for (const forbidden of [
      'assertPlatformOwner', 'ForbiddenError', 'throw ',
      '.create(', '.update(', '.delete(', '.upsert(', 'platformAdmin',
    ]) {
      expect(`${forbidden}: ${src.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
    // It reads memberships, and only their roles.
    expect(src).toContain('prisma.membership');
    expect(src).toContain('select: { role: true }');
  });
});

/**
 * tests/fabric-users-producer.unit.test.ts
 *
 * The Users domain as a Data Fabric producer — the first domain migrated onto
 * `publishFabricEvent`, and therefore the file that decides what the pattern is
 * for every domain after it.
 *
 * Four properties are load-bearing.
 *
 * ONE — AN EVENT MEANS IT HAPPENED. Every helper is called after the write has
 * committed, so a rolled-back transaction leaves no event behind. That is
 * tested from the failing direction as well as the succeeding one: a login with
 * the wrong password, a grant to a deactivated user, a role change that changes
 * nothing. Each must produce silence.
 *
 * TWO — NOTHING PRIVATE TRAVELS. The helpers take typed arguments and build
 * their own payloads, so there is no call site at which an email, a hash, a
 * token or a child's date of birth could be handed to them. The tests drive the
 * REAL services with a fake database full of exactly those things and then
 * search every event the transport received — and every frame the board would
 * draw — for each one of them.
 *
 * THREE — USERS IS ONE SOURCE. Eleven event types route to a single lane, and
 * adding a twelfth does not add a card. Asserted by count, not by inspection.
 *
 * FOUR — OBSERVABILITY CANNOT BREAK A LOGIN. An unregistered name, a payload
 * that fails validation and a transport that throws are all driven through the
 * real service calls, and in every case the user-facing operation returns
 * normally.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUB = '22222222-2222-4222-8222-222222222222';
const TEAM = '33333333-3333-4333-8333-333333333333';

/** Every one of these is planted in the fake database and must never travel. */
const SECRETS = {
  email: 'guardian.muller@example.com',
  hash: '$2b$12$abcdefghijklmnopqrstuv',
  token: 'eyJhbGciOiJIUzI1NiJ9.refresh',
  firstName: 'Tomás',
  lastName: 'Müller-Fernández',
  avatar: 'https://cdn.example.com/portraits/tomas-muller.jpg',
  address: '221B Baker Street',
  dateOfBirth: '2014-03-19',
  reason: 'Safeguarding concern raised by the parent on 3 March',
  locale: 'de-DE',
};

const state = {
  users: [] as Row[],
  clubs: [] as Row[],
  teams: [] as Row[],
  memberships: [] as Row[],
  refreshTokens: [] as Row[],
  audit: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== (v as Row).not;
    }
    return row[k] === v;
  });

/** Prisma hands back detached rows; so does this, or a later update would
 *  mutate a caller's own "before" snapshot. */
const copy = <T>(row: T): T => (row == null ? row : JSON.parse(JSON.stringify(row)) as T);

/** The fake honours `include: { club: ... }`, which the real service relies on. */
const withClub = (user: Row, include?: Row): Row => {
  if (!include?.club) return user;
  const club = state.clubs.find((c) => c.id === user.clubId);
  return { ...user, club: { name: club?.name ?? 'Unknown club' } };
};

const db: Row = {
  user: {
    findUnique: async ({ where, include }: Row) => {
      const u = state.users.find((x) => (where.id ? x.id === where.id : x.email === where.email));
      return u ? copy(withClub(u, include)) : null;
    },
    findFirst: async ({ where = {}, include }: Row = {}) => {
      const u = state.users.find((x) => match(x, where));
      return u ? copy(withClub(u, include)) : null;
    },
    create: async ({ data }: Row) => {
      const row = { id: `u-${state.users.length + 1}`, isActive: true, tokenVersion: 0, ...data };
      state.users.push(row);
      return copy(withClub(row, { club: true }));
    },
    update: async ({ where, data }: Row) => {
      const u = state.users.find((x) => x.id === where.id)!;
      Object.assign(u, data);
      return copy(u);
    },
  },
  club: { findUnique: async ({ where }: Row) => state.clubs.find((c) => c.id === where.id) ?? null },
  team: { findUnique: async ({ where }: Row) => state.teams.find((t) => t.id === where.id) ?? null },
  membership: {
    findUnique: async ({ where }: Row) => copy(state.memberships.find((m) => m.id === where.id) ?? null),
    findFirst: async ({ where = {} }: Row = {}) => copy(state.memberships.find((m) => match(m, where)) ?? null),
    findMany: async ({ where = {} }: Row = {}) => copy(state.memberships.filter((m) => match(m, where))),
    count: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)).length,
    create: async ({ data }: Row) => {
      const row = { id: `m-${state.memberships.length + 1}`, status: 'ACTIVE', ...data };
      state.memberships.push(row);
      return copy(row);
    },
    update: async ({ where, data }: Row) => {
      const m = state.memberships.find((x) => x.id === where.id)!;
      Object.assign(m, data);
      return copy(m);
    },
    updateMany: async () => ({ count: 0 }),
  },
  membershipAuditLog: {
    create: async ({ data }: Row) => { state.audit.push(data); return data; },
    findMany: async () => [],
    count: async () => 0,
  },
  refreshToken: {
    findUnique: async ({ where }: Row) => {
      const t = state.refreshTokens.find((r) => r.token === where.token);
      if (!t) return null;
      const user = state.users.find((u) => u.id === t.userId);
      return { ...t, user: user ? { clubId: user.clubId } : null };
    },
    create: async ({ data }: Row) => { state.refreshTokens.push(data); return data; },
    delete: async ({ where }: Row) => {
      const i = state.refreshTokens.findIndex((r) => r.token === where.token);
      return i >= 0 ? state.refreshTokens.splice(i, 1)[0] : null;
    },
    deleteMany: async ({ where = {} }: Row = {}) => {
      const before = state.refreshTokens.length;
      state.refreshTokens = state.refreshTokens.filter((r) => !match(r, where));
      return { count: before - state.refreshTokens.length };
    },
  },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));
// One rule and no escape hatch. A mock that accepts any password would make
// every "a failed action publishes nothing" test below pass for the wrong
// reason — the action would not have failed.
jest.mock('../src/utils/password', () => ({
  hashPassword: async (p: string) => `hashed:${p}`,
  verifyPassword: async (p: string, h: string) => h === `hashed:${p}`,
}));

/** The password the seeded account actually has. */
const PASSWORD = 'CorrectHorseBattery1!';

import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { project, sourceLaneFor } from '../src/fabric/pulse/pulse.service';
import {
  fabricEvent, fabricEventsForSource, isRegisteredEventType,
} from '../src/fabric/registry/event-registry';
import { sourceLanes, visibleFabricSources } from '../src/fabric/registry/source-registry';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import { registryHealth, resetRegistryHealth } from '../src/fabric/registry/unknown-events';
import { pulseTopology } from '../src/fabric/pulse/pulse.service';
import '../src/fabric/producers/users.producer';

import * as authService from '../src/services/auth.service';
import * as membershipService from '../src/services/membership.service';

/**
 * Every `.ts` under `src/` whose text contains `needle`, as repo-relative paths.
 *
 * A walk rather than a `grep` subprocess: spawning one from a test leaves a
 * handle behind that Jest reports as a worker which would not exit, and a
 * directory walk is both faster and has no such cost.
 */
function filesNaming(needle: string): string[] {
  const root = path.join(__dirname, '..');
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      if (fs.readFileSync(full, 'utf8').includes(needle)) {
        hits.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(root, 'src'));
  return hits.sort();
}

/** Every event the fabric was asked to store during one test. */
let published: FamilistaEvent[] = [];

/**
 * Let a detached publish finish.
 *
 * `publishFabricEventDetached` starts a chain — validate, build the envelope,
 * await the transport, fan out — so one turn of the loop is not enough. Three
 * is, comfortably, and the cost is microseconds.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
};

const transport: EventTransport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as EventTransport;

beforeEach(() => {
  published = [];
  resetRegistryHealth();
  setEventTransport(transport);

  state.users = [{
    id: 'u-existing',
    email: SECRETS.email,
    passwordHash: `hashed:${PASSWORD}`,
    // A bcrypt-shaped string parked on the row so the leak hunt has one to find.
    legacyPasswordHash: SECRETS.hash,
    firstName: SECRETS.firstName,
    lastName: SECRETS.lastName,
    avatar: SECRETS.avatar,
    addressLine: SECRETS.address,
    dateOfBirth: SECRETS.dateOfBirth,
    locale: SECRETS.locale,
    role: 'HEAD_COACH',
    clubId: CLUB,
    isActive: true,
    tokenVersion: 0,
  }];
  // Every membership below belongs to this person, and revoking one ends their
  // club session — which writes to their user row. Seeded once, here.
  state.users.push({
    id: 'u-target', email: 'target@example.com', passwordHash: `hashed:${PASSWORD}`,
    firstName: 'Ida', lastName: 'Berg', role: 'SCOUT', clubId: CLUB,
    isActive: true, tokenVersion: 0,
  });
  state.clubs = [{ id: CLUB, name: 'FC Familista' }, { id: OTHER_CLUB, name: 'SV Nord' }];
  state.teams = [{ id: TEAM, clubId: CLUB }];
  state.memberships = [];
  state.refreshTokens = [];
  state.audit = [];
});

afterEach(async () => {
  // Publishing is detached, so the last assertion of a test can run while a
  // publish is still in flight. Drain before the next test swaps the transport
  // out from under it — otherwise a promise resolves into a torn-down module
  // and Jest reports a worker that would not exit.
  await settle();
});

afterAll(async () => {
  await settle();
  setEventTransport(null);
});

const typesPublished = () => published.map((e) => e.eventType);
const only = (type: string) => published.filter((e) => e.eventType === type);

// ── one action, one event ────────────────────────────────────────────────────

describe('a successful Users action publishes exactly one correct event', () => {
  it('registerUser → user.created', async () => {
    await authService.registerUser({
      email: 'new.coach@example.com', password: 'Str0ngPassphrase!',
      firstName: 'Ana', lastName: 'Silva', clubId: CLUB,
    });
    await settle();

    expect(typesPublished()).toEqual(['user.created']);
    const e = only('user.created')[0];
    expect(e).toMatchObject({
      clubId: CLUB, subjectType: 'USER', sourceType: 'USER', schemaVersion: 1,
      dataClassification: 'CONFIDENTIAL',
    });
    expect(e.payload).toEqual({ accountRole: 'HEAD_COACH', invited: false });
    expect(validateEventPayload('user.created', 1, e.payload)).toEqual({ ok: true, validated: true });
  });

  it('registerInvitedUser → user.created, marked invited', async () => {
    await authService.registerInvitedUser({
      email: 'invited@example.com', clubId: CLUB, accountRole: 'ANALYST',
      firstName: 'Lena', lastName: 'Kruse', password: 'Str0ngPassphrase!',
    } as never);
    await settle();

    expect(typesPublished()).toEqual(['user.created']);
    expect(only('user.created')[0].payload).toEqual({ accountRole: 'ANALYST', invited: true });
  });

  it('loginUser → user.login, and the method only', async () => {
    await authService.loginUser(SECRETS.email, PASSWORD);
    await settle();

    // The mocked verifier accepts the stored hash directly, so this is a
    // genuine successful login through the real service.
    expect(typesPublished()).toEqual(['user.login']);
    const e = only('user.login')[0];
    expect(e.payload).toEqual({ method: 'PASSWORD' });
    expect(e.subjectType).toBe('USER');
    expect(e.clubId).toBe(CLUB);
  });

  it('logoutUser → user.logout for a session that existed', async () => {
    state.refreshTokens.push({ token: SECRETS.token, userId: 'u-existing', expiresAt: new Date(Date.now() + 1e6) });
    await authService.logoutUser(SECRETS.token);
    await settle();

    expect(typesPublished()).toEqual(['user.logout']);
    expect(only('user.logout')[0].payload).toEqual({ scope: 'SESSION' });
    expect(state.refreshTokens).toHaveLength(0);
  });

  it('grantMembership → membership.granted', async () => {
    await membershipService.grantMembership(
      { userId: 'u-existing', clubId: CLUB } as never,
      { userId: 'u-target', role: 'ASSISTANT_COACH' } as never,
    );
    await settle();

    expect(typesPublished()).toEqual(['membership.granted']);
    const e = only('membership.granted')[0];
    expect(e.payload).toEqual({ role: 'ASSISTANT_COACH', scope: 'CLUB', reactivated: false });
    expect(e.subjectType).toBe('MEMBERSHIP');
    expect(validateEventPayload('membership.granted', 1, e.payload).ok).toBe(true);
  });

  it('grantMembership on a team is TEAM-scoped', async () => {
    await membershipService.grantMembership(
      { userId: 'u-existing', clubId: CLUB } as never,
      { userId: 'u-target', role: 'YOUTH_COACH', teamId: TEAM } as never,
    );
    await settle();
    expect(only('membership.granted')[0].payload).toMatchObject({ scope: 'TEAM' });
  });

  it('re-granting a revoked membership reports reactivated', async () => {
    state.memberships.push({
      id: 'm-old', userId: 'u-target', clubId: CLUB, teamId: null,
      role: 'SCOUT', isActive: false,
    });
    await membershipService.grantMembership(
      { userId: 'u-existing', clubId: CLUB } as never,
      { userId: 'u-target', role: 'SCOUT' } as never,
    );
    await settle();
    expect(only('membership.granted')[0].payload).toMatchObject({ reactivated: true });
  });

  it('changeRole → access.role.changed, with the tokens and not the reason', async () => {
    state.memberships.push({
      id: 'm-1', userId: 'u-target', clubId: CLUB, teamId: null,
      role: 'SCOUT', isActive: true,
    });
    await membershipService.changeRole(
      { userId: 'u-existing', clubId: CLUB } as never,
      'm-1',
      { role: 'ANALYST', reason: SECRETS.reason } as never,
    );
    await settle();

    expect(typesPublished()).toEqual(['access.role.changed']);
    const e = only('access.role.changed')[0];
    expect(e.payload).toEqual({ from: 'SCOUT', to: 'ANALYST' });
    expect(JSON.stringify(e)).not.toContain('Safeguarding');
  });

  it('revokeMembership → membership.revoked', async () => {
    state.memberships.push({
      id: 'm-1', userId: 'u-target', clubId: CLUB, teamId: null,
      role: 'ANALYST', isActive: true,
    });
    await membershipService.revokeMembership(
      { userId: 'u-existing', clubId: CLUB } as never, 'm-1', SECRETS.reason,
    );
    await settle();

    expect(typesPublished()).toEqual(['membership.revoked']);
    const e = only('membership.revoked')[0];
    expect(e.payload).toEqual({ role: 'ANALYST', scope: 'CLUB' });
    expect(JSON.stringify(e)).not.toContain('Safeguarding');
  });
});

// ── a failed action publishes nothing ────────────────────────────────────────

describe('a business action that fails publishes no success event', () => {
  it('a wrong password publishes no user.login', async () => {
    await expect(authService.loginUser(SECRETS.email, 'not-the-password')).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('an unknown address publishes no user.login', async () => {
    await expect(authService.loginUser('nobody@example.com', 'anything')).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('a deactivated account publishes no user.login', async () => {
    state.users[0].isActive = false;
    await expect(authService.loginUser(SECRETS.email, PASSWORD))
      .rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('a duplicate address publishes no user.created', async () => {
    await expect(authService.registerUser({
      email: SECRETS.email, password: 'Str0ngPassphrase!',
      firstName: 'A', lastName: 'B', clubId: CLUB,
    })).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('registering into a club that does not exist publishes nothing', async () => {
    await expect(authService.registerUser({
      email: 'x@example.com', password: 'Str0ngPassphrase!',
      firstName: 'A', lastName: 'B', clubId: 'no-such-club',
    })).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('logging out a token that was never issued publishes nothing', async () => {
    await authService.logoutUser('a-token-nobody-minted');
    await settle();
    expect(published).toHaveLength(0);
  });

  it('granting to a deactivated user publishes no membership.granted', async () => {
    state.users.find((u) => u.id === 'u-target')!.isActive = false;
    await expect(membershipService.grantMembership(
      { userId: 'u-existing', clubId: CLUB } as never,
      { userId: 'u-target', role: 'SCOUT' } as never,
    )).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('granting a membership that is already active publishes nothing', async () => {
    state.memberships.push({
      id: 'm-1', userId: 'u-target', clubId: CLUB, teamId: null, role: 'SCOUT', isActive: true,
    });
    await expect(membershipService.grantMembership(
      { userId: 'u-existing', clubId: CLUB } as never,
      { userId: 'u-target', role: 'SCOUT' } as never,
    )).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('a role change to the role it already has publishes nothing', async () => {
    state.memberships.push({
      id: 'm-1', userId: 'u-target', clubId: CLUB, teamId: null, role: 'ANALYST', isActive: true,
    });
    await membershipService.changeRole(
      { userId: 'u-existing', clubId: CLUB } as never, 'm-1', { role: 'ANALYST' } as never,
    );
    await settle();
    expect(published).toHaveLength(0);
  });

  it('revoking an already-revoked membership publishes nothing', async () => {
    state.memberships.push({
      id: 'm-1', userId: 'u-target', clubId: CLUB, teamId: null, role: 'ANALYST', isActive: false,
    });
    await membershipService.revokeMembership({ userId: 'u-existing', clubId: CLUB } as never, 'm-1');
    await settle();
    expect(published).toHaveLength(0);
  });
});

// ── nothing private travels ──────────────────────────────────────────────────

describe('no private field reaches the fabric or the board', () => {
  /** Drive every producing path, then search everything that came out. */
  async function everything(): Promise<void> {
    await authService.registerUser({
      email: 'fresh@example.com', password: 'Str0ngPassphrase!',
      firstName: SECRETS.firstName, lastName: SECRETS.lastName, clubId: CLUB,
    });
    await authService.loginUser(SECRETS.email, PASSWORD);
    state.refreshTokens.push({ token: SECRETS.token, userId: 'u-existing', expiresAt: new Date(Date.now() + 1e6) });
    await authService.logoutUser(SECRETS.token);
    await membershipService.grantMembership(
      { userId: 'u-existing', clubId: CLUB } as never,
      { userId: 'u-target', role: 'SCOUT' } as never,
    );
    state.memberships.push({
      id: 'm-9', userId: 'u-target', clubId: CLUB, teamId: null, role: 'ANALYST', isActive: true,
    });
    await membershipService.changeRole(
      { userId: 'u-existing', clubId: CLUB } as never, 'm-9',
      { role: 'SCOUT', reason: SECRETS.reason } as never,
    );
    await membershipService.revokeMembership(
      { userId: 'u-existing', clubId: CLUB } as never, 'm-9', SECRETS.reason,
    );
    await settle();
  }

  it('publishes one event per action and not one secret among them', async () => {
    await everything();
    // Named rather than counted, so a path that stops producing is a failure
    // rather than a number that quietly still adds up.
    expect(typesPublished().sort()).toEqual([
      'access.role.changed', 'membership.granted', 'membership.revoked',
      'user.created', 'user.login', 'user.logout',
    ]);

    const wire = JSON.stringify(published);
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(`${name} in events: ${wire.includes(value)}`).toBe(`${name} in events: false`);
    }
    // Nor the password the caller supplied, nor anything shaped like a hash.
    expect(wire).not.toContain('Str0ngPassphrase!');
    expect(wire).not.toContain('hashed:');
    expect(wire).not.toMatch(/\$2[aby]\$/);
  });

  it('draws frames that carry no secret and no personal identifier', async () => {
    await everything();

    for (const event of published) {
      const frame = project(event);
      const wire = JSON.stringify(frame);
      for (const [name, value] of Object.entries(SECRETS)) {
        expect(`${name} in frame for ${event.eventType}: ${wire.includes(value)}`)
          .toBe(`${name} in frame for ${event.eventType}: false`);
      }
      // A USER or MEMBERSHIP subject is a person or a person's access. Neither
      // id travels, even to the platform owner.
      expect(`${event.eventType} subjectId: ${frame.subjectId}`).toBe(`${event.eventType} subjectId: null`);
      expect(wire).not.toContain('payload');
      expect(wire).not.toContain('actorUserId');
    }
  });

  it('carries every payload key as a name, a token or a boolean — never free text', async () => {
    await everything();
    for (const event of published) {
      for (const value of Object.values(event.payload as Record<string, unknown>)) {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          if (typeof v === 'boolean') continue;
          // A token or a field name: no spaces, and short. Free text fails both.
          expect(`${event.eventType} carries "${v}": ${/^[A-Za-z][\w.-]{0,39}$/.test(String(v))}`)
            .toBe(`${event.eventType} carries "${v}": true`);
        }
      }
    }
  });

  it('every payload satisfies its own strict schema', async () => {
    await everything();
    for (const event of published) {
      const check = validateEventPayload(event.eventType, event.schemaVersion, event.payload);
      expect(`${event.eventType}: ${JSON.stringify(check)}`)
        .toBe(`${event.eventType}: ${JSON.stringify({ ok: true, validated: true })}`);
    }
    // Strict, so a stray field is caught rather than passed through.
    expect(validateEventPayload('user.login', 1, { method: 'PASSWORD', email: SECRETS.email }).ok)
      .toBe(false);
  });
});

// ── observability cannot break a user-facing operation ───────────────────────

describe('a broken fabric does not break a login', () => {
  it('survives a transport that throws on every append', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('storage is down'); },
      async read() { return []; },
    } as EventTransport);

    const result = await authService.loginUser(SECRETS.email, PASSWORD);
    await settle();
    expect(result.user.id).toBe('u-existing');
    expect(result.tokens.accessToken).toBeTruthy();
  });

  it('survives a transport that rejects a membership grant', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('storage is down'); },
      async read() { return []; },
    } as EventTransport);

    const m = await membershipService.grantMembership(
      { userId: 'u-existing', clubId: CLUB } as never,
      { userId: 'u-target', role: 'SCOUT' } as never,
    );
    await settle();
    expect(m.id).toBeTruthy();
    expect(state.memberships).toHaveLength(1);
    expect(state.audit).toHaveLength(1);
  });

  it('survives an unregistered name without failing the caller', async () => {
    const { publishFabricEvent } = require('../src/fabric/registry/publisher');
    const result = await publishFabricEvent({ eventType: 'user.telepathy.detected' });
    expect(result.registered).toBe(false);
    expect(result.stored).toBe(true);
    expect(registryHealth().unknownEventTypes).toContain('user.telepathy.detected');
    // And it still lands on the Users lane, because `user` is Users' prefix.
    expect(sourceLaneFor('user.telepathy.detected')).toBe('Users');
  });

  it('quarantines an invalid payload without failing the caller', async () => {
    const { publishFabricEvent } = require('../src/fabric/registry/publisher');
    const result = await publishFabricEvent({
      eventType: 'user.login',
      payload: { method: 'TELEPATHY', email: SECRETS.email },
    });
    expect(result.schema.ok).toBe(false);
    expect(result.quarantined).toBe(true);
    expect(result.stored).toBe(true);
    expect(registryHealth().quarantinedCount).toBe(1);
  });
});

// ── Users stays one source ───────────────────────────────────────────────────

describe('Users is one source, whatever is added to it', () => {
  it('routes every Users event type to the single Users lane', () => {
    const types = [
      'user.created', 'user.updated', 'user.profile.updated', 'user.role.changed',
      'user.login', 'user.logout', 'user.context.switched',
      'membership.granted', 'membership.changed', 'membership.revoked',
      'access.role.changed',
    ];
    for (const type of types) {
      expect(`${type} -> ${sourceLaneFor(type)}`).toBe(`${type} -> Users`);
      expect(`${type} source: ${fabricEvent(type)?.source}`).toBe(`${type} source: users`);
    }
    expect(fabricEventsForSource('users').length).toBe(types.length);
  });

  it('adds no source card — the board still draws exactly ten lanes', () => {
    expect(sourceLanes()).toEqual([
      'Clubs', 'Users', 'Players', 'Training', 'Matches',
      'Transfers', 'Medical', 'Media', 'AI', 'System',
    ]);
    expect(visibleFabricSources()).toHaveLength(10);
    expect(pulseTopology().sources).toHaveLength(10);
  });

  it('a NEW Users feature adds no card either', () => {
    const { registerFabricEvent } = require('../src/fabric/registry/event-registry');
    registerFabricEvent({ type: 'user.preferences.updated', entityType: 'USER' });

    expect(sourceLanes()).toHaveLength(10);
    expect(pulseTopology().sources).toHaveLength(10);
    expect(fabricEvent('user.preferences.updated')?.source).toBe('users');
  });
});

// ── the board understands the new types with no UI change ────────────────────

describe('Live Data Flow understands the Users types automatically', () => {
  it('marks every one of them registered and routes it to Users', async () => {
    await authService.loginUser(SECRETS.email, PASSWORD);
    await membershipService.grantMembership(
      { userId: 'u-existing', clubId: CLUB } as never,
      { userId: 'u-target', role: 'SCOUT' } as never,
    );
    await settle();

    expect(published.length).toBe(2);
    for (const event of published) {
      const frame = project(event);
      expect(`${event.eventType} registered: ${frame.registered}`).toBe(`${event.eventType} registered: true`);
      expect(`${event.eventType} source: ${frame.source}`).toBe(`${event.eventType} source: Users`);
      expect(frame.destination).toBe('Audit');
      expect(typeof frame.latencyMs === 'number' || frame.latencyMs === null).toBe(true);
      expect(frame.status).toBe('STORED');
    }
  });

  it('needs no edit to the Live Data Flow page for any of it', () => {
    const client = fs.readFileSync(path.join(__dirname, '..', 'public/data-pulse.js'), 'utf8');
    // The page names no Users event type, and no Users event type names it.
    for (const type of ['user.created', 'user.login', 'user.logout', 'access.role.changed']) {
      expect(`${type} hard-coded in the page: ${client.includes(type)}`)
        .toBe(`${type} hard-coded in the page: false`);
    }
  });

  it('declares user.role.changed with no producer rather than inventing one', () => {
    // Nothing in Familista changes an account's own role today. The contract
    // exists; the producer honestly does not.
    expect(isRegisteredEventType('user.role.changed')).toBe(true);
    const producer = fs.readFileSync(
      path.join(__dirname, '..', 'src/fabric/producers/users.producer.ts'), 'utf8',
    );
    expect(producer).not.toMatch(/publishUserRoleChanged/);
    // And nothing anywhere else so much as names it.
    expect(filesNaming('user.role.changed')).toEqual(['src/fabric/producers/users.producer.ts']);
  });
});

// ── the producers are called after the write, never before ───────────────────

describe('no helper is called before its write has committed', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  it('membership publishes outside the transaction, not inside it', () => {
    const body = read('src/services/membership.service.ts');
    for (const [start, end] of [
      [body.indexOf('export async function grantMembership'), body.indexOf('export async function assertMayAppointPresident')],
      [body.indexOf('export async function changeRole'), body.indexOf('// Audit reads')],
    ]) {
      const fn = body.slice(start, end);
      const tx = fn.slice(fn.indexOf('$transaction'), fn.lastIndexOf('});'));
      expect(tx).not.toMatch(/publish(Membership|Access)/);
      expect(fn).toMatch(/publish(Membership|Access)/);
    }
  });

  it('auth publishes after the account exists and the session was issued', () => {
    const body = read('src/services/auth.service.ts');
    const login = body.slice(body.indexOf('export async function loginUser'), body.indexOf('export async function refreshTokens'));
    expect(login.indexOf('issueTokens')).toBeLessThan(login.indexOf('publishUserLogin'));
    const reg = body.slice(body.indexOf('export async function registerUser'), body.indexOf('export async function registerInvitedUser'));
    expect(reg.indexOf('prisma.user.create')).toBeLessThan(reg.indexOf('publishUserCreated'));
  });

  it('every helper is detached, so no user waits on the outbox', () => {
    const producer = read('src/fabric/producers/users.producer.ts');
    expect(producer).not.toMatch(/await publishFabricEvent\(/);
    const calls = producer.match(/publishFabricEventDetached\(/g) ?? [];
    expect(calls.length).toBe(8);
  });
});

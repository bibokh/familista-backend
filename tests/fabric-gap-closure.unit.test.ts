/**
 * tests/fabric-gap-closure.unit.test.ts
 *
 * The eleven flows the Full Coverage & Integrity Audit found writing rows and
 * telling the fabric nothing, and the Clubs lane that had four registered names
 * and no producer at all.
 *
 * WHAT THIS SUITE IS FOR
 *
 * Every test here answers one of four questions about a flow that already
 * existed and now publishes:
 *
 *   1. does the successful path publish, once, with the right name and lane?
 *   2. does the failing path publish nothing?
 *   3. does a broken fabric still let the business operation succeed?
 *   4. is anything private on the event, the frame, or the resolved frame?
 *
 * The third is the one worth stating plainly. None of these eleven flows asked
 * for observability; they were asked to enrol a device, switch a session's
 * club, delete a club forever. An integration that can fail one of them has
 * made the platform worse, so every helper publishes through
 * `publishFabricEventDetached` and every one of these flows is driven here with
 * a transport that throws on every append.
 *
 * THE PRIVACY METHOD
 *
 * The same one the Medical suite uses: plant a real secret in the fixture, then
 * search for it in the published event, in the frame `project()` builds, and in
 * the frame after `resolveSubjects()` has filled in its labels. A club holds a
 * president's email address, an invitation token, a white-label configuration
 * and a billing contact, and a device row holds an HMAC secret while a session
 * row holds a server-issued session key. None of it may reach the board.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_TEAM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACTOR = 'u-platform-owner';
const MEMBER = 'u-member';

/** Everything in these rows that must never leave the modules under test. */
const SECRETS = {
  presidentEmail: 'president.candidate@private-family-domain.test',
  presidentName: 'Ingrid Bergström-Okafor',
  contactEmail: 'billing@fcmusterstadt.test',
  websiteUrl: 'https://fcmusterstadt.test/private-portal',
  invitationToken: 'inv_tok_9f3a1c77e04b48e2b0d6c1f5a8937ee2',
  lifecycleReason: 'Suspended pending a safeguarding review of a named youth coach',
  deviceSecret: 'ZGV2aWNlLWhtYWMtc2VjcmV0LW5ldmVyLXNoaXA=',
  sessionKey: 'c2Vzc2lvbi1rZXktbmV2ZXItc2hpcC1hbnl3aGVyZQ==',
  deviceSerial: 'FMLSTA-WEAR-SN-0099813',
  deviceNotes: 'Assigned to the under-13 goalkeeper whose father collects him',
  packetPayload: 'hr=181;lat=52.5200;lon=13.4050',
  modelSlug: 'squad-selection-bias-corrected-v3-internal',
  activationNotes: 'Rolled out ahead of the Bayern fixture, do not mention externally',
};

const state = {
  clubs: [] as Row[], invitations: [] as Row[], memberships: [] as Row[],
  membershipAudit: [] as Row[], platformAudit: [] as Row[], users: [] as Row[],
  teams: [] as Row[], devices: [] as Row[], sessions: [] as Row[],
  packets: [] as Row[], models: [] as Row[], aiAudit: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    if (k === 'NOT') return !match(row, v as Row);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== (v as Row).not;
      if ('some' in v) return true;
    }
    if (v === null) return row[k] == null;
    return row[k] === v;
  });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const copy = <T>(row: T): T => {
  if (row == null) return row;
  return JSON.parse(
    JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    (_k, v) => (typeof v === 'string' && ISO.test(v) ? new Date(v) : v),
  ) as T;
};

let seq = 0;
const table = (rows: () => Row[], prefix: string, defaults: Row = {}) => ({
  findUnique: async ({ where }: Row) => copy(rows().find((r) => match(r, where)) ?? null),
  findUniqueOrThrow: async ({ where }: Row) => {
    const hit = rows().find((r) => match(r, where));
    if (!hit) throw new Error(`${prefix} not found`);
    return copy(hit);
  },
  findFirst: async ({ where = {} }: Row = {}) => copy(rows().find((r) => match(r, where)) ?? null),
  findMany: async ({ where = {} }: Row = {}) => copy(rows().filter((r) => match(r, where))),
  count: async ({ where = {} }: Row = {}) => rows().filter((r) => match(r, where)).length,
  create: async ({ data }: Row) => {
    seq += 1;
    const row = { id: `${prefix}-${seq}`, createdAt: new Date(), ...defaults, ...data };
    rows().push(row);
    return copy(row);
  },
  createMany: async ({ data }: Row) => {
    const list = Array.isArray(data) ? data : [data];
    for (const d of list) { seq += 1; rows().push({ id: `${prefix}-${seq}`, ...defaults, ...d }); }
    return { count: list.length };
  },
  update: async ({ where, data }: Row) => {
    const r = rows().find((x) => match(x, where));
    if (!r) throw new Error(`${prefix} not found`);
    Object.assign(r, data);
    return copy(r);
  },
  updateMany: async ({ where = {}, data }: Row = {}) => {
    const hits = rows().filter((r) => match(r, where));
    hits.forEach((r) => Object.assign(r, data));
    return { count: hits.length };
  },
  delete: async ({ where }: Row) => {
    const i = rows().findIndex((x) => match(x, where));
    return i >= 0 ? copy(rows().splice(i, 1)[0]) : null;
  },
});

/** A table that owns nothing but a count. What `clubDependencies` asks twelve of. */
const empty = { count: async () => 0 };

/** The joins `getActiveMembershipsForUser` asks for, attached by `include`. */
const withClub = (row: Row): Row => ({
  ...copy(row),
  club: copy(state.clubs.find((c) => c.id === row.clubId) ?? null),
  team: row.teamId ? copy(state.teams.find((t) => t.id === row.teamId) ?? null) : null,
});

const db: Row = {
  club: table(() => state.clubs, 'club'),
  clubInvitation: table(() => state.invitations, 'inv'),
  membership: {
    ...table(() => state.memberships, 'mem'),
    findMany: async ({ where = {}, include }: Row = {}) => {
      const hits = state.memberships.filter((r) => match(r, where));
      return include ? hits.map(withClub) : hits.map(copy);
    },
  },
  membershipAuditLog: table(() => state.membershipAudit, 'maud'),
  platformAuditLog: table(() => state.platformAudit, 'paud'),
  platformAdmin: { findUnique: async () => ({ id: 'admin-1' }) },
  user: {
    ...table(() => state.users, 'user'),
    findUnique: async ({ where, select }: Row) => {
      const r = state.users.find((x) => match(x, where));
      if (!r) return null;
      const out: Row = copy(r);
      if (select?.currentClub) out.currentClub = copy(state.clubs.find((c) => c.id === r.currentClubId) ?? null);
      if (select?.currentTeam) out.currentTeam = copy(state.teams.find((t) => t.id === r.currentTeamId) ?? null);
      return out;
    },
  },
  team: table(() => state.teams, 'team'),
  device: table(() => state.devices, 'dev'),
  deviceSession: table(() => state.sessions, 'sess'),
  sensorPacket: table(() => state.packets, 'pkt'),
  aIModel: table(() => state.models, 'model'),
  // `clubDependencies` counts twelve tables before it will allow a permanent
  // deletion. Each is empty here, which is the only state in which the service
  // permits one — a club that still owns anything is refused.
  player: empty, match: empty, trainingSession: empty, announcement: empty,
  staffEngagement: empty, financial: empty, gpsDevice: empty, scoutReport: empty,
  whiteLabelConfig: { upsert: async ({ create }: Row) => create },
  // `endClubSession` ends every session a suspended member holds.
  refreshToken: { deleteMany: async () => ({ count: 0 }) },
  eventOutbox: { create: async ({ data }: Row) => data, findMany: async () => [] },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));
jest.mock('../src/lib/prisma', () => ({ prisma: db, default: db }));

// The guards these services run before they do anything. Each is a real check
// in production and each is somebody else's suite; here they pass, so what is
// under test is what the flow publishes rather than who may call it.
jest.mock('../src/platform/system.service', () => ({
  assertPlatformOwner: jest.fn(async () => undefined),
}));
jest.mock('../src/platform/environment', () => ({ currentEnvironment: () => 'test' }));
jest.mock('../src/platform/email/service', () => ({
  emailConfiguration: () => ({ configured: false, provider: 'none' }),
}));
jest.mock('../src/services/ai-audit.service', () => ({
  writeAIAudit: jest.fn(async (row: Row) => { state.aiAudit.push(row); }),
}));
jest.mock('../src/fusion/realtime-ingest', () => ({
  emitSensorPacket: jest.fn(), emitSensorBatch: jest.fn(),
}));
jest.mock('../src/middleware/auth.middleware', () => ({ forgetIdentity: jest.fn() }));
jest.mock('../src/fabric/secrets/device-credentials', () => ({
  resolveCredential: jest.fn(async () => null),
  storeNewCredential: jest.fn(async () => 'secret-ref-1'),
}));

/** The invitation service. Mints a token this suite then hunts for. */
const invitationView = (email: string, id = 'inv-view-1') => ({
  id, email, role: 'CLUB_OWNER', status: 'PENDING',
  expiresAt: new Date(Date.now() + 7 * 864e5),
});
jest.mock('../src/identity/invitation.service', () => ({
  createInvitation: jest.fn(async (_a: Row, dto: Row) => ({
    invitation: invitationView(dto.email),
    token: SECRETS.invitationToken,
    delivery: { state: 'NOT_SENT' },
  })),
  resendInvitation: jest.fn(async () => ({
    invitation: invitationView(SECRETS.presidentEmail),
    token: SECRETS.invitationToken,
    delivery: { state: 'NOT_SENT' },
  })),
  revokeInvitation: jest.fn(async () => undefined),
}));

import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { project, sourceLaneFor, destinationLaneFor, pulseTopology } from '../src/fabric/pulse/pulse.service';
import { resolveSubjects } from '../src/fabric/pulse/subject-resolver.service';
import { fabricEvent, fabricEventsForSource, fabricEvents } from '../src/fabric/registry/event-registry';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import { resetFabricSelfHealth } from '../src/fabric/producers/system.producer';
// Every lane the platform registers at boot, so a source assertion below
// describes the real board rather than whichever producers this file imported.
import '../src/fabric/producers/coach-market.producer';
import '../src/fabric/producers/clubs.producer';
import '../src/fabric/producers/devices.producer';

import * as clubService from '../src/services/club.service';
import * as onboarding from '../src/platform/club-onboarding.service';
import * as lifecycle from '../src/platform/club-lifecycle.service';
import * as membership from '../src/services/membership.service';
import * as context from '../src/services/context.service';
import * as deviceRegistry from '../src/services/device-registry.service';
import * as deviceSession from '../src/services/device-session.service';
import * as modelRegistry from '../src/services/ai-model-registry.service';

let published: FamilistaEvent[] = [];

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const recording: EventTransport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as EventTransport;

/** A transport that fails every append, for the failure-isolation tests. */
const broken: EventTransport = {
  name: 'BROKEN',
  async append() { throw new Error('outbox unavailable'); },
  async read() { return []; },
} as EventTransport;

const typesOf = (): string[] => published.map((e) => e.eventType).sort();
const only = (type: string): FamilistaEvent[] => published.filter((e) => e.eventType === type);

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const OWNER = { userId: ACTOR, ipAddress: '10.0.0.1', userAgent: 'jest', correlationId: 'corr-1' };

beforeEach(() => {
  published = [];
  seq = 0;
  resetFabricSelfHealth();
  setEventTransport(recording);
  state.clubs = [];
  state.invitations = [];
  state.memberships = [];
  state.membershipAudit = [];
  state.platformAudit = [];
  state.packets = [];
  state.devices = [];
  state.sessions = [];
  state.aiAudit = [];
  state.teams = [
    { id: TEAM, clubId: CLUB, kind: 'SENIOR', isActive: true },
    { id: OTHER_TEAM, clubId: CLUB, kind: 'ACADEMY_U13', isActive: true },
  ];
  state.users = [{ id: MEMBER, clubId: CLUB, currentClubId: null, currentTeamId: null }];
  state.models = [{
    id: 'model-1', slug: SECRETS.modelSlug, version: '3.1.0',
    domain: 'SQUAD', decisionType: 'SELECTION', isActive: false,
    deprecatedAt: null, releasedAt: null,
  }, {
    id: 'model-old', slug: 'squad-selection-v2', version: '2.0.0',
    domain: 'SQUAD', decisionType: 'SELECTION', isActive: true,
    deprecatedAt: null, releasedAt: new Date(),
  }];
});

/** A club as the database holds one, complete with the private parts. */
const aClub = (over: Row = {}): Row => ({
  id: CLUB, name: 'FC Musterstadt', city: 'Musterstadt', country: 'Germany',
  shortName: 'FCM', lifecycle: 'ACTIVE', previousLifecycle: null,
  contactEmail: SECRETS.contactEmail, websiteUrl: SECRETS.websiteUrl,
  emblem: null, timezone: 'Europe/Berlin', defaultLocale: 'de-DE',
  lifecycleReason: null, lifecycleChangedAt: null, lifecycleChangedByUserId: null,
  deactivatedAt: null, reactivatedAt: null, archivedAt: null, restoredAt: null,
  activatedAt: null, createdAt: new Date(),
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the Clubs lane, which had four names and no producer', () => {
  it('announces a self-service creation once, after the row exists', async () => {
    const out = await clubService.createClubAwaitingPresident(
      { name: 'FC Neustadt', city: 'Neustadt', country: 'Germany', shortName: 'FCN' } as never,
      MEMBER,
    );
    await settle();

    expect(typesOf()).toEqual(['club.created']);
    const e = only('club.created')[0];
    expect(e.clubId).toBe(out.clubId);
    expect(e.subjectType).toBe('CLUB');
    expect(e.payload).toEqual({
      route: 'SELF_SERVICE', lifecycle: 'PENDING_SETUP',
      countryDeclared: true, shortNameDeclared: true,
    });
    expect(sourceLaneFor('club.created')).toBe('Clubs');
  });

  it('publishes nothing when the creation is refused', async () => {
    state.clubs = [aClub({ name: 'FC Neustadt' })];
    state.memberships = [{ id: 'm1', userId: MEMBER, clubId: CLUB, isActive: true }];
    await expect(clubService.createClubAwaitingPresident(
      { name: 'FC Neustadt', city: 'Neustadt' } as never, MEMBER,
    )).rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('a platform creation is two events, and the invitation is not a third', async () => {
    await onboarding.createClubWithPresidentInvite(OWNER as never, {
      name: 'FC Platzhalter', city: 'Berlin',
      president: {
        firstName: 'Ingrid', lastName: 'Bergström-Okafor',
        email: SECRETS.presidentEmail, message: 'Please take this on',
      },
    } as never);
    await settle();

    // The club, and the invitation. NOT `club.lifecycle.changed` — the move to
    // PRESIDENT_INVITED is what `club.president.invited` means, and a third
    // name for it would draw one occurrence twice.
    expect(typesOf()).toEqual(['club.created', 'club.president.invited']);
    expect(only('club.created')[0].payload).toMatchObject({ route: 'PLATFORM' });
    expect(only('club.president.invited')[0].payload).toEqual({
      role: 'CLUB_OWNER', issue: 'NEW', lifecycle: 'PRESIDENT_INVITED',
    });
  });

  it('carries no address, no token and no contact detail off a club creation', async () => {
    await onboarding.createClubWithPresidentInvite(OWNER as never, {
      name: 'FC Platzhalter', city: 'Berlin', contactEmail: SECRETS.contactEmail,
      websiteUrl: SECRETS.websiteUrl,
      president: {
        firstName: 'Ingrid', lastName: 'Bergström-Okafor',
        email: SECRETS.presidentEmail, message: 'Please take this on',
      },
    } as never);
    await settle();

    const frames = published.map((e) => project(e));
    await resolveSubjects(frames);
    const surfaces = JSON.stringify({ published, frames });
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(`${name}: absent`).toBe(`${name}: ${surfaces.includes(secret) ? 'LEAKED' : 'absent'}`);
    }
  });

  it('tells a re-mint from a replacement without naming either address', async () => {
    state.clubs = [aClub({ lifecycle: 'PRESIDENT_INVITED' })];
    state.invitations = [{
      id: 'inv-1', clubId: CLUB, role: 'CLUB_OWNER', status: 'PENDING',
      email: SECRETS.presidentEmail, createdAt: new Date(),
    }];

    await onboarding.resendPresidentInvite(OWNER as never, CLUB);
    await settle();
    expect(typesOf()).toEqual(['club.president.invited']);
    expect(only('club.president.invited')[0].payload).toMatchObject({ issue: 'RESENT' });

    published = [];
    await onboarding.replacePresidentInvite(OWNER as never, CLUB, {
      firstName: 'Otto', lastName: 'Vance', email: 'someone.else@private.test',
    });
    await settle();
    expect(typesOf()).toEqual(['club.president.invited']);
    expect(only('club.president.invited')[0].payload).toMatchObject({ issue: 'REPLACED' });

    const surfaces = JSON.stringify(published);
    expect(surfaces).not.toContain(SECRETS.presidentEmail);
    expect(surfaces).not.toContain('someone.else@private.test');
  });

  it('a revocation is a lifecycle move backwards, and not an invitation', async () => {
    state.clubs = [aClub({ lifecycle: 'PRESIDENT_INVITED' })];
    state.invitations = [{
      id: 'inv-1', clubId: CLUB, role: 'CLUB_OWNER', status: 'PENDING',
      email: SECRETS.presidentEmail, createdAt: new Date(),
    }];
    await onboarding.revokePresidentInvite(OWNER as never, CLUB, SECRETS.lifecycleReason);
    await settle();

    expect(typesOf()).toEqual(['club.lifecycle.changed']);
    expect(only('club.lifecycle.changed')[0].payload).toEqual({
      from: 'PRESIDENT_INVITED', to: 'PENDING_SETUP',
      action: 'ClubPresidentInvitationRevoked',
    });
    // The reason somebody typed is a safeguarding sentence about a named coach.
    expect(JSON.stringify(published)).not.toContain(SECRETS.lifecycleReason);
  });

  it('activation publishes once however many times it is called', async () => {
    state.clubs = [aClub({ lifecycle: 'PRESIDENT_INVITED' })];
    state.memberships = [{
      id: 'mem-owner', clubId: CLUB, userId: MEMBER,
      role: 'CLUB_OWNER', isActive: true, status: 'ACTIVE', teamId: null,
    }];

    await onboarding.activateIfReady(CLUB, { userId: ACTOR } as never);
    await onboarding.activateIfReady(CLUB, { userId: ACTOR } as never);
    await onboarding.activateIfReady(CLUB, { userId: ACTOR } as never);
    await settle();

    // Three calls, one transition. The update is conditional on the club not
    // already being ACTIVE and the publish is conditional on the update.
    expect(typesOf()).toEqual(['club.lifecycle.changed']);
    expect(only('club.lifecycle.changed')[0].payload).toEqual({
      from: 'PRESIDENT_INVITED', to: 'ACTIVE', action: 'ClubActivated',
    });
  });

  it('every one of the four lifecycle moves publishes through one funnel', async () => {
    const moves: Array<[string, () => Promise<unknown>, string, string]> = [
      ['ClubDeactivated', () => lifecycle.deactivateClub(OWNER as never, CLUB, SECRETS.lifecycleReason), 'ACTIVE', 'DEACTIVATED'],
      ['ClubReactivated', () => lifecycle.reactivateClub(OWNER as never, CLUB), 'DEACTIVATED', 'ACTIVE'],
      ['ClubArchived', () => lifecycle.archiveClub(OWNER as never, CLUB), 'ACTIVE', 'ARCHIVED'],
      ['ClubRestored', () => lifecycle.restoreClub(OWNER as never, CLUB), 'ARCHIVED', 'ACTIVE'],
    ];
    for (const [action, run, from, to] of moves) {
      published = [];
      state.clubs = [aClub({ lifecycle: from, previousLifecycle: from === 'ACTIVE' ? null : 'ACTIVE' })];
      await run();
      await settle();
      expect(`${action}: ${typesOf().join(',')}`).toBe(`${action}: club.lifecycle.changed`);
      expect(only('club.lifecycle.changed')[0].payload).toEqual({ from, to, action });
    }
    // One publish statement in the file, not four. Four helpers each announcing
    // for themselves would be four chances to announce a state the row does not
    // hold.
    const src = decomment(read('src/platform/club-lifecycle.service.ts'));
    expect(src.match(/publishClubLifecycleChanged\(/g) ?? []).toHaveLength(1);
  });

  it('a refused transition publishes nothing', async () => {
    state.clubs = [aClub({ lifecycle: 'ARCHIVED' })];
    await expect(lifecycle.deactivateClub(OWNER as never, CLUB)).rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('a permanent deletion is announced after the row is gone', async () => {
    // Permanent deletion is refused unless the club owns nothing — twelve
    // counts, all of which must be zero. That is why the payload carries no
    // dependency figures: they are zero by construction.
    state.clubs = [aClub({ lifecycle: 'ARCHIVED' })];
    state.teams = []; state.invitations = []; state.users = [];
    await lifecycle.deleteClubForever(OWNER as never, CLUB, { name: 'FC Musterstadt' });
    await settle();

    expect(typesOf()).toEqual(['club.deleted']);
    expect(only('club.deleted')[0].payload).toEqual({ lifecycle: 'ARCHIVED' });
    expect(state.clubs).toEqual([]);
    // The publish is below the delete in the file, not above it: a deletion
    // that rolled back is not a deletion.
    const src = decomment(read('src/platform/club-lifecycle.service.ts'));
    const fn = src.slice(src.indexOf('export async function deleteClubForever'));
    expect(fn.indexOf('tx.club.delete')).toBeLessThan(fn.indexOf('publishClubDeleted'));
  });

  it('a deletion refused for the wrong name publishes nothing', async () => {
    state.clubs = [aClub()];
    state.teams = []; state.invitations = []; state.users = [];
    await expect(lifecycle.deleteClubForever(OWNER as never, CLUB, { name: 'Not The Name' }))
      .rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
    expect(state.clubs).toHaveLength(1);
  });

  it('every Clubs type is produced, and the lane is one source', () => {
    const owned = fabricEventsForSource('clubs');
    // The four the taxonomy shipped, plus `club.updated`, which this producer
    // registers because `updateClubProfile` is a real persisted general edit
    // that had no name at all.
    expect(owned.map((s) => s.type).sort()).toEqual([
      'club.created', 'club.deleted', 'club.lifecycle.changed',
      'club.president.invited', 'club.updated',
    ]);
    for (const spec of owned) {
      expect(`${spec.type} produced: ${spec.produced}`).toBe(`${spec.type} produced: true`);
      expect(sourceLaneFor(spec.type)).toBe('Clubs');
      // Registered under `clubs`, and its destination is stated rather than
      // reached by falling through the map's default.
      expect(destinationLaneFor(spec.type)).toBe('Audit');
      // A strict schema exists for each, so an unknown key quarantines.
      expect(validateEventPayload(spec.type, 1, null).ok).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the two Users flows that wrote audit rows and said nothing', () => {
  const member = (over: Row = {}) => ({
    id: 'mem-1', clubId: CLUB, userId: MEMBER, role: 'COACH',
    teamId: null, isActive: true, status: 'ACTIVE', ...over,
  });

  it('a team move publishes the field name and the scope, never the team', async () => {
    state.memberships = [member()];
    await membership.changeTeam({ userId: ACTOR, clubId: CLUB } as never, 'mem-1', OTHER_TEAM);
    await settle();

    expect(typesOf()).toEqual(['membership.changed']);
    const e = only('membership.changed')[0];
    expect(e.payload).toEqual({ changedFields: ['teamId'], scope: 'TEAM' });
    expect(e.subjectType).toBe('MEMBERSHIP');
    // The squad a person was moved into is not on the envelope either: a team
    // id beside a membership event is a person's position in a club.
    expect(e.teamId).toBeNull();
    expect(JSON.stringify(e)).not.toContain(OTHER_TEAM);
    expect(sourceLaneFor('membership.changed')).toBe('Users');
  });

  it('moving a membership to the team it already has publishes nothing', async () => {
    state.memberships = [member({ teamId: OTHER_TEAM })];
    await membership.changeTeam({ userId: ACTOR, clubId: CLUB } as never, 'mem-1', OTHER_TEAM);
    await settle();
    expect(published).toEqual([]);
  });

  it('a context switch publishes two booleans and no ids', async () => {
    state.clubs = [aClub()];
    state.memberships = [member()];
    await context.switchContext({ userId: MEMBER }, CLUB, TEAM);
    await settle();

    expect(typesOf()).toEqual(['user.context.switched']);
    const e = only('user.context.switched')[0];
    expect(e.payload).toEqual({
      clubChanged: true, teamChanged: true, scope: 'TEAM', viaPlatform: false,
    });
    expect(e.subjectType).toBe('USER');
    expect(JSON.stringify(e.payload)).not.toContain(TEAM);
  });

  it('reselecting the context you are already in publishes nothing', async () => {
    state.clubs = [aClub()];
    state.memberships = [member()];
    state.users = [{ id: MEMBER, clubId: CLUB, currentClubId: CLUB, currentTeamId: null }];
    await context.switchContext({ userId: MEMBER }, CLUB, null);
    await settle();
    expect(published).toEqual([]);
  });

  it('a refused switch publishes nothing', async () => {
    state.memberships = [];
    state.users = [{ id: MEMBER, clubId: 'some-other-club', currentClubId: null, currentTeamId: null }];
    await expect(context.switchContext({ userId: MEMBER }, CLUB, null)).rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('`user.role.changed` still has no producer, because nothing moves that column', () => {
    expect(fabricEvent('user.role.changed')?.produced).toBe(false);
    const src = decomment(read('src/fabric/producers/users.producer.ts'));
    expect(src).not.toMatch(/eventType: 'user\.role\.changed',\s*\n\s*clubId/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('devices and their telemetry', () => {
  const ACTOR_CTX = { userId: ACTOR, clubId: CLUB };

  it('an enrolment publishes the model and the state, never the serial or the secret', async () => {
    const out = await deviceRegistry.registerDevice(ACTOR_CTX as never, {
      serial: SECRETS.deviceSerial, model: 'FAMILISTA-WEAR-2',
      teamId: OTHER_TEAM, notes: SECRETS.deviceNotes,
    } as never);
    await settle();

    expect(typesOf()).toEqual(['device.registered']);
    const e = only('device.registered')[0];
    expect(e.payload).toEqual({
      model: 'FAMILISTA-WEAR-2', status: 'REGISTERED',
      credentialStored: true, teamScoped: true,
    });
    // The plaintext secret is handed back to the caller and is on no event.
    expect(out.hmacSecretPlaintext).toBeTruthy();
    const surfaces = JSON.stringify(published);
    expect(surfaces).not.toContain(out.hmacSecretPlaintext);
    expect(surfaces).not.toContain(SECRETS.deviceSerial);
    expect(surfaces).not.toContain(SECRETS.deviceNotes);
    expect(sourceLaneFor('device.registered')).toBe('System');
  });

  it('a duplicate serial is refused and publishes nothing', async () => {
    state.devices = [{ id: 'dev-0', serial: SECRETS.deviceSerial, clubId: CLUB }];
    await expect(deviceRegistry.registerDevice(ACTOR_CTX as never, {
      serial: SECRETS.deviceSerial, model: 'FAMILISTA-WEAR-2',
    } as never)).rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('a session opens and closes once each, and the session key never travels', async () => {
    const session = await deviceSession.openSession(ACTOR_CTX as never, {
      deviceModel: 'FAMILISTA-WEAR-2', deviceSerial: SECRETS.deviceSerial,
      edgeFwVersion: '1.4.2', teamId: TEAM, trainingSessionId: null, matchId: null,
    } as never);
    await settle();

    expect(typesOf()).toEqual(['device.connected']);
    expect(only('device.connected')[0].payload).toEqual({
      model: 'FAMILISTA-WEAR-2', attachedTo: 'NONE',
      firmwareDeclared: true, teamScoped: true,
    });
    expect(JSON.stringify(published)).not.toContain(session.sessionKey);

    published = [];
    await deviceSession.closeSession(ACTOR_CTX as never, session.id);
    await deviceSession.closeSession(ACTOR_CTX as never, session.id);
    await settle();

    // Twice called, once announced: the service returns the row untouched when
    // it is already closed, and a second close is not a second disconnection.
    expect(typesOf()).toEqual(['device.disconnected']);
    const e = only('device.disconnected')[0];
    expect(e.payload).toMatchObject({ model: 'FAMILISTA-WEAR-2', attachedTo: 'NONE' });
    expect(typeof (e.payload as Row).durationSeconds === 'number').toBe(true);
  });

  it('a batch is one event with a count and kinds, never a packet', async () => {
    const session = await deviceSession.openSession(ACTOR_CTX as never, {
      deviceModel: 'FAMILISTA-WEAR-2', deviceSerial: SECRETS.deviceSerial,
      edgeFwVersion: '1.4.2', teamId: TEAM,
    } as never);
    published = [];

    const packets = Array.from({ length: 64 }, (_, i) => ({
      kind: i % 2 ? 'IMU' : 'ECG',
      capturedAt: new Date().toISOString(),
      payload: { raw: SECRETS.packetPayload },
      sigB64: 'c2ln',
    }));
    const out = await deviceSession.ingestBatch(ACTOR_CTX as never, session.id, packets as never);
    await settle();

    expect(out.accepted).toBe(64);
    // ONE event for sixty-four packets. Per-packet would be a flood at 100 Hz.
    expect(typesOf()).toEqual(['telemetry.batch.received']);
    const e = only('telemetry.batch.received')[0];
    expect(e.payload).toEqual({
      accepted: 64, kinds: ['ECG', 'IMU'], attachedTo: 'NONE',
    });
    // A sensor payload is a heart rate and a position, and on an academy squad
    // that is a child's.
    expect(JSON.stringify(published)).not.toContain(SECRETS.packetPayload);
    expect(destinationLaneFor('telemetry.batch.received')).toBe('Analytics');
  });

  it('a rejected batch publishes nothing', async () => {
    const session = await deviceSession.openSession(ACTOR_CTX as never, {
      deviceModel: 'W', deviceSerial: 'S', edgeFwVersion: '1',
    } as never);
    published = [];
    await expect(deviceSession.ingestBatch(ACTOR_CTX as never, session.id, [] as never))
      .rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('camera streams stay unproduced, because this build has no camera lifecycle', () => {
    for (const t of ['camera.stream.started', 'camera.stream.ended']) {
      expect(`${t}: ${fabricEvent(t)?.produced}`).toBe(`${t}: false`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the model registry', () => {
  it('a deployment names the decision and the count, never the slug or the notes', async () => {
    await modelRegistry.activateModel({ userId: ACTOR } as never, 'model-1', {
      notes: SECRETS.activationNotes,
    } as never);
    await settle();

    expect(typesOf()).toEqual(['model.deployment.completed']);
    const e = only('model.deployment.completed')[0];
    expect(e.payload).toEqual({
      domain: 'SQUAD', decisionType: 'SELECTION', version: '3.1.0',
      peersDeactivated: 1, component: 'MODEL',
    });
    expect(e.subjectType).toBe('MODEL');
    const surfaces = JSON.stringify(published);
    expect(surfaces).not.toContain(SECRETS.modelSlug);
    expect(surfaces).not.toContain(SECRETS.activationNotes);
    expect(sourceLaneFor('model.deployment.completed')).toBe('AI');
  });

  it('reports the peers that really stood down, not the flag that was passed', async () => {
    state.models = [
      { id: 'model-1', slug: 's', version: '1', domain: 'SQUAD', decisionType: 'SELECTION', isActive: false, deprecatedAt: null, releasedAt: null },
    ];
    await modelRegistry.activateModel({ userId: ACTOR } as never, 'model-1', {} as never);
    await settle();
    expect((only('model.deployment.completed')[0].payload as Row).peersDeactivated).toBe(0);
  });

  it('activating a deprecated model is refused and publishes nothing', async () => {
    state.models = [{
      id: 'model-1', slug: 's', version: '1', domain: 'SQUAD',
      decisionType: 'SELECTION', isActive: false, deprecatedAt: new Date(), releasedAt: null,
    }];
    await expect(modelRegistry.activateModel({ userId: ACTOR } as never, 'model-1', {} as never))
      .rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('`model.evaluation.completed` stays unproduced — nothing evaluates a model', () => {
    expect(fabricEvent('model.evaluation.completed')?.produced).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a broken fabric never breaks the business operation', () => {
  beforeEach(() => setEventTransport(broken));

  it('every one of the eleven flows still succeeds when every append throws', async () => {
    // Clubs
    const made = await clubService.createClubAwaitingPresident(
      { name: 'FC Resilient', city: 'Nowhere' } as never, MEMBER,
    );
    expect(made.clubId).toBeTruthy();

    state.clubs = [aClub({ lifecycle: 'PRESIDENT_INVITED' })];
    state.invitations = [{ id: 'inv-1', clubId: CLUB, role: 'CLUB_OWNER', status: 'PENDING', email: SECRETS.presidentEmail, createdAt: new Date() }];
    await expect(onboarding.resendPresidentInvite(OWNER as never, CLUB)).resolves.toBeTruthy();
    await expect(onboarding.revokePresidentInvite(OWNER as never, CLUB)).resolves.toBeTruthy();

    state.clubs = [aClub({ lifecycle: 'ACTIVE' })];
    await expect(lifecycle.deactivateClub(OWNER as never, CLUB)).resolves.toBeTruthy();

    state.clubs = [aClub({ lifecycle: 'ARCHIVED' })];
    state.teams = []; state.invitations = []; state.users = [];
    await expect(lifecycle.deleteClubForever(OWNER as never, CLUB, { name: 'FC Musterstadt' }))
      .resolves.toMatchObject({ deleted: true });

    // Users
    state.clubs = [aClub()];
    state.teams = [{ id: TEAM, clubId: CLUB, kind: 'SENIOR', isActive: true }];
    state.users = [{ id: MEMBER, clubId: CLUB, currentClubId: null, currentTeamId: null }];
    state.memberships = [{ id: 'mem-1', clubId: CLUB, userId: MEMBER, role: 'COACH', teamId: null, isActive: true, status: 'ACTIVE' }];
    await expect(membership.changeTeam({ userId: ACTOR, clubId: CLUB } as never, 'mem-1', TEAM))
      .resolves.toBeTruthy();
    await expect(context.switchContext({ userId: MEMBER }, CLUB, null)).resolves.toBeTruthy();

    // Devices
    await expect(deviceRegistry.registerDevice({ userId: ACTOR, clubId: CLUB } as never, {
      serial: 'SN-RESILIENT', model: 'W',
    } as never)).resolves.toBeTruthy();
    const session = await deviceSession.openSession({ userId: ACTOR, clubId: CLUB } as never, {
      deviceModel: 'W', deviceSerial: 'SN-RESILIENT', edgeFwVersion: '1',
    } as never);
    expect(session.id).toBeTruthy();
    await expect(deviceSession.ingestBatch({ userId: ACTOR, clubId: CLUB } as never, session.id, [
      { kind: 'IMU', capturedAt: new Date().toISOString(), payload: {} },
    ] as never)).resolves.toEqual({ accepted: 1 });
    await expect(deviceSession.closeSession({ userId: ACTOR, clubId: CLUB } as never, session.id))
      .resolves.toBeTruthy();

    // Model registry
    await expect(modelRegistry.activateModel({ userId: ACTOR } as never, 'model-1', {} as never))
      .resolves.toBeTruthy();

    await settle();
  });

  it('no helper in either new producer is awaited', () => {
    for (const f of ['src/fabric/producers/clubs.producer.ts', 'src/fabric/producers/devices.producer.ts']) {
      const src = decomment(read(f));
      expect(`${f}: ${/await publishFabricEvent\(/.test(src)}`).toBe(`${f}: false`);
      expect(src).toMatch(/publishFabricEventDetached\(/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a club’s own record, amended', () => {
  it('publishes the field names once, and never the values', async () => {
    state.clubs = [aClub()];
    await clubService.updateClubProfile(
      CLUB,
      { name: 'FC Musterstadt 1904', crestUrl: 'https://cdn.private.test/crest.png' } as never,
      { primaryColor: '#0b5cff', logoUrl: 'https://cdn.private.test/logo.png' } as never,
      ACTOR,
    );
    await settle();

    expect(typesOf()).toEqual(['club.updated']);
    const e = only('club.updated')[0];
    expect(e.payload).toEqual({
      changedFields: ['name', 'crestUrl', 'primaryColor', 'logoUrl'],
      brandChanged: true,
    });
    // A brand colour and a logo URL are a paying customer's configuration.
    const surfaces = JSON.stringify(published);
    expect(surfaces).not.toContain('#0b5cff');
    expect(surfaces).not.toContain('cdn.private.test');
    expect(sourceLaneFor('club.updated')).toBe('Clubs');
  });

  it('says so when only the brand moved', async () => {
    state.clubs = [aClub()];
    await clubService.updateClubProfile(CLUB, {} as never, { accentColor: '#fff' } as never, ACTOR);
    await settle();
    expect(only('club.updated')[0].payload).toEqual({
      changedFields: ['accentColor'], brandChanged: true,
    });
  });

  it('an empty patch writes nothing and publishes nothing', async () => {
    state.clubs = [aClub()];
    await clubService.updateClubProfile(CLUB, {} as never, {} as never, ACTOR);
    await settle();
    expect(published).toEqual([]);
  });

  it('a patch against a club that is not there publishes nothing', async () => {
    state.clubs = [];
    await expect(clubService.updateClubProfile(CLUB, { name: 'X' } as never, {} as never, ACTOR))
      .rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('cannot fire for a status transition, because the patch cannot reach one', () => {
    // The rule is structural rather than conditional: `ClubCorePatch` is the
    // only shape `updateClubProfile` writes onto the club, and it has no
    // `lifecycle`. A state transition therefore cannot arrive at `club.updated`
    // — it goes to `club.lifecycle.changed`, which is the specialised event for
    // exactly that fact.
    const src = decomment(read('src/services/club.service.ts'));
    const patch = src.slice(src.indexOf('export interface ClubCorePatch'), src.indexOf('export interface ClubBrandPatch'));
    expect(patch).not.toMatch(/lifecycle/);
    expect(patch).not.toMatch(/status/);
    const fn = src.slice(src.indexOf('export async function updateClubProfile'));
    expect(fn).not.toMatch(/publishClubLifecycleChanged/);
    // And the lifecycle service does not reach for the general update event.
    expect(decomment(read('src/platform/club-lifecycle.service.ts'))).not.toMatch(/publishClubUpdated/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a membership suspended, and restored', () => {
  const member = (over: Row = {}) => ({
    id: 'mem-1', clubId: CLUB, userId: MEMBER, role: 'COACH',
    teamId: null, isActive: true, status: 'ACTIVE', joinedAt: new Date(), leftAt: null,
    ...over,
  });

  beforeEach(() => {
    // A second owner, so `assertNotLastOwner` does not refuse the suspension.
    state.memberships = [
      member(),
      member({ id: 'mem-owner', userId: 'u-owner', role: 'CLUB_OWNER' }),
    ];
  });

  it('a suspension publishes exactly once, and is not a revocation', async () => {
    await membership.suspendMembership(
      { userId: ACTOR, clubId: CLUB } as never, 'mem-1',
      'Suspended while the safeguarding complaint is investigated',
    );
    await settle();

    expect(typesOf()).toEqual(['membership.suspended']);
    const e = only('membership.suspended')[0];
    expect(e.payload).toEqual({ role: 'COACH', scope: 'CLUB' });
    expect(e.subjectType).toBe('MEMBERSHIP');
    // Never borrowed. A revocation means the person left the club.
    expect(typesOf()).not.toContain('membership.revoked');
    expect(typesOf()).not.toContain('membership.changed');
    // And the reason somebody typed is the most sensitive sentence in the flow.
    expect(JSON.stringify(published)).not.toContain('safeguarding');
    expect(sourceLaneFor('membership.suspended')).toBe('Users');
  });

  it('a restoration publishes exactly once, and is not a grant', async () => {
    state.memberships = [
      member({ isActive: false, status: 'SUSPENDED' }),
      member({ id: 'mem-owner', userId: 'u-owner', role: 'CLUB_OWNER' }),
    ];
    await membership.reactivateMembership({ userId: ACTOR, clubId: CLUB } as never, 'mem-1');
    await settle();

    expect(typesOf()).toEqual(['membership.reactivated']);
    expect(only('membership.reactivated')[0].payload).toEqual({
      role: 'COACH', scope: 'CLUB', from: 'SUSPENDED',
    });
    // Nobody was GIVEN access here; access they already held was restored.
    expect(typesOf()).not.toContain('membership.granted');
    expect(typesOf()).not.toContain('membership.changed');
  });

  it('names the state it came out of, so a restored revocation is not a lifted suspension', async () => {
    state.memberships = [
      member({ isActive: false, status: 'REVOKED' }),
      member({ id: 'mem-owner', userId: 'u-owner', role: 'CLUB_OWNER' }),
    ];
    await membership.reactivateMembership({ userId: ACTOR, clubId: CLUB } as never, 'mem-1');
    await settle();
    expect((only('membership.reactivated')[0].payload as Row).from).toBe('REVOKED');
  });

  it('suspending an already-suspended membership is refused and publishes nothing', async () => {
    state.memberships = [
      member({ isActive: false, status: 'SUSPENDED' }),
      member({ id: 'mem-owner', userId: 'u-owner', role: 'CLUB_OWNER' }),
    ];
    await expect(membership.suspendMembership({ userId: ACTOR, clubId: CLUB } as never, 'mem-1'))
      .rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('suspending the last owner is refused and publishes nothing', async () => {
    state.memberships = [member({ id: 'mem-owner', userId: 'u-owner', role: 'CLUB_OWNER' })];
    await expect(membership.suspendMembership({ userId: ACTOR, clubId: CLUB } as never, 'mem-owner'))
      .rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('restoring an already-active membership publishes nothing', async () => {
    await membership.reactivateMembership({ userId: ACTOR, clubId: CLUB } as never, 'mem-1');
    await settle();
    expect(published).toEqual([]);
  });

  it('a membership in another club is refused and publishes nothing', async () => {
    await expect(membership.suspendMembership(
      { userId: ACTOR, clubId: 'some-other-club' } as never, 'mem-1',
    )).rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('neither flow can reach the other’s event', () => {
    // `grantMembership` publishes `membership.granted`; `revokeMembership`
    // publishes `membership.revoked`. Suspension and restoration have their own
    // names and neither function calls the other, so one action is one event.
    const src = decomment(read('src/services/membership.service.ts'));
    const between = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to));
    const suspend = between('export async function suspendMembership', 'export async function reactivateMembership');
    const restore = between('export async function reactivateMembership', 'export async function changeTeam');
    expect(suspend).toMatch(/publishMembershipSuspended\(/);
    expect(suspend).not.toMatch(/publishMembershipRevoked\(|publishMembershipChanged\(|publishMembershipGranted\(/);
    expect(restore).toMatch(/publishMembershipReactivated\(/);
    expect(restore).not.toMatch(/publishMembershipGranted\(|publishMembershipChanged\(|publishMembershipRevoked\(/);
    expect(suspend).not.toMatch(/reactivateMembership\(/);
    expect(restore).not.toMatch(/grantMembership\(/);
    // One publish statement each.
    expect(suspend.match(/publishMembershipSuspended\(/g) ?? []).toHaveLength(1);
    expect(restore.match(/publishMembershipReactivated\(/g) ?? []).toHaveLength(1);
  });

  it('carries no person, no name and no id of one', async () => {
    await membership.suspendMembership({ userId: ACTOR, clubId: CLUB } as never, 'mem-1');
    await settle();
    const frames = published.map((e) => project(e));
    await resolveSubjects(frames);
    // `MEMBERSHIP` is not a safe subject kind, so the id is withheld and no
    // label is resolved onto the frame.
    for (const frame of frames) {
      expect(frame.subjectId).toBeNull();
      expect(frame.subjectLabel).toBeNull();
    }
    expect(JSON.stringify(frames)).not.toContain(MEMBER);
  });

  it('both are registered under Users, produced, and strictly shaped', () => {
    for (const t of ['membership.suspended', 'membership.reactivated']) {
      const spec = fabricEvent(t);
      expect(`${t} registered: ${!!spec}`).toBe(`${t} registered: true`);
      expect(`${t} source: ${spec!.source}`).toBe(`${t} source: users`);
      expect(`${t} entity: ${spec!.entityType}`).toBe(`${t} entity: MEMBERSHIP`);
      expect(`${t} produced: ${spec!.produced}`).toBe(`${t} produced: true`);
      expect(`${t} audit: ${spec!.auditRelevant}`).toBe(`${t} audit: true`);
      expect(sourceLaneFor(t)).toBe('Users');
      expect(destinationLaneFor(t)).toBe('Audit');
      // Strict: an unknown key quarantines rather than travelling.
      expect(validateEventPayload(t, 1, null).ok).toBe(false);
      expect(validateEventPayload(t, 1, { role: 'COACH', scope: 'CLUB', from: 'SUSPENDED', extra: 1 }).ok).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('model evaluation, which this build does not do', () => {
  it('stays registered and unproduced, because no evaluation workflow exists', () => {
    expect(fabricEvent('model.evaluation.completed')?.produced).toBe(false);
  });

  it('and nothing in the source evaluates a model against a dataset', () => {
    // The audit, as a test. `AIModel` has no evaluation columns, there is no
    // dataset entity, and `modelFeedbackStats` is a read-only aggregate over
    // per-decision human feedback that persists nothing and has no completed
    // state. Inventing a producer for this would be inventing the flow.
    const schema = read('prisma/schema.prisma');
    const model = schema.slice(schema.indexOf('model AIModel {'), schema.indexOf('model AIDecision {'));
    expect(model).not.toMatch(/evaluat/i);
    expect(schema).not.toMatch(/^model ModelEvaluation \{/m);
    expect(schema).not.toMatch(/^model Dataset \{/m);

    const registry = decomment(read('src/services/ai-model-registry.service.ts'));
    expect(registry).not.toMatch(/evaluat/i);
    // And no file publishes it.
    const dir = path.join(ROOT, 'src', 'fabric', 'producers');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = decomment(fs.readFileSync(path.join(dir, file), 'utf8'));
      expect(`${file}: ${/publish\w*\([^)]*'model\.evaluation\.completed'/.test(src)}`)
        .toBe(`${file}: false`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the catalogue, the lanes and the board', () => {
  it('reports exactly the eleven that the audit found missing as produced now', () => {
    const CLOSED = [
      'club.created', 'club.deleted', 'club.lifecycle.changed', 'club.president.invited',
      'membership.changed', 'user.context.switched',
      'device.registered', 'device.connected', 'device.disconnected',
      'telemetry.batch.received',
      'model.deployment.completed',
    ];
    expect(CLOSED).toHaveLength(11);
    for (const t of CLOSED) {
      expect(`${t}: ${fabricEvent(t)?.produced}`).toBe(`${t}: true`);
    }
  });

  it('leaves every name the audit classified as future, deprecated or noisy alone', () => {
    // Not an exhaustive list — a representative one from each of the four
    // reasons, so that a later change making coverage "look better" fails here.
    const STILL_FALSE = [
      'training.started', 'training.completed', 'attendance.recorded',  // superseded
      'camera.stream.started', 'camera.stream.ended',                   // future
      'model.evaluation.completed',                                     // future
      'user.role.changed',                                              // no flow
      'system.deploy.started', 'system.deploy.completed', 'system.deploy.failed',
      'system.route.changed', 'system.page.viewed', 'system.module.opened',
      'system.job.started', 'ai.task.started', 'media.processed',
      'transfer.offered', 'medical.injury.created',
    ];
    for (const t of STILL_FALSE) {
      expect(`${t}: ${fabricEvent(t)?.produced}`).toBe(`${t}: false`);
    }
  });

  it('every produced type still has a declared source and a declared lane', () => {
    const produced = fabricEvents().filter((e) => e.produced);
    const map = decomment(read('src/fabric/pulse/pulse.service.ts'));
    const block = map.slice(map.indexOf('const DESTINATION_LANE'));
    const declared = new Set<string>();
    for (const m of block.slice(0, block.indexOf('};')).matchAll(/(\w+):\s*'/g)) declared.add(m[1]);
    for (const spec of produced) {
      expect(`${spec.type} source: ${spec.source ? 'set' : 'MISSING'}`).toBe(`${spec.type} source: set`);
      const domain = spec.type.split('.')[0];
      expect(`${spec.type} lane: ${declared.has(domain) ? 'declared' : 'FELL THROUGH TO AUDIT'}`)
        .toBe(`${spec.type} lane: declared`);
    }
  });

  it('the board discovers the new activity with no edit to the interface', () => {
    const t = pulseTopology();
    // Clubs was always a lane. What changed is that it now has producers, and
    // the topology learned that from the registry rather than from a list.
    expect(t.sources).toContain('Clubs');
    const instrumented = new Set(t.instrumented.map((i) => i.eventType));
    for (const type of ['club.created', 'device.registered', 'telemetry.batch.received', 'model.deployment.completed']) {
      expect(`${type}: instrumented`).toBe(`${type}: ${instrumented.has(type) ? 'instrumented' : 'IN GAP LIST'}`);
      expect(t.notInstrumented).not.toContain(type);
    }
    // And no file that draws the board names any of them.
    const ui = decomment(read('public/data-pulse.js'));
    for (const type of ['club.created', 'device.registered', 'telemetry.batch.received']) {
      expect(`${type} in the interface: ${ui.includes(type)}`).toBe(`${type} in the interface: false`);
    }
  });

  it('no name this integration added is accepted by the registry and refused by the publisher', () => {
    // The divergence PR #15 found and fixed, re-checked against the names this
    // change newly publishes — `telemetry.batch.received` and the rest.
    const envelope = read('src/fabric/event-envelope.ts');
    const registry = read('src/fabric/registry/event-registry.ts');
    const pattern = /const TYPE_PATTERN = (\/.*\/);/;
    const a = envelope.match(pattern)?.[1];
    const b = registry.match(pattern)?.[1];
    expect(a).toBe(b);
    const re = new RegExp(a!.slice(1, -1));
    for (const spec of fabricEvents()) {
      expect(`${spec.type}: accepted`).toBe(`${spec.type}: ${re.test(spec.type) ? 'accepted' : 'REFUSED BY PUBLISHER'}`);
    }
  });

  it('the two club creation paths are independent, so neither double-publishes', () => {
    // `club.created` has two call sites and that is correct: two services each
    // write their own `club.create`. It stops being correct the moment one of
    // them starts delegating to the other, because then one creation announces
    // itself twice. Pinned from both directions.
    const selfService = decomment(read('src/services/club.service.ts'));
    const platform = decomment(read('src/platform/club-onboarding.service.ts'));
    expect(selfService).not.toMatch(/club-onboarding/);
    expect(platform).not.toMatch(/createClubAwaitingPresident/);
    expect(selfService).toMatch(/prisma\.club\.create\(/);
    expect(platform).toMatch(/tx\.club\.create\(/);
    // One publish statement each.
    expect(selfService.match(/publishClubCreated\(/g) ?? []).toHaveLength(1);
    expect(platform.match(/publishClubCreated\(/g) ?? []).toHaveLength(1);
  });

  it('every newly wired publish sits below the write it announces', () => {
    // A publish above its own commit announces something that may yet be rolled
    // back. Checked per function, on the source, because an ordering rule that
    // only a reviewer enforces is not enforced.
    const cases: Array<[string, string, string, string]> = [
      ['src/services/club.service.ts', 'export async function createClubAwaitingPresident', 'prisma.club.create(', 'publishClubCreated('],
      ['src/services/membership.service.ts', 'export async function changeTeam', 'prisma.$transaction(', 'publishMembershipChanged('],
      ['src/services/context.service.ts', 'export async function switchContext', 'prisma.$transaction(', 'publishUserContextSwitched('],
      ['src/services/device-registry.service.ts', 'export async function registerDevice', 'prisma.device.create(', 'publishDeviceRegistered('],
      ['src/services/device-session.service.ts', 'export async function openSession', 'prisma.deviceSession.create(', 'publishDeviceConnected('],
      ['src/services/device-session.service.ts', 'export async function closeSession', 'prisma.deviceSession.update(', 'publishDeviceDisconnected('],
      ['src/services/device-session.service.ts', 'export async function ingestBatch', 'prisma.sensorPacket.createMany(', 'publishTelemetryBatchReceived('],
      ['src/services/ai-model-registry.service.ts', 'export async function activateModel', 'writeAIAudit(', 'publishModelDeploymentCompleted('],
      ['src/platform/club-lifecycle.service.ts', 'async function transition', 'prisma.$transaction(', 'publishClubLifecycleChanged('],
    ];
    for (const [file, fn, write, publish] of cases) {
      const src = decomment(read(file));
      const start = src.indexOf(fn);
      expect(`${file} ${fn}: found`).toBe(`${file} ${fn}: ${start >= 0 ? 'found' : 'MISSING'}`);
      const body = src.slice(start, src.indexOf('\nexport ', start + 10) >= 0 ? src.indexOf('\nexport ', start + 10) : undefined);
      const w = body.indexOf(write);
      const pub = body.indexOf(publish);
      expect(`${fn}/${publish}: after the write`).toBe(
        `${fn}/${publish}: ${w >= 0 && pub > w ? 'after the write' : 'BEFORE THE WRITE'}`,
      );
    }
  });

  it('no event type is published from two different producer files', () => {
    // A second producer for a name that already has one is how a fact comes to
    // be drawn twice. Every `publishFabricEventDetached({ eventType: 'x' })` in
    // the tree must be the only one for that name.
    const dir = path.join(ROOT, 'src', 'fabric', 'producers');
    const owner = new Map<string, string>();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = decomment(fs.readFileSync(path.join(dir, file), 'utf8'));
      // Two producer styles: a literal `eventType:` at the publish call, and a
      // local `publish('name', …)` wrapper. Both name the type; neither may
      // name one another file already owns. A `registerFabricSchema` line is
      // excluded by the `version` lookahead — declaring a shape is not
      // producing an event.
      const named = [
        ...[...src.matchAll(/eventType:\s*'([a-z][a-z0-9_.]+)',(?!\s*version)/g)].map((m) => m[1]),
        ...[...src.matchAll(/\bpublish\(\s*'([a-z][a-z0-9_.]+)'/g)].map((m) => m[1]),
      ];
      for (const m of named.map((t) => [null, t] as unknown as RegExpMatchArray)) {
        const prev = owner.get(m[1]);
        expect(`${m[1]}: one producer`).toBe(`${m[1]}: ${prev && prev !== file ? `ALSO IN ${prev}` : 'one producer'}`);
        owner.set(m[1], file);
      }
    }
    // And the four Clubs names belong to the Clubs producer alone.
    for (const t of ['club.created', 'club.deleted', 'club.lifecycle.changed', 'club.president.invited']) {
      expect(`${t}: ${owner.get(t)}`).toBe(`${t}: clubs.producer.ts`);
    }
  });

  it('adds no source, and the eleven lanes are unchanged', () => {
    const t = pulseTopology();
    expect(t.sources).toEqual([
      'Clubs', 'Users', 'Players', 'Training', 'Matches', 'Transfers',
      'Coach Market', 'Medical', 'Media', 'AI', 'System',
    ]);
  });
});

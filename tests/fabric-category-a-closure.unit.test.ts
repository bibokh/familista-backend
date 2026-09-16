/**
 * tests/fabric-category-a-closure.unit.test.ts
 *
 * The five events the Remaining Unproduced Events Review classified as
 * "REAL FLOW EXISTS — producer still missing", and the last of them.
 *
 * WHY THEY WERE MISSED, AND WHAT THAT MEANS FOR THIS SUITE
 *
 * All five were registered, all five had a live flow writing rows, and all five
 * were declared silent-by-design on the strength of a comment beside their
 * registration rather than a reading of the code:
 *
 *   · `ai.alert.raised` and `ai.analysis.completed` were said to travel on the
 *     big-data dispatcher. `publishAIAlert` and `publishAIRecommendation` are
 *     called by nothing at all, so that transport had no producer either.
 *   · `camera.stream.started` and `camera.stream.ended` were said to have no
 *     lifecycle in this build, because `vision/event-stream` was judged "a
 *     different thing" from its file name.
 *   · `coach.assignment.changed` was said to have nothing that moves a staff
 *     member within a club. `moveStaffMember` does exactly that.
 *
 * So this suite asserts against the CODE and never against a claim about it:
 * each test drives the real service, and the structural tests read the source
 * rather than trusting a comment.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TEAM = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_TEAM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CAMERA = '11111111-2222-4333-8444-555555555555';
const ACTOR = 'u-actor';
const STAFF = 'u-staff';
const PLAYER = 'p-child-0001';

/** What these rows hold that must never leave the modules under test. */
const SECRETS = {
  alertTitle: 'Okonkwo is 38% above his four-week load mean',
  alertMessage: 'Third session this week above threshold; mother reports he is limping at home',
  alertPayload: 'acwr=1.62;player=Tomás Müller-Fernández',
  recommendationContent: 'Withdraw 9 at half time and press higher on the left',
  recommendationTitle: 'Substitute the striker',
  sessionRef: 'FCM-v-BVB-2026-09-16-CAM-EAST-STAND',
  streamMetadata: 'rtsp://cam-east:8554/live?token=abc123',
  teamLabelFrom: 'Under-13 Lions',
  teamLabelTo: 'First Team',
};

const state = {
  alerts: [] as Row[], recommendations: [] as Row[],
  cameras: [] as Row[], streams: [] as Row[],
  memberships: [] as Row[], teams: [] as Row[], engagements: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    if (k === 'NOT') return !match(row, v as Row);
    if (k === 'cameraId_sessionRef') {
      return row.cameraId === (v as Row).cameraId && row.sessionRef === (v as Row).sessionRef;
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== (v as Row).not;
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
  findFirst: async ({ where = {} }: Row = {}) => copy(rows().find((r) => match(r, where)) ?? null),
  findMany: async ({ where = {} }: Row = {}) => copy(rows().filter((r) => match(r, where))),
  count: async ({ where = {} }: Row = {}) => rows().filter((r) => match(r, where)).length,
  create: async ({ data }: Row) => {
    seq += 1;
    const row = { id: `${prefix}-${seq}`, createdAt: new Date(), ...defaults, ...data };
    rows().push(row);
    return copy(row);
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

const db: Row = {
  aIAlert: table(() => state.alerts, 'alert', { severity: 'INFO', status: 'OPEN' }),
  aIRecommendation: table(() => state.recommendations, 'rec', { status: 'OPEN' }),
  camera: table(() => state.cameras, 'cam'),
  eventCameraStream: table(() => state.streams, 'stream', {
    openedAt: new Date(Date.now() - 90_000), closedAt: null,
    packetsTotal: 0n, eventsTotal: 0n,
  }),
  membership: table(() => state.memberships, 'mem'),
  team: table(() => state.teams, 'team'),
  staffEngagement: table(() => state.engagements, 'eng'),
  staffProfile: { updateMany: async () => ({ count: 0 }) },
  user: table(() => [], 'user'),
  eventOutbox: { create: async ({ data }: Row) => data, findMany: async () => [] },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));
jest.mock('../src/realtime/match-channel', () => ({ publish: jest.fn() }));
jest.mock('../src/security/audit-chain.service', () => ({ appendAuditEventAsync: jest.fn() }));
jest.mock('../src/middleware/auth.middleware', () => ({ forgetIdentity: jest.fn() }));

import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { project, sourceLaneFor, destinationLaneFor } from '../src/fabric/pulse/pulse.service';
import { resolveSubjects } from '../src/fabric/pulse/subject-resolver.service';
import { fabricEvent, fabricEvents } from '../src/fabric/registry/event-registry';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import { resetFabricSelfHealth } from '../src/fabric/producers/system.producer';
import { confidenceBand, scopeOf } from '../src/fabric/producers/ai.producer';
import '../src/fabric/producers/clubs.producer';
import '../src/fabric/producers/devices.producer';
import '../src/fabric/producers/coach-market.producer';

import * as aiOps from '../src/services/ai-ops.service';
import * as streams from '../src/vision/event-stream.service';
import * as staffMarket from '../src/staff-market/staff-market.service';

/** The five, in one place, so the scope of this suite is itself a fixture. */
const CATEGORY_A = [
  'ai.alert.raised',
  'ai.analysis.completed',
  'camera.stream.started',
  'camera.stream.ended',
  'coach.assignment.changed',
] as const;

let published: FamilistaEvent[] = [];

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const recording: EventTransport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as EventTransport;

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

beforeEach(() => {
  published = [];
  seq = 0;
  resetFabricSelfHealth();
  setEventTransport(recording);
  state.alerts = [];
  state.recommendations = [];
  state.streams = [];
  state.engagements = [];
  state.cameras = [{ id: CAMERA, clubId: CLUB, status: 'ACTIVE' }];
  state.teams = [
    { id: TEAM, clubId: CLUB, name: SECRETS.teamLabelTo, kind: 'SENIOR', isActive: true },
    { id: OTHER_TEAM, clubId: CLUB, name: SECRETS.teamLabelFrom, kind: 'ACADEMY_U13', isActive: true },
  ];
  state.memberships = [{
    id: 'mem-staff', userId: STAFF, clubId: CLUB, role: 'GOALKEEPING_COACH',
    teamId: OTHER_TEAM, isActive: true, status: 'ACTIVE', joinedAt: new Date(),
  }];
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an AI alert, which was writing rows and telling the fabric nothing', () => {
  const anAlert = (over: Row = {}) => ({
    clubId: CLUB, kind: 'FATIGUE', severity: 'CRITICAL', agent: 'MEDICAL',
    title: SECRETS.alertTitle, message: SECRETS.alertMessage,
    payload: { raw: SECRETS.alertPayload }, playerId: PLAYER,
    matchId: null, teamId: TEAM, ...over,
  });

  it('publishes once, after the row exists, with the classification and nothing else', async () => {
    const row = await aiOps.createAlert(anAlert() as never);
    await settle();

    expect(typesOf()).toEqual(['ai.alert.raised']);
    const e = only('ai.alert.raised')[0];
    expect(e.payload).toEqual({
      alertKind: 'FATIGUE', severity: 'CRITICAL', agent: 'MEDICAL', scope: 'PLAYER',
    });
    expect(e.subjectId).toBe(row.id);
    expect(e.clubId).toBe(CLUB);
    expect(sourceLaneFor('ai.alert.raised')).toBe('AI');
    expect(destinationLaneFor('ai.alert.raised')).toBe('Analytics');
  });

  it('carries no title, no message, no payload and no player', async () => {
    await aiOps.createAlert(anAlert() as never);
    await settle();
    const frames = published.map((e) => project(e));
    await resolveSubjects(frames);
    const surfaces = JSON.stringify({ published, frames });
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(`${name}: absent`).toBe(`${name}: ${surfaces.includes(secret) ? 'LEAKED' : 'absent'}`);
    }
    // A fatigue alert about an identifiable person is a health disclosure, and
    // on an academy squad it is one about a child. Neither the player nor the
    // squad he is in travels.
    expect(surfaces).not.toContain(PLAYER);
    expect(surfaces).not.toContain(TEAM);
    expect(published[0].teamId).toBeNull();
  });

  it('says what the alert is about without saying which one', () => {
    expect(scopeOf({ playerId: PLAYER, teamId: TEAM, matchId: 'm1' })).toBe('PLAYER');
    expect(scopeOf({ playerId: null, teamId: TEAM, matchId: 'm1' })).toBe('TEAM');
    expect(scopeOf({ playerId: null, teamId: null, matchId: 'm1' })).toBe('MATCH');
    expect(scopeOf({ playerId: null, teamId: null, matchId: null })).toBe('CLUB');
  });

  it('truncates a kind somebody typed rather than shipping a sentence', async () => {
    // `AIAlert.kind` is `z.string()` at the route — genuinely unconstrained.
    await aiOps.createAlert(anAlert({ kind: 'He has been limping at home for a fortnight and hid it' }) as never);
    await settle();
    const kind = String((only('ai.alert.raised')[0].payload as Row).alertKind);
    expect(kind.length).toBeLessThanOrEqual(48);
    expect(validateEventPayload('ai.alert.raised', 1, only('ai.alert.raised')[0].payload).ok).toBe(true);
  });

  it('publishes exactly one event per alert, however many are raised', async () => {
    await aiOps.createAlert(anAlert() as never);
    await aiOps.createAlert(anAlert({ kind: 'DISCIPLINE' }) as never);
    await settle();
    expect(published).toHaveLength(2);
    expect(new Set(published.map((e) => e.subjectId)).size).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an AI recommendation', () => {
  const aRec = (over: Row = {}) => ({
    clubId: CLUB, agent: 'TACTICAL', kind: 'SUBSTITUTION',
    title: SECRETS.recommendationTitle,
    content: { text: SECRETS.recommendationContent },
    score: 0.91, playerId: PLAYER, matchId: 'match-1', teamId: TEAM, ...over,
  });

  it('publishes once with the agent, the kind and a confidence BAND', async () => {
    await aiOps.createRecommendation(aRec() as never);
    await settle();

    expect(typesOf()).toEqual(['ai.analysis.completed']);
    expect(only('ai.analysis.completed')[0].payload).toEqual({
      analysisKind: 'SUBSTITUTION', agent: 'TACTICAL', scope: 'PLAYER', confidence: 'HIGH',
    });
  });

  it('never carries the recommendation itself', async () => {
    await aiOps.createRecommendation(aRec() as never);
    await settle();
    const surfaces = JSON.stringify(published);
    expect(surfaces).not.toContain(SECRETS.recommendationContent);
    expect(surfaces).not.toContain(SECRETS.recommendationTitle);
    expect(surfaces).not.toContain(PLAYER);
    // A precise confidence beside a named player is a judgement about a person.
    expect(surfaces).not.toContain('0.91');
  });

  it('bands a score, and admits when a model gave none', () => {
    expect(confidenceBand(0.1)).toBe('LOW');
    expect(confidenceBand(0.5)).toBe('MEDIUM');
    expect(confidenceBand(0.99)).toBe('HIGH');
    expect(confidenceBand(null)).toBeNull();
    expect(confidenceBand(undefined)).toBeNull();
    expect(confidenceBand(Number.NaN)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a camera capture stream', () => {
  const open = () => streams.openStream(
    { userId: ACTOR, clubId: CLUB, role: 'ANALYST' } as never,
    { cameraId: CAMERA, sessionRef: SECRETS.sessionRef, matchId: 'match-1', metadata: { url: SECRETS.streamMetadata } } as never,
  );

  it('publishes once when a stream really opens', async () => {
    const row = await open();
    await settle();

    expect(typesOf()).toEqual(['camera.stream.started']);
    expect(only('camera.stream.started')[0].payload).toEqual({
      status: 'ACTIVE', attachedTo: 'MATCH', metadataDeclared: true,
    });
    expect(only('camera.stream.started')[0].subjectId).toBe(row.id);
    expect(sourceLaneFor('camera.stream.started')).toBe('System');
  });

  it('reopening the same camera and session is not a second opening', async () => {
    const first = await open();
    published = [];
    const again = await open();
    await settle();
    // The service hands back the existing row untouched on the compound unique.
    expect(again.id).toBe(first.id);
    expect(published).toEqual([]);
  });

  it('publishes once on close, with a duration and the totals it carried', async () => {
    const row = await open();
    published = [];
    await streams.closeStream({ userId: ACTOR, clubId: CLUB, role: 'ANALYST' } as never, row.id);
    await streams.closeStream({ userId: ACTOR, clubId: CLUB, role: 'ANALYST' } as never, row.id);
    await settle();

    // Twice called, once announced: the `closedAt` guard means a second close
    // is not a second ending.
    expect(typesOf()).toEqual(['camera.stream.ended']);
    const p = only('camera.stream.ended')[0].payload as Row;
    expect(p.status).toBe('CLOSED');
    expect(p.attachedTo).toBe('MATCH');
    expect(typeof p.durationSeconds === 'number').toBe(true);
    expect(p.packetsTotal).toBe(0);
    expect(p.eventsTotal).toBe(0);
  });

  it('never carries the session reference, the metadata or the camera', async () => {
    const row = await open();
    published = [];
    await streams.closeStream({ userId: ACTOR, clubId: CLUB, role: 'ANALYST' } as never, row.id);
    await settle();
    const frames = published.map((e) => project(e));
    await resolveSubjects(frames);
    const surfaces = JSON.stringify({ published, frames });
    expect(surfaces).not.toContain(SECRETS.sessionRef);
    expect(surfaces).not.toContain(SECRETS.streamMetadata);
    expect(surfaces).not.toContain(CAMERA);
    // `CAMERA` is not a safe subject kind, so the id is withheld from the frame.
    for (const frame of frames) expect(frame.subjectId).toBeNull();
  });

  it('a refused open publishes nothing', async () => {
    state.cameras = [{ id: CAMERA, clubId: CLUB, status: 'RETIRED' }];
    await expect(open()).rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('a close of a stream in another club publishes nothing', async () => {
    const row = await open();
    published = [];
    await expect(streams.closeStream(
      { userId: ACTOR, clubId: 'another-club', role: 'ANALYST' } as never, row.id,
    )).rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a staff member moved to a different job in the same club', () => {
  const move = (dto: Row) => staffMarket.moveStaffMember(
    { userId: ACTOR, clubId: CLUB } as never, STAFF, dto as never,
  );

  beforeEach(() => {
    state.engagements = [{
      id: 'eng-1', userId: STAFF, clubId: CLUB, role: 'GOALKEEPING_COACH',
      teamLabel: SECRETS.teamLabelFrom, isActive: true, startedAt: new Date(),
    }];
  });

  it('publishes once, after the commit, naming the team contexts', async () => {
    await move({ teamId: TEAM });
    await settle();

    expect(typesOf()).toEqual(['coach.assignment.changed']);
    expect(only('coach.assignment.changed')[0].payload).toEqual({
      from: SECRETS.teamLabelFrom,
      to: SECRETS.teamLabelTo,
      staffRole: 'GOALKEEPING_COACH',
      counterpartyClubId: null,
      stage: 'HIRE',
    });
    expect(sourceLaneFor('coach.assignment.changed')).toBe('Coach Market');
    expect(destinationLaneFor('coach.assignment.changed')).toBe('Operational Data');
  });

  it('is one event for three writes — the membership and two engagements', async () => {
    await move({ teamId: TEAM, role: 'ANALYST' });
    await settle();
    // A role change AND a team change in one request is one reassignment.
    expect(published).toHaveLength(1);
    expect((only('coach.assignment.changed')[0].payload as Row).staffRole).toBe('ANALYST');
  });

  it('a move that moves nothing publishes nothing', async () => {
    const out = await move({ teamId: OTHER_TEAM });
    await settle();
    expect(out).toEqual({ staffUserId: STAFF, moved: false });
    expect(published).toEqual([]);
  });

  it('a move to another club’s team is refused and publishes nothing', async () => {
    state.teams.push({ id: 'foreign-team', clubId: 'another-club', name: 'Not Ours', isActive: true });
    await expect(move({ teamId: 'foreign-team' })).rejects.toThrow();
    await settle();
    expect(published).toEqual([]);
  });

  it('reaches the board without the person, and never carries a team id at all', async () => {
    await move({ teamId: TEAM });
    await settle();
    const frames = published.map((e) => project(e));
    await resolveSubjects(frames);

    // The staff id is on the ENVELOPE, as it is on every `coach.*` event: the
    // envelope is the audit record, read through a service that authorises the
    // read. The guarantee is about the FRAME, which is the board, and there
    // `STAFF` is not a safe subject kind — no id, and no name resolved onto it.
    expect(published[0].subjectId).toBe(STAFF);
    for (const frame of frames) {
      expect(frame.subjectId).toBeNull();
      expect(frame.subjectLabel).toBeNull();
    }
    expect(JSON.stringify(frames)).not.toContain(STAFF);

    // A team id is on neither. Which squad a coach was moved between is which
    // children he works with, and the payload names contexts rather than rows.
    const surfaces = JSON.stringify({ published, frames });
    expect(surfaces).not.toContain(TEAM);
    expect(surfaces).not.toContain(OTHER_TEAM);
    expect(published[0].teamId).toBeNull();
  });

  it('does not borrow a name that already means something else', async () => {
    await move({ teamId: TEAM, role: 'ANALYST' });
    await settle();
    // A reassignment is not a hire, not an offer and not a membership grant.
    for (const other of ['coach.hired', 'coach.offer.accepted', 'membership.changed', 'access.role.changed']) {
      expect(`${other}: not published`).toBe(`${other}: ${typesOf().includes(other) ? 'PUBLISHED' : 'not published'}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a broken fabric never breaks any of the five', () => {
  beforeEach(() => setEventTransport(broken));

  it('every one of the five flows still succeeds when every append throws', async () => {
    await expect(aiOps.createAlert({ clubId: CLUB, kind: 'FATIGUE' } as never)).resolves.toBeTruthy();
    await expect(aiOps.createRecommendation({
      clubId: CLUB, agent: 'TACTICAL', kind: 'REST', content: {},
    } as never)).resolves.toBeTruthy();

    const row = await streams.openStream(
      { userId: ACTOR, clubId: CLUB, role: 'ANALYST' } as never,
      { cameraId: CAMERA, sessionRef: 'ref-1' } as never,
    );
    expect(row.id).toBeTruthy();
    await expect(streams.closeStream(
      { userId: ACTOR, clubId: CLUB, role: 'ANALYST' } as never, row.id,
    )).resolves.toBeTruthy();

    state.engagements = [{
      id: 'eng-1', userId: STAFF, clubId: CLUB, role: 'GOALKEEPING_COACH',
      teamLabel: SECRETS.teamLabelFrom, isActive: true, startedAt: new Date(),
    }];
    await expect(staffMarket.moveStaffMember(
      { userId: ACTOR, clubId: CLUB } as never, STAFF, { teamId: TEAM } as never,
    )).resolves.toMatchObject({ moved: true });

    await settle();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the catalogue after the closure', () => {
  it('all five are produced, and each kept its registered source and entity', () => {
    const expected: Record<string, [string, string]> = {
      'ai.alert.raised': ['ai', 'MODEL'],
      'ai.analysis.completed': ['ai', 'MODEL'],
      'camera.stream.started': ['system', 'CAMERA'],
      'camera.stream.ended': ['system', 'CAMERA'],
      'coach.assignment.changed': ['coach-market', 'STAFF'],
    };
    for (const t of CATEGORY_A) {
      const spec = fabricEvent(t)!;
      expect(`${t} produced: ${spec.produced}`).toBe(`${t} produced: true`);
      expect(`${t} source: ${spec.source}`).toBe(`${t} source: ${expected[t][0]}`);
      expect(`${t} entity: ${spec.entityType}`).toBe(`${t} entity: ${expected[t][1]}`);
      expect(`${t} version: ${spec.schemaVersion}`).toBe(`${t} version: 1`);
      // Every one now has a strict schema, so an unknown key quarantines.
      expect(validateEventPayload(t, 1, null).ok).toBe(false);
      expect(validateEventPayload(t, 1, { nonsense: true }).ok).toBe(false);
    }
  });

  it('the two legacy mappings survive, so a reader of either name finds the other', () => {
    expect(fabricEvent('ai.alert.raised')?.legacyKind).toBe('AI_ALERT');
    expect(fabricEvent('ai.analysis.completed')?.legacyKind).toBe('AI_RECOMMENDATION');
  });

  it('no new event name was invented for any of the five', () => {
    // The contracts were valid; only their producers were missing. Anything
    // like `ai.alert.created` or `camera.stream.opened` would be a second name
    // for a fact that already has one.
    for (const invented of [
      'ai.alert.created', 'ai.recommendation.created', 'camera.stream.opened',
      'camera.stream.closed', 'coach.team.changed', 'staff.assignment.changed',
    ]) {
      expect(`${invented}: ${!!fabricEvent(invented)}`).toBe(`${invented}: false`);
    }
  });

  it('adds no source, and the eleven lanes are unchanged', () => {
    const { pulseTopology } = require('../src/fabric') as typeof import('../src/fabric');
    expect(pulseTopology().sources).toEqual([
      'Clubs', 'Users', 'Players', 'Training', 'Matches', 'Transfers',
      'Coach Market', 'Medical', 'Media', 'AI', 'System',
    ]);
  });

  it('the board needed no edit to draw any of them', () => {
    const ui = decomment(read('public/data-pulse.js'));
    for (const t of CATEGORY_A) {
      expect(`${t} in the interface: ${ui.includes(t)}`).toBe(`${t} in the interface: false`);
    }
    const { pulseTopology } = require('../src/fabric') as typeof import('../src/fabric');
    const live = new Set(pulseTopology().instrumented.map((i) => i.eventType));
    for (const t of CATEGORY_A) {
      expect(`${t}: instrumented`).toBe(`${t}: ${live.has(t) ? 'instrumented' : 'IN GAP LIST'}`);
    }
  });

  it('every one of the five publishes below its own write', () => {
    const cases: Array<[string, string, string, string]> = [
      ['src/services/ai-ops.service.ts', 'export async function createAlert', 'prisma.aIAlert.create(', 'publishAIAlertRaised('],
      ['src/services/ai-ops.service.ts', 'export async function createRecommendation', 'prisma.aIRecommendation.create(', 'publishAIAnalysisCompleted('],
      ['src/vision/event-stream.service.ts', 'export async function openStream', 'prisma.eventCameraStream.create(', 'publishCameraStreamStarted('],
      ['src/vision/event-stream.service.ts', 'export async function closeStream', 'prisma.eventCameraStream.update(', 'publishCameraStreamEnded('],
      ['src/staff-market/staff-market.service.ts', 'export async function moveStaffMember', 'prisma.$transaction(', 'publishCoachAssignmentChanged('],
    ];
    for (const [file, fn, write, publish] of cases) {
      const src = decomment(read(file));
      const start = src.indexOf(fn);
      expect(`${fn}: found`).toBe(`${fn}: ${start >= 0 ? 'found' : 'MISSING'}`);
      const next = src.indexOf('\nexport ', start + 10);
      const body = src.slice(start, next >= 0 ? next : undefined);
      const w = body.indexOf(write);
      const p = body.indexOf(publish);
      expect(`${fn}/${publish}: after the write`).toBe(
        `${fn}/${publish}: ${w >= 0 && p > w ? 'after the write' : 'BEFORE THE WRITE'}`,
      );
      // One publish statement per flow.
      expect(body.match(new RegExp(publish.replace('(', '\\('), 'g')) ?? []).toHaveLength(1);
    }
  });

  it('no event type is published from two different producer files', () => {
    const dir = path.join(ROOT, 'src', 'fabric', 'producers');
    const owner = new Map<string, string>();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = decomment(fs.readFileSync(path.join(dir, file), 'utf8'));
      const named = [
        ...[...src.matchAll(/eventType:\s*'([a-z][a-z0-9_.]+)',(?!\s*version)/g)].map((m) => m[1]),
        ...[...src.matchAll(/\bpublish\w*\(\s*'([a-z][a-z0-9_.]+)'/g)].map((m) => m[1]),
      ];
      for (const t of named) {
        const prev = owner.get(t);
        expect(`${t}: one producer`).toBe(`${t}: ${prev && prev !== file ? `ALSO IN ${prev}` : 'one producer'}`);
        owner.set(t, file);
      }
    }
  });

  it('no producer publishes a name the registry does not know', () => {
    const known = new Set(fabricEvents().map((e) => e.type));
    const dir = path.join(ROOT, 'src', 'fabric', 'producers');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = decomment(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const m of src.matchAll(/eventType:\s*'([a-z][a-z0-9_.]+)',(?!\s*version)/g)) {
        expect(`${file} ${m[1]}: registered`).toBe(`${file} ${m[1]}: ${known.has(m[1]) ? 'registered' : 'UNREGISTERED'}`);
      }
    }
  });
});

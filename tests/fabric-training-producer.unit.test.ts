/**
 * tests/fabric-training-producer.unit.test.ts
 *
 * The Training domain as a Data Fabric producer, and the location bug the
 * migration uncovered.
 *
 * FOUR PROPERTIES.
 *
 * ONE — A LOCATION THAT IS SET STAYS SET. `updateTrainingSession` silently
 * discarded `location` behind a workaround for a Prisma Client that predated
 * the column's own migration. Both create paths had been writing the field
 * successfully for as long as the workaround stood, which is the proof it had
 * outlived its cause. `training.location.changed` cannot be produced honestly
 * while a venue move is a no-op, so the bug is fixed here and pinned below.
 *
 * TWO — ONE ACTION, ONE SET OF EVENTS. `completeSession` calls `savePerformance`
 * on its way to `completed`, and `savePerformance` moves the session through
 * `in_progress`. Publishing from both would put two status events on the board
 * for one thing the coach did. Asserted on the EXACT SET, never on membership.
 *
 * THREE — NOTHING ABOUT A CHILD TRAVELS. A session carries a venue, a coach's
 * description, a closing note and a roster; its attendance records carry a mark
 * and a free-text reason per child. The tests drive the REAL service with all
 * of it populated and then search every event and every frame for every value.
 * The venue is the sharpest case: an address plus a scheduled time is where a
 * named squad of children will physically be.
 *
 * FOUR — ACADEMY AND FIRST TEAM ARE ONE SOURCE, TOLD APART. Both land on the
 * Training lane; `teamKind` carries `ACADEMY_U17` or `SENIOR`, which is also
 * where the age group comes from.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUB = '22222222-2222-4222-8222-222222222222';
const SENIOR_TEAM = '33333333-3333-4333-8333-333333333333';
const ACADEMY_TEAM = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const ACTOR = 'u-actor';
const P1 = 'p-1';
const P2 = 'p-2';
const P3 = 'p-3';

/** Everything on a session or an attendance record that must never travel. */
const SECRETS = {
  venue: 'Bramall Lane, Sheffield S2 4SU',
  newVenue: '14 Church Road, Manchester M20 6RQ',
  description: 'Small-sided work; keep Tomás off contact drills',
  coachNote: 'Discussed his parents’ separation with the safeguarding lead',
  absenceReason: 'Hospital appointment — cardiology follow-up',
  title: 'U17 recovery — post-injury group',
};

const state = { sessions: [] as Row[], teams: [] as Row[], players: [] as Row[], stats: [] as Row[], attendance: [] as Row[] };

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== (v as Row).not;
    }
    return row[k] === v;
  });

const copy = <T>(row: T): T => (row == null ? row : JSON.parse(JSON.stringify(row)) as T);

const withStats = (session: Row): Row => ({
  ...session,
  playerStats: state.stats
    .filter((s) => s.sessionId === session.id)
    .map((s) => ({ ...s, player: state.players.find((p) => p.id === s.playerId) ?? null })),
});

const db: Row = {
  trainingSession: {
    findUnique: async ({ where }: Row) => {
      const s = state.sessions.find((x) => x.id === where.id);
      return s ? copy(withStats(s)) : null;
    },
    findMany: async ({ where = {} }: Row = {}) => copy(state.sessions.filter((s) => match(s, where)).map(withStats)),
    count: async ({ where = {} }: Row = {}) => state.sessions.filter((s) => match(s, where)).length,
    create: async ({ data }: Row) => {
      const { playerStats, ...rest } = data;
      const row = { id: `s-${state.sessions.length + 1}`, status: 'planned', teamId: null, ...rest };
      state.sessions.push(row);
      for (const ps of playerStats?.create ?? []) state.stats.push({ sessionId: row.id, ...ps });
      return copy(withStats(row));
    },
    update: async ({ where, data }: Row) => {
      const s = state.sessions.find((x) => x.id === where.id)!;
      Object.assign(s, data);
      return copy(s);
    },
    updateMany: async ({ where, data }: Row) => {
      const hits = state.sessions.filter((s) => match(s, where));
      for (const s of hits) Object.assign(s, data);
      return { count: hits.length };
    },
    delete: async ({ where }: Row) => {
      const i = state.sessions.findIndex((x) => x.id === where.id);
      return i >= 0 ? copy(state.sessions.splice(i, 1)[0]) : null;
    },
  },
  team: { findUnique: async ({ where }: Row) => copy(state.teams.find((t) => t.id === where.id) ?? null) },
  player: {
    findMany: async ({ where = {} }: Row = {}) => copy(state.players.filter((p) => match(p, where))),
    findUnique: async ({ where }: Row) => copy(state.players.find((p) => p.id === where.id) ?? null),
  },
  playerTrainingStat: {
    deleteMany: async ({ where }: Row) => {
      const before = state.stats.length;
      state.stats = state.stats.filter((s) => !match(s, where));
      return { count: before - state.stats.length };
    },
    createMany: async ({ data }: Row) => { state.stats.push(...data); return { count: data.length }; },
    upsert: async ({ where, create, update }: Row) => {
      const k = where.sessionId_playerId ?? {};
      const hit = state.stats.find((s) => s.sessionId === k.sessionId && s.playerId === k.playerId);
      if (hit) { Object.assign(hit, update); return copy(hit); }
      state.stats.push({ ...create }); return copy(create);
    },
    findMany: async ({ where = {} }: Row = {}) => copy(state.stats.filter((s) => match(s, where))),
  },
  trainingAttendanceRecord: {
    upsert: async ({ where, create, update }: Row) => {
      const k = where.trainingSessionId_playerId ?? {};
      const hit = state.attendance.find(
        (a) => a.trainingSessionId === k.trainingSessionId && a.playerId === k.playerId,
      );
      if (hit) { Object.assign(hit, update); return copy(hit); }
      state.attendance.push({ ...create }); return copy(create);
    },
    findMany: async ({ where = {} }: Row = {}) => copy(state.attendance.filter((a) => match(a, where))),
  },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
// Every source the platform registers at boot, so a lane assertion below
// describes the real board rather than whichever producers this file
// happened to import.
import '../src/fabric/producers/coach-market.producer';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { project, sourceLaneFor, pulseTopology } from '../src/fabric/pulse/pulse.service';
import { fabricEvent, fabricEventsForSource, isRegisteredEventType } from '../src/fabric/registry/event-registry';
import { sourceLanes, visibleFabricSources } from '../src/fabric/registry/source-registry';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import { registryHealth, resetRegistryHealth } from '../src/fabric/registry/unknown-events';
import '../src/fabric/producers/training.producer';

import * as training from '../src/services/training.service';

let published: FamilistaEvent[] = [];

/** Publishing is detached and resolves a team kind on the way; drain properly. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
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

  state.teams = [
    { id: SENIOR_TEAM, clubId: CLUB, kind: 'SENIOR', isActive: true },
    { id: ACADEMY_TEAM, clubId: CLUB, kind: 'ACADEMY_U17', isActive: true },
    { id: 'other-team', clubId: OTHER_CLUB, kind: 'SENIOR', isActive: true },
  ];
  state.players = [P1, P2, P3].map((id) => ({
    id, clubId: CLUB, teamId: SENIOR_TEAM, isActive: true, firstName: 'A', lastName: 'B',
  }));
  state.sessions = [{
    id: SESSION, clubId: CLUB, teamId: SENIOR_TEAM,
    title: SECRETS.title, description: SECRETS.description, location: SECRETS.venue,
    scheduledAt: new Date('2026-10-01T10:00:00Z'), duration: 90, drills: [],
    status: 'planned', coachNote: null,
  }];
  state.stats = [{ sessionId: SESSION, playerId: P1 }, { sessionId: SESSION, playerId: P2 }];
  state.attendance = [];
});

afterEach(async () => { await settle(); });
afterAll(async () => { await settle(); setEventTransport(null); });

const types = () => published.map((e) => e.eventType).sort();
const one = (type: string) => {
  const hits = published.filter((e) => e.eventType === type);
  expect(`${type} count: ${hits.length}`).toBe(`${type} count: 1`);
  return hits[0];
};

// ── the bug ──────────────────────────────────────────────────────────────────

describe('a training session keeps the venue it is given', () => {
  it('writes location on the clean create path', async () => {
    const created = await training.createCleanSession(CLUB, {
      title: 'Session', scheduledAt: '2026-10-02T10:00:00Z', duration: 60,
      location: SECRETS.newVenue, teamId: SENIOR_TEAM,
    } as never);
    expect(created.location).toBe(SECRETS.newVenue);
  });

  it('writes location on the legacy create path', async () => {
    const created = await training.createTrainingSession(CLUB, {
      title: 'Session', scheduledAt: '2026-10-02T10:00:00Z', duration: 60,
      location: SECRETS.newVenue, teamId: SENIOR_TEAM,
    } as never);
    expect(created.location).toBe(SECRETS.newVenue);
  });

  it('PERSISTS a venue move rather than returning 200 and discarding it', async () => {
    // This is the regression. Before the fix the update returned the session
    // unchanged and the caller had no way to tell the value had been dropped.
    const updated = await training.updateTrainingSession(SESSION, CLUB, {
      location: SECRETS.newVenue,
    } as never);
    expect(updated.location).toBe(SECRETS.newVenue);
    expect(state.sessions[0].location).toBe(SECRETS.newVenue);
  });

  it('can clear a venue', async () => {
    await training.updateTrainingSession(SESSION, CLUB, { location: null } as never);
    expect(state.sessions[0].location).toBeNull();
  });

  it('leaves the venue alone when the caller does not mention it', async () => {
    await training.updateTrainingSession(SESSION, CLUB, { title: 'Renamed' } as never);
    expect(state.sessions[0].location).toBe(SECRETS.venue);
  });

  it('no longer carries a note claiming location is not written', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/training.service.ts'), 'utf8');
    expect(src).not.toMatch(/location` intentionally NOT written/);
  });
});

// ── one action, one set of events ────────────────────────────────────────────

describe('a successful Training action publishes exactly the right events', () => {
  it('createCleanSession → session.created, once, with counts and no names', async () => {
    await training.createCleanSession(CLUB, {
      title: 'Session', scheduledAt: '2026-10-02T10:00:00Z', duration: 60,
      teamId: ACADEMY_TEAM, playerIds: [], drills: ['PASSING', 'SHOOTING'],
    } as never);
    await settle();

    expect(types()).toEqual(['training.session.created']);
    const e = one('training.session.created');
    expect(e.payload).toEqual({ players: 0, drills: 2, teamKind: 'ACADEMY_U17' });
    expect(e.subjectType).toBe('TRAINING_SESSION');
    expect(validateEventPayload('training.session.created', 1, e.payload).ok).toBe(true);
  });

  it('createTrainingSession publishes the SAME name, not a second one', async () => {
    await training.createTrainingSession(CLUB, {
      title: 'Session', scheduledAt: '2026-10-02T10:00:00Z', duration: 60,
      teamId: SENIOR_TEAM, playerIds: [P1, P2, P3],
    } as never);
    await settle();

    expect(types()).toEqual(['training.session.created']);
    expect(one('training.session.created').payload).toEqual({
      players: 3, drills: 0, teamKind: 'SENIOR',
    });
  });

  it('an ordinary update is ONE event', async () => {
    await training.updateTrainingSession(SESSION, CLUB, { title: 'Renamed' } as never);
    await settle();

    expect(types()).toEqual(['training.session.updated']);
    expect(one('training.session.updated').payload).toEqual({
      changedFields: ['title'], teamKind: 'SENIOR',
    });
  });

  it('a venue move is the umbrella AND the specific fact', async () => {
    await training.updateTrainingSession(SESSION, CLUB, { location: SECRETS.newVenue } as never);
    await settle();

    expect(types()).toEqual(['training.location.changed', 'training.session.updated']);
    const e = one('training.location.changed');
    expect(e.dataClassification).toBe('RESTRICTED');
    // The name says a venue changed. It does not say to what.
    expect(e.payload).toEqual({ teamKind: 'SENIOR' });
  });

  it('resending the SAME venue says nothing about a move', async () => {
    await training.updateTrainingSession(SESSION, CLUB, { location: SECRETS.venue } as never);
    await settle();
    expect(types()).toEqual(['training.session.updated']);
  });

  it('a roster change reports counts in each direction', async () => {
    // Was [P1, P2]; becomes [P2, P3] — one in, one out.
    await training.updateTrainingSession(SESSION, CLUB, { playerIds: [P2, P3] } as never);
    await settle();

    expect(types()).toEqual([
      'training.player.added', 'training.player.removed', 'training.session.updated',
    ]);
    expect(one('training.player.added').payload).toEqual({ count: 1, teamKind: 'SENIOR' });
    expect(one('training.player.removed').payload).toEqual({ count: 1, teamKind: 'SENIOR' });
  });

  it('a roster change in one direction only publishes that direction', async () => {
    await training.updateTrainingSession(SESSION, CLUB, { playerIds: [P1, P2, P3] } as never);
    await settle();
    expect(types()).toEqual(['training.player.added', 'training.session.updated']);
    expect(one('training.player.added').payload).toMatchObject({ count: 1 });
  });

  it('deleteTrainingSession → session.deleted, once', async () => {
    await training.deleteTrainingSession(SESSION, CLUB);
    await settle();
    expect(types()).toEqual(['training.session.deleted']);
    expect(one('training.session.deleted').payload).toEqual({ teamKind: 'SENIOR' });
    expect(state.sessions).toHaveLength(0);
  });

  it('setTrainingAttendance → attendance.saved, with a COUNT and nothing else', async () => {
    await training.setTrainingAttendance(SESSION, CLUB, ACTOR, [
      { playerId: P1, mark: 'PRESENT' },
      { playerId: P2, mark: 'ABSENT', notes: SECRETS.absenceReason },
    ] as never);
    await settle();

    expect(types()).toEqual(['training.attendance.saved']);
    const e = one('training.attendance.saved');
    expect(e.dataClassification).toBe('RESTRICTED');
    expect(e.payload).toEqual({ marked: 2, teamKind: 'SENIOR' });
    // The reason was written to the record and reached no event.
    expect(state.attendance.find((a) => a.playerId === P2)?.notes).toBe(SECRETS.absenceReason);
    expect(JSON.stringify(published)).not.toContain('cardiology');
  });

  it('savePerformance called directly announces the status it moved', async () => {
    await training.savePerformance(SESSION, CLUB, [{ playerId: P1, rating: 7 }] as never);
    await settle();

    expect(types()).toEqual(['training.status.changed']);
    expect(one('training.status.changed').payload).toEqual({
      from: 'planned', to: 'in_progress', teamKind: 'SENIOR',
    });
  });

  it('savePerformance on a session already started says nothing', async () => {
    state.sessions[0].status = 'in_progress';
    await training.savePerformance(SESSION, CLUB, [{ playerId: P1, rating: 7 }] as never);
    await settle();
    expect(published).toHaveLength(0);
  });
});

// ── the duplicate-publish trap ───────────────────────────────────────────────

describe('one coach action is one status event', () => {
  it('completeSession WITH performance publishes exactly one status event', async () => {
    // `completeSession` calls `savePerformance`, which moves planned →
    // in_progress on its way. Two events here would be one action reported
    // twice — the exact thing rule 7 guards against.
    await training.completeSession(SESSION, CLUB, {
      sessionRating: 8, coachNote: SECRETS.coachNote,
      performance: [{ playerId: P1, rating: 7 }],
    } as never);
    await settle();

    expect(types()).toEqual(['training.status.changed']);
    expect(one('training.status.changed').payload).toEqual({
      from: 'planned', to: 'completed', teamKind: 'SENIOR',
    });
  });

  it('completeSession WITHOUT performance publishes the same single event', async () => {
    await training.completeSession(SESSION, CLUB, { sessionRating: 8 } as never);
    await settle();
    expect(types()).toEqual(['training.status.changed']);
    expect(one('training.status.changed').payload).toMatchObject({
      from: 'planned', to: 'completed',
    });
  });

  it('reports the status the session really had, not the one it passed through', async () => {
    state.sessions[0].status = 'draft';
    await training.completeSession(SESSION, CLUB, {
      performance: [{ playerId: P1, rating: 7 }],
    } as never);
    await settle();
    expect(one('training.status.changed').payload).toMatchObject({ from: 'draft' });
  });

  it('routes every publish through the one adapter', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/training.service.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const adapter = code.slice(code.indexOf('function emitTrainingEvent('), code.indexOf('export interface CreateTrainingDto'));
    const body = code.slice(code.indexOf("} from '../fabric/producers/training.producer';"));
    expect(body.replace(adapter, '')).not.toMatch(/publishTraining[A-Z]/);
  });

  it('never publishes inside a transaction', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/training.service.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

    let from = 0; let spans = 0;
    while ((from = src.indexOf('$transaction(', from)) !== -1) {
      const open = src.indexOf('{', from);
      let depth = 0; let end = open;
      for (; end < src.length; end += 1) {
        if (src[end] === '{') depth += 1;
        else if (src[end] === '}') { depth -= 1; if (depth === 0) break; }
      }
      expect(`span ${spans}: ${src.slice(open, end).includes('emitTrainingEvent(') ? 'EMIT INSIDE' : 'clean'}`)
        .toBe(`span ${spans}: clean`);
      spans += 1; from = end;
    }
    expect(spans).toBeGreaterThanOrEqual(1);
  });
});

// ── failure publishes nothing ────────────────────────────────────────────────

describe('a Training action that fails publishes no success event', () => {
  it('creating for another club’s team publishes nothing', async () => {
    await expect(training.createCleanSession(CLUB, {
      title: 'x', scheduledAt: '2026-10-02T10:00:00Z', duration: 60, teamId: 'other-team',
    } as never)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('creating with a player outside the squad publishes nothing', async () => {
    await expect(training.createCleanSession(CLUB, {
      title: 'x', scheduledAt: '2026-10-02T10:00:00Z', duration: 60,
      teamId: SENIOR_TEAM, playerIds: ['p-nobody'],
    } as never)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('creating with no club context publishes nothing', async () => {
    await expect(training.createCleanSession('', {
      title: 'x', scheduledAt: '2026-10-02T10:00:00Z', duration: 60,
    } as never)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('updating another club’s session publishes nothing', async () => {
    state.sessions.push({ id: 's-other', clubId: OTHER_CLUB, teamId: null, status: 'planned' });
    await expect(training.updateTrainingSession('s-other', CLUB, { title: 'x' } as never))
      .rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('updating a session that does not exist publishes nothing', async () => {
    await expect(training.updateTrainingSession('s-nope', CLUB, { title: 'x' } as never))
      .rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('deleting another club’s session publishes nothing', async () => {
    state.sessions.push({ id: 's-other', clubId: OTHER_CLUB, teamId: null, status: 'planned' });
    await expect(training.deleteTrainingSession('s-other', CLUB)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('attendance for a player outside the session’s team publishes nothing', async () => {
    await expect(training.setTrainingAttendance(SESSION, CLUB, ACTOR, [
      { playerId: 'p-nobody', mark: 'PRESENT' },
    ] as never)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
    expect(state.attendance).toHaveLength(0);
  });
});

// ── nothing about a child travels ────────────────────────────────────────────

describe('no training secret reaches the fabric or the board', () => {
  async function everything(): Promise<void> {
    await training.updateTrainingSession(SESSION, CLUB, {
      title: SECRETS.title, description: SECRETS.description,
      location: SECRETS.newVenue, playerIds: [P2, P3],
    } as never);
    await training.setTrainingAttendance(SESSION, CLUB, ACTOR, [
      { playerId: P2, mark: 'ABSENT', notes: SECRETS.absenceReason },
    ] as never);
    await training.completeSession(SESSION, CLUB, {
      sessionRating: 8, coachNote: SECRETS.coachNote,
    } as never);
    await settle();
  }

  it('carries no value from the session, the roster or the attendance sheet', async () => {
    await everything();
    expect(published.length).toBeGreaterThan(0);

    const wire = JSON.stringify(published);
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(`${name} in events: ${wire.includes(value)}`).toBe(`${name} in events: false`);
    }
    // And no player identifier, even though a roster change was published.
    for (const pid of [P1, P2, P3]) {
      expect(`${pid} in events: ${wire.includes(pid)}`).toBe(`${pid} in events: false`);
    }
  });

  it('draws frames with no secret in them', async () => {
    await everything();
    for (const event of published) {
      const wire = JSON.stringify(project(event));
      for (const [name, value] of Object.entries(SECRETS)) {
        expect(`${name} in ${event.eventType} frame: ${wire.includes(value)}`)
          .toBe(`${name} in ${event.eventType} frame: false`);
      }
      expect(wire).not.toContain('payload');
    }
  });

  it('DOES let the session id through, because a session is not a person', async () => {
    await everything();
    for (const event of published) {
      expect(`${event.eventType} subjectId: ${project(event).subjectId}`)
        .toBe(`${event.eventType} subjectId: ${SESSION}`);
    }
  });

  it('carries only counts, names and tokens in every payload', async () => {
    await everything();
    for (const event of published) {
      for (const value of Object.values(event.payload as Record<string, unknown>)) {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          if (v === null || typeof v === 'number' || typeof v === 'boolean') continue;
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
    // Strict, so smuggling a venue onto the location event is caught.
    expect(validateEventPayload('training.location.changed', 1, {
      teamKind: 'SENIOR', to: SECRETS.newVenue,
    }).ok).toBe(false);
  });
});

// ── academy and first team ───────────────────────────────────────────────────

describe('Academy and First Team are one source, told apart', () => {
  it('both land on the Training lane', async () => {
    await training.updateTrainingSession(SESSION, CLUB, { title: 'A' } as never);
    state.sessions[0].teamId = ACADEMY_TEAM;
    await training.updateTrainingSession(SESSION, CLUB, { title: 'B' } as never);
    await settle();

    expect(published).toHaveLength(2);
    for (const e of published) expect(project(e).source).toBe('Training');
  });

  it('carries the age group through teamKind', async () => {
    state.sessions[0].teamId = ACADEMY_TEAM;
    await training.updateTrainingSession(SESSION, CLUB, { title: 'B' } as never);
    await settle();
    expect((published[0].payload as Row).teamKind).toBe('ACADEMY_U17');
    expect(published[0].teamId).toBe(ACADEMY_TEAM);
    expect(published[0].clubId).toBe(CLUB);
  });

  it('a club-wide session reports teamKind null rather than guessing', async () => {
    state.sessions[0].teamId = null;
    await training.updateTrainingSession(SESSION, CLUB, { title: 'B' } as never);
    await settle();
    expect((published[0].payload as Row).teamKind).toBeNull();
  });
});

// ── a broken fabric does not break training ──────────────────────────────────

describe('observability cannot break a Training operation', () => {
  it('survives a transport that throws on every append', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('storage is down'); },
      async read() { return []; },
    } as EventTransport);

    const updated = await training.updateTrainingSession(SESSION, CLUB, { title: 'Still works' } as never);
    await settle();
    expect(updated.title).toBe('Still works');
  });

  it('survives a broken transport on an attendance save', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('storage is down'); },
      async read() { return []; },
    } as EventTransport);

    await training.setTrainingAttendance(SESSION, CLUB, ACTOR, [
      { playerId: P1, mark: 'PRESENT' },
    ] as never);
    await settle();
    expect(state.attendance).toHaveLength(1);
  });

  it('survives an unregistered name, and still routes it to Training', async () => {
    const { publishFabricEvent } = require('../src/fabric/registry/publisher');
    const result = await publishFabricEvent({ eventType: 'training.telepathy.detected' });
    expect(result.registered).toBe(false);
    expect(result.stored).toBe(true);
    expect(registryHealth().unknownEventTypes).toContain('training.telepathy.detected');
    expect(sourceLaneFor('training.telepathy.detected')).toBe('Training');
  });

  it('quarantines an invalid payload without failing the caller', async () => {
    const { publishFabricEvent } = require('../src/fabric/registry/publisher');
    const result = await publishFabricEvent({
      eventType: 'training.attendance.saved',
      payload: { marked: 2, teamKind: 'SENIOR', reason: SECRETS.absenceReason },
    });
    expect(result.schema.ok).toBe(false);
    expect(result.quarantined).toBe(true);
    expect(result.stored).toBe(true);
  });
});

// ── the board understands them with no UI change ─────────────────────────────

describe('Live Data Flow recognises the Training types automatically', () => {
  it('marks every produced event registered and routes it to Training', async () => {
    await training.updateTrainingSession(SESSION, CLUB, {
      location: SECRETS.newVenue, playerIds: [P2, P3],
    } as never);
    await settle();

    expect(published.length).toBe(4);
    for (const event of published) {
      const frame = project(event);
      expect(`${event.eventType} registered: ${frame.registered}`).toBe(`${event.eventType} registered: true`);
      expect(`${event.eventType} source: ${frame.source}`).toBe(`${event.eventType} source: Training`);
      expect(frame.destination).toBe('Operational Data');
      expect(frame.status).toBe('STORED');
    }
  });

  it('adds no source card of its own — the board draws the registry’s lanes', () => {
    expect(sourceLanes()).toEqual([
      'Clubs', 'Users', 'Players', 'Training', 'Matches',
      'Transfers', 'Coach Market', 'Medical', 'Media', 'AI', 'System',
    ]);
    expect(visibleFabricSources()).toHaveLength(11);
    expect(pulseTopology().sources).toHaveLength(11);
  });

  it('a NEW Training feature adds no card either', () => {
    const { registerFabricEvent } = require('../src/fabric/registry/event-registry');
    registerFabricEvent({ type: 'training.drill.logged', entityType: 'TRAINING_SESSION' });
    expect(sourceLanes()).toHaveLength(11);
    expect(fabricEvent('training.drill.logged')?.source).toBe('training');
  });

  it('needs no edit to the Live Data Flow page', () => {
    const client = fs.readFileSync(path.join(__dirname, '..', 'public/data-pulse.js'), 'utf8');
    for (const type of [
      'training.session.created', 'training.session.updated', 'training.session.deleted',
      'training.attendance.saved', 'training.location.changed', 'training.status.changed',
      'training.player.added', 'training.player.removed',
    ]) {
      expect(`${type} hard-coded in the page: ${client.includes(type)}`)
        .toBe(`${type} hard-coded in the page: false`);
    }
  });

  it('registers all eight produced types under the training source', () => {
    const all = fabricEventsForSource('training').map((e) => e.type);
    for (const t of [
      'training.session.created', 'training.session.updated', 'training.session.deleted',
      'training.attendance.saved', 'training.location.changed', 'training.status.changed',
      'training.player.added', 'training.player.removed',
    ]) {
      expect(`${t} registered: ${isRegisteredEventType(t)}`).toBe(`${t} registered: true`);
      expect(`${t} under training: ${all.includes(t)}`).toBe(`${t} under training: true`);
      expect(`${t} lane: ${sourceLaneFor(t)}`).toBe(`${t} lane: Training`);
    }
  });
});

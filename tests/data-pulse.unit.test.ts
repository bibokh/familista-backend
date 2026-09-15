/**
 * tests/data-pulse.unit.test.ts
 *
 * Data Pulse — the platform owner watches real events move.
 *
 * WHAT THIS IS GUARDING
 *
 * A live visualiser has two failure modes that are much worse than being ugly,
 * and this file exists for both.
 *
 * The first is FICTION. A screen that animates when nothing happened, reports a
 * throughput it did not measure, or draws a destination that consumes nothing,
 * is not a dashboard — it is a decoration that will be trusted for a decision
 * one day. So the tests assert that a pulse appears only when an event really
 * reached the fabric, that an uncomputable metric comes back as `null` rather
 * than `0`, and that the future lanes are marked as future by the server.
 *
 * The second is LEAKAGE. This is one endpoint that sees every event in every
 * club, so a projection that carried payloads would be a cross-tenant read of
 * everything the platform records, wearing an observability hat. The frame is
 * therefore an allow-list, and the tests feed it an event stuffed with
 * passwords, tokens, HMAC secrets and medical text to prove none of it can come
 * out the other side.
 *
 * The producer half is tested end to end: `updatePlayer` is called against a
 * mocked database, and the assertion is that the canonical event arrives — not
 * that the function was called.
 */

import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

type Row = Record<string, any>;

const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUB = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRESIDENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COACH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PLAYER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TEAM = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const state = {
  outbox: [] as Row[],
  telemetry: [] as Row[],
  players: [] as Row[],
  audits: [] as Row[],
  platformAdmins: [] as Row[],
  /** Clubs as the footprint reads them: a country each, and nothing else. */
  clubs: [] as Row[],
  users: 0,
};

const db: Row = {
  eventOutbox: {
    create: async ({ data }: Row) => {
      if (state.outbox.some((r) => r.idempotencyKey === data.idempotencyKey)) {
        const err: any = new Error('Unique constraint failed'); err.code = 'P2002'; throw err;
      }
      const row = { id: `o-${state.outbox.length + 1}`, createdAt: new Date(), processedAt: null, failedAt: null, ...data };
      state.outbox.push(row);
      return row;
    },
    findMany: async ({ where = {}, orderBy, take, select }: Row = {}) => {
      // The window AND the keyset predicate are honoured here on purpose. A
      // mock that ignored either would make the tail tests pass whatever the
      // service asked for — which is how a wrong cursor or a wrong time column
      // ships.
      const at = (r: Row) => (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt));
      const matchesKeyset = (r: Row, clauses: Row[]) => clauses.some((c) => {
        if (c.createdAt?.gt !== undefined) return at(r) > c.createdAt.gt;
        if (c.createdAt !== undefined && c.id?.gt !== undefined) {
          return at(r).getTime() === (c.createdAt as Date).getTime() && String(r.id) > String(c.id.gt);
        }
        return false;
      });

      let rows = state.outbox.filter((r) => {
        if (where.OR && !matchesKeyset(r, where.OR)) return false;
        if (where.createdAt?.gte && at(r) < where.createdAt.gte) return false;
        if (where.createdAt?.lte && at(r) > where.createdAt.lte) return false;
        return true;
      });

      // `orderBy` arrives as an array for every (createdAt, id) ordering.
      const order = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
      if (order.length) {
        rows = [...rows].sort((a, b) => {
          for (const clause of order) {
            const key = Object.keys(clause)[0];
            const dir = clause[key] === 'desc' ? -1 : 1;
            const av = key === 'createdAt' ? at(a).getTime() : String(a[key]);
            const bv = key === 'createdAt' ? at(b).getTime() : String(b[key]);
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
          }
          return 0;
        });
      }
      if (take) rows = rows.slice(0, take);
      if (select) return rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k] ?? null])));
      return rows;
    },
    count: async ({ where = {} }: Row = {}) => state.outbox.filter((r) => {
      const at = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
      if (where.createdAt?.gte && at < where.createdAt.gte) return false;
      if (where.createdAt?.lte && at > where.createdAt.lte) return false;
      if (where.processedAt?.not === null && !r.processedAt) return false;
      if (where.failedAt?.not === null && !r.failedAt) return false;
      return true;
    }).length,
  },
  // The telemetry table, with the same keyset honesty as the outbox mock — and
  // with the TWO clocks kept apart, because the code now keeps them apart. A
  // mock that collapsed `recordedAt` onto `occurredAt` would pass whichever one
  // the service walked, which is exactly the property that let the live tail
  // walk the wrong one into production.
  analyticsEvent: {
    findMany: async ({ where = {}, orderBy, take, select }: Row = {}) => {
      const when = (r: Row, key: string) => {
        const v = r[key] ?? r.occurredAt;
        return v instanceof Date ? v : new Date(v as string);
      };
      const at = (r: Row) => when(r, 'occurredAt');
      const rec = (r: Row) => when(r, 'recordedAt');
      const keyset = (r: Row, clauses: Row[]) => clauses.some((c) => {
        if (c.recordedAt?.gt !== undefined) return rec(r) > c.recordedAt.gt;
        if (c.recordedAt !== undefined && c.id?.gt !== undefined) {
          return rec(r).getTime() === (c.recordedAt as Date).getTime() && String(r.id) > String(c.id.gt);
        }
        return false;
      });
      let rows = state.telemetry.filter((r) => {
        if (where.OR && !keyset(r, where.OR)) return false;
        if (where.occurredAt?.gte && at(r) < where.occurredAt.gte) return false;
        if (where.occurredAt?.lte && at(r) > where.occurredAt.lte) return false;
        return true;
      });
      const order = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
      if (order.length) {
        rows = [...rows].sort((a, b) => {
          for (const clause of order) {
            const key = Object.keys(clause)[0];
            const dir = clause[key] === 'desc' ? -1 : 1;
            const timeKey = key === 'occurredAt' || key === 'recordedAt';
            const av = timeKey ? when(a, key).getTime() : String(a[key]);
            const bv = timeKey ? when(b, key).getTime() : String(b[key]);
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
          }
          return 0;
        });
      }
      if (take) rows = rows.slice(0, take);
      if (select) return rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k] ?? null])));
      return rows;
    },
  },
  player: {
    findFirst: async ({ where }: Row) => state.players.find((p) =>
      p.id === where.id && (!where.clubId || p.clubId === where.clubId)) ?? null,
    findUnique: async ({ where }: Row) => state.players.find((p) => p.id === where.id) ?? null,
    findMany: async ({ where = {}, select }: Row = {}) => state.players
      .filter((p) => (where.id?.in ?? []).includes(p.id))
      .map((p) => (select
        ? Object.fromEntries(Object.keys(select).map((k) => [k, p[k] ?? null]))
        : p)),
    update: async ({ where, data }: Row) => {
      const p = state.players.find((r) => r.id === where.id) as Row;
      Object.assign(p, data);
      return p;
    },
  },
  playerAuditLog: { create: async ({ data }: Row) => { state.audits.push(data); return data; } },
  team: {
    findUnique: async ({ where }: Row) => ({ id: where.id, clubId: CLUB, isActive: true }),
    findMany: async ({ where = {} }: Row = {}) =>
      (where.id?.in ?? []).map((id: string) => ({ id, name: 'First Team' })),
  },
  // The resolver's two reads. `select`ed narrowly by the service; the mock
  // returns only what that select names, so a test cannot accidentally prove a
  // wider read is safe.
  club: {
    findMany: async ({ where = {} }: Row = {}) => (where.id?.in ?? [])
      .filter((id: string) => id === CLUB || id === OTHER_CLUB)
      .map((id: string) => ({ id, name: id === CLUB ? 'FC Familista' : 'Other Club' })),
    // The footprint's one read. Grouped the way Prisma groups, so a test cannot
    // prove a shape the service will not actually receive.
    groupBy: async ({ by }: Row) => {
      if (!Array.isArray(by) || by[0] !== 'country') throw new Error('unexpected groupBy');
      const counts = new Map<string, number>();
      for (const c of state.clubs) counts.set(c.country, (counts.get(c.country) ?? 0) + 1);
      return [...counts].map(([country, n]) => ({ country, _count: { _all: n } }));
    },
  },
  platformAdmin: {
    findUnique: async ({ where }: Row) =>
      state.platformAdmins.find((a) => a.userId === where.userId && a.isActive) ?? null,
  },
  user: { findUnique: async () => null, count: async () => state.users },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

const logged: string[] = [];
jest.mock('../src/utils/logger', () => ({
  logger: {
    warn: (...a: unknown[]) => { logged.push(JSON.stringify(a)); },
    error: (...a: unknown[]) => { logged.push(JSON.stringify(a)); },
    info: (...a: unknown[]) => { logged.push(JSON.stringify(a)); },
    debug: (...a: unknown[]) => { logged.push(JSON.stringify(a)); },
  },
}));

/** Whoever the current test says is calling. */
let actingAs: Row | null = null;
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req: Row, res: Row, next: () => void) => {
    if (!actingAs) { res.status(401).json({ success: false, message: 'unauthenticated' }); return; }
    req.user = actingAs;
    next();
  },
}));

import {
  emit, setEventTransport, outboxTransport, clearSubscribers,
  startPulse, stopPulse, resetPulse, onPulse, recentFrames, flushNow,
  pulseMetrics, pulseTopology, project,
  SOURCE_LANES, LIVE_DESTINATIONS, FUTURE_DESTINATIONS, INSTRUMENTED_EVENT_TYPES,
  SAMPLE_THRESHOLD, BUFFER_LIMIT,
  replayWindow, replayCounts, eventFromRow, currentTransport,
  tailStep, tailAfter, latestCursor, formatCursor, parseCursor, TAIL_BATCH, ingestFrames,
  framesFromRows,
  telemetryStep, latestTelemetryCursor, formatTelemetryCursor, parseTelemetryCursor,
  telemetryCategory, frameFromTelemetryRow, activeCounts,
  ecosystemFootprint, placeCountry, resetEcosystemCache,
  type FamilistaEvent, type PulseFrame,
} from '../src/fabric';
import { updatePlayer } from '../src/services/player.service';
import dataPulseRoutes from '../src/routes/data-pulse.routes';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/system/data-pulse', dataPulseRoutes);
  a.use((err: Row, _req: Row, res: Row, _next: unknown) => {
    res.status(err?.statusCode || err?.status || 500).json({ success: false, message: err?.message });
  });
  return a;
}

/** A player as the database would hold one, complete with the sensitive parts. */
const aPlayer = () => ({
  id: PLAYER, clubId: CLUB, teamId: TEAM,
  firstName: 'Amara', lastName: 'Okonkwo', number: 9, position: 'ST',
  dateOfBirth: new Date('2007-04-12'), avatar: null,
  email: 'amara@example.test', parentName: 'N. Okonkwo',
  parentEmail: 'parent@example.test', parentPhone: '+49 30 000000',
  medicalStatus: 'FIT', paymentStatus: 'PAID', isActive: true,
  notes: 'Recovering from a hamstring strain; see the club physio report.',
  nationality: 'NG', flag: '🇳🇬', height: 181, weight: 74,
  preferredFoot: 'RIGHT', overallRating: 72, potential: 86,
  marketValue: 250000, weeklyWage: 900, contractUntil: null,
  condition: 92, isInjured: false, joinedAt: new Date('2024-07-01'),
});

beforeEach(() => {
  state.outbox = [];
  state.telemetry = [];
  state.players = [aPlayer()];
  state.audits = [];
  state.platformAdmins = [{ userId: OWNER, isActive: true }];
  state.clubs = [];
  state.users = 0;
  resetEcosystemCache();
  logged.length = 0;
  actingAs = null;
  clearSubscribers();
  resetPulse();
  setEventTransport(outboxTransport);
  startPulse();
  // Live starts from the beginning of time in tests, so a test's own emits are
  // visible without having to seed a cursor first.
  liveCursor = { createdAt: new Date(0), id: '' };
});

afterAll(() => {
  resetPulse();
  setEventTransport(null);
  clearSubscribers();
});

/** Project one outbox row exactly as the replay path does. */
function replayProjection(row: Row): PulseFrame {
  const event = eventFromRow(row as never);
  if (!event) throw new Error('the row did not parse as a fabric envelope');
  return project(event);
}

/** Let the fabric's async emit reach the outbox. */
async function settle() {
  await new Promise((r) => setImmediate(r));
  flushNow();
}

/**
 * Drive one Live cycle the way the SSE route does.
 *
 * Live is no longer the in-process bus, so a test that emits and waits for a
 * subscriber is testing a mechanism that no longer exists. This tails the
 * outbox from a cursor, ingests what it finds, and returns the fresh frames —
 * exactly the loop in `data-pulse.routes.ts`.
 */
let liveCursor: Awaited<ReturnType<typeof latestCursor>> = null;

async function liveTick(): Promise<PulseFrame[]> {
  await settle();
  const step = await tailStep(liveCursor ?? { createdAt: new Date(0), id: '' });
  liveCursor = step.cursor;
  const fresh = ingestFrames(step.frames);
  flushNow();
  return fresh;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · A real action produces a real flow
// ─────────────────────────────────────────────────────────────────────────────

describe('a real platform action reaches the owner stream', () => {
  test('updating a player produces a canonical event and one pulse frame', async () => {
    await updatePlayer(
      { userId: PRESIDENT, clubId: CLUB },
      PLAYER,
      { position: 'CF', overallRating: 74 } as never,
    );
    // Through the OUTBOX, not the bus — which is what production does across
    // instances, and what the previous version of this test could not prove.
    const frames = await liveTick();

    // The event exists, is the canonical envelope, and is the one the taxonomy
    // registers — not a string invented at the call site.
    const types = frames.map((f) => f.eventType);
    expect(types).toContain('player.updated');

    const frame = frames.find((f) => f.eventType === 'player.updated')!;
    expect(frame.clubId).toBe(CLUB);
    expect(frame.teamId).toBe(TEAM);
    expect(frame.subjectType).toBe('PLAYER');
    expect(frame.registered).toBe(true);
    expect(frame.status).toBe('STORED');

    // And it is drawn along a real path: Players → the fabric → Operational Data.
    expect(frame.source).toBe('Players');
    expect(frame.destination).toBe('Operational Data');
    expect(LIVE_DESTINATIONS).toContain(frame.destination);
  });

  test('attaching a photograph is its own event, at its own sensitivity', async () => {
    await updatePlayer({ userId: PRESIDENT, clubId: CLUB }, PLAYER, { avatar: 'media:abc123' } as never);
    const frames = await liveTick();

    const types = frames.map((f) => f.eventType);
    expect(types).toContain('player.updated');
    expect(types).toContain('player.photo.attached');

    // A photograph is RESTRICTED where an ordinary update is CONFIDENTIAL, so a
    // consumer can tell them apart without opening either.
    const photo = frames.find((f) => f.eventType === 'player.photo.attached')!;
    expect(photo.dataClassification).toBe('RESTRICTED');
    expect(frames.find((f) => f.eventType === 'player.updated')!.dataClassification).toBe('CONFIDENTIAL');
  });

  test('an update that does not touch the photo does not claim one was attached', async () => {
    await updatePlayer({ userId: PRESIDENT, clubId: CLUB }, PLAYER, { number: 11 } as never);
    const frames = await liveTick();
    expect(frames.map((f) => f.eventType)).not.toContain('player.photo.attached');
  });

  test('the event is emitted AFTER the transaction, never inside it', () => {
    // An event announcing a change that then rolled back is worse than no
    // event. Checked in the source, because a mocked transaction always commits
    // and so cannot demonstrate the ordering by running.
    const src = decomment(read('src/services/player.service.ts'));
    for (const fn of ['createPlayer', 'updatePlayer']) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      const scope = body.slice(0, body.indexOf('\n}\n'));
      const commit = scope.indexOf('});');
      const emitAt = scope.indexOf('emitPlayerEvent(');
      expect(`${fn}: emit present`).toBe(`${fn}: ${emitAt > -1 ? 'emit present' : 'MISSING'}`);
      expect(`${fn}: after commit`).toBe(`${fn}: ${emitAt > commit ? 'after commit' : 'INSIDE TRANSACTION'}`);
    }
    // And no call sits INSIDE a transaction callback. Found exactly, by
    // matching the braces of every `$transaction(` span rather than by an
    // indentation rule a conditional would break.
    let from = 0;
    let spans = 0;
    while ((from = src.indexOf('$transaction(', from)) !== -1) {
      const open = src.indexOf('{', from);
      let depth = 0; let end = open;
      for (; end < src.length; end += 1) {
        if (src[end] === '{') depth += 1;
        else if (src[end] === '}') { depth -= 1; if (depth === 0) break; }
      }
      const inside = src.slice(open, end);
      expect(`span ${spans}: no emit inside`).toBe(`span ${spans}: ${inside.includes('emitPlayerEvent(') ? 'EMIT INSIDE TRANSACTION' : 'no emit inside'}`);
      spans += 1;
      from = end;
    }
    expect(spans).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Redaction — the part that would be a cross-tenant leak if it were wrong
// ─────────────────────────────────────────────────────────────────────────────

describe('safe projection', () => {
  /** Everything a frame must never carry, in one event. */
  const loadedEvent = (): FamilistaEvent => ({
    eventId: 'evt-1', eventType: 'player.updated', schemaVersion: 1,
    occurredAt: new Date('2026-09-16T10:00:00Z'), recordedAt: new Date('2026-09-16T10:00:00.120Z'),
    clubId: CLUB, teamId: TEAM, actorUserId: PRESIDENT,
    subjectType: 'PLAYER', subjectId: PLAYER,
    sourceType: 'USER', sourceId: 'req-9',
    correlationId: 'corr-1', causationId: 'cause-1',
    jurisdiction: 'DE', dataClassification: 'CONFIDENTIAL',
    payload: {
      password: 'hunter2-the-password',
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.tokenmaterial',
      hmacSecret: 'the-device-root-key',
      kek: 'the-key-encryption-key',
      medicalNotes: 'Grade II hamstring tear, MRI 12 Sep',
      parentEmail: 'parent@example.test',
      dateOfBirth: '2007-04-12',
    },
    metadata: {
      refreshToken: 'refresh-token-material',
      invitationToken: 'invite-token-material',
      note: 'internal-metadata-bag',
    },
    idempotencyKey: 'idem-1',
  } as FamilistaEvent);

  test('no payload or metadata value survives projection', () => {
    const frame = project(loadedEvent());
    const serialised = JSON.stringify(frame);

    for (const secret of [
      'hunter2-the-password', 'eyJhbGciOiJIUzI1NiJ9.tokenmaterial',
      'the-device-root-key', 'the-key-encryption-key',
      'Grade II hamstring tear, MRI 12 Sep', 'parent@example.test', '2007-04-12',
      'refresh-token-material', 'invite-token-material', 'internal-metadata-bag',
    ]) {
      expect(`${secret}: ${serialised.includes(secret)}`).toBe(`${secret}: false`);
    }

    // Not "redacted" — absent. A frame has no payload field at all, so there is
    // no key for a future producer's value to appear under.
    expect(frame).not.toHaveProperty('payload');
    expect(frame).not.toHaveProperty('metadata');
    expect(frame).not.toHaveProperty('actorUserId');
    expect(frame).not.toHaveProperty('idempotencyKey');
  });

  test('a person-identifying subject id is withheld; a tenant id is not', () => {
    // A PLAYER id identifies a person. The owner could look it up on a screen
    // that has an access log — which is an argument for that screen, not for
    // putting personal identifiers in an unlogged firehose.
    expect(project(loadedEvent()).subjectId).toBeNull();
    expect(project(loadedEvent()).subjectType).toBe('PLAYER');

    const clubEvent = { ...loadedEvent(), subjectType: 'CLUB', subjectId: CLUB } as FamilistaEvent;
    expect(project(clubEvent).subjectId).toBe(CLUB);
  });

  test('the projection is an allow-list in the source, not a deny-list', () => {
    // A deny-list ships every field a future producer adds. This asserts the
    // shape of the code, because that is the property that keeps holding.
    const src = decomment(read('src/fabric/pulse/pulse.service.ts'));
    const body = src.slice(src.indexOf('export function project'));
    const scope = body.slice(0, body.indexOf('\n}'));
    expect(scope).not.toMatch(/\.\.\.event/);
    expect(scope).not.toMatch(/\bdelete\b/);
    expect(scope).not.toMatch(/payload|metadata/);
  });

  test('the frame carries every field the inspector promises', () => {
    const frame = project(loadedEvent());
    for (const field of [
      'eventId', 'eventType', 'schemaVersion', 'occurredAt', 'recordedAt', 'latencyMs',
      'clubId', 'teamId', 'subjectType', 'subjectId', 'sourceType',
      'correlationId', 'causationId', 'dataClassification', 'status',
      'source', 'destination', 'registered',
    ]) {
      expect(`${field}: present`).toBe(`${field}: ${field in frame ? 'present' : 'MISSING'}`);
    }
    expect(frame.latencyMs).toBe(120);
  });

  test('a malformed event still yields a drawable frame rather than throwing', () => {
    // One bad producer must not take the owner's live view down.
    for (const bad of [{}, null, undefined, { eventType: 42 }, { occurredAt: 'not-a-date' }]) {
      const frame = project(bad as unknown as FamilistaEvent);
      expect(typeof frame.eventType).toBe('string');
      expect(frame.source).toBe('System');
      expect(frame.registered).toBe(false);
    }
    // A producer clock ahead of the server's gives a negative interval, which is
    // reported as unknown rather than as a duration nobody can read.
    const skewed = { ...loadedEvent(), recordedAt: new Date('2026-09-16T09:59:00Z') } as FamilistaEvent;
    expect(project(skewed).latencyMs).toBeNull();
  });

  test('an event type this build has never heard of is drawn, and marked unknown', () => {
    // A device firmware in the field will one day emit a name this build does
    // not know. Losing the event to protect a list would be the wrong trade.
    const future = { ...loadedEvent(), eventType: 'wearable.heartbeat.streamed' } as FamilistaEvent;
    const frame = project(future);
    expect(frame.registered).toBe(false);
    expect(frame.eventType).toBe('wearable.heartbeat.streamed');
    expect(SOURCE_LANES).toContain(frame.source);
    expect(LIVE_DESTINATIONS).toContain(frame.destination);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Authorization and tenancy
// ─────────────────────────────────────────────────────────────────────────────

describe('only the platform owner', () => {
  const ROUTES = ['/system/data-pulse/topology', '/system/data-pulse/snapshot', '/system/data-pulse/replay'];

  test('the platform owner is admitted', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    for (const route of ROUTES) {
      const res = await request(app()).get(route);
      expect(`${route}: ${res.status}`).toBe(`${route}: 200`);
    }
  });

  test('a club president is refused, however senior in their club', async () => {
    actingAs = { id: PRESIDENT, clubId: CLUB, role: 'CLUB_ADMIN' };
    for (const route of ROUTES) {
      const res = await request(app()).get(route);
      expect(`${route}: ${res.status >= 400}`).toBe(`${route}: true`);
      expect(JSON.stringify(res.body)).not.toContain('player.updated');
    }
  });

  test('a coach is refused', async () => {
    actingAs = { id: COACH, clubId: CLUB, role: 'COACH' };
    for (const route of ROUTES) {
      expect((await request(app()).get(route)).status).toBeGreaterThanOrEqual(400);
    }
  });

  test('an unauthenticated request never reaches the guard', async () => {
    actingAs = null;
    for (const route of ROUTES) {
      expect((await request(app()).get(route)).status).toBe(401);
    }
  });

  test('the guard is the platform\'s existing one, not a second system', () => {
    // A second authorization system is how two answers to one question appear.
    const src = decomment(read('src/routes/data-pulse.routes.ts'));
    expect(src).toMatch(/assertPlatformOwner/);
    expect(src).not.toMatch(/SUPER_ADMIN|role\s*===|isPlatformOwner\s*=/);
  });

  test('the endpoint is read-only — there is no writing route at all', () => {
    const src = decomment(read('src/routes/data-pulse.routes.ts'));
    for (const verb of ['post', 'put', 'patch', 'delete']) {
      expect(`${verb}: ${new RegExp(`router\\.${verb}\\(`).test(src)}`).toBe(`${verb}: false`);
    }
    // And in particular no route that manufactures an event. A button that
    // fakes activity is what would make this screen untrustworthy.
    expect(src).not.toMatch(/\bemit\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Metrics that are counted, and absences that are admitted
// ─────────────────────────────────────────────────────────────────────────────

describe('metrics are measured or absent, never invented', () => {
  test('an idle platform reports zero rate and no last event', () => {
    const m = pulseMetrics();
    expect(m.eventsPerSecond).toBe(0);
    expect(m.eventsPerMinute).toBe(0);
    expect(m.activeClubs).toBe(0);
    expect(m.lastEventAt).toBeNull();
    // Zero events is a MEASUREMENT. Average latency over zero events is not.
    expect(m.averageLatencyMs).toBeNull();
  });

  test('real events move the counters, and only real ones', async () => {
    await emit({ eventType: 'player.updated', clubId: CLUB, subjectType: 'PLAYER', subjectId: PLAYER, sourceType: 'USER', payload: {} });
    await emit({ eventType: 'player.created', clubId: OTHER_CLUB, subjectType: 'PLAYER', subjectId: 'p2', sourceType: 'USER', payload: {} });
    await liveTick();

    const m = pulseMetrics();
    expect(m.eventsPerMinute).toBe(2);
    expect(m.totalObserved).toBe(2);
    expect(m.activeClubs).toBe(2);          // two distinct clubs produced
    expect(m.lastEventAt).not.toBeNull();
    expect(typeof m.averageLatencyMs).toBe('number');
  });

  test('processed, failed and pending are admitted as not instrumented', () => {
    // Nothing in Familista sets `processedAt` or `failedAt`, so a count of zero
    // would describe the column rather than the platform.
    const m = pulseMetrics();
    expect(m.processed).toBeNull();
    expect(m.failed).toBeNull();
    expect(m.pending).toBeNull();
    expect(m.notInstrumented).toEqual(expect.arrayContaining(['processed', 'failed', 'pending']));
  });

  test('the interface renders a null metric as words, never as zero', () => {
    const src = decomment(read('public/data-pulse.js'));
    // `tile` is the one place a figure becomes pixels, so it is the one place
    // this property can be broken.
    const body = src.slice(src.indexOf('function tile(opts)'));
    const scope = body.slice(0, body.indexOf('\n  }'));
    expect(scope).toMatch(/Not instrumented/);
    // The null check must precede any formatting, or `null` renders as "0".
    expect(scope).toMatch(/value === null/);
    expect(scope.indexOf('value === null')).toBeLessThan(scope.indexOf('sy-dp-none'));
    // And the em dash is what a reader sees, never a zero.
    expect(scope).toMatch(/sy-dp-none">—/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · The map claims nothing it cannot support
// ─────────────────────────────────────────────────────────────────────────────

describe('topology', () => {
  test('live destinations are live and future ones are marked future', () => {
    const t = pulseTopology();
    expect(t.destinations.every((d) => d.live === true)).toBe(true);
    expect(t.destinations.map((d) => d.name)).toEqual([...LIVE_DESTINATIONS]);

    expect(t.future.length).toBe(FUTURE_DESTINATIONS.length);
    expect(t.future.every((d) => d.live === false)).toBe(true);
    expect(t.future.every((d) => /nothing is connected/i.test(d.note))).toBe(true);

    // ML, Feature Store, Data Lake, Cameras, GPS and Edge must never appear as
    // live: nothing consumes an event through any of them.
    for (const name of ['ML Pipeline', 'Feature Store', 'Data Lake', 'Cameras', 'GPS', 'Edge']) {
      expect(`${name}: ${t.destinations.some((d) => d.name === name)}`).toBe(`${name}: false`);
    }
  });

  test('the instrumented list matches what the source actually emits', () => {
    // The claim "these types have a producer" is checked against the code, so
    // the list cannot drift into a wish.
    const files = [
      'src/services/player.service.ts',
      'src/fabric/media/media-asset.service.ts',
      // Where the media names live now that the domain publishes through the
      // registry rather than through the bus. The service still calls the
      // producer; the producer is what names the type.
      'src/fabric/producers/media.producer.ts',
      'src/fabric/secrets/device-credentials.ts',
      'src/fabric/secrets/rewrap.ts',
    ];
    const found = new Set<string>();
    for (const file of files) {
      const src = decomment(read(file));
      for (const m of src.matchAll(/eventType:\s*['"]([a-z0-9.]+)['"]/g)) found.add(m[1]);
      // A producer that picks its name from a union of literals, as the player
      // one does, still names every literal in the signature.
      for (const m of src.matchAll(/'((?:player|media|device|secret)\.[a-z.]+)'/g)) found.add(m[1]);
    }
    for (const claimed of INSTRUMENTED_EVENT_TYPES) {
      expect(`${claimed}: emitted somewhere`).toBe(`${claimed}: ${found.has(claimed) ? 'emitted somewhere' : 'NOT EMITTED'}`);
    }
  });

  test('registered types with no producer are named as such', () => {
    const t = pulseTopology();
    // The honest gap. These are in the taxonomy so consumers can be written
    // against them; nothing emits them, and the screen says so.
    expect(t.notInstrumented.length).toBeGreaterThan(0);
    expect(t.notInstrumented).toContain('training.started');
    expect(t.notInstrumented).toContain('match.completed');
    for (const live of INSTRUMENTED_EVENT_TYPES) {
      expect(`${live}: not in gap list`).toBe(`${live}: ${t.notInstrumented.includes(live) ? 'IN GAP LIST' : 'not in gap list'}`);
    }
  });

  test('the interface has no particle loop and no synthetic activity', () => {
    const src = decomment(read('public/data-pulse.js'));
    // A dot exists only inside the function that draws one real frame.
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/setInterval/);
    expect(src).not.toMatch(/demo|fake|mock|sample.?data|dummy/i);
    // And the idle state says the true thing.
    expect(src).toMatch(/Listening for live platform activity/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · Load — the visualiser must not be able to hurt what it watches
// ─────────────────────────────────────────────────────────────────────────────

describe('burst handling', () => {
  test('a burst is batched, sampled, and reports what it sampled', async () => {
    const batches: Array<{ frames: PulseFrame[]; observed: number; sampling: number }> = [];
    onPulse((b) => batches.push(b));

    const burst = 400;
    for (let i = 0; i < burst; i += 1) {
      await emit({
        eventType: 'player.updated', clubId: CLUB,
        subjectType: 'PLAYER', subjectId: `p-${i}`, sourceType: 'USER',
        occurredAt: new Date(Date.now() - i), payload: { i },
      });
    }
    // Drained the way the route drains it: bounded pages until there is no more.
    for (let page = 0; page < 4; page += 1) await liveTick();

    // One flush, not four hundred callbacks.
    expect(batches.length).toBeLessThanOrEqual(2);
    const total = batches.reduce((n, b) => n + b.frames.length, 0);
    const observed = batches.reduce((n, b) => n + b.observed, 0);

    expect(observed).toBe(burst);
    expect(total).toBeLessThanOrEqual(SAMPLE_THRESHOLD * batches.length);
    expect(total).toBeLessThan(observed);
    // Sampling is DECLARED, so the screen can say "showing 1 in n" rather than
    // quietly showing a rate it is not drawing.
    expect(batches.some((b) => b.sampling > 1)).toBe(true);
  });

  test('the buffer is bounded, so a long-running process cannot grow forever', async () => {
    for (let i = 0; i < BUFFER_LIMIT + 120; i += 1) {
      await emit({
        eventType: 'player.updated', clubId: CLUB,
        subjectType: 'PLAYER', subjectId: `p-${i}`, sourceType: 'USER', payload: {},
      });
    }
    for (let page = 0; page < 4; page += 1) await liveTick();
    expect(recentFrames(10_000).length).toBe(BUFFER_LIMIT);
  });

  test('the metrics rate window is what the stream carries, not a database poll', () => {
    // A browser polling a count every second is exactly the aggressive Neon
    // traffic the brief rules out. Metrics ride the open connection.
    const src = decomment(read('src/routes/data-pulse.routes.ts'));
    expect(src).toMatch(/event: metrics|'metrics'/);
    const client = decomment(read('public/data-pulse.js'));
    expect(client).not.toMatch(/setInterval/);
    // Two raw fetches, and only two: the SSE stream, which cannot go through
    // a JSON helper, and the fallback beside it for a page without app.js.
    // Every other read is `FamilistaAPI.get`, which is not a fetch here.
    expect(client.match(/fetch\(/g)!.length).toBe(2);
    expect(client).toMatch(/api\.get\('\/system\/data-pulse'/);
  });

  test('a throwing listener does not stop the others or the emit', async () => {
    const seen: string[] = [];
    onPulse(() => { throw new Error('a bad consumer'); });
    onPulse((b) => { seen.push(...b.frames.map((f) => f.eventType)); });

    const result = await emit({
      eventType: 'player.updated', clubId: CLUB,
      subjectType: 'PLAYER', subjectId: PLAYER, sourceType: 'USER', payload: {},
    });
    await liveTick();

    expect(result.stored).toBe(true);
    expect(seen).toContain('player.updated');
    expect(logged.join('\n')).toMatch(/listener threw/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 · Reconnect, and replay over the durable record
// ─────────────────────────────────────────────────────────────────────────────

describe('reconnect and replay', () => {
  test('a reconnecting client is caught up from the buffer, not from nothing', async () => {
    await emit({ eventType: 'player.created', clubId: CLUB, subjectType: 'PLAYER', subjectId: PLAYER, sourceType: 'USER', payload: {} });
    await liveTick();

    // What `GET /snapshot` and the stream's `backlog` frame both serve.
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    const res = await request(app()).get('/system/data-pulse/snapshot');
    expect(res.status).toBe(200);
    expect(res.body.data.frames.map((f: PulseFrame) => f.eventType)).toContain('player.created');
    expect(res.body.data.metrics.totalObserved).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('parent@example.test');
  });

  test('the client backs off rather than hammering a dead stream', () => {
    const src = decomment(read('public/data-pulse.js'));
    const body = src.slice(src.indexOf('function fail('));
    const scope = body.slice(0, body.indexOf('\n  }'));
    expect(scope).toMatch(/Math\.pow\(2/);          // exponential
    expect(scope).toMatch(/Math\.min\(/);           // capped
    expect(scope).toMatch(/AbortError/);            // a deliberate close is not a failure
    // A silent reconnect would make a dead stream look like an idle platform.
    expect(scope).toMatch(/paint\('metrics'\)/);
    expect(src).toMatch(/Reconnecting/);
  });

  test('the server declares a heartbeat and a retry interval', () => {
    const src = decomment(read('src/routes/data-pulse.routes.ts'));
    expect(src).toMatch(/retry: 3000/);
    expect(src).toMatch(/keepalive/);
    expect(src).toMatch(/HEARTBEAT_MS/);
    // And tears everything down on disconnect — a leaked interval per closed
    // connection is how a long-lived process dies of a visualiser.
    expect(src).toMatch(/req\.on\('close', stop\)/);
    expect(src).toMatch(/clearInterval\(metricsTick\)/);
  });

  test('replay reads the durable record and yields the same frame shape', async () => {
    await emit({ eventType: 'player.updated', clubId: CLUB, teamId: TEAM, subjectType: 'PLAYER', subjectId: PLAYER, sourceType: 'USER', payload: { secretish: 'parent@example.test' } });
    await settle();

    const result = await replayWindow({ minutes: 5 });
    expect(result.frames.length).toBe(1);
    const frame = result.frames[0];
    expect(frame.eventType).toBe('player.updated');
    expect(frame.source).toBe('Players');
    expect(frame).not.toHaveProperty('payload');
    // Same redaction as the live path, because it is the same projection.
    expect(JSON.stringify(result)).not.toContain('parent@example.test');
  });

  test('replay counts admit that processing state is uninstrumented', async () => {
    await emit({ eventType: 'player.updated', clubId: CLUB, subjectType: 'PLAYER', subjectId: PLAYER, sourceType: 'USER', payload: {} });
    await settle();
    const counts = await replayCounts({ minutes: 5 });
    expect(counts.total).toBe(1);
    expect(counts.processed).toBeNull();
    expect(counts.failed).toBeNull();
    expect(counts.pending).toBeNull();
  });

  test('a legacy outbox row is shown by kind, and its payload is never opened', async () => {
    // Pre-envelope rows written by `big-data/publisher` are real activity. They
    // have no envelope and no classification, so the frame is built from
    // columns and treated as the most sensitive thing it could be.
    state.outbox.push({
      id: 'legacy-1', clubId: CLUB, kind: 'MATCH_EVENT',
      payload: { note: 'a-legacy-payload-value', playerEmail: 'parent@example.test' },
      source: 'match-intelligence', createdAt: new Date(), idempotencyKey: 'legacy-1',
      processedAt: null, failedAt: null,
    });

    const result = await replayWindow({ minutes: 5 });
    expect(result.legacyCount).toBe(1);
    const frame = result.frames.find((f) => f.eventId === 'legacy-1')!;
    // Mapped through the taxonomy so one occurrence keeps one name.
    expect(frame.eventType).toBe('match.event.recorded');
    expect(frame.dataClassification).toBe('RESTRICTED');
    expect(frame.latencyMs).toBeNull();
    expect(JSON.stringify(result)).not.toContain('a-legacy-payload-value');
    expect(JSON.stringify(result)).not.toContain('parent@example.test');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 · The panel itself
// ─────────────────────────────────────────────────────────────────────────────

describe('the panel', () => {
  test('it is registered in SYSTEM navigation without restructuring it', () => {
    const src = read('public/system/system.js');
    expect(src).toMatch(/\['data-pulse', 'Live Data Flow', '.', 'PLATFORM'\]/);
    expect(src).toMatch(/case 'data-pulse': return dataPulseHtml\(\);/);
    // Mounted after the markup is in the document, and unmounted on navigation
    // away — a stream held open for a screen nobody is watching.
    expect(src).toMatch(/syncDataPulse\(\)/);
    expect(src).toMatch(/window\.dpUnmount/);
  });

  test('the token travels in a header, never in the URL', () => {
    const src = decomment(read('public/data-pulse.js'));
    expect(src).toMatch(/Authorization: 'Bearer '/);
    expect(src).not.toMatch(/new EventSource/);
    expect(src).not.toMatch(/[?&]token=/);
  });

  test('nothing in the panel animates a layout property', () => {
    const css = read('public/system/system.css');
    const block = css.slice(css.indexOf('Live Data Flow — Data Pulse'));
    // A dot is positioned once and then only transformed, so a pulse cannot
    // reflow the panel underneath it.
    // The packet rides `offset-path`, so those are the properties that change.
    expect(block).toMatch(/will-change: offset-distance, opacity/);
    expect(block).toMatch(/pointer-events: none/);
    // The copper is a real SVG layer, behind the pads, hit-testing nothing.
    expect(block).toMatch(/\.sy-dp-traces/);
    expect(block).toMatch(/\.sy-dp-trace-hot/);
    for (const bad of ['animation: dp-grow', 'transition: width', 'transition: height', 'transition: top', 'transition: left']) {
      expect(`${bad}: ${block.includes(bad)}`).toBe(`${bad}: false`);
    }
    // The responsive escape hatch the repository requires of every workspace.
    expect(block).toMatch(/max-width: 980px/);
    expect(block).toMatch(/max-height: 620px/);
    expect(block).toMatch(/prefers-reduced-motion/);
  });

  test('the inspector shows fields and says the body is withheld', () => {
    const src = decomment(read('public/data-pulse.js'));
    for (const label of ['Event id', 'Schema version', 'Occurred at', 'Recorded at',
      'Write latency', 'Correlation id', 'Causation id', 'Classification', 'Status']) {
      expect(`${label}: ${src.includes(label)}`).toBe(`${label}: true`);
    }
    expect(src).toMatch(/The event body is never sent to this screen/);
  });

  test('the panel is served and its strings go through SYSTEM\'s catalogue', () => {
    expect(read('public/index.html')).toMatch(/data-pulse\.js/);
    // SYSTEM has its own three-language catalogue and the platform's 31-locale
    // one is deliberately not applied there. One screen, one catalogue.
    expect(decomment(read('public/data-pulse.js'))).toMatch(/sySyncTranslate/);
    expect(read('public/system/system.js')).toMatch(/window\.sySyncTranslate = syTranslate/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 · The production delivery failure, and the regressions that pin it shut
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT HAPPENED
//
// The server half worked from the first deploy: a Head Coach saved a player,
// `emit` ran, and two `player.updated` rows landed in `EventOutbox`. Nothing on
// the screen. The panel built its own URL from two properties that do not
// exist on the API client — `API().baseUrl` and `API().token` — so every
// request went to `/system/data-pulse/...` with no `/api/v1` prefix and no
// credentials, and 404'd. The client then reported every failure as
// "Reconnecting…" with no status code, so a 404 was indistinguishable from an
// idle platform.
//
// Three defects, and the tests below are one per defect: the prefix, the
// credentials, and the silence. The fourth test is the one that stops it
// recurring — a single request helper, asserted to be the only `fetch` here.

describe('the auth transport bugs that broke production', () => {
  const CLIENT = () => decomment(read('public/data-pulse.js'));
  const APP = () => read('public/app.js');
  const SYSTEM = () => read('public/system/system.js');

  test('the token comes from the one place the application keeps it', () => {
    // THE 401. `app.js` defines a `FamilistaAPI` that REPLACES the one in
    // `familista-api-client.js` and exposes no token accessor at all, so
    // `getToken()` was undefined and the header went out empty. The canonical
    // expression is the one SYSTEM's own `api()` uses.
    const src = CLIENT();
    expect(src).toMatch(/window\.State && window\.State\.token/);
    expect(src).toMatch(/localStorage\.getItem\('familista_token'\)/);
    expect(src).not.toMatch(/getToken\(\)/);
    expect(src).not.toMatch(/API\(\)\.token\b/);
    expect(src).not.toMatch(/API\(\)\.baseUrl/);

    // And it is the SAME expression, not a lookalike.
    expect(SYSTEM()).toMatch(/window\.State && window\.State\.token/);
    expect(SYSTEM()).toMatch(/localStorage\.getItem\('familista_token'\)/);
  });

  test('the exported client really has no getToken, which is why that failed', () => {
    // Pins the fact the fix rests on: if app.js ever exports getToken, this
    // test should be revisited rather than silently passing.
    const surface = APP().slice(APP().indexOf('  return {\n    request,'));
    const block = surface.slice(0, surface.indexOf('\n  };'));
    expect(block).toMatch(/refreshTokens/);
    expect(block).toMatch(/request/);
    expect(block).not.toMatch(/getToken/);
  });

  test('JSON reads go through the application request path, not a private one', () => {
    // `FamilistaAPI.get` brings the 401-refresh-retry, the cold-start timeout
    // and the backoff. Reimplementing any of that would be a second session.
    const src = CLIENT();
    expect(src).toMatch(/api\.get\('\/system\/data-pulse'/);
    expect(src).toMatch(/api\.refreshTokens/);
    // Exactly two raw fetches: the stream, which cannot be a JSON helper, and
    // the no-app.js fallback beside it.
    expect(src.match(/\bfetch\(/g)).toHaveLength(2);
  });

  test('an expired token is refreshed once through the canonical flow', () => {
    const src = CLIENT();
    const connect = src.slice(src.indexOf('function connect('));
    const body = connect.slice(0, connect.indexOf('\n  }'));
    expect(body).toMatch(/res\.status === 401 && !DP\.refreshed/);
    expect(body).toMatch(/refreshOnce\(\)/);
    // One refresh per attempt, so an expired session cannot loop.
    expect(body).toMatch(/DP\.refreshed = true/);
    // And the app's own refresh is what is called.
    const refresh = src.slice(src.indexOf('function refreshOnce'));
    expect(refresh.slice(0, refresh.indexOf('\n  }'))).toMatch(/api\.refreshTokens\(\)/);
  });

  test('production is cross-origin, so the bearer is the credential that counts', () => {
    // `FAM_CONFIG.API_BASE` is absolute in production, so the access_token
    // cookie does not travel by default and cannot be relied on.
    expect(APP()).toMatch(/https:\/\/familista-backend\.onrender\.com\/api\/v1/);
    const src = CLIENT();
    expect(src).toMatch(/FAM_CONFIG\.API_BASE/);
    expect(src).toMatch(/Authorization: 'Bearer '/);
    // Sent as well, for a same-origin deployment. Belt, not the only strap.
    expect(src).toMatch(/credentials: 'include'/);
  });

  test('401 and 403 stay distinguishable all the way to the label', () => {
    const src = CLIENT();
    expect(src).toMatch(/Not signed in/);
    expect(src).toMatch(/Not authorised/);
    expect(src).toMatch(/Platform Owner authority required/);
    expect(src).toMatch(/DP\.fatalStatus === 401/);
    expect(src).toMatch(/DP\.fatalStatus === 403/);
    // The status travels on the error object, so nothing has to be inferred
    // from a message string.
    expect(src).toMatch(/e\.status = status/);
    expect(src).toMatch(/sy-dp-status-detail/);
  });

  test('no credential ever appears in a URL', () => {
    const src = CLIENT();
    expect(src).not.toMatch(/[?&]token=/);
    expect(src).not.toMatch(/[?&]access_token=/);
    expect(src).not.toMatch(/new EventSource/);
    // The only query parameter this panel sends is the replay window.
    expect(src).toMatch(/'\/replay\?minutes=' \+ encodeURIComponent/);
  });

  test('a refusal is not retried, and a network fault is', () => {
    const src = CLIENT();
    const fail = src.slice(src.indexOf('function fail('));
    const body = fail.slice(0, fail.indexOf('\n  }'));
    expect(body).toMatch(/if \(DP\.fatal\) return;/);
    expect(body).toMatch(/AbortError/);
    expect(body.indexOf('DP.fatal')).toBeLessThan(body.indexOf('setTimeout'));
    const auth = src.slice(src.indexOf('function isAuthStatus'));
    expect(auth.slice(0, auth.indexOf('\n  }'))).toMatch(/401.*403/s);
  });

  test('the same event is never rendered twice across a reconnect', () => {
    const src = CLIENT();
    const accept = src.slice(src.indexOf('function accept('));
    const body = accept.slice(0, accept.indexOf('\n  }'));
    expect(body).toMatch(/seen\[id\]/);
    expect(body).toMatch(/f\.eventId/);
    expect(body).toMatch(/if \(!fresh\.length\) return;/);
    expect(src).toMatch(/delete seen\[seenOrder\.shift\(\)\]/);
  });
});

describe('replay reads the real outbox rows', () => {
  /** A row exactly as the outbox transport writes one. */
  const outboxRow = (over: Row = {}) => ({
    id: 'row-1', clubId: CLUB, kind: 'player.updated',
    source: 'USER', createdAt: new Date(), idempotencyKey: 'idem-row-1',
    processedAt: null, failedAt: null,
    payload: {
      __familista_event: {
        eventId: 'evt-real-1', eventType: 'player.updated', schemaVersion: 1,
        occurredAt: new Date().toISOString(), recordedAt: new Date().toISOString(),
        clubId: CLUB, teamId: TEAM, actorUserId: COACH,
        subjectType: 'PLAYER', subjectId: PLAYER,
        sourceType: 'USER', sourceId: null,
        correlationId: null, causationId: null, jurisdiction: null,
        dataClassification: 'CONFIDENTIAL',
        payload: { changedFields: ['position'] },
        metadata: {}, idempotencyKey: 'idem-row-1',
      },
    },
    ...over,
  });

  test('a real player.updated row appears in the last five minutes', async () => {
    // The production case, reproduced from the row shape rather than by
    // emitting: this is what Neon actually holds.
    state.outbox.push(outboxRow());

    const result = await replayWindow({ minutes: 5 });
    expect(result.frames).toHaveLength(1);
    expect(result.legacyCount).toBe(0);

    const frame = result.frames[0];
    expect(frame.eventType).toBe('player.updated');
    expect(frame.clubId).toBe(CLUB);
    expect(frame.teamId).toBe(TEAM);
    expect(frame.source).toBe('Players');
    expect(frame.destination).toBe('Operational Data');
    expect(frame.dataClassification).toBe('CONFIDENTIAL');
    expect(frame.registered).toBe(true);
  });

  test('subject metadata is read from the real envelope path', () => {
    // `payload.__familista_event.subjectType` — verified against what the
    // transport writes, not assumed. The id is withheld for a PLAYER because
    // it identifies a person; the TYPE is not, and must survive.
    const frame = replayProjection(outboxRow());
    expect(frame.subjectType).toBe('PLAYER');
    expect(frame.subjectId).toBeNull();

    const clubRow = outboxRow();
    (clubRow.payload as Row).__familista_event.subjectType = 'CLUB';
    (clubRow.payload as Row).__familista_event.subjectId = CLUB;
    expect(replayProjection(clubRow).subjectId).toBe(CLUB);
  });

  test('the replay window filters on the column the rows are written with', async () => {
    // `createdAt`, which is the row's insert time. Filtering on the envelope's
    // `occurredAt` would silently miss a row whose producer clock differs.
    const src = decomment(read('src/fabric/pulse/pulse-replay.service.ts'));
    expect(src).toMatch(/createdAt: \{ gte: from, lte: to \}/);

    state.outbox.push(outboxRow({ createdAt: new Date(Date.now() - 60 * 60_000) }));
    expect((await replayWindow({ minutes: 5 })).frames).toHaveLength(0);
    expect((await replayWindow({ minutes: 120 })).frames).toHaveLength(1);
  });

  /**
   * Replay read only the outbox, so every navigation, pointer window, scroll
   * and hover was live-only. It existed on screen for as long as the board's
   * buffer held it and then it was gone, even though the row was sitting in
   * `AnalyticsEvent` the whole time. That is a second reason a NAV event could
   * be missing from a reader's point of view, independent of the cursor bug.
   */
  test('replay shows telemetry as well as domain events, merged by when they happened', async () => {
    const base = Date.now() - 60_000;
    state.outbox.push(outboxRow({ id: 'dom-1', createdAt: new Date(base + 2000) }));
    state.telemetry.push({
      id: 'ui-nav', eventName: 'route_changed', module: 'squad', feature: 'squad',
      occurredAt: new Date(base + 1000), recordedAt: new Date(base + 4000),
      sessionId: 's', userId: COACH, platformRole: 'HEAD_COACH',
      clubId: CLUB, teamId: TEAM, route: '/squad', durationMs: null,
      deviceCategory: 'desktop', source: 'web', schemaVersion: 1,
    });
    state.telemetry.push({
      id: 'ui-scroll', eventName: 'scroll_depth', module: 'squad', feature: 'depth-50',
      occurredAt: new Date(base + 3000), recordedAt: new Date(base + 4001),
      sessionId: 's', userId: COACH, platformRole: 'HEAD_COACH',
      clubId: CLUB, teamId: TEAM, route: '/squad', durationMs: null,
      deviceCategory: 'desktop', source: 'web', schemaVersion: 1,
    });

    const result = await replayWindow({ minutes: 5 });
    const types = result.frames.map((f) => f.eventType);
    expect(types).toContain('ui.route_changed');
    expect(types).toContain('ui.scroll_depth');
    // Interleaved by `occurredAt` across both tables, not one table after the
    // other — a replay is meant to show what a minute actually looked like.
    expect(types.indexOf('ui.route_changed')).toBeLessThan(types.indexOf('ui.scroll_depth'));
    expect(types.some((t) => t.indexOf('ui.') !== 0)).toBe(true);
  });

  test('a replay window is asked of when things HAPPENED, on both tables', async () => {
    const src = decomment(read('src/fabric/pulse/pulse-replay.service.ts'));
    // The outbox has one clock and it is the database's. Telemetry has two, and
    // a window is a question about the browser's — which is the opposite of
    // what a live CURSOR may walk.
    expect(src).toMatch(/createdAt: \{ gte: from, lte: to \}/);
    expect(src).toMatch(/occurredAt: \{ gte: from, lte: to \}/);

    const old = new Date(Date.now() - 60 * 60_000);
    state.telemetry.push({
      id: 'ui-old', eventName: 'route_changed', module: 'training',
      occurredAt: old, recordedAt: new Date(),
      sessionId: 's', userId: COACH, platformRole: 'HEAD_COACH',
      clubId: CLUB, teamId: null, route: '/training', durationMs: null,
      deviceCategory: 'desktop', source: 'web', schemaVersion: 1,
    });
    // Recorded seconds ago, but it HAPPENED an hour ago, so a five-minute
    // window does not contain it and a two-hour one does.
    expect((await replayWindow({ minutes: 5 })).frames).toHaveLength(0);
    expect((await replayWindow({ minutes: 120 })).frames.map((f) => f.eventId)).toEqual(['ui-old']);
  });

  test('a telemetry outage does not take replay down with it', async () => {
    const original = db.analyticsEvent.findMany;
    db.analyticsEvent.findMany = async () => { throw new Error('telemetry unavailable'); };
    try {
      state.outbox.push(outboxRow());
      const result = await replayWindow({ minutes: 5 });
      expect(result.frames).toHaveLength(1);
    } finally {
      db.analyticsEvent.findMany = original;
    }
  });

  test('a real row still leaks nothing', async () => {
    state.outbox.push(outboxRow());
    const result = await replayWindow({ minutes: 5 });
    // The club and the player NAME are resolved and are meant to be here; the
    // ids, the payload and the actor are not.
    expect(result.frames[0].clubLabel).toBe('FC Familista');
    const serialised = JSON.stringify(result);
    // The two APPROVED additions are present, and are the reason the card can
    // answer "which player, which field" without the payload.
    expect(result.frames[0].subjectLabel).toBe('Amara Okonkwo');
    expect(result.frames[0].changedFields).toEqual(['position']);

    // Everything else the row holds still does not travel. `position` here is a
    // field NAME the producer chose to publish; the VALUE it changed to is not
    // in the envelope at all, and none of the rest of the player is either.
    expect(serialised).not.toContain(COACH);            // the actor is not published
    expect(serialised).not.toContain(PLAYER);           // nor the person's id
    expect(serialised).not.toContain('idem-row-1');     // nor the idempotency key
    expect(serialised).not.toContain('parent@example.test');
    expect(serialised).not.toContain('hamstring');      // the notes
    expect(serialised).not.toContain('2007-04-12');     // the date of birth
    // And the id used server-side for the label lookup is deleted, not blanked,
    // so a serialiser cannot even find the key.
    expect(serialised).not.toContain('resolveId');
    expect('resolveId' in result.frames[0]).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10 · The cross-origin check that a same-origin test cannot make
// ─────────────────────────────────────────────────────────────────────────────
//
// The production 401 was invisible to every test in this file, because its
// cause was the two things a same-origin suite cannot see: an absolute API base
// and a cookie that does not cross origins. `scripts/data-pulse-xorigin-check.js`
// serves the panel from one host and the API from another and drives the real
// browser. It is not in `npm test` because it needs a browser binary; these
// assertions pin that it exists and still covers the cases that failed.

describe('the cross-origin browser check', () => {
  const SCRIPT = () => read('scripts/data-pulse-xorigin-check.js');

  test('it exists, and uses two genuinely different origins', () => {
    const src = SCRIPT();
    // Different hosts, so the browser treats it as cross-origin and applies
    // real CORS and real cookie rules.
    expect(src).toMatch(/http:\/\/127\.0\.0\.1:7801/);
    expect(src).toMatch(/http:\/\/localhost:7802/);
    // And it says which production origins those stand for.
    expect(src).toMatch(/familista-v5\.onrender\.com/);
    expect(src).toMatch(/familista-backend\.onrender\.com/);
    // An absolute API base is the production shape, and the shape that broke.
    expect(src).toMatch(/API_BASE: '\$\{BACK\}\/api\/v1'/);
  });

  test('it drives the real client, not a reimplementation of it', () => {
    // Decommented: the header explains the getToken defect in prose, and an
    // assertion that matches its own explanation proves nothing.
    const src = decomment(SCRIPT());
    expect(src).toMatch(/src="\/data-pulse\.js"/);
    expect(src).toMatch(/window\.dpMount\('dp-host'\)/);
    // The harness models the client app.js really exports — get and
    // refreshTokens, and no getToken, which is the fact the fix rests on.
    expect(src).toMatch(/refreshTokens/);
    expect(src).not.toMatch(/getToken/);
    // And the token where the application really keeps it.
    expect(src).toMatch(/window\.State = \{ token/);
  });

  test('it covers every authorization outcome that reached production', () => {
    const src = SCRIPT();
    for (const scenario of [
      'fresh owner token',
      'expired token -> refresh',
      'signed out (no token, no refresh)',
      'president',
      'head coach',
    ]) {
      expect(`${scenario}: ${src.includes(scenario)}`).toBe(`${scenario}: true`);
    }
    // 403 for a club role, 401 for no session — asserted by the harness's own
    // backend rather than by the client, so the client cannot fake either.
    expect(src).toMatch(/res\.writeHead\(403/);
    expect(src).toMatch(/res\.writeHead\(401/);
    // And it watches for a credential in a URL on every request it records.
    expect(src).toMatch(/tokenInUrl/);
  });

  test('it writes nothing into the repository it does not clean up', () => {
    const src = SCRIPT();
    expect(src).toMatch(/unlinkSync\('public\/__x\.html'\)/);
    // No production host is ever contacted.
    expect(src).not.toMatch(/https:\/\/familista-backend\.onrender\.com\/api/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11 · Live reads the outbox, not this process's memory
// ─────────────────────────────────────────────────────────────────────────────
//
// THE FAILURE THIS CLOSES
//
// Live used to be fed by `subscribe('*')` on the in-process event bus, so a
// frame only reached the screen when the `emit()` that made it ran in the SAME
// Node process as the open stream. On a service with more than one instance
// those are different processes, and two real `player.updated` rows sat in
// Postgres while the panel reported an idle platform.
//
// The tests below are written so that a pass CANNOT be explained by an
// in-process shortcut: the event bus is explicitly disconnected — no transport,
// no subscribers — and the row is inserted directly, the way another instance
// would have left it. If the tail did not read the table, every one of these
// would fail.

describe('the durable tail — process A sees what process B wrote', () => {
  /** A row exactly as `outboxTransport.append` leaves one. */
  const outboxRow = (over: Row = {}, envelope: Row = {}) => {
    const created = (over.createdAt as Date) ?? new Date();
    return {
      id: (over.id as string) ?? `row-${state.outbox.length + 1}`,
      clubId: CLUB, kind: 'player.updated', source: 'USER',
      createdAt: created, idempotencyKey: `idem-${state.outbox.length + 1}`,
      processedAt: null, failedAt: null,
      payload: {
        __familista_event: {
          eventId: (over.id as string) ?? `evt-${state.outbox.length + 1}`,
          eventType: 'player.updated', schemaVersion: 1,
          occurredAt: created.toISOString(), recordedAt: created.toISOString(),
          clubId: CLUB, teamId: TEAM, actorUserId: COACH,
          subjectType: 'PLAYER', subjectId: PLAYER,
          sourceType: 'USER', sourceId: null,
          correlationId: null, causationId: null, jurisdiction: null,
          dataClassification: 'CONFIDENTIAL',
          payload: { changedFields: ['position'] },
          metadata: {}, idempotencyKey: `idem-${state.outbox.length + 1}`,
          ...envelope,
        },
      },
      ...over,
    };
  };

  /**
   * Sever every in-process path.
   *
   * No transport and no subscribers, so nothing can reach a frame except by
   * reading the table. This is what makes the next test meaningful rather than
   * merely green.
   */
  const asAnotherInstance = () => {
    setEventTransport(null);
    clearSubscribers();
  };

  test('THE CRITICAL TEST — a row written elsewhere animates here', async () => {
    asAnotherInstance();

    // A owns a stream and is caught up: its cursor is the newest row, of which
    // there are none.
    let cursor = await latestCursor();
    expect(cursor).toBeNull();

    // Process B writes. No emit, no bus, no subscriber — just the row.
    state.outbox.push(outboxRow({ id: 'row-from-B' }));

    // A had no cursor, so it seeds now — as a freshly opened panel would.
    cursor = await latestCursor();
    expect(cursor).not.toBeNull();

    // B writes a second one while A is watching.
    state.outbox.push(outboxRow({ id: 'row-from-B-2', createdAt: new Date(Date.now() + 5) }));

    const step = await tailStep(cursor);
    expect(step.frames).toHaveLength(1);
    expect(step.frames[0].eventType).toBe('player.updated');
    expect(step.frames[0].eventId).toBe('row-from-B-2');
    // And the cursor moved to exactly what was read.
    expect(step.cursor!.id).toBe('row-from-B-2');

    // Proof that nothing in-process was involved: no transport is installed.
    expect(currentTransport()).toBeNull();
  });

  test('the cursor is a (createdAt, id) pair, so a shared millisecond is exact', async () => {
    asAnotherInstance();
    // The real case: one player update emits `player.updated` and
    // `player.photo.attached` inside the same millisecond.
    const sameMs = new Date('2026-09-18T10:00:00.000Z');
    state.outbox.push(outboxRow({ id: 'aaa', createdAt: sameMs }));
    state.outbox.push(outboxRow({ id: 'bbb', createdAt: sameMs }, { eventType: 'player.photo.attached' }));
    state.outbox.push(outboxRow({ id: 'ccc', createdAt: sameMs }));

    // Starting from the first of the three: the other two follow, in id order,
    // and the first is not repeated.
    const step = await tailStep({ createdAt: sameMs, id: 'aaa' });
    expect(step.frames.map((f) => f.eventId)).toEqual(['bbb', 'ccc']);

    // A cursor on the timestamp alone could not do this: every row shares it.
    const all = await tailAfter({ createdAt: new Date(sameMs.getTime() - 1), id: '' });
    expect(all.rows).toHaveLength(3);
  });

  test('opening Live does not animate history, and Replay still has it', async () => {
    asAnotherInstance();
    // Ten minutes of existing activity.
    for (let i = 0; i < 5; i += 1) {
      state.outbox.push(outboxRow({ id: `old-${i}`, createdAt: new Date(Date.now() - (10 - i) * 60_000) }));
    }

    // A panel opens: the cursor seeds at the newest row that exists…
    const cursor = await latestCursor();
    expect(cursor!.id).toBe('old-4');
    // …so the first tail finds nothing. Live means "after I started watching".
    expect((await tailStep(cursor)).frames).toHaveLength(0);

    // The same rows are Replay's job, and Replay has them.
    const replay = await replayWindow({ minutes: 60 });
    expect(replay.frames.map((f) => f.eventId).sort()).toEqual(['old-0', 'old-1', 'old-2', 'old-3', 'old-4']);
  });

  test('no cursor means nothing, not everything', async () => {
    asAnotherInstance();
    state.outbox.push(outboxRow({ id: 'x' }));
    // A tail that defaulted to the beginning of time would replay the whole
    // table on its first poll — the flood the seed exists to prevent.
    expect((await tailStep(null)).frames).toHaveLength(0);
  });

  test('a resumed cursor replays nothing already delivered', async () => {
    asAnotherInstance();
    const t0 = new Date('2026-09-18T10:00:00.000Z');
    state.outbox.push(outboxRow({ id: 'r1', createdAt: t0 }));
    state.outbox.push(outboxRow({ id: 'r2', createdAt: new Date(t0.getTime() + 10) }));

    const first = await tailStep({ createdAt: new Date(t0.getTime() - 1), id: '' });
    expect(first.frames.map((f) => f.eventId)).toEqual(['r1', 'r2']);

    // The client reconnects and hands back the pair it rendered.
    const resumed = await tailStep(first.cursor);
    expect(resumed.frames).toHaveLength(0);

    // And the wire form round-trips exactly, so a reconnect cannot drift.
    const wire = formatCursor(first.cursor);
    expect(parseCursor(wire)).toEqual(first.cursor);
  });

  test('the batch is bounded, and says when more is waiting', async () => {
    asAnotherInstance();
    const t0 = Date.now();
    for (let i = 0; i < TAIL_BATCH + 40; i += 1) {
      state.outbox.push(outboxRow({ id: `b-${String(i).padStart(4, '0')}`, createdAt: new Date(t0 + i) }));
    }
    const step = await tailStep({ createdAt: new Date(t0 - 1), id: '' }, TAIL_BATCH);
    expect(step.frames).toHaveLength(TAIL_BATCH);
    expect(step.more).toBe(true);
    // The cursor advanced only as far as was read. A cursor moved past unread
    // rows loses them silently — the one failure a tail must not have.
    expect(step.cursor!.id).toBe(`b-${String(TAIL_BATCH - 1).padStart(4, '0')}`);
  });

  test('two simultaneous events keep their own lanes', async () => {
    asAnotherInstance();
    const t0 = new Date();
    state.outbox.push(outboxRow({ id: 'p1', createdAt: t0 }));
    state.outbox.push(outboxRow({ id: 'm1', createdAt: new Date(t0.getTime() + 1) },
      { eventType: 'media.created', subjectType: 'MEDIA_ASSET', subjectId: 'media-1' }));

    const step = await tailStep({ createdAt: new Date(t0.getTime() - 1), id: '' });
    const byId = Object.fromEntries(step.frames.map((f) => [f.eventId, f]));

    // A Players event lights Players, and a Media event does not.
    expect(byId.p1.source).toBe('Players');
    expect(byId.p1.destination).toBe('Operational Data');
    expect(byId.m1.source).toBe('Media');
    expect(byId.m1.destination).toBe('Media');
  });

  test('the in-process subscription is gone, not kept alongside', () => {
    // Two sources would deliver every same-process event twice and — worse —
    // would make the screen appear to work in single-instance testing while
    // still failing in production.
    const src = decomment(read('src/fabric/pulse/pulse.service.ts'));
    expect(src).not.toMatch(/subscribe\('\*'/);
    expect(src).not.toMatch(/from '\.\.\/event-bus'/);
    // And `initDataFabric` no longer starts it against the bus. Scoped to that
    // function's body: the module legitimately still EXPORTS `startPulse`, and
    // asserting on the whole file would fail for the wrong reason.
    const barrel = decomment(read('src/fabric/index.ts'));
    const init = barrel.slice(barrel.indexOf('export function initDataFabric'));
    const body = init.slice(0, init.indexOf('\n}'));
    expect(body).toMatch(/setEventTransport|set\(t\)/);
    expect(body).not.toMatch(/startPulse|watch\(\)/);
    expect(body).not.toMatch(/pulse\.service/);
  });

  test('a failed poll leaves the cursor where it was', async () => {
    asAnotherInstance();
    const cursor = { createdAt: new Date(), id: 'somewhere' };
    const original = db.eventOutbox.findMany;
    db.eventOutbox.findMany = async () => { throw new Error('connection lost'); };
    try {
      const step = await tailStep(cursor);
      expect(step.frames).toHaveLength(0);
      // Unchanged, so the next tick asks for exactly the same rows.
      expect(step.cursor).toEqual(cursor);
      expect(logged.join('\n')).toMatch(/tail step failed/);
    } finally {
      db.eventOutbox.findMany = original;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12 · Naming the subject, without opening the row
// ─────────────────────────────────────────────────────────────────────────────
//
// The card must say WHICH player, in WHICH club, and WHICH field changed —
// discovered by the server from the outbox row, with nothing supplied by
// whoever opened the panel. That is two new labels and one payload key, and
// each is the narrowest thing that answers the question. These tests are the
// boundary: they feed a player row carrying every sensitive column Familista
// holds and assert that only the name comes out.

describe('subject resolution', () => {
  const rowFor = (envelope: Row = {}) => {
    const created = new Date();
    return {
      id: 'row-res', clubId: CLUB, kind: 'player.updated', source: 'USER',
      createdAt: created, idempotencyKey: 'idem-res', processedAt: null, failedAt: null,
      payload: {
        __familista_event: {
          eventId: 'evt-res', eventType: 'player.updated', schemaVersion: 1,
          occurredAt: created.toISOString(), recordedAt: created.toISOString(),
          clubId: CLUB, teamId: TEAM, actorUserId: COACH,
          subjectType: 'PLAYER', subjectId: PLAYER,
          sourceType: 'USER', sourceId: null,
          correlationId: null, causationId: null, jurisdiction: null,
          dataClassification: 'CONFIDENTIAL',
          payload: { changedFields: ['position'] },
          metadata: {}, idempotencyKey: 'idem-res', ...envelope,
        },
      },
    };
  };

  test('the acceptance case: the system discovers the player unaided', async () => {
    // Nothing in this test tells the resolver which player changed. It has the
    // row, and the row has an id, and that is all it needs.
    state.outbox.push(rowFor());
    const [frame] = await framesFromRows([state.outbox[0] as Row]);

    expect(frame.eventType).toBe('player.updated');
    expect(frame.clubLabel).toBe('FC Familista');
    expect(frame.subjectLabel).toBe('Amara Okonkwo');
    expect(frame.changedFields).toEqual(['position']);
    expect(frame.occurredAt).toBeTruthy();
    expect(frame.source).toBe('Players');
    expect(frame.destination).toBe('Operational Data');
  });

  test('the resolver selects names and nothing else', () => {
    // Read the source. A `select` naming three columns cannot return a fourth;
    // a fetch-and-delete would ship whatever a migration adds next.
    const src = decomment(read('src/fabric/pulse/subject-resolver.service.ts'));
    const player = src.slice(src.indexOf('prisma.player.findMany'));
    const scope = player.slice(0, player.indexOf('}),'));
    expect(scope).toMatch(/select: \{ id: true, firstName: true, lastName: true \}/);
    for (const forbidden of ['dateOfBirth', 'parentEmail', 'parentPhone', 'medicalStatus', 'notes', 'email', 'avatar']) {
      expect(`${forbidden}: ${src.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
    // And never a bare findMany with no select.
    expect(src).not.toMatch(/findMany\(\{ where: \{ id: \{ in: playerIds \} \} \}\)/);
  });

  test('resolution is batched, not per frame', async () => {
    // A burst of activity must not become a burst of database load.
    let calls = 0;
    const original = db.player.findMany;
    db.player.findMany = async (args: Row) => { calls += 1; return original(args); };
    try {
      const rows = [];
      for (let i = 0; i < 30; i += 1) rows.push({ ...rowFor(), id: `r-${i}` });
      await framesFromRows(rows as Row[]);
      // One query for thirty frames, not thirty.
      expect(calls).toBe(1);
    } finally {
      db.player.findMany = original;
    }
  });

  test('a value hidden in changedFields is truncated, not published', async () => {
    // The producer writes names only. If one day it wrote something longer,
    // the cap keeps a mistake to a truncated string rather than a paragraph.
    const long = 'x'.repeat(400);
    state.outbox.push(rowFor({ payload: { changedFields: [long, 'position'] } }) as never);
    const [frame] = await framesFromRows([state.outbox[state.outbox.length - 1] as Row]);
    expect(frame.changedFields[0].length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(frame)).not.toContain(long);
  });

  test('a non-string, or too many, cannot smuggle a payload through', async () => {
    state.outbox.push(rowFor({
      payload: { changedFields: [{ secret: 'a-value' }, 42, null, 'position'] },
    }) as never);
    const [frame] = await framesFromRows([state.outbox[state.outbox.length - 1] as Row]);
    expect(frame.changedFields).toEqual(['position']);
    expect(JSON.stringify(frame)).not.toContain('a-value');
  });

  test('a deleted subject leaves the label empty and the event visible', async () => {
    // The event happened. That the player has since gone is not a reason to
    // hide it, and inventing a name would be a fabrication.
    state.players = [];
    state.outbox.push(rowFor());
    const [frame] = await framesFromRows([state.outbox[state.outbox.length - 1] as Row]);
    expect(frame.subjectLabel).toBeNull();
    expect(frame.eventType).toBe('player.updated');
  });

  test('a failed lookup costs the label, never the frame', async () => {
    const original = db.club.findMany;
    db.club.findMany = async () => { throw new Error('read failed'); };
    try {
      state.outbox.push(rowFor());
      const [frame] = await framesFromRows([state.outbox[state.outbox.length - 1] as Row]);
      expect(frame.eventType).toBe('player.updated');
      expect(frame.clubLabel).toBeNull();
      expect('resolveId' in frame).toBe(false);
      expect(logged.join('\n')).toMatch(/could not resolve subject labels/);
    } finally {
      db.club.findMany = original;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13 · The board is a board
// ─────────────────────────────────────────────────────────────────────────────

describe('the PCB topology', () => {
  const CLIENT = () => decomment(read('public/data-pulse.js'));
  const CSS = () => read('public/system/system.css');

  test('traces are real SVG paths, measured from the pads', () => {
    const src = CLIENT();
    expect(src).toMatch(/createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'path'\)/);
    expect(src).toMatch(/function tracePath/);
    expect(src).toMatch(/getBoundingClientRect/);
    // One trace per source and per destination, keyed so a packet can find its
    // own copper rather than a straight line between two boxes.
    expect(src).toMatch(/'tr-src-' \+ slug/);
    expect(src).toMatch(/'tr-dst-' \+ slug/);
  });

  test('a packet rides the trace, and the trace lights along its length', () => {
    const src = CLIENT();
    expect(src).toMatch(/offsetPath = 'path\("'/);
    expect(src).toMatch(/offsetDistance/);
    // stroke-dashoffset, which does not reflow.
    expect(src).toMatch(/strokeDashoffset/);
    expect(src).toMatch(/getTotalLength/);
  });

  test('the flow is source → fabric → outbox → destination, in that order', () => {
    const src = CLIENT();
    const fn = src.slice(src.indexOf('function pulse(frame)'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    // The outbox lights at arrival, because that is the instant the row exists
    // and Live reads rows.
    expect(body.indexOf('lightFor(srcPad')).toBeLessThan(body.indexOf("getElementById('dp-outbox')") + 1e9);
    expect(body).toMatch(/dp-outbox|outbox/);
    expect(body).toMatch(/energise\(inTrace/);
    expect(body).toMatch(/energise\(outTrace/);
    expect(body).toMatch(/lightFor\(dstPad/);
    // Leg two is delayed by leg one's duration, so direction is unambiguous.
    expect(body).toMatch(/packet\(outTrace, OUT_MS, IN_MS\)/);
  });

  test('a missing lane draws nothing rather than something arbitrary', () => {
    const src = CLIENT();
    const fn = src.slice(src.indexOf('function pulse(frame)'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toMatch(/if \(!inTrace \|\| !outTrace \|\| !srcPad \|\| !dstPad\) return;/);
    // And the hard cap holds regardless.
    expect(body).toMatch(/DOT_LIMIT\) return;/);
  });

  test('a pad lights only while its own traffic passes', () => {
    const src = CLIENT();
    expect(src).toMatch(/classList\.add\('sy-dp-hot'\)/);
    expect(src).toMatch(/classList\.remove\('sy-dp-hot'\)/);
    // Idle means dark: the LED's resting colour is a line token, not an accent.
    const css = CSS();
    const led = css.slice(css.indexOf('.sy-dp-led {'));
    expect(led.slice(0, led.indexOf('}'))).toMatch(/background: var\(--sy-line-2\)/);
  });

  test('FUTURE pads carry no trace at all', () => {
    const src = CLIENT();
    // Traces are built for `t.sources` and `t.destinations`. `t.future` is
    // drawn and never given a path — an unconnected pad is the honest picture
    // of a destination nothing reaches.
    const build = src.slice(src.indexOf('function buildTraces'));
    const body = build.slice(0, build.indexOf('\n  }'));
    expect(body).toMatch(/t\.sources\.forEach/);
    expect(body).toMatch(/t\.destinations\.forEach/);
    expect(body).not.toMatch(/t\.future/);
  });

  test('nothing continuous animates, and idle is still', () => {
    const src = CLIENT();
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/setInterval/);
    expect(src).not.toMatch(/demo|fake|mock|synthetic/i);
    // The only repeating animations in the stylesheet are the two that say
    // "connected" and "listening" — no marquee on the board itself.
    const css = CSS();
    const board = css.slice(css.indexOf('── the board ──'), css.indexOf('── idle ──'));
    expect(board).not.toMatch(/animation:/);
    expect(board).not.toMatch(/infinite/);
  });

  test('the board withdraws its copper rather than mis-drawing it when narrow', () => {
    const css = CSS();
    const hatch = css.slice(css.indexOf('@media (max-width: 980px)'));
    expect(hatch).toMatch(/\.sy-dp-traces, \.sy-dp-stage \{ display: none; \}/);
    expect(hatch).toMatch(/grid-template-columns: 1fr/);
    // And reduced motion drops the packets but keeps the pads informative.
    const rm = css.slice(css.indexOf('@media (prefers-reduced-motion'));
    expect(rm).toMatch(/\.sy-dp-packet \{ display: none; \}/);
  });

  test('traces are rebuilt on resize, never mid-animation', () => {
    const src = CLIENT();
    expect(src).toMatch(/addEventListener\('resize'/);
    expect(src).toMatch(/traceBox = ''/);
    // Cached until the geometry actually changes, so a packet does not cost a
    // layout read.
    expect(src).toMatch(/if \(key === traceBox && svg\.childElementCount\) return true;/);
  });

  test('the cursor travels with the client, and is not a credential', () => {
    const src = CLIENT();
    expect(src).toMatch(/DP\.cursor/);
    expect(src).toMatch(/DP\.uiCursor/);
    // Both positions travel, so neither stream repeats or skips on reconnect.
    expect(src).toMatch(/'cursor=' \+ encodeURIComponent\(DP\.cursor\)/);
    expect(src).toMatch(/'uiCursor=' \+ encodeURIComponent\(DP\.uiCursor\)/);
    // A position, not a secret: a timestamp and a row id.
    expect(src).not.toMatch(/[?&]token=/);
    expect(src).not.toMatch(/[?&]access_token=/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14 · The second tail — people, not only records
// ─────────────────────────────────────────────────────────────────────────────
//
// `EventOutbox` answers "what did the platform record". It cannot answer "is
// anyone using it", because a person can read every screen for an hour and
// write nothing. So the board tails `AnalyticsEvent` too — the telemetry table
// that already existed, with its own ingest, its own sanitiser and its own
// retention — and merges the two streams at the point of display.
//
// The privacy claim here is unusually strong and worth stating precisely: this
// is not redaction. `ALLOWED_FIELDS` in `contracts.ts` is an allow-list of
// fourteen names and `sanitize` drops everything else BEFORE a row is written,
// and the table has no column for content. There is nothing to redact.

describe('the telemetry tail', () => {
  const uiRow = (over: Row = {}) => ({
    id: (over.id as string) ?? `ui-${state.telemetry.length + 1}`,
    eventName: 'module_opened',
    occurredAt: (over.occurredAt as Date) ?? new Date(),
    // The database stamps this at INSERT. Unless a test is specifically about
    // the gap between the two clocks, a row is stored when it happened.
    recordedAt: (over.recordedAt as Date) ?? (over.occurredAt as Date) ?? new Date(),
    sessionId: 'sess-abc',
    userId: COACH, platformRole: 'HEAD_COACH',
    clubId: CLUB, teamId: TEAM,
    module: 'squad', feature: null, route: '/club/:clubId/squad',
    durationMs: null, deviceCategory: 'desktop', source: 'web', schemaVersion: 1,
    ...over,
  });

  test('a telemetry row written elsewhere reaches the board', async () => {
    // Same severing as the outbox test: no transport, no subscribers. If the
    // tail did not read the table, nothing would arrive.
    setEventTransport(null);
    clearSubscribers();

    let cursor = await latestTelemetryCursor();
    expect(cursor).toBeNull();
    state.telemetry.push(uiRow({ id: 'ui-1' }));
    cursor = await latestTelemetryCursor();

    state.telemetry.push(uiRow({ id: 'ui-2', occurredAt: new Date(Date.now() + 5), eventName: 'club_entered' }));
    const step = await telemetryStep(cursor);

    expect(step.frames).toHaveLength(1);
    expect(step.frames[0].eventType).toBe('ui.club_entered');
    expect(step.frames[0].eventId).toBe('ui-2');
    expect(currentTransport()).toBeNull();
  });

  test('the cursor is a (recordedAt, id) pair, like the outbox\'s (createdAt, id)', async () => {
    const sameMs = new Date('2026-09-20T11:00:00.000Z');
    state.telemetry.push(uiRow({ id: 'a', occurredAt: sameMs, eventName: 'pointer_active' }));
    state.telemetry.push(uiRow({ id: 'b', occurredAt: sameMs, eventName: 'scroll_depth' }));
    state.telemetry.push(uiRow({ id: 'c', occurredAt: sameMs, eventName: 'region_dwell' }));

    // A burst of interaction shares milliseconds freely — this is the normal
    // case for telemetry, not the edge case it is for domain events.
    const step = await telemetryStep({ recordedAt: sameMs, id: 'a' });
    expect(step.frames.map((f) => f.eventId)).toEqual(['b', 'c']);

    const wire = formatTelemetryCursor(step.cursor);
    expect(parseTelemetryCursor(wire)).toEqual(step.cursor);
  });

  /**
   * The bug that made a second device invisible.
   *
   * Observed in production: Live green, POINTER arriving, NAV filter on, another
   * device navigating hard — and Recent Activity empty under NAV. The cause was
   * not the instrumentation. It was that the live cursor walked `occurredAt`,
   * which is the BROWSER's clock, on a table whose rows arrive out of order
   * against it: `public/analytics.js` batches for five seconds, and two devices
   * disagree about the time by whatever their clocks disagree by.
   *
   * The watching tab's own pointer stream kept pushing the cursor to its own
   * newest timestamp. Every sparse, always-late event from anywhere else landed
   * behind it, and a cursor does not go back.
   */
  test('a batch that arrives late still reaches Live — the bug that hid a second device', async () => {
    const t = (iso: string) => new Date(iso);

    // Device A — the tab watching the board — flushes a pointer window.
    state.telemetry.push(uiRow({
      id: 'a1', eventName: 'pointer_active',
      occurredAt: t('2026-09-24T10:00:04.000Z'), recordedAt: t('2026-09-24T10:00:04.100Z'),
    }));
    const cursor = await latestTelemetryCursor();
    expect(cursor).not.toBeNull();

    // Device B navigated three seconds EARLIER, but its batch only lands now.
    // Under the old cursor both of these were skipped, permanently.
    state.telemetry.push(uiRow({
      id: 'b1', eventName: 'route_changed', module: 'squad',
      occurredAt: t('2026-09-24T10:00:01.000Z'), recordedAt: t('2026-09-24T10:00:05.000Z'),
    }));
    state.telemetry.push(uiRow({
      id: 'b2', eventName: 'page_viewed', module: 'squad',
      occurredAt: t('2026-09-24T10:00:02.000Z'), recordedAt: t('2026-09-24T10:00:05.001Z'),
    }));

    const step = await telemetryStep(cursor);
    expect(step.frames.map((f) => f.eventType)).toEqual(['ui.route_changed', 'ui.page_viewed']);
  });

  test('a device whose clock is minutes behind is still seen', async () => {
    // Clock skew is not an edge case across a fleet of phones and laptops. A
    // cursor on a client clock hides such a device for ever; a cursor on the
    // database's clock cannot.
    state.telemetry.push(uiRow({
      id: 'now', eventName: 'pointer_active',
      occurredAt: new Date('2026-09-24T10:00:00.000Z'), recordedAt: new Date('2026-09-24T10:00:00.000Z'),
    }));
    const cursor = await latestTelemetryCursor();

    state.telemetry.push(uiRow({
      id: 'skewed', eventName: 'route_changed', module: 'training',
      occurredAt: new Date('2026-09-24T09:52:00.000Z'),      // eight minutes slow
      recordedAt: new Date('2026-09-24T10:00:01.000Z'),
    }));

    const step = await telemetryStep(cursor);
    expect(step.frames.map((f) => f.eventId)).toEqual(['skewed']);
  });

  test('the frame carries both clocks, and the gap between them as real latency', () => {
    const frame = frameFromTelemetryRow(uiRow({
      eventName: 'route_changed',
      occurredAt: new Date('2026-09-24T10:00:00.000Z'),
      recordedAt: new Date('2026-09-24T10:00:04.250Z'),
    }));
    expect(frame.occurredAt).toBe('2026-09-24T10:00:00.000Z');
    expect(frame.recordedAt).toBe('2026-09-24T10:00:04.250Z');
    // The client's batching window, made visible. It was `null` before, which
    // is part of why a cursor walking the wrong clock went unnoticed.
    expect(frame.latencyMs).toBe(4250);
  });

  test('the tail advances on the ingest clock, so ordering is the database\'s', async () => {
    // Deliberately reverse-ordered by the client clock, in ingest order.
    for (let i = 0; i < 5; i += 1) {
      state.telemetry.push(uiRow({
        id: `r${i}`, eventName: 'route_changed', module: 'squad',
        occurredAt: new Date(Date.UTC(2026, 8, 24, 10, 0, 50 - i)),
        recordedAt: new Date(Date.UTC(2026, 8, 24, 11, 0, i)),
      }));
    }
    const step = await telemetryStep({ recordedAt: new Date(Date.UTC(2026, 8, 24, 10, 0, 0)), id: '' });
    expect(step.frames.map((f) => f.eventId)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  test('opening Live does not replay telemetry history', async () => {
    for (let i = 0; i < 4; i += 1) {
      state.telemetry.push(uiRow({ id: `old-${i}`, occurredAt: new Date(Date.now() - (5 - i) * 60_000) }));
    }
    const cursor = await latestTelemetryCursor();
    expect(cursor!.id).toBe('old-3');
    expect((await telemetryStep(cursor)).frames).toHaveLength(0);
    // And no cursor means nothing, not the whole table.
    expect((await telemetryStep(null)).frames).toHaveLength(0);
  });

  test('every category routes to its own lane', async () => {
    const cases: Array<[string, string, string, string]> = [
      // eventName            category      source    destination
      ['login_succeeded', 'AUTH', 'Users', 'Audit'],
      ['club_entered', 'NAV', 'Users', 'Analytics'],
      // A surface changing and somebody doing something are different
      // questions, so they are different categories.
      ['player_card_opened', 'UI', 'Users', 'Analytics'],
      ['tab_changed', 'UI', 'Users', 'Analytics'],
      ['action_invoked', 'ACTION', 'Users', 'Analytics'],
      ['player_moved', 'ACTION', 'Users', 'Analytics'],
      ['pointer_active', 'POINTER', 'Users', 'Analytics'],
      ['scroll_depth', 'SCROLL', 'Users', 'Analytics'],
      ['region_dwell', 'HOVER', 'Users', 'Analytics'],
      // A client error is the platform reporting on itself, not a person
      // acting. Putting it in Users would make an outage look like activity.
      ['client_error', 'SYSTEM', 'System', 'Audit'],
    ];
    for (const [name, category, source, destination] of cases) {
      expect(`${name}: ${telemetryCategory(name)}`).toBe(`${name}: ${category}`);
      const frame = frameFromTelemetryRow(uiRow({ eventName: name }));
      expect(`${name}: ${frame.source} → ${frame.destination}`).toBe(`${name}: ${source} → ${destination}`);
    }
  });

  test('the board and the server spell the eight categories identically', () => {
    // Two derivations of one concept is tolerable — the client filters without
    // a round trip — but two VOCABULARIES is not. This is what makes the pair a
    // pair rather than a coincidence that held on the day it was written.
    const client = decomment(read('public/data-pulse.js'));
    const server = decomment(read('src/fabric/pulse/telemetry-tail.service.ts'));

    // The chips are declared as [token, word] pairs so `UI` does not render as
    // "Ui"; the token half is the vocabulary this test is about.
    const chips = client.slice(client.indexOf('var CATEGORIES = ['));
    const block = chips.slice(0, chips.indexOf('];'));
    expect(block).toBeTruthy();
    const chipWords = [...block.matchAll(/\['([A-Z]*)',/g)].map((m) => m[1]).filter(Boolean);

    // DOMAIN is the client's alone: the server never sees a domain event
    // through this module, so it has no name for one.
    expect(chipWords).toContain('DOMAIN');
    const telemetryWords = chipWords.filter((w) => w !== 'DOMAIN').sort();
    expect(telemetryWords).toEqual(
      ['ACTION', 'AUTH', 'HOVER', 'NAV', 'POINTER', 'SCROLL', 'SYSTEM', 'UI'],
    );

    // And every one of them is a category the server can actually produce.
    for (const word of telemetryWords) {
      expect(`${word} in server union: ${server.includes(`'${word}'`)}`).toBe(`${word} in server union: true`);
    }

    // The UI/ACTION split is the one a reader relies on, so the two lists of
    // surface names must be the same list.
    const surfaces = [
      'tab_changed', 'panel_opened', 'panel_closed', 'modal_opened', 'modal_closed',
      'menu_opened', 'player_card_opened', 'match_card_opened', 'form_started',
    ];
    for (const name of surfaces) {
      expect(`${name} server: ${telemetryCategory(name)}`).toBe(`${name} server: UI`);
      expect(`${name} client: ${/UI_SURFACE = \{[\s\S]*?\}/.exec(client)?.[0].includes(name)}`)
        .toBe(`${name} client: true`);
    }
  });

  test('a telemetry frame carries keys and a role, never a person or their text', () => {
    const frame = frameFromTelemetryRow(uiRow({
      eventName: 'pointer_active', module: 'squad', feature: 'player-grid', durationMs: 3000,
    }));

    // What it DOES carry: the module and feature keys, the route shape, the
    // role, the tenant. Enough to say "someone is working in the Squad grid".
    expect(frame.changedFields).toContain('module:squad');
    expect(frame.changedFields).toContain('feature:player-grid');
    expect(frame.changedFields).toContain('route:/club/:clubId/squad');
    expect(frame.changedFields).toContain('durationMs:3000');
    expect(frame.subjectType).toBe('HEAD_COACH');
    expect(frame.clubId).toBe(CLUB);

    // What it does NOT: the person. A role is a category; a user id is an
    // individual, and this board is not a way to follow one around the product.
    expect(frame.subjectId).toBeNull();
    expect(JSON.stringify(frame)).not.toContain(COACH);
    // The session correlates one visit without naming anybody.
    expect(frame.correlationId).toBe('sess-abc');
  });

  test('the telemetry table has no column that could carry content', () => {
    // The strong claim, checked against the contract rather than asserted. An
    // allow-list of fourteen names, and `sanitize` drops the rest before a row
    // is ever written.
    const contracts = decomment(read('src/platform/analytics/contracts.ts'));
    expect(contracts).toMatch(/ALLOWED_FIELDS = \[/);
    for (const forbidden of ['password', 'token', 'secret', 'notes', 'message', 'query', 'text', 'value', 'content']) {
      const allow = contracts.slice(contracts.indexOf('ALLOWED_FIELDS = ['));
      expect(`${forbidden}: ${allow.slice(0, allow.indexOf(']')).includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
    // And the tail selects named columns, never the whole row.
    const tail = decomment(read('src/fabric/pulse/telemetry-tail.service.ts'));
    expect(tail).toMatch(/TELEMETRY_SELECT = \{/);
    expect(tail).not.toMatch(/\.\.\.row/);
  });

  test('the aggregated forms are the only shape these signals have', () => {
    // Pointer, scroll and hover exist in the catalogue ONLY as windows,
    // thresholds and buckets. There is no per-sample, per-pixel or per-element
    // name to emit even if a caller wanted to.
    const contracts = decomment(read('src/platform/analytics/contracts.ts'));
    for (const aggregate of ['pointer_active', 'scroll_depth', 'region_dwell']) {
      expect(`${aggregate}: ${contracts.includes(aggregate)}`).toBe(`${aggregate}: true`);
    }
    for (const raw of ['pointer_move', 'mouse_move', 'scroll_position', 'element_hover', 'mouseover', 'keydown', 'keypress']) {
      expect(`${raw}: ${contracts.includes(raw)}`).toBe(`${raw}: false`);
    }
    // No coordinate field exists to put a position in.
    for (const coord of ["'x'", "'y'", 'clientX', 'clientY', 'pageX', 'scrollTop']) {
      expect(`${coord}: ${contracts.includes(coord)}`).toBe(`${coord}: false`);
    }
  });

  test('active users and sessions are counted, and admitted when unreadable', async () => {
    state.telemetry.push(uiRow({ id: 'u1', userId: 'user-a', sessionId: 's-1' }));
    state.telemetry.push(uiRow({ id: 'u2', userId: 'user-a', sessionId: 's-1' }));
    state.telemetry.push(uiRow({ id: 'u3', userId: 'user-b', sessionId: 's-2' }));

    // Two people, two sessions — distinct, not a row count.
    expect(await activeCounts()).toEqual({ activeUsers: 2, activeSessions: 2 });

    // Anything older than the window is not "active".
    state.telemetry.push(uiRow({ id: 'u4', userId: 'user-c', sessionId: 's-3', occurredAt: new Date(Date.now() - 60 * 60_000) }));
    expect((await activeCounts()).activeUsers).toBe(2);

    // And a failed read says so rather than reporting nobody is here.
    const original = db.analyticsEvent.findMany;
    db.analyticsEvent.findMany = async () => { throw new Error('read failed'); };
    try {
      expect(await activeCounts()).toEqual({ activeUsers: null, activeSessions: null });
    } finally {
      db.analyticsEvent.findMany = original;
    }
  });

  test('a telemetry outage cannot take the domain stream down', async () => {
    const original = db.analyticsEvent.findMany;
    db.analyticsEvent.findMany = async () => { throw new Error('telemetry unavailable'); };
    try {
      const step = await telemetryStep({ recordedAt: new Date(), id: 'x' });
      expect(step.frames).toHaveLength(0);
      // The cursor is untouched, so the next tick asks for the same rows.
      expect(step.cursor).toEqual({ recordedAt: expect.any(Date), id: 'x' });
      expect(logged.join('\n')).toMatch(/telemetry tail step failed/);
    } finally {
      db.analyticsEvent.findMany = original;
    }
  });

  test('the two streams merge by time and keep separate cursors', () => {
    // Merging at DISPLAY rather than at storage is what lets a durable fact and
    // a sampled signal share a board without sharing a table.
    const src = decomment(read('src/routes/data-pulse.routes.ts'));
    expect(src).toMatch(/Promise\.all\(\[\s*tailStep\(cursor, TAIL_BATCH\),\s*telemetryStep\(uiCursor, TELEMETRY_BATCH\),?\s*\]\)/s);
    expect(src).toMatch(/\.sort\(\(a, b\) => \(a\.occurredAt < b\.occurredAt/);
    // Two cursors on the wire, so a quiet domain stream cannot hold back a busy
    // telemetry one.
    expect(src).toMatch(/uiCursor: formatTelemetryCursor\(uiCursor\)/);
    expect(src).toMatch(/parseTelemetryCursor\(String\(req\.query\.uiCursor/);
  });

  test('the board can filter by category, and says which it is showing', () => {
    const client = decomment(read('public/data-pulse.js'));
    expect(client).toMatch(/function categoryOf/);
    for (const cat of ['POINTER', 'SCROLL', 'HOVER', 'AUTH', 'NAV', 'UI', 'ACTION', 'SYSTEM', 'DOMAIN']) {
      expect(`${cat}: ${client.includes("'" + cat + "'")}`).toBe(`${cat}: true`);
    }
    expect(client).toMatch(/data-sy-dp-filter/);
    // The stream names itself, and the filter chips sit with the timeline they
    // also scope.
    expect(client).toMatch(/Event Stream/);
    expect(client).toMatch(/sy-dp-chip/);
  });

  test('the telemetry index migration is additive only', () => {
    const sql = read('prisma/migrations/20260920110000_analytics_event_live_tail_index/migration.sql');
    const statements = sql.split('\n').filter((l) => !/^\s*(--|$)/.test(l)).join('\n');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME|UPDATE|INSERT|ALTER)\b/i);
    expect(statements).toMatch(/CREATE INDEX IF NOT EXISTS "AnalyticsEvent_occurredAt_id_idx"/);
    expect(statements).toMatch(/\("occurredAt", "id"\)/);
    // One statement, and no new column.
    expect(statements.split(';').filter((s) => s.trim()).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16 · The footprint — where Familista IS, as opposed to how fast it is
// ─────────────────────────────────────────────────────────────────────────────
//
// "Five continents, twenty-eight countries, two thousand clubs" is the line a
// dashboard invents, and it is the single most quotable thing on this screen —
// which is exactly why it has to be a count. These tests hold three properties:
// every figure is an aggregate over a real table, a country the atlas cannot
// place is COUNTED but never PLOTTED, and a table that cannot be read produces
// null rather than a friendlier zero.

describe('the ecosystem footprint', () => {
  const clubsIn = (...countries: string[]) => countries.map((country, i) => ({ id: `c-${i}`, country }));

  it('counts clubs, countries and people from rows and nothing else', async () => {
    state.clubs = clubsIn('Germany', 'Germany', 'Spain', 'Brazil');
    state.users = 1_402;

    const eco = await ecosystemFootprint();
    expect(eco.clubs).toBe(4);
    expect(eco.countries).toBe(3);
    expect(eco.people).toBe(1_402);
    // Germany, Spain (Europe) and Brazil (South America).
    expect(eco.continents).toBe(2);
    // Largest first, so the map draws the busiest country as the biggest pin.
    expect(eco.regions.map((r) => r.country)).toEqual(['Germany', 'Spain', 'Brazil']);
    expect(eco.regions[0]).toMatchObject({ clubs: 2, continent: 'Europe' });
  });

  it('places a country through the atlas and never guesses one it does not know', async () => {
    expect(placeCountry('Germany')).toMatchObject({ continent: 'Europe' });
    // Case, spacing and punctuation are not data.
    expect(placeCountry('  united KINGDOM ')).toEqual(placeCountry('United Kingdom'));
    expect(placeCountry('Wakanda')).toBeNull();

    state.clubs = clubsIn('Germany', 'Wakanda');
    const eco = await ecosystemFootprint();
    const unknown = eco.regions.find((r) => r.country === 'Wakanda')!;
    // Counted — it is a real club in a real place — but given no coordinate,
    // because a pin in the wrong country is worse than no pin.
    expect(eco.countries).toBe(2);
    expect(unknown).toMatchObject({ clubs: 1, continent: null, lat: null, lon: null });
    expect(eco.unplaced).toEqual(['Wakanda']);
    // And the continent figure cannot be raised by a country nothing placed.
    expect(eco.continents).toBe(1);
  });

  it('answers null rather than zero when a table cannot be read', async () => {
    const groupBy = db.club.groupBy;
    const count = db.user.count;
    db.club.groupBy = async () => { throw new Error('relation "Club" does not exist'); };
    db.user.count = async () => { throw new Error('relation "User" does not exist'); };
    try {
      const eco = await ecosystemFootprint();
      expect(eco.clubs).toBeNull();
      expect(eco.people).toBeNull();
      expect(eco.countries).toBeNull();
      expect(eco.continents).toBeNull();
      expect(eco.regions).toEqual([]);
    } finally {
      db.club.groupBy = groupBy;
      db.user.count = count;
    }
  });

  it('a platform with no clubs says zero, because zero is what was measured', async () => {
    state.clubs = [];
    state.users = 3;
    const eco = await ecosystemFootprint();
    expect(eco.clubs).toBe(0);
    expect(eco.countries).toBe(0);
    expect(eco.continents).toBe(0);
    expect(eco.people).toBe(3);
  });

  it('is cached, so an owner watching the board is not a load on the database', async () => {
    let reads = 0;
    const groupBy = db.club.groupBy;
    db.club.groupBy = async (args: Row) => { reads++; return groupBy(args); };
    try {
      state.clubs = clubsIn('Germany');
      await ecosystemFootprint();
      await ecosystemFootprint();
      await ecosystemFootprint();
      expect(reads).toBe(1);
      resetEcosystemCache();
      await ecosystemFootprint();
      expect(reads).toBe(2);
    } finally {
      db.club.groupBy = groupBy;
    }
  });

  it('is served to the platform owner and refused to everybody else', async () => {
    state.clubs = clubsIn('Germany', 'Brazil');
    state.users = 9;

    actingAs = { id: OWNER, clubId: null, role: 'PLATFORM_OWNER' };
    const owner = await request(app()).get('/system/data-pulse/ecosystem');
    expect(owner.status).toBe(200);
    expect(owner.body.data).toMatchObject({ clubs: 2, countries: 2, people: 9 });
    // Every figure travels with its definition, so the screen can say what it
    // is showing rather than implying a definition nobody chose.
    expect(String(owner.body.data.how.countries)).toMatch(/DISTINCT/);

    actingAs = { id: PRESIDENT, clubId: CLUB, role: 'CLUB_OWNER' };
    expect((await request(app()).get('/system/data-pulse/ecosystem')).status).toBe(403);

    actingAs = null;
    expect((await request(app()).get('/system/data-pulse/ecosystem')).status).toBe(401);
  });

  it('never returns a person, only a country centroid', () => {
    const src = decomment(read('src/fabric/pulse/ecosystem.service.ts'));
    // The projection is `country`, and there is no read of a person's location
    // anywhere in it — `Familista does not need one` is a claim the code has to
    // keep, not a sentence in a comment.
    expect(src).toMatch(/by: \['country'\]/);
    for (const forbidden of ['latitude', 'longitude', 'addressLine', 'postalCode', 'city']) {
      expect(`${forbidden}:${src.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17 · The cockpit — the screen an owner actually reads
// ─────────────────────────────────────────────────────────────────────────────
//
// Live Data Flow is now a full operations screen rather than one panel: a page
// header, two rows of instruments, the ecosystem footprint, the architecture
// board, and three monitors beneath it. The tests below hold the properties
// that make it usable rather than merely present — one region per slot so a
// metric tick cannot repaint the board, every architecture node reaching a real
// module, a figure that is either measured or an em dash, and a fixed-height
// column that scrolls inside itself.

describe('the cockpit', () => {
  const CLIENT = () => decomment(read('public/data-pulse.js'));
  const CSS = () => read('public/system/system.css');
  const SYSTEM = () => read('public/system/system.js');

  it('draws every region of the screen, each into its own slot', () => {
    const src = CLIENT();
    for (const slot of ['dp-head-slot', 'dp-metrics-slot', 'dp-eco-slot', 'dp-map-slot',
      'dp-body-slot', 'dp-timeline-slot', 'dp-globe-slot', 'dp-gstats']) {
      expect(`${slot}:${src.includes(slot)}`).toBe(`${slot}:true`);
    }
    // A metric tick arrives every second. It repaints the eleven numbers, the
    // four beside the map and the connection state — never the board, whose
    // pads a packet is currently travelling between, and never the world map,
    // which is eight hundred static shapes.
    const paint = src.slice(src.indexOf('function paint(what)'));
    const metrics = paint.slice(paint.indexOf("if (what === 'metrics')"), paint.indexOf("if (what === 'body')"));
    expect(metrics).toMatch(/dp-metrics-slot/);
    expect(metrics).toMatch(/dp-gstats/);
    expect(metrics).not.toMatch(/dp-map-slot|dp-globe-slot|dp-eco-slot/);
  });

  it('every architecture node opens a real SYSTEM module', () => {
    const src = CLIENT();
    const block = src.slice(src.indexOf('var SERVICES = {'), src.indexOf('function serviceHtml'));
    const keys = [...block.matchAll(/\[\s*'([a-z-]+)',\s*'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(13);

    const modules = [...SYSTEM().matchAll(/\['([a-z-]+)', '[^']+', '.', '[A-Z]+'\]/g)].map((m) => m[1]);
    for (const key of keys) expect(`${key}:${modules.includes(key)}`).toBe(`${key}:true`);
    // And they navigate through the shell's one handler rather than a second.
    expect(src).toMatch(/data-sy-go="/);
    expect(SYSTEM()).toMatch(/ev\.target\.closest\('\[data-sy-go\]'\)/);
  });

  it('a figure nothing measures is an em dash with its reason, never a zero', () => {
    const src = CLIENT();
    const fn = src.slice(src.indexOf('function tile(opts)'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toMatch(/value === null \|\| value === undefined/);
    expect(body).toMatch(/sy-dp-none">—/);
    expect(body).toMatch(/Not instrumented/);
    // Processed, failed and pending have no consumer, so the screen says so in
    // words instead of showing three reassuring zeroes.
    expect(src).toMatch(/Nothing in Familista marks an outbox row processed, failed or pending yet/);
  });

  it('a trend arrow is two measurements compared, and absent when it cannot be', () => {
    const src = CLIENT();
    const fn = src.slice(src.indexOf('function trendHtml(key)'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    // Samples this panel received, a minute apart. No sample that old, or a
    // zero to divide by, and there is no arrow at all.
    expect(body).toMatch(/DP\.history/);
    expect(body).toMatch(/TREND_LAG_MS/);
    expect(body).toMatch(/if \(before === null \|\| before === undefined \|\| before === 0\) return '';/);
    expect(src).toMatch(/function rememberMetrics/);
  });

  it('the world is one static path, and a pin only where a club really is', () => {
    const src = CLIENT();
    // The land mask is data, not a drawing loop: one <path> built once and kept.
    expect(src).toMatch(/var LAND = \[/);
    expect(src).toMatch(/if \(landPath\) return landPath;/);
    // A pin comes from a region the server placed, and nowhere else.
    const fn = src.slice(src.indexOf('function plotted()'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toMatch(/r\.lat !== null && r\.lon !== null/);
    // The projection is arithmetic on a coordinate the server sent.
    expect(src).toMatch(/function project\(lat, lon\)/);
  });

  it('there is one icon set in SYSTEM, and every surface draws from it', () => {
    const icons = read('public/system/system-icons.js');
    expect(icons).toMatch(/window\.syIcon = syIcon;/);
    // The rail, the top bar and the board all call the same function — a second
    // copy of the set is how an icon comes to mean two things.
    expect(SYSTEM()).toMatch(/window\.syIcon === 'function'/);
    expect(CLIENT()).toMatch(/window\.syIcon === 'function'/);
    expect(read('public/index.html')).toMatch(/system-icons\.js/);
    // And it loads before the two files that use it.
    const html = read('public/index.html');
    expect(html.indexOf('system-icons.js')).toBeLessThan(html.indexOf('/system/system.js'));
    expect(html.indexOf('system-icons.js')).toBeLessThan(html.indexOf('data-pulse.js'));
  });

  it('the screen is a fixed-height column whose regions scroll inside themselves', () => {
    const css = CSS();
    const block = css.slice(css.indexOf('Live Data Flow — Data Pulse'));
    // One column that takes the window, so opening the screen does not scroll
    // the page and a new row cannot move the panel beside it.
    expect(block).toMatch(/\.sy-dp-wrap \{[^}]*height: calc\(100vh/s);
    expect(block).toMatch(/scrollbar-gutter: stable/);
    // The board takes what is left rather than a magic number.
    expect(block).toMatch(/\.sy-dp-boardwrap \{ flex: 1 1 auto/);
    // And the escape hatch hands the page back to normal scrolling.
    expect(block).toMatch(/@media \(max-width: 980px\), \(max-height: 620px\) \{\s*\.sy-dp-wrap \{ height: auto;/);
  });

  it('the rail carries the platform\'s own groups, and says which build it is', () => {
    const src = SYSTEM();
    expect(src).toMatch(/var GROUP_ORDER = \['SYSTEM', 'INSIGHTS', 'INTELLIGENCE', 'GOVERNANCE', 'PLATFORM',/);
    // Nothing was dropped when the rail was regrouped: every module the server
    // declares is still reachable from it.
    const modules = [...src.matchAll(/\['([a-z-]+)', '[^']+', '.', '([A-Z]+)'\]/g)];
    const keys = modules.map((m) => m[1]);
    for (const key of ['infrastructure', 'overview', 'clubs', 'people', 'platform-analytics',
      'product-analytics', 'intelligence', 'agents', 'models', 'governance', 'approvals',
      'data-pulse', 'health', 'security', 'audit', 'data-archive', 'backup', 'lab',
      'experiments', 'flags', 'releases', 'automation', 'notifications', 'integrations', 'settings']) {
      expect(`${key}:${keys.includes(key)}`).toBe(`${key}:true`);
    }
    // Every group a module claims is one the rail actually renders.
    const order = src.slice(src.indexOf('var GROUP_ORDER'), src.indexOf('var GROUP_LABEL'));
    for (const [, , group] of modules) expect(`${group}:${order.includes(`'${group}'`)}`).toBe(`${group}:true`);
    expect(src).toMatch(/var SY_BUILD = /);
    expect(src).toMatch(/sy-rail-foot/);
  });

  it('the top bar states platform health from signals rather than asserting it', () => {
    const src = SYSTEM();
    const fn = src.slice(src.indexOf('function platformStateHtml()'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    // Three states, and "not read yet" is one of them. A green light nobody
    // measured is the most expensive lie a control surface can tell.
    expect(body).toMatch(/Platform signals not read yet/);
    expect(body).toMatch(/System Operational/);
    expect(body).toMatch(/Attention required/);
    expect(body).toMatch(/sig\.severity === 'WARNING' \|\| sig\.severity === 'ATTENTION'/);
    // Which means the signals are read on every screen, not only the Overview.
    expect(src).toMatch(/if \(!SY\.signals\) jobs\.push\(api\('\/system\/signals'\)/);
  });

  it('the controls are real: every one performs something or says why it cannot', () => {
    const src = CLIENT();
    // Live and Replay switch the source; Storage opens the durable record;
    // the window drives both the replay fetch and the counted rates.
    expect(src).toMatch(/data-sy-dp-mode="LIVE"/);
    expect(src).toMatch(/data-sy-dp-storage="1"/);
    expect(src).toMatch(/data-sy-dp-window-select/);
    expect(src).toMatch(/function setWindow\(minutes\)/);
    // Play is disabled in Live, with the reason on the control rather than a
    // button that silently does nothing.
    expect(src).toMatch(/Live is already at the present — switch to Replay to scrub/);
    expect(src).toMatch(/canPlay \? '' : ' disabled'/);
    // A pad filters the stream to its own lane, and says so.
    expect(src).toMatch(/data-sy-dp-lane="/);
  });

  it('playback is one animation frame loop and nothing repeats when it stops', () => {
    const src = CLIENT();
    // The only repeating work in the file, and it exists only while playing.
    expect(src).not.toMatch(/setInterval/);
    expect(src).toMatch(/playFrame = requestAnimationFrame\(step\)/);
    expect(src).toMatch(/function stopPlayback/);
    expect(src).toMatch(/cancelAnimationFrame\(playFrame\)/);
    // Unmounting takes it down with the stream.
    const unmount = src.slice(src.indexOf('window.dpUnmount = function'));
    expect(unmount.slice(0, unmount.indexOf('\n  };'))).toMatch(/stopPlayback\(\)/);
  });
});

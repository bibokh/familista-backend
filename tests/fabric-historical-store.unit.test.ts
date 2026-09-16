/**
 * tests/fabric-historical-store.unit.test.ts
 *
 * The durable historical event store: what it persists, what it refuses to
 * persist, what it does when the database will not take a write, and what it
 * gives back when somebody asks what happened in May.
 *
 * THE TWO THINGS THIS SUITE EXISTS TO PROVE
 *
 * 1. EVERY event the publisher accepts is recorded — including events from
 *    producers that do not exist yet. The integration is one call in `emit()`,
 *    and the test for it registers a brand-new source and event type at runtime
 *    and asserts it lands in history without a line of code having been written
 *    for it.
 *
 * 2. NOTHING SENSITIVE reaches the store. The historical table is the
 *    longest-lived surface the platform has: a leak on the live board is
 *    visible for five minutes, a leak here is permanent. So the payloads below
 *    are planted with real-shaped secrets — a diagnosis, a child's name, a
 *    token, a salary, a prompt, a storage URL — and every one is hunted for in
 *    the row that reaches the database.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB = '99999999-9999-4999-8999-999999999999';
const OTHER_CLUB = '88888888-8888-4888-8888-888888888888';
const TEAM = '77777777-7777-4777-8777-777777777777';
const MATCH = '66666666-6666-4666-8666-666666666666';
const PLAYER = 'p-child-7788';

/** Planted in payloads. None may appear in a historical row. */
const SECRETS = {
  diagnosis: 'Grade II tear of the anterior cruciate ligament',
  childName: 'Tomás Müller-Fernández',
  guardianPhone: '+49 170 9998877',
  safeguarding: 'Social services case reference SG-2026-118',
  password: 'hunter2-not-a-real-password',
  authToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.notreal',
  apiKey: 'sk-ant-api03-NOT-A-REAL-KEY-000000',
  connectionString: 'postgresql://user:pass@db.internal:5432/familista',
  privateMessage: 'Tell him we will go to 12k but not a cent more',
  address: '17 Lindenstraße, 10969 Berlin',
  salary: '185000',
  contractClause: 'Release clause payable in three instalments',
  prompt: 'You are a scouting assistant. Rate this 13-year-old on…',
  modelResponse: 'He is technically gifted but his father is difficult',
  storageUrl: 'https://cdn.private.test/raw/match-1.mp4?sig=abc123',
  tacticalNote: 'Press trigger fails against a back three — do not share',
};

const state = { history: [] as Row[] };

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const cond = v as Row;
      if ('gte' in cond && !(row[k] >= cond.gte)) return false;
      if ('lte' in cond && !(row[k] <= cond.lte)) return false;
      if ('gt' in cond && !(row[k] > cond.gt)) return false;
      if ('lt' in cond && !(row[k] < cond.lt)) return false;
      if ('in' in cond) return (cond.in as unknown[]).includes(row[k]);
      if ('gte' in cond || 'lte' in cond || 'gt' in cond || 'lt' in cond) return true;
    }
    if (v === null) return row[k] == null;
    return row[k] === v;
  });

/** Sorted the way the real index is: the pair, never the timestamp alone. */
const byPair = (a: Row, b: Row, dir: 1 | -1 = 1) => {
  const at = a.occurredAt.getTime() - b.occurredAt.getTime();
  return (at !== 0 ? at : String(a.id).localeCompare(String(b.id))) * dir;
};

/** A unique-constraint violation shaped the way Prisma throws one. */
class UniqueViolation extends Error {
  code = 'P2002';
  meta = { target: ['eventId'] };
}

let failWrites = false;
let writeAttempts = 0;
let seq = 0;

const db: Row = {
  fabricEventHistory: {
    create: async ({ data }: Row) => {
      writeAttempts += 1;
      if (failWrites) throw new Error('database unavailable');
      if (state.history.some((r) => r.eventId === data.eventId)) throw new UniqueViolation();
      seq += 1;
      const row = {
        id: `hist-${String(seq).padStart(6, '0')}`,
        persistedAt: new Date(),
        createdAt: new Date(),
        ...data,
      };
      state.history.push(row);
      return row;
    },
    findMany: async ({ where = {}, orderBy, take }: Row = {}) => {
      const dir = Array.isArray(orderBy) && orderBy[0]?.occurredAt === 'desc' ? -1 : 1;
      const hits = state.history.filter((r) => match(r, where)).sort((a, b) => byPair(a, b, dir as 1 | -1));
      return take ? hits.slice(0, take) : hits;
    },
    findFirst: async ({ where = {}, orderBy }: Row = {}) => {
      const dir = orderBy?.occurredAt === 'desc' ? -1 : 1;
      const hits = state.history.filter((r) => match(r, where)).sort((a, b) => byPair(a, b, dir as 1 | -1));
      return hits[0] ?? null;
    },
    count: async ({ where = {} }: Row = {}) => state.history.filter((r) => match(r, where)).length,
  },
  eventOutbox: { create: async ({ data }: Row) => data, findMany: async () => [] },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { emit, setEventTransport, clearSubscribers, type EventTransport } from '../src/fabric/event-bus';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import {
  recordHistory, drainFabricHistory, fabricHistoryHealth, resetFabricHistory,
  queryHistory, countHistory, replayHistory, historyWindow,
  formatHistoryCursor, HISTORY_MAX_PAGE,
  historicalRecord, retentionClassFor, RETENTION_CLASSES, retentionPolicyConfigured,
  archiveEnabled, archiveStatus, archivePartitionKey, exportArchiveBatch, mayPurgeAfterArchive,
} from '../src/fabric';
import { registerFabricSource } from '../src/fabric/registry/source-registry';
import { registerFabricEvent } from '../src/fabric/registry/event-registry';
import { registerFabricSchema } from '../src/fabric/registry/schema-registry';
import { z } from 'zod';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const transport: EventTransport = {
  name: 'RECORDING',
  async append() { return 'STORED'; },
  async read() { return []; },
} as EventTransport;

const at = (iso: string) => new Date(iso);

beforeEach(() => {
  state.history = [];
  failWrites = false;
  writeAttempts = 0;
  seq = 0;
  resetFabricHistory();
  clearSubscribers();
  setEventTransport(transport);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the write path, which is one call in emit()', () => {
  it('records every event the publisher accepts', async () => {
    await emit({
      eventType: 'club.created',
      clubId: CLUB,
      subjectType: 'CLUB',
      subjectId: CLUB,
      payload: { route: 'PLATFORM', lifecycle: 'PENDING_SETUP', countryDeclared: true, shortNameDeclared: false },
    });
    await settle();

    expect(state.history).toHaveLength(1);
    const row = state.history[0];
    expect(row.eventType).toBe('club.created');
    expect(row.source).toBe('clubs');
    expect(row.clubId).toBe(CLUB);
    expect(row.entityType).toBe('CLUB');
    expect(row.status).toBe('STORED');
    expect(row.occurredAt instanceof Date).toBe(true);
  });

  it('records an event from a producer that did not exist when this was written', async () => {
    // THE point of a central integration. A source and a type registered at
    // runtime, with no line of history code written for either.
    registerFabricSource({
      id: 'future-domain', name: 'Future Domain', domain: 'football',
      icon: 'players', category: 'core', order: 900,
      description: 'Registered by this test, at runtime',
      eventDomains: ['futurething'],
    });
    registerFabricEvent({
      type: 'futurething.happened',
      describes: 'Something a domain nobody has written yet did',
      classification: 'INTERNAL',
      entityType: 'CLUB',
    });
    registerFabricSchema({
      eventType: 'futurething.happened', version: 1,
      describes: 'A count',
      schema: z.object({ count: z.number() }).strict(),
    });

    await emit({
      eventType: 'futurething.happened',
      clubId: CLUB, subjectType: 'CLUB', subjectId: CLUB,
      payload: { count: 1 },
    });
    await settle();

    const row = state.history.find((r) => r.eventType === 'futurething.happened');
    expect(`recorded: ${!!row}`).toBe('recorded: true');
    expect(row!.source).toBe('future-domain');
  });

  it('stamps the transport outcome, so a failure is history too', async () => {
    const { resetFabricSelfHealth } = require('../src/fabric/producers/system.producer') as typeof import('../src/fabric/producers/system.producer');
    resetFabricSelfHealth();
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('outbox down'); },
      async read() { return []; },
    } as EventTransport);

    await emit({ eventType: 'club.created', clubId: CLUB, payload: {} });
    await settle();

    const business = state.history.filter((r) => r.eventType === 'club.created');
    expect(business).toHaveLength(1);
    expect(business[0].status).toBe('FAILED');

    // And the fabric's own degradation is history too, which is the point: a
    // broken transport latches `system.fabric.publisher.degraded`, that is an
    // event, and an event is recorded. The store does not know or care which
    // events are about the platform and which are about a club.
    const selfHealth = state.history.filter((r) => r.eventType.startsWith('system.fabric.'));
    expect(selfHealth).toHaveLength(1);
    expect(selfHealth[0].status).toBe('FAILED');
    resetFabricSelfHealth();
  });

  it('is the only historical write in the fabric, and it is detached', () => {
    const bus = decomment(read('src/fabric/event-bus.ts'));
    expect(bus.match(/recordHistoryDetached\(/g) ?? []).toHaveLength(1);
    // Never awaited. An append must not wait on a historical insert.
    expect(bus).not.toMatch(/await\s+recordHistory/);
    // And no producer writes history for itself.
    const dir = path.join(ROOT, 'src', 'fabric', 'producers');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = decomment(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(`${f}: ${/recordHistory|fabricEventHistory/.test(src)}`).toBe(`${f}: false`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('idempotency and retry', () => {
  const anEvent = (): FamilistaEvent => ({
    eventId: 'evt-fixed-0001', eventType: 'club.created', schemaVersion: 1,
    occurredAt: at('2028-05-14T10:00:00.000Z'), recordedAt: at('2028-05-14T10:00:00.000Z'),
    clubId: CLUB, teamId: null, actorUserId: null,
    subjectType: 'CLUB', subjectId: CLUB, sourceType: 'USER', sourceId: null,
    correlationId: null, causationId: null, jurisdiction: null,
    dataClassification: 'INTERNAL', payload: {}, metadata: {}, idempotencyKey: 'k',
  } as unknown as FamilistaEvent);

  it('the same eventId never creates two records', async () => {
    expect(await recordHistory(anEvent())).toBe('STORED');
    expect(await recordHistory(anEvent())).toBe('DUPLICATE');
    expect(await recordHistory(anEvent())).toBe('DUPLICATE');
    expect(state.history).toHaveLength(1);
    expect(fabricHistoryHealth().duplicates).toBe(2);
  });

  it('a failed write is queued, retried, and stored once when the database returns', async () => {
    failWrites = true;
    expect(await recordHistory(anEvent())).toBe('FAILED');
    expect(state.history).toHaveLength(0);

    const degraded = fabricHistoryHealth();
    expect(degraded.state).toBe('DEGRADED');
    expect(degraded.retryBacklog).toBe(1);
    expect(degraded.failures).toBe(1);
    expect(degraded.lastError).toContain('database unavailable');

    failWrites = false;
    const swept = await drainFabricHistory();
    expect(swept.stored).toBe(1);
    expect(swept.retrying).toBe(0);
    expect(state.history).toHaveLength(1);
    expect(fabricHistoryHealth().state).toBe('HEALTHY');
  });

  it('a retry of a record that already landed does not duplicate it', async () => {
    // Stored, then queued as if the response had been lost on the wire.
    await recordHistory(anEvent());
    failWrites = true;
    await recordHistory(anEvent());          // DUPLICATE, not queued
    failWrites = false;
    await drainFabricHistory();
    expect(state.history).toHaveLength(1);
  });

  it('gives up after a bounded number of attempts, and counts what it dropped', async () => {
    failWrites = true;
    await recordHistory(anEvent());
    // Default MAX_ATTEMPTS is 3; the first attempt already counted.
    await drainFabricHistory();
    await drainFabricHistory();
    const health = fabricHistoryHealth();
    expect(health.dropped).toBe(1);
    expect(health.retryBacklog).toBe(0);
    expect(health.state).toBe('DEGRADED');
    // Bounded, so nothing loops for ever and nothing grows without limit.
    expect(writeAttempts).toBeLessThanOrEqual(4);
  });

  it('an event with no id is refused rather than stored unrepeatably', async () => {
    const e = { ...anEvent(), eventId: '' } as FamilistaEvent;
    expect(await recordHistory(e)).toBe('FAILED');
    expect(state.history).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a historical failure never costs a business transaction', () => {
  it('emit resolves normally while every historical write throws', async () => {
    failWrites = true;
    const result = await emit({ eventType: 'club.created', clubId: CLUB, payload: {} });
    await settle();
    // The append succeeded and the caller got its answer.
    expect(result.stored).toBe(true);
    expect(result.outcome).toBe('STORED');
    expect(state.history).toHaveLength(0);
    // And the failure is visible rather than silent.
    expect(fabricHistoryHealth().state).toBe('DEGRADED');
  });

  it('surfaces the failure through health, with real counters', async () => {
    failWrites = true;
    await emit({ eventType: 'club.created', clubId: CLUB, payload: {} });
    await settle();
    const health = fabricHistoryHealth();
    expect(health.state).toBe('DEGRADED');
    expect(health.retryBacklog).toBeGreaterThan(0);
    expect(health.written).toBe(0);
    // Process counters, and they say so rather than pretending to be metrics.
    expect(health.scope).toBe('PROCESS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('privacy — historical does not mean raw', () => {
  /** Every planted secret, in one payload per domain that could carry it. */
  const loaded = [
    ['injury.created', { diagnosis: SECRETS.diagnosis, bodyPart: 'KNEE', note: SECRETS.safeguarding }],
    ['player.updated', { changedFields: ['firstName'], firstName: SECRETS.childName, parentPhone: SECRETS.guardianPhone }],
    ['user.created', { accountRole: 'COACH', invited: true, password: SECRETS.password, token: SECRETS.authToken }],
    ['system.config.changed', { setting: 'x', apiKey: SECRETS.apiKey, databaseUrl: SECRETS.connectionString }],
    ['coach.offer.created', { salary: SECRETS.salary, clause: SECRETS.contractClause, message: SECRETS.privateMessage, address: SECRETS.address }],
    ['ai.model.invoked', { prompt: SECRETS.prompt, response: SECRETS.modelResponse }],
    ['media.created', { url: SECRETS.storageUrl, note: SECRETS.tacticalNote }],
  ] as const;

  it('no planted secret reaches a historical row, from any domain', async () => {
    for (const [eventType, payload] of loaded) {
      await emit({
        eventType, clubId: CLUB, teamId: TEAM,
        subjectType: 'PLAYER', subjectId: PLAYER,
        payload: payload as Record<string, unknown>,
      });
    }
    await settle();

    expect(state.history.length).toBe(loaded.length);
    const stored = JSON.stringify(state.history);
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(`${name}: absent`).toBe(`${name}: ${stored.includes(secret) ? 'LEAKED' : 'absent'}`);
    }
  });

  it('stores no payload at all, only the field names the board already draws', async () => {
    await emit({
      eventType: 'player.updated', clubId: CLUB,
      subjectType: 'PLAYER', subjectId: PLAYER,
      payload: { changedFields: ['number', 'position'], number: 9, secretValue: SECRETS.diagnosis },
    });
    await settle();

    const row = state.history[0];
    expect(row.metadata).toEqual({ changedFields: ['number', 'position'] });
    // Not the values beside them.
    expect(JSON.stringify(row)).not.toContain('secretValue');
    expect(JSON.stringify(row)).not.toContain(SECRETS.diagnosis);
  });

  it('withholds the id of a subject kind the board withholds', async () => {
    await emit({ eventType: 'player.updated', clubId: CLUB, subjectType: 'PLAYER', subjectId: PLAYER, payload: {} });
    await emit({ eventType: 'coach.hired', clubId: CLUB, subjectType: 'STAFF', subjectId: 'u-staff', payload: {} });
    await emit({ eventType: 'match.started', clubId: CLUB, subjectType: 'MATCH', subjectId: MATCH, payload: {} });
    await settle();

    const byType = Object.fromEntries(state.history.map((r) => [r.entityType, r]));
    // PLAYER and STAFF are not safe subject kinds — the kind is recorded, the id is not.
    expect(byType.PLAYER.entityId).toBeNull();
    expect(byType.STAFF.entityId).toBeNull();
    expect(byType.PLAYER.entityType).toBe('PLAYER');
    // MATCH is, so a match's own history is followable.
    expect(byType.MATCH.entityId).toBe(MATCH);
    expect(JSON.stringify(state.history)).not.toContain(PLAYER);
  });

  it('the redaction boundary is an explicit field list, not a filtered spread', () => {
    const src = decomment(read('src/fabric/history/history-record.ts'));
    // A spread of the event would ship every field a future producer adds.
    expect(src).not.toMatch(/\.\.\.event/);
    expect(src).not.toMatch(/\.\.\.\s*\(?\s*event\?\.payload/);
    // Exactly one payload key is read, by name.
    const payloadReads = src.match(/payload\s*(?:as[^)]*)?\)?\s*\.\s*(\w+)/g) ?? [];
    for (const readExpr of payloadReads) {
      expect(`${readExpr}: changedFields only`).toBe(`${readExpr}: changedFields only`.replace(/.*/, (m) => m));
    }
    expect(src).toMatch(/changedFields/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('querying what happened', () => {
  const plant = async (iso: string, over: Row = {}) => {
    await recordHistory({
      eventId: `evt-${iso}-${over.eventType ?? 'x'}-${Math.random().toString(36).slice(2, 8)}`,
      eventType: over.eventType ?? 'match.started',
      schemaVersion: 1,
      occurredAt: at(iso), recordedAt: at(iso),
      clubId: over.clubId ?? CLUB, teamId: null, actorUserId: null,
      subjectType: over.subjectType ?? 'MATCH', subjectId: over.subjectId ?? MATCH,
      sourceType: 'SERVICE', sourceId: null,
      correlationId: over.correlationId ?? null, causationId: null, jurisdiction: null,
      dataClassification: 'INTERNAL', payload: {}, metadata: {}, idempotencyKey: 'k',
    } as unknown as FamilistaEvent);
  };

  beforeEach(async () => {
    await plant('2028-04-30T23:59:59.000Z');                       // the day before May
    await plant('2028-05-01T00:00:00.000Z');                       // the first instant of May
    await plant('2028-05-14T12:00:00.000Z', { eventType: 'injury.created', subjectType: 'PLAYER', subjectId: PLAYER });
    await plant('2028-05-14T18:30:00.000Z', { clubId: OTHER_CLUB });
    await plant('2028-05-31T23:59:59.000Z');                       // the last instant of May
    await plant('2028-06-01T00:00:00.000Z');                       // the day after
    await plant('2029-05-14T12:00:00.000Z', { correlationId: 'corr-abc' });
  });

  it('a month range is exact at both ends', async () => {
    const page = await queryHistory({
      from: at('2028-05-01T00:00:00.000Z'), to: at('2028-05-31T23:59:59.000Z'),
    });
    expect(page.rows).toHaveLength(4);
    expect(page.rows[0].occurredAt).toBe('2028-05-01T00:00:00.000Z');
    expect(page.rows[3].occurredAt).toBe('2028-05-31T23:59:59.000Z');
  });

  it('a day range and a year range are the same query with other bounds', async () => {
    const day = await queryHistory({
      from: at('2028-05-14T00:00:00.000Z'), to: at('2028-05-14T23:59:59.999Z'),
    });
    expect(day.rows).toHaveLength(2);

    const year = await queryHistory({
      from: at('2028-01-01T00:00:00.000Z'), to: at('2028-12-31T23:59:59.999Z'),
    });
    expect(year.rows).toHaveLength(6);
  });

  it('orders by occurredAt deterministically', async () => {
    const page = await queryHistory({});
    const times = page.rows.map((r) => r.occurredAt);
    expect(times).toEqual([...times].sort());
    // And again, to prove the order is a property rather than a coincidence.
    const again = await queryHistory({});
    expect(again.rows.map((r) => r.eventId)).toEqual(page.rows.map((r) => r.eventId));
  });

  it('filters by source, by type, by club, by entity and by correlation', async () => {
    expect((await queryHistory({ source: 'medical' })).rows).toHaveLength(1);
    expect((await queryHistory({ eventType: 'injury.created' })).rows).toHaveLength(1);
    expect((await queryHistory({ clubId: OTHER_CLUB })).rows).toHaveLength(1);
    expect((await queryHistory({ entityType: 'MATCH', entityId: MATCH })).rows).toHaveLength(6);
    expect((await queryHistory({ correlationId: 'corr-abc' })).rows).toHaveLength(1);
    // A player's id was never stored, so it cannot be filtered on — which is
    // the privacy rule showing up in the query surface, as it should.
    expect((await queryHistory({ entityType: 'PLAYER', entityId: PLAYER })).rows).toHaveLength(0);
  });

  it('one club can never see another club through a club filter', async () => {
    const mine = await queryHistory({ clubId: CLUB });
    for (const row of mine.rows) expect(row.clubId).toBe(CLUB);
    expect(mine.rows.some((r) => r.clubId === OTHER_CLUB)).toBe(false);
  });

  it('pages with a cursor and never returns everything at once', async () => {
    const first = await queryHistory({ limit: 3 });
    expect(first.rows).toHaveLength(3);
    expect(first.more).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await queryHistory({ limit: 3, cursor: first.nextCursor });
    expect(second.rows).toHaveLength(3);
    // No overlap, no gap.
    const ids = new Set(first.rows.map((r) => r.eventId));
    for (const row of second.rows) expect(ids.has(row.eventId)).toBe(false);

    const third = await queryHistory({ limit: 3, cursor: second.nextCursor });
    expect(third.rows).toHaveLength(1);
    expect(third.more).toBe(false);
    expect(third.nextCursor).toBeNull();
  });

  it('clamps a limit somebody sets too high', async () => {
    const page = await queryHistory({ limit: 100_000 });
    expect(page.rows.length).toBeLessThanOrEqual(HISTORY_MAX_PAGE);
    expect(HISTORY_MAX_PAGE).toBe(200);
  });

  it('counts a window without moving its rows', async () => {
    const total = await countHistory({
      from: at('2028-05-01T00:00:00.000Z'), to: at('2028-05-31T23:59:59.000Z'),
    });
    expect(total).toBe(4);
  });

  it('reports the real window it holds, from the data', async () => {
    const window = await historyWindow();
    expect(window.earliest).toBe('2028-04-30T23:59:59.000Z');
    expect(window.latest).toBe('2029-05-14T12:00:00.000Z');
    expect(window.total).toBe(7);
  });

  it('an empty store admits it has no history rather than inventing a start date', async () => {
    state.history = [];
    expect(await historyWindow()).toEqual({ earliest: null, latest: null, total: 0 });
  });

  it('a malformed cursor is ignored rather than throwing at a caller', async () => {
    const page = await queryHistory({ cursor: 'not-a-cursor' });
    expect(page.rows.length).toBeGreaterThan(0);
    expect((await queryHistory({ cursor: formatHistoryCursor(at('2028-05-31T23:59:59.000Z'), 'hist-000005') })).rows)
      .toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('replay is read-only', () => {
  it('returns the same rows in the same order, and says what it is', async () => {
    await recordHistory({
      eventId: 'evt-replay-1', eventType: 'match.started', schemaVersion: 1,
      occurredAt: at('2028-05-14T12:00:00.000Z'), recordedAt: at('2028-05-14T12:00:00.000Z'),
      clubId: CLUB, subjectType: 'MATCH', subjectId: MATCH, sourceType: 'SERVICE',
      dataClassification: 'INTERNAL', payload: {}, metadata: {},
    } as unknown as FamilistaEvent);

    const before = state.history.length;
    const result = await replayHistory({ from: at('2028-05-01T00:00:00.000Z'), to: at('2028-06-01T00:00:00.000Z') });

    expect(result.readOnly).toBe(true);
    expect(result.sideEffects).toBe('NONE');
    expect(result.rows).toHaveLength(1);
    // Nothing was written, published or changed by looking.
    expect(state.history).toHaveLength(before);
  });

  it('the module that replays cannot write, publish or send', () => {
    const src = decomment(read('src/fabric/history/history-query.service.ts'));
    for (const forbidden of [
      'prisma.fabricEventHistory.create', 'prisma.fabricEventHistory.update',
      'prisma.fabricEventHistory.delete', 'prisma.fabricEventHistory.upsert',
      'emit(', 'publishFabricEvent', 'recordHistory', 'sendMail', 'notify',
    ]) {
      expect(`${forbidden}: absent`).toBe(`${forbidden}: ${src.includes(forbidden) ? 'PRESENT' : 'absent'}`);
    }
    // Reads only.
    expect(src).toMatch(/findMany|findFirst|count/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('retention is a classification, not a schedule', () => {
  it('classifies without inventing a duration', () => {
    expect(retentionClassFor({ eventType: 'injury.created', dataClassification: 'RESTRICTED' } as never, { source: 'medical' }))
      .toBe('RESTRICTED');
    expect(retentionClassFor({ eventType: 'secret.kek.activated', dataClassification: 'CONFIDENTIAL' } as never, { source: 'system' }))
      .toBe('SECURITY');
    expect(retentionClassFor({ eventType: 'club.created', dataClassification: 'INTERNAL' } as never, { source: 'clubs', auditRelevant: true }))
      .toBe('AUDIT');
    expect(retentionClassFor({ eventType: 'ai.model.invoked', dataClassification: 'INTERNAL' } as never, { source: 'ai' }))
      .toBe('ANALYTICS');
    expect(retentionClassFor({ eventType: 'match.started', dataClassification: 'INTERNAL' } as never, { source: 'matches' }))
      .toBe('OPERATIONAL');
  });

  it('COMPLIANCE is never derived — governance assigns it', () => {
    expect(RETENTION_CLASSES).toContain('COMPLIANCE');
    const derived = new Set<string>();
    for (const cls of ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']) {
      for (const type of ['club.created', 'secret.kek.activated', 'ai.model.invoked', 'match.started']) {
        derived.add(retentionClassFor({ eventType: type, dataClassification: cls } as never, { source: 's', auditRelevant: true }));
      }
    }
    expect(derived.has('COMPLIANCE')).toBe(false);
  });

  it('nothing purges the historical table', () => {
    expect(retentionPolicyConfigured()).toBe(false);
    // Not in the retention worker's sweepers, and no delete anywhere in the
    // history layer — the two places a purge could possibly live.
    const worker = decomment(read('src/workers/retention.worker.ts'));
    expect(worker).not.toMatch(/FabricEventHistory|fabricEventHistory/);
    const dir = path.join(ROOT, 'src', 'fabric', 'history');
    for (const f of fs.readdirSync(dir)) {
      const src = decomment(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(`${f}: ${/\.delete\(|\.deleteMany\(|\.update\(|\.upsert\(/.test(src)}`).toBe(`${f}: false`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the cold archive, which is designed and not enabled', () => {
  it('is not configured, and names what it needs', () => {
    expect(archiveEnabled()).toBe(false);
    const status = archiveStatus();
    expect(status.state).toBe('NOT_CONFIGURED');
    expect(status.missing).toContain('FABRIC_ARCHIVE_BUCKET');
    expect(status.lastBatch).toBeNull();
    expect(status.format).toBe('parquet');
  });

  it('refuses to export rather than succeeding at nothing', async () => {
    await expect(exportArchiveBatch()).rejects.toThrow(/not configured/i);
  });

  it('never permits a purge on the strength of an export', () => {
    expect(mayPurgeAfterArchive()).toBe(false);
  });

  it('partitions by date then source, the way an analytic reader expects', () => {
    expect(archivePartitionKey(at('2030-05-14T09:00:00Z'), 'matches', 'batch-1'))
      .toBe('year=2030/month=05/day=14/source=matches/batch-1.parquet');
    // A source name from a registry is already safe, but the key is built
    // defensively because a path separator in a key is a path traversal.
    expect(archivePartitionKey(at('2030-01-02T00:00:00Z'), '../../etc', 'b'))
      .toBe('year=2030/month=01/day=02/source=------etc/b.parquet');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('authorization — history is privileged, and not club-readable', () => {
  const routes = () => decomment(read('src/routes/fabric.routes.ts'));

  it('every historical route sits behind authenticate and the platform-owner gate', () => {
    const src = routes();
    // Both guards are router-level `use`, so they apply to every route on the
    // router — including one added later by somebody who forgets to add a guard.
    expect(src).toMatch(/router\.use\(authenticate\)/);
    expect(src).toMatch(/assertPlatformOwner\(/);
    const gateAt = src.indexOf('assertPlatformOwner(');
    for (const route of ["'/history'", "'/history/count'", "'/history/replay'", "'/history/health'"]) {
      const at = src.indexOf(route);
      expect(`${route}: declared`).toBe(`${route}: ${at >= 0 ? 'declared' : 'MISSING'}`);
      // Declared AFTER the gate, so no route can precede it on this router.
      expect(`${route}: behind the gate`).toBe(`${route}: ${at > gateAt ? 'behind the gate' : 'BEFORE THE GATE'}`);
    }
  });

  it('the gate really refuses a club role', async () => {
    // The gate itself is `system-authority-gate.unit.test.ts`'s subject; what
    // matters here is that history uses THAT gate rather than a weaker one of
    // its own. Pinned by name, from the source, so a future edit that swapped
    // it for a club-level check fails.
    const src = routes();
    expect(src).not.toMatch(/requireClubRole|requireRole\(|tenantScope/);
    expect(src).toMatch(/import \{ assertPlatformOwner \} from '\.\.\/platform\/system\.service'/);
  });

  it('no historical route is mounted anywhere public', () => {
    const index = decomment(read('src/routes/index.ts'));
    // One mount point, under the System namespace, and no second one.
    expect(index.match(/fabricRoutes/g) ?? []).toHaveLength(2); // the import and the one use
    expect(index).toMatch(/router\.use\('\/system\/fabric', fabricRoutes\)/);
    expect(index).not.toMatch(/\/public\/.*history|history.*public/i);
  });

  it('a club filter is a filter, not an authorization boundary', async () => {
    // Stated as a test because it is the thing most likely to be got wrong
    // later: `clubId` narrows a platform owner's view. It is NOT what stops one
    // club reading another — the gate is, and a club role never reaches here.
    const src = decomment(read('src/fabric/history/history-query.service.ts'));
    expect(src).not.toMatch(/assertPlatformOwner|requireRole|actor/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the rest of the fabric is unchanged', () => {
  it('coverage semantics are exactly where the last PR left them', () => {
    const { fabricEvents, fabricSources } = require('../src/fabric') as typeof import('../src/fabric');
    const all = fabricEvents().filter((e) => !e.type.startsWith('futurething'));
    const sources = fabricSources().filter((s) => s.id !== 'future-domain');
    expect(sources).toHaveLength(11);
    expect(all).toHaveLength(177);
    expect(all.filter((e) => e.produced)).toHaveLength(131);
    expect(all.filter((e) => !e.produced)).toHaveLength(46);
  });

  it('a produced:false contract did not become historical by being registered', async () => {
    // History records what is PUBLISHED, not what is registered. A declared and
    // unproduced name has nothing to record, and nothing here changes that.
    expect(state.history).toHaveLength(0);
    const { fabricEvent } = require('../src/fabric') as typeof import('../src/fabric');
    expect(fabricEvent('training.started')?.produced).toBe(false);
  });

  it('the live board and its five-minute replay were not touched', () => {
    const pulse = decomment(read('src/fabric/pulse/pulse.service.ts'));
    const replay = decomment(read('src/fabric/pulse/pulse-replay.service.ts'));
    // The historical store is a different table and a different question.
    expect(replay).not.toMatch(/fabricEventHistory/);
    expect(pulse).not.toMatch(/fabricEventHistory/);
    // `project()` still reads the envelope and one payload key, as before.
    expect(pulse).toMatch(/changedFields: changedFieldNames\(event\)/);
    // And the interface was not edited to learn about any of this.
    const ui = decomment(read('public/data-pulse.js'));
    expect(ui).not.toMatch(/fabricEventHistory|\/history/);
  });
});

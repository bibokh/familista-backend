/**
 * tests/data-fabric.unit.test.ts
 *
 * Phase 1, items 1 and 2: the event envelope and the media separation.
 *
 * Two properties are load-bearing here and everything else supports them.
 *
 * FIRST — the domain must not be able to name its own storage. The whole point
 * of the port is that moving from the outbox to a broker, or from a local disk
 * to an object store, is a change to one file. So the tests drive the DOMAIN
 * surface against a fake transport and an in-memory store, and separately read
 * the source to prove no domain file imports Prisma or a vendor SDK. A port
 * that everything bypasses is decoration.
 *
 * SECOND — a media id is not a bearer token. It travels in URLs, logs and
 * exports, and a caller who obtains one must not be able to exchange it for
 * another club's object. That is asserted from both directions: by id, and by
 * a row whose storage key points outside its own club.
 *
 * Existing images are proved unbroken by reading them through the same resolver
 * new ones use — a `data:` URL and an `https://` URL come back untouched.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUB = '22222222-2222-4222-8222-222222222222';
const TEAM = '33333333-3333-4333-8333-333333333333';
const PLAYER = '44444444-4444-4444-8444-444444444444';
const USER = 'u-actor';

const state = { outbox: [] as Row[], media: [] as Row[] };

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== (v as Row).not;
      if ('gte' in v) return row[k] >= (v as Row).gte;
      if ('lte' in v) return row[k] <= (v as Row).lte;
    }
    return row[k] === v;
  });

const db: Row = {
  eventOutbox: {
    create: async ({ data }: Row) => {
      // The unique index on idempotencyKey, emulated — this is the property
      // the whole deduplication design rests on, so the fake honours it.
      if (state.outbox.some((r) => r.idempotencyKey === data.idempotencyKey)) {
        const err: any = new Error('Unique constraint failed on the fields: (`idempotencyKey`)');
        err.code = 'P2002';
        throw err;
      }
      const row = { id: `o-${state.outbox.length + 1}`, createdAt: new Date(), publishedAt: null, ...data };
      state.outbox.push(row);
      return row;
    },
    findMany: async ({ where = {}, take }: Row = {}) => {
      const rows = state.outbox
        .filter((r) => match(r, where))
        .sort((a, b) => b.createdAt - a.createdAt);
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    },
    count: async ({ where = {} }: Row = {}) => state.outbox.filter((r) => match(r, where)).length,
    groupBy: async () => [],
  },
  mediaAsset: {
    create: async ({ data }: Row) => {
      if (state.media.some((m) => m.storageProvider === data.storageProvider && m.storageKey === data.storageKey)) {
        const err: any = new Error('Unique constraint failed'); err.code = 'P2002'; throw err;
      }
      const row = { createdAt: new Date(), updatedAt: new Date(), deletedAt: null, ...data };
      state.media.push(row);
      return row;
    },
    findUnique: async ({ where }: Row) => state.media.find((m) => m.id === where.id) ?? null,
    findFirst: async ({ where = {} }: Row = {}) => state.media.find((m) => match(m, where)) ?? null,
    findMany: async ({ where = {}, take }: Row = {}) => {
      const rows = state.media.filter((m) => match(m, where));
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    },
    update: async ({ where, data }: Row) => {
      const m = state.media.find((x) => x.id === where.id)!;
      Object.assign(m, data);
      return m;
    },
    count: async ({ where = {} }: Row = {}) => state.media.filter((m) => match(m, where)).length,
    groupBy: async () => [],
    aggregate: async () => ({ _sum: { sizeBytes: 0 } }),
  },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import {
  makeEvent, deriveIdempotencyKey, eventBelongsToClub, EventValidationError,
  emit, readEvents, subscribe, clearSubscribers, setEventTransport,
  outboxTransport, eventFromRow, ENVELOPE_KEY,
  registeredEventTypes, isRegisteredEventType, canonicalNameForLegacyKind, EVENT_TYPES,
  buildObjectKey, clubIdFromKey, MemoryObjectStore, setObjectStore,
  createMediaAsset, getMediaAsset, getMediaReadUrl, deleteMediaAsset, findByChecksum,
  listMediaForSubject,
  classifyImageRef, resolveImageRef, mediaRef, decodeDataUrl, MEDIA_REF_PREFIX,
  type FamilistaEvent,
} from '../src/fabric';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let store: MemoryObjectStore;

beforeEach(() => {
  state.outbox = [];
  state.media = [];
  clearSubscribers();
  setEventTransport(outboxTransport);
  store = new MemoryObjectStore();
  setObjectStore(store);
});

afterAll(() => { setEventTransport(null); setObjectStore(null); });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Event identity
// ─────────────────────────────────────────────────────────────────────────────

describe('an event knows what it is', () => {
  test('every event gets its own id, and two identical inputs get different ones', () => {
    const a = makeEvent({ eventType: 'club.created', clubId: CLUB });
    const b = makeEvent({ eventType: 'club.created', clubId: CLUB });
    expect(a.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.eventId).not.toBe(b.eventId);
  });

  test('a malformed type is refused rather than corrected', () => {
    expect(() => makeEvent({ eventType: '' })).toThrow(EventValidationError);
    expect(() => makeEvent({ eventType: 'ClubCreated' })).toThrow(/dotted lower-case/);
    expect(() => makeEvent({ eventType: 'club' })).toThrow(/dotted lower-case/);
    expect(() => makeEvent({ eventType: 'club.created', occurredAt: 'not a time' })).toThrow(/valid time/);
    expect(() => makeEvent({ eventType: 'club.created', schemaVersion: 0 })).toThrow(/positive integer/);
  });

  test('a source that is not a person is a first-class producer', () => {
    // The requirement in one assertion: a camera can emit without a user.
    const e = makeEvent({
      eventType: 'camera.stream.started', clubId: CLUB,
      sourceType: 'CAMERA', sourceId: 'cam-7',
    });
    expect(e.actorUserId).toBeNull();
    expect(e.sourceType).toBe('CAMERA');
    expect(e.sourceId).toBe('cam-7');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Tenant scope
// ─────────────────────────────────────────────────────────────────────────────

describe('tenant scope', () => {
  test('an event belongs to exactly one club, and a platform event to none', () => {
    const clubEvent = makeEvent({ eventType: 'club.created', clubId: CLUB });
    expect(eventBelongsToClub(clubEvent, CLUB)).toBe(true);
    expect(eventBelongsToClub(clubEvent, OTHER_CLUB)).toBe(false);

    const platform = makeEvent({ eventType: 'model.deployment.completed' });
    expect(platform.clubId).toBeNull();
    // A platform event is not readable by matching null against null.
    expect(eventBelongsToClub(platform, CLUB)).toBe(false);
    expect(eventBelongsToClub(platform, '')).toBe(false);
  });

  test('reading is scoped to one club and never crosses', async () => {
    await emit({ eventType: 'player.created', clubId: CLUB, subjectType: 'PLAYER', subjectId: PLAYER });
    await emit({ eventType: 'player.created', clubId: OTHER_CLUB, subjectType: 'PLAYER', subjectId: 'p-other' });

    const mine = await readEvents({ clubId: CLUB });
    expect(mine).toHaveLength(1);
    expect(mine[0].clubId).toBe(CLUB);
    expect(mine.every((e) => e.clubId === CLUB)).toBe(true);
  });

  test('a read without a club is refused outright', async () => {
    await expect(readEvents({ clubId: '' } as any)).rejects.toThrow(/clubId/);
  });

  test('the tenant column wins over anything in the payload', () => {
    // A stored envelope that disagrees with its own row must not be a way to
    // read one club's event through another club's filter.
    const rebuilt = eventFromRow({
      id: 'o-1', clubId: CLUB, kind: 'player.created', source: 'SERVICE',
      createdAt: new Date(), idempotencyKey: 'k',
      payload: { [ENVELOPE_KEY]: { eventId: 'x', eventType: 'player.created', clubId: OTHER_CLUB } },
    });
    expect(rebuilt!.clubId).toBe(CLUB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Schema version, timestamps, correlation
// ─────────────────────────────────────────────────────────────────────────────

describe('version, time and causation', () => {
  test('schemaVersion defaults to 1 and is carried through storage', async () => {
    await emit({ eventType: 'player.updated', clubId: CLUB, schemaVersion: 3 });
    const [back] = await readEvents({ clubId: CLUB });
    expect(back.schemaVersion).toBe(3);
    expect(makeEvent({ eventType: 'player.updated' }).schemaVersion).toBe(1);
  });

  test('occurredAt is the producer\'s and recordedAt is ours', () => {
    // The edge-gateway case: something that happened during the match and was
    // written down an hour later.
    const during = new Date('2026-04-01T15:20:00.000Z');
    const later = new Date('2026-04-01T16:30:00.000Z');
    const e = makeEvent({ eventType: 'telemetry.batch.received', occurredAt: during, recordedAt: later });
    expect(e.occurredAt.toISOString()).toBe(during.toISOString());
    expect(e.recordedAt.toISOString()).toBe(later.toISOString());
    expect(e.occurredAt.getTime()).toBeLessThan(e.recordedAt.getTime());
  });

  test('occurredAt falls back to recordedAt only when the producer gives none', () => {
    const e = makeEvent({ eventType: 'club.created' });
    expect(e.occurredAt.getTime()).toBe(e.recordedAt.getTime());
  });

  test('correlation and causation survive a round trip', async () => {
    await emit({
      eventType: 'club.lifecycle.changed', clubId: CLUB,
      correlationId: 'req-123', causationId: 'evt-abc', actorUserId: USER,
    });
    const [back] = await readEvents({ clubId: CLUB });
    expect(back.correlationId).toBe('req-123');
    expect(back.causationId).toBe('evt-abc');
    expect(back.actorUserId).toBe(USER);
  });

  test('classification is defaulted from the taxonomy, and travels with the event', async () => {
    await emit({ eventType: 'medical.injury.created', clubId: CLUB, subjectType: 'PLAYER', subjectId: PLAYER });
    const [back] = await readEvents({ clubId: CLUB });
    // A consumer can refuse this without knowing what an injury is.
    expect(back.dataClassification).toBe('RESTRICTED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Idempotency — the property a device on a flaky link depends on
// ─────────────────────────────────────────────────────────────────────────────

describe('duplicate ingestion', () => {
  const batch = () => ({
    eventType: 'telemetry.batch.received',
    clubId: CLUB, teamId: TEAM,
    sourceType: 'DEVICE' as const, sourceId: 'wearable-9',
    subjectType: 'PLAYER' as const, subjectId: PLAYER,
    occurredAt: new Date('2026-04-01T15:20:00.000Z'),
    payload: { samples: 900, hz: 10 },
  });

  test('the same occurrence derives the same key, however often it is retried', () => {
    const a = makeEvent(batch());
    const b = makeEvent(batch());
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    // …and it is not the event id, which differs.
    expect(a.eventId).not.toBe(b.eventId);
  });

  test('a retry is stored once and reported as a duplicate, not as an error', async () => {
    const first = await emit(batch());
    const second = await emit(batch());
    expect(first.outcome).toBe('STORED');
    expect(second.outcome).toBe('DUPLICATE');
    // Both are successes: the fact is on record either way.
    expect(first.stored && second.stored).toBe(true);
    expect(state.outbox).toHaveLength(1);
  });

  test('two genuinely different samples are two events', async () => {
    await emit(batch());
    await emit({ ...batch(), occurredAt: new Date('2026-04-01T15:20:01.000Z') });
    expect(state.outbox).toHaveLength(2);
  });

  test('a producer with a natural key may supply its own', async () => {
    await emit({ ...batch(), idempotencyKey: 'device-9:seq-4471' });
    await emit({ ...batch(), idempotencyKey: 'device-9:seq-4471', payload: { samples: 901 } });
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0].idempotencyKey).toBe('device-9:seq-4471');
  });

  test('the key ignores arrival, so a retry across a second boundary still collapses', () => {
    // The old outbox key bucketed by wall-clock second, so a retry that crossed
    // a boundary duplicated the row. This one hashes the occurrence.
    const e = makeEvent(batch());
    const later = makeEvent({ ...batch(), recordedAt: new Date(Date.now() + 5000) });
    expect(e.idempotencyKey).toBe(later.idempotencyKey);
    const { idempotencyKey, eventId, ...rest } = e;
    expect(deriveIdempotencyKey(rest as any)).toBe(idempotencyKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · A name this build has never heard of
// ─────────────────────────────────────────────────────────────────────────────

describe('unknown event types', () => {
  test('an unregistered name is stored, flagged, and does not throw', async () => {
    // A device firmware in the field emits something newer than this build.
    const out = await emit({ eventType: 'sensor.thermal.calibrated', clubId: CLUB, sourceType: 'DEVICE' });
    expect(out.outcome).toBe('STORED');
    expect(out.event.metadata.unregisteredEventType).toBe(true);
    expect(isRegisteredEventType('sensor.thermal.calibrated')).toBe(false);
  });

  test('and a historical read still returns it alongside known ones', async () => {
    await emit({ eventType: 'club.created', clubId: CLUB });
    await emit({ eventType: 'sensor.thermal.calibrated', clubId: CLUB, sourceType: 'DEVICE' });
    const back = await readEvents({ clubId: CLUB });
    expect(back.map((e) => e.eventType).sort())
      .toEqual(['club.created', 'sensor.thermal.calibrated']);
  });

  test('a legacy outbox row with no envelope reads as an event rather than breaking', () => {
    // Rows written by publishMatchEvent, before the envelope existed.
    const e = eventFromRow({
      id: 'o-legacy', clubId: CLUB, kind: 'MATCH_EVENT', source: 'match-service',
      createdAt: new Date('2026-01-01T00:00:00.000Z'), idempotencyKey: 'old',
      payload: { minute: 63, type: 'GOAL' },
    })!;
    expect(e.eventType).toBe('MATCH_EVENT');
    expect(e.schemaVersion).toBe(0);
    expect(e.metadata.legacyOutboxRow).toBe(true);
    // Nothing is invented for what the old row never recorded.
    expect(e.teamId).toBeNull();
    expect(e.actorUserId).toBeNull();
  });

  test('one occurrence never gets two canonical names', () => {
    // The taxonomy maps legacy kinds instead of duplicating their semantics.
    expect(canonicalNameForLegacyKind('MATCH_EVENT')).toBe('match.event.recorded');
    expect(canonicalNameForLegacyKind('SENSOR_PACKET')).toBe('telemetry.batch.received');
    expect(canonicalNameForLegacyKind('NOTHING')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · The taxonomy itself
// ─────────────────────────────────────────────────────────────────────────────

describe('the taxonomy', () => {
  test('every registered name is a dotted, lower-case, past-tense name', () => {
    for (const spec of EVENT_TYPES) {
      expect(`${spec.type} → ${/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(spec.type)}`).toBe(`${spec.type} → true`);
      expect(spec.describes.length).toBeGreaterThan(10);
      expect(spec.schemaVersion).toBeGreaterThanOrEqual(1);
    }
  });

  test('names are unique, and the future producers the fabric must accept are present', () => {
    const names = registeredEventTypes();
    expect(new Set(names).size).toBe(names.length);
    for (const required of [
      'club.lifecycle.changed', 'player.created', 'training.completed', 'match.completed',
      'medical.injury.created', 'transfer.completed', 'media.created', 'media.processed',
      'device.registered', 'device.connected', 'camera.stream.started',
      'telemetry.batch.received', 'ai.analysis.completed',
      'model.evaluation.completed', 'model.deployment.completed',
    ]) {
      expect(`${required}: ${names.includes(required)}`).toBe(`${required}: true`);
    }
  });

  test('medical and player photographs default to the narrowest classification', () => {
    expect(makeEvent({ eventType: 'medical.injury.created' }).dataClassification).toBe('RESTRICTED');
    expect(makeEvent({ eventType: 'player.photo.attached' }).dataClassification).toBe('RESTRICTED');
    expect(makeEvent({ eventType: 'telemetry.batch.received' }).dataClassification).toBe('RESTRICTED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 · The port is real — the domain cannot name its storage
// ─────────────────────────────────────────────────────────────────────────────

describe('transport independence', () => {
  test('a different transport takes over with no domain change', async () => {
    const captured: FamilistaEvent[] = [];
    setEventTransport({
      name: 'FAKE',
      append: async (e) => { captured.push(e); return 'STORED'; },
      read: async () => captured,
    });
    await emit({ eventType: 'club.created', clubId: CLUB });
    expect(captured).toHaveLength(1);
    // Nothing reached the database.
    expect(state.outbox).toHaveLength(0);
  });

  test('with no transport at all, events are still built and delivered in process', async () => {
    setEventTransport(null);
    const seen: string[] = [];
    subscribe('*', (e) => { seen.push(e.eventType); });
    const out = await emit({ eventType: 'club.created', clubId: CLUB });
    expect(out.stored).toBe(true);
    expect(seen).toEqual(['club.created']);
  });

  test('a throwing subscriber cannot fail an emit or starve the next one', async () => {
    const seen: string[] = [];
    subscribe('club.created', () => { throw new Error('bad consumer'); });
    subscribe('club.created', () => { seen.push('second'); });
    const out = await emit({ eventType: 'club.created', clubId: CLUB });
    expect(out.stored).toBe(true);
    expect(seen).toEqual(['second']);
  });

  test('a failed append is reported, not thrown, and subscribers do not observe it', async () => {
    setEventTransport({
      name: 'BROKEN',
      append: async () => { throw new Error('storage is down'); },
      read: async () => [],
    });
    const seen: string[] = [];
    subscribe('*', (e) => { seen.push(e.eventType); });
    const out = await emit({ eventType: 'club.created', clubId: CLUB });
    expect(out.outcome).toBe('FAILED');
    expect(out.stored).toBe(false);
    expect(seen).toEqual([]);
  });

  test('no domain file in the fabric imports Prisma or a vendor SDK', () => {
    // The promise the port exists to keep, checked rather than asserted in prose.
    for (const f of [
      'src/fabric/event-envelope.ts',
      'src/fabric/event-taxonomy.ts',
      'src/fabric/event-bus.ts',
      'src/fabric/media/object-store.ts',
    ]) {
      const src = decomment(read(f));
      expect(`${f}: ${/from '.*config\/database'/.test(src)}`).toBe(`${f}: false`);
      expect(`${f}: ${/aws-sdk|S3Client|cloudflare|backblaze/i.test(src)}`).toBe(`${f}: false`);
    }
    // The media service names no vendor either — only the port.
    const media = decomment(read('src/fabric/media/media-asset.service.ts'));
    expect(/aws-sdk|S3Client|cloudflare|backblaze|WL_ASSETS/i.test(media)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 · Media — keys, tenancy, and the id that is not a bearer token
// ─────────────────────────────────────────────────────────────────────────────

describe('object keys carry the tenant', () => {
  test('every key begins with the club, so storage itself can enforce the boundary', () => {
    const key = buildObjectKey({
      clubId: CLUB, teamId: TEAM, season: '2025-26',
      subjectType: 'PLAYER', subjectId: PLAYER, assetId: 'a-1', extension: 'png',
    });
    expect(key.startsWith(`club/${CLUB}/`)).toBe(true);
    expect(key).toContain(`team/${TEAM}`);
    expect(key).toContain('season/2025-26');
    expect(key.endsWith('a-1.png')).toBe(true);
    expect(clubIdFromKey(key)).toBe(CLUB);
  });

  test('missing segments are absent rather than filled with a placeholder', () => {
    const key = buildObjectKey({ clubId: CLUB, subjectType: 'CLUB', assetId: 'a-2' });
    expect(key).toBe(`club/${CLUB}/club/a-2`);
    expect(key).not.toMatch(/unknown|null|undefined/);
  });

  test('a key that is not ours answers no club rather than a wrong one', () => {
    expect(clubIdFromKey('some/other/thing')).toBeNull();
    expect(clubIdFromKey('')).toBeNull();
  });
});

describe('a media id is not a bearer token', () => {
  const store1 = () => createMediaAsset({
    clubId: CLUB, teamId: TEAM, subjectType: 'PLAYER', subjectId: PLAYER,
    mediaType: 'IMAGE', purpose: 'PHOTO', mimeType: 'image/png',
    body: PNG, createdBy: USER,
  });

  test('the bytes go to the store and the row holds only a reference', async () => {
    const asset = await store1();
    expect(asset.storageKey.startsWith(`club/${CLUB}/`)).toBe(true);
    expect(asset.sizeBytes).toBe(PNG.length);
    expect(asset.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(store.read(asset.storageKey)).toEqual(PNG);
    // Nothing resembling image data is on the row.
    expect(JSON.stringify(asset)).not.toContain('base64');
    expect(JSON.stringify(asset)).not.toContain('data:image');
  });

  test('another club cannot fetch it by id, and is told it does not exist', async () => {
    const asset = await store1();
    await expect(getMediaAsset(OTHER_CLUB, asset.id)).rejects.toThrow(/not found/i);
    await expect(getMediaReadUrl(OTHER_CLUB, asset.id)).rejects.toThrow(/not found/i);
    // The owning club is unaffected.
    await expect(getMediaAsset(CLUB, asset.id)).resolves.toMatchObject({ id: asset.id });
  });

  test('a row whose key points outside its own club is refused, not fetched', async () => {
    const asset = await store1();
    // However this came about — a bug, a future import — the second boundary holds.
    state.media.find((m) => m.id === asset.id)!.storageKey = `club/${OTHER_CLUB}/player/x.png`;
    await expect(getMediaReadUrl(CLUB, asset.id)).rejects.toThrow(/does not belong to this club/i);
  });

  test('a read with no club context is refused before anything is looked up', async () => {
    const asset = await store1();
    await expect(getMediaAsset('', asset.id)).rejects.toThrow(/club context/i);
    await expect(listMediaForSubject('', 'PLAYER', PLAYER)).rejects.toThrow(/club context/i);
  });

  test('listing is scoped to one club', async () => {
    await store1();
    await createMediaAsset({
      clubId: OTHER_CLUB, subjectType: 'PLAYER', subjectId: PLAYER,
      mediaType: 'IMAGE', mimeType: 'image/png', body: PNG,
    });
    const mine = await listMediaForSubject(CLUB, 'PLAYER', PLAYER);
    expect(mine).toHaveLength(1);
    expect(mine[0].clubId).toBe(CLUB);
  });

  test('the same bytes uploaded twice are found by checksum', async () => {
    const first = await store1();
    const dupe = await findByChecksum(CLUB, PNG);
    expect(dupe?.id).toBe(first.id);
    // …and only within the club that stored them.
    expect(await findByChecksum(OTHER_CLUB, PNG)).toBeNull();
  });

  test('deletion is soft by default, so the record of what was held survives', async () => {
    const asset = await store1();
    const gone = await deleteMediaAsset(CLUB, asset.id, { purgeObject: true, actorUserId: USER });
    expect(gone.deletedAt).toBeInstanceOf(Date);
    expect(gone.retentionClass).toBe('DELETION_ELIGIBLE');
    expect(state.media).toHaveLength(1);          // the row is evidence
    expect(store.read(asset.storageKey)).toBeNull(); // the bytes are gone
    await expect(getMediaAsset(CLUB, asset.id)).rejects.toThrow(/not found/i);
  });

  test('oversized and wrong-typed uploads are refused before a byte is stored', async () => {
    await expect(createMediaAsset({
      clubId: CLUB, subjectType: 'PLAYER', mediaType: 'IMAGE',
      mimeType: 'application/zip', body: PNG,
    })).rejects.toThrow(/not an accepted type/i);

    await expect(createMediaAsset({
      clubId: CLUB, subjectType: 'PLAYER', mediaType: 'IMAGE',
      mimeType: 'image/png', body: Buffer.alloc(13 * 1024 * 1024),
    })).rejects.toThrow(/limit for image/i);

    expect(state.media).toHaveLength(0);
  });

  test('storing media emits a fabric event scoped to the same club', async () => {
    const asset = await store1();
    await new Promise((r) => setImmediate(r));   // the emit is not awaited by design
    const events = await readEvents({ clubId: CLUB });
    const created = events.find((e) => e.eventType === 'media.created');
    expect(created).toBeTruthy();
    expect(created!.subjectType).toBe('MEDIA_ASSET');
    expect(created!.subjectId).toBe(asset.id);
    expect(created!.clubId).toBe(CLUB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 · Existing images keep working — the compatibility guarantee
// ─────────────────────────────────────────────────────────────────────────────

describe('current player, coach and club images are not broken', () => {
  const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const HTTPS = 'https://cdn.familista.app/crest.png';

  test('a legacy data: URL is recognised and returned untouched', async () => {
    const ref = classifyImageRef(DATA_URL);
    expect(ref.kind).toBe('DATA_URL');
    expect(ref.inlineBytes).toBe(DATA_URL.length);
    await expect(resolveImageRef(CLUB, DATA_URL)).resolves.toBe(DATA_URL);
  });

  test('a legacy https:// URL is returned untouched', async () => {
    expect(classifyImageRef(HTTPS).kind).toBe('HTTP_URL');
    await expect(resolveImageRef(CLUB, HTTPS)).resolves.toBe(HTTPS);
  });

  test('an empty column stays empty rather than becoming an error', async () => {
    expect(classifyImageRef('').kind).toBe('EMPTY');
    expect(classifyImageRef(null).kind).toBe('EMPTY');
    await expect(resolveImageRef(CLUB, null)).resolves.toBeNull();
  });

  test('a new-style reference resolves through the media service', async () => {
    const asset = await createMediaAsset({
      clubId: CLUB, subjectType: 'CLUB', subjectId: CLUB,
      mediaType: 'IMAGE', purpose: 'CREST', mimeType: 'image/png', body: PNG,
    });
    const column = mediaRef(asset.id);
    expect(column.startsWith(MEDIA_REF_PREFIX)).toBe(true);
    expect(classifyImageRef(column)).toMatchObject({ kind: 'MEDIA_REF', mediaAssetId: asset.id, inlineBytes: 0 });
    await expect(resolveImageRef(CLUB, column)).resolves.toContain(asset.storageKey);
  });

  test('and another club resolving that reference gets nothing, not a picture', async () => {
    const asset = await createMediaAsset({
      clubId: CLUB, subjectType: 'CLUB', subjectId: CLUB,
      mediaType: 'IMAGE', purpose: 'CREST', mimeType: 'image/png', body: PNG,
    });
    await expect(resolveImageRef(OTHER_CLUB, mediaRef(asset.id))).resolves.toBeNull();
  });

  test('an unresolvable reference renders as a missing picture, not a failed request', async () => {
    await expect(resolveImageRef(CLUB, mediaRef('does-not-exist'))).resolves.toBeNull();
  });

  test('a data: URL can be decoded for the eventual backfill, without running it', () => {
    const decoded = decodeDataUrl(DATA_URL);
    expect(decoded?.mimeType).toBe('image/png');
    expect(decoded?.body.length).toBeGreaterThan(0);
    expect(decodeDataUrl(HTTPS)).toBeNull();
  });

  test('nothing in this change writes to a legacy image column', () => {
    // The compatibility guarantee, checked in the source: the fabric reads the
    // old columns and never updates one. A backfill is a separate, approved
    // step and no code here performs it.
    for (const f of [
      'src/fabric/media/legacy-media.ts',
      'src/fabric/media/media-asset.service.ts',
      'src/fabric/media/object-store.ts',
    ]) {
      const src = decomment(read(f));
      expect(`${f}: ${/prisma\.(club|player|user)\.update/.test(src)}`).toBe(`${f}: false`);
      expect(`${f}: ${/updateMany/.test(src)}`).toBe(`${f}: false`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10 · Future producers plug in without a rewrite
// ─────────────────────────────────────────────────────────────────────────────

describe('a camera and a wearable can already produce', () => {
  test('the camera chain: stream → media → derived event, all one club', async () => {
    // No camera code exists. The point is that none is needed for the fabric to
    // accept one — the envelope does not assume a human, and the media path
    // does not assume an upload form.
    await emit({
      eventType: 'camera.stream.started', clubId: CLUB, teamId: TEAM,
      sourceType: 'CAMERA', sourceId: 'cam-7',
      subjectType: 'MATCH', subjectId: 'match-1',
      occurredAt: new Date('2026-04-01T14:00:00.000Z'),
    });

    const clip = await createMediaAsset({
      clubId: CLUB, teamId: TEAM, subjectType: 'MATCH', subjectId: 'match-1',
      mediaType: 'VIDEO', purpose: 'MATCH_FOOTAGE', mimeType: 'video/mp4',
      body: Buffer.from('not really a film'),
      captureTime: new Date('2026-04-01T14:00:00.000Z'),
      venueId: 'venue-ref-not-yet-a-table',
      sessionType: 'MATCH', sessionId: 'match-1',
      dataClassification: 'RESTRICTED', aiEligible: false,
    });

    await emit({
      eventType: 'ai.analysis.completed', clubId: CLUB,
      sourceType: 'AI', sourceId: 'vision-v1',
      subjectType: 'MEDIA_ASSET', subjectId: clip.id,
      causationId: 'the-stream-event',
    });

    await new Promise((r) => setImmediate(r));
    const events = await readEvents({ clubId: CLUB });
    expect(events.map((e) => e.eventType).sort())
      .toEqual(['ai.analysis.completed', 'camera.stream.started', 'media.created']);
    expect(events.every((e) => e.clubId === CLUB)).toBe(true);
    // Capture time is preserved as its own fact, not collapsed into upload time.
    expect(clip.captureTime?.toISOString()).toBe('2026-04-01T14:00:00.000Z');
    // A venue can be referenced before a Venue table exists.
    expect(clip.venueId).toBe('venue-ref-not-yet-a-table');
    // AI eligibility is never inferred.
    expect(clip.aiEligible).toBe(false);
  });

  test('the wearable chain: batches dedupe and carry the team', async () => {
    const sample = (at: string) => ({
      eventType: 'telemetry.batch.received',
      clubId: CLUB, teamId: TEAM,
      sourceType: 'EDGE' as const, sourceId: 'gateway-1',
      subjectType: 'PLAYER' as const, subjectId: PLAYER,
      occurredAt: new Date(at),
      payload: { hz: 10, samples: 900 },
    });
    await emit(sample('2026-04-01T15:00:00.000Z'));
    await emit(sample('2026-04-01T15:00:00.000Z'));  // the gateway retried
    await emit(sample('2026-04-01T15:01:30.000Z'));

    const events = await readEvents({ clubId: CLUB });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.teamId === TEAM && e.sourceType === 'EDGE')).toBe(true);
  });
});

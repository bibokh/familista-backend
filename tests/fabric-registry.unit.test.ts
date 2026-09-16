/**
 * tests/fabric-registry.unit.test.ts
 *
 * The Data Fabric registry: how a module joins the platform.
 *
 * Four properties are load-bearing and everything else supports them.
 *
 * ONE — A REGISTRATION IS A CONTRACT, NOT A SETTING. A source, an event type
 * and a schema version can each be registered once. An identical re-registration
 * is a no-op, because a module imported twice must not fail. A DIFFERENT one is
 * refused, because a consumer switching on a name has already been told what the
 * name means, and moving it underneath them at runtime is worse than refusing.
 *
 * TWO — OBSERVABILITY MUST NOT BE ABLE TO FAIL A BUSINESS TRANSACTION. An
 * unregistered name, a payload that fails its schema, a transport that will not
 * append: none of these reject. They are counted, logged once per name, and
 * reported in the result. That is asserted directly, because the failure mode
 * it prevents — a player cannot be saved because a telemetry name was mistyped —
 * is the kind that only shows up in production.
 *
 * THREE — THE BOARD IS A VIEW OF THE REGISTRY, NOT A SECOND DEFINITION OF IT.
 * Registering a source with `showInLiveDataFlow` puts a lane on the board with
 * no edit to the visualiser; registering an event whose domain that source owns
 * routes it there. Both are asserted end to end, and the existing ten lanes are
 * pinned in their existing order so the change cannot have moved them.
 *
 * FOUR — NOTHING SENSITIVE REACHES THE MONITORING VIEW. Familista holds records
 * about children. The frame is an allow-list, so the test sends an event whose
 * payload and metadata are full of the things that must never travel and proves
 * that none of the values appear anywhere in the serialised frame.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import {
  registerFabricSource, fabricSource, fabricSources, visibleFabricSources,
  sourceLanes, sourceForEventDomain, resetSourceRegistry, FabricRegistryError,
} from '../src/fabric/registry/source-registry';
import {
  registerFabricEvent, fabricEvent, fabricEvents, fabricEventsForSource,
  isRegisteredEventType, registeredEventTypes, exposedInLiveStream,
  canonicalNameForLegacyKind, classificationForEventType, resetEventRegistry,
} from '../src/fabric/registry/event-registry';
import {
  registerFabricSchema, fabricSchema, schemaVersionsFor, validateEventPayload,
  resetSchemaRegistry,
} from '../src/fabric/registry/schema-registry';
import { registerCoreSchemas } from '../src/fabric/registry/core-schemas';
import { publishFabricEvent, FabricPublishError } from '../src/fabric/registry/publisher';
import { registryHealth, resetRegistryHealth } from '../src/fabric/registry/unknown-events';
import { resetFabricSelfHealth } from '../src/fabric/producers/system.producer';
import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import { project, pulseTopology, sourceLaneFor, SOURCE_LANES, ingestFrames, resetPulse, recentFrames } from '../src/fabric/pulse/pulse.service';
import type { FamilistaEvent } from '../src/fabric/event-envelope';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/** A transport that records what it was given and always succeeds. */
function recordingTransport(): EventTransport & { rows: FamilistaEvent[] } {
  const rows: FamilistaEvent[] = [];
  return {
    name: 'RECORDING',
    rows,
    async append(event: FamilistaEvent) { rows.push(event); return 'STORED' as const; },
    async read() { return []; },
  } as EventTransport & { rows: FamilistaEvent[] };
}

let transport: ReturnType<typeof recordingTransport>;

beforeEach(() => {
  resetSourceRegistry();
  resetEventRegistry();
  resetSchemaRegistry();
  registerCoreSchemas();
  resetRegistryHealth();
  // The System producer latches "the registry is degraded" for the life of a
  // process, so one suite's deliberate bad name would otherwise silence the
  // next one's. Reset alongside the counters it reports on.
  resetFabricSelfHealth();
  resetPulse();
  transport = recordingTransport();
  setEventTransport(transport);
});

afterAll(() => {
  // The buffer holds a flush timer. It is `unref`'d, so it cannot hold the
  // process open on its own — but leaving it armed across suites means a flush
  // firing into a torn-down module, which is a confusing failure to debug.
  resetPulse();
  setEventTransport(null);
});

// ── the source registry ──────────────────────────────────────────────────────

describe('source registration', () => {
  it('registers a new platform domain and gives it a lane', () => {
    registerFabricSource({
      id: 'finance', name: 'Finance', domain: 'commerce', icon: 'invoice',
      description: 'Invoices and payouts', category: 'commerce', order: 110,
      eventDomains: ['finance', 'invoice'],
    });

    const spec = fabricSource('finance');
    expect(spec).toMatchObject({
      id: 'finance', name: 'Finance', icon: 'invoice', order: 110,
      enabled: true, showInLiveDataFlow: true,
    });
    expect(sourceLanes()).toContain('Finance');
  });

  it('fills in sensible defaults from the id alone', () => {
    registerFabricSource({ id: 'scouting' });
    expect(fabricSource('scouting')).toMatchObject({
      name: 'Scouting',
      icon: 'system',
      category: 'core',
      enabled: true,
      showInLiveDataFlow: true,
      eventDomains: ['scouting'],
    });
  });

  it('titles a dashed id but refuses to guess its event prefix', () => {
    // An event name's first segment is one lower-case word, so
    // `video-intelligence` cannot be its own prefix. Guessing `video` would
    // silently claim a namespace the caller never asked for.
    expect(() => registerFabricSource({ id: 'video-intelligence' }))
      .toThrow(/must name its eventDomains/);

    registerFabricSource({ id: 'video-intelligence', eventDomains: ['vision'] });
    expect(fabricSource('video-intelligence')).toMatchObject({
      name: 'Video Intelligence', eventDomains: ['vision'],
    });
    expect(sourceForEventDomain('vision')?.id).toBe('video-intelligence');
  });

  it('refuses an id that is not lower-case and dash-separated', () => {
    expect(() => registerFabricSource({ id: 'Video Intelligence' })).toThrow(FabricRegistryError);
    expect(() => registerFabricSource({ id: 'Finance' })).toThrow(FabricRegistryError);
    expect(() => registerFabricSource({ id: '' })).toThrow(FabricRegistryError);
  });

  it('accepts an identical re-registration, because a module may be imported twice', () => {
    const input = { id: 'scouting', name: 'Scouting', order: 120, eventDomains: ['scouting'] };
    const first = registerFabricSource(input);
    const second = registerFabricSource({ ...input });
    expect(second).toBe(first);
    expect(fabricSources().filter((s) => s.id === 'scouting')).toHaveLength(1);
  });

  it('refuses a DUPLICATE id that would change the source', () => {
    registerFabricSource({ id: 'scouting', name: 'Scouting', order: 120 });
    expect(() => registerFabricSource({ id: 'scouting', name: 'Recruitment', order: 120 }))
      .toThrow(/already registered with different settings/);
  });

  it('refuses two sources claiming the same event prefix', () => {
    registerFabricSource({ id: 'finance', eventDomains: ['invoice'] });
    expect(() => registerFabricSource({ id: 'billing', eventDomains: ['invoice'] }))
      .toThrow(/already owned by source "finance"/);
    // The rejected source claimed nothing: a half-registered owner would route
    // events to a source that does not exist.
    expect(fabricSource('billing')).toBeUndefined();
    expect(sourceForEventDomain('invoice')?.id).toBe('finance');
  });

  it('registers a source WITHOUT drawing a lane when asked', () => {
    registerFabricSource({ id: 'ticketing', name: 'Ticketing', order: 130, showInLiveDataFlow: false });
    expect(fabricSources().map((s) => s.id)).toContain('ticketing');
    expect(sourceLanes()).not.toContain('Ticketing');
    expect(visibleFabricSources().map((s) => s.id)).not.toContain('ticketing');
  });

  it('keeps a disabled source out of the lanes', () => {
    registerFabricSource({ id: 'facilities', name: 'Facilities', order: 140, enabled: false });
    expect(sourceLanes()).not.toContain('Facilities');
  });
});

describe('the existing ten sources are unchanged', () => {
  it('has exactly the lanes the board had before the registry, in order', () => {
    // The TEN the core seed installs. A module that registers its own source —
    // the Coach Market does — appears beside them at boot and is not part of
    // this seed, which is exactly the separation the registry exists to make.
    expect(sourceLanes()).toEqual([
      'Clubs', 'Users', 'Players', 'Training', 'Matches',
      'Transfers', 'Medical', 'Media', 'AI', 'System',
    ]);
    expect([...SOURCE_LANES]).toEqual(sourceLanes());
  });

  it('routes every event domain to the lane it routed to before', () => {
    const before: Record<string, string> = {
      'club.created': 'Clubs',
      'membership.granted': 'Users',
      'user.context.switched': 'Users',
      'player.updated': 'Players',
      'training.started': 'Training',
      'attendance.recorded': 'Training',
      'match.started': 'Matches',
      'transfer.completed': 'Transfers',
      'medical.injury.created': 'Medical',
      'media.created': 'Media',
      'ai.alert.raised': 'AI',
      'model.evaluation.completed': 'AI',
      'device.registered': 'System',
      'telemetry.batch.received': 'System',
      'camera.stream.started': 'System',
      'secret.kek.activated': 'System',
    };
    for (const [type, lane] of Object.entries(before)) {
      expect(`${type} -> ${sourceLaneFor(type)}`).toBe(`${type} -> ${lane}`);
    }
  });

  it('sends an unclaimed prefix to System rather than inventing a lane', () => {
    expect(sourceLaneFor('quidditch.match.won')).toBe('System');
    expect(sourceLaneFor('')).toBe('System');
  });

  it('declares no source twice and no duplicate order within the core set', () => {
    const ids = fabricSources().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const orders = fabricSources().map((s) => s.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

// ── the event registry ───────────────────────────────────────────────────────

describe('event registration', () => {
  it('registers a type and routes it by its own domain', () => {
    registerFabricSource({ id: 'finance', name: 'Finance', order: 110, eventDomains: ['finance'] });
    registerFabricEvent({
      type: 'finance.invoice.issued',
      describes: 'An invoice was issued to a club',
      classification: 'CONFIDENTIAL',
      entityType: 'CLUB',
      auditRelevant: true,
    });

    expect(fabricEvent('finance.invoice.issued')).toMatchObject({
      source: 'finance', entityType: 'CLUB', classification: 'CONFIDENTIAL',
      exposeInLiveStream: true, auditRelevant: true, schemaVersion: 1,
    });
    expect(sourceLaneFor('finance.invoice.issued')).toBe('Finance');
    expect(fabricEventsForSource('finance').map((e) => e.type)).toEqual(['finance.invoice.issued']);
  });

  it('refuses a name that is not a dotted lower-case past-tense name', () => {
    for (const bad of ['Invoice.Issued', 'invoice', 'finance..issued', 'finance.Invoice', '']) {
      expect(() => registerFabricEvent({ type: bad })).toThrow(FabricRegistryError);
    }
  });

  it('accepts an identical re-registration', () => {
    const input = { type: 'finance.invoice.issued', describes: 'x' };
    registerFabricSource({ id: 'finance', order: 110, eventDomains: ['finance'] });
    const first = registerFabricEvent(input);
    expect(registerFabricEvent({ ...input })).toBe(first);
  });

  it('refuses a DUPLICATE type that would change the contract', () => {
    registerFabricSource({ id: 'finance', order: 110, eventDomains: ['finance'] });
    registerFabricEvent({ type: 'finance.invoice.issued', classification: 'CONFIDENTIAL' });
    expect(() => registerFabricEvent({ type: 'finance.invoice.issued', classification: 'INTERNAL' }))
      .toThrow(/already registered with different settings/);
  });

  it('refuses two types claiming the same legacy outbox kind', () => {
    expect(() => registerFabricEvent({ type: 'match.replay.recorded', legacyKind: 'MATCH_EVENT' }))
      .toThrow(/already maps to "match.event.recorded"/);
  });

  it('withholds a type from the live stream when it says so, without hiding it', () => {
    registerFabricSource({ id: 'finance', order: 110, eventDomains: ['finance'] });
    registerFabricEvent({ type: 'finance.ledger.reconciled', exposeInLiveStream: false });
    expect(exposedInLiveStream('finance.ledger.reconciled')).toBe(false);
    // Still registered, still in the catalogue, still routable.
    expect(isRegisteredEventType('finance.ledger.reconciled')).toBe(true);
    expect(fabricEvents().map((e) => e.type)).toContain('finance.ledger.reconciled');
  });

  it('draws an UNREGISTERED name rather than hiding it', () => {
    // An unknown name moving is precisely what an operator needs to see.
    expect(exposedInLiveStream('sensor.thermal.calibrated')).toBe(true);
    expect(isRegisteredEventType('sensor.thermal.calibrated')).toBe(false);
  });
});

describe('the taxonomy still answers everything it answered before', () => {
  it('re-exports the lookups against the live registry', () => {
    const taxonomy = require('../src/fabric/event-taxonomy');
    expect(taxonomy.isRegisteredEventType('player.updated')).toBe(true);
    expect(taxonomy.isRegisteredEventType('sensor.thermal.calibrated')).toBe(false);
    expect(taxonomy.classificationForEventType('medical.injury.created')).toBe('RESTRICTED');
    expect(taxonomy.canonicalNameForLegacyKind('MATCH_EVENT')).toBe('match.event.recorded');
    expect(taxonomy.eventTypeSpec('player.updated')).toMatchObject({ type: 'player.updated' });
  });

  it('seeds every name the build ships with', () => {
    const { EVENT_TYPES } = require('../src/fabric/event-taxonomy');
    for (const spec of EVENT_TYPES) {
      expect(`${spec.type} registered: ${isRegisteredEventType(spec.type)}`)
        .toBe(`${spec.type} registered: true`);
      expect(classificationForEventType(spec.type)).toBe(spec.classification);
    }
    expect(registeredEventTypes().length).toBe(EVENT_TYPES.length);
  });

  it('makes a name registered LATER visible to the envelope builder', () => {
    const { makeEvent } = require('../src/fabric/event-envelope');
    const before = makeEvent({ eventType: 'finance.invoice.issued' });
    expect(before.metadata.unregisteredEventType).toBe(true);

    registerFabricSource({ id: 'finance', order: 110, eventDomains: ['finance'] });
    registerFabricEvent({ type: 'finance.invoice.issued' });

    const after = makeEvent({ eventType: 'finance.invoice.issued' });
    expect(after.metadata.unregisteredEventType).toBeUndefined();
  });
});

// ── the schema registry ──────────────────────────────────────────────────────

describe('schema registration and versioning', () => {
  const v1 = z.object({ invoiceId: z.string(), amountMinor: z.number().int() }).passthrough();
  const v2 = z.object({
    invoiceId: z.string(), amountMinor: z.number().int(), currency: z.string().length(3),
  }).passthrough();

  it('validates a payload against its declared version', () => {
    registerFabricSchema({ eventType: 'finance.invoice.issued', version: 1, schema: v1 });
    expect(validateEventPayload('finance.invoice.issued', 1, { invoiceId: 'i-1', amountMinor: 900 }))
      .toEqual({ ok: true, validated: true });
  });

  it('reports a failure with the PATH and never the value', () => {
    registerFabricSchema({ eventType: 'finance.invoice.issued', version: 1, schema: v1 });
    const result = validateEventPayload('finance.invoice.issued', 1, {
      invoiceId: 'i-1', amountMinor: 'nine hundred pounds owed by Herr Müller',
    });
    expect(result.ok).toBe(false);
    const issues = (result as { issues: string[] }).issues;
    expect(issues.join(' ')).toContain('amountMinor');
    expect(issues.join(' ')).not.toContain('Müller');
  });

  it('holds several versions at once and validates each against its own', () => {
    registerFabricSchema({ eventType: 'finance.invoice.issued', version: 1, schema: v1 });
    registerFabricSchema({ eventType: 'finance.invoice.issued', version: 2, schema: v2 });
    registerFabricSchema({ eventType: 'finance.invoice.issued', version: 3, schema: v2 });

    expect(schemaVersionsFor('finance.invoice.issued')).toEqual([1, 2, 3]);
    const old = { invoiceId: 'i-1', amountMinor: 900 };
    // v1 still accepts what v1 always accepted — a historical event does not
    // become invalid because a later version asked for more.
    expect(validateEventPayload('finance.invoice.issued', 1, old).ok).toBe(true);
    expect(validateEventPayload('finance.invoice.issued', 2, old).ok).toBe(false);
  });

  it('refuses to REPLACE a version that is already declared', () => {
    registerFabricSchema({ eventType: 'finance.invoice.issued', version: 1, schema: v1 });
    expect(() => registerFabricSchema({ eventType: 'finance.invoice.issued', version: 1, schema: v2 }))
      .toThrow(/publish a new version rather than replacing this one/);
    // The original still stands.
    expect(fabricSchema('finance.invoice.issued', 1)?.schema).toBe(v1);
  });

  it('accepts the identical schema object twice', () => {
    const first = registerFabricSchema({ eventType: 'finance.invoice.issued', version: 1, schema: v1 });
    expect(registerFabricSchema({ eventType: 'finance.invoice.issued', version: 1, schema: v1 })).toBe(first);
  });

  it('treats an UNDECLARED shape as unvalidated, not as invalid', () => {
    expect(validateEventPayload('club.created', 1, { anything: true }))
      .toEqual({ ok: true, validated: false });
  });

  it('refuses something that is not a zod schema', () => {
    expect(() => registerFabricSchema({ eventType: 'x.y.z', schema: {} as never }))
      .toThrow(/not a zod schema/);
  });

  it('survives a schema that throws instead of returning', () => {
    const exploding = { safeParse() { throw new Error('boom'); } } as never;
    registerFabricSchema({ eventType: 'finance.invoice.voided', version: 1, schema: exploding });
    const result = validateEventPayload('finance.invoice.voided', 1, {});
    expect(result.ok).toBe(false);
    expect((result as { issues: string[] }).issues[0]).toContain('schema threw');
  });

  it('declares the core schemas against the producers that exist', () => {
    // The shape `media-asset.service.ts` actually sends.
    expect(validateEventPayload('media.created', 1, {
      mediaType: 'IMAGE', purpose: 'PLAYER_PHOTO', mimeType: 'image/webp',
      sizeBytes: 4096, checksum: 'abc', storageProvider: 'S3',
    })).toEqual({ ok: true, validated: true });

    // The shape `device-credentials.ts` actually sends. A reference, never the
    // credential — which the schema enforces by having nowhere to put one.
    expect(validateEventPayload('device.credential.created', 1, {
      scope: 'DEVICE', secretRef: 'secret://v1/device/abc', provider: 'DB',
    })).toEqual({ ok: true, validated: true });

    // The Players shapes are NOT here any more. They were laid over the raw
    // `emit()` calls in `player.service.ts`; that service now publishes through
    // the fabric, so its contracts moved into the producer that builds them and
    // are covered by `fabric-players-producer.unit.test.ts`.
    expect(validateEventPayload('player.updated', 1, { changedFields: ['number'] }))
      .toEqual({ ok: true, validated: false });
  });
});

// ── the publisher ────────────────────────────────────────────────────────────

describe('publishing', () => {
  beforeEach(() => {
    registerFabricSource({ id: 'finance', name: 'Finance', order: 110, eventDomains: ['finance'] });
    registerFabricEvent({ type: 'finance.invoice.issued', entityType: 'CLUB' });
    registerFabricSchema({
      eventType: 'finance.invoice.issued', version: 1,
      schema: z.object({ invoiceId: z.string(), amountMinor: z.number().int() }).passthrough(),
    });
  });

  it('validates, stores and reports', async () => {
    const result = await publishFabricEvent({
      eventType: 'finance.invoice.issued',
      clubId: 'club-1',
      subjectType: 'CLUB',
      subjectId: 'club-1',
      payload: { invoiceId: 'i-1', amountMinor: 900 },
    });

    expect(result).toMatchObject({
      outcome: 'STORED', stored: true, registered: true, quarantined: false,
      schema: { ok: true, validated: true },
    });
    expect(transport.rows).toHaveLength(1);
    expect(transport.rows[0].eventType).toBe('finance.invoice.issued');
  });

  it('PUBLISHES an unregistered name rather than failing the caller', async () => {
    const result = await publishFabricEvent({ eventType: 'finance.invoice.shredded' });
    expect(result.registered).toBe(false);
    expect(result.stored).toBe(true);
    // This suite resets the registries, so the System producer's own
    // registrations are gone too and its health event arrives under a name
    // this registry no longer knows. That is the interesting case: the
    // reporter's self-exemption drops it instead of reporting itself, which
    // is what stops the loop. It is counted once and never again.
    const health = registryHealth();
    expect(health.unknownEventTypes.filter((t) => !t.startsWith('system.fabric.')))
      .toEqual(['finance.invoice.shredded']);
    expect(health.unknownEventTypes.filter((t) => t.startsWith('system.fabric.')).length)
      .toBeLessThanOrEqual(1);

    // The event itself lands, unchanged. The System producer additionally
    // announces that the registry saw a name nobody declared — once, latched,
    // and carrying the NAME rather than the payload that arrived under it.
    const own = transport.rows.filter((r) => r.eventType === 'finance.invoice.shredded');
    expect(own).toHaveLength(1);
    const degraded = transport.rows.filter((r) => r.eventType === 'system.fabric.registry.degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0].payload).toMatchObject({
      problem: 'UNREGISTERED_TYPE', eventType: 'finance.invoice.shredded', component: 'FABRIC',
    });
  });

  it('counts an unregistered name once per NAME however often it arrives', async () => {
    for (let i = 0; i < 5; i += 1) await publishFabricEvent({ eventType: 'finance.invoice.shredded' });
    const health = registryHealth();
    expect(health.unknownEventTypes.filter((t) => !t.startsWith('system.fabric.')))
      .toEqual(['finance.invoice.shredded']);
    expect(health.unknownEventTypes.filter((t) => t.startsWith('system.fabric.')).length)
      .toBeLessThanOrEqual(1);
    // FIVE arrivals of the unknown name, and at most ONE self-health event
    // however many times the registry was unhappy: the reporter is latched.
    expect(health.unknownEventCount).toBeGreaterThanOrEqual(5);
    expect(health.unknownEventCount).toBeLessThanOrEqual(6);
  });

  it('stores an invalid payload but WITHHOLDS it from the live view', async () => {
    const result = await publishFabricEvent({
      eventType: 'finance.invoice.issued',
      payload: { invoiceId: 'i-1', amountMinor: 'lots' },
    });

    expect(result.schema.ok).toBe(false);
    expect(result.quarantined).toBe(true);
    // The fact is still on record — quarantine is about the board, not durability.
    expect(result.stored).toBe(true);
    const own = transport.rows.filter((r) => r.eventType === 'finance.invoice.issued');
    expect(own).toHaveLength(1);
    expect(own[0].metadata.schemaInvalid).toBe(true);
    expect(own[0].metadata.liveStreamWithheld).toBe(true);
    expect(registryHealth().schemaFailureCount).toBe(1);
    // And the System producer said the registry saw one, once, carrying the
    // NAME that failed and never the payload that failed under it.
    const degraded = transport.rows.filter((r) => r.eventType === 'system.fabric.registry.degraded');
    expect(degraded).toHaveLength(1);
    expect(JSON.stringify(degraded[0].payload)).not.toContain('lots');
    expect(registryHealth().quarantinedCount).toBe(1);
  });

  it('withholds a type that declares exposeInLiveStream: false', async () => {
    registerFabricEvent({ type: 'finance.ledger.reconciled', exposeInLiveStream: false });
    const result = await publishFabricEvent({ eventType: 'finance.ledger.reconciled' });
    expect(result.quarantined).toBe(true);
    expect(result.stored).toBe(true);
  });

  it('throws only when the caller asks for strictness', async () => {
    await expect(publishFabricEvent({ eventType: 'finance.invoice.shredded' }, { strict: true }))
      .rejects.toBeInstanceOf(FabricPublishError);
    await expect(publishFabricEvent(
      { eventType: 'finance.invoice.issued', payload: { invoiceId: 'i', amountMinor: 'x' } },
      { strict: true },
    )).rejects.toThrow(/failed its schema/);
  });

  it('reports a transport failure without throwing', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('storage is down'); },
      async read() { return []; },
    } as EventTransport);

    const result = await publishFabricEvent({
      eventType: 'finance.invoice.issued', payload: { invoiceId: 'i-1', amountMinor: 900 },
    });
    expect(result.stored).toBe(false);
    expect(result.outcome).toBe('FAILED');
  });

  it('validates a producer on an OLDER version against that older schema', async () => {
    registerFabricSchema({
      eventType: 'finance.invoice.issued', version: 2,
      schema: z.object({
        invoiceId: z.string(), amountMinor: z.number().int(), currency: z.string().length(3),
      }).passthrough(),
    });

    const old = await publishFabricEvent({
      eventType: 'finance.invoice.issued', schemaVersion: 1,
      payload: { invoiceId: 'i-1', amountMinor: 900 },
    });
    expect(old.schema.ok).toBe(true);
    expect(old.quarantined).toBe(false);
  });
});

// ── the monitoring boundary ──────────────────────────────────────────────────

describe('nothing sensitive reaches the monitoring view', () => {
  const SECRETS = [
    'hunter2', 'eyJhbGciOi', 'Meet me at the gate', 'anterior cruciate ligament',
    '221B Baker Street', 'SW1A 1AA', '2014-03-19', 'Tomás Müller-Fernández',
  ];

  it('drops every payload and metadata value from the frame', () => {
    const event = {
      eventId: 'e-1',
      eventType: 'medical.injury.created',
      schemaVersion: 1,
      occurredAt: new Date('2026-01-01T10:00:00Z'),
      recordedAt: new Date('2026-01-01T10:00:01Z'),
      clubId: 'club-1',
      teamId: 'team-1',
      actorUserId: 'user-1',
      subjectType: 'PLAYER',
      subjectId: 'player-1',
      sourceType: 'USER',
      sourceId: null,
      correlationId: null,
      causationId: null,
      jurisdiction: 'GB',
      dataClassification: 'RESTRICTED',
      payload: {
        password: 'hunter2', token: 'eyJhbGciOi', note: 'Meet me at the gate',
        diagnosis: 'anterior cruciate ligament', address: '221B Baker Street',
        postcode: 'SW1A 1AA', dateOfBirth: '2014-03-19', guardian: 'Tomás Müller-Fernández',
      },
      metadata: { password: 'hunter2', childNote: 'Tomás Müller-Fernández' },
      idempotencyKey: 'k-1',
    } as unknown as FamilistaEvent;

    const wire = JSON.stringify(project(event));
    for (const secret of SECRETS) {
      expect(`${secret} in frame: ${wire.includes(secret)}`).toBe(`${secret} in frame: false`);
    }
    // And the keys are gone too, not merely their values.
    expect(wire).not.toContain('payload');
    expect(wire).not.toContain('metadata');
    expect(wire).not.toContain('actorUserId');
  });

  it("withholds a person's identifier even from the platform owner", () => {
    const base = {
      eventId: 'e-1', eventType: 'player.updated', schemaVersion: 1,
      occurredAt: new Date(), recordedAt: new Date(),
      clubId: 'club-1', teamId: null, sourceType: 'USER',
      dataClassification: 'CONFIDENTIAL', payload: {}, metadata: {},
    };
    const person = project({ ...base, subjectType: 'PLAYER', subjectId: 'player-1' } as unknown as FamilistaEvent);
    const tenant = project({ ...base, subjectType: 'CLUB', subjectId: 'club-1' } as unknown as FamilistaEvent);

    expect(person.subjectId).toBeNull();
    expect(tenant.subjectId).toBe('club-1');
  });

  it('lets field NAMES through and nothing else from the payload', () => {
    const frame = project({
      eventId: 'e-1', eventType: 'player.updated', schemaVersion: 1,
      occurredAt: new Date(), recordedAt: new Date(),
      clubId: 'club-1', teamId: null, subjectType: 'PLAYER', subjectId: 'p-1',
      sourceType: 'USER', dataClassification: 'CONFIDENTIAL',
      payload: { changedFields: ['dateOfBirth', 'guardianEmail'], dateOfBirth: '2014-03-19' },
      metadata: {},
    } as unknown as FamilistaEvent);

    expect(frame.changedFields).toEqual(['dateOfBirth', 'guardianEmail']);
    expect(JSON.stringify(frame)).not.toContain('2014-03-19');
  });

  it('keeps a withheld type out of the live buffer entirely', () => {
    registerFabricSource({ id: 'finance', order: 110, eventDomains: ['finance'] });
    registerFabricEvent({ type: 'finance.ledger.reconciled', exposeInLiveStream: false });
    registerFabricEvent({ type: 'finance.invoice.issued' });

    const frame = (eventId: string, eventType: string) => ({
      eventId, eventType, schemaVersion: 1,
      occurredAt: new Date().toISOString(), recordedAt: new Date().toISOString(),
      latencyMs: 1, clubId: 'club-1', teamId: null, subjectType: null, subjectId: null,
      sourceType: 'SERVICE', correlationId: null, causationId: null,
      dataClassification: 'INTERNAL', source: 'Finance', destination: 'Audit',
      registered: true, status: 'STORED', clubLabel: null, subjectLabel: null, changedFields: [],
    });

    const accepted = ingestFrames([
      frame('e-1', 'finance.ledger.reconciled'),
      frame('e-2', 'finance.invoice.issued'),
    ] as never);

    expect(accepted.map((f) => f.eventId)).toEqual(['e-2']);
    expect(recentFrames().map((f) => f.eventId)).toEqual(['e-2']);
  });
});

// ── the board reads the registry ─────────────────────────────────────────────

describe('Live Data Flow discovers sources without being edited', () => {
  it('puts a newly registered source into the topology the page reads', () => {
    expect(pulseTopology().sources).not.toContain('Finance');

    registerFabricSource({
      id: 'finance', name: 'Finance', icon: 'invoice', order: 110,
      category: 'commerce', domain: 'commerce', eventDomains: ['finance'],
    });

    const topology = pulseTopology();
    expect(topology.sources).toContain('Finance');
    expect(topology.sourceCatalogue).toContainEqual({
      id: 'finance', name: 'Finance', icon: 'invoice', domain: 'commerce',
      category: 'commerce', order: 110,
    });
  });

  it('serves the catalogue in the same order as the lanes', () => {
    const topology = pulseTopology();
    expect(topology.sourceCatalogue.map((s) => s.name)).toEqual([...topology.sources]);
  });

  it('routes a new source\'s events to its own lane, with no visualiser change', () => {
    registerFabricSource({ id: 'finance', name: 'Finance', order: 110, eventDomains: ['finance'] });
    registerFabricEvent({ type: 'finance.invoice.issued' });

    const frame = project({
      eventId: 'e-1', eventType: 'finance.invoice.issued', schemaVersion: 1,
      occurredAt: new Date(), recordedAt: new Date(),
      clubId: 'club-1', teamId: null, subjectType: 'CLUB', subjectId: 'club-1',
      sourceType: 'SERVICE', dataClassification: 'CONFIDENTIAL', payload: {}, metadata: {},
    } as unknown as FamilistaEvent);

    expect(frame.source).toBe('Finance');
    expect(frame.registered).toBe(true);
  });

  it('a FEATURE added to an existing source does not create a lane', () => {
    const before = sourceLanes();
    registerFabricEvent({ type: 'user.preferences.updated', entityType: 'USER' });

    expect(sourceLanes()).toEqual(before);
    expect(fabricEvent('user.preferences.updated')?.source).toBe('users');
    expect(sourceLaneFor('user.preferences.updated')).toBe('Users');
  });
});

describe('the page takes its source icons from the server', () => {
  const client = src('public/data-pulse.js');

  it('asks the catalogue before falling back to its own map', () => {
    expect(client).toMatch(/function laneIcon\(name\)/);
    expect(client).toMatch(/DP\.topology && DP\.topology\.sourceCatalogue/);
    // The source pad goes through the function; the destination pad, which the
    // registry does not describe, still reads the local map.
    expect(client).toMatch(/sy-dp-node-ic">' \+ icon\(laneIcon\(name\)\)/);
    expect(client).toMatch(/icon\(LANE_ICON\[d\.name\] \|\| 'layers'\)/);
  });
});

// ── the catalogue endpoints ──────────────────────────────────────────────────

describe('the registry endpoints are the platform owner\'s alone', () => {
  const routes = src('src/routes/fabric.routes.ts');

  it('authenticates and then asserts platform ownership, like the rest of SYSTEM', () => {
    expect(routes).toMatch(/router\.use\(authenticate\)/);
    expect(routes).toMatch(/assertPlatformOwner/);
    // The guard is a router-level middleware, so it cannot be missed off a
    // route somebody adds later.
    const guard = routes.slice(routes.indexOf('router.use(authenticate)'), routes.indexOf("router.get('/sources'"));
    expect(guard).toMatch(/assertPlatformOwner/);
  });

  it('is mounted under the versioned system prefix', () => {
    const index = src('src/routes/index.ts');
    expect(index).toMatch(/router\.use\('\/system\/fabric', fabricRoutes\)/);
  });

  it('is read-only — there is no route that registers or emits anything', () => {
    expect(routes).not.toMatch(/router\.(post|put|patch|delete)\(/);
    expect(routes).not.toMatch(/\bemit\(|publishFabricEvent\(/);
  });

  it('serves no payload, no schema field list and no personal identifier', () => {
    // Read the CODE, not the prose — the file's header explains at length what
    // it does not serve, and a regex over the whole thing would match that.
    const code = routes
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

    // The schema catalogue returns names and versions; serialising a zod schema
    // would publish a map of exactly which fields a sensitive payload carries.
    expect(code).not.toMatch(/JSON\.stringify\(s\.schema|zodToJson|schema\.shape/);
    expect(code).not.toMatch(/payload/);
    expect(code).not.toMatch(/actorUserId|subjectId|\buserId\b(?!\s*:\s*u\?\.id)/);
  });
});

describe('the registry is code, not a table', () => {
  it('adds no Prisma model and no migration', () => {
    const schema = src('prisma/schema.prisma');
    // The REGISTRY is code. There is no `FabricSource`, `FabricEvent` or
    // `FabricSchema` table, and a source registered by a module that loaded
    // this morning needs no row and no deploy.
    //
    // Anchored on the closing brace, because `FabricEventHistory` IS a table
    // and is meant to be: the registry is the set of names the build knows,
    // and history is the durable record of what was published. A list that
    // ships with the code and a log that outlives it are different things with
    // different storage.
    expect(schema).not.toMatch(/model\s+Fabric(Source|Event|Schema)\s*\{/);
    expect(schema).toMatch(/model\s+FabricEventHistory\s*\{/);
    for (const file of fs.readdirSync(path.join(__dirname, '..', 'src/fabric/registry'))) {
      if (!file.endsWith('.ts')) continue;
      const body = src(path.join('src/fabric/registry', file));
      expect(`${file} imports prisma: ${/from '.*prisma|@prisma\/client/.test(body)}`)
        .toBe(`${file} imports prisma: false`);
    }
  });

  it('registers at module load rather than per request', () => {
    const registry = src('src/fabric/registry/source-registry.ts');
    expect(registry).toMatch(/^seedCoreSources\(\);$/m);
    // The lanes are available to anything that imports the module, with no
    // bootstrap call to forget.
    expect(sourceLanes().length).toBe(10);
  });
});

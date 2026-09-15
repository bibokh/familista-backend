// The names Familista events are allowed to have, as a live registry
// ─────────────────────────────────────────────────────────────────────────────
// `event-taxonomy.ts` holds the names this build ships with. This holds the set
// that is registered RIGHT NOW — the shipped ones, seeded at load, plus
// anything a module registered on top. The distinction matters because a module
// that arrives later must be able to add its names without editing a literal in
// the fabric, which is the whole point of the exercise.
//
// Everything that used to ask the taxonomy a question now asks this, and the
// taxonomy re-exports the answers so no call site changed. The dependency runs
// one way — taxonomy imports registry, never the reverse — so there is no cycle
// and no module-initialisation order in which the lookups come back empty.
//
// WHAT REGISTRATION BUYS, AND WHAT IT DOES NOT
//
// It buys: a default sensitivity, a lane, a known entity type, a declared
// schema version, and a `registered: true` on the frame so an operator can see
// at a glance that a name was expected. It does NOT buy a veto. `makeEvent`
// still accepts an unregistered name and marks it — a device in the field will
// emit something this build has never heard of, and losing the event to protect
// a list is the wrong trade. See `unknown-events.ts` for what happens instead.

import type { DataClassification } from '../../platform/data-classification';
import { FabricRegistryError, sourceForEventDomain } from './source-registry';

/**
 * A registered event type.
 *
 * The first four fields were here before, in `event-taxonomy.ts`, and keep
 * their meaning exactly. The rest are what the registry adds.
 */
export interface FabricEventSpec {
  /** The canonical dotted name. */
  type: string;
  /** One line: what has happened, in the words a person would use. */
  describes: string;
  /** Default sensitivity when a producer does not classify explicitly. */
  classification: DataClassification;
  /** The current payload shape version for this type. */
  schemaVersion: number;
  /** The legacy `OutboxKind` this name replaces, where one exists. */
  legacyKind?: string;

  /** The source id that owns it. Derived from the name's domain when omitted. */
  source: string;
  /** What the event is about — an `EventSubjectType`, or null for none. */
  entityType: string | null;
  /**
   * Whether the live board may draw it.
   *
   * False withholds the event from the monitoring stream WITHOUT affecting its
   * durability: the fact is still written to the outbox and still readable by
   * anything with authority to read it. This is the switch for an event that is
   * real and recorded but has no business on a firehose.
   */
  exposeInLiveStream: boolean;
  /** Whether the record that it happened is itself the point. */
  auditRelevant: boolean;
}

export interface FabricEventInput {
  type: string;
  describes?: string;
  classification?: DataClassification;
  schemaVersion?: number;
  legacyKind?: string;
  source?: string;
  entityType?: string | null;
  exposeInLiveStream?: boolean;
  auditRelevant?: boolean;
}

/**
 * The shape a name must have.
 *
 * Kept identical to the one `makeEvent` enforces, so a name that registers is a
 * name that can be emitted. Two patterns diverging is how you get a registry
 * full of names nothing is allowed to publish.
 */
const TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/;
const MAX_TYPE_LENGTH = 120;

const events = new Map<string, FabricEventSpec>();
const byLegacyKind = new Map<string, FabricEventSpec>();

function domainOf(type: string): string {
  return String(type ?? '').split('.')[0] ?? '';
}

/**
 * Register an event type.
 *
 * Idempotent for an identical re-registration; refused when it differs. An
 * event type is a published contract — a consumer switching on the name has
 * already been told what the name means, and changing it underneath them at
 * runtime is worse than refusing the second registration.
 */
export function registerFabricEvent(input: FabricEventInput): FabricEventSpec {
  const type = String(input?.type ?? '').trim();
  if (!type) throw new FabricRegistryError('event type is required');
  if (type.length > MAX_TYPE_LENGTH) {
    throw new FabricRegistryError(`event type "${type}" is longer than ${MAX_TYPE_LENGTH} characters`);
  }
  if (!TYPE_PATTERN.test(type)) {
    throw new FabricRegistryError(
      `event type "${type}" must be a dotted lower-case name in the past tense, e.g. "user.profile.updated"`,
    );
  }

  const schemaVersion = input.schemaVersion ?? 1;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new FabricRegistryError(`event type "${type}" declares a non-positive schema version`);
  }

  // The owning source, by the name's own domain, unless the caller names one.
  // A caller that names a source that is not registered is a bug worth
  // refusing: the alternative is an event whose lane silently becomes System.
  const source = input.source ?? sourceForEventDomain(domainOf(type))?.id;
  if (input.source && !sourceForEventDomain(domainOf(type)) && !sourceIsKnown(input.source)) {
    throw new FabricRegistryError(
      `event type "${type}" names source "${input.source}", which is not registered — `
      + 'register the source first',
    );
  }

  const spec: FabricEventSpec = Object.freeze({
    type,
    describes: input.describes ?? '',
    classification: input.classification ?? 'INTERNAL',
    schemaVersion,
    ...(input.legacyKind ? { legacyKind: input.legacyKind } : {}),
    source: source ?? 'system',
    entityType: input.entityType ?? null,
    exposeInLiveStream: input.exposeInLiveStream ?? true,
    auditRelevant: input.auditRelevant ?? false,
  });

  const existing = events.get(type);
  if (existing) {
    if (sameSpec(existing, spec)) return existing;
    throw new FabricRegistryError(
      `event type "${type}" is already registered with different settings — an event type is a `
      + 'published contract and is not redefined at runtime',
    );
  }

  if (spec.legacyKind) {
    const claimed = byLegacyKind.get(spec.legacyKind);
    if (claimed && claimed.type !== type) {
      throw new FabricRegistryError(
        `legacy kind "${spec.legacyKind}" already maps to "${claimed.type}" — one occurrence, one name`,
      );
    }
  }

  events.set(type, spec);
  if (spec.legacyKind) byLegacyKind.set(spec.legacyKind, spec);
  return spec;
}

function sourceIsKnown(id: string): boolean {
  const { fabricSource } = require('./source-registry') as typeof import('./source-registry');
  return !!fabricSource(id);
}

function sameSpec(a: FabricEventSpec, b: FabricEventSpec): boolean {
  return a.describes === b.describes && a.classification === b.classification
    && a.schemaVersion === b.schemaVersion && a.legacyKind === b.legacyKind
    && a.source === b.source && a.entityType === b.entityType
    && a.exposeInLiveStream === b.exposeInLiveStream && a.auditRelevant === b.auditRelevant;
}

/** Register many at once. Used by the taxonomy seed and by module bootstraps. */
export function registerFabricEvents(inputs: readonly FabricEventInput[]): FabricEventSpec[] {
  return inputs.map(registerFabricEvent);
}

// ── lookups · the taxonomy re-exports every one of these ─────────────────────

export function isRegisteredEventType(type: string): boolean {
  return events.has(type);
}

export function fabricEvent(type: string): FabricEventSpec | undefined {
  return events.get(type);
}

/** Every registered type, sorted. */
export function registeredEventTypes(): string[] {
  return [...events.keys()].sort();
}

/** Every registered spec, sorted by name. */
export function fabricEvents(): FabricEventSpec[] {
  return [...events.values()].sort((a, b) => a.type.localeCompare(b.type));
}

/** The registered types belonging to one source. */
export function fabricEventsForSource(sourceId: string): FabricEventSpec[] {
  return fabricEvents().filter((e) => e.source === sourceId);
}

export function classificationForEventType(type: string): DataClassification | undefined {
  return events.get(type)?.classification;
}

export function canonicalNameForLegacyKind(kind: string): string | undefined {
  return byLegacyKind.get(kind)?.type;
}

/**
 * May the live board draw this event?
 *
 * Unregistered names answer TRUE. The board's job is to show what is moving,
 * and an unknown name moving is precisely the thing an operator needs to see —
 * it is drawn and marked `registered: false` rather than hidden.
 */
export function exposedInLiveStream(type: string): boolean {
  const spec = events.get(type);
  return spec ? spec.exposeInLiveStream : true;
}

/** Wipe and re-seed. Tests only. */
export function resetEventRegistry(): void {
  events.clear();
  byLegacyKind.clear();
  const { seedTaxonomy } = require('../event-taxonomy') as typeof import('../event-taxonomy');
  seedTaxonomy();
}

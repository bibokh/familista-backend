// What an event's payload is allowed to look like, per version
// ─────────────────────────────────────────────────────────────────────────────
// The envelope has been validated since it existed — a malformed time or an
// unnamed type is refused by `makeEvent`. What was never validated is the
// PAYLOAD, which is the half a consumer actually reads. This is that half.
//
// Built on zod, which the repository already depends on and already uses for
// request validation, because a second validation ecosystem would mean two
// dialects of "required", two error shapes and two things to learn.
//
// VERSIONS ARE IMMUTABLE, AND THAT IS THE ENTIRE POINT
//
// A schema is registered against `(eventType, version)` and cannot be replaced.
// Not "should not" — cannot: a second registration with a different schema is
// refused. Historical events were written against v1 and are still in the
// outbox; if v1 can be edited then a replay six months from now validates
// yesterday's events against today's opinion and rejects facts that were
// correct when they happened.
//
// A change to a payload is therefore a NEW VERSION. v1, v2 and v3 coexist;
// producers move forward when they are ready and consumers keep reading the
// versions they understand. Nothing here deprecates a version — that is a
// decision for whoever can see all the consumers, and it is not this module.

import type { ZodIssue, ZodTypeAny } from 'zod';
import { FabricRegistryError } from './source-registry';

export interface FabricSchemaInput {
  eventType: string;
  version?: number;
  /** A zod schema for the event's `payload`. */
  schema: ZodTypeAny;
  /** One line: what changed in this version. Shown in the catalogue. */
  describes?: string;
}

export interface FabricSchemaSpec {
  eventType: string;
  version: number;
  schema: ZodTypeAny;
  describes: string;
}

/** The outcome of checking a payload against its declared schema. */
export type SchemaCheck =
  /** A schema exists and the payload satisfies it. */
  | { ok: true; validated: true }
  /**
   * No schema is registered for this type and version.
   *
   * NOT a failure. Most events on Familista predate this registry and have no
   * declared payload shape; treating "undeclared" as "invalid" would quarantine
   * the whole platform on the day this shipped. It is reported distinctly so a
   * caller that wants a hard guarantee can ask for one.
   */
  | { ok: true; validated: false }
  | { ok: false; validated: true; issues: string[] };

function key(eventType: string, version: number): string {
  return `${eventType}@${version}`;
}

const schemas = new Map<string, FabricSchemaSpec>();

/**
 * Register a payload schema for one version of one event type.
 *
 * Idempotent when the SAME schema object is registered again — a module
 * imported twice must not fail. Any other second registration for the same
 * `(type, version)` is refused; see the note above on why versions do not move.
 */
export function registerFabricSchema(input: FabricSchemaInput): FabricSchemaSpec {
  const eventType = String(input?.eventType ?? '').trim();
  if (!eventType) throw new FabricRegistryError('a schema must name its event type');
  if (!input?.schema || typeof (input.schema as ZodTypeAny).safeParse !== 'function') {
    throw new FabricRegistryError(`schema for "${eventType}" is not a zod schema`);
  }

  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new FabricRegistryError(`schema for "${eventType}" declares a non-positive version`);
  }

  const spec: FabricSchemaSpec = Object.freeze({
    eventType, version, schema: input.schema, describes: input.describes ?? '',
  });

  const existing = schemas.get(key(eventType, version));
  if (existing) {
    if (existing.schema === spec.schema && existing.describes === spec.describes) return existing;
    throw new FabricRegistryError(
      `a schema for "${eventType}" v${version} is already registered — a payload shape is a `
      + 'historical contract, so publish a new version rather than replacing this one',
    );
  }

  schemas.set(key(eventType, version), spec);
  return spec;
}

/** The schema for one version, if one was declared. */
export function fabricSchema(eventType: string, version = 1): FabricSchemaSpec | undefined {
  return schemas.get(key(eventType, version));
}

/** Every declared version of one event type, ascending. */
export function schemaVersionsFor(eventType: string): number[] {
  return [...schemas.values()]
    .filter((s) => s.eventType === eventType)
    .map((s) => s.version)
    .sort((a, b) => a - b);
}

/** Every declared schema, for the catalogue. */
export function fabricSchemas(): FabricSchemaSpec[] {
  return [...schemas.values()].sort(
    (a, b) => a.eventType.localeCompare(b.eventType) || a.version - b.version,
  );
}

/**
 * Check a payload against its declared schema.
 *
 * Never throws — a validator that can throw is a validator that can take down
 * the request it was called from, and the publisher's whole contract is that
 * observability cannot fail a business transaction.
 */
export function validateEventPayload(
  eventType: string,
  version: number,
  payload: unknown,
): SchemaCheck {
  const spec = fabricSchema(eventType, version);
  if (!spec) return { ok: true, validated: false };

  try {
    const result = spec.schema.safeParse(payload);
    if (result.success) return { ok: true, validated: true };
    return {
      ok: false,
      validated: true,
      issues: result.error.issues.slice(0, 10).map(describeIssue),
    };
  } catch (err) {
    // A schema that throws rather than returning is a bug in the schema, not in
    // the event. Reported as an issue so it surfaces, without taking the caller
    // down with it.
    return { ok: false, validated: true, issues: [`schema threw: ${(err as Error).message}`] };
  }
}

/**
 * One issue as a short string.
 *
 * The PATH and the MESSAGE, never the received value. A validation error on a
 * medical or identity payload would otherwise print the very content this
 * fabric spends the rest of its code keeping out of logs.
 */
function describeIssue(issue: ZodIssue): string {
  const path = issue.path.length ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

/** Wipe the registry. Tests only. */
export function resetSchemaRegistry(): void {
  schemas.clear();
}

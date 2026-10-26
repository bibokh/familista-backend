// zod 4, saying what zod 3 said
// ─────────────────────────────────────────────────────────────────────────────
// Security migration zod 3 → 4 (GHSA-mrhx-c7xc-m3w5). zod 4 rewrote every default
// validation message ("Required" became "Invalid input: expected string, received
// undefined"), and those messages are the API's: the error handler returns them
// as errors[].message and every controller's zerr() joins them into its 400. So
// the global error map returns zod 3's wording for each kind of issue, and a
// client is told exactly what it was told before.
//
// Only defaults change: a message a schema gives itself (.min(1, '…'),
// .refine(…, '…')) is not consulted here; zod uses it first. The behaviour
// baseline (tests/zod-request-baseline.unit.test.ts) replays 15,314 recorded
// zod 3 answers against this and requires every path and message to match.
//
// Two zod 3 semantics the map cannot carry are here as helpers: partialUpdate()
// for zod 3's .partial(), and nativeEnum() for its native-enum message.
//
// Loaded for its effect, first, by src/server.ts and src/app.ts (and the Jest
// setup), so the map is in place before any request is validated; zod computes
// a message when an error's issues are read, never at import.

import { z } from 'zod';

type RawIssue = {
  code: string;
  input?: unknown;
  expected?: string;
  received?: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
  exact?: boolean;
  format?: string;
  prefix?: string;
  suffix?: string;
  includes?: string;
  divisor?: number;
  keys?: string[];
  values?: unknown[];
  note?: string;
  options?: unknown[];
  errors?: Array<Array<{ code: string; expected?: string; message: string }>>;
  inst?: { _zod?: { def?: { type?: string } } };
};

const nativeEnums = new WeakSet<object>();

/**
 * z.nativeEnum(), remembered as one: zod 3 answered a number given to a native
 * enum "Invalid enum value. Expected …, received '3'", where z.enum() (and every
 * enum in zod 4) answers with a type error.
 */
export function nativeEnum<T extends Readonly<Record<string, string | number>>>(entries: T) {
  const schema = z.nativeEnum(entries);
  nativeEnums.add(schema);
  return schema;
}

type Updatable<S extends z.ZodRawShape> = {
  -readonly [K in keyof S]: z.ZodOptional<S[K] extends z.ZodDefault<infer T extends z.core.SomeType> ? T : S[K]>;
};

/**
 * zod 3's .partial(): every field optional, and a field that is left out stays
 * out. zod 4's .partial() still fills a missing field's .default(), so an update
 * built from a create schema would write the defaults over what is stored.
 */
export function partialUpdate<S extends z.ZodRawShape, C extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<S, C>,
): z.ZodObject<Updatable<S>, C> {
  const undefaulted: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    if (field instanceof z.ZodDefault) undefaulted[key] = (field.unwrap() as z.ZodType).optional();
  }
  return schema.partial().extend(undefaulted) as unknown as z.ZodObject<Updatable<S>, C>;
}

/**
 * Whether zod 3 went on after this issue (its "dirty" result) rather than
 * giving up on the value: a failed check, an unknown key, a fraction given to
 * .int(). zod 3 answered a union with the first branch that only went dirty.
 */
const dirtyInZod3 = (i: { code: string; expected?: string }) =>
  ['too_small', 'too_big', 'invalid_format', 'not_multiple_of', 'custom', 'unrecognized_keys'].includes(i.code)
  || (i.code === 'invalid_type' && i.expected === 'int');

/** zod 3's name for the type of a value (its getParsedType). */
function parsedType(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isNaN(v) ? 'nan' : 'number';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (v instanceof Map) return 'map';
  if (v instanceof Set) return 'set';
  if (typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function') return 'promise';
  return typeof v;
}
const quote = (v: unknown) => (typeof v === 'string' ? `'${v}'` : String(v));
const joined = (values: unknown[]) => values.map(quote).join(' | ');
const has = (iss: RawIssue, k: keyof RawIssue) => Object.prototype.hasOwnProperty.call(iss, k);

/** The message zod 3 gave the same failure, or undefined to leave zod 4's own. */
export function zod3Message(iss: RawIssue): string | undefined {
  const input = has(iss, 'input') ? iss.input : undefined;
  const received = iss.received === 'NaN' ? 'nan' : parsedType(input);
  switch (iss.code) {
    case 'invalid_type': {
      if (input instanceof Date && Number.isNaN(input.getTime())) return 'Invalid date';
      if (iss.expected === 'nonoptional' || input === undefined) return 'Required';
      if (iss.expected === 'int' && typeof input === 'number') return 'Expected integer, received float';
      const expected = iss.expected === 'record' ? 'object' : iss.expected === 'int' ? 'integer' : iss.expected;
      return `Expected ${expected}, received ${received}`;
    }
    case 'invalid_value': {
      const values = iss.values ?? [];
      const kind = iss.inst?._zod?.def?.type;
      if (kind === 'literal') return `Invalid literal value, expected ${JSON.stringify(values[0])}`;
      if (input === undefined) return 'Required';
      if (typeof input === 'number' && iss.inst && nativeEnums.has(iss.inst)) return `Invalid enum value. Expected ${joined(values)}, received '${input}'`;
      if (typeof input !== 'string') return `Expected ${joined(values)}, received ${received}`;
      return `Invalid enum value. Expected ${joined(values)}, received '${input}'`;
    }
    case 'too_small': {
      const { minimum, inclusive, exact } = iss;
      switch (iss.origin) {
        case 'string': return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${minimum} character(s)`;
        case 'number': case 'int': return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${minimum}`;
        case 'array': return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${minimum} element(s)`;
        case 'set': return `Set must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${minimum} element(s)`;
        case 'date': return `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(minimum))}`;
        default: return 'Invalid input';
      }
    }
    case 'too_big': {
      const { maximum, inclusive, exact } = iss;
      switch (iss.origin) {
        case 'string': return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${maximum} character(s)`;
        case 'number': case 'int': return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
        case 'array': return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${maximum} element(s)`;
        case 'set': return `Set must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${maximum} element(s)`;
        case 'date': return `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(maximum))}`;
        default: return 'Invalid input';
      }
    }
    case 'invalid_format': {
      switch (iss.format) {
        case 'regex': return 'Invalid';
        case 'starts_with': return `Invalid input: must start with "${iss.prefix}"`;
        case 'ends_with': return `Invalid input: must end with "${iss.suffix}"`;
        case 'includes': return `Invalid input: must include "${iss.includes}"`;
        case 'guid': return 'Invalid uuid';
        default: return `Invalid ${iss.format}`;
      }
    }
    case 'not_multiple_of': return `Number must be a multiple of ${iss.divisor}`;
    case 'unrecognized_keys': return `Unrecognized key(s) in object: ${(iss.keys ?? []).map(quote).join(', ')}`;
    case 'invalid_union': {
      if (iss.note === 'No matching discriminator') return `Invalid discriminator value. Expected ${joined(iss.options ?? [])}`;
      const dirty = (iss.errors ?? []).find((branch) => branch.length > 0 && branch.every(dirtyInZod3));
      return dirty ? dirty[0].message : 'Invalid input';
    }
    case 'custom': return 'Invalid input';
    default: return undefined;
  }
}

z.config({ customError: (iss) => zod3Message(iss as unknown as RawIssue) });

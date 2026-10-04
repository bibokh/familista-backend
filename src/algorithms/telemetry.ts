// Familista — algorithm runtime telemetry: the recorder
// ─────────────────────────────────────────────────────────────────────────────
// `observed` and `observedAsync` wrap the place where production code calls a
// registered algorithm. They return exactly what the algorithm returned and
// rethrow exactly what it threw — the same value, the same error object — so
// the algorithm and its caller behave as they did before. Around the call they
// record, in this process's memory and nowhere else:
//
//   which algorithm, which version, which code fingerprint, which workflow
//   whether it threw, and the error's class name (never its message)
//   how long it took
//   its outputs, as counts per fixed bin, and how many broke the declared
//   output contract (monitoring-spec.ts)
//   the input quality and freshness the call site could see, as counts
//
// WHAT IT NEVER RECORDS
//
// A club, team, player or user id, a name, an input value, an output tied to
// anyone, a request, a token or a message. The inspector a call site passes in
// reduces the output to the numbers or category tokens above, and the recorder
// keeps only the bin each one falls in.
//
// COST
//
// Two clock reads, a map lookup and a handful of additions — no I/O, no await,
// no allocation beyond the first run of a workflow in an hour. Writing to the
// database happens elsewhere, off the request path, once a minute
// (telemetry-store.ts). Measured overhead is pinned by
// tests/algorithms-monitoring.unit.test.ts.
//
// NEVER THROWS INTO THE CALLER. A failure to record is counted and dropped:
// measuring an algorithm must never break it.

import { performance } from 'perf_hooks';
import { algorithmOf } from './registry';
import {
  SOURCES, LATENCY_EDGES_US, instrumentedSpecOf, binCount, classifyOutput, latencyBinOf,
  type InstrumentedKey, type InstrumentedSpec, type SourceName,
} from './monitoring-spec';
import { telemetryFingerprintOf } from './runtime-fingerprint';

/** What a call site may report about one run, beyond success and time. */
export interface Inspection {
  /** The run's outputs, as numbers or category tokens — binned, never stored. */
  outputs?: ReadonlyArray<number | string>;
  /** Further contract breaks the call site checked itself (e.g. a verdict that contradicts its flag). */
  violations?: number;
  quality?: 'OK' | 'PARTIAL' | 'EMPTY';
  freshness?: 'FRESH' | 'STALE';
}

/** One hour of one algorithm, one workflow, one version, one fingerprint — as it will be written. */
export interface TelemetryEntry {
  key: string;
  version: string;
  fingerprint: string;
  source: string;
  /** Start of the UTC hour, epoch ms. */
  bucketStart: number;
  executions: number;
  failures: number;
  outputs: number;
  outOfContract: number;
  latencySumUs: number;
  latencyMaxUs: number;
  latencyBins: number[];
  outputBins: number[];
  qualityOk: number;
  qualityPartial: number;
  qualityEmpty: number;
  freshnessFresh: number;
  freshnessStale: number;
  firstAt: number;
  lastAt: number;
  lastFailureAt: number | null;
  lastFailureKind: string | null;
}

const HOUR_MS = 3_600_000;
/** Pending hours kept while the database cannot be written: ~5 days of every workflow. */
export const MAX_PENDING_ENTRIES = 2_000;

const pending = new Map<string, TelemetryEntry>();
const counters = { recorded: 0, dropped: 0, recordErrors: 0 };

/**
 * Everything a run of one algorithm in one workflow needs that does not change
 * between runs — resolved once, so the hot path is a map lookup and a few
 * additions. `entry` is this hour's pending row, valid while `gen` is the
 * current generation (any write, eviction or reset starts a new one).
 */
interface RunContext {
  spec: InstrumentedSpec;
  version: string;
  fingerprint: string;
  source: string;
  key: string;
  bins: number;
  prefix: string;
  hour: number;
  gen: number;
  entry: TelemetryEntry | null;
}
const contexts = new Map<string, RunContext | null>();
let generation = 0;

/** The context for one algorithm in one workflow — or null, for a workflow not declared for it. */
function contextOf(key: InstrumentedKey, source: SourceName): RunContext | null {
  const id = key + ' ' + source;
  const known = contexts.get(id);
  if (known !== undefined) return known;
  const spec = instrumentedSpecOf(key);
  const decl = algorithmOf(key);
  // A workflow that is not declared for this algorithm is never written: the
  // closed list is the privacy boundary, and a typo must not widen it.
  if (!spec || !decl || !(source in SOURCES) || !spec.sources.includes(source)) { contexts.set(id, null); return null; }
  const fingerprint = telemetryFingerprintOf(key);
  const ctx: RunContext = {
    spec, version: decl.version, fingerprint, source, key, bins: binCount(spec.output),
    prefix: `${key}|${decl.version}|${fingerprint}|${source}|`, hour: -1, gen: -1, entry: null,
  };
  contexts.set(id, ctx);
  return ctx;
}

/** This hour's pending entry for a context, created when it is the hour's first run. */
function entryOf(ctx: RunContext, now: number, at: number): TelemetryEntry {
  const bucketStart = now - (now % HOUR_MS);
  if (ctx.entry !== null && ctx.hour === bucketStart && ctx.gen === generation) return ctx.entry;
  const id = ctx.prefix + bucketStart;
  let e = pending.get(id);
  if (!e) {
    if (pending.size >= MAX_PENDING_ENTRIES) evictOldest();
    e = emptyEntry(ctx.key, ctx.version, ctx.fingerprint, ctx.source, bucketStart, ctx.bins, at);
    pending.set(id, e);
  }
  ctx.entry = e; ctx.hour = bucketStart; ctx.gen = generation;
  return e;
}

/** An error's class name — the only part of an error that is ever kept. */
export function failureKindOf(err: unknown): string {
  // Only an object has a class worth naming; a thrown string or number says
  // nothing a reader can use, and its value is never kept.
  if (typeof err !== 'object' || err === null) return 'Error';
  const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
  const name = typeof ctor === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(ctor) && ctor !== 'Object' ? ctor : 'Error';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? `${name}:${code}` : name;
}

function emptyEntry(key: string, version: string, fingerprint: string, source: string, bucketStart: number, bins: number, at: number): TelemetryEntry {
  return {
    key, version, fingerprint, source, bucketStart,
    executions: 0, failures: 0, outputs: 0, outOfContract: 0,
    latencySumUs: 0, latencyMaxUs: 0,
    latencyBins: new Array(LATENCY_EDGES_US.length + 1).fill(0),
    outputBins: new Array(bins).fill(0),
    qualityOk: 0, qualityPartial: 0, qualityEmpty: 0, freshnessFresh: 0, freshnessStale: 0,
    firstAt: at, lastAt: at, lastFailureAt: null, lastFailureKind: null,
  };
}

/** Make room for a new hour by dropping the oldest one. Counted, never silent. */
function evictOldest(): void {
  let oldestKey: string | null = null;
  let oldest = Infinity;
  for (const [k, e] of pending) if (e.bucketStart < oldest) { oldest = e.bucketStart; oldestKey = k; }
  if (oldestKey !== null) {
    counters.dropped += pending.get(oldestKey)!.executions;
    pending.delete(oldestKey);
    generation += 1;
  }
}

function record(key: InstrumentedKey, source: SourceName, ms: number, inspection: Inspection | null, err: unknown, hasError: boolean): void {
  try {
    const ctx = contextOf(key, source);
    if (ctx === null) { counters.recordErrors += 1; return; }

    const now = Date.now();
    const at = now - (now % 1000);             // second precision is all a reader needs
    const e = entryOf(ctx, now, at);

    const us = ms > 0 ? Math.round(ms * 1000) : 0;
    e.executions += 1;
    e.latencySumUs += us;
    if (us > e.latencyMaxUs) e.latencyMaxUs = us;
    e.latencyBins[latencyBinOf(us)] += 1;
    if (at > e.lastAt) e.lastAt = at;

    if (hasError) {
      e.failures += 1;
      e.lastFailureAt = at;
      e.lastFailureKind = failureKindOf(err);
    } else if (inspection !== null) {
      const outs = inspection.outputs;
      if (outs !== undefined && outs.length) {
        let broken = 0;
        for (const v of outs) {
          const c = classifyOutput(ctx.spec.output, v);
          if (c.bin !== null) e.outputBins[c.bin] += 1;
          if (!c.ok) broken += 1;
        }
        e.outputs += outs.length;
        // Never more breaks than outputs: the database holds the two to that.
        e.outOfContract += Math.min(outs.length, broken + Math.max(0, inspection.violations ?? 0));
      }
      if (inspection.quality === 'OK') e.qualityOk += 1;
      else if (inspection.quality === 'PARTIAL') e.qualityPartial += 1;
      else if (inspection.quality === 'EMPTY') e.qualityEmpty += 1;
      if (inspection.freshness === 'FRESH') e.freshnessFresh += 1;
      else if (inspection.freshness === 'STALE') e.freshnessStale += 1;
    }
    counters.recorded += 1;
  } catch {
    counters.recordErrors += 1;
  }
}

/** The call site's inspector, contained: if it throws, the run is still counted, without outputs. */
function inspectSafely<T>(inspect: ((out: T) => Inspection | void) | undefined, out: T): Inspection | null {
  if (!inspect) return null;
  try { return inspect(out) || null; } catch { counters.recordErrors += 1; return null; }
}

/**
 * Run one synchronous algorithm call and record it.
 * Returns exactly what `run` returns; rethrows exactly what it throws.
 */
export function observed<T>(key: InstrumentedKey, source: SourceName, run: () => T, inspect?: (out: T) => Inspection | void): T {
  const t0 = performance.now();
  let out: T;
  try {
    out = run();
  } catch (err) {
    record(key, source, performance.now() - t0, null, err, true);
    throw err;
  }
  const ms = performance.now() - t0;
  record(key, source, ms, inspectSafely(inspect, out), undefined, false);
  return out;
}

/**
 * Run one asynchronous algorithm call and record it when it settles.
 * Resolves with exactly what `run` resolves with; rejects with exactly what it rejects with.
 */
export function observedAsync<T>(key: InstrumentedKey, source: SourceName, run: () => Promise<T>, inspect?: (out: T) => Inspection | void): Promise<T> {
  const t0 = performance.now();
  let p: Promise<T>;
  try {
    p = run();
  } catch (err) {
    record(key, source, performance.now() - t0, null, err, true);
    throw err;
  }
  return p.then(
    (out) => { record(key, source, performance.now() - t0, inspectSafely(inspect, out), undefined, false); return out; },
    (err) => { record(key, source, performance.now() - t0, null, err, true); throw err; },
  );
}

/**
 * Record outputs observed after a run, without counting another run — for an
 * algorithm whose outputs are read back once its own transaction has
 * committed (the match rating). Contract breaks are counted like any other.
 */
export function recordOutputs(key: InstrumentedKey, source: SourceName, inspection: Inspection): void {
  try {
    const ctx = contextOf(key, source);
    if (ctx === null) { counters.recordErrors += 1; return; }
    const outs = inspection.outputs ?? [];
    if (!outs.length) return;
    const now = Date.now();
    const e = entryOf(ctx, now, now - (now % 1000));
    let broken = 0;
    for (const v of outs) {
      const c = classifyOutput(ctx.spec.output, v);
      if (c.bin !== null) e.outputBins[c.bin] += 1;
      if (!c.ok) broken += 1;
    }
    e.outputs += outs.length;
    e.outOfContract += Math.min(outs.length, broken + Math.max(0, inspection.violations ?? 0));
  } catch {
    counters.recordErrors += 1;
  }
}

// ── for the store: hand pending hours over, and take them back on failure ────

const cloneEntry = (e: TelemetryEntry): TelemetryEntry => ({ ...e, latencyBins: [...e.latencyBins], outputBins: [...e.outputBins] });

/** Everything recorded since the last write, removed from memory. */
export function takePending(): TelemetryEntry[] {
  const list = [...pending.values()];
  pending.clear();
  generation += 1;
  return list;
}

/** A copy of what is recorded but not yet written — for a read that must not write. */
export function peekPending(): TelemetryEntry[] {
  return [...pending.values()].map(cloneEntry);
}

/** Add one entry's counts into another of the same identity. */
export function mergeEntry(into: TelemetryEntry, from: TelemetryEntry): void {
  into.executions += from.executions;
  into.failures += from.failures;
  into.outputs += from.outputs;
  into.outOfContract += from.outOfContract;
  into.latencySumUs += from.latencySumUs;
  into.latencyMaxUs = Math.max(into.latencyMaxUs, from.latencyMaxUs);
  for (let i = 0; i < Math.max(into.latencyBins.length, from.latencyBins.length); i++) into.latencyBins[i] = (into.latencyBins[i] ?? 0) + (from.latencyBins[i] ?? 0);
  for (let i = 0; i < Math.max(into.outputBins.length, from.outputBins.length); i++) into.outputBins[i] = (into.outputBins[i] ?? 0) + (from.outputBins[i] ?? 0);
  into.qualityOk += from.qualityOk;
  into.qualityPartial += from.qualityPartial;
  into.qualityEmpty += from.qualityEmpty;
  into.freshnessFresh += from.freshnessFresh;
  into.freshnessStale += from.freshnessStale;
  into.firstAt = Math.min(into.firstAt, from.firstAt);
  into.lastAt = Math.max(into.lastAt, from.lastAt);
  if (from.lastFailureAt !== null && (into.lastFailureAt === null || from.lastFailureAt >= into.lastFailureAt)) {
    into.lastFailureAt = from.lastFailureAt;
    into.lastFailureKind = from.lastFailureKind;
  }
}

/** A write failed: put what it held back, so the next write carries it. */
export function restorePending(list: readonly TelemetryEntry[]): void {
  for (const e of list) {
    const id = `${e.key}|${e.version}|${e.fingerprint}|${e.source}|${e.bucketStart}`;
    const there = pending.get(id);
    if (there) mergeEntry(there, e);
    else {
      if (pending.size >= MAX_PENDING_ENTRIES) evictOldest();
      pending.set(id, cloneEntry(e));
    }
  }
}

/** The recorder's own counters: what it recorded, dropped and could not record. */
export function recorderCounters(): { recorded: number; dropped: number; recordErrors: number; pendingEntries: number } {
  return { ...counters, pendingEntries: pending.size };
}

/** For tests: forget everything recorded. */
export function resetTelemetry(): void {
  pending.clear();
  contexts.clear();
  generation += 1;
  counters.recorded = 0; counters.dropped = 0; counters.recordErrors = 0;
}

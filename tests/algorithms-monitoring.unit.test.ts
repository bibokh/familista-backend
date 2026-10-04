/**
 * Algorithms, Step 2 — production monitoring.
 *
 * THE TESTS THIS FILE EXISTS FOR
 *
 *   1. Coverage cannot be claimed, only shown. Every workflow the monitoring
 *      spec declares is wrapped by the recorder in the file that runs it; every
 *      production call of an instrumented algorithm is wrapped; and an
 *      algorithm declared "not in production" has no production caller. If any
 *      of that stops being true, this file fails.
 *   2. Measuring changes nothing. The recorder returns exactly what the
 *      algorithm returned and rethrows exactly what it threw.
 *   3. Nothing personal is recorded — not a name, an id, an input or a
 *      message — and nothing undeclared can be.
 *   4. Green only for what was measured: Healthy needs enough runs and every
 *      check passing; the other four states say why not.
 *
 * The database is not used here: the store's read is replaced by aggregates
 * built from hourly entries, through the same fold the room uses for its own
 * unwritten minute. tests/algorithm-telemetry.integration.test.ts proves the
 * store itself on real PostgreSQL.
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import express from 'express';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ── a database that can only say who is the platform owner ───────────────────

const OWNER = 'user-owner';
const PRESIDENT = 'user-president';
const CLUB = 'club-1';
const db: Row = {
  platformAdmin: { findUnique: async ({ where }: Row) => (where.userId === OWNER ? { isActive: true } : null) },
  user: { findUnique: async () => null, findFirst: async () => null },
};
jest.mock('../src/config/database', () => ({ prisma: db, basePrisma: db }));

let actingAs: Row | null = null;
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req: Row, res: Row, next: () => void) => {
    if (!actingAs) { res.status(401).json({ success: false, message: 'unauthenticated' }); return; }
    req.user = actingAs;
    next();
  },
  onIdentityForgotten: () => () => undefined,
  sessionStillValid: async () => true,
}));

// The store's read is replaced; everything else in it is the real module.
const storeRead = jest.fn();
jest.mock('../src/algorithms/telemetry-store', () => {
  const real = jest.requireActual('../src/algorithms/telemetry-store');
  return { ...real, readTelemetryAggregates: (...a: unknown[]) => storeRead(...a) };
});

import { ALGORITHMS, algorithmOf } from '../src/algorithms/registry';
import {
  MONITORING, MONITORING_SPECS, SOURCES, LATENCY_EDGES_US, monitoringSpecOf, instrumentedSpecOf,
  classifyOutput, latencyBinOf, binCount, type InstrumentedSpec, type SourceName, type InstrumentedKey,
} from '../src/algorithms/monitoring-spec';
import {
  observed, observedAsync, recordOutputs, peekPending, takePending, restorePending, resetTelemetry,
  recorderCounters, failureKindOf, MAX_PENDING_ENTRIES, type TelemetryEntry,
} from '../src/algorithms/telemetry';
import {
  verifyRuntime, runtimeFingerprints, runtimeFingerprintOf, telemetryFingerprintOf, resetRuntimeFingerprints,
} from '../src/algorithms/runtime-fingerprint';
import {
  algorithmsMonitoring, algorithmMonitoring, resetMonitoringCache, aggregateEntries, combineAggregates,
  populationStability, latencyAtMost, MONITORING_STATES,
} from '../src/algorithms/monitoring';
import { windowsAt } from '../src/algorithms/telemetry-store';
import { SCENARIOS } from '../src/algorithms/scenarios';
import { resetAlgorithmMonitor, algorithmsOverview } from '../src/algorithms/algorithms.service';
import { computeMedicalRiskScore, ageDecayFactor } from '../src/intelligence/shared.utils';
import { eligibilityFor } from '../src/competition/league-eligibility';
import { validateKickoff, DEFAULT_SCHEDULING_POLICY } from '../src/competition/match-scheduling';
import { inspectKickoff } from '../src/competition/match-center.service';
import { inspectWorkload } from '../src/workload/workload-science.service';
import algorithmsRoutes from '../src/routes/algorithms.routes';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const discover = require('../scripts/algorithms-discover.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../src/algorithms/fingerprint-core.js');

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
/** Source with comments blanked, strings kept — so a comment cannot satisfy or fail a check. */
const code = (rel: string): string => core.stripComments(read(rel));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A fixed "now", in the middle of an hour, so window edges are unambiguous. */
const NOW = Date.UTC(2026, 9, 4, 12, 30, 0);
const hourOf = (t: number) => t - (t % HOUR);

beforeEach(() => {
  resetTelemetry();
  resetMonitoringCache();
  storeRead.mockReset();
  storeRead.mockResolvedValue({ groups: [], daily: [] });
  actingAs = null;
});

// ── a way to say "this algorithm ran like this, at these times" ──────────────

/** One hourly entry, as the store would hold it. */
function entry(key: InstrumentedKey, source: SourceName, hoursAgo: number, over: Partial<TelemetryEntry> = {}): TelemetryEntry {
  const spec = instrumentedSpecOf(key)!;
  const bucketStart = hourOf(NOW) - hoursAgo * HOUR;
  return {
    key, version: algorithmOf(key)!.version, fingerprint: telemetryFingerprintOf(key), source, bucketStart,
    executions: 0, failures: 0, outputs: 0, outOfContract: 0, latencySumUs: 0, latencyMaxUs: 0,
    latencyBins: new Array(LATENCY_EDGES_US.length + 1).fill(0),
    outputBins: new Array(binCount(spec.output)).fill(0),
    qualityOk: 0, qualityPartial: 0, qualityEmpty: 0, freshnessFresh: 0, freshnessStale: 0,
    firstAt: bucketStart, lastAt: bucketStart + 60_000, lastFailureAt: null, lastFailureKind: null,
    ...over,
  };
}

/** `n` successful runs, each taking `us` microseconds and producing one output in `bin`. */
function runs(key: InstrumentedKey, source: SourceName, hoursAgo: number, n: number, opts: { us?: number; bin?: number; failures?: number } = {}): TelemetryEntry {
  const e = entry(key, source, hoursAgo);
  const us = opts.us ?? 40;
  const failures = opts.failures ?? 0;
  e.executions = n;
  e.failures = failures;
  e.latencySumUs = us * n;
  e.latencyMaxUs = us;
  e.latencyBins[latencyBinOf(us)] = n;
  e.outputs = n - failures;
  e.outputBins[opts.bin ?? 0] = n - failures;
  e.qualityOk = n - failures;
  if (failures) { e.lastFailureAt = e.lastAt; e.lastFailureKind = 'TypeError'; }
  return e;
}

/** The store answers with these entries. */
function stored(...entries: TelemetryEntry[]) {
  storeRead.mockResolvedValue(aggregateEntries(entries, NOW));
}

async function stateOf(key: string) {
  const r = await algorithmMonitoring(key, NOW);
  if (r.state !== 'READY') throw new Error(`${key}: ${r.state}`);
  return r.detail;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Coverage is shown, never claimed
// ─────────────────────────────────────────────────────────────────────────────

/** Production source: src/, minus this room's own evaluation and the operator's CLI scripts. */
function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (rel !== 'src/scripts' && rel !== 'src/algorithms') walk(rel); }
      else if (e.name.endsWith('.ts')) out.push(rel);
    }
  };
  walk('src');
  return out;
}

/** The registered function each instrumented algorithm is called through. */
const ENTRY: Record<InstrumentedKey, string> = {
  'match-rating': 'computeMatchStats',
  'training-load': 'recomputeWorkload',
  'biomechanical-load': 'biomechanicalLoadIndex',
  'tactical-attrition': 'tacticalAttritionIndex',
  'data-confidence': 'computeConfidence',
  'medical-risk': 'computeMedicalRiskScore',
  'age-curve': 'ageDecayFactor',
  'league-eligibility': 'eligibilityOf',
  'kickoff-window': 'validateKickoff',
};

describe('coverage is shown, never claimed', () => {
  it('says something about every registered algorithm, once', () => {
    expect(MONITORING_SPECS.map((s) => s.key)).toEqual(ALGORITHMS.map((a) => a.key));
    const instrumented = MONITORING_SPECS.filter((s) => s.instrumented).map((s) => s.key).sort();
    expect(instrumented).toEqual(Object.keys(ENTRY).sort());
    expect(MONITORING_SPECS.filter((s) => !s.instrumented).map((s) => s.key).sort()).toEqual(['form-trend', 'xa', 'xg', 'xgot']);
  });

  it('every declared workflow is wrapped by the recorder in the file that runs it', () => {
    for (const spec of MONITORING_SPECS.filter((s): s is InstrumentedSpec => s.instrumented)) {
      for (const source of spec.sources) {
        const file = SOURCES[source].file;
        expect(`${source} → ${file}: ${exists(file)}`).toBe(`${source} → ${file}: true`);
        const src = code(file);
        const direct = new RegExp(`observed(?:Async)?\\(\\s*'${spec.key}',\\s*'${source.replace('.', '\\.')}'`).test(src);
        // The eligibility rule takes its workflow as an argument: the call site
        // names it, and the rule itself does the wrapping.
        const viaArgument = spec.key === 'league-eligibility'
          && new RegExp(`eligibilityFor\\(comp, \\{[\\s\\S]*?\\}, '${source.replace('.', '\\.')}'\\)`).test(src)
          && /observed\('league-eligibility', workflow, \(\) => eligibilityOf\(team\)/.test(code('src/competition/league-eligibility.ts'));
        expect(`${spec.key} · ${source}: ${direct || viaArgument}`).toBe(`${spec.key} · ${source}: true`);
      }
    }
  });

  it('every production call of an instrumented algorithm is wrapped, on the line that makes it', () => {
    const unwrapped: string[] = [];
    for (const file of productionFiles()) {
      const lines = code(file).split('\n');
      lines.forEach((line, i) => {
        for (const [key, fn] of Object.entries(ENTRY)) {
          if (!new RegExp(`(?<![\\w.])(?:\\w+\\.)?${fn}\\(`).test(line)) continue;
          if (new RegExp(`function\\s+${fn}\\(`).test(line)) continue; // its definition, or a handler of the same name
          if (new RegExp(`observed(?:Async)?\\('${key}'`).test(line)) continue;
          // Declared and proven below: a wrapper with no production caller.
          if (file === 'src/competition/league-eligibility.ts' && /isEligibleForFamilistaLeague|return eligibilityOf\(team\)\.eligible/.test(lines.slice(Math.max(0, i - 1), i + 1).join('\n'))) continue;
          unwrapped.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(unwrapped).toEqual([]);
  });

  it('the one unwrapped wrapper really has no production caller', () => {
    const callers = productionFiles().filter((f) => f !== 'src/competition/league-eligibility.ts' && /isEligibleForFamilistaLeague\b/.test(code(f)));
    expect(callers).toEqual([]);
  });

  it('every server caller of the eligibility rule names its workflow; only the operator scripts do not', () => {
    for (const file of productionFiles()) {
      if (file === 'src/competition/league-eligibility.ts') continue;
      const src = code(file);
      const calls = (src.match(/\beligibilityFor\(/g) || []).length;
      if (!calls) continue;
      if (file === 'src/competition/familista-league.bootstrap.ts') continue; // proven script-only below
      const named = (src.match(/\}, '(league\.[a-z-]+)'\)/g) || []).length;
      expect(`${file}: ${named}/${calls}`).toBe(`${file}: ${calls}/${calls}`);
    }
    // The season bootstrap runs from src/scripts only: the server imports
    // nothing from it but the league's code name.
    for (const file of productionFiles().filter((f) => f !== 'src/competition/familista-league.bootstrap.ts')) {
      const m = code(file).match(/import\s*\{([^}]*)\}\s*from\s*'\.\/familista-league\.bootstrap'/);
      if (m) expect(`${file}: ${m[1].trim()}`).toBe(`${file}: LEAGUE_CODE`);
    }
  });

  it('an algorithm declared "not in production" has no production caller — re-proven, not trusted', () => {
    for (const spec of MONITORING_SPECS.filter((s) => !s.instrumented)) {
      if (spec.instrumented) continue;
      for (const f of spec.evidence) expect(`${spec.key} evidence ${f}: ${exists(f)}`).toBe(`${spec.key} evidence ${f}: true`);
      const decl = algorithmOf(spec.key)!;
      for (const fn of spec.entry) {
        const callers = productionFiles().filter((f) => f !== decl.source.file && new RegExp(`\\b${fn}\\b`).test(code(f)));
        expect(`${spec.key} · ${fn} called from: ${callers.join(', ') || 'nowhere'}`).toBe(`${spec.key} · ${fn} called from: nowhere`);
      }
    }
    // The xG model's module is imported by this room's evaluation and nothing else.
    const importers = [...productionFiles(), 'src/algorithms/scenarios.ts']
      .filter((f) => /from '[./]*(?:match-events\/)?xg-model\.service'/.test(code(f)));
    expect(importers).toEqual(['src/algorithms/scenarios.ts']);
    // And the xG that the platform stores arrives with the event.
    expect(code('src/match-events/match-event.service.ts')).toMatch(/xg:\s*dto\.xg \?\? null,/);
  });

  it('every workflow belongs to exactly the algorithms that run in it, and names a real entry point', () => {
    const used = new Set(MONITORING_SPECS.flatMap((s) => (s.instrumented ? [...s.sources] : [])));
    expect([...used].sort()).toEqual(Object.keys(SOURCES).sort());
    for (const [name, s] of Object.entries(SOURCES)) {
      expect(`${name}: ${/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(name)}`).toBe(`${name}: true`);
      expect(['REQUEST', 'WORKER']).toContain(s.kind);
    }
  });

  it('adds no instrumentation inside a fingerprinted declaration: every algorithm still runs its approved code', () => {
    const fresh = discover.buildManifest().algorithms;
    for (const a of ALGORITHMS) expect(`${a.key}: ${fresh[a.key].fingerprint === a.approval!.fingerprint}`).toBe(`${a.key}: true`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Measuring changes nothing
// ─────────────────────────────────────────────────────────────────────────────

describe('the recorder returns what the algorithm returned and throws what it threw', () => {
  it('returns the very same value', () => {
    const out = { value: 0.42 };
    expect(observed('biomechanical-load', 'matches.fusion-frame', () => out, (o) => ({ outputs: [o.value] }))).toBe(out);
    expect(observed('medical-risk', 'intelligence.unified-player', () => 40)).toBe(40);
  });

  it('rethrows the very same error, and counts it as a failure', () => {
    const boom = new RangeError('no');
    let caught: unknown;
    try { observed('medical-risk', 'intelligence.unified-player', () => { throw boom; }); } catch (e) { caught = e; }
    expect(caught).toBe(boom);
    const [e] = peekPending();
    expect(e).toMatchObject({ key: 'medical-risk', executions: 1, failures: 1, lastFailureKind: 'RangeError' });
  });

  it('resolves and rejects with the very same values when asynchronous', async () => {
    const out = { rebuilt: 3 };
    await expect(observedAsync('match-rating', 'stats.rebuild', async () => out)).resolves.toBe(out);
    const boom = new Error('db');
    await expect(observedAsync('match-rating', 'stats.rebuild', async () => { throw boom; })).rejects.toBe(boom);
    expect(peekPending()[0]).toMatchObject({ executions: 2, failures: 1 });
  });

  it('an inspector that throws costs the run its outputs, never its result', () => {
    expect(observed('age-curve', 'intelligence.succession', () => 0.7, () => { throw new Error('inspect'); })).toBe(0.7);
    expect(peekPending()[0]).toMatchObject({ executions: 1, failures: 0, outputs: 0 });
    expect(recorderCounters().recordErrors).toBe(1);
  });

  it('the real call sites still return the algorithm\'s own answer', () => {
    const team = { kind: 'SENIOR', isActive: true };
    expect(eligibilityFor({ ageGroup: null }, team, 'league.add-participant')).toEqual(eligibilityFor({ ageGroup: null }, team));
    const at = '2030-03-08T15:00:00Z';
    const check = validateKickoff({ at, timeZone: 'UTC', policy: DEFAULT_SCHEDULING_POLICY, now: new Date('2030-03-01T00:00:00Z') });
    expect(observed('kickoff-window', 'match-center.change-request', () => check, (c) => inspectKickoff(c, 'CLUB'))).toBe(check);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Nothing personal is recorded, and nothing undeclared can be
// ─────────────────────────────────────────────────────────────────────────────

const ENTRY_KEYS = ['key', 'version', 'fingerprint', 'source', 'bucketStart', 'executions', 'failures', 'outputs',
  'outOfContract', 'latencySumUs', 'latencyMaxUs', 'latencyBins', 'outputBins', 'qualityOk', 'qualityPartial',
  'qualityEmpty', 'freshnessFresh', 'freshnessStale', 'firstAt', 'lastAt', 'lastFailureAt', 'lastFailureKind'].sort();

describe('privacy: counts, bins and times — never a person', () => {
  const NAME = 'Zinedine Testplayer';
  const EMAIL = 'coach.private@example-club.test';
  const SECRET = 'eyJhbGciOiJIUzI1NiJ9.secret-token';

  it('keeps no input, name, id, token or message, whatever the call site had in hand', () => {
    const player = { id: 'player-uuid-1234', firstName: NAME, email: EMAIL, token: SECRET };
    observed('age-curve', 'intelligence.succession', () => ageDecayFactor(player.id.length), (f) => ({ outputs: [f], quality: 'OK' }));
    observed('medical-risk', 'intelligence.unified-player',
      () => computeMedicalRiskScore({ activeInjuryCount: 1, totalInjuryCount: 2, recentReturnDays: null, acwr: null }),
      (s) => ({ outputs: [s], quality: 'PARTIAL' }));
    try {
      observed('medical-risk', 'intelligence.unified-player', () => { throw new TypeError(`${NAME} <${EMAIL}> ${SECRET}`); });
    } catch { /* expected */ }
    eligibilityFor({ ageGroup: null }, { kind: 'SENIOR', isActive: true, name: `${NAME} FC` }, 'league.eligible-teams');

    const all = JSON.stringify(peekPending());
    for (const s of [NAME, EMAIL, SECRET, player.id, 'Testplayer', 'example-club']) expect(`${s}: ${all.includes(s)}`).toBe(`${s}: false`);
    for (const e of peekPending()) expect(Object.keys(e).sort()).toEqual(ENTRY_KEYS);
  });

  it('keeps an error\'s class name, and a database code — never its message', () => {
    class PrismaClientKnownRequestError extends Error { code = 'P2034'; }
    expect(failureKindOf(new PrismaClientKnownRequestError(`deadlock for ${EMAIL}`))).toBe('PrismaClientKnownRequestError:P2034');
    expect(failureKindOf({ message: EMAIL })).toBe('Error');
    expect(failureKindOf('a string thrown')).toBe('Error');
    expect(failureKindOf(Object.assign(new TypeError('x'), { code: `not a code ${EMAIL}` }))).toBe('TypeError');
  });

  it('refuses a workflow that is not declared for the algorithm, so a typo cannot widen what is kept', () => {
    expect(observed('medical-risk', 'stats.rebuild', () => 5)).toBe(5);
    expect(observed('medical-risk', 'not.a.workflow' as SourceName, () => 6)).toBe(6);
    recordOutputs('medical-risk', 'stats.rebuild', { outputs: [1] });
    expect(peekPending()).toEqual([]);
    expect(recorderCounters().recordErrors).toBe(3);
  });

  it('the table has exactly its aggregate columns, and the database refuses free text in them', () => {
    const schema = read('prisma/schema.prisma');
    const block = schema.match(/^model AlgorithmTelemetryBucket \{([\s\S]*?)^\}/m)![1];
    const cols = [...block.matchAll(/^\s+([A-Za-z]\w*)\s+\S/gm)].map((m) => m[1]).sort();
    expect(cols).toEqual([...ENTRY_KEYS.filter((k) => k !== 'key'), 'algorithmKey', 'id', 'updatedAt'].sort());
    for (const c of cols) expect(`${c}: ${/club|team|player|user|email|name|token|ip|payload|message|request|body/i.test(c)}`).toBe(`${c}: false`);
    const sql = read('prisma/migrations/20261007100000_algorithm_runtime_telemetry/migration.sql');
    for (const c of ['_key_shape', '_version_shape', '_fingerprint_shape', '_source_shape', '_failure_kind_shape', '_hour_aligned', '_counts_sane', '_bins_bounded']) {
      expect(`${c}: ${sql.includes(`"AlgorithmTelemetryBucket${c}" CHECK`)}`).toBe(`${c}: true`);
    }
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/);
  });

  it('the training-load and kickoff inspectors keep a ratio and a verdict token — nothing else', () => {
    const rec = { acwr: 1.2, acuteLoad: 30, chronicLoad: 25, trainingStressBalance: -5, injuryRiskScore: 0.08,
      playerId: 'player-uuid', clubId: CLUB, id: 'wr-1' } as never;
    const w = inspectWorkload(rec, new Date(Date.now() - 2 * HOUR));
    expect(w).toEqual({ outputs: [1.2], violations: 0, quality: 'OK', freshness: 'FRESH' });
    expect(inspectWorkload({ ...(rec as Row), acuteLoad: 0, chronicLoad: 0 } as never).quality).toBe('EMPTY');
    expect(inspectWorkload({ ...(rec as Row), injuryRiskScore: 1.4 } as never).violations).toBe(1);
    expect(inspectWorkload(rec, new Date(Date.now() - 5 * DAY)).freshness).toBe('STALE');
    const c = validateKickoff({ at: 'next Saturday', timeZone: 'UTC', policy: DEFAULT_SCHEDULING_POLICY });
    expect(inspectKickoff(c, 'FALLBACK')).toEqual({ outputs: ['MALFORMED'], violations: 0, quality: 'EMPTY' });
  });

  it('the monitoring answer carries no identifier of a club, a player or a user', async () => {
    stored(runs('medical-risk', 'intelligence.unified-player', 2, 25));
    const out = JSON.stringify([await algorithmsMonitoring(NOW), await stateOf('medical-risk')]);
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(out).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    // No identifier as a field, and none as a value: an endpoint is named by
    // its route template (`:playerId`), never by a filled-in one.
    expect(out).not.toMatch(/"(clubId|playerId|userId|teamId|matchId|email|firstName|lastName|token)"\s*:/i);
    const idSegments = out.match(/\/[^/"\s]*Id\b/g) || [];
    expect(idSegments.length).toBeGreaterThan(0);
    expect(idSegments.filter((seg) => !seg.startsWith('/:'))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Outputs, contracts and bins
// ─────────────────────────────────────────────────────────────────────────────

describe('outputs are binned against a declared contract', () => {
  it('a number outside its range, a NaN, or an unknown category breaks the contract', () => {
    const risk = instrumentedSpecOf('medical-risk')!.output;
    expect(classifyOutput(risk, 0)).toEqual({ bin: 0, ok: true });
    expect(classifyOutput(risk, 100)).toEqual({ bin: 4, ok: true });
    expect(classifyOutput(risk, 101)).toEqual({ bin: 4, ok: false });
    expect(classifyOutput(risk, NaN)).toEqual({ bin: null, ok: false });
    const conf = instrumentedSpecOf('data-confidence')!.output;
    expect(classifyOutput(conf, 'HIGH')).toEqual({ bin: 3, ok: true });
    expect(classifyOutput(conf, 'VERY_HIGH')).toEqual({ bin: null, ok: false });
  });

  it('counts a broken output, never more breaks than outputs', () => {
    observed('medical-risk', 'intelligence.unified-player', () => NaN, (s) => ({ outputs: [s], violations: 3 }));
    observed('league-eligibility', 'league.add-participant', () => ({ eligible: true, reason: 'INACTIVE' }),
      (v) => ({ outputs: [v.reason], violations: v.eligible === (v.reason === 'OK') ? 0 : 1 }));
    const byKey = Object.fromEntries(peekPending().map((e) => [e.key, e]));
    expect(byKey['medical-risk']).toMatchObject({ outputs: 1, outOfContract: 1 });
    expect(byKey['league-eligibility']).toMatchObject({ outputs: 1, outOfContract: 1 });
  });

  it('every instrumented algorithm declares labels for every bin, and bins its own documented range', () => {
    for (const s of MONITORING_SPECS.filter((x): x is InstrumentedSpec => x.instrumented)) {
      if (s.output.kind === 'NUMERIC') {
        expect(`${s.key}: ${s.output.labels.length}`).toBe(`${s.key}: ${s.output.edges.length + 1}`);
        expect([...s.output.edges]).toEqual([...s.output.edges].sort((a, b) => a - b));
        // The boundaries of the declared range are themselves inside the contract.
        expect(classifyOutput(s.output, s.output.min).ok).toBe(true);
        if (s.output.max !== null) expect(classifyOutput(s.output, s.output.max).ok).toBe(true);
      } else {
        expect(new Set(s.output.categories).size).toBe(s.output.categories.length);
      }
      expect(binCount(s.output)).toBeLessThanOrEqual(32); // the database's own bound
    }
    expect(LATENCY_EDGES_US.length + 1).toBeLessThanOrEqual(32);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · The running code: approved, proven, or said not to be
// ─────────────────────────────────────────────────────────────────────────────

describe('the runtime fingerprint is the code this process loaded', () => {
  const xg = algorithmOf('xg')!;
  const src = read(xg.source.file);

  it('running from TypeScript, every algorithm is the approved code', () => {
    resetRuntimeFingerprints();
    const r = runtimeFingerprints();
    expect(r.basis).toBe('SOURCE');
    for (const f of r.list) {
      expect(`${f.key}: ${f.verdict} ${f.reason}`).toBe(`${f.key}: MATCH OK`);
      expect(f.source).toBe(algorithmOf(f.key)!.approval!.fingerprint);
      expect(telemetryFingerprintOf(f.key)).toBe(f.source);
    }
    expect(runtimeFingerprintOf('not-registered')).toBeNull();
  });

  it('a changed weight in the loaded source is a mismatch', () => {
    const changed = src.replace('distanceM:         -0.0991', 'distanceM:         -0.0992');
    expect(changed).not.toBe(src);
    const v = verifyRuntime(xg, { basis: 'SOURCE', text: changed, seal: null, file: 'src/x.ts' });
    expect(v).toMatchObject({ verdict: 'MISMATCH', reason: 'NOT_APPROVED' });
    // …while a reworded comment is not.
    const comment = src.replace('// Goal centre in a 120×80m pitch', '// The centre of the goal');
    expect(verifyRuntime(xg, { basis: 'SOURCE', text: comment, seal: null, file: 'src/x.ts' }).verdict).toBe('MATCH');
  });

  it('compiled: equal to the seal and the seal approved is a match; anything else is not', () => {
    const compiledText = 'function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }\nconst WEIGHTS = { a: 1 };\nconst GOAL_X = 120;\nconst GOAL_Y = 40;\nconst POST_HALF_WIDTH = 3.66;\nfunction computeXG(f) {\n    return sigmoid(f.x);\n}\n';
    const compiled = core.fingerprintText(compiledText, xg.source.symbols, { compiled: true }).fingerprint as string;
    const approved = xg.approval!.fingerprint;
    const seal = (s: Row) => ({ schemaVersion: 1, algorithms: { xg: { file: 'dist/x.js', error: null, ...s } } });
    const v = (text: string | null, sl: Row | null) => verifyRuntime(xg, { basis: 'COMPILED', text, seal: sl as never, file: 'dist/x.js' });

    expect(v(compiledText, seal({ compiled, source: approved }))).toMatchObject({ verdict: 'MATCH', reason: 'OK', source: approved });
    expect(v(compiledText.replace('return sigmoid(f.x)', 'return sigmoid(f.x) * 2'), seal({ compiled, source: approved })))
      .toMatchObject({ verdict: 'MISMATCH', reason: 'CHANGED_AFTER_BUILD', source: null });
    expect(v(compiledText, seal({ compiled, source: 'f'.repeat(64) }))).toMatchObject({ verdict: 'MISMATCH', reason: 'BUILD_NOT_APPROVED' });
    expect(v(compiledText, null)).toMatchObject({ verdict: 'UNVERIFIED', reason: 'SEAL_MISSING' });
    expect(v(null, seal({ compiled, source: approved }))).toMatchObject({ verdict: 'UNVERIFIED', reason: 'UNREADABLE' });
  });

  it('the build seals exactly what it compiled, from approved source (checked whenever dist/ exists; always in CI)', () => {
    const sealPath = 'dist/algorithms/generated/algorithm-runtime-seal.json';
    if (!exists(sealPath)) {
      if (process.env.CI) throw new Error(`${sealPath} is missing: CI runs \`npm run build\` before the tests, and the build must write the seal`);
      return;
    }
    const seal = JSON.parse(read(sealPath));
    for (const a of ALGORITHMS) {
      const s = seal.algorithms[a.key];
      const compiledFile = `dist/${a.source.file.replace(/^src\//, '').replace(/\.ts$/, '.js')}`;
      const now = core.fingerprintText(read(compiledFile), a.source.symbols, { compiled: true }).fingerprint;
      expect(`${a.key}: compiled ${s.compiled === now}, approved ${s.source === a.approval!.fingerprint}`)
        .toBe(`${a.key}: compiled true, approved true`);
      expect(verifyRuntime(a, { basis: 'COMPILED', text: read(compiledFile), seal, file: compiledFile }).verdict).toBe('MATCH');
    }
  });

  it('a mismatch makes the algorithm Failing, and an unproven one a Warning — never Healthy', async () => {
    let results: Row = {};
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../src/algorithms/runtime-fingerprint', () => {
        const real = jest.requireActual('../src/algorithms/runtime-fingerprint');
        const patch = (f: Row) => (f.key === 'medical-risk' ? { ...f, verdict: 'MISMATCH', reason: 'CHANGED_AFTER_BUILD', source: null }
          : f.key === 'age-curve' ? { ...f, verdict: 'UNVERIFIED', reason: 'SEAL_MISSING', source: null } : f);
        return {
          ...real,
          runtimeFingerprints: () => { const r = real.runtimeFingerprints(); return { ...r, list: r.list.map(patch) }; },
        };
      });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mon = require('../src/algorithms/monitoring');
      // Plenty of healthy-looking runs: the code check alone must decide.
      storeRead.mockResolvedValue(aggregateEntries([
        ...Array.from({ length: 6 }, (_, i) => runs('medical-risk', 'intelligence.unified-player', i, 10)),
        ...Array.from({ length: 6 }, (_, i) => runs('age-curve', 'intelligence.succession', i, 10)),
      ], NOW));
      results = {
        risk: (await mon.algorithmMonitoring('medical-risk', NOW)).detail,
        age: (await mon.algorithmMonitoring('age-curve', NOW)).detail,
        overview: await mon.algorithmsMonitoring(NOW),
      };
    });
    expect(results.risk.state).toBe('FAILING');
    expect(results.risk.findings).toContain('FINGERPRINT_MISMATCH');
    expect(results.risk.checks.find((c: Row) => c.id === 'runtime-code')).toMatchObject({ state: 'FAIL', observed: 'MISMATCH · CHANGED_AFTER_BUILD' });
    expect(results.age.state).toBe('WARNING');
    expect(results.age.findings).toContain('FINGERPRINT_UNVERIFIED');
    expect(results.overview.runtime).toMatchObject({ mismatched: 1, unverified: 1 });
  });

  it('the overview guarantees the running code only while every algorithm is proven', () => {
    resetAlgorithmMonitor();
    const g = algorithmsOverview().guarantees.find((x) => x.id === 'runtime-code-approved')!;
    expect(g).toMatchObject({ basis: 'RUNTIME', holds: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · Five states, and green only for what was measured
// ─────────────────────────────────────────────────────────────────────────────

describe('the five states', () => {
  it('with no telemetry: instrumented algorithms have not enough data, the rest are not instrumented, none is healthy', async () => {
    const o = await algorithmsMonitoring(NOW);
    expect(o.state).toBe('READY');
    expect(o.states).toEqual({ HEALTHY: 0, WARNING: 0, FAILING: 0, NOT_ENOUGH_DATA: 9, NOT_INSTRUMENTED: 4 });
    expect(o.coverage).toEqual({ registered: 13, instrumented: 9, notInstrumented: 4, workflows: 13 });
    for (const a of o.algorithms) {
      expect(`${a.key}: ${a.state}`).toBe(`${a.key}: ${a.instrumented ? 'NOT_ENOUGH_DATA' : 'NOT_INSTRUMENTED'}`);
      if (a.instrumented) expect(a.findings).toContain('NO_EXECUTIONS');
    }
    expect(o.loop).toMatchObject({ measured: 9, notInstrumented: 4, healthy: 0, withFindings: 0 });
    expect([...MONITORING_STATES].sort()).toEqual(Object.keys(o.states).sort());
  });

  it('a not-instrumented algorithm says why, with its evidence, and has no production checks', async () => {
    const d = await stateOf('xg');
    expect(d.state).toBe('NOT_INSTRUMENTED');
    expect(d.coverage.reason).toMatch(/does not run in production/);
    expect(d.coverage.evidence).toContain('src/match-events/xg-model.service.ts');
    expect(d.checks.map((c) => c.id)).toEqual(['runtime-code', 'evaluation']);
    expect(d.distribution).toBeNull();
  });

  it('19 clean runs are not enough data; 20 are healthy', async () => {
    stored(runs('kickoff-window', 'match-center.change-request', 3, 19));
    expect((await stateOf('kickoff-window')).state).toBe('NOT_ENOUGH_DATA');
    resetMonitoringCache();
    stored(runs('kickoff-window', 'match-center.change-request', 3, 20));
    const d = await stateOf('kickoff-window');
    expect(d.state).toBe('HEALTHY');
    expect(d.checks.filter((c) => c.state === 'FAIL' || c.state === 'WARN')).toEqual([]);
  });

  it('one failure in the week is a warning', async () => {
    stored(runs('medical-risk', 'intelligence.unified-player', 30, 40, { failures: 1 }));
    const d = await stateOf('medical-risk');
    expect(d.state).toBe('WARNING');
    expect(d.findings).toEqual(['FAILURES']);
    expect(d.lastFailureKind).toBe('TypeError');
  });

  it('repeated failures are failing; the same count among many runs is a warning', async () => {
    stored(runs('match-rating', 'stats.aggregator', 2, 30, { failures: 3 }));
    let d = await stateOf('match-rating');
    expect(d.state).toBe('FAILING');
    expect(d.findings).toContain('REPEATED_FAILURES');
    resetMonitoringCache();
    stored(runs('match-rating', 'stats.aggregator', 2, 100, { failures: 3 }));
    d = await stateOf('match-rating');
    expect(d.state).toBe('WARNING');
    expect(d.findings).toEqual(['FAILURES']);
  });

  it('one output outside its contract is failing', async () => {
    const e = runs('tactical-attrition', 'matches.fusion-frame', 5, 50);
    e.outOfContract = 1;
    stored(e);
    const d = await stateOf('tactical-attrition');
    expect(d.state).toBe('FAILING');
    expect(d.checks.find((c) => c.id === 'output-contract')).toMatchObject({ state: 'FAIL', observed: '1/50' });
  });

  it('runs that stopped a week ago are a warning, not health and not silence', async () => {
    stored(runs('age-curve', 'intelligence.succession', 8 * 24 + 3, 60));
    const d = await stateOf('age-curve');
    expect(d.state).toBe('WARNING');
    expect(d.findings).toContain('STALE');
    expect(d.counts.recent.executions).toBe(0);
    expect(d.counts.baseline.executions).toBe(60);
  });

  it('a shifted output distribution is a warning; the same distribution is not', async () => {
    const baseline = Array.from({ length: 4 }, (_, i) => runs('medical-risk', 'intelligence.unified-player', 10 * 24 + i, 50, { bin: 1 }));
    stored(...baseline, runs('medical-risk', 'intelligence.unified-player', 5, 60, { bin: 3 }));
    let d = await stateOf('medical-risk');
    expect(d.state).toBe('WARNING');
    expect(d.findings).toContain('DISTRIBUTION_SHIFT');
    expect(d.distribution!.psi!).toBeGreaterThanOrEqual(MONITORING.driftPsiWarn);
    resetMonitoringCache();
    stored(...baseline, runs('medical-risk', 'intelligence.unified-player', 5, 60, { bin: 1 }));
    d = await stateOf('medical-risk');
    expect(d.state).toBe('HEALTHY');
    expect(d.distribution!.psi).toBe(0);
  });

  it('too few outputs are not compared at all — and that alone does not withhold health', async () => {
    stored(runs('data-confidence', 'intelligence.unified-player', 1, 30, { bin: 2 }));
    const d = await stateOf('data-confidence');
    expect(d.checks.find((c) => c.id === 'distribution')).toMatchObject({ state: 'NOT_ENOUGH_DATA' });
    expect(d.distribution!.psi).toBeNull();
    expect(d.state).toBe('HEALTHY');
  });

  it('a latency regression above the floor is a warning; a jump under a millisecond is not', async () => {
    const base = (us: number) => Array.from({ length: 2 }, (_, i) => runs('training-load', 'workload.recompute', 10 * 24 + i, 40, { us }));
    stored(...base(400), runs('training-load', 'workload.recompute', 2, 60, { us: 7000 }));
    let d = await stateOf('training-load');
    expect(d.findings).toContain('LATENCY_REGRESSION');
    expect(d.state).toBe('WARNING');
    resetMonitoringCache();
    stored(...base(8), runs('training-load', 'workload.recompute', 2, 60, { us: 90 }));
    d = await stateOf('training-load');
    expect(d.findings).not.toContain('LATENCY_REGRESSION');
    expect(d.state).toBe('HEALTHY');
  });

  it('a failing evaluation fails the algorithm, instrumented or not', async () => {
    const real = SCENARIOS.xg;
    const mutable = SCENARIOS as Record<string, typeof real>;
    mutable.xg = [{ id: 'broken', title: 'Broken', run: () => [{ label: 'x', pass: false, observed: '0', expected: '1' }] }];
    try {
      resetAlgorithmMonitor();
      const d = await stateOf('xg');
      expect(d.state).toBe('FAILING');
      expect(d.findings).toContain('EVALUATION_FAILED');
    } finally { mutable.xg = real; resetAlgorithmMonitor(); }
  });

  it('when the store cannot be read: said so, this server\'s own runs shown, and nothing healthy', async () => {
    storeRead.mockRejectedValue(new Error('ECONNREFUSED db.internal:5432'));
    for (let i = 0; i < 30; i++) observed('age-curve', 'intelligence.succession', () => ageDecayFactor(25), (f) => ({ outputs: [f], quality: 'OK' }));
    const o = await algorithmsMonitoring(Date.now());
    expect(o.state).toBe('STORE_UNAVAILABLE');
    expect(o.reason).toMatch(/could not be read/);
    expect(JSON.stringify(o)).not.toMatch(/ECONNREFUSED|db\.internal/);
    const age = o.algorithms.find((a) => a.key === 'age-curve')!;
    expect(age.executions7d).toBe(30);
    expect(age.state).toBe('NOT_ENOUGH_DATA');
    expect(o.states.HEALTHY).toBe(0);
  });

  it('only the version the registry names now is compared for drift', async () => {
    const old = runs('medical-risk', 'intelligence.unified-player', 12 * 24, 200, { bin: 4 });
    old.version = 'v0.9';
    stored(old, ...Array.from({ length: 3 }, (_, i) => runs('medical-risk', 'intelligence.unified-player', 10 * 24 + i, 50, { bin: 0 })),
      runs('medical-risk', 'intelligence.unified-player', 3, 60, { bin: 0 }));
    const d = await stateOf('medical-risk');
    expect(d.distribution!.psi).toBe(0);
    expect(d.fingerprintsSeen.map((f) => f.version).sort()).toEqual(['v0.9', 'v1.0']);
    expect(d.fingerprintsSeen.find((f) => f.version === 'v1.0')).toMatchObject({ current: true, approved: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 · The arithmetic the states stand on
// ─────────────────────────────────────────────────────────────────────────────

describe('aggregation, stability and latency bounds', () => {
  it('folds this process\'s unwritten minute into the stored windows without counting anything twice', () => {
    const a = aggregateEntries([runs('medical-risk', 'intelligence.unified-player', 1, 5)], NOW);
    const b = aggregateEntries([runs('medical-risk', 'intelligence.unified-player', 1, 7), runs('medical-risk', 'intelligence.unified-player', 40 * 24, 9)], NOW);
    const c = combineAggregates(a, b);
    expect(c.groups).toHaveLength(1);
    expect(c.groups[0].recent.executions).toBe(12);
    expect(c.groups[0].last24h.executions).toBe(12);
    expect(c.groups[0].retained.executions).toBe(21);
    expect(c.groups[0].baseline.executions).toBe(0); // 40 days ago is retained, but outside the baseline window
    expect(c.daily.reduce((n, d) => n + d.executions, 0)).toBe(12);
    // The inputs are untouched.
    expect(a.groups[0].recent.executions).toBe(5);
  });

  it('window edges are UTC hours, like the rows', () => {
    const w = windowsAt(NOW);
    expect(w.last24h).toBe(hourOf(NOW) - 23 * HOUR);
    expect(w.recent).toBe(hourOf(NOW) - (7 * 24 - 1) * HOUR);
    expect(w.baseline).toBe(hourOf(NOW) - (35 * 24 - 1) * HOUR);
    expect(w.retained).toBe(hourOf(NOW) - (42 * 24 - 1) * HOUR);
  });

  it('population stability is zero for the same shape, large for a different one, and absent without data', () => {
    expect(populationStability([10, 20, 30], [1, 2, 3])).toBe(0);
    expect(populationStability([100, 0], [0, 100])!).toBeGreaterThan(5);
    expect(populationStability([], [1])).toBeNull();
  });

  it('a percentile is the upper edge of its bin — or the slowest run, when that is lower', () => {
    const bins = new Array(LATENCY_EDGES_US.length + 1).fill(0);
    bins[latencyBinOf(7)] = 90; bins[latencyBinOf(700)] = 10;
    expect(latencyAtMost(bins, 0.5, 900)).toBe(10);
    expect(latencyAtMost(bins, 0.95, 900)).toBe(900);
    expect(latencyAtMost(bins, 0.95, 5000)).toBe(1000);
    expect(latencyAtMost(new Array(13).fill(0), 0.5, 0)).toBeNull();
  });

  it('memory stays bounded while the database cannot be written, and what is dropped is counted', () => {
    const many = Array.from({ length: MAX_PENDING_ENTRIES + 25 }, (_, i) => runs('age-curve', 'intelligence.succession', i, 1));
    restorePending(many);
    expect(recorderCounters().pendingEntries).toBe(MAX_PENDING_ENTRIES);
    expect(recorderCounters().dropped).toBe(25);
    expect(takePending()).toHaveLength(MAX_PENDING_ENTRIES);
    expect(peekPending()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 · The platform owner's, read-only
// ─────────────────────────────────────────────────────────────────────────────

describe('only the platform owner, and only to read', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use('/system/algorithms', algorithmsRoutes);
    a.use((err: Row, _req: Row, res: Row, _next: unknown) => {
      res.status(err?.statusCode || err?.status || 500).json({ success: false, message: err?.message });
    });
    return a;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const request = require('supertest');
  const ROUTES = ['/system/algorithms/monitoring', '/system/algorithms/medical-risk/monitoring', '/system/algorithms/xg/monitoring'];

  it('serves the owner, with no-store', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    for (const r of ROUTES) {
      const res = await request(app()).get(r);
      expect(`${r}: ${res.status}`).toBe(`${r}: 200`);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.success).toBe(true);
    }
    expect((await request(app()).get('/system/algorithms/not-an-algorithm/monitoring')).status).toBe(404);
  });

  it('refuses a club administrator, however senior in their club', async () => {
    actingAs = { id: PRESIDENT, clubId: CLUB, role: 'CLUB_ADMIN' };
    for (const r of ROUTES) {
      const res = await request(app()).get(r);
      expect(`${r}: ${res.status}`).toBe(`${r}: 403`);
      expect(JSON.stringify(res.body)).not.toMatch(/executions|fingerprint/);
    }
  });

  it('refuses an unauthenticated caller before the guard', async () => {
    for (const r of ROUTES) expect((await request(app()).get(r)).status).toBe(401);
  });

  it('answers no write, to anyone', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    for (const r of ROUTES) {
      for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await request(app())[verb](r).send({ retrain: true });
        expect(`${verb} ${r}: ${res.status}`).toBe(`${verb} ${r}: 404`);
      }
    }
  });

  it('declares monitoring before the key route, so the word is never read as a key', () => {
    const routes = code('src/routes/algorithms.routes.ts');
    expect(routes.indexOf("router.get('/monitoring'")).toBeGreaterThan(0);
    expect(routes.indexOf("router.get('/monitoring'")).toBeLessThan(routes.indexOf("router.get('/:key'"));
  });

  it('a monitoring read writes nothing — not even this process\'s own unwritten minute', () => {
    const mon = code('src/algorithms/monitoring.ts');
    expect(mon).not.toMatch(/flushAlgorithmTelemetry|takePending|\$executeRaw/);
    expect(mon).toContain('peekPending()');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 · Cost: measuring must not slow Familista
// ─────────────────────────────────────────────────────────────────────────────

describe('the recorder is cheap enough to leave on', () => {
  it('adds microseconds, not milliseconds, to a call', () => {
    const input = { activeInjuryCount: 1, totalInjuryCount: 4, recentReturnDays: 20, acwr: 1.35 };
    const N = 100_000;
    // Warm both paths so the JIT measures steady state, not compilation.
    for (let i = 0; i < 5_000; i++) { computeMedicalRiskScore(input); observed('medical-risk', 'intelligence.unified-player', () => computeMedicalRiskScore(input), (s) => ({ outputs: [s], quality: 'OK' })); }
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) computeMedicalRiskScore(input);
    const direct = Number(process.hrtime.bigint() - t0) / N;
    t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) observed('medical-risk', 'intelligence.unified-player', () => computeMedicalRiskScore(input), (s) => ({ outputs: [s], quality: 'OK' }));
    const wrapped = Number(process.hrtime.bigint() - t0) / N;
    const overheadNs = wrapped - direct;
    // A generous ceiling for a shared CI runner; measured locally at well under 1µs.
    expect(overheadNs).toBeLessThan(20_000);
    // And it all landed in one hourly entry, not in 100 000 objects.
    expect(peekPending().length).toBeLessThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10 · The room draws it: three languages, no inline style, nothing moves
// ─────────────────────────────────────────────────────────────────────────────

describe('the room draws production monitoring in its own design system', () => {
  const js = read('public/algorithms/algorithms.js');
  const css = read('public/algorithms/algorithms.css');

  it('reads both monitoring endpoints, and checks their contract before drawing', () => {
    expect(js).toContain("api('/system/algorithms/monitoring')");
    expect(js).toContain("'/monitoring')");
    expect(js).toContain('REQUIRED.monitoring');
    expect(js).toContain('REQUIRED.production');
  });

  it('colours a state as a fact: green for Healthy only, dotted for the two that measured nothing', () => {
    const sandbox: Row = { window: {} };
    vm.runInNewContext(js, sandbox);
    const kind = sandbox.window.__familistaAlgorithmsMonKind as (s: string) => string;
    expect(kind('HEALTHY')).toBe('ok');
    expect(kind('WARNING')).toBe('warn');
    expect(kind('FAILING')).toBe('crit');
    expect(kind('NOT_ENOUGH_DATA')).toBe('none');
    expect(kind('NOT_INSTRUMENTED')).toBe('off');
    expect(css).toMatch(/\.al-chip--none\s*\{[^}]*border-style:\s*dotted/);
  });

  it('draws bars and columns with classes, never an inline style', () => {
    expect(js).not.toMatch(/style="/);
    expect(js).not.toMatch(/\.style\./);
    for (let i = 0; i <= 20; i++) expect(css).toContain(`.al-w-${i} {`);
    for (let i = 0; i <= 10; i++) expect(css).toContain(`.al-h-${i} {`);
    expect(css).not.toMatch(/@keyframes|animation:/);
  });

  it('mirrors in Arabic and stays inside the screen on a phone', () => {
    const added = css.slice(css.indexOf('/* ── production monitoring (Step 2)'), css.indexOf('/* ── empty, loading, notices'));
    expect(added.length).toBeGreaterThan(1000);
    expect(added).not.toMatch(/(?:margin|padding)-(?:left|right)\s*:|(?:^|[;{\s])(?:left|right)\s*:/m);
    expect(css).toContain('#al-root[dir="rtl"] .al-banner--warn');
    const hatch = css.slice(css.indexOf('@media (max-width: 980px), (max-height: 620px)'));
    expect(hatch).toContain('.al-mstates { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    expect(hatch).toContain('.al-tbl--mon .al-tr { grid-template-columns: minmax(0, 1fr) auto; }');
    expect(hatch).toContain('.al-dist-row { grid-template-columns: 76px minmax(0, 1fr) 54px; }');
    // Every grid track that holds text can shrink.
    expect(added).not.toMatch(/repeat\(\d+,\s*1fr\)/);
  });
});

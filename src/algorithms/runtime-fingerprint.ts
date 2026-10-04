// Familista — which algorithm code is this server actually running?
// ─────────────────────────────────────────────────────────────────────────────
// Step 1 compares an approval with the fingerprint of the source that shipped.
// This file answers the runtime half: it fingerprints the module file THIS
// PROCESS loaded for each registered algorithm, and proves — or fails to prove
// — that it is the approved code.
//
//   running from TypeScript (tsx, ts-jest)    the loaded file is the source;
//     basis SOURCE                            its fingerprint is compared with
//                                             the approval directly
//
//   running compiled (dist/, production)      the loaded file is tsc's output;
//     basis COMPILED                          its fingerprint must equal the one
//                                             the build sealed beside it
//                                             (scripts/algorithms-seal.js),
//                                             which names the source fingerprint
//                                             it was compiled from — and THAT
//                                             must equal the approval
//
// A verdict is MATCH only when the chain closes. A file changed after the
// build, a build compiled from unapproved source or an approval the code no
// longer matches is MISMATCH; a missing seal or an unreadable file is
// UNVERIFIED. Neither is ever shown as healthy.
//
// Computed once per process, at start (src/algorithms/telemetry-store.ts primes
// it before the first request), from the files on disk: a few small reads.
// Pure apart from those reads; nothing here writes or touches a database.

import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { ALGORITHMS, algorithmOf, type AlgorithmDecl } from './registry';

interface FingerprintCore {
  fingerprintText(text: string, symbols: string[], options?: { compiled?: boolean }): {
    fingerprint: string | null; missing: string[]; error: string | null;
  };
}
// Plain JavaScript shared with the build scripts; copied into dist/ by the build.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core: FingerprintCore = require('./fingerprint-core.js');

export type RuntimeBasis = 'SOURCE' | 'COMPILED';
export type RuntimeVerdict = 'MATCH' | 'MISMATCH' | 'UNVERIFIED';
export type RuntimeReason =
  | 'OK'
  | 'NOT_APPROVED'          // SOURCE: the loaded source is not the approved source
  | 'CHANGED_AFTER_BUILD'   // COMPILED: the loaded file is not what the build sealed
  | 'BUILD_NOT_APPROVED'    // COMPILED: the build was compiled from unapproved source
  | 'SEAL_MISSING'          // COMPILED: no seal beside the server, so no proof
  | 'UNREADABLE';           // the loaded file, or its declarations, could not be read

export interface RuntimeFingerprint {
  key: string;
  basis: RuntimeBasis;
  /** Repository-relative path of the file this process loaded, e.g. dist/fusion/metrics.js. */
  file: string;
  /** Fingerprint of the registered declarations in that file. */
  runtime: string | null;
  /** The source fingerprint the running code is proven to be; null when unproven. */
  source: string | null;
  approved: string | null;
  verdict: RuntimeVerdict;
  reason: RuntimeReason;
}

interface SealEntry { file: string; source: string | null; compiled: string | null; error: string | null }
interface Seal { schemaVersion: number; algorithms: Record<string, SealEntry> }

/** The repository root: two levels above this file in src/ and in dist/ alike. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CODE_ROOT = path.resolve(__dirname, '..');
const RUNNING_BASIS: RuntimeBasis = path.extname(__filename) === '.js' ? 'COMPILED' : 'SOURCE';
const SEAL_PATH = path.join(__dirname, 'generated', 'algorithm-runtime-seal.json');

/** The file this process loads for a registered source file. */
export function loadedFileOf(decl: AlgorithmDecl, basis: RuntimeBasis = RUNNING_BASIS): string {
  const rel = decl.source.file.replace(/^src\//, '');
  return path.join(CODE_ROOT, basis === 'COMPILED' ? rel.replace(/\.ts$/, '.js') : rel);
}

export interface VerifyInput {
  basis: RuntimeBasis;
  /** The loaded file's text, or null when it could not be read. */
  text: string | null;
  /** The build seal, or null when there is none (COMPILED only). */
  seal: Seal | null;
  file: string;
}

/**
 * The verdict for one algorithm, from evidence passed in — so every branch can
 * be tested without touching the filesystem.
 */
export function verifyRuntime(decl: AlgorithmDecl, input: VerifyInput): RuntimeFingerprint {
  const approved = decl.approval?.fingerprint ?? null;
  const base = { key: decl.key, basis: input.basis, file: input.file, approved };
  const read = input.text === null ? null
    : core.fingerprintText(input.text, decl.source.symbols, { compiled: input.basis === 'COMPILED' });
  const runtime = read?.fingerprint ?? null;
  if (!runtime) return { ...base, runtime: null, source: null, verdict: 'UNVERIFIED', reason: 'UNREADABLE' };

  if (input.basis === 'SOURCE') {
    return runtime === approved
      ? { ...base, runtime, source: runtime, verdict: 'MATCH', reason: 'OK' }
      : { ...base, runtime, source: runtime, verdict: 'MISMATCH', reason: 'NOT_APPROVED' };
  }

  const sealed = input.seal?.algorithms?.[decl.key];
  if (!sealed || !sealed.compiled || !sealed.source) {
    return { ...base, runtime, source: null, verdict: 'UNVERIFIED', reason: 'SEAL_MISSING' };
  }
  if (sealed.compiled !== runtime) {
    return { ...base, runtime, source: null, verdict: 'MISMATCH', reason: 'CHANGED_AFTER_BUILD' };
  }
  return sealed.source === approved
    ? { ...base, runtime, source: sealed.source, verdict: 'MATCH', reason: 'OK' }
    : { ...base, runtime, source: sealed.source, verdict: 'MISMATCH', reason: 'BUILD_NOT_APPROVED' };
}

function readSeal(): Seal | null {
  try {
    const s = JSON.parse(fs.readFileSync(SEAL_PATH, 'utf8')) as Seal;
    return s && typeof s.algorithms === 'object' ? s : null;
  } catch { return null; }
}

interface Computed { at: string; durationMs: number; byKey: Map<string, RuntimeFingerprint> }
let computed: Computed | null = null;

function compute(): Computed {
  const t0 = performance.now();
  const seal = RUNNING_BASIS === 'COMPILED' ? readSeal() : null;
  const texts = new Map<string, string | null>();
  const byKey = new Map<string, RuntimeFingerprint>();
  for (const decl of ALGORITHMS) {
    const abs = loadedFileOf(decl);
    if (!texts.has(abs)) {
      let text: string | null = null;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { text = null; }
      texts.set(abs, text);
    }
    const file = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    byKey.set(decl.key, verifyRuntime(decl, { basis: RUNNING_BASIS, text: texts.get(abs) ?? null, seal, file }));
  }
  return { at: new Date().toISOString(), durationMs: +(performance.now() - t0).toFixed(3), byKey };
}

/** Every registered algorithm's runtime fingerprint, computed once per process. */
export function runtimeFingerprints(): { at: string; durationMs: number; basis: RuntimeBasis; list: RuntimeFingerprint[] } {
  if (!computed) computed = compute();
  return { at: computed.at, durationMs: computed.durationMs, basis: RUNNING_BASIS, list: [...computed.byKey.values()] };
}

/** One algorithm's runtime fingerprint, or null for a key the registry does not have. */
export function runtimeFingerprintOf(key: string): RuntimeFingerprint | null {
  if (!algorithmOf(key)) return null;
  if (!computed) computed = compute();
  return computed.byKey.get(key) ?? null;
}

/**
 * What a telemetry row records as "the code that ran": the proven source
 * fingerprint when there is one, otherwise the raw fingerprint of the loaded
 * file — which then matches no approval, as it should not.
 */
export function telemetryFingerprintOf(key: string): string {
  const f = runtimeFingerprintOf(key);
  return f?.source ?? f?.runtime ?? 'unavailable';
}

/** For tests: forget the computed fingerprints, so the next read recomputes them. */
export function resetRuntimeFingerprints(): void { computed = null; }

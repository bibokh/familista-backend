// Moving every sealed credential onto a new key, a page at a time
// ─────────────────────────────────────────────────────────────────────────────
// The operational half of the keyring. Rotating a key is four separate acts and
// this module is the third:
//
//   A · add material for a new kid            a deployment variable
//   B · name it active                        a deployment variable
//   C · old envelopes keep opening            automatic — they name their key
//   D · re-key the old envelopes              THIS MODULE, resumable
//   E · prove nothing references the old kid  `rewrapPlan` / `retirementCheck`
//   F · retire the old key                    a deployment variable
//
// Steps A, B and F are configuration and leave no code path to get wrong. D is
// the one that touches data, so it is built to be interrupted: it works in
// pages ordered by id, carries a cursor, and each row's write is guarded on the
// envelope it opened. Kill it halfway and the rows it finished stay finished;
// run it again and it resumes from the first row that is not.
//
// WHAT NEVER HAPPENS HERE
//
// No plaintext is returned, logged, emitted, or held longer than the two
// cryptographic operations that consume it — `rewrapEnvelope` opens and re-seals
// inside one function and hands back only ciphertext. Nothing in this module
// can be asked for a credential.
//
// A row it cannot open is LEFT ALONE. That is not politeness: a row whose key
// is missing is a row whose value cannot be recovered, and overwriting it with
// anything at all would destroy the only copy while making the ledger say the
// re-key succeeded.

import { logger } from '../../utils/logger';
import { emit } from '../event-bus';
import { DbSecretStore } from './db-secret-store';
import { LEGACY_KID, readKeyring, SecretKeyConfigError } from './keyring';
import { formatSecretRef } from './secret-ref';
import { getSecretStore, rewrapEnvelope } from './secret-store';

/** The store, when it is the database-backed one. Re-keying means nothing else. */
function dbStore(): DbSecretStore {
  const store = getSecretStore();
  if (!(store instanceof DbSecretStore)) {
    throw new Error(
      'Re-keying applies only to the database-backed secret store. '
      + 'The env store holds its values on the deployment and re-keys by changing them there.',
    );
  }
  return store;
}

export interface RewrapPlan {
  /** Rows per key, by recorded kid. `v1` covers rows written before the keyring. */
  byKid: Record<string, number>;
  activeKid: string | null;
  /** Rows not yet under the active key. Zero means step D is complete. */
  outstanding: number;
  /** Why a re-key cannot start, or null. */
  problem: string | null;
}

/**
 * What a re-key would have to do, without doing any of it.
 *
 * Read first, always. It answers step E as well as step D's scope: a kid with
 * zero rows is a kid nothing references.
 */
export async function rewrapPlan(): Promise<RewrapPlan> {
  const ring = readKeyring();
  const byKid = await dbStore().countByKid();
  const outstanding = ring.activeKid
    ? Object.entries(byKid).reduce((n, [kid, c]) => (kid === ring.activeKid ? n : n + c), 0)
    : Object.values(byKid).reduce((n, c) => n + c, 0);
  return { byKid, activeKid: ring.activeKid, outstanding, problem: ring.problem };
}

export interface RetirementCheck {
  kid: string;
  /** Live rows still sealed under this key. */
  referenced: number;
  safeToRetire: boolean;
  reason: string | null;
}

/**
 * Whether a key can be retired yet — step E, as a gate rather than a habit.
 *
 * Retiring a key that still seals rows makes those rows permanently unreadable,
 * and the failure does not show up until something tries to authenticate with
 * one. So the question gets a real answer from the data, and the answer for the
 * active key is always no.
 */
export async function retirementCheck(kid: string): Promise<RetirementCheck> {
  const ring = readKeyring();
  const byKid = await dbStore().countByKid();
  const referenced = byKid[kid] ?? 0;

  if (kid === ring.activeKid) {
    return { kid, referenced, safeToRetire: false, reason: 'it is the active key for new writes' };
  }
  if (referenced > 0) {
    return {
      kid, referenced, safeToRetire: false,
      reason: `${referenced} live secret(s) are still sealed under it — re-key them first`,
    };
  }
  return { kid, referenced: 0, safeToRetire: true, reason: null };
}

export interface RewrapOptions {
  /** Rows per page. Kept modest by default: this is a background chore. */
  limit?: number;
  /** Resume point — the `cursor` from the previous report. */
  after?: string | null;
  /** Stop after this many rows, so one invocation has a bounded cost. */
  max?: number;
  /** Recorded on every event. A person or `SYSTEM`, never a credential. */
  actor?: string | null;
}

export interface RewrapReport {
  toKid: string | null;
  scanned: number;
  rewrapped: number;
  /** Rows already under the active key, or replaced underneath us. */
  skipped: number;
  /** Rows that could not be opened. Left exactly as they were. */
  unreadable: number;
  /** Pass back as `after` to continue. Null when the scan reached the end. */
  cursor: string | null;
  done: boolean;
  problem: string | null;
}

/**
 * Step D. Re-key one bounded batch and report where to resume.
 *
 * Deliberately not a loop that runs to completion: a re-key over a large table
 * should be something an operator can start, watch and stop, and something a
 * scheduled job can do a slice of. Call it until `done`.
 */
export async function rewrapBatch(opts: RewrapOptions = {}): Promise<RewrapReport> {
  const ring = readKeyring();
  const empty: RewrapReport = {
    toKid: ring.activeKid, scanned: 0, rewrapped: 0, skipped: 0, unreadable: 0,
    cursor: opts.after ?? null, done: false, problem: ring.problem,
  };

  // No active key means no target to re-key ONTO. Refusing here is the same
  // fail-closed rule the seal path uses, for the same reason.
  if (!ring.activeKid) return { ...empty, problem: ring.problem ?? 'no active key-encryption key is configured' };

  const store = dbStore();
  const toKid = ring.activeKid;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const max = Math.max(opts.max ?? limit, 1);

  let cursor = opts.after ?? null;
  let scanned = 0; let rewrapped = 0; let skipped = 0; let unreadable = 0;
  let done = false;

  while (scanned < max) {
    const page = await store.pageForRewrap(toKid, { after: cursor, limit: Math.min(limit, max - scanned) });
    if (page.length === 0) { done = true; break; }

    for (const row of page) {
      cursor = row.id;
      scanned += 1;

      const ref = formatSecretRef({ provider: 'db', scope: row.scope, name: row.name, version: row.version });
      const fromKid = row.kid ?? LEGACY_KID;

      let out: { sealed: string; fromKid: string; toKid: string } | null = null;
      try {
        // Opens and re-seals inside one call. The plaintext is a local in there
        // and does not cross this boundary.
        out = rewrapEnvelope(row.sealed);
      } catch (err) {
        // A missing or retired key for THIS row. Not fatal to the batch: the
        // rest of the table may be perfectly re-keyable, and stopping the whole
        // scan on one orphaned row is how a re-key never finishes.
        if (!(err instanceof SecretKeyConfigError)) throw err;
        unreadable += 1;
        logger.warn('[secrets] a sealed row names a key this deployment cannot resolve; left unchanged', {
          ref, fromKid, err: (err as Error).message,
        });
        continue;
      }

      if (!out) {
        unreadable += 1;
        logger.warn('[secrets] a sealed row could not be opened; left unchanged', { ref, fromKid });
        continue;
      }

      const applied = await store.applyRewrap(row.id, row.sealed, out.sealed);
      if (!applied) { skipped += 1; continue; }

      rewrapped += 1;
      // The audit record: which secret, from which key to which key, by whom.
      // Two key NAMES and a reference. No material of any kind, and nothing
      // here could be used to open anything.
      void emit({
        eventType: 'secret.kek.rewrapped',
        clubId: null,
        subjectType: 'PLATFORM_SECRET',
        subjectId: row.id,
        sourceType: 'SERVICE',
        payload: { secretRef: ref, fromKid: out.fromKid, toKid: out.toKid, actor: opts.actor ?? 'SYSTEM' },
      });
    }

    if (page.length < limit) { done = true; break; }
  }

  return { toKid, scanned, rewrapped, skipped, unreadable, cursor, done, problem: null };
}

/**
 * Record that a key became active, or was retired.
 *
 * Configuration changes leave no trace in the database by themselves, and "when
 * did this key become active" is the first question asked after an incident. So
 * the operator performing step B or step F records it, and the record carries
 * names only.
 */
export async function recordKeyLifecycle(
  action: 'activated' | 'retired',
  kid: string,
  opts: { actor?: string | null; note?: string | null } = {},
): Promise<void> {
  await emit({
    eventType: action === 'activated' ? 'secret.kek.activated' : 'secret.kek.retired',
    clubId: null,
    subjectType: 'PLATFORM_SECRET',
    subjectId: kid,
    sourceType: 'SERVICE',
    payload: { kid, actor: opts.actor ?? 'SYSTEM', note: opts.note ?? null },
  });
}

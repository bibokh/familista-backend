// Cyber Defense — login lockout, in shadow mode
// ─────────────────────────────────────────────────────────────────────────────
// Step 5. `security/login-attempt.service.ts` has held a lockout since Phase I —
// 5 failed sign-ins on one account in 15 minutes, or 20 from one address in 5 —
// and nothing has ever called it. Switching it on blind would risk locking the
// platform owner out of their own platform, and would hand anyone who knows an
// e-mail address a way to do exactly that.
//
// So first it runs in shadow: every sign-in outcome is measured against those
// same thresholds (imported, not copied), and an attempt the lockout WOULD have
// refused is recorded as `security.lockout.triggered` with `shadow: true`.
// Nothing is refused. Nothing about any response changes.
//
// WHAT IT MIRRORS
//
// `assertNotLocked` runs BEFORE the password is checked and counts failures in
// the window. So here the decision is taken before this attempt is counted, it
// applies to successful attempts as well, and a success does not reset the
// count. A successful sign-in that would have been refused is recorded with
// `attemptSucceeded: true` — it is either the false positive to know about
// before enforcing, or a correct password arriving after a run of failures.
//
// WHAT IT KEEPS, AND WHERE
//
// In this process's memory only: per account, keyed by the SHA-256 of the
// normalised e-mail (the lockout service's own `emailHash`), and per address,
// the timestamps of recent failures. No database row, no e-mail, no user agent.
// An event carries the address as a /24 or /48 prefix and, when the account
// threshold is the reason, `accountRef` — the first 16 hex characters of that
// hash, a pseudonym the existing LoginAttempt table already stores in full.
//
// LIMITS, STATED
//
// Per process: with more than one instance each counts its own share, so the
// shadow under-reports rather than over-reports. Bounded memory: past
// `MAX_KEYS` per scope the oldest keys are dropped, which can also only
// under-report. Events go through the Step 4 flood cap (one per account or
// address per minute, `suppressedBefore` on the next).

import type { Request } from 'express';
import {
  emailHash,
  EMAIL_FAIL_THRESHOLD, EMAIL_FAIL_WINDOW_MS,
  IP_FAIL_THRESHOLD, IP_FAIL_WINDOW_MS,
} from '../security/login-attempt.service';
import { emit } from './collectors';
import { ipPrefix } from './security-event-schema';

export const MAX_KEYS = 10_000;
/** Kept per key; enough to report a count well past either threshold. */
const MAX_STAMPS = 100;

const byAccount = new Map<string, number[]>();
const byAddress = new Map<string, number[]>();

/** Failures for `key` inside the window, pruning the rest. */
function failuresIn(map: Map<string, number[]>, key: string | null, windowMs: number, now: number): number {
  if (!key) return 0;
  const stamps = map.get(key);
  if (!stamps) return 0;
  const live = stamps.filter((t) => now - t < windowMs);
  if (live.length) map.set(key, live); else map.delete(key);
  return live.length;
}

function noteFailure(map: Map<string, number[]>, key: string | null, now: number): void {
  if (!key) return;
  const stamps = map.get(key) ?? [];
  stamps.push(now);
  if (stamps.length > MAX_STAMPS) stamps.splice(0, stamps.length - MAX_STAMPS);
  map.delete(key);
  map.set(key, stamps);
  while (map.size > MAX_KEYS) map.delete(map.keys().next().value as string);
}

/**
 * One finished `/auth/login` request. `status` is the response status: 200 is
 * a sign-in, 401 a refused credential; anything else (a validation 400, a 503)
 * was not a password check and is ignored.
 */
export function recordShadowLoginOutcome(req: Request, email: string, status: number): void {
  try {
    if (status !== 200 && status !== 401) return;
    const now = Date.now();
    const account = email ? emailHash(email) : null;
    const address = typeof req.ip === 'string' && req.ip ? req.ip : null;

    // Decided before this attempt is counted, as `assertNotLocked` would be.
    const accountFailures = failuresIn(byAccount, account, EMAIL_FAIL_WINDOW_MS, now);
    const addressFailures = failuresIn(byAddress, address, IP_FAIL_WINDOW_MS, now);
    const accountHit = accountFailures >= EMAIL_FAIL_THRESHOLD;
    const addressHit = addressFailures >= IP_FAIL_THRESHOLD;

    if (accountHit || addressHit) {
      const succeeded = status === 200;
      const accountRef = account ? account.slice(0, 16) : null;
      emit('security.lockout.triggered', req, {
        outcome: 'DETECTED',
        severity: succeeded ? 'HIGH' : 'MEDIUM',
        actor: { type: 'ANONYMOUS', role: null },
        source: { component: 'AUTH', requestId: requestIdOf(req), ipPrefix: ipPrefix(address) },
        evidence: {
          shadow: true,
          scope: accountHit && addressHit ? 'BOTH' : accountHit ? 'ACCOUNT' : 'ADDRESS',
          attemptSucceeded: succeeded,
          accountFailures,
          addressFailures,
          accountThreshold: EMAIL_FAIL_THRESHOLD,
          addressThreshold: IP_FAIL_THRESHOLD,
          accountWindowMinutes: EMAIL_FAIL_WINDOW_MS / 60_000,
          addressWindowMinutes: IP_FAIL_WINDOW_MS / 60_000,
          ...(accountHit && accountRef ? { accountRef } : {}),
        },
        privacyClass: 'PERSONAL',
      }, {
        // Success and failure are capped apart, so a would-be-refused correct
        // password is never hidden behind the failures that preceded it.
        sourceKey: `${succeeded ? 'ok' : 'fail'}|`
          + (accountHit && accountRef ? `a:${accountRef}` : `ip:${ipPrefix(address) ?? 'unknown'}`),
      });
    }

    if (status === 401) {
      noteFailure(byAccount, account, now);
      noteFailure(byAddress, address, now);
    }
  } catch { /* shadow mode never affects a sign-in */ }
}

function requestIdOf(req: Request): string | null {
  const id = (req as Request & { requestId?: string }).requestId;
  return typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(id) ? id : null;
}

/** Tests only. */
export function resetLockoutShadow(): void {
  byAccount.clear();
  byAddress.clear();
}

/** Tests and a future status surface: how many keys are being watched. */
export function lockoutShadowSize(): { accounts: number; addresses: number } {
  return { accounts: byAccount.size, addresses: byAddress.size };
}

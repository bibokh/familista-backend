// Cyber Defense, Step 10 — the scheduled backup, triggered from outside
// ─────────────────────────────────────────────────────────────────────────────
// A GitHub Actions schedule asks the running service to take its backup. The
// request carries nothing but proof that it came from the holder of
// BACKUP_TRIGGER_SECRET: no body, no query, no configuration. What runs is the
// fixed backup runner with the service's own environment — the database it is
// already connected to, and the bucket, keys and endpoint set on the service.
//
//   authentication   HMAC-SHA256(secret, METHOD \n PATH \n TIMESTAMP), hex,
//                    compared in constant time; the timestamp must be within
//                    five minutes of the server's clock. The secret never
//                    travels. Without a configured secret nothing is accepted.
//   one at a time    a PostgreSQL advisory lock, so two requests — or two
//                    instances — cannot run two backups.
//   once a day       a new run is refused while the last successful backup is
//                    less than 20 hours old, so a replayed or leaked request can
//                    cause at most one extra backup a day.
//   state            the run is a BackupRecord from its first moment: created
//                    as running, completed by the runner as succeeded or failed.
//                    A run the process never finished (a restart mid-backup)
//                    reads as failed once it is older than the longest a run
//                    may take.

import { createHmac, timingSafeEqual } from 'crypto';

export const TRIGGER_WINDOW_SECONDS = 300;
export const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
export const MAX_RUN_MS = 90 * 60 * 1000;
/** Shortest secret accepted: 32 characters (e.g. `openssl rand -hex 32` gives 64). */
export const MIN_SECRET_LENGTH = 32;

// ── authentication ──────────────────────────────────────────────────────────

/** The trigger secret, or null — which closes the endpoint — when unset or too short. */
export function triggerSecret(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = (env.BACKUP_TRIGGER_SECRET ?? '').trim();
  return raw.length >= MIN_SECRET_LENGTH ? Buffer.from(raw, 'utf8') : null;
}

/** The string that is signed: method, path and timestamp, one per line. */
export function signingInput(method: string, path: string, timestamp: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}`;
}

export function signTrigger(secret: Buffer | string, method: string, path: string, timestamp: string): string {
  return createHmac('sha256', secret).update(signingInput(method, path, timestamp)).digest('hex');
}

export type TriggerVerdict = 'ok' | 'unauthenticated' | 'stale';

/**
 * Checks one request. `stale` and `unauthenticated` are distinguished for the
 * log only; the caller answers both the same way.
 */
export function verifyTrigger(
  secret: Buffer,
  req: { method: string; path: string; timestamp?: string; signature?: string },
  nowSeconds: number,
): TriggerVerdict {
  const ts = req.timestamp ?? '';
  const sig = req.signature ?? '';
  if (!/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return 'unauthenticated';
  const expected = Buffer.from(signTrigger(secret, req.method, req.path, ts), 'hex');
  const given = Buffer.from(sig, 'hex');
  // Both are 32 bytes here; the length check keeps timingSafeEqual from throwing.
  const match = given.length === expected.length && timingSafeEqual(given, expected);
  if (!match) return 'unauthenticated';
  if (Math.abs(nowSeconds - Number(ts)) > TRIGGER_WINDOW_SECONDS) return 'stale';
  return 'ok';
}

// ── runs ─────────────────────────────────────────────────────────────────────

export type RunState = 'running' | 'succeeded' | 'failed';

/** What the status endpoint may say about a run. Nothing else leaves the service. */
export interface RunStatus {
  id: string;
  state: RunState;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
}

export interface RunRow { id: string; startedAt: Date; finishedAt: Date | null; ok: boolean }

/** The persistence and locking a run needs. Prisma in production; fakes in tests. */
export interface BackupRunStore {
  /** Runs `fn` holding the global backup lock, or calls it with `false` when another holder has it. */
  withLock<T>(fn: (acquired: boolean) => Promise<T>): Promise<T>;
  lastSuccessAt(): Promise<Date | null>;
  latestUnfinished(): Promise<RunRow | null>;
  createRunning(startedAt: Date): Promise<string>;
  find(id: string): Promise<RunRow | null>;
}

export function statusOf(row: RunRow, now: Date): RunStatus {
  const state: RunState = row.finishedAt
    ? (row.ok ? 'succeeded' : 'failed')
    // Never finished: still going, or lost to a restart.
    : (now.getTime() - row.startedAt.getTime() > MAX_RUN_MS ? 'failed' : 'running');
  return {
    id: row.id,
    state,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    ok: state === 'succeeded',
  };
}

export type StartResult =
  | { kind: 'started'; id: string }
  | { kind: 'running'; id: string | null }
  | { kind: 'recent'; lastSuccessAt: string }
  | { kind: 'error' };

/**
 * Starts one backup if none is running and none succeeded in the last 20
 * hours. Resolves as soon as that is decided; the backup itself carries on in
 * the background, holding the lock until it finishes. `run` is the fixed
 * runner, bound to the run's record — nothing about it comes from the request.
 */
export function startBackupRun(deps: {
  store: BackupRunStore;
  run: (id: string) => Promise<unknown>;
  now?: () => Date;
  onBackgroundError?: (err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<StartResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return new Promise<StartResult>((resolve) => {
    let decided = false;
    const decide = (r: StartResult) => { if (!decided) { decided = true; resolve(r); } };
    // The lock can be held a moment before its holder has written the run
    // record (or a moment after it has finished): retry briefly, then report.
    const attempt = async (tries: number): Promise<void> => {
      let busy = false;
      await deps.store.withLock(async (acquired) => {
        if (!acquired) { busy = true; return; }
        const last = await deps.store.lastSuccessAt();
        if (last && now().getTime() - last.getTime() < MIN_INTERVAL_MS) {
          decide({ kind: 'recent', lastSuccessAt: last.toISOString() });
          return;
        }
        const id = await deps.store.createRunning(now());
        decide({ kind: 'started', id });
        await deps.run(id);
      });
      if (!busy) return;
      const running = await deps.store.latestUnfinished();
      if (running || tries <= 0) {
        decide({ kind: 'running', id: running?.id ?? null });
        return;
      }
      await sleep(200);
      return attempt(tries - 1);
    };
    attempt(5).catch((err) => {
      if (!decided) decide({ kind: 'error' });
      else deps.onBackgroundError?.(err);
    });
  });
}

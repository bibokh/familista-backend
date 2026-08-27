// Familista — distributed lease / leader election
// ─────────────────────────────────────────────────────────────────────────────
// `src/server.ts` starts six background timers. Each of them assumes it is the
// only one: the settlement sweep, the notification dispatcher, the stats
// aggregator, the transcode poller, retention, the AI agent. Start a second
// process and every one of them runs twice — two sweeps racing the same due
// auction, two dispatchers sending the same notification, two transcoders
// claiming the same job.
//
// This is the thing that makes exactly one process the owner.
//
// ── How it works
//
// A lease is a Redis key holding a random token, set with NX and an expiry. The
// process that wins the SET owns the lease; everyone else retries. The owner
// renews at a third of the TTL, and renewal is a compare-and-extend in Lua — it
// extends the key ONLY if the token is still its own — so a process that was
// paused past its expiry cannot come back and steal a lease that has since been
// taken by someone else. That is the failure mode a plain `PEXPIRE` has, and it
// is exactly the one that would let two settlement sweeps run.
//
// ── What happens when Redis is unreachable
//
// The owner STOPS. It does not carry on assuming it still holds the lease. A
// process that cannot see Redis also cannot see whether the lease expired and
// another process took it, and the cost of guessing wrong is duplicated work on
// live money. A settlement sweep that is thirty seconds late is invisible; two
// sweeps settling one auction is not.
//
// When Redis is NOT configured at all there is by definition one process — the
// cluster refuses to fan out without Redis — so `isSoleProcess()` is true and
// the callers run their timers directly, exactly as they always did.

import { randomUUID } from 'crypto';
import { getRedis, redisConfigured, rkey } from './redis';
import { logger } from '../utils/logger';

/** This process, distinctly. Survives nothing — that is the point of a lease. */
export const INSTANCE_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/** No Redis means no second process is possible, so this one owns everything. */
export function isSoleProcess(): boolean {
  return !redisConfigured();
}

// Extend only if still ours.
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

// Release only if still ours. Deleting someone else's lease is the same bug as
// extending it.
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface LeaseHandle {
  /** Do we hold it at this instant? */
  held(): boolean;
  /** Stop renewing and hand it back. Safe to call twice. */
  release(): Promise<void>;
}

export interface LeaseOptions {
  /** How long the lease survives without renewal. */
  ttlMs?: number;
  /** Called when this process becomes the owner. */
  onAcquire: () => void | Promise<void>;
  /** Called when it stops being the owner — lost, expired, or Redis went away. */
  onRelease: () => void | Promise<void>;
}

const DEFAULT_TTL_MS = parseInt(process.env.LEASE_TTL_MS ?? '30000', 10);

/**
 * Hold `name` for as long as this process is alive and Redis agrees.
 *
 * Calls `onAcquire` when ownership starts and `onRelease` when it ends, so the
 * caller never has to ask "am I the leader" — it is told. Both are invoked at
 * most once per transition, never twice in a row for the same state.
 */
export function holdLease(name: string, opts: LeaseOptions): LeaseHandle {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const key = rkey('lease', name);
  const token = `${INSTANCE_ID}:${randomUUID()}`;
  // A third of the TTL: two renewals may fail before the lease is at risk, so a
  // single blip does not hand ownership around.
  const renewMs = Math.max(1000, Math.floor(ttlMs / 3));

  let owned = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function lose(why: string): Promise<void> {
    if (!owned) return;
    owned = false;
    logger.warn('[lease] released', { name, why, instance: INSTANCE_ID });
    try { await opts.onRelease(); } catch (err) {
      logger.error('[lease] onRelease threw', { name, err: (err as Error).message });
    }
  }

  async function beat(): Promise<void> {
    if (stopped) return;
    const client = getRedis('cmd');
    if (!client) { await lose('redis not configured'); return; }

    try {
      if (owned) {
        const extended = await client.eval(RENEW_LUA, 1, key, token, String(ttlMs)) as number;
        if (extended !== 1) {
          // Someone else holds it now. That is legitimate — we were slow, or we
          // were partitioned — and the only correct response is to stand down.
          await lose('lease taken by another process');
        }
      } else {
        const won = await client.set(key, token, 'PX', ttlMs, 'NX');
        if (won === 'OK') {
          owned = true;
          logger.info('[lease] acquired', { name, instance: INSTANCE_ID, ttlMs });
          try { await opts.onAcquire(); } catch (err) {
            logger.error('[lease] onAcquire threw', { name, err: (err as Error).message });
          }
        }
      }
    } catch (err) {
      // Redis unreachable. Fail closed: if we were the owner we stop being it.
      await lose('redis error: ' + (err as Error).message);
    } finally {
      if (!stopped) {
        timer = setTimeout(() => { void beat(); }, renewMs);
        timer.unref?.();
      }
    }
  }

  void beat();

  return {
    held: () => owned,
    async release() {
      if (stopped) return;
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      const wasOwned = owned;
      await lose('shutting down');
      if (!wasOwned) return;
      const client = getRedis('cmd');
      if (!client) return;
      // Hand it back immediately rather than making the next process wait out
      // the TTL. A deploy should not cost thirty seconds of nobody settling.
      try { await client.eval(RELEASE_LUA, 1, key, token); } catch { /* it expires anyway */ }
    },
  };
}

/**
 * Run `fn` at most once across all processes within `ttlMs`.
 *
 * For one-shot work that must not double-run and is not worth a standing lease.
 * Returns `false` when another process already claimed it. When Redis is
 * unreachable it returns `false` — refusing to run is the safe direction for
 * anything that needed this guard in the first place.
 */
export async function runOnce(name: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean> {
  if (isSoleProcess()) { await fn(); return true; }
  const client = getRedis('cmd');
  if (!client) return false;
  const key = rkey('once', name);
  try {
    const won = await client.set(key, INSTANCE_ID, 'PX', ttlMs, 'NX');
    if (won !== 'OK') return false;
  } catch (err) {
    logger.error('[lease] runOnce could not reach redis — skipping', {
      name, err: (err as Error).message,
    });
    return false;
  }
  await fn();
  return true;
}

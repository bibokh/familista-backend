// Familista — shared Redis infrastructure
// ─────────────────────────────────────────────────────────────────────────────
// One place that owns the connections, so that every piece of state which
// cannot be process-local — rate-limit buckets, device nonces, worker
// ownership, websocket fan-out — reaches the same Redis and reports the same
// health.
//
// ── What Redis is for here
//
// Nothing in this file is a cache. Everything that moved to Redis moved because
// a second Node process would otherwise get the WRONG ANSWER, not because it
// would be slower:
//
//   · a rate-limit bucket per process is N × the configured limit
//   · a nonce remembered on process A is not a replay when it lands on B
//   · a settlement timer in every process is N processes racing one auction
//   · a broadcast raised on A never reaches a socket held by B
//
// ── What happens when Redis is not there
//
// Two different answers, because the two failures are not the same failure.
//
// REDIS IS NOT CONFIGURED (`REDIS_URL` unset). This is the single-process
// deployment, and it is a supported one. Every caller keeps its in-process
// implementation, which is correct for one process. Clustering refuses to
// start (see `cluster.ts`), so the assumptions above are never violated.
//
// REDIS IS CONFIGURED AND DOWN. Now the deployment believes it is sharing
// state and is not, so the honest response depends on what the state protects:
//
//   · REPLAY PROTECTION fails CLOSED. A nonce store that cannot answer
//     "have I seen this before" must not answer "no". The request is refused.
//     Refusing a device is recoverable; accepting a replayed one is not.
//
//   · RATE LIMITS fall back to the LOCAL store and shout. The ceiling is still
//     enforced — it just becomes per-process, so N processes allow at most
//     N × capacity instead of one. That is a degradation with a known bound,
//     and it is not "protection disabled": the limiter still refuses abuse. It
//     is logged at error level on every state change and reported by
//     `redisStatus()` for the health endpoint, so it cannot pass unnoticed.
//
//   · WEBSOCKET FAN-OUT degrades to local delivery. Clients on the affected
//     process see stale prices until they re-read. Nothing stored is wrong.
//
//   · WORKER OWNERSHIP fails CLOSED. A process that cannot confirm it holds
//     the lease stops running the timers rather than assuming it may. Better a
//     sweep is late than settled twice.
//
// The rule, stated once: a Redis outage may cost availability or freshness. It
// may never quietly cost a security property.

import Redis, { type RedisOptions } from 'ioredis';
import { logger } from '../utils/logger';

export const REDIS_PREFIX = process.env.REDIS_PREFIX ?? 'familista';

/** Is this deployment configured to share state at all? */
export function redisConfigured(): boolean {
  return !!process.env.REDIS_URL;
}

/** Namespaced key. Every key this codebase writes goes through here. */
export function rkey(...parts: Array<string | number>): string {
  return REDIS_PREFIX + ':' + parts.join(':');
}

// ── connection health ───────────────────────────────────────────────────────
// `ioredis` reconnects on its own; what matters to callers is a single boolean
// they can consult before deciding how to fail. It flips on the connection
// events rather than being probed, so reading it costs nothing.

type Role = 'cmd' | 'sub' | 'pub';

const clients = new Map<Role, Redis>();
const healthy = new Map<Role, boolean>();
let everConnected = false;
let lastOutageAt: number | null = null;
let outages = 0;

function options(role: Role): RedisOptions {
  return {
    connectTimeout: 4000,
    // A command issued while the socket is down should fail NOW, so the caller
    // can apply its own failure policy. Queueing it would turn a Redis outage
    // into a request that hangs until it times out somewhere else.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // Backoff, capped. A long outage must not become a reconnect storm.
    retryStrategy: (times: number) => Math.min(1000 * times, 10_000),
    lazyConnect: false,
    connectionName: `familista-${role}-${process.pid}`,
  };
}

function markHealthy(role: Role, ok: boolean, why?: string): void {
  const before = healthy.get(role);
  if (before === ok) return;
  healthy.set(role, ok);
  if (ok) {
    everConnected = true;
    logger.info(`[redis] ${role} connection healthy`, { pid: process.pid });
  } else {
    outages++;
    lastOutageAt = Date.now();
    // Error level, deliberately. Something that was global is now local, and
    // an operator has to be able to see that in the logs without looking for it.
    logger.error(`[redis] ${role} connection LOST — shared state is degraded`, {
      pid: process.pid, why: why ?? 'unknown',
    });
  }
}

/**
 * The client for `role`, or null when Redis is not configured.
 *
 * Roles exist because a connection in subscriber mode cannot issue ordinary
 * commands — that is a Redis protocol rule, not a preference — so the pub/sub
 * bridge needs its own socket, and the publisher gets one too so a slow
 * subscriber cannot stall an ordinary command.
 */
export function getRedis(role: Role = 'cmd'): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  const existing = clients.get(role);
  if (existing) return existing;

  const client = new Redis(url, options(role));
  client.on('ready',      () => markHealthy(role, true));
  client.on('connect',    () => markHealthy(role, true));
  client.on('end',        () => markHealthy(role, false, 'connection ended'));
  client.on('close',      () => markHealthy(role, false, 'connection closed'));
  client.on('reconnecting', () => markHealthy(role, false, 'reconnecting'));
  client.on('error', (err: Error) => markHealthy(role, false, err.message));
  clients.set(role, client);
  healthy.set(role, false);
  logger.info('[redis] client created', { role, pid: process.pid, url: redactUrl(url) });
  return client;
}

/**
 * Is the shared store usable right now?
 *
 * `false` when Redis is configured but unreachable — which is the case every
 * fail-safe decision in this codebase branches on. When Redis is NOT configured
 * this is also `false`, and callers distinguish the two with `redisConfigured()`:
 * unconfigured means "you are alone, your local implementation is correct",
 * configured-but-down means "you are not alone and you cannot see the others".
 */
export function redisHealthy(role: Role = 'cmd'): boolean {
  if (!redisConfigured()) return false;
  const c = clients.get(role) ?? getRedis(role);
  if (!c) return false;
  return c.status === 'ready' && healthy.get(role) !== false;
}

/** For the ops/health endpoint. Never throws. */
export function redisStatus() {
  const roles: Role[] = ['cmd', 'sub', 'pub'];
  const per: Record<string, string> = {};
  for (const r of roles) {
    const c = clients.get(r);
    if (c) per[r] = c.status;
  }
  return {
    configured: redisConfigured(),
    healthy:    redisHealthy('cmd'),
    everConnected,
    connections: per,
    outages,
    lastOutageAt: lastOutageAt ? new Date(lastOutageAt).toISOString() : null,
    prefix: REDIS_PREFIX,
  };
}

/**
 * Resolve when `client` is ready to take commands, or reject on timeout.
 *
 * This is not a nicety. `enableOfflineQueue: false` — which is deliberate,
 * because a command issued during an outage must fail rather than hang — also
 * means a command issued during the FIRST connect fails, since the socket is
 * not writable yet. Anything that runs at boot has to wait for `ready` before
 * it speaks, or it will conclude Redis is down a few milliseconds before it
 * comes up.
 */
export function whenReady(client: Redis, timeoutMs = 5000): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('redis not ready within ' + timeoutMs + 'ms')); }, timeoutMs);
    const onReady = () => { cleanup(); resolve(); };
    const onEnd   = () => { cleanup(); reject(new Error('redis connection ended')); };
    function cleanup() {
      clearTimeout(timer);
      client.off('ready', onReady);
      client.off('end', onEnd);
    }
    client.once('ready', onReady);
    client.once('end', onEnd);
  });
}

/**
 * Connect and verify, once, at boot.
 *
 * Returns whether the shared store actually answered. The caller — `server.ts`,
 * and `cluster.ts` before it forks — uses it to decide whether clustering is
 * allowed to start, because "REDIS_URL is set" is a statement of intent and
 * "Redis replied to PING" is a fact.
 */
export async function verifyRedis(timeoutMs = 5000): Promise<boolean> {
  if (!redisConfigured()) return false;
  const c = getRedis('cmd');
  if (!c) return false;
  try {
    await whenReady(c, timeoutMs);
    const pong = await c.ping();
    const ok = pong === 'PONG';
    if (ok) markHealthy('cmd', true);
    return ok;
  } catch (err) {
    logger.error('[redis] verification failed', { err: (err as Error).message });
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  for (const [role, c] of clients) {
    try { await c.quit(); } catch { try { c.disconnect(); } catch { /* nothing left to do */ } }
    healthy.set(role, false);
  }
  clients.clear();
}

function redactUrl(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}

/** Test seam — drops memoised clients so a suite can point at a new URL. */
export function __resetRedisForTests(): void {
  for (const c of clients.values()) { try { c.disconnect(); } catch { /* ignore */ } }
  clients.clear();
  healthy.clear();
}

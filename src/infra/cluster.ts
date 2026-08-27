// Familista — multi-core workers
// ─────────────────────────────────────────────────────────────────────────────
// Node runs one thread. The machine has four cores, and measurement showed
// ordinary reads leaving three of them idle while one process served everything.
// This forks a process per core and lets the kernel spread connections across
// them.
//
// ── The gate, and why it is a gate rather than a flag
//
// Fanning out is only correct once the state that cannot be process-local is
// actually shared. Before Redis, a second process meant: rate limits N times
// looser than configured, nonces that replay successfully on whichever process
// did not see them, six background timers running N times, and websocket
// broadcasts reaching a quarter of the clients that should get them.
//
// So clustering refuses to start unless Redis ANSWERED — not "REDIS_URL is set",
// which is a statement of intent, but a PING that came back. A misconfigured URL,
// a Redis that is still booting, a firewall rule: each of those would otherwise
// produce a four-process deployment believing it was sharing state and sharing
// none of it, which is strictly worse than the single process it replaced.
// When the check fails the service starts anyway — as one process, correct and
// slower — and says why. It never silently degrades into the unsafe shape.
//
// ── Budgets that must be divided, not multiplied
//
// Each worker builds its own Prisma pool and its own libuv thread pool. Left
// alone, four workers would open 4 × 25 = 100 database connections against a
// server permitting 100, and ask for 4 × 8 = 32 libuv threads on 4 cores. Both
// numbers are shares of a fixed resource, so the primary divides them and passes
// each worker its portion. The deployment's totals are unchanged; only the
// number of processes splitting them went up.

import cluster from 'cluster';
import os from 'os';
import fs from 'fs';
import { verifyRedis, redisConfigured } from './redis';
import { logger } from '../utils/logger';

/**
 * How many CPUs this process may actually use.
 *
 * `os.cpus().length` reports the cores of the HOST, not the share this
 * container is allowed. On a managed platform those are wildly different
 * numbers: a one-CPU instance scheduled onto a sixteen-core machine reports
 * sixteen. Forking sixteen workers onto one CPU is far worse than not
 * clustering at all — sixteen event loops timeslicing one core, sixteen Prisma
 * pools, sixteen sets of GC threads — and it would happen silently, because
 * every number involved looks plausible.
 *
 * The container's real allowance is its cgroup CPU quota, so read that first
 * and fall back to the host count only when there is no quota (an unrestricted
 * machine, where the two agree anyway).
 */
export function effectiveCpus(): number {
  const host = Math.max(1, os.cpus().length);
  try {
    // cgroup v2: "<quota> <period>", or "max <period>" when unrestricted.
    const v2 = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (v2.length === 2 && v2[0] !== 'max') {
      const quota = Number(v2[0]), period = Number(v2[1]);
      if (Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0) {
        // A fractional allowance (Render's 0.5-CPU Starter) floors to ONE, and
        // must not fall through to the host count — falling through is how a
        // half-CPU instance would end up forking a worker per host core.
        return Math.max(1, Math.min(Math.floor(quota / period), host));
      }
    } else if (v2[0] === 'max') {
      return host;
    }
  } catch { /* not cgroup v2 */ }
  try {
    // cgroup v1: quota of -1 means unrestricted.
    const quota  = parseInt(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim(), 10);
    const period = parseInt(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim(), 10);
    if (quota > 0 && period > 0) {
      // Same flooring rule as v2: a positive quota always yields at least one.
      return Math.max(1, Math.min(Math.floor(quota / period), host));
    }
  } catch { /* not cgroup v1 */ }
  return host;
}

/** How many processes the operator asked for. 1 (or unset) means don't cluster. */
export function desiredWorkers(): number {
  const raw = process.env.WEB_CONCURRENCY ?? process.env.CLUSTER_WORKERS ?? '1';
  const cpus = effectiveCpus();
  if (raw.trim().toLowerCase() === 'auto') return Math.max(1, cpus);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 1) return 1;
  // More processes than usable CPUs buys nothing for CPU-bound work and costs
  // memory and database connections — so an explicit number is capped too, not
  // just `auto`.
  return Math.min(n, Math.max(1, cpus));
}

/** Split a fixed budget across the workers, never below a usable floor. */
function share(total: number, workers: number, floor: number): number {
  return Math.max(floor, Math.floor(total / workers));
}

function childEnv(workers: number): NodeJS.ProcessEnv {
  const dbTotal = parseInt(process.env.DB_CONNECTION_LIMIT ?? '25', 10);
  const cores = effectiveCpus();
  const uvTotal = parseInt(process.env.UV_THREADPOOL_SIZE ?? String(Math.max(4, Math.min(cores * 2, 16))), 10);
  return {
    ...process.env,
    // The deployment still opens `dbTotal` connections in total, not per worker.
    DB_CONNECTION_LIMIT: String(share(dbTotal, workers, 2)),
    // Likewise the thread pool: bcrypt runs there, and thirty-two threads
    // competing for four cores is slower than eight, not faster.
    UV_THREADPOOL_SIZE: String(share(uvTotal, workers, 2)),
    FAMILISTA_CLUSTER_WORKER: '1',
  };
}

/**
 * If this process should be a cluster primary, become one and return true.
 * The caller then returns without starting a server — the primary supervises
 * and never serves requests itself.
 *
 * Returns false when the process should go on to serve normally: either it is
 * already a worker, or clustering was not asked for, or it was asked for and
 * refused because Redis could not be verified.
 */
export async function startClusterPrimary(): Promise<boolean> {
  if (!cluster.isPrimary) return false;

  const workers = desiredWorkers();
  if (workers <= 1) return false;

  if (!redisConfigured()) {
    logger.error(
      '[cluster] REFUSING to start multiple workers: REDIS_URL is not set. ' +
      'Rate limits, device replay protection, background workers and websocket ' +
      'fan-out would all be process-local and wrong. Serving as a single process.',
      { requested: workers },
    );
    return false;
  }

  const ok = await verifyRedis();
  if (!ok) {
    logger.error(
      '[cluster] REFUSING to start multiple workers: REDIS_URL is set but Redis did not answer. ' +
      'Starting workers now would produce a deployment that believes it shares state and does not. ' +
      'Serving as a single process.',
      { requested: workers },
    );
    return false;
  }

  const env = childEnv(workers);
  logger.info('[cluster] Redis verified — forking workers', {
    workers,
    cores: effectiveCpus(),
    hostCores: os.cpus().length,
    dbConnectionsPerWorker: env.DB_CONNECTION_LIMIT,
    uvThreadsPerWorker: env.UV_THREADPOOL_SIZE,
  });

  for (let i = 0; i < workers; i++) cluster.fork(env);

  let shuttingDown = false;

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;
    // A worker that dies takes its share of the traffic with it. Replace it —
    // but do not hot-loop if it is dying on startup.
    logger.error('[cluster] worker exited — replacing', { pid: worker.process.pid, code, signal });
    setTimeout(() => { if (!shuttingDown) cluster.fork(env); }, 1000).unref();
  });

  const stop = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[cluster] ${signal} — stopping workers`);
    for (const w of Object.values(cluster.workers ?? {})) w?.process.kill(signal as NodeJS.Signals);
    // Workers get the same grace the single-process shutdown gives itself.
    setTimeout(() => process.exit(0), 27_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT',  () => stop('SIGINT'));

  return true;
}

/** Which worker is this, for logs. `0` in a single-process deployment. */
export function workerIndex(): number {
  return cluster.worker?.id ?? 0;
}

export function clusterStatus() {
  return {
    enabled: !!process.env.FAMILISTA_CLUSTER_WORKER,
    requested: desiredWorkers(),
    // Both, because a gap between them is the thing that silently breaks
    // worker sizing on a container.
    usableCpus: effectiveCpus(),
    hostCpus: os.cpus().length,
    workerId: workerIndex(),
    pid: process.pid,
  };
}

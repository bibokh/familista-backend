// Familista — background workers, started in exactly one process
// ─────────────────────────────────────────────────────────────────────────────
// These are timers, not request handlers. Nothing about them is per-process
// work: the settlement sweep asks the database which auctions are due, the
// dispatcher asks which notifications are unsent, the transcoder asks which
// jobs are queued. Run them in four processes and all four get the same answer
// and all four act on it.
//
// Settlement is the one that matters most. `settleDueAuctions` claims each
// auction out of ACTIVE inside a transaction, so a race should not double-pay —
// but "should not" resting on a race nobody designed for is not a control, and
// the other workers have no such guard at all. Two dispatchers send the
// notification twice. Two transcoders both spawn FFmpeg on the same asset.
//
// So one process owns them, by lease (`infra/leader.ts`), and the rest run none.
// Ownership is not sticky to a particular process: whoever wins the lease runs
// them, and if that process dies the lease expires and another takes over
// within its TTL. There is no configured "primary" to get wrong at deploy time.
//
// Without Redis there is one process by construction, so it owns them directly
// and this file is a thin pass-through — the behaviour the service has today.

import { holdLease, isSoleProcess, type LeaseHandle } from './leader';
import { logger } from '../utils/logger';

import { startIntelBroadcaster, stopIntelBroadcaster } from '../live-intelligence/intel-broadcaster';
import { startAIAgentWorker, stopAIAgentWorker } from '../workers/ai-agent.worker';
import { startAutomationScheduler, stopAutomationScheduler } from '../workers/automation.worker';
import { startAuctionSettlementWorker, stopAuctionSettlementWorker } from '../workers/auction-settlement.worker';
import { startStatsAggregatorWorker, stopStatsAggregatorWorker } from '../workers/stats-aggregator.worker';
import { startVideoTranscodeWorker, stopVideoTranscodeWorker } from '../workers/video-transcode.worker';
import { stopRetentionWorker } from '../workers/retention.worker';
import { stopNotificationDispatchWorker } from '../workers/notification-dispatch.worker';
import { startHeartbeat, stopHeartbeat } from '../distributed/region.service';

/**
 * The set that must run once across the whole deployment.
 *
 * `startIntelBroadcaster` is here for a reason that is easy to miss: it
 * subscribes to every match event and publishes computed intel back onto the
 * channel. Once the channel is bridged over Redis pub/sub, every process sees
 * every match event — so an unleased broadcaster in four processes would compute
 * the same bundle four times and publish it four times.
 *
 * `startRetentionWorker` and `startNotificationDispatchWorker` are deliberately
 * absent: they are imported and stopped by `server.ts` but have never been
 * started by it. Starting them here would be a behaviour change smuggled in
 * under an infrastructure task, so they stay as they are and their `stop`
 * remains wired for the day they are turned on.
 */
const OWNED: Array<{ label: string; start: () => void; stop: () => void | Promise<void> }> = [
  { label: 'intel-broadcaster',   start: startIntelBroadcaster,        stop: stopIntelBroadcaster },
  { label: 'ai-agent',            start: startAIAgentWorker,           stop: stopAIAgentWorker },
  { label: 'automation',          start: startAutomationScheduler,     stop: stopAutomationScheduler },
  { label: 'auction-settlement',  start: startAuctionSettlementWorker, stop: stopAuctionSettlementWorker },
  { label: 'stats-aggregator',    start: startStatsAggregatorWorker,   stop: stopStatsAggregatorWorker },
  { label: 'video-transcode',     start: startVideoTranscodeWorker,    stop: stopVideoTranscodeWorker },
  // The region heartbeat is a timer too, and an easy one to overlook. On Render
  // every worker of an instance derives the SAME `NODE_ID` from
  // RENDER_SERVICE_NAME, so four unleased workers would append four identical
  // heartbeat rows per interval for one node — four times the writes, and a
  // health average computed from four copies of one sample.
  { label: 'region-heartbeat',    start: startHeartbeat,               stop: stopHeartbeat },
];

let running = false;

function startAll(): void {
  if (running) return;
  running = true;
  for (const w of OWNED) {
    // One failure must not stop the others coming up — the same guarantee
    // server.ts's `safeStart` gave.
    try { w.start(); } catch (err) {
      logger.error(`[workers] ${w.label} failed to start (swallowed)`, { err: (err as Error).message });
    }
  }
  logger.info('[workers] background workers started in this process', { count: OWNED.length });
}

async function stopAll(): Promise<void> {
  if (!running) return;
  running = false;
  for (const w of OWNED) {
    try { await w.stop(); } catch { /* shutting down; nothing to salvage */ }
  }
  try { stopRetentionWorker(); } catch { /* never started */ }
  try { stopNotificationDispatchWorker(); } catch { /* never started */ }
  logger.info('[workers] background workers stopped in this process');
}

/** Are the timers running here, right now? */
export function workersRunningHere(): boolean {
  return running;
}

let lease: LeaseHandle | null = null;

/**
 * Start the workers here if this process owns them.
 *
 * Returns immediately. With Redis the lease is acquired in the background and
 * the workers start the moment it is won — which, on a fresh deploy, is on the
 * first beat.
 */
export function startOwnedWorkers(): void {
  if (isSoleProcess()) {
    logger.info('[workers] no Redis configured — single process owns all background workers');
    startAll();
    return;
  }
  lease = holdLease('background-workers', {
    onAcquire: () => { startAll(); },
    onRelease: async () => { await stopAll(); },
  });
}

/** Shutdown: stop the timers, then hand the lease back so the next process
 *  picks it up immediately rather than waiting out the TTL. */
export async function stopOwnedWorkers(): Promise<void> {
  await stopAll();
  if (lease) { await lease.release(); lease = null; }
}

/** For the ops endpoint. */
export function workerOwnershipStatus() {
  return {
    mode: isSoleProcess() ? 'sole-process' : 'leased',
    runningHere: running,
    holdsLease: lease ? lease.held() : isSoleProcess(),
    workers: OWNED.map((w) => w.label),
  };
}

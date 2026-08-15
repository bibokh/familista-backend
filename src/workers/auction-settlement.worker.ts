// Familista — Auction settlement worker
// ─────────────────────────────────────────────────────────────────────────
// An auction ends because its deadline passed, not because somebody opened a
// page. This is the thing that makes that true: one bounded sweep, on the same
// self-rescheduling timer every other worker in this directory uses, started
// from server.ts beside them and stopped with them on shutdown.
//
// It contains no settlement logic of its own. It calls settleDueAuctions(),
// the one implementation, which claims each auction out of ACTIVE before it
// touches anything — so a second worker, a second instance, or a screen that
// happens to read the market at the same moment cannot settle the same auction
// twice, move a player twice, or pay anybody twice.
//
// The market's read paths still reconcile due auctions, and deliberately so:
// it is idempotent and it costs one indexed query. It is no longer what makes
// settlement happen.

import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { settleDueAuctions } from '../transfer-market/transfer-auction.service';

// Often enough that a manager watching a countdown sees the result seconds
// after it ends; rare enough that a quiet market costs one indexed query
// returning nothing. The database is the source of truth through validUntil —
// this only asks it, on a clock.
const TICK_MS = 15_000;
// The first sweep comes sooner than a full tick so a deploy that lands after
// an auction's deadline settles it on the way up rather than a tick later.
const FIRST_TICK_MS = 5_000;

let _running = false;
let _timer: ReturnType<typeof setTimeout> | null = null;

async function tick(): Promise<void> {
  if (!_running) return;
  try {
    const settled = await settleDueAuctions();
    if (settled.length) {
      logger.info('[auctions] settled', {
        count: settled.length,
        sold: settled.filter((s) => s.status === 'SOLD').length,
        unsold: settled.filter((s) => s.status === 'UNSOLD').length,
      });
    }
  } catch (err) {
    // A sweep that fails leaves every auction exactly as it was — the claim is
    // inside the settlement transaction — so the next tick simply tries again.
    logger.error('[auctions] tick error', { err: (err as Error)?.message });
  } finally {
    if (_running) _timer = setTimeout(tick, TICK_MS);
  }
}

export function startAuctionSettlementWorker(): void {
  if (_running) return;
  _running = true;
  logger.info('[auctions] starting settlement worker', { tickMs: TICK_MS });
  _timer = setTimeout(tick, FIRST_TICK_MS);
}

export async function stopAuctionSettlementWorker(): Promise<void> {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info('[auctions] settlement worker stopped');
}

// Exposed for the operator and for tests: what the worker would settle right
// now, without settling it. Deliberately the same query the sweep uses.
export async function dueAuctionCount(): Promise<number> {
  return prisma.marketplaceItem.count({
    where: {
      kind: 'TRANSFER_LISTING', status: 'ACTIVE', validUntil: { lte: new Date() },
      payload: { path: ['mode'], equals: 'AUCTION' },
    },
  });
}

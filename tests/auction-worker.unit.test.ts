/**
 * tests/auction-worker.unit.test.ts
 *
 * The sweep that makes an auction end because its deadline passed.
 *
 * Two things are being held here. The first is that the worker owns no
 * settlement logic — it calls settleDueAuctions and nothing else, so there is
 * still exactly one implementation and a second copy cannot drift from it. The
 * second is the query that chooses what is due: auctions only, active only,
 * past their deadline only. A fixed-price listing also lapses and also carries
 * a validUntil, and sweeping those was a real bug in this module before.
 */

const itemFindMany = jest.fn();
const itemCount = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    marketplaceItem: { findMany: (...a: unknown[]) => itemFindMany(...a), count: (...a: unknown[]) => itemCount(...a) },
  },
}));
jest.mock('../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const settleDueAuctions = jest.fn();
jest.mock('../src/transfer-market/transfer-auction.service', () => ({
  settleDueAuctions: (...a: unknown[]) => settleDueAuctions(...a),
}));

import {
  startAuctionSettlementWorker, stopAuctionSettlementWorker, dueAuctionCount,
} from '../src/workers/auction-settlement.worker';
import { logger } from '../src/utils/logger';

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  settleDueAuctions.mockResolvedValue([]);
  itemCount.mockResolvedValue(0);
});
afterEach(async () => {
  await stopAuctionSettlementWorker();
  jest.useRealTimers();
});

describe('the worker sweeps on its own clock', () => {
  it('does nothing until its first tick is due', () => {
    startAuctionSettlementWorker();
    expect(settleDueAuctions).not.toHaveBeenCalled();
    jest.advanceTimersByTime(4_000);
    expect(settleDueAuctions).not.toHaveBeenCalled();
  });

  it('sweeps shortly after boot, so a deploy past a deadline catches up', async () => {
    startAuctionSettlementWorker();
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(settleDueAuctions).toHaveBeenCalledTimes(1);
  });

  it('and keeps sweeping on a fixed interval', async () => {
    startAuctionSettlementWorker();
    jest.advanceTimersByTime(5_000);
    await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(15_000);
    await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(15_000);
    await Promise.resolve(); await Promise.resolve();
    expect(settleDueAuctions.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('starting twice does not double the sweep', async () => {
    startAuctionSettlementWorker();
    startAuctionSettlementWorker();
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(settleDueAuctions).toHaveBeenCalledTimes(1);
  });

  it('stops when the server stops', async () => {
    startAuctionSettlementWorker();
    await stopAuctionSettlementWorker();
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(settleDueAuctions).not.toHaveBeenCalled();
  });
});

describe('a sweep that fails is survivable', () => {
  it('logs and tries again on the next tick', async () => {
    settleDueAuctions.mockRejectedValueOnce(new Error('database went away'));
    startAuctionSettlementWorker();
    jest.advanceTimersByTime(5_000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith('[auctions] tick error', expect.objectContaining({ err: 'database went away' }));
    settleDueAuctions.mockResolvedValue([]);
    jest.advanceTimersByTime(15_000);
    await Promise.resolve(); await Promise.resolve();
    expect(settleDueAuctions.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the worker owns no settlement logic', () => {
  it('delegates to the one implementation', async () => {
    startAuctionSettlementWorker();
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    // it calls the service and touches nothing else
    expect(settleDueAuctions).toHaveBeenCalledTimes(1);
    expect(itemFindMany).not.toHaveBeenCalled();
  });
});

describe('what counts as due', () => {
  it('is auctions, active, past their deadline — and nothing else', async () => {
    await dueAuctionCount();
    const where = itemCount.mock.calls[0][0].where;
    expect(where.kind).toBe('TRANSFER_LISTING');
    expect(where.status).toBe('ACTIVE');
    expect(where.validUntil.lte).toBeInstanceOf(Date);
    // the clause that keeps ordinary fixed-price listings out of the sweep
    expect(where.payload).toEqual({ path: ['mode'], equals: 'AUCTION' });
  });

  it('a cancelled, sold or unsold auction is not ACTIVE, so it is never due', async () => {
    await dueAuctionCount();
    const where = itemCount.mock.calls[0][0].where;
    for (const gone of ['CANCELLED', 'SOLD', 'UNSOLD', 'CLOSED']) {
      expect(where.status).not.toBe(gone);
    }
    expect(where.status).toBe('ACTIVE');
  });
});

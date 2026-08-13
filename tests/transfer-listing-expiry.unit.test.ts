/**
 * tests/transfer-listing-expiry.unit.test.ts
 *
 * A transfer listing's window is a server rule, not a UI convention.
 *
 * `readMarket` hides an expired listing and the screen disables its button, but
 * neither is enforcement: a club holding the listing id could once still sign
 * the player after the window had closed, and both the player and the money
 * moved. `purchase()` now refuses it. This is the regression guard for that.
 *
 * Prisma is mocked — this is about the decision `purchase()` makes, not about
 * the database. The strongest proof that nothing settled is that the write path
 * is never entered at all: no transaction is opened, so no player row is
 * reassigned and no balance is touched.
 */

// ── Mock the Prisma client (no DB) ──────────────────────────────────────────
const findUnique = jest.fn();
const $transaction = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    marketplaceItem: { findUnique: (...a: unknown[]) => findUnique(...a) },
    $transaction:    (...a: unknown[]) => $transaction(...a),
    // Reached only by getBalance(), which purchase() calls after the expiry
    // check. Present so a regression that removes the check fails loudly here
    // rather than throwing for an unrelated reason.
    clubTransferBalance: {
      upsert: jest.fn().mockResolvedValue({ budgetEur: 50_000_000n, earnedEur: 0n, spentEur: 0n }),
    },
  },
}));

jest.mock('../src/security/audit-chain.service', () => ({
  appendAuditEventAsync: jest.fn(),
}));

import { purchase } from '../src/transfer-market/transfer-market.service';
import { ConflictError } from '../src/utils/errors';

const SELLER = 'club-seller';
const BUYER  = 'club-buyer';
const actor  = { userId: 'user-1', clubId: BUYER, role: 'CLUB_ADMIN' };

function listing(validUntil: Date | null) {
  return {
    id: 'listing-1',
    kind: 'TRANSFER_LISTING',
    clubId: SELLER,
    status: 'ACTIVE',
    validUntil,
    payload: { playerId: 'player-1', askingPriceEur: 1_000_000 },
  };
}

beforeEach(() => {
  findUnique.mockReset();
  $transaction.mockReset();
});

describe('purchase() — listing expiry', () => {
  it('refuses an ACTIVE listing whose validUntil has passed', async () => {
    findUnique.mockResolvedValue(listing(new Date(Date.now() - 1_000)));

    await expect(purchase(actor, 'listing-1')).rejects.toBeInstanceOf(ConflictError);
    await expect(purchase(actor, 'listing-1')).rejects.toThrow(/expired/i);
  });

  it('settles nothing when the listing has expired', async () => {
    findUnique.mockResolvedValue(listing(new Date(Date.now() - 1_000)));

    await expect(purchase(actor, 'listing-1')).rejects.toThrow();

    // No transaction was opened, so the player was never reassigned, neither
    // club's balance was touched, and the listing was not taken out of ACTIVE.
    expect($transaction).not.toHaveBeenCalled();
  });

  it('still reaches the write path for a listing whose window is open', async () => {
    findUnique.mockResolvedValue(listing(new Date(Date.now() + 60_000)));
    $transaction.mockRejectedValue(new Error('write path reached'));

    await expect(purchase(actor, 'listing-1')).rejects.toThrow('write path reached');
    expect($transaction).toHaveBeenCalled();
  });

  it('still reaches the write path for a listing with no window', async () => {
    findUnique.mockResolvedValue(listing(null));
    $transaction.mockRejectedValue(new Error('write path reached'));

    await expect(purchase(actor, 'listing-1')).rejects.toThrow('write path reached');
    expect($transaction).toHaveBeenCalled();
  });
});

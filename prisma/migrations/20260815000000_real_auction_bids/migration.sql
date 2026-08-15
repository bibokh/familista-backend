-- Real, server-held auctions: a bid becomes a row, and a listing says how it
-- ended. Purely additive — no column is dropped, no type is narrowed, and every
-- row written before this stays valid: the three new MarketplaceItem columns are
-- nullable, and CLOSED remains a legal status for the fixed-price listings that
-- already use it.
--
-- Written idempotently, the way 20260612 in this repository is, because a
-- database bootstrapped with `prisma db push` may already carry some of these
-- objects when the migration is first deployed.

-- ── how an auction ended ────────────────────────────────────────────────────
-- CLOSED could not distinguish a player who was sold from one nobody wanted
-- from a listing the seller pulled.
ALTER TYPE "MarketplaceItemStatus" ADD VALUE IF NOT EXISTS 'SOLD';
ALTER TYPE "MarketplaceItemStatus" ADD VALUE IF NOT EXISTS 'UNSOLD';
ALTER TYPE "MarketplaceItemStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- ── the outcome of a settled auction, written down rather than recomputed ───
ALTER TABLE "MarketplaceItem" ADD COLUMN IF NOT EXISTS "winnerClubId"  TEXT;
ALTER TABLE "MarketplaceItem" ADD COLUMN IF NOT EXISTS "finalPriceEur" BIGINT;
ALTER TABLE "MarketplaceItem" ADD COLUMN IF NOT EXISTS "settledAt"     TIMESTAMP(3);

-- due auctions are found by status + deadline
CREATE INDEX IF NOT EXISTS "MarketplaceItem_status_validUntil_idx"
  ON "MarketplaceItem"("status", "validUntil");

-- ── one club's bid on one auction, immutable ────────────────────────────────
CREATE TABLE IF NOT EXISTS "TransferBid" (
    "id"           TEXT NOT NULL,
    "listingId"    TEXT NOT NULL,
    "bidderClubId" TEXT NOT NULL,
    "amountEur"    BIGINT NOT NULL,
    "createdById"  TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransferBid_pkey" PRIMARY KEY ("id")
);

-- the highest bid, and the timeline, without a scan
CREATE INDEX IF NOT EXISTS "TransferBid_listingId_amountEur_idx"
  ON "TransferBid"("listingId", "amountEur");
CREATE INDEX IF NOT EXISTS "TransferBid_listingId_createdAt_idx"
  ON "TransferBid"("listingId", "createdAt");
-- "my bids"
CREATE INDEX IF NOT EXISTS "TransferBid_bidderClubId_createdAt_idx"
  ON "TransferBid"("bidderClubId", "createdAt");
-- the same club cannot lodge the same amount twice on the same auction
CREATE UNIQUE INDEX IF NOT EXISTS "TransferBid_listingId_bidderClubId_amountEur_key"
  ON "TransferBid"("listingId", "bidderClubId", "amountEur");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TransferBid_listingId_fkey'
  ) THEN
    ALTER TABLE "TransferBid"
      ADD CONSTRAINT "TransferBid_listingId_fkey"
      FOREIGN KEY ("listingId") REFERENCES "MarketplaceItem"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

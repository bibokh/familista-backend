-- Offer to Clubs: the terms a selling club publishes with a player, and what a
-- bid carries besides its fee.
--
-- Additive and nullable throughout. Every existing row keeps NULL in every new
-- column and behaves exactly as it did: no status changes, no defaults that
-- rewrite history, no constraint that an existing row could violate.

ALTER TABLE "PlayerOfferToClub" ADD COLUMN IF NOT EXISTS "minAcceptableEur" BIGINT;
ALTER TABLE "PlayerOfferToClub" ADD COLUMN IF NOT EXISTS "allowNegotiation" BOOLEAN;
ALTER TABLE "PlayerOfferToClub" ADD COLUMN IF NOT EXISTS "preferredDate" TIMESTAMP(3);
ALTER TABLE "PlayerOfferToClub" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

ALTER TABLE "TransferOffer" ADD COLUMN IF NOT EXISTS "addOnsEur" BIGINT;
ALTER TABLE "TransferOffer" ADD COLUMN IF NOT EXISTS "sellOnPct" INTEGER;
ALTER TABLE "TransferOffer" ADD COLUMN IF NOT EXISTS "preferredDate" TIMESTAMP(3);

-- The board reads active approaches to one club, newest first, and skips the
-- expired ones; this is the index that read walks.
CREATE INDEX IF NOT EXISTS "PlayerOfferToClub_toClubId_status_expiresAt_idx"
  ON "PlayerOfferToClub" ("toClubId", "status", "expiresAt");

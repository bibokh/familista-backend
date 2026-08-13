-- Club-to-club transfers: interest, offers, recruitment needs, and a club
-- offering its own player to another club.
--
-- Written IF NOT EXISTS throughout, like its two predecessors. This database
-- was bootstrapped with `prisma db push` and its ledger is reconciled at deploy
-- time, so an object may already exist before the migration that declares it
-- runs. Re-running this file is a no-op: it creates, it never drops, never
-- rewrites and never touches an existing row.

-- ── enums ───────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "TransferOfferStatus" AS ENUM ('PENDING','ACCEPTED','REJECTED','WITHDRAWN','EXPIRED','COUNTERED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TransferInterestStatus" AS ENUM ('OPEN','INVITED','DECLINED','NOT_FOR_SALE','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RecruitmentPriority" AS ENUM ('LOW','MEDIUM','HIGH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The inbox that already exists gains the transfer kinds. Additive: every
-- existing row keeps its value, and nothing reads these until code does.
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'TRANSFER_INTEREST';
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'TRANSFER_OFFER_RECEIVED';
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'TRANSFER_OFFER_ACCEPTED';
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'TRANSFER_OFFER_REJECTED';
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'TRANSFER_COUNTER_OFFER';
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'TRANSFER_OFFER_WITHDRAWN';
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'PLAYER_OFFERED_TO_CLUB';
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'AUCTION_STARTED';
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'AUCTION_BID_RECEIVED';
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'AUCTION_ENDING';
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'AUCTION_WON';
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'AUCTION_LOST';
ALTER TYPE "UserNotificationKind" ADD VALUE IF NOT EXISTS 'TRANSFER_COMPLETED';

-- ── a formal offer from one club to another ────────────────────────────────
CREATE TABLE IF NOT EXISTS "TransferOffer" (
    "id"              TEXT NOT NULL,
    "playerId"        TEXT NOT NULL,
    "sellerClubId"    TEXT NOT NULL,
    "buyerClubId"     TEXT NOT NULL,
    "feeEur"          BIGINT NOT NULL,
    "status"          "TransferOfferStatus" NOT NULL DEFAULT 'PENDING',
    "message"         TEXT,
    "parentOfferId"   TEXT,
    "createdByClubId" TEXT NOT NULL,
    "createdById"     TEXT,
    "respondedAt"     TIMESTAMP(3),
    "expiresAt"       TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TransferOffer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TransferOffer_sellerClubId_status_idx" ON "TransferOffer"("sellerClubId","status");
CREATE INDEX IF NOT EXISTS "TransferOffer_buyerClubId_status_idx"  ON "TransferOffer"("buyerClubId","status");
CREATE INDEX IF NOT EXISTS "TransferOffer_playerId_status_idx"     ON "TransferOffer"("playerId","status");
CREATE INDEX IF NOT EXISTS "TransferOffer_parentOfferId_idx"       ON "TransferOffer"("parentOfferId");

-- ── a club registering interest, before any money is named ─────────────────
CREATE TABLE IF NOT EXISTS "TransferInterest" (
    "id"               TEXT NOT NULL,
    "playerId"         TEXT NOT NULL,
    "ownerClubId"      TEXT NOT NULL,
    "interestedClubId" TEXT NOT NULL,
    "message"          TEXT,
    "status"           "TransferInterestStatus" NOT NULL DEFAULT 'OPEN',
    "respondedAt"      TIMESTAMP(3),
    "createdById"      TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TransferInterest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TransferInterest_ownerClubId_status_idx"      ON "TransferInterest"("ownerClubId","status");
CREATE INDEX IF NOT EXISTS "TransferInterest_interestedClubId_status_idx" ON "TransferInterest"("interestedClubId","status");
CREATE INDEX IF NOT EXISTS "TransferInterest_playerId_idx"                ON "TransferInterest"("playerId");

-- ── what a club is currently looking for ───────────────────────────────────
CREATE TABLE IF NOT EXISTS "ClubRecruitmentNeed" (
    "id"                 TEXT NOT NULL,
    "clubId"             TEXT NOT NULL,
    "positions"          TEXT NOT NULL,
    "ageMin"             INTEGER,
    "ageMax"             INTEGER,
    "ratingMin"          INTEGER,
    "ratingMax"          INTEGER,
    "budgetMinEur"       BIGINT,
    "budgetMaxEur"       BIGINT,
    "nationality"        TEXT,
    "preferredFoot"      TEXT,
    "playstyle"          TEXT,
    "contractPreference" TEXT,
    "priority"           "RecruitmentPriority" NOT NULL DEFAULT 'MEDIUM',
    "note"               TEXT,
    "isActive"           BOOLEAN NOT NULL DEFAULT true,
    "expiresAt"          TIMESTAMP(3),
    "createdById"        TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClubRecruitmentNeed_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ClubRecruitmentNeed_clubId_isActive_idx"    ON "ClubRecruitmentNeed"("clubId","isActive");
CREATE INDEX IF NOT EXISTS "ClubRecruitmentNeed_isActive_expiresAt_idx" ON "ClubRecruitmentNeed"("isActive","expiresAt");

-- ── a club offering its own player to another club ─────────────────────────
CREATE TABLE IF NOT EXISTS "PlayerOfferToClub" (
    "id"             TEXT NOT NULL,
    "playerId"       TEXT NOT NULL,
    "fromClubId"     TEXT NOT NULL,
    "toClubId"       TEXT NOT NULL,
    "needId"         TEXT,
    "askingPriceEur" BIGINT,
    "matchPct"       INTEGER,
    "message"        TEXT,
    "status"         "TransferInterestStatus" NOT NULL DEFAULT 'OPEN',
    "respondedAt"    TIMESTAMP(3),
    "createdById"    TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlayerOfferToClub_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PlayerOfferToClub_toClubId_status_idx"   ON "PlayerOfferToClub"("toClubId","status");
CREATE INDEX IF NOT EXISTS "PlayerOfferToClub_fromClubId_status_idx" ON "PlayerOfferToClub"("fromClubId","status");
CREATE INDEX IF NOT EXISTS "PlayerOfferToClub_playerId_idx"          ON "PlayerOfferToClub"("playerId");

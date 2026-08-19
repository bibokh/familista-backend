-- Coach Market.
--
-- Additive only. No existing table is altered in a way that could lose a value,
-- no column is dropped, no row is touched. The new enum values are appended, so
-- every membership that exists keeps the role it was granted.

-- ── the rest of a technical staff ────────────────────────────────────────────
ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'GOALKEEPING_COACH';
ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'FITNESS_COACH';
ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'TECHNICAL_COACH';
ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'TACTICAL_COACH';
ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'YOUTH_COACH';
ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'PERFORMANCE_COACH';

-- ── what a staff record now also holds ───────────────────────────────────────
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "languages" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "reputation" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "coachingStyle" TEXT;

-- ── a club's private shortlist ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "StaffShortlist" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "addedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffShortlist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StaffShortlist_clubId_staffUserId_key" ON "StaffShortlist"("clubId", "staffUserId");
CREATE INDEX IF NOT EXISTS "StaffShortlist_clubId_idx" ON "StaffShortlist"("clubId");
CREATE INDEX IF NOT EXISTS "StaffShortlist_staffUserId_idx" ON "StaffShortlist"("staffUserId");

ALTER TABLE "StaffShortlist" DROP CONSTRAINT IF EXISTS "StaffShortlist_clubId_fkey";
ALTER TABLE "StaffShortlist" ADD CONSTRAINT "StaffShortlist_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StaffShortlist" DROP CONSTRAINT IF EXISTS "StaffShortlist_staffUserId_fkey";
ALTER TABLE "StaffShortlist" ADD CONSTRAINT "StaffShortlist_staffUserId_fkey"
    FOREIGN KEY ("staffUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StaffShortlist" DROP CONSTRAINT IF EXISTS "StaffShortlist_addedById_fkey";
ALTER TABLE "StaffShortlist" ADD CONSTRAINT "StaffShortlist_addedById_fkey"
    FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

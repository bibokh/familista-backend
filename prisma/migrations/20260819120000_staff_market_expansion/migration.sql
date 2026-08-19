-- The Coach Market becomes a staff database.
--
-- Additive only. Nothing is dropped, no existing column changes type, and no
-- row is rewritten — an approach already SUBMITTED stays SUBMITTED and is still
-- read as an open one.

-- ── what an offer says, and where it has got to ──────────────────────────────
ALTER TYPE "StaffApproachStatus" ADD VALUE IF NOT EXISTS 'SENT';
ALTER TYPE "StaffApproachStatus" ADD VALUE IF NOT EXISTS 'VIEWED';

ALTER TABLE "StaffApproach" ADD COLUMN IF NOT EXISTS "startDate" TIMESTAMP(3);
ALTER TABLE "StaffApproach" ADD COLUMN IF NOT EXISTS "bonuses" TEXT;
ALTER TABLE "StaffApproach" ADD COLUMN IF NOT EXISTS "releaseClause" BIGINT;
ALTER TABLE "StaffApproach" ADD COLUMN IF NOT EXISTS "viewedAt" TIMESTAMP(3);

-- ── what a contract holds ────────────────────────────────────────────────────
ALTER TABLE "StaffEngagement" ADD COLUMN IF NOT EXISTS "releaseClause" BIGINT;
ALTER TABLE "StaffEngagement" ADD COLUMN IF NOT EXISTS "renewalStatus" TEXT;

-- ── what he wants next ───────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "StaffCareerIntent" AS ENUM ('ACTIVELY_LOOKING', 'OPEN_TO_OFFERS', 'NOT_LOOKING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the rest of a professional record ────────────────────────────────────────
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "attackingApproach"  TEXT;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "defensiveApproach"  TEXT;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "transitionApproach" TEXT;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "developmentStyle"   TEXT;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "certifications" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "education"      TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "seniorYears"    INTEGER;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "academyYears"   INTEGER;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "youthAgeGroups" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "careerIntent" "StaffCareerIntent" NOT NULL DEFAULT 'NOT_LOOKING';
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "availableFrom" TIMESTAMP(3);
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "preferredRoles" "MembershipRole"[] DEFAULT ARRAY[]::"MembershipRole"[];
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "preferredCountries" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "preferredLeagues"   TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "preferredClubLevel" TEXT;

CREATE INDEX IF NOT EXISTS "StaffProfile_careerIntent_idx" ON "StaffProfile"("careerIntent");

-- ── what a club has written down about somebody ──────────────────────────────
CREATE TABLE IF NOT EXISTS "StaffClubNote" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffClubNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StaffClubNote_clubId_staffUserId_key" ON "StaffClubNote"("clubId", "staffUserId");
CREATE INDEX IF NOT EXISTS "StaffClubNote_clubId_idx" ON "StaffClubNote"("clubId");

ALTER TABLE "StaffClubNote" DROP CONSTRAINT IF EXISTS "StaffClubNote_clubId_fkey";
ALTER TABLE "StaffClubNote" ADD CONSTRAINT "StaffClubNote_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StaffClubNote" DROP CONSTRAINT IF EXISTS "StaffClubNote_staffUserId_fkey";
ALTER TABLE "StaffClubNote" ADD CONSTRAINT "StaffClubNote_staffUserId_fkey"
    FOREIGN KEY ("staffUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StaffClubNote" DROP CONSTRAINT IF EXISTS "StaffClubNote_updatedById_fkey";
ALTER TABLE "StaffClubNote" ADD CONSTRAINT "StaffClubNote_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

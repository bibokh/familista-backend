-- Three modules, and the records the two staff ones need.
--
-- Additive only. No column is dropped, no row rewritten, every statement is
-- idempotent so a re-run is a no-op.

-- ── a shortlist entry carries the club's own judgement ───────────────────────
DO $$ BEGIN
  CREATE TYPE "StaffShortlistPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StaffShortlistStage" AS ENUM ('WATCHING', 'CONTACTED', 'INTERVIEW', 'NEGOTIATION', 'OFFER_SENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "StaffShortlist" ADD COLUMN IF NOT EXISTS "priority" "StaffShortlistPriority" NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "StaffShortlist" ADD COLUMN IF NOT EXISTS "stage"    "StaffShortlistStage"    NOT NULL DEFAULT 'WATCHING';

-- ── a vacancy says more than a role and a ceiling ────────────────────────────
ALTER TABLE "StaffNeed" ADD COLUMN IF NOT EXISTS "minExperience"  INTEGER;
ALTER TABLE "StaffNeed" ADD COLUMN IF NOT EXISTS "contractType"   TEXT;
ALTER TABLE "StaffNeed" ADD COLUMN IF NOT EXISTS "startDate"      TIMESTAMP(3);
ALTER TABLE "StaffNeed" ADD COLUMN IF NOT EXISTS "languages"      TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "StaffNeed" ADD COLUMN IF NOT EXISTS "youthRequired"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StaffNeed" ADD COLUMN IF NOT EXISTS "seniorRequired" BOOLEAN NOT NULL DEFAULT false;

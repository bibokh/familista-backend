-- Club lifecycle and default locale
--
-- Additive only. Nothing is dropped, nothing is renamed, no existing row is
-- rewritten to mean something different.
--
-- `lifecycle` defaults to ACTIVE, which is the whole point of the default: every
-- club that existed before this migration was, in effect, active — it had been
-- created by somebody who became its owner in the same breath — and it must keep
-- behaving exactly as it did. Only the SYSTEM creation path introduced by this
-- change writes PENDING_SETUP, and it writes it explicitly.
--
-- Guarded throughout so the migration is safe to replay against a database that
-- was bootstrapped with `db push`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ClubLifecycle') THEN
    CREATE TYPE "ClubLifecycle" AS ENUM ('PENDING_SETUP', 'PRESIDENT_INVITED', 'ACTIVE');
  END IF;
END $$;

ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "defaultLocale" TEXT;
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "lifecycle" "ClubLifecycle" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3);

-- Finding the clubs that still need a president is the query SYSTEM runs most.
CREATE INDEX IF NOT EXISTS "Club_lifecycle_idx" ON "Club"("lifecycle");

-- One more audit category, for the events that explain how a club came to be
-- owned by the person who owns it. Adding an enum value never rewrites a row.
ALTER TYPE "PlatformAuditCategory" ADD VALUE IF NOT EXISTS 'CLUB_MANAGEMENT';

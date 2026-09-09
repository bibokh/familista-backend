-- Club operational lifecycle: DEACTIVATED and ARCHIVED.
--
-- Additive only. No column is dropped or renamed, no existing row is rewritten,
-- and NOTHING a club owns is touched: this migration adds places to record that
-- a club has been suspended or put away, and suspension is a state, never a
-- deletion.
--
-- Every existing club stays exactly as it is. The two new enum values are not
-- written to any row by this migration; only the platform owner's lifecycle
-- controls write them, one club at a time, deliberately.
--
-- Guarded throughout so it is safe to replay against a database bootstrapped
-- with `db push`.

-- Adding an enum value never rewrites a row. Postgres requires each ADD VALUE
-- to be its own statement.
ALTER TYPE "ClubLifecycle" ADD VALUE IF NOT EXISTS 'DEACTIVATED';
ALTER TYPE "ClubLifecycle" ADD VALUE IF NOT EXISTS 'ARCHIVED';

-- The state to come back to. Null for every club that has never been suspended
-- or archived, which is all of them today.
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "previousLifecycle" "ClubLifecycle";

-- When each transition happened. Distinct columns because SYSTEM reports them
-- as distinct facts.
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3);
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "archivedAt"    TIMESTAMP(3);
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "reactivatedAt" TIMESTAMP(3);
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "restoredAt"    TIMESTAMP(3);

-- Who changed it last, when, and why. A convenience over the authoritative
-- history in PlatformAuditLog; deliberately not a foreign key, so a club holds
-- no reference into the people who administer the platform.
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "lifecycleChangedAt"       TIMESTAMP(3);
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "lifecycleChangedByUserId" TEXT;
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "lifecycleReason"          TEXT;

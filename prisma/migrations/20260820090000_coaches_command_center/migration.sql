-- The Coaches command centre: what a move costs, and which records are samples.
--
-- Additive only. Nothing is dropped, no row rewritten, every statement
-- idempotent so a re-run is a no-op.

ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "releaseClause"   BIGINT;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "compensationFee" BIGINT;

-- Sample staff, created only into teams that had none. Real records are never
-- marked, so removing every sample is one predicate and touches nothing else.
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "StaffProfile_isDemo_idx" ON "StaffProfile"("isDemo");

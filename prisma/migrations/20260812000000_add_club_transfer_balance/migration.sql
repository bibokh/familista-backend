-- ClubTransferBalance — the only money the club-to-club transfer market needs.
--
-- Written IF NOT EXISTS on purpose. This database was bootstrapped with
-- `prisma db push` and its migration history is repaired at deploy time by
-- scripts/render-predeploy.sh, so a table may already exist before its
-- migration runs. Re-running this file is a no-op; it never drops, never
-- rewrites and never touches an existing row.

CREATE TABLE IF NOT EXISTS "ClubTransferBalance" (
    "id"        TEXT NOT NULL,
    "clubId"    TEXT NOT NULL,
    "budgetEur" BIGINT NOT NULL DEFAULT 50000000,
    "earnedEur" BIGINT NOT NULL DEFAULT 0,
    "spentEur"  BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClubTransferBalance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ClubTransferBalance_clubId_key" ON "ClubTransferBalance"("clubId");
CREATE INDEX IF NOT EXISTS "ClubTransferBalance_clubId_idx" ON "ClubTransferBalance"("clubId");

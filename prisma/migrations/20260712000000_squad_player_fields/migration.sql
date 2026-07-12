-- Squad migration (additive & safe): bring the client-side Squad into the backend.
-- Every column is nullable or has a default, so this migration cannot fail on existing
-- rows and requires no data backfill. It is forward-only; see the documented rollback
-- in docs/SQUAD_BACKEND_MIGRATION.md to reverse it.

ALTER TABLE "Player" ADD COLUMN "legacyId" TEXT;
ALTER TABLE "Player" ADD COLUMN "roles" TEXT;
ALTER TABLE "Player" ADD COLUMN "morale" TEXT;
ALTER TABLE "Player" ADD COLUMN "isCaptain" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Player" ADD COLUMN "isViceCaptain" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Player" ADD COLUMN "trainedPositions" TEXT;

-- Stable, idempotent mapping key from the old client Squad id (e.g. "sq-8") to this row.
CREATE UNIQUE INDEX "Player_legacyId_key" ON "Player"("legacyId");

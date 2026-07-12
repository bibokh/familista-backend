-- Training-persistence additions (Stage 2).
-- ADDITIVE ONLY: every column is nullable or has a default, so this migration
-- applies cleanly to existing rows and cannot fail on or alter production data.
-- (The AttendanceMark.INJURED enum value is added by the preceding migration
-- 20260712009000_add_injured_attendance_mark.) Reversible via the DROP
-- statements documented in docs/SQUAD_BACKEND_MIGRATION.md.

-- TrainingSession: persist the full planning → completion lifecycle in Postgres.
ALTER TABLE "TrainingSession" ADD COLUMN "startTime"     TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "sessionType"   TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "objective"     TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "tacticalFocus" TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "formation"     TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "status"        TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE "TrainingSession" ADD COLUMN "sessionRating" DOUBLE PRECISION;
ALTER TABLE "TrainingSession" ADD COLUMN "bestPlayerId"  TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "coachNote"     TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "completedAt"   TIMESTAMP(3);

CREATE INDEX "TrainingSession_status_idx" ON "TrainingSession"("status");

-- PlayerTrainingStat: persisted participation (full | partial).
ALTER TABLE "PlayerTrainingStat" ADD COLUMN "participation" TEXT;

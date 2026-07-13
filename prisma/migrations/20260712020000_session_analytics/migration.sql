-- Session-analytics fields (real coach-entered session context).
-- ADDITIVE ONLY: every column is nullable, so this migration applies cleanly to
-- existing rows and cannot fail on or alter production data. Reversible via
-- DROP COLUMN.
ALTER TABLE "TrainingSession" ADD COLUMN "intensity"   TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "pitch"       TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "weather"     TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "temperature" TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "equipment"   TEXT;
ALTER TABLE "TrainingSession" ADD COLUMN "coachName"   TEXT;

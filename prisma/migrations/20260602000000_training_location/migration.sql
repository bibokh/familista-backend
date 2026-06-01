-- Training Attendance MVP — add "location" to TrainingSession.
-- Additive, nullable, no default: existing rows stay valid, no data rewrite.
ALTER TABLE "TrainingSession"
  ADD COLUMN IF NOT EXISTS "location" TEXT;

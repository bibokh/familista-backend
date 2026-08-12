-- Player.form — the Squad UI's 1-10 form figure.
--
-- The sibling compatibility columns (legacyId, roles, morale, isCaptain,
-- trainedPositions) already exist; form was the one field the Squad shape
-- carried that had nowhere to live, so hydration silently replaced it with a
-- constant. Nullable and additive: existing rows are untouched and read NULL.
ALTER TABLE "Player" ADD COLUMN IF NOT EXISTS "form" INTEGER;

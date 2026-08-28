-- Club crest.
--
-- One club, one crest, held on the club itself so every team under it — the
-- first team and every academy age group — resolves the same image without a
-- copy of its own. Additive and nullable: a club without one keeps rendering
-- the neutral placeholder.
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "crestUrl" TEXT;

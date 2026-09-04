-- Training belongs to a team
-- ─────────────────────────────────────────────────────────────────────────────
-- A training week is a team's, not a club's. The First Team trains apart from
-- the Under-15s, and each session is private to the people assigned to that
-- team. Until now a TrainingSession carried only a clubId, so the server could
-- not tell one team's week from another's and therefore could not protect it.
--
-- This migration is additive and reversible in effect: it adds one nullable
-- column, one foreign key and two indexes, and then attributes the sessions it
-- can attribute WITHOUT GUESSING. Nothing is deleted, nothing is rewritten, and
-- no session is moved from one team to another.
--
-- ── What the backfill will and will not do
--
-- It assigns a session to a team only when the data already says so:
--
--   1. every player in the session's squad belongs to the same team, and none
--      of them is teamless — then the session is that team's;
--   2. otherwise, if the club has exactly one team, the session is that team's,
--      because there is nowhere else it could belong.
--
-- Everything else keeps a NULL team, on purpose. A session whose squad spans
-- two teams, or which has no squad recorded at all, cannot be attributed
-- honestly, and filing a First Team session under an academy side would be
-- worse than leaving it unattributed. Those rows are the club's own: the
-- application treats them as legacy club sessions — readable by the club's
-- staff, editable only by a club-wide administrator, and adoptable by naming a
-- team, which takes an assignment to manage that team.

-- ── the column ───────────────────────────────────────────────────────────────
ALTER TABLE "TrainingSession" ADD COLUMN IF NOT EXISTS "teamId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TrainingSession_teamId_fkey'
  ) THEN
    ALTER TABLE "TrainingSession"
      ADD CONSTRAINT "TrainingSession_teamId_fkey"
      FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "TrainingSession_clubId_teamId_idx" ON "TrainingSession"("clubId", "teamId");
CREATE INDEX IF NOT EXISTS "TrainingSession_teamId_idx" ON "TrainingSession"("teamId");

-- ── rule 1: a squad that is entirely one team's ──────────────────────────────
-- COUNT(p."teamId") ignores nulls, so `COUNT(*) = COUNT(p."teamId")` is the
-- assertion that no player in the session is teamless. Both conditions must
-- hold: one team, and every player on it.
UPDATE "TrainingSession" ts
SET "teamId" = agreed."teamId"
FROM (
  SELECT pts."sessionId" AS "sessionId", MIN(p."teamId") AS "teamId"
  FROM "PlayerTrainingStat" pts
  JOIN "Player" p ON p."id" = pts."playerId"
  GROUP BY pts."sessionId"
  HAVING COUNT(DISTINCT p."teamId") = 1
     AND COUNT(*) = COUNT(p."teamId")
) AS agreed
WHERE ts."id" = agreed."sessionId"
  AND ts."teamId" IS NULL
  -- Never across a club boundary, whatever the squad rows say.
  AND EXISTS (SELECT 1 FROM "Team" t WHERE t."id" = agreed."teamId" AND t."clubId" = ts."clubId");

-- ── rule 2: a club with exactly one team ─────────────────────────────────────
UPDATE "TrainingSession" ts
SET "teamId" = only_team."id"
FROM (
  SELECT MIN(t."id") AS "id", t."clubId"
  FROM "Team" t
  GROUP BY t."clubId"
  HAVING COUNT(*) = 1
) AS only_team
WHERE ts."teamId" IS NULL
  AND ts."clubId" = only_team."clubId";

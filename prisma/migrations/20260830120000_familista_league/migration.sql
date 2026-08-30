-- Familista League — a competition the platform owns rather than a club.
--
-- Nothing is created here. The competition engine already has every concept the
-- league needs (Competition, CompetitionTeam, Fixture, StandingsEntry) and it is
-- reused as it stands; all that was missing is a way to say "this competition
-- belongs to no single club", which is what a null owner means.

-- A club's own competition keeps its owner. The platform's has none.
ALTER TABLE "Competition" ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE "Fixture"     ALTER COLUMN "clubId" DROP NOT NULL;

-- Zones, points, season window and prizes, as data.
ALTER TABLE "Competition" ADD COLUMN IF NOT EXISTS "rules" JSONB;

-- The existing unique is ("clubId", "code", "season"). In Postgres two NULLs are
-- distinct, so that constraint stops guarding the platform's own competitions
-- the moment clubId may be null — two Familista Leagues could share a code and a
-- season. This partial unique covers exactly the rows the other one stopped
-- covering, and only those.
CREATE UNIQUE INDEX IF NOT EXISTS "Competition_platform_code_season_key"
  ON "Competition" ("code", "season")
  WHERE "clubId" IS NULL;

-- Standings and round listings are read by competition; fixtures are also read
-- by "which round is current", which orders by kickoff.
CREATE INDEX IF NOT EXISTS "Fixture_competitionId_scheduledAt_idx"
  ON "Fixture" ("competitionId", "scheduledAt");

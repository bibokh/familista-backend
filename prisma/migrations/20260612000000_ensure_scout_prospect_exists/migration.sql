-- Migration: ensure ScoutProspect table exists (idempotent safety net)
-- Purpose: 20260611000000_add_scout_prospect may have failed if the table
-- was pre-created by a prior `prisma db push`, causing the predeploy to exit
-- non-zero.  This migration uses CREATE TABLE IF NOT EXISTS and is therefore
-- always safe to run whether the table exists or not.
-- The predeploy fallback resolves 20260611000000 so this migration runs next.

CREATE TABLE IF NOT EXISTS "ScoutProspect" (
    "id"                  TEXT NOT NULL,
    "clubId"              TEXT NOT NULL,
    "playerName"          TEXT NOT NULL,
    "dateOfBirth"         TIMESTAMP(3),
    "age"                 INTEGER,
    "nationality"         TEXT,
    "currentClub"         TEXT,
    "league"              TEXT,
    "position"            TEXT NOT NULL,
    "secondaryPositions"  TEXT[] NOT NULL DEFAULT '{}',
    "preferredFoot"       TEXT,
    "heightCm"            INTEGER,
    "weightKg"            INTEGER,
    "marketValueEur"      DOUBLE PRECISION,
    "contractUntil"       TIMESTAMP(3),
    "agentName"           TEXT,
    "scoutName"           TEXT,
    "reportDate"          TIMESTAMP(3),
    "status"              TEXT NOT NULL DEFAULT 'IDENTIFIED',
    "pace"                INTEGER,
    "acceleration"        INTEGER,
    "agility"             INTEGER,
    "dribbling"           INTEGER,
    "ballControl"         INTEGER,
    "passing"             INTEGER,
    "vision"              INTEGER,
    "crossing"            INTEGER,
    "finishing"           INTEGER,
    "shooting"            INTEGER,
    "heading"             INTEGER,
    "tackling"            INTEGER,
    "positioning"         INTEGER,
    "composure"           INTEGER,
    "decisionMaking"      INTEGER,
    "strength"            INTEGER,
    "stamina"             INTEGER,
    "endurance"           INTEGER,
    "balance"             INTEGER,
    "mobility"            INTEGER,
    "explosiveness"       INTEGER,
    "leadership"          INTEGER,
    "discipline"          INTEGER,
    "concentration"       INTEGER,
    "workRate"            INTEGER,
    "determination"       INTEGER,
    "professionalism"     INTEGER,
    "coachability"        INTEGER,
    "currentRating"       DOUBLE PRECISION,
    "potentialRating"     DOUBLE PRECISION,
    "recommendationScore" DOUBLE PRECISION,
    "recommendation"      TEXT,
    "fitGK"               INTEGER,
    "fitCB"               INTEGER,
    "fitFB"               INTEGER,
    "fitDM"               INTEGER,
    "fitCM"               INTEGER,
    "fitAM"               INTEGER,
    "fitWinger"           INTEGER,
    "fitStriker"          INTEGER,
    "injuryRisk"          TEXT,
    "adaptationRisk"      TEXT,
    "disciplineRisk"      TEXT,
    "financialRisk"       TEXT,
    "strengths"           TEXT,
    "weaknesses"          TEXT,
    "tacticalFit"         TEXT,
    "developmentAreas"    TEXT,
    "comments"            TEXT,
    "finalRecommendation" TEXT,
    "isOnWatchlist"       BOOLEAN NOT NULL DEFAULT false,
    "watchlistCategory"   TEXT,
    "watchlistPriority"   INTEGER NOT NULL DEFAULT 50,
    "followUpDate"        TIMESTAMP(3),
    "createdBy"           TEXT,
    "updatedBy"           TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScoutProspect_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ScoutProspect_clubId_fkey'
    ) THEN
        ALTER TABLE "ScoutProspect"
            ADD CONSTRAINT "ScoutProspect_clubId_fkey"
            FOREIGN KEY ("clubId") REFERENCES "Club"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ScoutProspect_clubId_status_idx"
    ON "ScoutProspect"("clubId", "status");
CREATE INDEX IF NOT EXISTS "ScoutProspect_clubId_position_idx"
    ON "ScoutProspect"("clubId", "position");
CREATE INDEX IF NOT EXISTS "ScoutProspect_clubId_isOnWatchlist_idx"
    ON "ScoutProspect"("clubId", "isOnWatchlist");
CREATE INDEX IF NOT EXISTS "ScoutProspect_clubId_recommendation_idx"
    ON "ScoutProspect"("clubId", "recommendation");
CREATE INDEX IF NOT EXISTS "ScoutProspect_clubId_createdAt_idx"
    ON "ScoutProspect"("clubId", "createdAt");

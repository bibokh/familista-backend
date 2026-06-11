-- Migration: add ScoutProspect table (Phase 7 — Scouting & Recruitment Center)
-- Root cause: ScoutProspect model was added to schema.prisma after the last
-- migration (20260603000000_player_uuid_id_migration). No migration was created,
-- so the table never existed in production, causing 500s on all scouting endpoints.
-- Safe: additive only, no existing data touched.

CREATE TABLE "ScoutProspect" (
    "id"                  TEXT NOT NULL,
    "clubId"              TEXT NOT NULL,

    -- Basic profile
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

    -- Market intelligence
    "marketValueEur"      DOUBLE PRECISION,
    "contractUntil"       TIMESTAMP(3),
    "agentName"           TEXT,

    -- Scout metadata
    "scoutName"           TEXT,
    "reportDate"          TIMESTAMP(3),

    -- Recruitment pipeline status
    "status"              TEXT NOT NULL DEFAULT 'IDENTIFIED',

    -- Technical evaluation (1–100)
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

    -- Physical evaluation (1–100)
    "strength"            INTEGER,
    "stamina"             INTEGER,
    "endurance"           INTEGER,
    "balance"             INTEGER,
    "mobility"            INTEGER,
    "explosiveness"       INTEGER,

    -- Mental evaluation (1–100)
    "leadership"          INTEGER,
    "discipline"          INTEGER,
    "concentration"       INTEGER,
    "workRate"            INTEGER,
    "determination"       INTEGER,
    "professionalism"     INTEGER,
    "coachability"        INTEGER,

    -- Calculated scores (auto-computed by service layer on save)
    "currentRating"       DOUBLE PRECISION,
    "potentialRating"     DOUBLE PRECISION,
    "recommendationScore" DOUBLE PRECISION,
    "recommendation"      TEXT,

    -- Position fit (0–100, computed)
    "fitGK"               INTEGER,
    "fitCB"               INTEGER,
    "fitFB"               INTEGER,
    "fitDM"               INTEGER,
    "fitCM"               INTEGER,
    "fitAM"               INTEGER,
    "fitWinger"           INTEGER,
    "fitStriker"          INTEGER,

    -- Risk assessment
    "injuryRisk"          TEXT,
    "adaptationRisk"      TEXT,
    "disciplineRisk"      TEXT,
    "financialRisk"       TEXT,

    -- Scout report text fields
    "strengths"           TEXT,
    "weaknesses"          TEXT,
    "tacticalFit"         TEXT,
    "developmentAreas"    TEXT,
    "comments"            TEXT,
    "finalRecommendation" TEXT,

    -- Watchlist
    "isOnWatchlist"       BOOLEAN NOT NULL DEFAULT false,
    "watchlistCategory"   TEXT,
    "watchlistPriority"   INTEGER NOT NULL DEFAULT 50,
    "followUpDate"        TIMESTAMP(3),

    -- Audit
    "createdBy"           TEXT,
    "updatedBy"           TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScoutProspect_pkey" PRIMARY KEY ("id")
);

-- Foreign key: ScoutProspect.clubId → Club.id (cascade delete)
ALTER TABLE "ScoutProspect"
    ADD CONSTRAINT "ScoutProspect_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes matching @@index directives in schema.prisma
CREATE INDEX "ScoutProspect_clubId_status_idx"         ON "ScoutProspect"("clubId", "status");
CREATE INDEX "ScoutProspect_clubId_position_idx"        ON "ScoutProspect"("clubId", "position");
CREATE INDEX "ScoutProspect_clubId_isOnWatchlist_idx"   ON "ScoutProspect"("clubId", "isOnWatchlist");
CREATE INDEX "ScoutProspect_clubId_recommendation_idx"  ON "ScoutProspect"("clubId", "recommendation");
CREATE INDEX "ScoutProspect_clubId_createdAt_idx"       ON "ScoutProspect"("clubId", "createdAt");

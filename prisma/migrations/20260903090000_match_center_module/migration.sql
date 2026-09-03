-- Match Center — the club's global match calendar, and the workflow that moves
-- a fixture's kickoff.
--
-- Nothing here duplicates a fixture. The Match Center reads the Fixture rows the
-- competition engine already owns; what it adds is (a) somewhere to record the
-- venue's own time zone, so a kickoff can be judged by the clock at the ground
-- rather than the clock in the browser, and (b) the request workflow that lets a
-- club ASK for a different kickoff instead of taking one.

-- ── The venue's clock ────────────────────────────────────────────────────────
-- An IANA zone, e.g. "Europe/Berlin". Null means the club has not recorded one
-- and the scheduler falls back to the competition's zone, then to the country
-- already on the row, then to UTC.
ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "timezone" TEXT;

-- ── The reschedule workflow ─────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FixtureChangeStatus') THEN
    CREATE TYPE "FixtureChangeStatus" AS ENUM (
      'DRAFT',
      'REQUESTED',
      'AWAITING_OPPONENT',
      'OPPONENT_ACCEPTED',
      'OPPONENT_REJECTED',
      'AWAITING_COMPETITION_APPROVAL',
      'APPROVED',
      'REJECTED',
      'CANCELLED'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "FixtureChangeRequest" (
  "id"                     TEXT NOT NULL,
  "fixtureId"              TEXT NOT NULL,
  "requestedByClubId"      TEXT NOT NULL,
  "requestedByUserId"      TEXT,
  "opponentClubId"         TEXT,
  "currentKickoff"         TIMESTAMP(3) NOT NULL,
  "proposedKickoff"        TIMESTAMP(3) NOT NULL,
  "timeZone"               TEXT NOT NULL,
  "reason"                 TEXT NOT NULL,
  "note"                   TEXT,
  "status"                 "FixtureChangeStatus" NOT NULL DEFAULT 'DRAFT',
  "decidedByOpponentAt"    TIMESTAMP(3),
  "decidedByCompetitionAt" TIMESTAMP(3),
  "appliedAt"              TIMESTAMP(3),
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FixtureChangeRequest_pkey" PRIMARY KEY ("id")
);

-- Append-only. A decision is a new row, never an edit of the one before it.
CREATE TABLE IF NOT EXISTS "FixtureChangeEvent" (
  "id"          TEXT NOT NULL,
  "requestId"   TEXT NOT NULL,
  "status"      "FixtureChangeStatus" NOT NULL,
  "actorUserId" TEXT,
  "actorClubId" TEXT,
  "actorRole"   TEXT,
  "note"        TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FixtureChangeEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FixtureChangeRequest_fixtureId_idx"         ON "FixtureChangeRequest" ("fixtureId");
CREATE INDEX IF NOT EXISTS "FixtureChangeRequest_status_idx"            ON "FixtureChangeRequest" ("status");
CREATE INDEX IF NOT EXISTS "FixtureChangeRequest_requestedByClubId_idx" ON "FixtureChangeRequest" ("requestedByClubId");
CREATE INDEX IF NOT EXISTS "FixtureChangeRequest_opponentClubId_idx"    ON "FixtureChangeRequest" ("opponentClubId");
CREATE INDEX IF NOT EXISTS "FixtureChangeEvent_requestId_idx"           ON "FixtureChangeEvent" ("requestId");
CREATE INDEX IF NOT EXISTS "FixtureChangeEvent_createdAt_idx"           ON "FixtureChangeEvent" ("createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FixtureChangeRequest_fixtureId_fkey'
  ) THEN
    ALTER TABLE "FixtureChangeRequest"
      ADD CONSTRAINT "FixtureChangeRequest_fixtureId_fkey"
      FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FixtureChangeEvent_requestId_fkey'
  ) THEN
    ALTER TABLE "FixtureChangeEvent"
      ADD CONSTRAINT "FixtureChangeEvent_requestId_fkey"
      FOREIGN KEY ("requestId") REFERENCES "FixtureChangeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

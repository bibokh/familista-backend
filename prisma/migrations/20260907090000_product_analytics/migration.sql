-- Product analytics — raw events, sessions, and daily rollups
--
-- Additive only. Three new tables and one new enum; nothing existing is
-- dropped, renamed, or rewritten, and no production row is touched.
--
-- These tables are deliberately separate from every audit table. Audit answers
-- "who changed what" and is kept as long as the record it explains; analytics
-- answers "what is being used" and its raw tier expires. Different questions,
-- different retention, different privacy exposure — so, different tables.
--
-- Guarded throughout so the migration is safe to replay against a database that
-- was bootstrapped with `db push`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AnalyticsEnvironment') THEN
    CREATE TYPE "AnalyticsEnvironment" AS ENUM ('PRODUCTION', 'STAGING', 'LAB', 'PREVIEW');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "AnalyticsEvent" (
    "id"             TEXT NOT NULL,
    "eventName"      TEXT NOT NULL,
    "occurredAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "environment"    "AnalyticsEnvironment" NOT NULL,
    "sessionId"      TEXT NOT NULL,
    "userId"         TEXT,
    "platformRole"   TEXT,
    "clubId"         TEXT,
    "teamId"         TEXT,
    "module"         TEXT,
    "feature"        TEXT,
    "route"          TEXT,
    "durationMs"     INTEGER,
    "deviceCategory" TEXT,
    "locale"         TEXT,
    "timezone"       TEXT,
    "source"         TEXT NOT NULL DEFAULT 'web',
    "schemaVersion"  INTEGER NOT NULL DEFAULT 1,
    "day"            DATE NOT NULL,
    "hourOfDay"      INTEGER NOT NULL,
    "weekday"        INTEGER NOT NULL,
    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- Every index here exists to keep one dashboard query off a sequential scan.
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_environment_occurredAt_idx"      ON "AnalyticsEvent"("environment", "occurredAt");
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_environment_day_userId_idx"      ON "AnalyticsEvent"("environment", "day", "userId");
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_environment_module_occurredAt_idx" ON "AnalyticsEvent"("environment", "module", "occurredAt");
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_environment_clubId_occurredAt_idx" ON "AnalyticsEvent"("environment", "clubId", "occurredAt");
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_environment_eventName_occurredAt_idx" ON "AnalyticsEvent"("environment", "eventName", "occurredAt");
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_sessionId_occurredAt_idx"        ON "AnalyticsEvent"("sessionId", "occurredAt");
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_day_idx"                         ON "AnalyticsEvent"("day");

CREATE TABLE IF NOT EXISTS "AnalyticsSession" (
    "id"             TEXT NOT NULL,
    "environment"    "AnalyticsEnvironment" NOT NULL,
    "userId"         TEXT,
    "platformRole"   TEXT,
    "clubId"         TEXT,
    "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt"        TIMESTAMP(3),
    "durationMs"     INTEGER,
    "eventCount"     INTEGER NOT NULL DEFAULT 0,
    "moduleCount"    INTEGER NOT NULL DEFAULT 0,
    "deviceCategory" TEXT,
    "locale"         TEXT,
    "timezone"       TEXT,
    "day"            DATE NOT NULL,
    CONSTRAINT "AnalyticsSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AnalyticsSession_environment_startedAt_idx"       ON "AnalyticsSession"("environment", "startedAt");
CREATE INDEX IF NOT EXISTS "AnalyticsSession_environment_day_idx"             ON "AnalyticsSession"("environment", "day");
CREATE INDEX IF NOT EXISTS "AnalyticsSession_environment_userId_startedAt_idx" ON "AnalyticsSession"("environment", "userId", "startedAt");
CREATE INDEX IF NOT EXISTS "AnalyticsSession_lastActivityAt_idx"              ON "AnalyticsSession"("lastActivityAt");

CREATE TABLE IF NOT EXISTS "AnalyticsDailyMetric" (
    "id"          TEXT NOT NULL,
    "day"         DATE NOT NULL,
    "environment" "AnalyticsEnvironment" NOT NULL,
    "metric"      TEXT NOT NULL,
    "dimension"   TEXT NOT NULL DEFAULT '',
    "value"       BIGINT NOT NULL DEFAULT 0,
    "uniqueUsers" INTEGER NOT NULL DEFAULT 0,
    "computedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalyticsDailyMetric_pkey" PRIMARY KEY ("id")
);

-- The unique key is what makes the rollup idempotent: re-running a day upserts
-- rather than doubling it.
CREATE UNIQUE INDEX IF NOT EXISTS "AnalyticsDailyMetric_day_environment_metric_dimension_key"
    ON "AnalyticsDailyMetric"("day", "environment", "metric", "dimension");
CREATE INDEX IF NOT EXISTS "AnalyticsDailyMetric_environment_metric_day_idx" ON "AnalyticsDailyMetric"("environment", "metric", "day");
CREATE INDEX IF NOT EXISTS "AnalyticsDailyMetric_day_idx"                    ON "AnalyticsDailyMetric"("day");

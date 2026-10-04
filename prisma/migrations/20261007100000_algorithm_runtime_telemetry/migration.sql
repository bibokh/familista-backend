-- Algorithms Step 2 — production runtime telemetry
--
-- One row is one UTC hour of one registered algorithm's production executions,
-- from one workflow, under one version and one runtime code fingerprint:
-- counts, a latency histogram, an output histogram over the algorithm's fixed
-- bins, data-quality counts and three instants. Written only by
-- src/algorithms/telemetry-store.ts (an atomic INSERT … ON CONFLICT increment
-- from every server process), read only by the owner-only Algorithms room,
-- kept 42 days.
--
-- PRIVACY, IN THE DATABASE ITSELF
--
-- The table has no column for a club, a team, a player, a user, a request, an
-- input or an error message, and the CHECK constraints below refuse free text
-- in the columns it does have: a registry key, a workflow name from a closed
-- list, a 64-character hex fingerprint, an error class name. A name, an email
-- address or a sentence cannot be written here, whatever code asks — which is
-- proven on real PostgreSQL by tests/algorithm-telemetry.integration.test.ts.
--
-- Not a club-private table: no row belongs to a club, so row-level security
-- (R14) does not apply and none is enabled.

-- CreateTable
CREATE TABLE "AlgorithmTelemetryBucket" (
    "id" TEXT NOT NULL,
    "algorithmKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "bucketStart" TIMESTAMPTZ(3) NOT NULL,
    "executions" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "outputs" INTEGER NOT NULL DEFAULT 0,
    "outOfContract" INTEGER NOT NULL DEFAULT 0,
    "latencySumUs" BIGINT NOT NULL DEFAULT 0,
    "latencyMaxUs" INTEGER NOT NULL DEFAULT 0,
    "latencyBins" INTEGER[],
    "outputBins" INTEGER[],
    "qualityOk" INTEGER NOT NULL DEFAULT 0,
    "qualityPartial" INTEGER NOT NULL DEFAULT 0,
    "qualityEmpty" INTEGER NOT NULL DEFAULT 0,
    "freshnessFresh" INTEGER NOT NULL DEFAULT 0,
    "freshnessStale" INTEGER NOT NULL DEFAULT 0,
    "firstAt" TIMESTAMPTZ(3) NOT NULL,
    "lastAt" TIMESTAMPTZ(3) NOT NULL,
    "lastFailureAt" TIMESTAMPTZ(3),
    "lastFailureKind" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlgorithmTelemetryBucket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlgorithmTelemetryBucket_bucketStart_idx" ON "AlgorithmTelemetryBucket"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "AlgorithmTelemetryBucket_algorithmKey_version_fingerprint_s_key" ON "AlgorithmTelemetryBucket"("algorithmKey", "version", "fingerprint", "source", "bucketStart");

-- No free text: identifiers from closed vocabularies only.
ALTER TABLE "AlgorithmTelemetryBucket"
  ADD CONSTRAINT "AlgorithmTelemetryBucket_key_shape" CHECK ("algorithmKey" ~ '^[a-z0-9-]{1,64}$'),
  ADD CONSTRAINT "AlgorithmTelemetryBucket_version_shape" CHECK ("version" ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  ADD CONSTRAINT "AlgorithmTelemetryBucket_fingerprint_shape" CHECK ("fingerprint" ~ '^([0-9a-f]{64}|unavailable)$'),
  ADD CONSTRAINT "AlgorithmTelemetryBucket_source_shape" CHECK ("source" ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*$' AND length("source") <= 64),
  ADD CONSTRAINT "AlgorithmTelemetryBucket_failure_kind_shape" CHECK ("lastFailureKind" IS NULL OR "lastFailureKind" ~ '^[A-Za-z][A-Za-z0-9]{0,63}(:P[0-9]{4})?$'),
  -- A UTC hour, whatever the session's TimeZone is (a +05:30 session would
  -- otherwise truncate to a different boundary).
  ADD CONSTRAINT "AlgorithmTelemetryBucket_hour_aligned" CHECK (
    ("bucketStart" AT TIME ZONE 'UTC') = date_trunc('hour', "bucketStart" AT TIME ZONE 'UTC')
  ),
  ADD CONSTRAINT "AlgorithmTelemetryBucket_counts_sane" CHECK (
    "executions" >= 0 AND "failures" >= 0 AND "failures" <= "executions"
    AND "outputs" >= 0 AND "outOfContract" >= 0 AND "outOfContract" <= "outputs"
    AND "latencySumUs" >= 0 AND "latencyMaxUs" >= 0
    AND "qualityOk" >= 0 AND "qualityPartial" >= 0 AND "qualityEmpty" >= 0
    AND "freshnessFresh" >= 0 AND "freshnessStale" >= 0
  ),
  ADD CONSTRAINT "AlgorithmTelemetryBucket_bins_bounded" CHECK (
    "latencyBins" IS NOT NULL AND "outputBins" IS NOT NULL
    AND cardinality("latencyBins") <= 32 AND cardinality("outputBins") <= 32
  );

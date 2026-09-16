-- Familista Data Fabric — the historical event store
--
-- WHY A NEW TABLE RATHER THAN `EventOutbox`
--
-- The outbox is a transport, and three properties disqualify it as history:
--
--   1. RETENTION-GOVERNED. `workers/retention.worker.ts` carries an
--      `EventOutbox` sweeper that deletes published rows the moment a
--      `DataRetentionPolicy` row names that entity type. No such policy exists
--      today, so the rows survive — by the absence of a policy, not by any
--      guarantee. A governance admin adding one tomorrow would destroy the
--      platform's history without meaning to.
--
--   2. NOT QUERYABLE BY TIME OR TYPE. The envelope lives inside
--      `payload."__familista_event"` as JSON. There is no column for
--      `eventType`, `occurredAt`, `entityType`, `entityId` or `correlationId`,
--      and none of the table's five indexes could serve "every medical event in
--      May 2028 for this club" as anything but a full scan with JSON extraction
--      on every row.
--
--   3. MIXED PROVENANCE. It also holds legacy rows from `match-event.service`
--      and `big-data/event-source` whose payloads have no schema and no
--      classification — which is why the live board already renders such a row
--      as RESTRICTED. Building durable guarantees on a table with two kinds of
--      row in it inherits the weaker kind's properties.
--
-- SAFETY
--
-- Purely additive. One new table, created only if absent. No existing table,
-- column, index or constraint is touched, so the migration is a no-op for every
-- read and write path that exists today and rolls back by dropping one table.
--
-- TIMESTAMPTZ
--
-- Every other table in this schema uses `timestamp(3)`. This one does not. A
-- historical store is range-queried across years, deployments and time zones,
-- and a month boundary computed against a zone-less column is an off-by-one-hour
-- error waiting for the first query that crosses a DST change. New table, no
-- column retyped: the divergence costs nothing and is the correct type.

CREATE TABLE IF NOT EXISTS "FabricEventHistory" (
    "id"                    TEXT         NOT NULL,
    "eventId"               TEXT         NOT NULL,
    "eventType"             TEXT         NOT NULL,
    "source"                TEXT         NOT NULL,
    "schemaVersion"         INTEGER      NOT NULL DEFAULT 1,
    "occurredAt"            TIMESTAMPTZ(3) NOT NULL,
    "persistedAt"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entityType"            TEXT,
    "entityId"              TEXT,
    "clubId"                TEXT,
    "teamContext"           JSONB,
    "ageGroup"              TEXT,
    "correlationId"         TEXT,
    "requestId"             TEXT,
    "status"                TEXT         NOT NULL DEFAULT 'STORED',
    "metadata"              JSONB,
    "privacyClassification" TEXT         NOT NULL,
    "retentionClass"        TEXT         NOT NULL,
    "createdAt"             TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FabricEventHistory_pkey" PRIMARY KEY ("id")
);

-- Idempotency. One envelope id, one historical record, however many times a
-- retry runs. This constraint is the guarantee; the writer's duplicate handling
-- is only how it reports one.
CREATE UNIQUE INDEX IF NOT EXISTS "FabricEventHistory_eventId_key"
  ON "FabricEventHistory" ("eventId");

-- The six questions history is actually asked, and deliberately not more: every
-- index here is a write cost paid on the hot path of every event in the system.
--
--   occurredAt                        a day, a month, a year, a custom range
--   source + occurredAt               "what did Medical do last March"
--   eventType + occurredAt            "every club.deleted, ever"
--   clubId + occurredAt               one tenant's history
--   entityType + entityId + occurredAt  one match, one transfer, one club
--   correlationId                     everything one request caused
--
-- A partial index per high-volume source is the next step when one source's
-- volume justifies it; adding six more now would slow every write for queries
-- nobody has run yet.
CREATE INDEX IF NOT EXISTS "FabricEventHistory_occurredAt_idx"
  ON "FabricEventHistory" ("occurredAt");
CREATE INDEX IF NOT EXISTS "FabricEventHistory_source_occurredAt_idx"
  ON "FabricEventHistory" ("source", "occurredAt");
CREATE INDEX IF NOT EXISTS "FabricEventHistory_eventType_occurredAt_idx"
  ON "FabricEventHistory" ("eventType", "occurredAt");
CREATE INDEX IF NOT EXISTS "FabricEventHistory_clubId_occurredAt_idx"
  ON "FabricEventHistory" ("clubId", "occurredAt");
CREATE INDEX IF NOT EXISTS "FabricEventHistory_entityType_entityId_occurredAt_idx"
  ON "FabricEventHistory" ("entityType", "entityId", "occurredAt");
CREATE INDEX IF NOT EXISTS "FabricEventHistory_correlationId_idx"
  ON "FabricEventHistory" ("correlationId");

-- Data Pulse — an ingest clock for the telemetry tail
--
-- `occurredAt` comes from a browser. `public/analytics.js` batches for five
-- seconds before it posts, so a row is stored 0-5s after the instant it names,
-- and two devices disagree about the instant by whatever their clocks disagree
-- by. The live tail walked a `(occurredAt, id)` cursor forward, so any batch
-- that arrived after a row bearing a later client timestamp was skipped — and
-- skipped permanently, because a cursor does not go back. A second device's
-- navigation was invisible for exactly that reason while the watching tab's own
-- continuous pointer stream came through.
--
-- `recordedAt` is assigned by THIS database at INSERT and by nothing else, so it
-- is monotonic across every application instance in a way a Node-side `new
-- Date()` could never be.
--
-- Additive and reversible:
--   * a new nullable-by-default column with a STABLE default, which PostgreSQL
--     fills in place rather than by rewriting the table;
--   * existing rows are stamped with their own `occurredAt`, which is the best
--     available answer for history and keeps the two columns consistent;
--   * one new index. No column is dropped, renamed or retyped, and no existing
--     index is touched.

ALTER TABLE "AnalyticsEvent"
  ADD COLUMN IF NOT EXISTS "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- History keeps its own timestamp rather than the moment of this migration, so
-- a replay of yesterday does not show every row as having arrived today.
UPDATE "AnalyticsEvent"
   SET "recordedAt" = "occurredAt"
 WHERE "recordedAt" <> "occurredAt";

CREATE INDEX IF NOT EXISTS "AnalyticsEvent_recordedAt_id_idx"
  ON "AnalyticsEvent" ("recordedAt", "id");

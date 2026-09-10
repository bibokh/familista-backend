-- Familista Data Fabric — versioned KEK keyring
--
-- PURELY ADDITIVE. One new nullable column, one index. No existing column is
-- dropped, renamed or re-typed; no existing row is read, written or moved; no
-- secret is migrated, re-keyed or backfilled by this migration.
--
-- WHAT THE COLUMN IS FOR
--
-- The key that sealed an envelope is named INSIDE the envelope, so decryption
-- never consults this column and would work identically without it. It exists
-- for the two operational questions the envelope cannot answer in aggregate:
--
--   "which rows are not yet sealed under the active key?"   — the re-key scan
--   "does anything still reference the key I want to retire?" — the safety gate
--
-- Answering those by decrypting every row would mean holding every credential
-- in memory to count them, which is precisely the thing this table exists to
-- avoid.
--
-- NULL MEANS `v1`
--
-- Every row written before this migration keeps NULL, and NULL is read as the
-- legacy kid. Nothing is backfilled: a NULL row opens exactly as it does today
-- because its three-part envelope resolves to `v1` on its own. The re-key
-- described in the rotation runbook fills the column as a side effect of doing
-- real work, one row at a time, and is resumable at any point.
--
-- Guarded so it is safe to replay against a database bootstrapped with
-- `db push`.

ALTER TABLE "PlatformSecret" ADD COLUMN IF NOT EXISTS "kid" TEXT;

CREATE INDEX IF NOT EXISTS "PlatformSecret_kid_idx" ON "PlatformSecret"("kid");

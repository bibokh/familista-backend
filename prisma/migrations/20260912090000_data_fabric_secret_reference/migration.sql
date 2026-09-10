-- Familista Data Fabric — secrets by reference
--
-- PURELY ADDITIVE. One new table, two new nullable columns. No existing column
-- is dropped, renamed or re-typed; no existing row is read, written or moved.
--
-- In particular: `Device.hmacSecret` and `Camera.hmacSecret` are NOT touched.
-- Every device and camera in the field keeps authenticating from the column it
-- was provisioned against. This migration only creates somewhere better for the
-- NEXT credential to live, and somewhere on the row to record where that is.
--
-- The step that eventually clears the plaintext columns is deliberately not
-- here. It is a separate, explicitly approved operation that must not run until
-- the reference path has been observed working in production — see the rollout
-- plan in src/fabric/secrets/device-credentials.ts.
--
-- Guarded throughout so it is safe to replay against a database bootstrapped
-- with `db push`.

-- ── the secret store ────────────────────────────────────────────────────────
-- Ciphertext, sealed with AES-256-GCM under a key that lives in the
-- environment and is never written here. A dump of this table is a dump of
-- ciphertext; the thing that opens it is somewhere else entirely.
CREATE TABLE IF NOT EXISTS "PlatformSecret" (
  "id"        TEXT NOT NULL,
  "scope"     TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "version"   INTEGER NOT NULL DEFAULT 1,
  "sealed"    TEXT NOT NULL,
  "metadata"  JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT,
  "rotatedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "PlatformSecret_pkey" PRIMARY KEY ("id")
);

-- One row per (scope, name, version). Rotation mints a new version rather than
-- overwriting, so a fleet can move between generations without an outage.
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformSecret_scope_name_version_key"
  ON "PlatformSecret"("scope", "name", "version");
CREATE INDEX IF NOT EXISTS "PlatformSecret_scope_name_idx" ON "PlatformSecret"("scope", "name");
CREATE INDEX IF NOT EXISTS "PlatformSecret_revokedAt_idx"  ON "PlatformSecret"("revokedAt");

-- ── the reference on the owning rows ────────────────────────────────────────
-- Nullable, with no default and no backfill. Every existing device and camera
-- keeps NULL here, which is exactly what routes it down the legacy path.
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "secretRef" TEXT;
ALTER TABLE "Camera" ADD COLUMN IF NOT EXISTS "secretRef" TEXT;

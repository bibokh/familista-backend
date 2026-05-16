-- Familista — One-time platform-admin bootstrap.
-- Run this once in the Render Postgres shell BEFORE running scripts/bootstrap.sh.
-- Without a PlatformAdmin row, no JWT can authenticate against /api/v1/admin/* routes.
--
-- Usage (Render dashboard → Postgres → Shell):
--   1. Replace the placeholder below with the User.id of the operator who should
--      become PLATFORM_OWNER. You can find it with:
--        SELECT id, email, role FROM "User" WHERE role = 'SUPER_ADMIN' ORDER BY "createdAt" DESC LIMIT 5;
--   2. Paste this entire file into the shell.
--
-- Idempotent — re-running is safe. ON CONFLICT prevents duplicate inserts.

\set ON_ERROR_STOP on

BEGIN;

-- ── 1. Promote an existing User to PlatformAdmin ───────────────────────────
INSERT INTO "PlatformAdmin" (
  id,
  "userId",
  role,
  "mfaEnforced",
  "isActive",
  "createdAt",
  "updatedAt"
)
VALUES (
  gen_random_uuid(),
  -- REPLACE WITH THE ACTUAL User.id of your platform owner:
  '00000000-0000-0000-0000-000000000000',
  'PLATFORM_OWNER',
  false,            -- mfaEnforced — flip to true after MFA is wired
  true,             -- isActive
  now(),
  now()
)
ON CONFLICT ("userId") DO NOTHING;

-- ── 2. Verify the row exists ──────────────────────────────────────────────
SELECT
  pa.id              AS platform_admin_id,
  u.email            AS user_email,
  pa.role            AS platform_role,
  pa."isActive"      AS is_active,
  pa."mfaEnforced"   AS mfa_enforced,
  pa."createdAt"     AS created_at
FROM "PlatformAdmin" pa
JOIN "User" u ON u.id = pa."userId"
WHERE pa.role = 'PLATFORM_OWNER'
ORDER BY pa."createdAt" DESC
LIMIT 5;

COMMIT;

-- ── Next step ─────────────────────────────────────────────────────────────
-- The user above can now log in normally; their JWT will pass the
-- requirePlatformAdmin middleware. Use that JWT to run:
--   BASE_URL=https://your-service.onrender.com JWT=<jwt> ./scripts/bootstrap.sh

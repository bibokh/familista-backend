-- Platform kernel — invitations, membership lifecycle, session versioning
-- ─────────────────────────────────────────────────────────────────────────────
-- Additive only. Three new enums, one new table, two new columns with defaults,
-- four new enum values. No column is dropped, renamed or rewritten; no existing
-- row is updated; no production data is converted. Every existing query reads
-- exactly what it read before this ran.
--
-- Membership.status is added ALONGSIDE isActive rather than replacing it: every
-- existing read still uses isActive, and the new column defaults to ACTIVE so
-- every existing row is correct the moment it appears.
--
-- User.tokenVersion defaults to 0 and is compared against a claim that older
-- tokens do not carry — a token with no version is accepted, so the deploy that
-- adds this logs nobody out.

-- ── enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MembershipStatus') THEN
    CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REMOVED');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ClubInvitationStatus') THEN
    CREATE TYPE "ClubInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');
  END IF;
END $$;

-- New actions on the existing audit enum. ADD VALUE IF NOT EXISTS is idempotent
-- and never rewrites the existing values.
ALTER TYPE "MembershipAuditAction" ADD VALUE IF NOT EXISTS 'SUSPEND';
ALTER TYPE "MembershipAuditAction" ADD VALUE IF NOT EXISTS 'UNSUSPEND';
ALTER TYPE "MembershipAuditAction" ADD VALUE IF NOT EXISTS 'INVITED';
ALTER TYPE "MembershipAuditAction" ADD VALUE IF NOT EXISTS 'INVITE_ACCEPTED';
ALTER TYPE "MembershipAuditAction" ADD VALUE IF NOT EXISTS 'INVITE_REVOKED';
ALTER TYPE "MembershipAuditAction" ADD VALUE IF NOT EXISTS 'INVITE_RESENT';

-- ── columns ──────────────────────────────────────────────────────────────────
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "User"       ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- ── invitations ──────────────────────────────────────────────────────────────
-- No password, no credential, nothing the inviter could sign in with: an email,
-- a role, an optional team, and the SHA-256 of a token that was sent once.
CREATE TABLE IF NOT EXISTS "ClubInvitation" (
  "id"               TEXT NOT NULL,
  "clubId"           TEXT NOT NULL,
  "email"            TEXT NOT NULL,
  "role"             "MembershipRole" NOT NULL,
  "teamId"           TEXT,
  "tokenHash"        TEXT NOT NULL,
  "status"           "ClubInvitationStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt"        TIMESTAMP(3) NOT NULL,
  "acceptedAt"       TIMESTAMP(3),
  "acceptedByUserId" TEXT,
  "revokedAt"        TIMESTAMP(3),
  "revokedByUserId"  TEXT,
  "invitedByUserId"  TEXT NOT NULL,
  "message"          TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClubInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ClubInvitation_tokenHash_key"    ON "ClubInvitation"("tokenHash");
CREATE INDEX        IF NOT EXISTS "ClubInvitation_clubId_status_idx" ON "ClubInvitation"("clubId", "status");
CREATE INDEX        IF NOT EXISTS "ClubInvitation_email_idx"         ON "ClubInvitation"("email");
CREATE INDEX        IF NOT EXISTS "ClubInvitation_expiresAt_idx"     ON "ClubInvitation"("expiresAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ClubInvitation_clubId_fkey') THEN
    ALTER TABLE "ClubInvitation" ADD CONSTRAINT "ClubInvitation_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ClubInvitation_teamId_fkey') THEN
    ALTER TABLE "ClubInvitation" ADD CONSTRAINT "ClubInvitation_teamId_fkey"
      FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

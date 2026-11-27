-- Creator Studio, P2 — personal creator accounts and a second kind of tenant.
--
-- A creator is a person who designs on their own account, independent of any club. A creator is not a User: a User
-- always belongs to a club (User.clubId is required), and every club listing, role check and session on the platform
-- assumes it. A creator is its own identity (CreatorAccount), signs in on its own routes with its own token audience,
-- and owns its designs the way a club owns its own.
--
-- Every Design Studio and manufacturing table now has exactly one owner: a club ("clubId") or a creator ("creatorId"),
-- never both and never neither (the platform's own projects, DesignProject PLATFORM, keep neither, as before). The
-- database holds that line in three places:
--
--   shape        CHECK — exactly one owner on every row (DesignProject: by its ownerKind)
--   lineage      composite foreign keys — a child names its parent AND the parent's owner, once per kind of owner, so a
--                creator's asset cannot sit in a club's kit, nor one creator's item in another creator's collection
--                (MATCH SIMPLE: the club key is skipped on a creator's row and the creator key on a club's)
--   isolation    row-level security — familista_rls_owner_ok(club, creator): a club session reaches its club's rows, a
--                creator session (familista.rls_mode = 'creator') its own creator's rows, system everything, and
--                nothing else reaches anything. A creator session reaches no club-only table at all:
--                familista_rls_club_ok admits 'club' and 'system' alone.
--
-- Accounts are never hard-deleted (a deletion scrubs the account and keeps a tombstone, P3), so a creator's foreign
-- keys RESTRICT: no row ever names a creator that is not there.

-- ── Identity ──────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "CreatorStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');
CREATE TYPE "CreatorEmailPurpose" AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD');

CREATE TABLE "CreatorInvite" (
  "id"          TEXT NOT NULL,
  "codeHash"    TEXT NOT NULL,
  "email"       TEXT,
  "note"        TEXT,
  "maxUses"     INTEGER NOT NULL DEFAULT 1,
  "uses"        INTEGER NOT NULL DEFAULT 0,
  "expiresAt"   TIMESTAMPTZ(3) NOT NULL,
  "revokedAt"   TIMESTAMPTZ(3),
  "createdById" TEXT NOT NULL,
  "createdAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorInvite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorInvite_shape" CHECK ("maxUses" BETWEEN 1 AND 1000 AND "uses" BETWEEN 0 AND "maxUses"
    AND ("email" IS NULL OR "email" = lower("email")) AND char_length("codeHash") = 64)
);
CREATE UNIQUE INDEX "CreatorInvite_codeHash_key" ON "CreatorInvite"("codeHash");
CREATE INDEX "CreatorInvite_createdAt_idx" ON "CreatorInvite"("createdAt");

CREATE TABLE "CreatorAccount" (
  "id"                 TEXT NOT NULL,
  "email"              TEXT NOT NULL,
  "passwordHash"       TEXT,
  "displayName"        TEXT,
  "locale"             TEXT NOT NULL DEFAULT 'en-GB',
  "status"             "CreatorStatus" NOT NULL DEFAULT 'ACTIVE',
  "tokenVersion"       INTEGER NOT NULL DEFAULT 0,
  "emailVerifiedAt"    TIMESTAMPTZ(3),
  "ageConfirmedAt"     TIMESTAMPTZ(3) NOT NULL,
  "ageConfirmedMinimum" INTEGER NOT NULL,
  "inviteId"           TEXT,
  "lastLoginAt"        TIMESTAMPTZ(3),
  "createdAt"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"          TIMESTAMPTZ(3),
  CONSTRAINT "CreatorAccount_pkey" PRIMARY KEY ("id"),
  -- A live account has its sign-in and its name; a deleted one has neither, and keeps no address but its tombstone.
  CONSTRAINT "CreatorAccount_shape" CHECK (
    "email" = lower("email") AND "ageConfirmedMinimum" BETWEEN 13 AND 21
    AND (("status" <> 'DELETED' AND "passwordHash" IS NOT NULL AND "displayName" IS NOT NULL AND "deletedAt" IS NULL)
      OR ("status" = 'DELETED' AND "passwordHash" IS NULL AND "displayName" IS NULL AND "deletedAt" IS NOT NULL
          AND "emailVerifiedAt" IS NULL AND "email" LIKE 'deleted+%@invalid'))
  )
);
CREATE UNIQUE INDEX "CreatorAccount_email_key" ON "CreatorAccount"("email");
CREATE INDEX "CreatorAccount_status_createdAt_idx" ON "CreatorAccount"("status", "createdAt");
ALTER TABLE "CreatorAccount" ADD CONSTRAINT "CreatorAccount_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "CreatorInvite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CreatorSession" (
  "id"        TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "familyId"  TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorSession_shape" CHECK (char_length("tokenHash") = 64)
);
CREATE UNIQUE INDEX "CreatorSession_tokenHash_key" ON "CreatorSession"("tokenHash");
CREATE INDEX "CreatorSession_creatorId_idx" ON "CreatorSession"("creatorId");
CREATE INDEX "CreatorSession_familyId_idx" ON "CreatorSession"("familyId");
ALTER TABLE "CreatorSession" ADD CONSTRAINT "CreatorSession_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CreatorEmailToken" (
  "id"        TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "purpose"   "CreatorEmailPurpose" NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt"    TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorEmailToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorEmailToken_shape" CHECK (char_length("tokenHash") = 64)
);
CREATE UNIQUE INDEX "CreatorEmailToken_tokenHash_key" ON "CreatorEmailToken"("tokenHash");
CREATE INDEX "CreatorEmailToken_creatorId_purpose_idx" ON "CreatorEmailToken"("creatorId", "purpose");
ALTER TABLE "CreatorEmailToken" ADD CONSTRAINT "CreatorEmailToken_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A creator's action is recorded as theirs, never as a club user's.
ALTER TABLE "PlatformAuditLog" ADD COLUMN "creatorId" TEXT;
CREATE INDEX "PlatformAuditLog_creatorId_idx" ON "PlatformAuditLog"("creatorId");

-- ── The isolation predicate, for a row with two possible owners ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.familista_rls_owner_ok(row_club text, row_creator text) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT NOT public.familista_rls_enforced()
      OR current_setting('familista.rls_mode', true) = 'system'
      OR (current_setting('familista.rls_mode', true) = 'club'
          AND row_club IS NOT NULL
          AND row_club = NULLIF(current_setting('familista.club_id', true), ''))
      OR (current_setting('familista.rls_mode', true) = 'creator'
          AND row_creator IS NOT NULL
          AND row_creator = NULLIF(current_setting('familista.creator_id', true), ''))
$$;

-- ── An owner column on every Design Studio and manufacturing table ────────────────────────────────────────────────────
ALTER TABLE "DesignProject"              ADD COLUMN "creatorId" TEXT;
ALTER TABLE "DesignBrandKit"             ADD COLUMN "creatorId" TEXT, ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE "DesignBrandAsset"           ADD COLUMN "creatorId" TEXT, ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE "DesignRoster"               ADD COLUMN "creatorId" TEXT, ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE "DesignCollection"           ADD COLUMN "creatorId" TEXT, ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE "DesignCollectionItem"       ADD COLUMN "creatorId" TEXT, ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE "ManufacturingRequest"       ADD COLUMN "creatorId" TEXT, ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE "ManufacturingRequestPerson" ADD COLUMN "creatorId" TEXT, ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE "ManufacturingRequestEvent"  ADD COLUMN "creatorId" TEXT, ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE "ManufacturingQuote"         ADD COLUMN "creatorId" TEXT, ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE "DesignReviewComment"        ADD COLUMN "creatorId" TEXT, ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE "DesignApproval"             ADD COLUMN "creatorId" TEXT, ALTER COLUMN "clubId" DROP NOT NULL;

-- The creator, when there is one, is a creator that exists.
ALTER TABLE "DesignProject"              ADD CONSTRAINT "DesignProject_creatorId_fkey"              FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DesignBrandKit"             ADD CONSTRAINT "DesignBrandKit_creatorId_fkey"             FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DesignRoster"               ADD CONSTRAINT "DesignRoster_creatorId_fkey"               FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DesignCollection"           ADD CONSTRAINT "DesignCollection_creatorId_fkey"           FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManufacturingRequest"       ADD CONSTRAINT "ManufacturingRequest_creatorId_fkey"       FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one owner.
ALTER TABLE "DesignProject" DROP CONSTRAINT "DesignProject_owner_shape";
ALTER TABLE "DesignProject" ADD CONSTRAINT "DesignProject_owner_shape" CHECK (
  ("ownerKind" = 'PLATFORM' AND "clubId" IS NULL AND "ownerUserId" IS NULL AND "creatorId" IS NULL)
  OR ("ownerKind" = 'CLUB' AND "clubId" IS NOT NULL AND "ownerUserId" IS NULL AND "creatorId" IS NULL)
  OR ("ownerKind" = 'PERSONAL' AND "creatorId" IS NOT NULL AND "clubId" IS NULL AND "ownerUserId" IS NULL)
);
ALTER TABLE "DesignProject" DROP CONSTRAINT "DesignProject_context_active";
ALTER TABLE "DesignProject" ADD CONSTRAINT "DesignProject_context_active" CHECK ("ownerKind" IN ('PLATFORM', 'CLUB', 'PERSONAL'));
ALTER TABLE "DesignBrandKit"             ADD CONSTRAINT "DesignBrandKit_one_owner"             CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL));
ALTER TABLE "DesignBrandAsset"           ADD CONSTRAINT "DesignBrandAsset_one_owner"           CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL));
ALTER TABLE "DesignRoster"               ADD CONSTRAINT "DesignRoster_one_owner"               CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL));
ALTER TABLE "DesignCollection"           ADD CONSTRAINT "DesignCollection_one_owner"           CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL));
ALTER TABLE "DesignCollectionItem"       ADD CONSTRAINT "DesignCollectionItem_one_owner"       CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL));
ALTER TABLE "ManufacturingRequest"       ADD CONSTRAINT "ManufacturingRequest_one_owner"       CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL));
ALTER TABLE "ManufacturingRequestPerson" ADD CONSTRAINT "ManufacturingRequestPerson_one_owner" CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL));
ALTER TABLE "ManufacturingRequestEvent"  ADD CONSTRAINT "ManufacturingRequestEvent_one_owner"  CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL));
ALTER TABLE "ManufacturingQuote"         ADD CONSTRAINT "ManufacturingQuote_one_owner"         CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL));
ALTER TABLE "DesignReviewComment"        ADD CONSTRAINT "DesignReviewComment_one_owner"        CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL));
ALTER TABLE "DesignApproval"             ADD CONSTRAINT "DesignApproval_one_owner"             CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL));

-- Parents name their creator with their id, so a child can name both; and a creator keeps one brand kit, as a club does.
CREATE UNIQUE INDEX "DesignProject_id_creatorId_key"        ON "DesignProject"("id", "creatorId");
CREATE UNIQUE INDEX "DesignBrandKit_id_creatorId_key"       ON "DesignBrandKit"("id", "creatorId");
CREATE UNIQUE INDEX "DesignBrandKit_creatorId_key"          ON "DesignBrandKit"("creatorId");
CREATE UNIQUE INDEX "DesignRoster_id_creatorId_key"         ON "DesignRoster"("id", "creatorId");
CREATE UNIQUE INDEX "DesignCollection_id_creatorId_key"     ON "DesignCollection"("id", "creatorId");
CREATE UNIQUE INDEX "ManufacturingRequest_id_creatorId_key" ON "ManufacturingRequest"("id", "creatorId");
CREATE INDEX "DesignProject_creatorId_idx"              ON "DesignProject"("creatorId");
CREATE INDEX "DesignBrandAsset_creatorId_archivedAt_createdAt_idx" ON "DesignBrandAsset"("creatorId", "archivedAt", "createdAt");
CREATE INDEX "DesignRoster_creatorId_archivedAt_updatedAt_idx"     ON "DesignRoster"("creatorId", "archivedAt", "updatedAt");
CREATE INDEX "DesignCollection_creatorId_archivedAt_updatedAt_idx" ON "DesignCollection"("creatorId", "archivedAt", "updatedAt");
CREATE INDEX "DesignCollectionItem_creatorId_idx"       ON "DesignCollectionItem"("creatorId");
CREATE INDEX "ManufacturingRequest_creatorId_status_updatedAt_idx" ON "ManufacturingRequest"("creatorId", "status", "updatedAt");
CREATE INDEX "ManufacturingRequestPerson_creatorId_idx" ON "ManufacturingRequestPerson"("creatorId");
CREATE INDEX "ManufacturingRequestEvent_creatorId_idx"  ON "ManufacturingRequestEvent"("creatorId");
CREATE INDEX "ManufacturingQuote_creatorId_idx"         ON "ManufacturingQuote"("creatorId");
CREATE INDEX "DesignReviewComment_creatorId_idx"        ON "DesignReviewComment"("creatorId");
CREATE INDEX "DesignApproval_creatorId_idx"             ON "DesignApproval"("creatorId");

-- Lineage, the creator's twin of every club key a child already has.
ALTER TABLE "DesignBrandAsset" ADD CONSTRAINT "DesignBrandAsset_kitId_creatorId_fkey"
  FOREIGN KEY ("kitId", "creatorId") REFERENCES "DesignBrandKit"("id", "creatorId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DesignCollectionItem" ADD CONSTRAINT "DesignCollectionItem_collectionId_creatorId_fkey"
  FOREIGN KEY ("collectionId", "creatorId") REFERENCES "DesignCollection"("id", "creatorId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DesignCollectionItem" ADD CONSTRAINT "DesignCollectionItem_projectId_creatorId_fkey"
  FOREIGN KEY ("projectId", "creatorId") REFERENCES "DesignProject"("id", "creatorId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManufacturingRequestPerson" ADD CONSTRAINT "ManufacturingRequestPerson_requestId_creatorId_fkey"
  FOREIGN KEY ("requestId", "creatorId") REFERENCES "ManufacturingRequest"("id", "creatorId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManufacturingRequestEvent" ADD CONSTRAINT "ManufacturingRequestEvent_requestId_creatorId_fkey"
  FOREIGN KEY ("requestId", "creatorId") REFERENCES "ManufacturingRequest"("id", "creatorId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManufacturingQuote" ADD CONSTRAINT "ManufacturingQuote_requestId_creatorId_fkey"
  FOREIGN KEY ("requestId", "creatorId") REFERENCES "ManufacturingRequest"("id", "creatorId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DesignReviewComment" ADD CONSTRAINT "DesignReviewComment_projectId_creatorId_fkey"
  FOREIGN KEY ("projectId", "creatorId") REFERENCES "DesignProject"("id", "creatorId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DesignApproval" ADD CONSTRAINT "DesignApproval_projectId_creatorId_fkey"
  FOREIGN KEY ("projectId", "creatorId") REFERENCES "DesignProject"("id", "creatorId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Guards that name the owner: they now name either ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION familista_design_project_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" = OLD."id"
     AND NEW."ownerKind" = OLD."ownerKind"
     AND NEW."clubId" IS NOT DISTINCT FROM OLD."clubId"
     AND NEW."creatorId" IS NOT DISTINCT FROM OLD."creatorId"
     AND NEW."ownerUserId" IS NOT DISTINCT FROM OLD."ownerUserId"
     AND NEW."origin" = OLD."origin"
     AND NEW."createdById" = OLD."createdById"
     AND NEW."createdAt" = OLD."createdAt"
     AND NEW."headRevision" IN (OLD."headRevision", OLD."headRevision" + 1) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'familista: this update of "DesignProject" is refused — its owner, origin and creation are fixed, and its head revision only moves forward by one'
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE OR REPLACE FUNCTION public.familista_design_collection_roster_club() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."rosterId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "DesignRoster" r WHERE r."id" = NEW."rosterId"
      AND r."clubId" IS NOT DISTINCT FROM NEW."clubId" AND r."creatorId" IS NOT DISTINCT FROM NEW."creatorId"
  ) THEN
    RAISE EXCEPTION 'DesignCollection_roster_club: a collection names a roster of its own owner only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER "DesignCollection_roster_club" ON "DesignCollection";
CREATE TRIGGER "DesignCollection_roster_club" BEFORE INSERT OR UPDATE OF "rosterId", "clubId", "creatorId" ON "DesignCollection"
  FOR EACH ROW EXECUTE FUNCTION public.familista_design_collection_roster_club();

CREATE OR REPLACE FUNCTION public.familista_manufacturing_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."spec" IS DISTINCT FROM OLD."spec" OR NEW."clubId" IS DISTINCT FROM OLD."clubId" OR NEW."creatorId" IS DISTINCT FROM OLD."creatorId"
     OR NEW."setsTotal" IS DISTINCT FROM OLD."setsTotal"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ManufacturingRequest_frozen: a submitted specification is never changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.familista_manufacturing_person_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "ManufacturingRequest" r WHERE r."id" = OLD."requestId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'ManufacturingRequestPerson_erase_only: a name is erased, never removed with its row' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'ManufacturingRequestPerson_erase_only: a name is erased, never removed with its row' USING ERRCODE = '23514';
  END IF;
  IF OLD."state" = 'KEPT' AND NEW."state" = 'ERASED' AND NEW."name" IS NULL AND NEW."erasedAt" IS NOT NULL
     AND NEW."id" = OLD."id" AND NEW."clubId" IS NOT DISTINCT FROM OLD."clubId" AND NEW."creatorId" IS NOT DISTINCT FROM OLD."creatorId"
     AND NEW."requestId" = OLD."requestId" AND NEW."position" = OLD."position" AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ManufacturingRequestPerson_erase_only: a kept name can only be erased' USING ERRCODE = '23514';
END;
$$;

-- ── Row-level security, by either owner: each policy is altered in place, never dropped, so no table is ever without one ───────────────────────────────────────────────────────────────────────────────
ALTER POLICY "DesignProject_club_isolation" ON "DesignProject" RENAME TO "DesignProject_tenant_isolation";
ALTER POLICY "DesignProject_tenant_isolation" ON "DesignProject"
  USING (public.familista_rls_owner_ok("clubId", "creatorId"))
  WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));

ALTER POLICY "DesignRevision_club_isolation" ON "DesignRevision" RENAME TO "DesignRevision_tenant_isolation";
ALTER POLICY "DesignRevision_tenant_isolation" ON "DesignRevision"
  USING (EXISTS (SELECT 1 FROM "DesignProject" p WHERE p."id" = "DesignRevision"."projectId" AND public.familista_rls_owner_ok(p."clubId", p."creatorId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "DesignProject" p WHERE p."id" = "DesignRevision"."projectId" AND public.familista_rls_owner_ok(p."clubId", p."creatorId")));

ALTER POLICY "DesignBrandKit_club_isolation" ON "DesignBrandKit" RENAME TO "DesignBrandKit_tenant_isolation";
ALTER POLICY "DesignBrandKit_tenant_isolation" ON "DesignBrandKit"
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
ALTER POLICY "DesignBrandAsset_club_isolation" ON "DesignBrandAsset" RENAME TO "DesignBrandAsset_tenant_isolation";
ALTER POLICY "DesignBrandAsset_tenant_isolation" ON "DesignBrandAsset"
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
ALTER POLICY "DesignRoster_club_isolation" ON "DesignRoster" RENAME TO "DesignRoster_tenant_isolation";
ALTER POLICY "DesignRoster_tenant_isolation" ON "DesignRoster"
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
ALTER POLICY "DesignCollection_club_isolation" ON "DesignCollection" RENAME TO "DesignCollection_tenant_isolation";
ALTER POLICY "DesignCollection_tenant_isolation" ON "DesignCollection"
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
ALTER POLICY "DesignCollectionItem_club_isolation" ON "DesignCollectionItem" RENAME TO "DesignCollectionItem_tenant_isolation";
ALTER POLICY "DesignCollectionItem_tenant_isolation" ON "DesignCollectionItem"
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
ALTER POLICY "ManufacturingRequest_club_isolation" ON "ManufacturingRequest" RENAME TO "ManufacturingRequest_tenant_isolation";
ALTER POLICY "ManufacturingRequest_tenant_isolation" ON "ManufacturingRequest"
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
ALTER POLICY "ManufacturingRequestPerson_club_isolation" ON "ManufacturingRequestPerson" RENAME TO "ManufacturingRequestPerson_tenant_isolation";
ALTER POLICY "ManufacturingRequestPerson_tenant_isolation" ON "ManufacturingRequestPerson"
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
ALTER POLICY "ManufacturingRequestEvent_club_isolation" ON "ManufacturingRequestEvent" RENAME TO "ManufacturingRequestEvent_tenant_isolation";
ALTER POLICY "ManufacturingRequestEvent_tenant_isolation" ON "ManufacturingRequestEvent"
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
ALTER POLICY "ManufacturingQuote_club_isolation" ON "ManufacturingQuote" RENAME TO "ManufacturingQuote_tenant_isolation";
ALTER POLICY "ManufacturingQuote_tenant_isolation" ON "ManufacturingQuote"
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
ALTER POLICY "DesignReviewComment_club_isolation" ON "DesignReviewComment" RENAME TO "DesignReviewComment_tenant_isolation";
ALTER POLICY "DesignReviewComment_tenant_isolation" ON "DesignReviewComment"
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
ALTER POLICY "DesignApproval_club_isolation" ON "DesignApproval" RENAME TO "DesignApproval_tenant_isolation";
ALTER POLICY "DesignApproval_tenant_isolation" ON "DesignApproval"
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));

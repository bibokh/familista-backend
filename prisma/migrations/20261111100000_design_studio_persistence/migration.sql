-- Design Studio, DS-1b — product designs saved on the server
--
-- A project and the immutable revisions of its canonical document
-- (`familista.product-design` v1, public/product-design/pd-core.js). Written
-- only by src/platform/product-design/, behind the platform owner's guard.
--
-- OWNERSHIP. Every project says who owns it: PLATFORM, CLUB (DS-3) or PERSONAL
-- (DS-4 after DS-ID). "DesignProject_owner_shape" holds the shape of each.
-- "DesignProject_context_active" admits PLATFORM rows alone: Club Design Studio
-- and Creator Studio are not activated, and the database refuses their rows
-- whatever code asks. The phase that activates a context drops that CHECK in
-- the same migration that adds the context's foreign key and its row-level
-- security policy (R14). Until then no row belongs to a club, so row-level
-- security does not apply and none is enabled, as for AlgorithmTelemetryBucket.
--
-- IMMUTABILITY. "DesignRevision_immutable" refuses UPDATE, and DELETE unless the
-- project the revision belongs to is already gone — the cascade of a deleted
-- project, which is how a whole design can still be erased. TRUNCATE is
-- refused. "DesignProject_guard" refuses an update that changes who owns the
-- project, where it came from or when it was created, or that moves the head
-- revision anywhere but forward by one. Proven on real PostgreSQL by
-- tests/product-design-persistence.integration.test.ts.
--
-- RECOVERY. Both tables are ordinary tables in the one database the backup
-- dumps whole (src/security/backup/backup-runner.ts, pg_dump --format=custom);
-- the document is in the row, so a database restore restores every design.

-- CreateEnum
CREATE TYPE "DesignOwnerKind" AS ENUM ('PLATFORM', 'CLUB', 'PERSONAL');

-- CreateEnum
CREATE TYPE "DesignOrigin" AS ENUM ('EDITOR', 'FILE_IMPORT', 'BROWSER_DRAFT');

-- CreateEnum
CREATE TYPE "DesignRevisionKind" AS ENUM ('CREATE', 'SAVE', 'RESTORE');

-- CreateTable
CREATE TABLE "DesignProject" (
    "id" TEXT NOT NULL,
    "ownerKind" "DesignOwnerKind" NOT NULL DEFAULT 'PLATFORM',
    "clubId" TEXT,
    "ownerUserId" TEXT,
    "name" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "headRevision" INTEGER NOT NULL,
    "origin" "DesignOrigin" NOT NULL,
    "createdById" TEXT NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignRevision" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "DesignRevisionKind" NOT NULL,
    "restoredFrom" INTEGER,
    "document" JSONB NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "formatVersion" INTEGER NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DesignProject_ownerKind_archivedAt_updatedAt_idx" ON "DesignProject"("ownerKind", "archivedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "DesignProject_clubId_idx" ON "DesignProject"("clubId");

-- CreateIndex
CREATE INDEX "DesignProject_ownerUserId_idx" ON "DesignProject"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignRevision_projectId_number_key" ON "DesignRevision"("projectId", "number");

-- AddForeignKey
ALTER TABLE "DesignRevision" ADD CONSTRAINT "DesignRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DesignProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Ownership, in the database
ALTER TABLE "DesignProject" ADD CONSTRAINT "DesignProject_owner_shape" CHECK (
  ("ownerKind" = 'PLATFORM' AND "clubId" IS NULL AND "ownerUserId" IS NULL)
  OR ("ownerKind" = 'CLUB' AND "clubId" IS NOT NULL AND "ownerUserId" IS NULL)
  OR ("ownerKind" = 'PERSONAL' AND "ownerUserId" IS NOT NULL AND "clubId" IS NULL)
);
ALTER TABLE "DesignProject" ADD CONSTRAINT "DesignProject_context_active" CHECK ("ownerKind" = 'PLATFORM');
ALTER TABLE "DesignProject" ADD CONSTRAINT "DesignProject_shape" CHECK (
  char_length("name") BETWEEN 1 AND 120
  AND "templateKey" ~ '^[a-z0-9][a-z0-9.-]{0,79}$'
  AND "templateVersion" >= 1
  AND "headRevision" >= 1
);

-- What a revision may hold
ALTER TABLE "DesignRevision" ADD CONSTRAINT "DesignRevision_shape" CHECK (
  "number" >= 1
  AND "sha256" ~ '^[0-9a-f]{64}$'
  AND "bytes" BETWEEN 1 AND 524288
  AND "formatVersion" >= 1
  AND jsonb_typeof("document") = 'object'
);
ALTER TABLE "DesignRevision" ADD CONSTRAINT "DesignRevision_kind_shape" CHECK (
  ("kind" = 'CREATE' AND "number" = 1 AND "restoredFrom" IS NULL)
  OR ("kind" = 'SAVE' AND "number" > 1 AND "restoredFrom" IS NULL)
  OR ("kind" = 'RESTORE' AND "number" > 1 AND "restoredFrom" >= 1 AND "restoredFrom" < "number")
);

-- A saved revision is never changed
CREATE OR REPLACE FUNCTION familista_design_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "DesignProject" WHERE "id" = OLD."projectId") THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'familista: % on "DesignRevision" is refused — a saved revision is never changed; restore it as a new one', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER "DesignRevision_immutable"
  BEFORE UPDATE OR DELETE ON "DesignRevision"
  FOR EACH ROW EXECUTE FUNCTION familista_design_revision_guard();
CREATE TRIGGER "DesignRevision_no_truncate"
  BEFORE TRUNCATE ON "DesignRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION familista_design_revision_guard();

-- A project keeps its owner and its history, and its head only moves forward by one
CREATE OR REPLACE FUNCTION familista_design_project_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" = OLD."id"
     AND NEW."ownerKind" = OLD."ownerKind"
     AND NEW."clubId" IS NOT DISTINCT FROM OLD."clubId"
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
CREATE TRIGGER "DesignProject_guard"
  BEFORE UPDATE ON "DesignProject"
  FOR EACH ROW EXECUTE FUNCTION familista_design_project_guard();

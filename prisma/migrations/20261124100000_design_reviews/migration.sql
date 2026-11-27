-- Design Studio M7b — reviews and approvals of a club's designs
-- ─────────────────────────────────────────────────────────────────────────────
-- DesignReviewComment holds comments on one saved version of a club's design,
-- on the whole garment or on one surface; a comment can be resolved.
-- DesignApproval holds a club administrator's decisions on one saved version,
-- pinned to its revision number and its SHA-256, so approving a version says
-- nothing about the next one. Decisions are never changed or removed (a trigger
-- refuses UPDATE, DELETE unless the design is already gone, and TRUNCATE); the
-- newest for a revision is the current one. Both name their design and club
-- together (a composite key onto DesignProject(id, clubId)), so neither can be
-- filed under another club's design.
--
-- Both tables join row-level security with the pilot's own fail-closed policy
-- (familista_rls_club_ok("clubId"), both ways), enforced from this migration on
-- (Stage 4). Every path to them is an authenticated club request.
--
-- Forward-only and additive.

-- CreateEnum
CREATE TYPE "DesignReviewDecision" AS ENUM ('APPROVED', 'CHANGES_REQUESTED');

-- CreateTable
CREATE TABLE "DesignReviewComment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "surface" TEXT,
    "body" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignReviewComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignApproval" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "decision" "DesignReviewDecision" NOT NULL,
    "note" TEXT,
    "decidedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DesignReviewComment_projectId_revision_createdAt_idx" ON "DesignReviewComment"("projectId", "revision", "createdAt");

-- CreateIndex
CREATE INDEX "DesignReviewComment_clubId_idx" ON "DesignReviewComment"("clubId");

-- CreateIndex
CREATE INDEX "DesignApproval_projectId_revision_createdAt_idx" ON "DesignApproval"("projectId", "revision", "createdAt");

-- CreateIndex
CREATE INDEX "DesignApproval_clubId_idx" ON "DesignApproval"("clubId");

-- AddForeignKey
ALTER TABLE "DesignReviewComment" ADD CONSTRAINT "DesignReviewComment_projectId_clubId_fkey" FOREIGN KEY ("projectId", "clubId") REFERENCES "DesignProject"("id", "clubId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignApproval" ADD CONSTRAINT "DesignApproval_projectId_clubId_fkey" FOREIGN KEY ("projectId", "clubId") REFERENCES "DesignProject"("id", "clubId") ON DELETE CASCADE ON UPDATE CASCADE;

-- The shape of what is kept, in the database itself.
ALTER TABLE "DesignReviewComment" ADD CONSTRAINT "DesignReviewComment_shape" CHECK (
  "revision" >= 1 AND char_length("body") BETWEEN 1 AND 1000
  AND ("surface" IS NULL OR "surface" ~ '^[a-z][a-z0-9-]{0,39}$')
  AND (("resolvedAt" IS NULL) = ("resolvedById" IS NULL))
);
ALTER TABLE "DesignApproval" ADD CONSTRAINT "DesignApproval_shape" CHECK (
  "revision" >= 1 AND "sha256" ~ '^[0-9a-f]{64}$'
  AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000)
  AND ("decision" <> 'CHANGES_REQUESTED' OR "note" IS NOT NULL)
);

-- A decision is never changed or removed, except with its design.
CREATE FUNCTION public.familista_design_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "DesignProject" p WHERE p."id" = OLD."projectId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'DesignApproval_immutable: a decision on a design is never changed or removed' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "DesignApproval_immutable" BEFORE UPDATE OR DELETE ON "DesignApproval"
  FOR EACH ROW EXECUTE FUNCTION public.familista_design_approval_guard();
CREATE TRIGGER "DesignApproval_no_truncate" BEFORE TRUNCATE ON "DesignApproval"
  FOR EACH STATEMENT EXECUTE FUNCTION public.familista_design_approval_guard();

-- Row-level security: a club's reviews are its club's alone.
ALTER TABLE "DesignReviewComment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignReviewComment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DesignReviewComment_club_isolation" ON "DesignReviewComment" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));

ALTER TABLE "DesignApproval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignApproval" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DesignApproval_club_isolation" ON "DesignApproval" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));

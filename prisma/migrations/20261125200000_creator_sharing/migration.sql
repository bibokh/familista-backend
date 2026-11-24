-- Creator Studio, P4 — sharing a design with another creator, to see it or to comment on it.
--
-- A share names one design, its owner (a creator), the creator it is shared with, and what they may do: VIEW (the
-- design at its newest version and its review) or COMMENT (that, and writing review notes). The owner alone edits the
-- design, resolves notes and approves versions; nothing about a share lets anyone write a design or a decision.
--
-- The database holds it, beside the owner's own isolation (familista_rls_owner_ok), with permissive policies that admit
-- a creator session to exactly what a live share (not revoked) gives it:
--
--   DesignShare           the owner and the grantee see the share; only the owner writes it
--   DesignProject         a grantee reads the shared design
--   DesignRevision        a grantee reads its versions
--   DesignReviewComment   a grantee reads its notes; with COMMENT, writes a note as themself on it, never anyone else
--   DesignApproval        a grantee reads its decisions
--
-- A share is only between creators: a club's design is never shared this way (a CHECK on the project's kind is held by
-- the share's composite key onto the project and its creator), and a club session matches none of these policies.

CREATE TYPE "DesignShareRole" AS ENUM ('VIEW', 'COMMENT');

CREATE TABLE "DesignShare" (
  "id"         TEXT NOT NULL,
  "projectId"  TEXT NOT NULL,
  "creatorId"  TEXT NOT NULL,
  "granteeId"  TEXT NOT NULL,
  "role"       "DesignShareRole" NOT NULL,
  "createdAt"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"  TIMESTAMPTZ(3),
  CONSTRAINT "DesignShare_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DesignShare_not_self" CHECK ("granteeId" <> "creatorId")
);
-- One live share per design and grantee; a revoked one stays as the record.
CREATE UNIQUE INDEX "DesignShare_live_key" ON "DesignShare"("projectId", "granteeId") WHERE "revokedAt" IS NULL;
CREATE INDEX "DesignShare_granteeId_idx" ON "DesignShare"("granteeId");
CREATE INDEX "DesignShare_creatorId_idx" ON "DesignShare"("creatorId");
ALTER TABLE "DesignShare" ADD CONSTRAINT "DesignShare_projectId_creatorId_fkey"
  FOREIGN KEY ("projectId", "creatorId") REFERENCES "DesignProject"("id", "creatorId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DesignShare" ADD CONSTRAINT "DesignShare_granteeId_fkey"
  FOREIGN KEY ("granteeId") REFERENCES "CreatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only a share's revocation changes it; who, what and when never do.
CREATE FUNCTION public.familista_design_share_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" = OLD."id" AND NEW."projectId" = OLD."projectId" AND NEW."creatorId" = OLD."creatorId" AND NEW."granteeId" = OLD."granteeId"
     AND NEW."role" = OLD."role" AND NEW."createdAt" = OLD."createdAt" AND OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'DesignShare_revoke_only: a share is only ever revoked' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "DesignShare_revoke_only" BEFORE UPDATE ON "DesignShare" FOR EACH ROW EXECUTE FUNCTION public.familista_design_share_guard();

/** The signed-in creator, in a creator session; null in any other. */
CREATE OR REPLACE FUNCTION public.familista_rls_creator() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT CASE WHEN current_setting('familista.rls_mode', true) = 'creator' THEN NULLIF(current_setting('familista.creator_id', true), '') END
$$;

ALTER TABLE "DesignShare" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignShare" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DesignShare_tenant_isolation" ON "DesignShare" FOR ALL
  USING (public.familista_rls_owner_ok(NULL, "creatorId")) WITH CHECK (public.familista_rls_owner_ok(NULL, "creatorId"));
CREATE POLICY "DesignShare_grantee_read" ON "DesignShare" FOR SELECT
  USING ("revokedAt" IS NULL AND "granteeId" = public.familista_rls_creator());

-- What a live share admits, table by table (permissive: OR-ed with each table's own isolation).
CREATE POLICY "DesignProject_shared_read" ON "DesignProject" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "DesignShare" s WHERE s."projectId" = "DesignProject"."id" AND s."revokedAt" IS NULL AND s."granteeId" = public.familista_rls_creator()));
CREATE POLICY "DesignRevision_shared_read" ON "DesignRevision" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "DesignShare" s WHERE s."projectId" = "DesignRevision"."projectId" AND s."revokedAt" IS NULL AND s."granteeId" = public.familista_rls_creator()));
CREATE POLICY "DesignReviewComment_shared_read" ON "DesignReviewComment" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "DesignShare" s WHERE s."projectId" = "DesignReviewComment"."projectId" AND s."revokedAt" IS NULL AND s."granteeId" = public.familista_rls_creator()));
CREATE POLICY "DesignReviewComment_shared_write" ON "DesignReviewComment" FOR INSERT
  WITH CHECK ("authorId" = public.familista_rls_creator() AND EXISTS (SELECT 1 FROM "DesignShare" s WHERE s."projectId" = "DesignReviewComment"."projectId"
    AND s."creatorId" = "DesignReviewComment"."creatorId" AND s."revokedAt" IS NULL AND s."role" = 'COMMENT' AND s."granteeId" = public.familista_rls_creator()));
CREATE POLICY "DesignApproval_shared_read" ON "DesignApproval" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "DesignShare" s WHERE s."projectId" = "DesignApproval"."projectId" AND s."revokedAt" IS NULL AND s."granteeId" = public.familista_rls_creator()));

-- Design Studio M2 — club design projects, held by row-level security
-- ─────────────────────────────────────────────────────────────────────────────
-- DS-1b created DesignProject and DesignRevision for three owners (PLATFORM,
-- CLUB, PERSONAL) and admitted PLATFORM alone: "DesignProject_context_active".
-- This admits CLUB as well. PERSONAL stays closed until the Creator Studio.
--
-- Both tables join row-level security, with the pilot's own fail-closed
-- function, unchanged (20261004100000_rls_pilot):
--
--   DesignProject    its own "clubId": a CLUB project is its club's alone; a
--                    PLATFORM project has no club, so like a VideoAsset with no
--                    club it is reached only on the named system path (the
--                    platform owner's requests run there, auth.middleware.ts).
--   DesignRevision   its project's club, looked up by primary key, as
--                    PlayerInjury looks up its player's.
--
-- Enforcement is the switch Stage 4 already turned on (20261006100000_rls_enforce):
-- these policies apply as soon as this migration runs. Every path that reads or
-- writes these tables is an authenticated request (club context, or the
-- platform owner's system path); no worker or job touches them.
--
-- Forward-only and additive: no row changes, no column changes.

ALTER TABLE "DesignProject" DROP CONSTRAINT "DesignProject_context_active";
ALTER TABLE "DesignProject" ADD CONSTRAINT "DesignProject_context_active" CHECK ("ownerKind" IN ('PLATFORM', 'CLUB'));

ALTER TABLE "DesignProject" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignProject" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DesignProject_club_isolation" ON "DesignProject" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));

ALTER TABLE "DesignRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignRevision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DesignRevision_club_isolation" ON "DesignRevision" FOR ALL
  USING (public.familista_rls_club_ok((SELECT p."clubId" FROM "DesignProject" p WHERE p."id" = "DesignRevision"."projectId")))
  WITH CHECK (public.familista_rls_club_ok((SELECT p."clubId" FROM "DesignProject" p WHERE p."id" = "DesignRevision"."projectId")));

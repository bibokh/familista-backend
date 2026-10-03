-- Cyber Defense R14 — rollback of Stage 4 (enforcement off)
-- ─────────────────────────────────────────────────────────────────────────────
-- Not a migration by itself. To roll enforcement back, copy this file to
-- prisma/migrations/<timestamp>_rls_enforcement_off/migration.sql, open a PR,
-- and deploy it through CI like any other change: the new instance runs it
-- before it starts, and its fresh connections stop enforcing. Policies, the
-- application's context and every table stay as they are — this returns the
-- platform to Stage 3 (context on, not enforced), and nothing else.
-- tests/rls-pilot.integration.test.ts runs this exact file.

CREATE OR REPLACE FUNCTION public.familista_rls_enforced() RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT false $$;

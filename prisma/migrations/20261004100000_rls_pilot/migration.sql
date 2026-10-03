-- Cyber Defense R14 — row-level security pilot (defence in depth)
-- ─────────────────────────────────────────────────────────────────────────────
-- Club isolation lives in the application (tenant guards, service filters).
-- This puts a second, independent check in PostgreSQL itself on four tables,
-- so a query that forgets its club filter cannot read or change another
-- club's rows. docs/security/row-level-security.md explains the design.
--
--   PlayerInjury   medical   read and write: the player's club only
--   VideoAsset     video     read and write: the asset's club only
--   Player         players   write: own club only. Reads stay open — the
--                            transfer market reads other clubs' players.
--   Membership     staff     write: own club only. Reads stay open — a user's
--                            own clubs and the staff market cross clubs.
--
-- Who is asking is set per transaction by the application
-- (src/security/db-context.ts), as transaction-local settings:
--
--   familista.rls_mode   'club'   — a request inside one club
--                        'system' — an explicit, named system or owner path
--   familista.club_id    the club, in 'club' mode
--
-- Anything else — no mode, an unknown mode, 'club' without a club — sees and
-- changes nothing. Fail closed.
--
-- ENFORCEMENT SHIPS OFF. familista_rls_enforced() returns false, and while it
-- does every policy passes and behaviour is exactly as before this migration.
-- Turning it on is a separate, reviewed, forward-only migration that replaces
-- the function body with `SELECT true` — an owner decision, after the
-- application has run with DB_RLS_CONTEXT=observe and then =on.
--
-- FORCE ROW LEVEL SECURITY: the application connects as the tables' owner,
-- which RLS otherwise exempts. Referential actions (a club's cascade delete)
-- are not subject to it. pg_dump reads these tables with
-- --enable-row-security under the 'system' mode (backup-runner.ts).
--
-- Forward-only and additive: two functions, eleven policies, no data change.

-- Schema-qualified inside the bodies: pg_dump runs with an empty search_path,
-- and a policy that cannot resolve its function stops the backup.
CREATE OR REPLACE FUNCTION public.familista_rls_enforced() RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION public.familista_rls_club_ok(row_club text) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT NOT public.familista_rls_enforced()
      OR current_setting('familista.rls_mode', true) = 'system'
      OR (current_setting('familista.rls_mode', true) = 'club'
          AND row_club IS NOT NULL
          AND row_club = NULLIF(current_setting('familista.club_id', true), ''))
$$;

-- ── PlayerInjury: medical, isolated both ways ────────────────────────────────
ALTER TABLE "PlayerInjury" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlayerInjury" FORCE ROW LEVEL SECURITY;
CREATE POLICY "PlayerInjury_club_isolation" ON "PlayerInjury" FOR ALL
  USING (familista_rls_club_ok((SELECT p."clubId" FROM "Player" p WHERE p."id" = "PlayerInjury"."playerId")))
  WITH CHECK (familista_rls_club_ok((SELECT p."clubId" FROM "Player" p WHERE p."id" = "PlayerInjury"."playerId")));

-- ── VideoAsset: isolated both ways; an asset with no club is system-only ─────
ALTER TABLE "VideoAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VideoAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY "VideoAsset_club_isolation" ON "VideoAsset" FOR ALL
  USING (familista_rls_club_ok("clubId"))
  WITH CHECK (familista_rls_club_ok("clubId"));

-- ── Player: readable (transfer market), written by its own club only ─────────
ALTER TABLE "Player" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Player" FORCE ROW LEVEL SECURITY;
CREATE POLICY "Player_read" ON "Player" FOR SELECT USING (true);
CREATE POLICY "Player_insert_own_club" ON "Player" FOR INSERT WITH CHECK (familista_rls_club_ok("clubId"));
CREATE POLICY "Player_update_own_club" ON "Player" FOR UPDATE
  USING (familista_rls_club_ok("clubId")) WITH CHECK (familista_rls_club_ok("clubId"));
CREATE POLICY "Player_delete_own_club" ON "Player" FOR DELETE USING (familista_rls_club_ok("clubId"));

-- ── Membership: readable (own clubs, staff market), written by its club only ─
ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY "Membership_read" ON "Membership" FOR SELECT USING (true);
CREATE POLICY "Membership_insert_own_club" ON "Membership" FOR INSERT WITH CHECK (familista_rls_club_ok("clubId"));
CREATE POLICY "Membership_update_own_club" ON "Membership" FOR UPDATE
  USING (familista_rls_club_ok("clubId")) WITH CHECK (familista_rls_club_ok("clubId"));
CREATE POLICY "Membership_delete_own_club" ON "Membership" FOR DELETE USING (familista_rls_club_ok("clubId"));

-- Cyber Defense R14 — Stage 4/4: PostgreSQL enforces row-level security
-- ─────────────────────────────────────────────────────────────────────────────
-- Stages 1–3 installed fail-closed club policies on 18 tables
-- (20261004100000_rls_pilot, 20261005100000_rls_club_private_tables) and had
-- the application carry its club context to them (DB_RLS_CONTEXT=on). While
-- familista_rls_enforced() returned false every policy passed. From here it
-- returns true and PostgreSQL itself refuses what the policies refuse:
--
--   a club context        its own club's rows only, read and write
--   the 'system' context  every club — the named, reviewed paths only
--                         (posture-policy.json rlsSystemPaths) and backups
--   no or invalid context nothing on the strictly isolated tables; on Player
--                         and Membership reads stay open (the transfer and
--                         staff markets) and writes are refused
--
-- Scope: exactly the 18 tables below; no policy, table or column changes. The
-- guard refuses to switch enforcement on if any of them is not forced under
-- row-level security or has no policy — the migration fails, the deploy stops,
-- and the running instance keeps serving.
--
-- The function is IMMUTABLE, so PostgreSQL folds its answer into prepared
-- plans: enforcement takes effect on fresh connections. The deploy that
-- carries this migration starts a new instance (scripts/render-start.sh runs
-- migrations first), which is what makes it effective.
--
-- Rollback: scripts/rls/rls-enforcement-off.sql, shipped as a new forward-only
-- migration and deployed the same way (docs/security/row-level-security.md).

DO $$
DECLARE
  unsafe text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO unsafe
  FROM unnest(ARRAY[
    'Player',
    'Membership',
    'PlayerInjury',
    'VideoAsset',
    'BiochemicalSignal',
    'HydrationEstimate',
    'StressIndex',
    'NeuromuscularLoad',
    'TendonRiskEstimate',
    'PlayerGuardianLink',
    'PlayerContractRecord',
    'PlayerEvaluationRecord',
    'PlayerOnboardingStep',
    'TrainingAttendanceRecord',
    'MatchAttendanceRecord',
    'OperationsPayment',
    'ClubCalendarEntry',
    'StaffClubNote'
  ]) AS t
  WHERE NOT EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity AND c.relforcerowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t);
  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION 'R14 enforcement refused: not forced under row-level security, or without a policy: %', unsafe;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.familista_rls_enforced() RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT true $$;

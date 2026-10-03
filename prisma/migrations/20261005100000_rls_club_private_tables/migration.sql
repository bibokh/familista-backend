-- Cyber Defense R14 — row-level security, extended to club-private tables
-- ─────────────────────────────────────────────────────────────────────────────
-- The pilot (20261004100000_rls_pilot) put a database-side club check on four
-- tables. This adds the same check, unchanged, to fourteen more: tables whose
-- every row belongs to exactly one club (clubId NOT NULL) and which no
-- legitimate path reads across clubs. Each is read and written by its own club
-- only, both ways (FOR ALL, USING and WITH CHECK):
--
--   health / biometric (special category)   BiochemicalSignal, HydrationEstimate,
--                                           StressIndex, NeuromuscularLoad,
--                                           TendonRiskEstimate
--   minors' safeguarding                    PlayerGuardianLink
--   player lifecycle                        PlayerContractRecord,
--                                           PlayerEvaluationRecord,
--                                           PlayerOnboardingStep
--   attendance                              TrainingAttendanceRecord,
--                                           MatchAttendanceRecord
--   finance                                 OperationsPayment
--   club operations                         ClubCalendarEntry
--   staff market (the club's private notes) StaffClubNote
--
-- The policy is the pilot's own function, familista_rls_club_ok("clubId"):
-- 'club' mode with the row's club, or the named 'system' path. No mode, an
-- unknown mode, 'club' without a club, or another club: no rows and no
-- writes. Fail closed.
--
-- ENFORCEMENT IS STILL THE PILOT'S ONE SWITCH. This migration does not touch
-- familista_rls_enforced(); while it returns false every policy passes and
-- behaviour is exactly as before. Turning it on remains a separate, reviewed,
-- forward-only migration and an owner decision.
--
-- Forward-only and additive: no function, column or data change. Every table
-- here is created by an earlier migration with a NOT NULL "clubId".

ALTER TABLE "BiochemicalSignal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BiochemicalSignal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BiochemicalSignal_club_isolation" ON "BiochemicalSignal" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "HydrationEstimate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HydrationEstimate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "HydrationEstimate_club_isolation" ON "HydrationEstimate" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "StressIndex" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StressIndex" FORCE ROW LEVEL SECURITY;
CREATE POLICY "StressIndex_club_isolation" ON "StressIndex" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "NeuromuscularLoad" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NeuromuscularLoad" FORCE ROW LEVEL SECURITY;
CREATE POLICY "NeuromuscularLoad_club_isolation" ON "NeuromuscularLoad" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "TendonRiskEstimate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TendonRiskEstimate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "TendonRiskEstimate_club_isolation" ON "TendonRiskEstimate" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "PlayerGuardianLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlayerGuardianLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY "PlayerGuardianLink_club_isolation" ON "PlayerGuardianLink" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "PlayerContractRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlayerContractRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "PlayerContractRecord_club_isolation" ON "PlayerContractRecord" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "PlayerEvaluationRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlayerEvaluationRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "PlayerEvaluationRecord_club_isolation" ON "PlayerEvaluationRecord" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "PlayerOnboardingStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlayerOnboardingStep" FORCE ROW LEVEL SECURITY;
CREATE POLICY "PlayerOnboardingStep_club_isolation" ON "PlayerOnboardingStep" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "TrainingAttendanceRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrainingAttendanceRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "TrainingAttendanceRecord_club_isolation" ON "TrainingAttendanceRecord" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "MatchAttendanceRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MatchAttendanceRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "MatchAttendanceRecord_club_isolation" ON "MatchAttendanceRecord" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "OperationsPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperationsPayment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "OperationsPayment_club_isolation" ON "OperationsPayment" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "ClubCalendarEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClubCalendarEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ClubCalendarEntry_club_isolation" ON "ClubCalendarEntry" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
ALTER TABLE "StaffClubNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffClubNote" FORCE ROW LEVEL SECURITY;
CREATE POLICY "StaffClubNote_club_isolation" ON "StaffClubNote" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));

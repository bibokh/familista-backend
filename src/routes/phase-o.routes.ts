// Familista — Phase O routes. Mounted at /api/v1/phase-o.
//
// Production Reality Layer:
//  • Auth: sessions + MFA
//  • Operations: guardians, attendance, payments, invoice lines, calendar
//  • Player lifecycle: onboarding, evaluations, contracts
//  • Hardware deploy: inventory + diagnostics
//  • Notifications + report templates/runs
//  • Governance: retention, GDPR, consent
//  • Monitoring: health, alert rules, backups
//  • Snapshot rollup
//
// All endpoints sit behind authenticate → tenantGuard → authorize(role…).
// SUPER_ADMIN is always implicit at the framework level via Phase I, but we
// list it explicitly per-route for clarity.

import { Router } from 'express';
import * as ctrl from '../controllers/phase-o.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { tenantGuard } from '../middleware/tenant-guard.middleware';

const router = Router();
router.use(authenticate);
router.use(tenantGuard);

// ── Auth: sessions ─────────────────────────────────────────────────────
router.get   ('/auth/sessions',                                                                                  ctrl.listAuthSessions);
router.post  ('/auth/sessions/rotate',                                                                           ctrl.rotateAuthSession);
router.delete('/auth/sessions/:sessionId',                                                                       ctrl.revokeAuthSession);
router.delete('/auth/users/:userId/sessions', authorize('CLUB_ADMIN','SUPER_ADMIN'),                             ctrl.revokeAllAuthSessions);

// ── Auth: MFA ──────────────────────────────────────────────────────────
router.post('/auth/mfa/enroll',                                                                                  ctrl.mfaEnroll);
router.post('/auth/mfa/confirm',                                                                                 ctrl.mfaConfirm);
router.post('/auth/mfa/verify',                                                                                  ctrl.mfaVerify);
router.post('/auth/mfa/disable',                                                                                 ctrl.mfaDisable);

// ── Operations: guardians ──────────────────────────────────────────────
router.post  ('/ops/guardians',                          authorize('CLUB_ADMIN','MANAGER','SUPER_ADMIN'),         ctrl.linkGuardian);
router.get   ('/ops/guardians/:playerId',                                                                         ctrl.listGuardians);
router.delete('/ops/guardians/:id',                      authorize('CLUB_ADMIN','MANAGER','SUPER_ADMIN'),         ctrl.unlinkGuardian);

// ── Operations: attendance ─────────────────────────────────────────────
router.post('/ops/attendance/training',                  authorize('CLUB_ADMIN','HEAD_COACH','ASSISTANT_COACH','COACH','MANAGER','SUPER_ADMIN'), ctrl.markTrainingAttendance);
router.get ('/ops/attendance/training/:sessionId',                                                                                                ctrl.listTrainingAttendance);
router.post('/ops/attendance/match',                     authorize('CLUB_ADMIN','HEAD_COACH','ASSISTANT_COACH','COACH','MANAGER','ANALYST','SUPER_ADMIN'), ctrl.markMatchAttendance);
router.get ('/ops/attendance/match/:matchId',                                                                                                     ctrl.listMatchAttendance);

// ── Operations: payments ───────────────────────────────────────────────
router.post('/ops/payments',                             authorize('CLUB_ADMIN','MANAGER','SUPER_ADMIN'),         ctrl.createPayment);
router.patch('/ops/payments/:id/state',                  authorize('CLUB_ADMIN','MANAGER','SUPER_ADMIN'),         ctrl.setPaymentState);
router.get ('/ops/payments',                                                                                      ctrl.listPayments);

// ── Operations: invoice lines (composes with Phase J InvoiceDraft) ─────
router.post('/ops/invoices/:invoiceDraftId/lines',       authorize('CLUB_ADMIN','MANAGER','SUPER_ADMIN'),         ctrl.addInvoiceLine);
router.get ('/ops/invoices/:invoiceDraftId/lines',                                                                ctrl.listInvoiceLines);

// ── Operations: calendar ───────────────────────────────────────────────
router.post('/ops/calendar',                             authorize('CLUB_ADMIN','HEAD_COACH','ASSISTANT_COACH','COACH','MANAGER','SUPER_ADMIN'), ctrl.createCalendarEntry);
router.get ('/ops/calendar',                                                                                                                      ctrl.listCalendar);

// ── Player lifecycle ───────────────────────────────────────────────────
router.post('/lifecycle/onboarding/:playerId/seed',      authorize('CLUB_ADMIN','MANAGER','HEAD_COACH','SUPER_ADMIN'),  ctrl.seedOnboarding);
router.post('/lifecycle/onboarding/:playerId/complete',  authorize('CLUB_ADMIN','MANAGER','HEAD_COACH','MEDICAL_STAFF','SUPER_ADMIN'), ctrl.completeOnboardingStep);
router.get ('/lifecycle/onboarding/:playerId',                                                                                          ctrl.listOnboarding);

router.post('/lifecycle/evaluations',                    authorize('CLUB_ADMIN','HEAD_COACH','ASSISTANT_COACH','COACH','ANALYST','SCOUT','MEDICAL_STAFF','SUPER_ADMIN'), ctrl.recordEvaluation);
router.get ('/lifecycle/evaluations/:playerId',                                                                                                                          ctrl.listEvaluations);

router.post ('/lifecycle/contracts',                     authorize('CLUB_ADMIN','MANAGER','SUPER_ADMIN'),         ctrl.createContract);
router.patch('/lifecycle/contracts/:id/state',           authorize('CLUB_ADMIN','MANAGER','SUPER_ADMIN'),         ctrl.transitionContract);
router.get  ('/lifecycle/contracts',                                                                              ctrl.listContracts);

// ── Hardware deploy ────────────────────────────────────────────────────
router.post('/hw/inventory',                             authorize('CLUB_ADMIN','MANAGER','SUPER_ADMIN'),         ctrl.upsertInventory);
router.get ('/hw/inventory',                             authorize('CLUB_ADMIN','MANAGER','ANALYST','SUPER_ADMIN'), ctrl.listInventory);
router.post('/hw/diagnostics',                           authorize('CLUB_ADMIN','MANAGER','ANALYST','SUPER_ADMIN'), ctrl.recordDiagnostic);
router.get ('/hw/diagnostics/:deviceId',                 authorize('CLUB_ADMIN','MANAGER','ANALYST','SUPER_ADMIN'), ctrl.listDiagnostics);

// ── Notifications ──────────────────────────────────────────────────────
router.post('/notifications/channels',                                                                            ctrl.registerChannel);
router.get ('/notifications/channels',                                                                            ctrl.listChannels);
router.post('/notifications/report-templates',           authorize('CLUB_ADMIN','MANAGER','ANALYST','SUPER_ADMIN'), ctrl.publishReportTemplate);
router.post('/notifications/report-runs',                authorize('CLUB_ADMIN','MANAGER','ANALYST','HEAD_COACH','SUPER_ADMIN'), ctrl.recordReportRun);

// ── Governance ─────────────────────────────────────────────────────────
router.post ('/governance/retention',                    authorize('CLUB_ADMIN','SUPER_ADMIN'),                   ctrl.upsertRetention);
router.get  ('/governance/retention',                                                                             ctrl.listRetention);

router.post ('/governance/gdpr/requests',                                                                          ctrl.openGdprRequest);
router.patch('/governance/gdpr/requests/:id/state',      authorize('CLUB_ADMIN','SUPER_ADMIN'),                   ctrl.transitionGdpr);
router.get  ('/governance/gdpr/requests',                authorize('CLUB_ADMIN','MANAGER','SUPER_ADMIN'),         ctrl.listGdprRequests);

router.post ('/governance/consent',                                                                                ctrl.recordConsent);
router.get  ('/governance/consent',                      authorize('CLUB_ADMIN','MANAGER','MEDICAL_STAFF','SUPER_ADMIN'), ctrl.listConsent);

// ── Monitoring ─────────────────────────────────────────────────────────
router.post('/monitoring/health',                        authorize('CLUB_ADMIN','MANAGER','ANALYST','SUPER_ADMIN'), ctrl.recordHealth);
router.get ('/monitoring/health/snapshot',                        authorize('SUPER_ADMIN'),                          ctrl.healthSnapshot);

router.post ('/monitoring/alert-rules',                  authorize('CLUB_ADMIN','SUPER_ADMIN'),                   ctrl.upsertAlertRule);
router.patch('/monitoring/alert-rules/:id/state',        authorize('CLUB_ADMIN','SUPER_ADMIN'),                   ctrl.setAlertRuleState);
router.get  ('/monitoring/alert-rules',                                                                            ctrl.listAlertRules);

router.post('/monitoring/backups',                       authorize('CLUB_ADMIN','SUPER_ADMIN'),                   ctrl.recordBackup);
router.get ('/monitoring/backups',                       authorize('CLUB_ADMIN','MANAGER','SUPER_ADMIN'),         ctrl.listBackups);

// ── Snapshot ───────────────────────────────────────────────────────────
router.get('/snapshot',                                  authorize('CLUB_ADMIN','MANAGER','ANALYST','HEAD_COACH','SUPER_ADMIN'), ctrl.phaseOSnapshot);

export default router;

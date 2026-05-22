// Familista — Phase P routes. Mounted at /api/v1/phase-p.
//
// Real-launch surface: status rollup, attendance reports, payer balances,
// in-app inbox, and the FC Familista bootstrap seed (SUPER_ADMIN only).
//
// Middleware chain (inherited): rateLimit → authenticate → tenantGuard → authorize(...)

import { Router } from 'express';
import * as ctrl from '../controllers/phase-p.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { tenantGuard } from '../middleware/tenant-guard.middleware';

const router = Router();
router.use(authenticate);
router.use(tenantGuard);

// ── Production status ──────────────────────────────────────────────────
router.get('/status', authorize('CLUB_ADMIN','MANAGER','ANALYST','SUPER_ADMIN'), ctrl.status);

// ── Attendance reports ─────────────────────────────────────────────────
router.get('/reports/attendance/training',                                                                                              ctrl.trainingAttendance);
router.get('/reports/attendance/match',                                                                                                 ctrl.matchAttendance);
router.get('/reports/attendance/players/:playerId',                                                                                     ctrl.combinedAttendance);

// ── Balance + history + ops summary ────────────────────────────────────
router.get('/finance/balance',                                                                                                          ctrl.balanceFor);
router.get('/finance/history',                                                                                                          ctrl.history);
router.get('/finance/club-summary',                authorize('CLUB_ADMIN','MANAGER','SUPER_ADMIN'),                                       ctrl.opsSummary);

// ── In-app notification inbox ──────────────────────────────────────────
router.post('/notifications',                      authorize('CLUB_ADMIN','MANAGER','HEAD_COACH','ASSISTANT_COACH','COACH','ANALYST','MEDICAL_STAFF','SUPER_ADMIN'), ctrl.sendNotification);
router.post('/notifications/batch',                authorize('CLUB_ADMIN','MANAGER','HEAD_COACH','SUPER_ADMIN'),                          ctrl.sendNotificationBatch);
router.get ('/notifications/inbox',                                                                                                       ctrl.inboxList);
router.get ('/notifications/inbox/counts',                                                                                                ctrl.inboxCounts);
router.patch('/notifications/inbox/:id/read',                                                                                             ctrl.inboxMarkRead);
router.patch('/notifications/inbox/read-all',                                                                                             ctrl.inboxMarkAllRead);
router.delete('/notifications/inbox/:id',                                                                                                 ctrl.inboxArchive);

// ── Seed (SUPER_ADMIN only; env-guarded) ───────────────────────────────
router.post('/seed/fc-familista',                  authorize('SUPER_ADMIN'),                                                              ctrl.runSeed);

export default router;

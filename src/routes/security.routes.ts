// Familista — Security routes (Phase I)
// Mounted at /api/v1/security.

import { Router } from 'express';
import * as ctrl from '../controllers/security.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { tenantGuard } from '../middleware/tenant-guard.middleware';

const router = Router();
router.use(authenticate);
router.use(tenantGuard);

// Audit chain — read + verify. Read is open to admins + analysts;
// verify is the same: anyone with access to security logs can verify.
router.get('/audit',          authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.listAudit);
router.get('/audit/head',     authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.getAuditHead);
router.get('/audit/verify',         authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.verifyChain);
router.get('/audit/verify/full',    authorize('SUPER_ADMIN','CLUB_ADMIN'),                         ctrl.verifyChainComplete);

// Security events feed.
router.get('/events',         authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.listEventsCtrl);

// AI approval queue (high-risk human gate).
router.get('/approvals',                       authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST','MEDICAL_STAFF'), ctrl.listApprovals);
router.post('/approvals/:approvalId/approve',  authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH'), ctrl.approveOne);
router.post('/approvals/:approvalId/reject',   authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH'), ctrl.rejectOne);

// Operational stats — rate-limit + nonce cache sizes.
router.get('/health',         authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.securityHealth);

export default router;

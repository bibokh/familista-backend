// Familista — Phase J billing routes. Mounted at /api/v1/billing-j to
// avoid collision with the legacy /billing namespace from Phase A.

import { Router } from 'express';
import * as ctrl from '../controllers/billing-j.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

router.get('/tiers',                              ctrl.listTiers);
router.get('/account',                            ctrl.getAccount);
router.post('/account/plan',                      authorize('CLUB_ADMIN','SUPER_ADMIN'), ctrl.changePlan);
router.post('/account/cancel',                    authorize('CLUB_ADMIN','SUPER_ADMIN'), ctrl.cancelAccount);
router.get('/devices/:deviceId/plans',            ctrl.listDevicePlans);
router.post('/devices/plans',                     authorize('CLUB_ADMIN','SUPER_ADMIN'), ctrl.assignDevicePlan);
router.get('/usage',                              ctrl.listUsage);
router.get('/invoices',                           authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH'), ctrl.listInvoiceDrafts);
router.post('/invoices',                          authorize('CLUB_ADMIN','SUPER_ADMIN'), ctrl.createInvoiceDraft);

export default router;

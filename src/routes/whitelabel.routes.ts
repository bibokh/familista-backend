// Familista — White-label Engine
// File location: src/routes/whitelabel.routes.ts
//
// Express router. Wire under /api/v1/whitelabel via routes/index.ts.
//
// Path conventions:
//   PUBLIC  GET  /public/resolve?host=...     → theme JSON for SPA boot
//   ADMIN   GET  /                            → current config
//   ADMIN   PUT  /                            → upsert config
//   ADMIN   POST /reset                       → restore defaults
//   ADMIN   GET  /preview                     → theme as resolved for this club
//   ADMIN   GET  /domains                     → list custom domains
//   ADMIN   POST /domains                     → register a new custom domain
//   ADMIN   POST /domains/:id/verify          → run DNS verification
//   ADMIN   POST /domains/:id/promote         → mark domain as primary
//   ADMIN   DELETE /domains/:id               → remove a domain
//   ADMIN   GET  /audit                       → audit log

import { Router } from 'express';

import * as ctrl from '../controllers/whitelabel.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireWhiteLabelAccess, publicThemeRateLimiter } from '../middleware/whitelabel.middleware';

const router = Router();

// Public (no auth) — rate-limited
router.get('/public/resolve', publicThemeRateLimiter, ctrl.resolveTheme);

// Admin (auth + role/plan gate)
router.use(authenticate, requireWhiteLabelAccess);

router.get('/', ctrl.getMyConfig);
router.put('/', ctrl.updateMyConfig);
router.post('/reset', ctrl.resetMyConfig);
router.get('/preview', ctrl.previewMyTheme);

router.get('/domains', ctrl.listDomains);
router.post('/domains', ctrl.addDomain);
router.post('/domains/:id/verify', ctrl.verifyDomain);
router.post('/domains/:id/promote', ctrl.promoteDomain);
router.delete('/domains/:id', ctrl.deleteDomain);

router.get('/audit', ctrl.getAuditLog);

export default router;

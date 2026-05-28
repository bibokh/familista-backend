// src/routes/club-admin.routes.ts
// Phase 12 — Club Admin Control Center routes
// Mounted at /api/v1/club-admin
// Role guard: CLUB_ADMIN or SUPER_ADMIN only.

import { Router }                     from 'express';
import { UserRole }                   from '@prisma/client';
import { authenticate, authorize }    from '../middleware/auth.middleware';
import * as ctrl                      from '../controllers/club-admin.controller';

const router = Router();

// Every route requires authentication + CLUB_ADMIN or SUPER_ADMIN role.
router.use(authenticate, authorize(UserRole.CLUB_ADMIN, UserRole.SUPER_ADMIN));

// GET /api/v1/club-admin/data-quality
// Returns player completeness scores + missing-field summary for the club.
router.get('/data-quality',  ctrl.getDataQuality);

// GET /api/v1/club-admin/system-health
// Returns DB status, active GPS count, process uptime, player/match totals.
router.get('/system-health', ctrl.getSystemHealth);

// GET /api/v1/club-admin/audit-log?limit=50
// Returns the last N PlayerAuditLog entries for the club.
router.get('/audit-log',     ctrl.getAuditLog);

export default router;

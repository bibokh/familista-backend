// Familista — Automation + AI Agent routes (Phase B)
// Mounted under /api/v1/automation.

import { Router } from 'express';
import * as ctrl from '../controllers/automation.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

// ── Tasks (declarative recurring jobs) ───────────────────────────────────
router.get('/tasks',                  ctrl.listTasks);
router.post('/tasks',                 authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.createTask);
router.get('/tasks/:id',              ctrl.getTask);
router.patch('/tasks/:id',            authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updateTask);
router.put('/tasks/:id',              authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updateTask);
router.delete('/tasks/:id',           authorize('CLUB_ADMIN'),              ctrl.deleteTask);
router.post('/tasks/:id/trigger',     authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.triggerTask);
router.get('/tasks/:id/runs',         ctrl.listTaskRuns);

// ── AI agent jobs (single agentic invocation) ────────────────────────────
router.get('/agents/jobs',            ctrl.listAgentJobs);
router.post('/agents/jobs',           authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','MEDICAL_STAFF'), ctrl.enqueueAgentJob);
router.get('/agents/jobs/:id',        ctrl.getAgentJob);
router.post('/agents/jobs/:id/cancel', authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.cancelAgentJob);

export default router;

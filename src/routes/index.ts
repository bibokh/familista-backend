import { Router } from 'express';
import authRoutes       from './auth.routes';
import playerRoutes     from './player.routes';
import matchRoutes      from './match.routes';
import analyticsRoutes  from './analytics.routes';
import aiRoutes         from './ai.routes';
import billingRoutes    from './billing.routes';
import trainingRoutes   from './training.routes';
// Phase A — Global SaaS Foundation
import teamRoutes       from './team.routes';
import membershipRoutes from './membership.routes';
import contextRoutes    from './context.routes';
// Phase B — Match Intelligence + Hardware Sessions + Automation
import deviceRoutes     from './device-session.routes';
import automationRoutes from './automation.routes';
// Phase E — AI Operations (alerts / recommendations / reports)
import aiOpsRoutes      from './ai-ops.routes';
// Phase F — Device PCB infrastructure (registry / firmware / calibration)
import deviceInfraRoutes from './device-infra.routes';
// Phase G — Vision intelligence + cognitive spatial + predictive intelligence
import visionRoutes     from './vision.routes';
import spatialRoutes    from './spatial.routes';
import predictiveRoutes from './predictive.routes';
// Phase I — Zero-trust security: audit chain + events + approvals
import securityRoutes   from './security.routes';
import { rateLimit, rateLimitAuth } from '../middleware/rate-limit.middleware';
// Phase J — Global distributed sports cloud
import distributedRoutes  from './distributed.routes';
import edgeRoutes         from './edge.routes';
import provisioningRoutes from './provisioning.routes';
import billingJRoutes     from './billing-j.routes';
import observabilityRoutes from './observability.routes';
// Phase K — Neuromorphic vision + autonomous visual tactical engine
import neuroRoutes        from './neuro.routes';
// Phase L — Federated cognition + real HW + simulation + cognitive graph + biochem + sport catalog + quantum
import phaseLRoutes       from './phase-l.routes';
// Phase M — Autonomous Sports Ecosystem (twins + exec + recruitment + training + economics + scouting + marketplace + council + knowledge)
import phaseMRoutes       from './phase-m.routes';
// Phase N — Global Sports Knowledge Graph + Universal Identity + Multi-Sport + Reasoning + Cryptographic Anchoring
import phaseNRoutes       from './phase-n.routes';
// Phase O — Production Reality Layer (RBAC + Auth sessions + MFA + Ops + Lifecycle + HW deploy + Notifications + Governance + Monitoring)
import phaseORoutes       from './phase-o.routes';
// Phase P — Real-launch layer (status rollup + attendance reports + payer balance + in-app inbox + FC Familista seed)
import phasePRoutes       from './phase-p.routes';
// Phase Q — Football Intelligence Core (match events + xG + player stats + workload + video + transfer + competition)
import phaseQRoutes       from './phase-q.routes';
// Phase S — Enterprise Football Intelligence Platform (Video + AI + Realtime + Sensors + Multi-Club + Big Data)
import intelligenceRoutes from './intelligence.routes';
// Phase 7 — Scouting & Recruitment Center
import scoutingRoutes from './scouting.routes';
// Phase 12 — Club Admin Control Center (data quality + system health + audit log)
import clubAdminRoutes from './club-admin.routes';
// Phase 13 — Tactical AI Engine (formation analysis + tactical scores + recommendations)
import tacticalAIRoutes from './tactical-ai.routes';
// Phase R — Club System (club profile + branding, reuses Club + WhiteLabelConfig)
import clubRoutes from './club.routes';

const router = Router();

// Phase I — global rate limit (SUPER_ADMIN exempt; per-IP + per-user buckets).
// Auth routes get the tighter bucket via /auth chain below.
router.use(rateLimit);

router.use('/auth',        rateLimitAuth, authRoutes);
router.use('/players',     playerRoutes);
router.use('/matches',     matchRoutes);
router.use('/analytics',   analyticsRoutes);
router.use('/ai',          aiRoutes);
router.use('/billing',     billingRoutes);
router.use('/training',    trainingRoutes);
router.use('/teams',       teamRoutes);
router.use('/memberships', membershipRoutes);
router.use('/me',          contextRoutes);
router.use('/devices',     deviceRoutes);
router.use('/automation',  automationRoutes);
router.use('/ai-ops',      aiOpsRoutes);
router.use('/device-infra', deviceInfraRoutes);
router.use('/vision',      visionRoutes);
router.use('/spatial',     spatialRoutes);
router.use('/predictive',  predictiveRoutes);
router.use('/security',    securityRoutes);
router.use('/distributed', distributedRoutes);
router.use('/edge',        edgeRoutes);
router.use('/provisioning', provisioningRoutes);
router.use('/billing-j',   billingJRoutes);
router.use('/observability', observabilityRoutes);
router.use('/neuro',       neuroRoutes);
router.use('/phase-l',     phaseLRoutes);
router.use('/phase-m',     phaseMRoutes);
router.use('/phase-n',     phaseNRoutes);
router.use('/phase-o',     phaseORoutes);
router.use('/phase-p',     phasePRoutes);
router.use('/phase-q',     phaseQRoutes);
router.use('/phase-s/intelligence', intelligenceRoutes);
router.use('/scouting',            scoutingRoutes);
router.use('/club-admin',          clubAdminRoutes);
router.use('/tactical-ai',         tacticalAIRoutes);
router.use('/clubs',               clubRoutes);

// Health check
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '1.0.0',
  });
});

export default router;

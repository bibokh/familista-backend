// Familista — Platform Admin Dashboard routes
// File location: src/routes/admin-dashboard.routes.ts
//
// Mounted under /api/v1/admin (alongside the existing /api/v1/admin/* white-label
// routes). All routes require, in order:
//   1. authenticate              — JWT
//   2. requirePlatformRole       — PlatformAdmin row, IP allowlist, MFA freshness
//   3. requireCapability(cap)    — granular per-role capability
//
// Read paths use *:read caps. Destructive paths use targeted *:write caps and
// the underlying service writes a PlatformAuditLog entry.

import { Router } from 'express';

import * as ctrl from '../controllers/admin-dashboard.controller';
import { authenticate } from '../middleware/auth.middleware';
import {
  requirePlatformRole,
  requireCapability,
} from '../middleware/admin-rbac.middleware';

const router = Router();

// All routes below require auth + platform role.
router.use(authenticate, requirePlatformRole);

// ─── Dashboard summaries ────────────────────────────────────────────────────
router.get('/dashboard/overview',
  requireCapability('dashboard:read'), ctrl.getOverview);
router.get('/dashboard/engines',
  requireCapability('dashboard:read'), ctrl.getEngineStatus);
router.get('/dashboard/subscriptions',
  requireCapability('dashboard:read'), ctrl.getSubscriptionBreakdown);
router.get('/dashboard/ai',
  requireCapability('ai-engine:read'), ctrl.getAiEngineDetail);
router.get('/dashboard/vision',
  requireCapability('vision-engine:read'), ctrl.getVisionEngineDetail);
router.get('/dashboard/alerts',
  requireCapability('dashboard:read'), ctrl.getSystemAlerts);

// ─── Organizations / clubs / academies ──────────────────────────────────────
router.get('/organizations',
  requireCapability('org:read'), ctrl.listOrganizations);
router.get('/organizations/:id',
  requireCapability('org:read'), ctrl.getOrganizationDetail);
router.get('/clubs',
  requireCapability('org:read'), ctrl.listOrganizations);    // alias
router.get('/clubs/:id',
  requireCapability('org:read'), ctrl.getOrganizationDetail);
router.get('/academies',
  requireCapability('org:read'), ctrl.listAcademies);

// ─── Users (general / coaches / managers) ───────────────────────────────────
router.get('/users',
  requireCapability('platform-admin:read'), ctrl.listUsers);
router.get('/coaches',
  requireCapability('coaches:read'), ctrl.listCoaches);
router.get('/managers',
  requireCapability('managers:read'), ctrl.listManagers);
router.patch('/users/:id/active',
  requireCapability('platform-admin:write'), ctrl.setUserActive);

// ─── Players ────────────────────────────────────────────────────────────────
router.get('/players',
  requireCapability('players:read'), ctrl.listPlayers);

// ─── Investors ──────────────────────────────────────────────────────────────
router.get('/investors',
  requireCapability('investor-profile:read'), ctrl.listInvestors);
router.patch('/investors/:id/active',
  requireCapability('investor-profile:write'), ctrl.setInvestorActive);

// ─── Subscriptions ──────────────────────────────────────────────────────────
router.get('/subscriptions',
  requireCapability('subscription:read'), ctrl.listSubscriptions);

// ─── Payments ───────────────────────────────────────────────────────────────
router.get('/payments',
  requireCapability('payment:read'), ctrl.listPayments);

// ─── Franchise units ────────────────────────────────────────────────────────
router.get('/franchise-units',
  requireCapability('franchise-unit:read'), ctrl.listFranchiseUnits);
router.patch('/franchise-units/:id/status',
  requireCapability('franchise-unit:write'), ctrl.setFranchiseUnitStatus);

// ─── AI engine ──────────────────────────────────────────────────────────────
router.get('/ai/models',
  requireCapability('ai-engine:read'), ctrl.listAiModels);
router.get('/ai/decisions',
  requireCapability('ai-engine:read'), ctrl.listAiDecisions);

// ─── Vision engine ──────────────────────────────────────────────────────────
router.get('/vision/runs',
  requireCapability('vision-engine:read'), ctrl.listVisionRuns);

// ─── Audit logs ─────────────────────────────────────────────────────────────
router.get('/audit-logs',
  requireCapability('audit:read'), ctrl.listAuditLogs);

export default router;

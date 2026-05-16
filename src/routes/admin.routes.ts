// Familista — Super Admin White-label Control Panel
// File location: src/routes/admin.routes.ts
//
// Mounted under /api/v1/admin. All routes require:
//   1. JWT auth (`authenticate`)
//   2. PlatformAdmin record + IP allowlist + fresh MFA (`requirePlatformRole`)
//   3. Capability check per endpoint (`requireCapability`)
//
// Asset uploads use multer with an in-memory buffer (≤6 MB hard cap).

import { Router } from 'express';
import multer from 'multer';

import * as ctrl from '../controllers/admin.controller';
import { authenticate } from '../middleware/auth.middleware';
import {
  requirePlatformRole,
  requireCapability,
} from '../middleware/admin-rbac.middleware';

const UPLOAD_HARD_CAP_BYTES = 6 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_HARD_CAP_BYTES, files: 1 },
});

const router = Router();

router.use(authenticate, requirePlatformRole);

// ── 1. Platform admins ──────────────────────────────────────────────────────
router.get('/platform-admins',
  requireCapability('platform-admin:read'), ctrl.listPlatformAdmins);
router.get('/platform-admins/:id',
  requireCapability('platform-admin:read'), ctrl.getPlatformAdmin);
router.post('/platform-admins',
  requireCapability('platform-admin:write'), ctrl.createPlatformAdmin);
router.patch('/platform-admins/:id',
  requireCapability('platform-admin:write'), ctrl.updatePlatformAdmin);
router.delete('/platform-admins/:id',
  requireCapability('platform-admin:write'), ctrl.deletePlatformAdmin);

// ── 2. Branding (cross-tenant) ──────────────────────────────────────────────
router.get('/whitelabel/configs',
  requireCapability('branding:read'), ctrl.listConfigs);
router.get('/whitelabel/configs/:clubId',
  requireCapability('branding:read'), ctrl.getConfig);
router.put('/whitelabel/configs/:clubId',
  requireCapability('branding:write'), ctrl.updateConfig);
router.post('/whitelabel/configs/:clubId/reset',
  requireCapability('branding:write'), ctrl.resetConfig);

// ── 3. Assets ───────────────────────────────────────────────────────────────
router.get('/whitelabel/configs/:clubId/assets',
  requireCapability('branding:read'), ctrl.listAssets);
router.post('/whitelabel/configs/:clubId/assets',
  requireCapability('asset:upload'), upload.single('file'), ctrl.uploadAsset);
router.delete('/whitelabel/configs/:clubId/assets/:assetId',
  requireCapability('asset:delete'), ctrl.deleteAsset);

// ── 4. Palettes ─────────────────────────────────────────────────────────────
router.get('/whitelabel/palettes',
  requireCapability('palette:read'), ctrl.listPalettes);
router.post('/whitelabel/palettes',
  requireCapability('palette:write'), ctrl.createPalette);
router.patch('/whitelabel/palettes/:id',
  requireCapability('palette:write'), ctrl.updatePalette);
router.delete('/whitelabel/palettes/:id',
  requireCapability('palette:write'), ctrl.deletePalette);
router.post('/whitelabel/palettes/seed-presets',
  requireCapability('palette:write'), ctrl.seedPalettePresets);
router.post('/whitelabel/configs/:clubId/apply-palette',
  requireCapability('branding:write'), ctrl.applyPalette);

// ── 5. Domains (cross-tenant) ───────────────────────────────────────────────
router.get('/whitelabel/domains',
  requireCapability('domain:read'), ctrl.listDomains);
router.get('/whitelabel/domains/:domainId',
  requireCapability('domain:read'), ctrl.getDomain);
router.post('/whitelabel/domains/:domainId/verify',
  requireCapability('domain:force-verify'), ctrl.forceVerifyDomain);
router.post('/whitelabel/domains/:domainId/status',
  requireCapability('domain:write'), ctrl.setDomainStatus);
router.delete('/whitelabel/domains/:domainId',
  requireCapability('domain:write'), ctrl.deleteDomain);

// ── 6. Organization limits ──────────────────────────────────────────────────
router.get('/organizations/:clubId/limits',
  requireCapability('org:read'), ctrl.getLimits);
router.put('/organizations/:clubId/limits',
  requireCapability('limits:write'), ctrl.updateLimits);

// ── 7. Subscription overrides + entitlement matrix ──────────────────────────
router.get('/organizations/:clubId/license',
  requireCapability('license:read'), ctrl.getEntitlementMatrix);
router.get('/organizations/:clubId/overrides',
  requireCapability('billing:read'), ctrl.listOverrides);
router.post('/organizations/:clubId/overrides',
  requireCapability('billing:override'), ctrl.createOverride);
router.post('/organizations/:clubId/overrides/:overrideId/revoke',
  requireCapability('billing:override'), ctrl.revokeOverride);

// ── 8. Feature flags ────────────────────────────────────────────────────────
router.get('/feature-flags',
  requireCapability('feature-flag:read'), ctrl.listFlags);
router.put('/feature-flags',
  requireCapability('feature-flag:write'), ctrl.upsertFlag);
router.delete('/feature-flags/:key',
  requireCapability('feature-flag:write'), ctrl.deleteFlag);
router.post('/feature-flags/seed',
  requireCapability('feature-flag:write'), ctrl.seedFlags);

// ── 9. Impersonation ────────────────────────────────────────────────────────
router.post('/impersonations',
  requireCapability('impersonate:start'), ctrl.startImpersonation);
router.get('/impersonations',
  requireCapability('audit:read'), ctrl.listImpersonations);
router.post('/impersonations/:sessionId/end',
  requireCapability('impersonate:end'), ctrl.endImpersonation);

// ── 10. Audit log ───────────────────────────────────────────────────────────
router.get('/audit',
  requireCapability('audit:read'), ctrl.searchAudit);
router.get('/audit/summary',
  requireCapability('audit:read'), ctrl.summarizeAudit);
router.get('/audit/export',
  requireCapability('audit:read'), ctrl.exportAudit);

export default router;

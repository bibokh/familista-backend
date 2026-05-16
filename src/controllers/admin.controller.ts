// Familista — Super Admin White-label Control Panel
// File location: src/controllers/admin.controller.ts
//
// HTTP handlers for the operator console. Thin shims over the admin-* services.
// Sections:
//   1. Platform admins (RBAC CRUD)
//   2. Branding (cross-tenant)
//   3. Assets (logo upload / delete)
//   4. Palettes (presets + custom + apply)
//   5. Domains (cross-tenant management)
//   6. Organization limits
//   7. Subscription overrides + entitlement matrix
//   8. Feature flags
//   9. Impersonation
//  10. Audit log

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import * as rbacSvc from '../services/admin-rbac.service';
import * as brandingSvc from '../services/admin-branding.service';
import * as assetSvc from '../services/admin-asset.service';
import * as domainSvc from '../services/admin-domain.service';
import * as orgSvc from '../services/admin-organization.service';
import * as flagSvc from '../services/admin-feature-flag.service';
import * as imperSvc from '../services/admin-impersonation.service';
import * as auditSvc from '../services/admin-audit.service';

import {
  createPlatformAdminSchema,
  updatePlatformAdminSchema,
  adminUpsertBrandingSchema,
  createPaletteSchema,
  updatePaletteSchema,
  applyPaletteSchema,
  forceVerifyDomainSchema,
  setDomainStatusSchema,
  updateLimitsSchema,
  createOverrideSchema,
  revokeOverrideSchema,
  upsertFeatureFlagSchema,
  startImpersonationSchema,
  assetUploadMetaSchema,
  auditQuerySchema,
} from '../utils/admin.validators';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { BadRequestError, ForbiddenError } from '../utils/errors';
import { invalidatePdfBrandingCache } from '../services/pdf-branding.service';
import { invalidateEmailBrandingCache } from '../services/email-branding.service';

function actorOf(req: Request) {
  if (!req.platformActor) throw new ForbiddenError('Platform context required');
  return req.platformActor;
}

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.join('.') || 'body'}: ${e.message}`).join(', '));
}

// ─── 1. Platform admins ──────────────────────────────────────────────────────

export async function listPlatformAdmins(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await rbacSvc.listPlatformAdmins(actorOf(req))); }
  catch (err) { return next(err); }
}

export async function getPlatformAdmin(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await rbacSvc.getPlatformAdmin(req.params.id)); }
  catch (err) { return next(err); }
}

export async function createPlatformAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const input = createPlatformAdminSchema.parse(req.body);
    return sendCreated(res, await rbacSvc.createPlatformAdmin(actorOf(req), input), 'Platform admin created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updatePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const input = updatePlatformAdminSchema.parse(req.body);
    return sendSuccess(res, await rbacSvc.updatePlatformAdmin(actorOf(req), req.params.id, input), 'Platform admin updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function deletePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    await rbacSvc.deletePlatformAdmin(actorOf(req), req.params.id);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// ─── 2. Branding (cross-tenant) ──────────────────────────────────────────────

export async function listConfigs(req: Request, res: Response, next: NextFunction) {
  try {
    const search = (req.query.search as string | undefined) ?? undefined;
    const cursor = (req.query.cursor as string | undefined) ?? undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    return sendSuccess(res, await brandingSvc.adminListConfigs({ search, cursor, limit }));
  } catch (err) { return next(err); }
}

export async function getConfig(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await brandingSvc.adminGetConfig(req.params.clubId)); }
  catch (err) { return next(err); }
}

export async function updateConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const input = adminUpsertBrandingSchema.parse(req.body);
    const cfg = await brandingSvc.adminUpsertBranding(actorOf(req), req.params.clubId, input);
    invalidatePdfBrandingCache(req.params.clubId);
    invalidateEmailBrandingCache(req.params.clubId);
    return sendSuccess(res, cfg, 'Branding updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function resetConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const cfg = await brandingSvc.adminResetConfig(actorOf(req), req.params.clubId);
    invalidatePdfBrandingCache(req.params.clubId);
    invalidateEmailBrandingCache(req.params.clubId);
    return sendSuccess(res, cfg, 'Branding reset to defaults');
  } catch (err) { return next(err); }
}

// ─── 3. Assets ────────────────────────────────────────────────────────────────

export async function uploadAsset(req: Request, res: Response, next: NextFunction) {
  try {
    const file = (req as Request & { file?: { buffer: Buffer; mimetype: string; originalname: string } }).file;
    if (!file) throw new BadRequestError('file field required (multipart/form-data)');

    const meta = assetUploadMetaSchema.parse({
      type: req.body.type,
      setAsActive: req.body.setAsActive === undefined ? undefined : req.body.setAsActive === 'true' || req.body.setAsActive === true,
    });

    const asset = await assetSvc.uploadAsset(actorOf(req), req.params.clubId, meta, file);
    invalidatePdfBrandingCache(req.params.clubId);
    invalidateEmailBrandingCache(req.params.clubId);
    return sendCreated(res, asset, 'Asset uploaded');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function listAssets(req: Request, res: Response, next: NextFunction) {
  try {
    const type = (req.query.type as string | undefined) as never;
    return sendSuccess(res, await assetSvc.listAssets(req.params.clubId, type));
  } catch (err) { return next(err); }
}

export async function deleteAsset(req: Request, res: Response, next: NextFunction) {
  try {
    await assetSvc.deleteAsset(actorOf(req), req.params.clubId, req.params.assetId);
    invalidatePdfBrandingCache(req.params.clubId);
    invalidateEmailBrandingCache(req.params.clubId);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// ─── 4. Palettes ──────────────────────────────────────────────────────────────

export async function listPalettes(req: Request, res: Response, next: NextFunction) {
  try {
    const category = (req.query.category as string | undefined) ?? undefined;
    return sendSuccess(res, await brandingSvc.listPalettes({ category }));
  } catch (err) { return next(err); }
}

export async function createPalette(req: Request, res: Response, next: NextFunction) {
  try {
    const input = createPaletteSchema.parse(req.body);
    return sendCreated(res, await brandingSvc.createPalette(actorOf(req), input), 'Palette created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updatePalette(req: Request, res: Response, next: NextFunction) {
  try {
    const input = updatePaletteSchema.parse(req.body);
    return sendSuccess(res, await brandingSvc.updatePalette(actorOf(req), req.params.id, input), 'Palette updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function deletePalette(req: Request, res: Response, next: NextFunction) {
  try {
    await brandingSvc.deletePalette(actorOf(req), req.params.id);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

export async function applyPalette(req: Request, res: Response, next: NextFunction) {
  try {
    const input = applyPaletteSchema.parse(req.body);
    const result = await brandingSvc.applyPaletteToClub(actorOf(req), req.params.clubId, input);
    invalidatePdfBrandingCache(req.params.clubId);
    invalidateEmailBrandingCache(req.params.clubId);
    return sendSuccess(res, result, 'Palette applied');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function seedPalettePresets(req: Request, res: Response, next: NextFunction) {
  try {
    const count = await brandingSvc.seedSystemPalettes(actorOf(req));
    return sendSuccess(res, { seeded: count }, 'System palettes seeded');
  } catch (err) { return next(err); }
}

// ─── 5. Domains (cross-tenant) ────────────────────────────────────────────────

export async function listDomains(req: Request, res: Response, next: NextFunction) {
  try {
    const status = (req.query.status as string | undefined) as never;
    const search = (req.query.search as string | undefined) ?? undefined;
    const cursor = (req.query.cursor as string | undefined) ?? undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    return sendSuccess(res, await domainSvc.listAllDomains({ status, search, cursor, limit }));
  } catch (err) { return next(err); }
}

export async function getDomain(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await domainSvc.getDomain(req.params.domainId)); }
  catch (err) { return next(err); }
}

export async function forceVerifyDomain(req: Request, res: Response, next: NextFunction) {
  try {
    const input = forceVerifyDomainSchema.parse(req.body);
    return sendSuccess(res, await domainSvc.adminVerifyDomain(actorOf(req), req.params.domainId, input));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function setDomainStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const input = setDomainStatusSchema.parse(req.body);
    return sendSuccess(res, await domainSvc.setDomainStatus(actorOf(req), req.params.domainId, input), 'Domain status updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function deleteDomain(req: Request, res: Response, next: NextFunction) {
  try {
    await domainSvc.deleteDomain(actorOf(req), req.params.domainId);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// ─── 6. Organization limits ───────────────────────────────────────────────────

export async function getLimits(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await orgSvc.getLimits(req.params.clubId)); }
  catch (err) { return next(err); }
}

export async function updateLimits(req: Request, res: Response, next: NextFunction) {
  try {
    const input = updateLimitsSchema.parse(req.body);
    return sendSuccess(res, await orgSvc.updateLimits(actorOf(req), req.params.clubId, input), 'Limits updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 7. Subscription overrides + entitlement matrix ───────────────────────────

export async function listOverrides(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await orgSvc.listOverrides(req.params.clubId)); }
  catch (err) { return next(err); }
}

export async function createOverride(req: Request, res: Response, next: NextFunction) {
  try {
    const input = createOverrideSchema.parse(req.body);
    return sendCreated(res, await orgSvc.createOverride(actorOf(req), req.params.clubId, input), 'Subscription override applied');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function revokeOverride(req: Request, res: Response, next: NextFunction) {
  try {
    const input = revokeOverrideSchema.parse(req.body);
    return sendSuccess(res, await orgSvc.revokeOverride(actorOf(req), req.params.clubId, req.params.overrideId, input), 'Override revoked');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function getEntitlementMatrix(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await orgSvc.getEntitlementMatrix(req.params.clubId)); }
  catch (err) { return next(err); }
}

// ─── 8. Feature flags ─────────────────────────────────────────────────────────

export async function listFlags(_req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await flagSvc.listFeatureFlags()); }
  catch (err) { return next(err); }
}

export async function upsertFlag(req: Request, res: Response, next: NextFunction) {
  try {
    const input = upsertFeatureFlagSchema.parse(req.body);
    return sendSuccess(res, await flagSvc.upsertFeatureFlag(actorOf(req), input), 'Feature flag saved');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function deleteFlag(req: Request, res: Response, next: NextFunction) {
  try {
    await flagSvc.deleteFeatureFlag(actorOf(req), req.params.key);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

export async function seedFlags(req: Request, res: Response, next: NextFunction) {
  try {
    const count = await flagSvc.seedBuiltinFlags(actorOf(req));
    return sendSuccess(res, { seeded: count }, 'Built-in feature flags seeded');
  } catch (err) { return next(err); }
}

// ─── 9. Impersonation ────────────────────────────────────────────────────────

export async function startImpersonation(req: Request, res: Response, next: NextFunction) {
  try {
    const input = startImpersonationSchema.parse(req.body);
    const result = await imperSvc.startImpersonation(actorOf(req), input);
    return sendCreated(res, {
      sessionId: result.session.id,
      token: result.token,
      expiresAt: result.expiresAt,
      targetUserId: result.session.targetUserId,
      targetClubId: result.session.targetClubId,
    }, 'Impersonation token issued');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function endImpersonation(req: Request, res: Response, next: NextFunction) {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'operator-ended';
    return sendSuccess(res, await imperSvc.endImpersonation(actorOf(req), req.params.sessionId, reason), 'Impersonation ended');
  } catch (err) { return next(err); }
}

export async function listImpersonations(req: Request, res: Response, next: NextFunction) {
  try {
    const status = (req.query.status as string | undefined) as never;
    const targetClubId = (req.query.clubId as string | undefined) ?? undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    return sendSuccess(res, await imperSvc.listImpersonations({ status, targetClubId, limit }));
  } catch (err) { return next(err); }
}

// ─── 10. Audit log ────────────────────────────────────────────────────────────

export async function searchAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const q = auditQuerySchema.parse(req.query);
    return sendSuccess(res, await auditSvc.searchAudit(q));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function summarizeAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const q = auditQuerySchema.parse(req.query);
    return sendSuccess(res, await auditSvc.summarizeAudit(q));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function exportAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const q = auditQuerySchema.parse(req.query);
    const rows = await auditSvc.exportAudit(q);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="platform-audit-${Date.now()}.json"`);
    return res.send(JSON.stringify(rows, null, 2));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

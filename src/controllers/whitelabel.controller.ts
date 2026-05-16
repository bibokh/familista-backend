// Familista — White-label Engine
// File location: src/controllers/whitelabel.controller.ts
//
// Controller layer: thin HTTP handlers. All business logic lives in the service.

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import * as whitelabelService from '../services/whitelabel.service';
import {
  upsertConfigSchema,
  addDomainSchema,
  resolveQuerySchema,
} from '../utils/whitelabel.validators';
import {
  sendSuccess,
  sendCreated,
  sendNoContent,
} from '../utils/response';
import { BadRequestError } from '../utils/errors';

function clientContext(req: Request) {
  return {
    ipAddress: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

function zodErrorToMessage(err: z.ZodError): string {
  return err.errors.map((e) => `${e.path.join('.') || 'body'}: ${e.message}`).join(', ');
}

// ── Admin endpoints ──────────────────────────────────────────────────────────

export async function getMyConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const cfg = await whitelabelService.getConfig(req.user!.clubId);
    return sendSuccess(res, cfg);
  } catch (err) {
    return next(err);
  }
}

export async function updateMyConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const input = upsertConfigSchema.parse(req.body);
    const ctx = clientContext(req);
    const cfg = await whitelabelService.upsertConfig(req.user!.clubId, input, {
      userId: req.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return sendSuccess(res, cfg, 'White-label configuration updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(new BadRequestError(zodErrorToMessage(err)));
    return next(err);
  }
}

export async function resetMyConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = clientContext(req);
    const cfg = await whitelabelService.resetConfig(req.user!.clubId, {
      userId: req.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return sendSuccess(res, cfg, 'White-label configuration reset to defaults');
  } catch (err) {
    return next(err);
  }
}

export async function previewMyTheme(req: Request, res: Response, next: NextFunction) {
  try {
    const theme = await whitelabelService.resolveThemeByClub(req.user!.clubId);
    return sendSuccess(res, theme);
  } catch (err) {
    return next(err);
  }
}

// ── Domain management ───────────────────────────────────────────────────────

export async function listDomains(req: Request, res: Response, next: NextFunction) {
  try {
    const domains = await whitelabelService.listDomains(req.user!.clubId);
    return sendSuccess(res, domains);
  } catch (err) {
    return next(err);
  }
}

export async function addDomain(req: Request, res: Response, next: NextFunction) {
  try {
    const input = addDomainSchema.parse(req.body);
    const ctx = clientContext(req);
    const domain = await whitelabelService.addDomain(req.user!.clubId, input, {
      userId: req.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return sendCreated(res, {
      ...domain,
      verifyInstructions: {
        recordType: 'TXT',
        host: domain.verifyHost,
        value: domain.verifyToken,
        ttlSeconds: 300,
        note: 'Add this TXT record to your DNS provider, then POST /verify to complete activation.',
      },
    }, 'Domain registered. Awaiting DNS verification.');
  } catch (err) {
    if (err instanceof z.ZodError) return next(new BadRequestError(zodErrorToMessage(err)));
    return next(err);
  }
}

export async function verifyDomain(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = clientContext(req);
    const domain = await whitelabelService.verifyDomain(req.user!.clubId, req.params.id, {
      userId: req.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    if (domain.status === 'ACTIVE') {
      return sendSuccess(res, domain, 'Domain verified and active');
    }
    return sendSuccess(res, domain, domain.failureReason ?? 'Verification incomplete');
  } catch (err) {
    return next(err);
  }
}

export async function promoteDomain(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = clientContext(req);
    const domain = await whitelabelService.promoteDomain(req.user!.clubId, req.params.id, {
      userId: req.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return sendSuccess(res, domain, 'Domain promoted to primary');
  } catch (err) {
    return next(err);
  }
}

export async function deleteDomain(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = clientContext(req);
    await whitelabelService.removeDomain(req.user!.clubId, req.params.id, {
      userId: req.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return sendNoContent(res);
  } catch (err) {
    return next(err);
  }
}

// ── Audit log ───────────────────────────────────────────────────────────────

export async function getAuditLog(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const audits = await whitelabelService.listAudits(req.user!.clubId, limit);
    return sendSuccess(res, audits);
  } catch (err) {
    return next(err);
  }
}

// ── Public endpoints (unauthenticated) ──────────────────────────────────────

export async function resolveTheme(req: Request, res: Response, next: NextFunction) {
  try {
    const queryHost = (req.query.host as string | undefined) ?? '';
    const headerHost = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '';
    const host = queryHost || headerHost;

    if (!host) {
      throw new BadRequestError('host is required (query param or Host header)');
    }

    const parsed = resolveQuerySchema.safeParse({ host });
    if (!parsed.success) throw new BadRequestError(zodErrorToMessage(parsed.error));

    const theme = await whitelabelService.resolveThemeByHost(parsed.data.host);

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return sendSuccess(res, theme);
  } catch (err) {
    return next(err);
  }
}

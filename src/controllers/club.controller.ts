// Familista — Club System controller (Phase R)
// GET  /clubs/current      → caller's active club profile
// GET  /clubs/:clubId      → club profile (tenant-guarded upstream)
// PATCH /clubs/:clubId     → update club + brand (CLUB_ADMIN / SUPER_ADMIN)

import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import * as svc from '../services/club.service';
import { sendSuccess } from '../utils/response';
import { BadRequestError, InternalServerError } from '../utils/errors';
import { logger } from '../utils/logger';

// ── Reusable validators ───────────────────────────────────────────────────
const httpsUrl = z
  .string()
  .trim()
  .url('must be a valid URL')
  .max(2048)
  .refine((u) => /^https:\/\//i.test(u), { message: 'only https:// URLs are allowed' });

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'must be a #RRGGBB or #RRGGBBAA hex color');

const text = (max: number) => z.string().trim().max(max);

// Social links: every value must be an https URL (or empty → omitted).
const socialLinks = z
  .object({
    x: httpsUrl.optional(),
    instagram: httpsUrl.optional(),
    facebook: httpsUrl.optional(),
    youtube: httpsUrl.optional(),
    tiktok: httpsUrl.optional(),
    linkedin: httpsUrl.optional(),
  })
  .strict();

const patchSchema = z.object({
  body: z.object({
    // Core Club fields
    name:           text(120).min(1).optional(),
    shortName:      text(40).nullable().optional(),
    description:    text(2000).nullable().optional(),
    founded:        z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullable().optional(),
    stadium:        text(160).nullable().optional(),
    capacity:       z.number().int().min(0).max(500000).nullable().optional(),
    city:           text(120).min(1).optional(),
    country:        text(120).min(1).optional(),
    addressLine:    text(200).nullable().optional(),
    region:         text(120).nullable().optional(),
    postalCode:     text(32).nullable().optional(),
    level:          z.number().int().min(1).max(100).optional(),
    overallRating:  z.number().min(0).max(200).optional(),
    leaguePosition: z.number().int().min(1).max(100).nullable().optional(),
    fanClub:        text(120).nullable().optional(),
    contactEmail:   z.string().trim().email().max(160).nullable().optional(),
    contactPhone:   text(40).nullable().optional(),
    websiteUrl:     httpsUrl.nullable().optional(),
    socialLinks:    socialLinks.nullable().optional(),
    // Brand (WhiteLabelConfig)
    logoUrl:        httpsUrl.nullable().optional(),
    logoDarkUrl:    httpsUrl.nullable().optional(),
    faviconUrl:     httpsUrl.nullable().optional(),
    primaryColor:   hexColor.optional(),
    secondaryColor: hexColor.optional(),
    accentColor:    hexColor.optional(),
  }).strict(),
});

const BRAND_KEYS = ['logoUrl', 'logoDarkUrl', 'faviconUrl', 'primaryColor', 'secondaryColor', 'accentColor'] as const;

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

export async function getCurrentClub(req: Request, res: Response, next: NextFunction) {
  try {
    const clubId = req.user!.clubId;
    if (!clubId) throw new BadRequestError('No active club for this user');
    const profile = await svc.getClubProfile(clubId);
    return sendSuccess(res, profile);
  } catch (err) { return next(err); }
}

export async function getClub(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await svc.getClubProfile(req.params.clubId);
    return sendSuccess(res, profile);
  } catch (err) { return next(err); }
}

export async function updateClub(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = patchSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const b = parsed.data.body;

    // Split validated payload into Club core vs WhiteLabelConfig brand.
    const brand: svc.ClubBrandPatch = {};
    const core: svc.ClubCorePatch = {};
    for (const [k, v] of Object.entries(b)) {
      if ((BRAND_KEYS as readonly string[]).includes(k)) {
        (brand as Record<string, unknown>)[k] = v;
      } else if (k === 'founded') {
        (core as Record<string, unknown>).founded = v == null ? null : new Date(v as string);
      } else {
        (core as Record<string, unknown>)[k] = v;
      }
    }

    try {
      const profile = await svc.updateClubProfile(req.params.clubId, core, brand);
      return sendSuccess(res, profile, 'Club updated');
    } catch (dbErr) {
      // Surface the precise DB failure for this endpoint. The global handler
      // hides 500 detail in prod and never logs the body; here we log the
      // Prisma code + meta + the FIELD KEYS ONLY (never values) and return the
      // concrete message so the cause is visible without trawling logs.
      if (dbErr instanceof Prisma.PrismaClientKnownRequestError) {
        logger.error('Club PATCH Prisma error', {
          code: dbErr.code,
          meta: dbErr.meta,
          fields: Object.keys(b),
          clubId: req.params.clubId,
        });
        const detail = (dbErr.message.split('\n').pop() || dbErr.message).trim();
        throw new InternalServerError(`Club update failed [${dbErr.code}]: ${detail}`);
      }
      throw dbErr;
    }
  } catch (err) { return next(err); }
}

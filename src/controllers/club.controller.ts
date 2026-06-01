// Familista — Club System controller (Phase R)
// GET  /clubs/current      → caller's active club profile
// GET  /clubs/:clubId      → club profile (tenant-guarded upstream)
// PATCH /clubs/:clubId     → update club + brand (CLUB_ADMIN / SUPER_ADMIN)

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/club.service';
import { sendSuccess } from '../utils/response';
import { BadRequestError } from '../utils/errors';

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

// TEMP emergency scope — Club Settings reduced to essentials only. The advanced
// club-profile fields (description / address / region / postalCode / contact* /
// websiteUrl / socialLinks / faviconUrl / logoDark / and the legacy core fields)
// are intentionally NOT accepted here, so the API only ever writes the safe set:
// name + logo + brand colors. `.strict()` rejects anything else.
const patchSchema = z.object({
  body: z.object({
    name:           text(120).min(1).optional(),
    // Brand (WhiteLabelConfig)
    logoUrl:        httpsUrl.nullable().optional(),
    primaryColor:   hexColor.optional(),
    secondaryColor: hexColor.optional(),
    accentColor:    hexColor.optional(),
  }).strict(),
});

const BRAND_KEYS = ['logoUrl', 'primaryColor', 'secondaryColor', 'accentColor'] as const;

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
      } else {
        (core as Record<string, unknown>)[k] = v;
      }
    }

    const profile = await svc.updateClubProfile(req.params.clubId, core, brand);
    return sendSuccess(res, profile, 'Club updated');
  } catch (err) { return next(err); }
}

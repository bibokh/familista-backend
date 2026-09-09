// Familista — Club System controller (Phase R)
// POST  /clubs              → onboard a new club (PLATFORM OWNER only)
// GET   /clubs/current      → caller's active club profile
// GET   /clubs/:clubId      → club profile (tenant-guarded upstream)
// PATCH /clubs/:clubId      → update club + brand (CLUB_ADMIN / SUPER_ADMIN)

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/club.service';
import { sendSuccess } from '../utils/response';
import { BadRequestError } from '../utils/errors';
import { assertPlatformOwner } from '../platform/system.service';
import * as onboarding from '../platform/club-onboarding.service';

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

// ── The club crest ────────────────────────────────────────────────────────
// Accepted in the two forms a crest actually arrives in: an https:// URL for a
// club that hosts its own, and an inline image for one uploaded through the
// crest picker — the same shape the player-photo upload has always sent, so
// there is one upload mechanism in the product rather than two.
//
// The cap is on the encoded string because that is what the request carries.
// 400 000 characters is roughly 300 KB of image, far more than the 256 px
// square the uploader produces and far less than the 2 MB body limit, so a
// pasted original is refused with a message rather than by a 413.
const MAX_CREST_CHARS = 400_000;
const CREST_DATA_URL = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const crestImage = z
  .string()
  .trim()
  .max(MAX_CREST_CHARS, 'image is too large — upload a smaller crest')
  .refine((u) => u === '' || /^https:\/\//i.test(u) || CREST_DATA_URL.test(u), {
    message: 'must be an https:// URL or an uploaded PNG, JPEG or WebP image',
  })
  // An empty string is how the UI says "remove the crest"; it is stored as null
  // so "no crest" is one value and not two.
  .transform((u) => (u === '' ? null : u));

// TEMP emergency scope — Club Settings reduced to essentials only. The advanced
// club-profile fields (description / address / region / postalCode / contact* /
// websiteUrl / socialLinks / faviconUrl / logoDark / and the legacy core fields)
// are intentionally NOT accepted here, so the API only ever writes the safe set:
// name + logo + brand colors. `.strict()` rejects anything else.
const patchSchema = z.object({
  body: z.object({
    name:           text(120).min(1).optional(),
    // Club crest (Club.crestUrl) — club identity, not product branding.
    crestUrl:       crestImage.nullable().optional(),
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

// POST /clubs — onboard a new club.
//
// Required: name, city. Optional: shortName, country, emblem (https URL), and
// the president to invite.
//
// NO side-effect on the caller. Creating a club grants the creator nothing —
// not a membership, not a role, not a place in their own club picker. If the
// president is named the invitation is minted here; if not, the club waits in
// PENDING_SETUP until one is invited through People & Access.
const createSchema = z.object({
  body: z.object({
    name:      text(120).min(1, 'name is required'),
    city:      text(120).min(1, 'city is required'),
    shortName: text(60).optional().nullable(),
    country:   text(120).optional().nullable(),
    emblem:    httpsUrl.optional().nullable(),
    // The person who will run the club. Optional, because a club may be
    // created first and its president invited afterwards — but never the
    // creator, and never implied.
    president: z.object({
      firstName: text(80).min(1, "the president's first name is required"),
      lastName:  text(80).min(1, "the president's last name is required"),
      email:     z.string().trim().email('must be a valid email address').max(254),
      message:   text(1000).optional().nullable(),
    }).strict().optional(),
  }).strict(),
});

/**
 * Onboard a club. The PLATFORM OWNER's action, and nobody else's.
 *
 * This route used to be open to any authenticated account, and it did not
 * merely create a row: it granted the caller a CLUB_OWNER membership in the
 * club it created. So an invited head coach, scoped to one team, could POST
 * here and come out owning a club — a genuine escalation reachable with a
 * single request.
 *
 * That is closed twice over now. The route is the platform owner's, and the
 * creation grants NOBODY anything: named a president, it delegates to the
 * onboarding service, which mints a CLUB_OWNER invitation for that person and
 * leaves the club PRESIDENT_INVITED; named none, the club is created
 * PENDING_SETUP and waits. Either way the club's president is somebody who
 * accepted an invitation, which is the only way a CLUB_OWNER membership is
 * ever created.
 *
 * The platform owner still reaches the club — through platform authority,
 * which needs no membership and is not one.
 */
export async function createClub(req: Request, res: Response, next: NextFunction) {
  try {
    // Before the body is even read: a refusal must not depend on the payload
    // being well formed.
    await assertPlatformOwner({
      userId: req.user?.id ?? '',
      clubId: req.user?.clubId ?? null,
      role: req.user?.role,
    });

    const parsed = createSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const b = parsed.data.body;

    const userId = req.user?.id;
    if (!userId) throw new BadRequestError('No authenticated user');

    // Named a president: one path, the onboarding service's, which is the only
    // code in Familista that may put a club on the road to having an owner.
    if (b.president) {
      const onboarded = await onboarding.createClubWithPresidentInvite(
        {
          userId,
          clubId: req.user?.clubId ?? null,
          role: req.user?.role,
          ipAddress: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        },
        {
          name:      b.name,
          city:      b.city,
          shortName: b.shortName ?? null,
          country:   b.country   ?? null,
          president: {
            firstName: b.president.firstName,
            lastName:  b.president.lastName,
            email:     b.president.email,
            message:   b.president.message ?? null,
          },
        },
      );
      return sendSuccess(
        res,
        {
          clubId: onboarded.clubId,
          // Nobody is a member of this club yet, and the field says so rather
          // than being quietly dropped.
          membershipId: null,
          profile: await svc.getClubProfile(onboarded.clubId),
          setup: onboarded.setup,
          invitation: onboarded.invitation,
          token: onboarded.token,
          delivery: onboarded.delivery,
        },
        'Club created — the president has been invited',
        201,
      );
    }

    const result = await svc.createClubAwaitingPresident(
      {
        name:      b.name,
        city:      b.city,
        shortName: b.shortName ?? null,
        country:   b.country   ?? null,
        emblem:    b.emblem    ?? null,
      },
      userId,
    );

    return sendSuccess(
      res,
      {
        clubId: result.clubId,
        membershipId: result.membershipId,
        lifecycle: result.lifecycle,
        profile: result.profile,
      },
      'Club created — invite a president to activate it',
      201,
    );
  } catch (err) { return next(err); }
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

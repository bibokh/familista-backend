// Familista — user settings (interface language)
// ─────────────────────────────────────────────────────────────────────────────
// The interface language belongs to the PERSON, not the club. Someone who
// manages three clubs reads the same interface in all three, and moving between
// them must not change the language under them. So it lives on the User row and
// is keyed by the authenticated subject — there is no clubId anywhere here, and
// no way to ask for or set anybody else's.
//
// The browser keeps a copy in localStorage for a fast first paint, but this is
// the source of truth: a new device, a cleared cache or a different browser all
// resolve to whatever was last saved here.

import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { sendSuccess } from '../utils/response';
import { BadRequestError } from '../utils/errors';
import { canonicalLocale, LOCALES, DEFAULT_LOCALE } from '../i18n/locales';
import { forgetIdentity } from '../middleware/auth.middleware';

/** GET /api/v1/me/settings — this user's stored preferences. */
export async function getSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const row = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { locale: true },
    });
    return sendSuccess(res, {
      // null is meaningful and is passed through as null: it means "never
      // chosen", which is what lets the client fall back to the browser locale
      // without ever overwriting a real choice.
      locale: row?.locale ?? null,
      defaultLocale: DEFAULT_LOCALE,
      supported: LOCALES,
    });
  } catch (err) { return next(err); }
}

/** PATCH /api/v1/me/settings — save this user's interface language. */
export async function updateSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const body = (req.body ?? {}) as { locale?: unknown };
    if (!('locale' in body)) throw new BadRequestError('locale is required');

    // A tag the interface cannot render is refused rather than stored. Storing
    // it would leave the user on a language that silently falls back forever.
    const tag = canonicalLocale(body.locale);
    if (!tag) throw new BadRequestError('Unsupported locale');

    await prisma.user.update({ where: { id: req.user!.id }, data: { locale: tag } });
    // The authenticated identity is cached for a few seconds; drop this user's
    // entry so the next request sees the new language immediately rather than
    // at the end of the TTL.
    forgetIdentity(req.user!.id);

    return sendSuccess(res, { locale: tag });
  } catch (err) { return next(err); }
}

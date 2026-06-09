// Familista — Active-context controller (Phase A)

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/context.service';
import { sendSuccess } from '../utils/response';
import { BadRequestError } from '../utils/errors';
import { prisma } from '../config/database';
import { getActiveMembershipsForUser } from '../services/membership.service';

const switchSchema = z.object({
  body: z.object({
    clubId: z.string().uuid(),
    teamId: z.string().uuid().nullable().optional(),
  }),
});

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

export async function getMe(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = await svc.getContext(req.user!.id);
    return sendSuccess(res, ctx);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMP DIAGNOSTIC — GET /api/v1/me/_diag
// ─────────────────────────────────────────────────────────────────────────────
// Read-only. Scoped to the calling user. Surfaces exactly what the DB holds
// for the JWT identity, so we can tell whether a newly-created club +
// membership actually committed. Optional ?name=BSC%20Marzahn looks up Club
// rows by case-insensitive substring (no cross-tenant member data leaked —
// only id/name/city/country/createdAt of the matching Club rows).
// Remove once the multi-club picker bug is closed out.
export async function getDiag(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const nameRaw = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    const nameQuery = nameRaw.slice(0, 120); // bound the query length

    const [user, allMyMemberships, activeMemberships, clubsByName] = await Promise.all([
      prisma.user.findUnique({
        where:  { id: userId },
        select: {
          id: true, email: true, role: true,
          clubId: true, currentClubId: true, currentTeamId: true,
          createdAt: true,
        },
      }),
      // EVERY membership for this user — no isActive filter — so we can
      // see whether the row was written but flagged inactive.
      prisma.membership.findMany({
        where:  { userId },
        select: {
          id: true, userId: true, clubId: true, teamId: true,
          role: true, isActive: true, joinedAt: true, leftAt: true,
          createdAt: true, updatedAt: true,
          club: { select: { id: true, name: true, shortName: true, createdAt: true } },
        },
        orderBy: { joinedAt: 'desc' },
      }),
      // Exactly what /me/context calls under the hood.
      getActiveMembershipsForUser(userId),
      // Look up Club rows by partial name (bounded). Only fires when
      // ?name=... is supplied. Returns just identifiers + timestamps.
      nameQuery
        ? prisma.club.findMany({
            where:  { name: { contains: nameQuery, mode: 'insensitive' } },
            select: { id: true, name: true, shortName: true, city: true, country: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take:    10,
          })
        : Promise.resolve([] as Array<{ id: string; name: string; shortName: string | null; city: string; country: string; createdAt: Date }>),
    ]);

    return sendSuccess(res, {
      jwtUserId:                   userId,
      user,
      allMembershipsForThisUser:   allMyMemberships,
      activeMemberships,
      activeMembershipCount:       activeMemberships.length,
      activeMembershipClubIds:     activeMemberships.map((m) => m.club.id),
      clubsByName:                 clubsByName,
      clubsByNameCount:            clubsByName.length,
      nameQuery:                   nameQuery || null,
    });
  } catch (err) { return next(err); }
}

export async function switchMe(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = switchSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const xff = req.headers['x-forwarded-for'];
    const ip  = typeof xff === 'string' ? xff.split(',')[0]?.trim() : req.ip;
    const ctx = await svc.switchContext(
      { userId: req.user!.id, ipAddress: ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null },
      parsed.data.body.clubId,
      parsed.data.body.teamId ?? null,
    );
    return sendSuccess(res, ctx, 'Context updated');
  } catch (err) { return next(err); }
}

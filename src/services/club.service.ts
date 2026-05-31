// Familista — Club System service (Phase R)
// Reads/writes the existing Club model + its 1:1 WhiteLabelConfig (brand).
// Logo + colors live ONLY in WhiteLabelConfig (no duplication on Club).

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface ClubBrand {
  logoUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
}

export interface ClubProfile {
  id: string;
  name: string;
  shortName: string | null;
  emblem: string | null;
  description: string | null;
  founded: Date | null;
  stadium: string | null;
  capacity: number | null;
  city: string | null;
  country: string | null;
  addressLine: string | null;
  region: string | null;
  postalCode: string | null;
  level: number;
  overallRating: number;
  leaguePosition: number | null;
  fanClub: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  socialLinks: unknown;
  branding: ClubBrand;
}

// Fields the PATCH endpoint may write onto Club (after validation upstream).
export interface ClubCorePatch {
  name?: string;
  shortName?: string | null;
  description?: string | null;
  founded?: Date | null;
  stadium?: string | null;
  capacity?: number | null;
  city?: string;
  country?: string;
  addressLine?: string | null;
  region?: string | null;
  postalCode?: string | null;
  level?: number;
  overallRating?: number;
  leaguePosition?: number | null;
  fanClub?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  websiteUrl?: string | null;
  socialLinks?: Record<string, string> | null;
}

// Fields the PATCH endpoint may write onto WhiteLabelConfig (brand).
export interface ClubBrandPatch {
  logoUrl?: string | null;
  logoDarkUrl?: string | null;
  faviconUrl?: string | null;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
}

// Phase-R fields are typed OPTIONAL here so the mapping never breaks if the
// generated Prisma Client is momentarily out of sync and omits them — they
// simply default to null.
function toProfile(club: {
  id: string; name: string; shortName: string | null; emblem: string | null;
  founded: Date | null; stadium: string | null;
  capacity: number | null; city: string | null; country: string | null;
  level: number; overallRating: number; leaguePosition: number | null;
  fanClub: string | null;
  description?: string | null; addressLine?: string | null; region?: string | null;
  postalCode?: string | null; contactEmail?: string | null; contactPhone?: string | null;
  websiteUrl?: string | null; socialLinks?: unknown;
  whiteLabel: {
    logoUrl: string | null; logoDarkUrl: string | null; faviconUrl: string | null;
    primaryColor: string | null; secondaryColor: string | null; accentColor: string | null;
  } | null;
}): ClubProfile {
  return {
    id: club.id,
    name: club.name,
    shortName: club.shortName,
    emblem: club.emblem,
    description: club.description ?? null,
    founded: club.founded,
    stadium: club.stadium,
    capacity: club.capacity,
    city: club.city,
    country: club.country,
    addressLine: club.addressLine ?? null,
    region: club.region ?? null,
    postalCode: club.postalCode ?? null,
    level: club.level,
    overallRating: club.overallRating,
    leaguePosition: club.leaguePosition,
    fanClub: club.fanClub,
    contactEmail: club.contactEmail ?? null,
    contactPhone: club.contactPhone ?? null,
    websiteUrl: club.websiteUrl ?? null,
    socialLinks: club.socialLinks ?? null,
    branding: {
      logoUrl: club.whiteLabel?.logoUrl ?? null,
      logoDarkUrl: club.whiteLabel?.logoDarkUrl ?? null,
      faviconUrl: club.whiteLabel?.faviconUrl ?? null,
      primaryColor: club.whiteLabel?.primaryColor ?? null,
      secondaryColor: club.whiteLabel?.secondaryColor ?? null,
      accentColor: club.whiteLabel?.accentColor ?? null,
    },
  };
}

export async function getClubProfile(clubId: string): Promise<ClubProfile> {
  // Bare findUnique — NO field-level `select` and NO relation `include` on Club.
  // Prisma then selects only the Club columns the generated client knows, so the
  // query can NEVER throw "Unknown field `description` for select statement on
  // model Club" even if the deployed client is momentarily out of sync with the
  // schema (the cause of the 500). WhiteLabel brand is read separately (its
  // columns are long-established). Phase-R fields default to null via toProfile
  // until the client includes them. Same safe shape for /clubs/current and
  // /clubs/:id (both call this function). No raw SQL.
  let club;
  try {
    club = await prisma.club.findUnique({ where: { id: clubId } });
  } catch (err) {
    logger.error('[clubs] prisma.club.findUnique failed', {
      clubId,
      name: (err as { name?: string })?.name,
      code: (err as { code?: string })?.code,
      message: (err as Error)?.message,
      commit: process.env.RENDER_GIT_COMMIT || process.env.SOURCE_COMMIT || null,
    });
    throw err;
  }
  if (!club) throw new NotFoundError('Club not found');

  let whiteLabel = null;
  try {
    whiteLabel = await prisma.whiteLabelConfig.findUnique({
      where: { clubId },
      select: {
        logoUrl: true, logoDarkUrl: true, faviconUrl: true,
        primaryColor: true, secondaryColor: true, accentColor: true,
      },
    });
  } catch (_) { /* brand is optional — never fail the profile read on it */ }

  return toProfile({ ...club, whiteLabel } as Parameters<typeof toProfile>[0]);
}

export async function updateClubProfile(
  clubId: string,
  core: ClubCorePatch,
  brand: ClubBrandPatch,
): Promise<ClubProfile> {
  const existing = await prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });
  if (!existing) throw new NotFoundError('Club not found');

  // Build the writes as independent operations and run them in a BATCH
  // transaction — prisma.$transaction([...]). The interactive form
  // ($transaction(async (tx) => …)) fails with P2028 on transaction-mode
  // connection poolers (e.g. Neon's -pooler endpoint), which is exactly the
  // production setup here; the batch form is pooler-safe and still atomic.
  const ops: Prisma.PrismaPromise<unknown>[] = [];

  // Split the patch: columns the (possibly stale) generated client models go
  // through prisma.club.update; the Phase-R columns are written with raw,
  // PARAMETERIZED SQL so they persist even when the deployed client doesn't yet
  // know them (which otherwise throws "Unknown argument `description`"). The
  // columns exist in the DB (migration 20260531000000_club_profile_fields).
  const PHASE_R = new Set(['description', 'addressLine', 'region', 'postalCode', 'contactEmail', 'contactPhone', 'websiteUrl', 'socialLinks']);
  const known: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(core)) {
    if (PHASE_R.has(k)) extra[k] = v; else known[k] = v;
  }

  if (Object.keys(known).length > 0) {
    ops.push(prisma.club.update({ where: { id: clubId }, data: known as Prisma.ClubUpdateInput }));
  }

  const sets: Prisma.Sql[] = [];
  if ('description'  in extra) sets.push(Prisma.sql`"description"  = ${(extra.description  ?? null) as string | null}`);
  if ('addressLine'  in extra) sets.push(Prisma.sql`"addressLine"  = ${(extra.addressLine  ?? null) as string | null}`);
  if ('region'       in extra) sets.push(Prisma.sql`"region"       = ${(extra.region       ?? null) as string | null}`);
  if ('postalCode'   in extra) sets.push(Prisma.sql`"postalCode"   = ${(extra.postalCode   ?? null) as string | null}`);
  if ('contactEmail' in extra) sets.push(Prisma.sql`"contactEmail" = ${(extra.contactEmail ?? null) as string | null}`);
  if ('contactPhone' in extra) sets.push(Prisma.sql`"contactPhone" = ${(extra.contactPhone ?? null) as string | null}`);
  if ('websiteUrl'   in extra) sets.push(Prisma.sql`"websiteUrl"   = ${(extra.websiteUrl   ?? null) as string | null}`);
  if ('socialLinks'  in extra) {
    const sl = extra.socialLinks;
    sets.push(Prisma.sql`"socialLinks" = ${sl == null ? null : JSON.stringify(sl)}::jsonb`);
  }
  if (sets.length > 0) {
    ops.push(prisma.$executeRaw(Prisma.sql`UPDATE "Club" SET ${Prisma.join(sets, ', ')} WHERE "id" = ${clubId}`));
  }

  if (Object.keys(brand).length > 0) {
    ops.push(
      prisma.whiteLabelConfig.upsert({
        where: { clubId },
        create: { clubId, ...brand },
        update: brand,
      }),
    );
  }

  if (ops.length > 0) await prisma.$transaction(ops);

  return getClubProfile(clubId);
}

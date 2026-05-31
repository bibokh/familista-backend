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
  // ROOT CAUSE of the 500: the typed `select: { description: true, … }` throws
  // "Unknown field `description` for select statement on model Club" — a Prisma
  // CLIENT validation error (raised before SQL) that means the generated client
  // is out of sync with the schema. Using `include` with NO field-level Club
  // `select` makes Prisma select exactly the columns the client knows, so it
  // never references an unknown field; Phase-R columns are returned once the
  // client includes them, and default to null until then. This is standard
  // Prisma (no raw SQL).
  let club;
  try {
    club = await prisma.club.findUnique({
      where: { id: clubId },
      include: {
        whiteLabel: {
          select: {
            logoUrl: true, logoDarkUrl: true, faviconUrl: true,
            primaryColor: true, secondaryColor: true, accentColor: true,
          },
        },
      },
    });
  } catch (err) {
    // TEMP diagnostic (Club read path only).
    logger.error('[clubs] prisma.club.findUnique failed', {
      clubId,
      name: (err as { name?: string })?.name,
      code: (err as { code?: string })?.code,
      message: (err as Error)?.message,
      stack: (err as Error)?.stack,
      commit: process.env.RENDER_GIT_COMMIT || process.env.SOURCE_COMMIT || null,
    });
    throw err;
  }
  if (!club) throw new NotFoundError('Club not found');
  return toProfile(club as Parameters<typeof toProfile>[0]);
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

  if (Object.keys(core).length > 0) {
    // Nullable JSON column needs Prisma.JsonNull, not literal null.
    const { socialLinks, ...rest } = core;
    const data: Prisma.ClubUpdateInput = { ...rest };
    if (socialLinks !== undefined) {
      data.socialLinks = socialLinks === null ? Prisma.JsonNull : (socialLinks as Prisma.InputJsonValue);
    }
    ops.push(prisma.club.update({ where: { id: clubId }, data }));
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

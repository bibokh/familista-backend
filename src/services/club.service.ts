// Familista — Club System service (Phase R)
// Reads/writes the existing Club model + its 1:1 WhiteLabelConfig (brand).
// Logo + colors live ONLY in WhiteLabelConfig (no duplication on Club).

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';

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

// The Phase-R Club-profile columns exist in production (migration
// 20260531000000_club_profile_fields) and the Prisma Client is regenerated
// from prisma/schema.prisma at startup, so the service reads/writes them fully.
function toProfile(club: {
  id: string; name: string; shortName: string | null; emblem: string | null;
  description: string | null; founded: Date | null; stadium: string | null;
  capacity: number | null; city: string | null; country: string | null;
  addressLine: string | null; region: string | null; postalCode: string | null;
  level: number; overallRating: number; leaguePosition: number | null;
  fanClub: string | null; contactEmail: string | null; contactPhone: string | null;
  websiteUrl: string | null; socialLinks: unknown;
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
    description: club.description,
    founded: club.founded,
    stadium: club.stadium,
    capacity: club.capacity,
    city: club.city,
    country: club.country,
    addressLine: club.addressLine,
    region: club.region,
    postalCode: club.postalCode,
    level: club.level,
    overallRating: club.overallRating,
    leaguePosition: club.leaguePosition,
    fanClub: club.fanClub,
    contactEmail: club.contactEmail,
    contactPhone: club.contactPhone,
    websiteUrl: club.websiteUrl,
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
  // Read the Club row via raw SQL so this endpoint NEVER depends on whether the
  // deployed Prisma Client recognises the Phase-R columns. Those columns exist
  // in the DB (migration 20260531000000_club_profile_fields); the generated
  // client on the live host did not include them, which made the typed
  // findUnique({ select: { description: true, … } }) throw
  // "Invalid prisma.club.findUnique() invocation". $queryRaw bypasses the
  // client's field validation entirely.
  const rows = await prisma.$queryRaw<Array<{
    id: string; name: string; shortName: string | null; emblem: string | null;
    description: string | null; founded: Date | null; stadium: string | null;
    capacity: number | null; city: string | null; country: string | null;
    addressLine: string | null; region: string | null; postalCode: string | null;
    level: number; overallRating: number; leaguePosition: number | null;
    fanClub: string | null; contactEmail: string | null; contactPhone: string | null;
    websiteUrl: string | null; socialLinks: unknown;
  }>>(Prisma.sql`
    SELECT "id", "name", "shortName", "emblem", "description", "founded",
           "stadium", "capacity", "city", "country", "addressLine", "region",
           "postalCode", "level", "overallRating", "leaguePosition", "fanClub",
           "contactEmail", "contactPhone", "websiteUrl", "socialLinks"
    FROM "Club" WHERE "id" = ${clubId} LIMIT 1
  `);
  if (!rows.length) throw new NotFoundError('Club not found');
  const c = rows[0];

  // WhiteLabelConfig columns are long-established — safe to read via the client.
  const whiteLabel = await prisma.whiteLabelConfig.findUnique({
    where: { clubId },
    select: {
      logoUrl: true, logoDarkUrl: true, faviconUrl: true,
      primaryColor: true, secondaryColor: true, accentColor: true,
    },
  });

  return toProfile({ ...c, whiteLabel });
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

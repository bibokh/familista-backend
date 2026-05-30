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

function toProfile(club: {
  id: string; name: string; shortName: string | null; emblem: string | null;
  founded: Date | null; stadium: string | null;
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
    // `description` column is not present on the production Club table — do not
    // read it (avoids Prisma referencing a non-existent column). Always null.
    description: null,
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
  // Explicit select (NOT include) so Prisma never references the `description`
  // column, which is absent on the production Club table.
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      id: true, name: true, shortName: true, emblem: true,
      founded: true, stadium: true, capacity: true, city: true, country: true,
      addressLine: true, region: true, postalCode: true, level: true,
      overallRating: true, leaguePosition: true, fanClub: true,
      contactEmail: true, contactPhone: true, websiteUrl: true, socialLinks: true,
      whiteLabel: {
        select: {
          logoUrl: true, logoDarkUrl: true, faviconUrl: true,
          primaryColor: true, secondaryColor: true, accentColor: true,
        },
      },
    },
  });
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
    // `description` column is absent on the production Club table — never write it.
    delete (data as Record<string, unknown>).description;
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

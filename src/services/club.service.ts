// Familista — Club System service (Phase R)
// Reads/writes the Club model + its 1:1 WhiteLabelConfig (brand).
// Logo + colors live ONLY in WhiteLabelConfig (no duplication on Club).
// Pure Prisma — schema is the single source of truth.

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
  socialLinks: Prisma.JsonValue;
  branding: ClubBrand;
}

// Fields the PATCH endpoint may write onto Club. TEMP emergency scope: only
// `name` — advanced profile fields are removed from the writable payload.
export interface ClubCorePatch {
  name?: string;
}

// Fields the PATCH endpoint may write onto WhiteLabelConfig (brand). TEMP
// emergency scope: logo + 3 colors only (logoDark / favicon removed).
export interface ClubBrandPatch {
  logoUrl?: string | null;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
}

const clubWithBrand = Prisma.validator<Prisma.ClubDefaultArgs>()({
  include: { whiteLabel: true },
});
type ClubWithBrand = Prisma.ClubGetPayload<typeof clubWithBrand>;

function toProfile(club: ClubWithBrand): ClubProfile {
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
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    include: { whiteLabel: true },
  });
  if (!club) throw new NotFoundError('Club not found');
  return toProfile(club);
}

export async function updateClubProfile(
  clubId: string,
  core: ClubCorePatch,
  brand: ClubBrandPatch,
): Promise<ClubProfile> {
  const existing = await prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });
  if (!existing) throw new NotFoundError('Club not found');

  const ops: Prisma.PrismaPromise<unknown>[] = [];

  if (Object.keys(core).length > 0) {
    const data: Prisma.ClubUpdateInput = { ...core };
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

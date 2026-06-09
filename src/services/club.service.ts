// Familista — Club System service (Phase R)
// Reads/writes the Club model + its 1:1 WhiteLabelConfig (brand).
// Logo + colors live ONLY in WhiteLabelConfig (no duplication on Club).
// Pure Prisma — schema is the single source of truth.

import { Prisma, MembershipRole } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ConflictError } from '../utils/errors';

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

// ─────────────────────────────────────────────────────────────────────────────
// Club onboarding (POST /clubs)
// ─────────────────────────────────────────────────────────────────────────────
// Creates a new Club row and, in the same transaction, grants the caller a
// CLUB_OWNER Membership so the club appears in /me/context.availableClubs
// immediately on the next refresh. No subscription/billing artefacts are
// provisioned — the row starts in the schema's default TRIALING / BASIC state.

export interface CreateClubInput {
  name: string;
  city: string;
  shortName?: string | null;
  country?: string | null;
  emblem?: string | null;
}

export interface CreateClubResult {
  clubId: string;
  membershipId: string;
  profile: ClubProfile;
}

export async function createClubWithOwnerMembership(
  input: CreateClubInput,
  ownerUserId: string,
): Promise<CreateClubResult> {
  // Defence in depth — controller already validates with zod, but the service
  // is callable from internal code paths too.
  const name = input.name.trim();
  const city = input.city.trim();
  if (!name) throw new ConflictError('Club name is required');
  if (!city) throw new ConflictError('Club city is required');

  // Reject duplicate name within the caller's own membership set — prevents a
  // single user from accidentally double-creating the same club. Cross-user
  // duplicates are allowed because two different owners may genuinely run
  // clubs that share a name (e.g. "FC Real Madrid Berlin").
  const dup = await prisma.club.findFirst({
    where: {
      name,
      memberships: { some: { userId: ownerUserId, isActive: true } },
    },
    select: { id: true },
  });
  if (dup) throw new ConflictError('You already own a club with that name');

  // TEMP DIAGNOSTIC — logs appear in Render service logs. Remove once the
  // multi-club picker bug is closed out.
  // eslint-disable-next-line no-console
  console.log('[clubs.create] START', { ownerUserId, name, city });

  const { clubId, membershipId } = await prisma.$transaction(async (tx) => {
    const club = await tx.club.create({
      data: {
        name,
        city,
        shortName: input.shortName?.trim() || null,
        country:   input.country?.trim()   || 'Germany',
        emblem:    input.emblem?.trim()    || null,
      },
      select: { id: true },
    });
    // eslint-disable-next-line no-console
    console.log('[clubs.create] CLUB_INSERTED', { clubId: club.id, name });

    const membership = await tx.membership.create({
      data: {
        userId:   ownerUserId,
        clubId:   club.id,
        teamId:   null,
        role:     MembershipRole.CLUB_OWNER,
        isActive: true,
      },
      select: { id: true, userId: true, clubId: true, isActive: true },
    });
    // eslint-disable-next-line no-console
    console.log('[clubs.create] MEMBERSHIP_INSERTED', {
      membershipId: membership.id,
      userId:       membership.userId,
      clubId:       membership.clubId,
      isActive:     membership.isActive,
    });

    return { clubId: club.id, membershipId: membership.id };
  });

  // eslint-disable-next-line no-console
  console.log('[clubs.create] COMMITTED', { clubId, membershipId, ownerUserId });

  return {
    clubId,
    membershipId,
    profile: await getClubProfile(clubId),
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

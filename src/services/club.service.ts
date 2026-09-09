// Familista — Club System service (Phase R)
// Reads/writes the Club model + its 1:1 WhiteLabelConfig (brand).
// Logo + colors live ONLY in WhiteLabelConfig (no duplication on Club).
// Pure Prisma — schema is the single source of truth.

import { Prisma, ClubLifecycle } from '@prisma/client';
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
  // The club crest. One image, held on the club, inherited by every team.
  crestUrl: string | null;
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
  // The crest is club data, not brand chrome: it identifies the football club
  // on every screen, where WhiteLabelConfig.logoUrl brands the product for a
  // white-label deployment. They are deliberately separate columns.
  crestUrl?: string | null;
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
    crestUrl: club.crestUrl,
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
// Creates a new Club row and GRANTS THE CALLER NOTHING.
//
// It used to grant the caller a CLUB_OWNER membership in the same transaction,
// so that the club appeared in their own `availableClubs`. That one line is
// where Familista's identity model came apart: the platform owner onboards
// clubs, so the platform owner ended up president of every club they onboarded
// — four of them in production — and every screen that names somebody's role
// then had to choose between "Platform Owner" and "President" for the same
// person. Convenience for the creator, paid for by the club's own identity.
//
// A club is created PENDING_SETUP: it exists, nobody owns it, and it waits for
// a real person to be invited as CLUB_OWNER and to accept. The platform owner
// reaches it meanwhile through platform authority, which is what platform
// authority is for, and no membership is invented to stand in for it.
//
// No subscription/billing artefacts are provisioned — the row starts in the
// schema's default TRIALING / BASIC state.

export interface CreateClubInput {
  name: string;
  city: string;
  shortName?: string | null;
  country?: string | null;
  emblem?: string | null;
}

export interface CreateClubResult {
  clubId: string;
  /**
   * Always null. Kept in the shape so the response contract does not change
   * under existing clients, and named so that a reader looking for where the
   * creator's membership went finds this comment rather than a missing field.
   */
  membershipId: null;
  /** PENDING_SETUP: the club has no president and cannot be run yet. */
  lifecycle: ClubLifecycle;
  profile: ClubProfile;
}

export async function createClubAwaitingPresident(
  input: CreateClubInput,
  creatorUserId: string,
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
      memberships: { some: { userId: creatorUserId, isActive: true } },
    },
    select: { id: true },
  });
  if (dup) throw new ConflictError('You already own a club with that name');

  // One statement, and deliberately no membership.create anywhere in this
  // function. `tests/identity-separation.unit.test.ts` reads this file and
  // fails if one comes back.
  const club = await prisma.club.create({
    data: {
      name,
      city,
      shortName: input.shortName?.trim() || null,
      country:   input.country?.trim()   || 'Germany',
      emblem:    input.emblem?.trim()    || null,
      // Explicit, and the point of the whole function: the club exists and is
      // awaiting a president. The schema's default is not relied on.
      lifecycle: ClubLifecycle.PENDING_SETUP,
    },
    select: { id: true },
  });

  return {
    clubId: club.id,
    membershipId: null,
    lifecycle: ClubLifecycle.PENDING_SETUP,
    profile: await getClubProfile(club.id),
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

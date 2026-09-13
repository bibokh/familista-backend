// Who did it, and where — for telemetry, from the canonical authority
// ─────────────────────────────────────────────────────────────────────────────
// A telemetry row carries two dimensions that are about a PERSON rather than an
// interaction: which identity acted, and which tenant it happened in. Both were
// wrong, and both were wrong for the same underlying reason — they were read
// from whatever the session happened to be carrying rather than resolved from
// the authority that owns the answer.
//
// ── WHAT WENT WRONG, EXACTLY
//
// `platformRole` was `req.user.role`. That is `User.role`, the ACCOUNT column
// that predates memberships and predates `PlatformAdmin`. This platform's owner
// holds `User.role = CLUB_ADMIN` — because the account was created before the
// platform-authority model existed and the column was never migrated, exactly
// as intended: `access-levels.ts` says renaming it would be a destructive
// migration bought for nothing. So every event the platform owner generated was
// stamped `CLUB_ADMIN`, including events inside SYSTEM, where no club role
// means anything at all.
//
// `clubId` was whatever `State.context.clubId` still held. Entering a club sets
// it; opening SYSTEM does not clear it, and should not — the reader's club
// context is theirs and a telemetry concern must never mutate it. So SYSTEM
// activity was attributed to the last club visited.
//
// ── THE RULE
//
// Identity comes from the canonical authority — `isPlatformOwner`, already
// resolved for every request by `authenticate` from `SUPER_ADMIN` or an active
// `PlatformAdmin` row — and from live `Membership` rows for everyone else.
// Never from `User.role`.
//
// Scope comes from the WORKSPACE the interaction happened in, which the event
// itself names in `module`. A global surface carries no tenant, whoever is
// looking at it and whatever club they were in a minute ago.
//
// ── THIS IS NOT AN AUTHORIZATION SURFACE
//
// Nothing here grants, denies or widens anything. It decides what two columns
// of an analytics row say. It reads memberships and it reads a flag the request
// already resolved; it writes nothing, and a wrong answer here mislabels a
// chart rather than opening a door. The guards are `assertPlatformOwner` and
// the middleware, unchanged and untouched.

import { prisma } from '../../config/database';

/** Where an interaction happened, at the only grain telemetry cares about. */
export type TelemetryScope = 'GLOBAL' | 'CLUB';

export interface TelemetryContext {
  /**
   * The identity that acted, as this platform's canonical vocabulary spells it.
   *
   * `PLATFORM_OWNER` for platform authority; a `MembershipRole` for somebody
   * acting inside a club they belong to; `VIEWER` when neither applies.
   */
  actorIdentity: string;
  scope: TelemetryScope;
  clubId: string | null;
  teamId: string | null;
}

/**
 * The club workspaces, mirrored from `_ALLOWED_PAGES` in `public/app.js`.
 *
 * These eleven are the only modules whose activity belongs to a tenant.
 * Everything else — SYSTEM, the eight platform pages, Owner Home, the clubs
 * picker — is the platform's own surface and carries no club, which is why the
 * list is of CLUB modules and not of global ones: a module nobody has
 * classified yet is treated as global and loses a dimension, rather than
 * treated as club-scoped and attributed to the wrong tenant.
 *
 * `tests/telemetry-actor-context.unit.test.ts` pins this against the page
 * allow-list, so a new club workspace cannot be added on one side only.
 */
export const CLUB_MODULES: ReadonlySet<string> = new Set([
  'club-home', 'squad', 'training', 'training-centre', 'academy', 'academy-team',
  'video-intelligence', 'transfers', 'coach-market', 'coaches',
  'familista-league', 'match-center', 'people-access', 'settings',
]);

/**
 * Which of the two a module is.
 *
 * The module key is the authority and the route is the fallback, because a
 * module is what the reader is IN and a route can lag a client-side navigation
 * by a frame. An event naming neither is global: an interaction that cannot say
 * which club workspace it happened in did not happen in one.
 */
export function scopeOfModule(module?: string | null, route?: string | null): TelemetryScope {
  const key = String(module ?? '').trim();
  if (key) return CLUB_MODULES.has(key) ? 'CLUB' : 'GLOBAL';

  const path = String(route ?? '').trim();
  if (path) {
    const first = path.split('/').filter(Boolean)[0];
    if (first && CLUB_MODULES.has(first)) return 'CLUB';
  }
  return 'GLOBAL';
}

/**
 * Which membership role speaks for somebody holding several in one club.
 *
 * A head coach who is also an analyst is reported as a head coach: the senior
 * role is the one that describes what they are doing there. Precedence, not
 * alphabetical order, and not "the first row the database returned" — which
 * would make the same person's telemetry unstable across requests.
 */
const ROLE_PRECEDENCE: readonly string[] = [
  'CLUB_OWNER', 'CLUB_ADMIN', 'HEAD_COACH', 'TECHNICAL_COACH', 'TACTICAL_COACH',
  'ASSISTANT_COACH', 'GOALKEEPING_COACH', 'FITNESS_COACH', 'PERFORMANCE_COACH',
  'YOUTH_COACH', 'ANALYST', 'SCOUT', 'MEDICAL_STAFF', 'PHYSIO',
  'FINANCE_MANAGER', 'PARENT', 'PLAYER', 'DEVICE',
];

export function strongestRole(roles: readonly string[]): string | null {
  for (const candidate of ROLE_PRECEDENCE) if (roles.includes(candidate)) return candidate;
  return roles.length ? String(roles[0]) : null;
}

export interface TelemetryActor {
  userId?: string | null;
  /**
   * Platform authority as `authenticate` resolved it — `SUPER_ADMIN` on the
   * account, or an active `PlatformAdmin` row. This is the canonical answer and
   * the ONLY thing that makes somebody a platform owner here.
   */
  isPlatformOwner?: boolean;
}

export interface TelemetryClaim {
  module?: string | null;
  route?: string | null;
  /** What the client said. Believed only where it can be corroborated. */
  clubId?: string | null;
  teamId?: string | null;
}

/**
 * A resolver for one batch, so a batch costs one query rather than fifty.
 *
 * Every event in a request shares an actor and almost always a club, so the
 * memberships are read once per distinct club and reused. The cache lives for
 * the batch and dies with it — a membership revoked between two requests
 * changes the next answer, which is the property the access model rests on and
 * is not worth breaking for a chart.
 */
export function telemetryContextResolver(actor: TelemetryActor) {
  const byClub = new Map<string, Promise<string[]>>();

  const rolesIn = (clubId: string): Promise<string[]> => {
    const hit = byClub.get(clubId);
    if (hit) return hit;
    // Wrapped, not just `.catch`-ed: a deployment without the membership table,
    // or a caller whose client does not expose it, must lose a DIMENSION and
    // never an event. Telemetry sits behind `track`, which product code calls
    // without awaiting an outcome, so a throw here would be a throw in the
    // middle of somebody's save.
    let query: Promise<string[]>;
    try {
      query = prisma.membership
        .findMany({
          where: { userId: String(actor.userId), clubId, isActive: true },
          select: { role: true },
        })
        .then((rows: Array<{ role: string }>) => rows.map((r) => String(r.role)))
        .catch(() => [] as string[]);
    } catch {
      query = Promise.resolve([] as string[]);
    }
    byClub.set(clubId, query);
    return query;
  };

  return async function resolve(claim: TelemetryClaim): Promise<TelemetryContext> {
    const scope = scopeOfModule(claim.module, claim.route);
    const owner = actor.isPlatformOwner === true;

    // ── a global surface carries no tenant ────────────────────────────────
    // Before anything else, and regardless of who is looking: SYSTEM is not a
    // club's screen, so nothing that happens there belongs to a club. The
    // reader's own club context is untouched — this decides what the ROW says.
    if (scope === 'GLOBAL') {
      return {
        actorIdentity: owner ? 'PLATFORM_OWNER' : 'VIEWER',
        scope,
        clubId: null,
        teamId: null,
      };
    }

    const claimedClub = claim.clubId ? String(claim.clubId) : null;
    if (!claimedClub) {
      // A club module with no club named is not club activity yet — a workspace
      // mid-hydration, most often. Global rather than guessed.
      return { actorIdentity: owner ? 'PLATFORM_OWNER' : 'VIEWER', scope: 'GLOBAL', clubId: null, teamId: null };
    }

    // ── platform authority, inside a club ─────────────────────────────────
    // The owner is reported as the platform, in the club they are looking at.
    // They hold no membership there and are never described as holding one:
    // that separation is the whole point of `access-levels.ts`, and telemetry
    // is not the place to quietly undo it.
    if (owner) {
      return {
        actorIdentity: 'PLATFORM_OWNER',
        scope: 'CLUB',
        clubId: claimedClub,
        teamId: claim.teamId ? String(claim.teamId) : null,
      };
    }

    // ── everybody else, from live membership rows ─────────────────────────
    // The claimed club is corroborated rather than trusted. A session whose
    // stored context names a club this person has no membership in produces no
    // tenant attribution at all — which is a missing dimension, where believing
    // it would be one tenant's activity recorded against another's.
    if (!actor.userId) {
      return { actorIdentity: 'VIEWER', scope: 'GLOBAL', clubId: null, teamId: null };
    }
    const roles = await rolesIn(claimedClub);
    const role = strongestRole(roles);
    if (!role) {
      return { actorIdentity: 'VIEWER', scope: 'GLOBAL', clubId: null, teamId: null };
    }
    return {
      actorIdentity: role,
      scope: 'CLUB',
      clubId: claimedClub,
      teamId: claim.teamId ? String(claim.teamId) : null,
    };
  };
}

/** One event's context, for a caller that has only one. */
export async function resolveTelemetryContext(
  actor: TelemetryActor,
  claim: TelemetryClaim,
): Promise<TelemetryContext> {
  return telemetryContextResolver(actor)(claim);
}

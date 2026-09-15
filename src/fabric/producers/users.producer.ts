// The Users domain, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// The first domain migrated onto `publishFabricEvent`. Everything here is the
// pattern the other domains will follow, so it is worth saying plainly what the
// pattern IS:
//
//   · the domain's event types and their payload schemas are registered here,
//     at module load, and nowhere else;
//   · the domain's services import a NAMED helper from this file and call it
//     after their transaction has committed;
//   · nothing in the Live Data Flow page, the pulse service or the routes is
//     touched, now or when a Users feature is added later.
//
// TYPED ARGUMENTS, NOT A PAYLOAD BAG
//
// Every helper below takes explicit parameters and BUILDS its payload. None of
// them accepts a `Record<string, unknown>`, so there is no call site at which a
// caller can hand this module an email address, a password hash, a token, a
// street or a child's date of birth. That is the real boundary — a type the
// compiler enforces — and the schemas below are the second line rather than
// the first.
//
// The schemas are `strict()`, unlike `core-schemas.ts` where `passthrough()` is
// correct. The difference is deliberate: those schemas were laid over producers
// that already existed and had to tolerate whatever the producers already sent.
// These producers are written today, so an unknown key means somebody added a
// field, and the right response to somebody adding a field to an identity event
// is to fail validation and quarantine it rather than let it through.
//
// WHAT AN ENVELOPE CARRIES AND WHAT THE BOARD SEES
//
// The envelope carries the club, the team, the actor and the subject — the
// subject of a Users event being a person. `project()` withholds a USER or
// MEMBERSHIP subjectId from the monitoring frame entirely (it is not in
// `SAFE_SUBJECT_IDS`), so the board learns that a user event happened in a
// club, and never which person it was about. The payloads here are therefore
// enum tokens, booleans and FIELD NAMES — never a field's value.
//
// PUBLISHING NEVER FAILS A LOGIN
//
// Every helper is fire-and-forget through `publishFabricEventDetached`. A
// person must not fail to log in because an event could not be recorded, and a
// membership must not fail to be granted because the outbox was slow. The
// publisher already resolves rather than rejecting on every observability
// failure; the detached call is the second guarantee, that the caller does not
// even wait.

import { z } from 'zod';
import { registerFabricEvent } from '../registry/event-registry';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';
import type { EventSourceType } from '../event-envelope';

/** The source every event in this file belongs to. Registered in `source-registry`. */
export const USERS_SOURCE_ID = 'users';

// ── the event types ──────────────────────────────────────────────────────────
//
// `membership.granted`, `membership.changed` and `membership.revoked` are NOT
// registered here: they are already in `event-taxonomy.ts` and registering them
// a second time with different settings would be refused, correctly. This file
// registers the names the taxonomy does not already carry.
//
// All of them are CONFIDENTIAL. Every one is about an identified person, which
// is the same reason `membership.granted` has always been CONFIDENTIAL, and
// failing toward more private is the direction to fail in.

/** Field NAMES that changed. Never values — see the module note. */
const changedFields = z.array(z.string().min(1).max(40)).min(1).max(24);

/** A role token from the schema's own enums. Not free text. */
const roleToken = z.string().min(1).max(40);

export function registerUsersProducer(): void {
  registerFabricEvent({
    type: 'user.created',
    describes: 'An account was created',
    classification: 'CONFIDENTIAL',
    entityType: 'USER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'user.created', version: 1,
    describes: 'The account role it was created with, and whether an invitation named it',
    schema: z.object({ accountRole: roleToken, invited: z.boolean() }).strict(),
  });

  registerFabricEvent({
    type: 'user.updated',
    describes: 'An account record changed',
    classification: 'CONFIDENTIAL',
    entityType: 'USER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'user.updated', version: 1,
    describes: 'Which account fields changed, by name',
    schema: z.object({ changedFields }).strict(),
  });

  registerFabricEvent({
    type: 'user.profile.updated',
    describes: 'A person changed something about how they appear or how the interface behaves',
    classification: 'CONFIDENTIAL',
    entityType: 'USER',
  });
  registerFabricSchema({
    eventType: 'user.profile.updated', version: 1,
    describes: 'Which profile fields changed, by name',
    schema: z.object({ changedFields }).strict(),
  });

  // Registered, and deliberately without a producer. Nothing in Familista
  // changes `User.role` today — an account's role is set when the account is
  // created and the only role that moves afterwards is the MEMBERSHIP role,
  // which is `access.role.changed` below. The name exists so the day that path
  // is built it has a contract waiting, and until then the event catalogue
  // says the type is registered and the metrics say nothing has ever produced
  // one. That is the honest picture. Inventing a producer for it would not be.
  registerFabricEvent({
    type: 'user.role.changed',
    describes: "An account's own role changed — no producer in this build",
    classification: 'CONFIDENTIAL',
    entityType: 'USER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'user.role.changed', version: 1,
    describes: 'The role token before and after',
    schema: z.object({ from: roleToken, to: roleToken }).strict(),
  });

  registerFabricEvent({
    type: 'user.login',
    describes: 'A person authenticated and was issued a session',
    classification: 'CONFIDENTIAL',
    entityType: 'USER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'user.login', version: 1,
    // No address, no user agent, no device fingerprint. An IP is personal data
    // under the GDPR, and a login event is not the place it earns its keep.
    describes: 'How the session was obtained. No address and no user agent',
    schema: z.object({ method: z.enum(['PASSWORD']) }).strict(),
  });

  registerFabricEvent({
    type: 'user.logout',
    describes: 'A session was ended',
    classification: 'CONFIDENTIAL',
    entityType: 'USER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'user.logout', version: 1,
    describes: 'Whether one session ended or all of them',
    schema: z.object({ scope: z.enum(['SESSION', 'ALL_SESSIONS']) }).strict(),
  });

  registerFabricEvent({
    type: 'access.role.changed',
    describes: "A membership's role within a club changed",
    classification: 'CONFIDENTIAL',
    entityType: 'MEMBERSHIP',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'access.role.changed', version: 1,
    // The reason a human typed is NOT here. It is free text, it is written to
    // the membership audit log where it belongs, and free text in an event that
    // reaches an observability surface is free text that reaches an
    // observability surface.
    describes: 'The membership role before and after. Never the reason text',
    schema: z.object({ from: roleToken, to: roleToken }).strict(),
  });

  // The two already in the taxonomy get their payload schemas here, since this
  // is the file that knows what the Users producers send.
  registerFabricSchema({
    eventType: 'membership.granted', version: 1,
    describes: 'The role, whether it is club- or team-scoped, and whether a lapsed one was restored',
    schema: z.object({
      role: roleToken,
      scope: z.enum(['CLUB', 'TEAM']),
      reactivated: z.boolean(),
    }).strict(),
  });

  registerFabricSchema({
    eventType: 'membership.revoked', version: 1,
    describes: 'The role and scope that ended. Never the reason text',
    schema: z.object({ role: roleToken, scope: z.enum(['CLUB', 'TEAM']) }).strict(),
  });
}

registerUsersProducer();

// ── the helpers the Users services call ──────────────────────────────────────
//
// One per event, each taking what the caller already has in hand. Call them
// AFTER the write has committed — see each service's call site for where that
// is. A helper called before a commit would announce something that may yet be
// rolled back, and an event log that can be wrong about whether a thing
// happened is worse than no event log.

/** Who caused it, and in which club. Common to every helper below. */
interface UsersContext {
  /** The person who caused it. Null for a self-service action with no other actor. */
  actorUserId?: string | null;
  /**
   * The tenant, when there is one.
   *
   * Optional and defaulting to null, because some Users events genuinely have
   * no club: a person's interface language is a property of the person, and
   * attaching a club to it would make a personal preference readable as club
   * data. A caller with no club to name simply does not name one.
   */
  clubId?: string | null;
  teamId?: string | null;
  /** What produced it. `USER` for a person acting through the interface. */
  sourceType?: EventSourceType;
}

export function publishUserCreated(
  ctx: UsersContext & { userId: string },
  accountRole: string,
  invited: boolean,
): void {
  publishFabricEventDetached({
    eventType: 'user.created',
    clubId: ctx.clubId ?? null,
    teamId: ctx.teamId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'USER',
    subjectId: ctx.userId,
    sourceType: ctx.sourceType ?? 'USER',
    payload: { accountRole: String(accountRole), invited },
  });
}

export function publishUserUpdated(
  ctx: UsersContext & { userId: string },
  fields: readonly string[],
): void {
  if (!fields.length) return;
  publishFabricEventDetached({
    eventType: 'user.updated',
    clubId: ctx.clubId ?? null,
    teamId: ctx.teamId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'USER',
    subjectId: ctx.userId,
    sourceType: ctx.sourceType ?? 'USER',
    payload: { changedFields: names(fields) },
  });
}

export function publishUserProfileUpdated(
  ctx: UsersContext & { userId: string },
  fields: readonly string[],
): void {
  if (!fields.length) return;
  publishFabricEventDetached({
    eventType: 'user.profile.updated',
    clubId: ctx.clubId ?? null,
    teamId: ctx.teamId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'USER',
    subjectId: ctx.userId,
    sourceType: ctx.sourceType ?? 'USER',
    payload: { changedFields: names(fields) },
  });
}

export function publishUserLogin(ctx: UsersContext & { userId: string }): void {
  publishFabricEventDetached({
    eventType: 'user.login',
    clubId: ctx.clubId ?? null,
    actorUserId: ctx.userId,
    subjectType: 'USER',
    subjectId: ctx.userId,
    sourceType: 'USER',
    payload: { method: 'PASSWORD' },
  });
}

export function publishUserLogout(
  ctx: UsersContext & { userId: string },
  scope: 'SESSION' | 'ALL_SESSIONS' = 'SESSION',
): void {
  publishFabricEventDetached({
    eventType: 'user.logout',
    clubId: ctx.clubId ?? null,
    actorUserId: ctx.userId,
    subjectType: 'USER',
    subjectId: ctx.userId,
    sourceType: 'USER',
    payload: { scope },
  });
}

export function publishMembershipGranted(
  ctx: UsersContext & { membershipId: string },
  role: string,
  scope: 'CLUB' | 'TEAM',
  reactivated: boolean,
): void {
  publishFabricEventDetached({
    eventType: 'membership.granted',
    clubId: ctx.clubId ?? null,
    teamId: ctx.teamId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'MEMBERSHIP',
    subjectId: ctx.membershipId,
    sourceType: ctx.sourceType ?? 'USER',
    payload: { role: String(role), scope, reactivated },
  });
}

export function publishMembershipRevoked(
  ctx: UsersContext & { membershipId: string },
  role: string,
  scope: 'CLUB' | 'TEAM',
): void {
  publishFabricEventDetached({
    eventType: 'membership.revoked',
    clubId: ctx.clubId ?? null,
    teamId: ctx.teamId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'MEMBERSHIP',
    subjectId: ctx.membershipId,
    sourceType: ctx.sourceType ?? 'USER',
    payload: { role: String(role), scope },
  });
}

export function publishAccessRoleChanged(
  ctx: UsersContext & { membershipId: string },
  from: string,
  to: string,
): void {
  publishFabricEventDetached({
    eventType: 'access.role.changed',
    clubId: ctx.clubId ?? null,
    teamId: ctx.teamId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'MEMBERSHIP',
    subjectId: ctx.membershipId,
    sourceType: ctx.sourceType ?? 'USER',
    payload: { from: String(from), to: String(to) },
  });
}

/**
 * Field names, cleaned to names.
 *
 * Trimmed, de-duplicated, capped in count and in length — the same shape the
 * schema declares and the same cap `project()` applies when it puts the array
 * on a frame. A caller that passed a value rather than a name would still be
 * truncated to something that cannot carry a sentence, which is the point: the
 * cap is not tidiness, it is the last thing standing between a mistake and a
 * paragraph of somebody's notes on an operator's screen.
 */
function names(fields: readonly string[]): string[] {
  return [...new Set(fields.map((f) => String(f).trim()).filter(Boolean))]
    .slice(0, 24)
    .map((f) => f.slice(0, 40));
}

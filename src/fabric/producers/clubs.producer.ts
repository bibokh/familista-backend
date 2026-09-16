// The Clubs domain, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// The last of the eleven lanes to get a producer, and the only one that had
// none at all. `clubs` has been drawn on the board since the board existed,
// with four registered names and nothing that publishes one — the Full
// Coverage & Integrity Audit found the lane registered, exposed and silent.
//
// The flows were all already there. A club is created two ways, invited a
// president, moved between five lifecycle states and occasionally deleted
// forever, and every one of those writes a row and a platform audit entry.
// None of them told the fabric. That is what this file changes, and it changes
// nothing else: no new name, no new source, no new column.
//
// WHAT A CLUB EVENT MAY CARRY
//
// A club record is one of the most private rows in the platform. It holds the
// president's contact address, a website, a billing relationship, white-label
// branding somebody paid for, and — through its memberships — every adult and
// every child in it. None of that is on any event here.
//
// `CLUB` IS a safe subject kind, so unlike a Players or a Medical frame the
// board does render the club's id and resolves its NAME. That is deliberate
// and it predates this file: an operator watching tenancy events needs to know
// which tenant, and a club's name is the one thing about a club that is not
// private — it is on the shirt. Everything else is a closed enum token, a
// boolean or a count.
//
// Specifically never: `contactEmail`, the president's address, the invitation
// token or its hash, `websiteUrl`, `emblem`, the white-label configuration,
// the lifecycle REASON somebody typed, the member counts' composition, or any
// field the platform owner wrote in a free-text box.
//
// ONE FACT, ONE EVENT
//
// Creating a club through SYSTEM creates it and then invites a president, and
// those are two separate transactions, so they are two events. Inviting the
// president also moves the lifecycle PENDING_SETUP → PRESIDENT_INVITED, and
// that is NOT a third: `club.president.invited` is the fact and the lifecycle
// move is its mechanism. Publishing both would put one occurrence on the board
// twice, which is the failure mode the taxonomy's own doctrine names.
//
// Where a transition is conditional on the state a read saw — activation, the
// four lifecycle moves — the publish happens only when the write actually
// moved something. A second administrator clicking at the same moment changes
// no row, writes no audit entry, and produces no event.

import { z } from 'zod';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';
import type { EventSourceType } from '../event-envelope';

/** The source every event in this file belongs to. Registered in `source-registry`. */
export const CLUBS_SOURCE_ID = 'clubs';

/**
 * A lifecycle state, as the platform's own `ClubLifecycle` enum records it.
 *
 * A closed set of five — `PENDING_SETUP`, `PRESIDENT_INVITED`, `ACTIVE`,
 * `DEACTIVATED`, `ARCHIVED`. Declared as a bounded token rather than a `z.enum`
 * so that adding a sixth state to the Prisma enum does not quarantine every
 * club event until this file is edited to agree.
 */
const lifecycleState = z.string().min(1).max(32);

/**
 * Which route the club came in by.
 *
 * `SELF_SERVICE` is a person creating their own club and waiting to become its
 * president; `PLATFORM` is the platform owner creating one and inviting
 * somebody else to run it. The two are different products of the same table
 * and an operator reading the board can tell them apart without either one
 * naming who was involved.
 */
const creationRoute = z.enum(['SELF_SERVICE', 'PLATFORM']);

/** Whether the club was named a country at creation. The value never travels. */
const declared = z.boolean();

export function registerClubsProducer(): void {
  // None of the four types is registered here. All four are in
  // `event-taxonomy.ts`, where they have been since the fabric shipped, and
  // registering them again would be refused — correctly. What was missing was
  // never the registration; it was a producer. Their payload SHAPES are
  // declared here, because this is the file that builds them.

  registerFabricSchema({
    eventType: 'club.created', version: 1,
    describes: 'How the club was created and what state it starts in. Never its contact details',
    schema: z.object({
      route: creationRoute,
      lifecycle: lifecycleState,
      // Whether the caller named a country, not which one. A single club in a
      // small country is identifiable by its country, and the club's name is
      // already on the frame — the two together are more than either.
      countryDeclared: declared,
      shortNameDeclared: declared,
    }).strict(),
  });

  registerFabricSchema({
    eventType: 'club.president.invited', version: 1,
    // The address is the entire point of the invitation and the entire reason
    // it cannot be here: it is a named individual's personal email, held by the
    // platform for one purpose. The board learns that a club is waiting for
    // somebody, never for whom.
    describes: 'That a president invitation was issued and which way. Never the address or the token',
    schema: z.object({
      role: z.string().min(1).max(40),
      /** `NEW` on first issue, `RESENT` for a re-mint, `REPLACED` for a different candidate. */
      issue: z.enum(['NEW', 'RESENT', 'REPLACED']),
      lifecycle: lifecycleState,
    }).strict(),
  });

  registerFabricSchema({
    eventType: 'club.lifecycle.changed', version: 1,
    // A TRANSITION, and never the reason somebody typed into the box beside the
    // button. "Suspended pending the safeguarding review of a named coach" is a
    // plausible reason, so no reason travels at all.
    describes: 'Which way a club’s lifecycle moved, and under what action. Never the reason',
    schema: z.object({
      from: lifecycleState,
      to: lifecycleState,
      /** The platform audit action: `ClubDeactivated`, `ClubArchived`, … */
      action: z.string().min(1).max(48),
    }).strict(),
  });

  registerFabricSchema({
    eventType: 'club.deleted', version: 1,
    // Permanent deletion is refused unless the club owns nothing, so the counts
    // this could carry are all zero by construction and would say nothing. What
    // is worth recording is that it happened and from which state.
    describes: 'That a club was permanently removed, and from which state',
    schema: z.object({ lifecycle: lifecycleState }).strict(),
  });
}

registerClubsProducer();

// ── the helpers the Clubs services call ──────────────────────────────────────
//
// One per event, each taking what the caller already has in hand, each called
// AFTER the write has committed. A helper called inside a transaction would
// announce a club that may yet be rolled back.

/** Who caused it, and to which club. Common to every helper below. */
export interface ClubsContext {
  /** The club this is about. The subject, and the tenant. */
  clubId: string;
  /** The person who caused it. Null for an automatic transition. */
  actorUserId?: string | null;
  /** What produced it. `USER` through the interface, `SERVICE` for activation. */
  sourceType?: EventSourceType;
}

function publish(eventType: string, ctx: ClubsContext, payload: Record<string, unknown>): void {
  publishFabricEventDetached({
    eventType,
    clubId: ctx.clubId,
    teamId: null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'CLUB',
    subjectId: ctx.clubId,
    sourceType: ctx.sourceType ?? 'USER',
    payload,
  });
}

/**
 * A club row was created.
 *
 * Both creation paths call this: `createClubAwaitingPresident`, where a person
 * creates their own club, and `createClubWithPresidentInvite`, where the
 * platform owner creates one for somebody else. They are separate services
 * writing separate transactions — neither delegates to the other — so each
 * calls this once and a club is announced exactly once however it was made.
 */
export function publishClubCreated(
  ctx: ClubsContext,
  route: 'SELF_SERVICE' | 'PLATFORM',
  lifecycle: string,
  declaredFields: { country: boolean; shortName: boolean },
): void {
  publish('club.created', ctx, {
    route,
    lifecycle: String(lifecycle),
    countryDeclared: !!declaredFields.country,
    shortNameDeclared: !!declaredFields.shortName,
  });
}

/**
 * An invitation to become a club's president was issued.
 *
 * Three ways in: the first one, a re-mint of the same address, and a swap to a
 * different candidate. All three are the same fact — there is an invitation
 * outstanding — and `issue` is how they are told apart without naming anybody.
 */
export function publishClubPresidentInvited(
  ctx: ClubsContext,
  role: string,
  issue: 'NEW' | 'RESENT' | 'REPLACED',
  lifecycle: string,
): void {
  publish('club.president.invited', ctx, {
    role: String(role), issue, lifecycle: String(lifecycle),
  });
}

/**
 * A club moved between lifecycle states.
 *
 * Published only where a state really moved. `activateIfReady` and the four
 * platform transitions are all conditional updates whose second caller changes
 * nothing; the callers pass the result of that condition and this is not
 * reached when it was false.
 *
 * Not published for the PENDING_SETUP → PRESIDENT_INVITED move, which is
 * `club.president.invited` — one occurrence, one name.
 */
export function publishClubLifecycleChanged(
  ctx: ClubsContext,
  from: string,
  to: string,
  action: string,
): void {
  if (String(from) === String(to)) return;
  publish('club.lifecycle.changed', ctx, {
    from: String(from), to: String(to), action: String(action).slice(0, 48),
  });
}

/** A club was permanently deleted. Published after the row is gone. */
export function publishClubDeleted(ctx: ClubsContext, lifecycle: string): void {
  publish('club.deleted', ctx, { lifecycle: String(lifecycle) });
}

// The Coach Market, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// A SOURCE OF ITS OWN, and that is the whole point of the file.
//
// Familista runs two markets. One moves FOOTBALLERS between clubs and publishes
// under `transfers`. This one moves STAFF — a head coach, a goalkeeping coach,
// an analyst, a physio — and publishes under `coach-market`. They share a shape
// and nothing else: different tables, different services, different realtime
// channel, different rules about who may accept. Routing one through the other
// would merge two markets the platform deliberately keeps apart, and the merge
// would be invisible to anybody reading the board.
//
// `tests/fabric-coach-market-producer.unit.test.ts` asserts the separation
// structurally rather than trusting it: no `coach.*` or `staff.*` name is owned
// by `transfers`, no `transfer.*` name is owned by `coach-market`, and neither
// service imports the other's producer.
//
// The id is `coach-market` rather than `coach_market` because a source id is
// dash-separated by the registry's own pattern — the same rule that gives
// `video-intelligence` its name.
//
// ONE SOURCE, SIX FAMILIES
//
// Profiles, availability, the shortlist, approaches, the hire and staff needs
// are one source and one lane, told apart by their event NAME and by `stage`.
// There is no card for Available, for Free Agents, for Shortlisted or for
// Activity: those are screens, not sources.
//
// WHAT NEVER TRAVELS
//
// A staff approach is made almost entirely of money and private words. It
// carries a salary, a compensation figure owed to the club he is leaving, a
// release clause, bonuses, a duration, a start date and a free-text message;
// the negotiation that follows is a thread of messages with figures in them;
// the shortlist entry beside it holds a club's private note about a person.
//
// NONE of it travels. Not the salary, not the compensation, not the clause,
// not the bonuses, not the message, not the note, not the club's private
// assessment, and no contact detail, address or document. What travels is that
// a stage was reached, which two clubs were in it, and which ROLE was on the
// table — a `MembershipRole`, which is the platform's ordinary classification
// of what somebody does and not a fact about the person doing it.

import { z } from 'zod';
import { registerFabricSource } from '../registry/source-registry';
import { registerFabricEvent } from '../registry/event-registry';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';
import type { EventSourceType } from '../event-envelope';

/** The source every event in this file belongs to. Dash-separated, by the registry's rule. */
export const COACH_MARKET_SOURCE_ID = 'coach-market';

const token = (max = 48) => z.string().min(1).max(max).nullable();

/** The other club in the room — the one he is leaving, or the one recruiting. */
const counterpartyClubId = token(64);

/**
 * Which family of the market this is.
 *
 * Carried so a consumer can filter the lane without knowing every event name.
 */
const stage = z.enum(['PROFILE', 'SHORTLIST', 'APPROACH', 'NEGOTIATION', 'HIRE', 'NEED']);

/**
 * What the job is.
 *
 * A `MembershipRole` — `HEAD_COACH`, `GK_COACH`, `ANALYST`, `PHYSIO` — which is
 * the platform's ordinary classification of a position and is on every squad
 * screen already. It says what the job is, never who is doing it, and there is
 * no card per role: a goalkeeping coach and a head coach are one market.
 */
const staffRole = token();

/** SENIOR, ACADEMY_U17, or the label an engagement recorded. Never a person. */
const teamContext = token();

const context = { staffRole, counterpartyClubId, stage };

export function registerCoachMarketProducer(): void {
  // The source itself. Registered here rather than in `CORE_SOURCES` because
  // this is exactly the case the registry was built for: a module declares its
  // own source and the board discovers it, with no edit to the renderer.
  registerFabricSource({
    id: COACH_MARKET_SOURCE_ID,
    name: 'Coach Market',
    domain: 'football',
    icon: 'coaches',
    category: 'operations',
    // Between Transfers and Medical: the two markets read together, and a
    // reader scanning the board should find them side by side.
    order: 65,
    description: 'Staff profiles, approaches, hires and vacancies',
    // `coach` for everything about a person in the market, `staff` for what a
    // club is looking for. Both belong to this source and to no other.
    eventDomains: ['coach', 'staff'],
  });

  // ── the professional record ────────────────────────────────────────────────

  registerFabricEvent({
    type: 'coach.profile.created',
    describes: 'A staff member was added to the market',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
  });
  registerFabricSchema({
    eventType: 'coach.profile.created', version: 1,
    // Not the name, the email, the telephone number or the nationality. The
    // record exists; who it is about is read through the service that
    // authorises it.
    describes: 'That a record exists, and for which kind of job',
    schema: z.object({ ...context }).strict(),
  });

  registerFabricEvent({
    type: 'coach.profile.updated',
    describes: 'A staff member’s professional record was amended',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
  });
  registerFabricSchema({
    eventType: 'coach.profile.updated', version: 1,
    // A COUNT, and deliberately not the key `changedFields` the board draws:
    // `salary`, `contractEnd` and `renewalStatus` are field names that are
    // themselves commercially sensitive about an identifiable person.
    describes: 'How many fields moved. Never which, and never to what',
    schema: z.object({
      changedFieldCount: z.number().int().min(0).max(200), ...context,
    }).strict(),
  });

  registerFabricEvent({
    type: 'coach.availability.changed',
    describes: 'A staff member’s availability moved',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
  });
  registerFabricSchema({
    eventType: 'coach.availability.changed', version: 1,
    // `StaffAvailability` is a market state — employed, free, listed — and is
    // the one thing the market exists to publish. It is not a fact about the
    // person's health, conduct or worth.
    describes: 'Which way availability moved, as tokens',
    schema: z.object({ from: token(), to: token(), ...context }).strict(),
  });

  registerFabricEvent({
    type: 'coach.career_intent.changed',
    describes: 'A staff member’s own career intent moved',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
  });
  registerFabricSchema({
    eventType: 'coach.career_intent.changed', version: 1,
    // His intent is HIS, and distinct from whether a club will let him go.
    // The token travels; any reason he gave does not, because the record has
    // nowhere to put one and this schema has nowhere to carry one.
    describes: 'Which way intent moved, as tokens. Never a reason',
    schema: z.object({ from: token(), to: token(), ...context }).strict(),
  });

  registerFabricEvent({
    type: 'coach.contract.status.changed',
    describes: 'An engagement’s renewal status moved',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'coach.contract.status.changed', version: 1,
    // THAT it moved, never the status text and never any figure beside it.
    // `renewalStatus` is free text a club typed — "In talks with Bayern" is a
    // plausible value — so not even the token travels.
    describes: 'That a contract’s standing changed. Never the wording or the terms',
    schema: z.object({ ...context }).strict(),
  });

  // ── the shortlist ──────────────────────────────────────────────────────────

  registerFabricEvent({
    type: 'coach.shortlisted',
    describes: 'A club added a staff member to its shortlist',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
  });
  registerFabricSchema({
    eventType: 'coach.shortlisted', version: 1,
    // A shortlist entry carries the club's own note about a person. The note is
    // not on the event, and the schema has nowhere to put one.
    describes: 'The club whose list it is. Never its note or its ranking',
    schema: z.object({ ...context }).strict(),
  });

  registerFabricEvent({
    type: 'coach.unshortlisted',
    describes: 'A club removed a staff member from its shortlist',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
  });
  registerFabricSchema({
    eventType: 'coach.unshortlisted', version: 1,
    describes: 'The club whose list it was',
    schema: z.object({ ...context }).strict(),
  });

  // ── the approach ───────────────────────────────────────────────────────────
  //
  // A `StaffApproach` is the offer AND the negotiation: one row that moves
  // SENT → NEGOTIATING → ACCEPTED → COMPLETED. The offer family names what the
  // approach itself did; the negotiation family names what happened inside it.

  for (const [type, describes, audit] of [
    ['coach.offer.created', 'An approach was sent to a staff member', false],
    ['coach.offer.updated', 'An approach was countered with different terms', false],
    ['coach.offer.accepted', 'An approach was accepted', true],
    ['coach.offer.rejected', 'An approach was refused', false],
  ] as const) {
    registerFabricEvent({
      type, describes, classification: 'CONFIDENTIAL', entityType: 'STAFF', auditRelevant: audit,
    });
    registerFabricSchema({
      eventType: type, version: 1,
      describes: 'The two clubs and the role. Never the salary, the compensation or the message',
      schema: z.object({ approachId: token(64), ...context }).strict(),
    });
  }

  registerFabricEvent({
    type: 'coach.negotiation.started',
    describes: 'An approach became a negotiation',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
  });
  registerFabricSchema({
    eventType: 'coach.negotiation.started', version: 1,
    describes: 'That terms began to be discussed. Never the terms',
    schema: z.object({ approachId: token(64), ...context }).strict(),
  });

  registerFabricEvent({
    type: 'coach.negotiation.updated',
    describes: 'A step was taken inside a live approach',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
  });
  registerFabricSchema({
    eventType: 'coach.negotiation.updated', version: 1,
    // Published for a PERSISTED step — an interview proposed, written as a
    // message row — and never for a draft, a view or a filter.
    describes: 'Which kind of step. Never what was said or when it was proposed',
    schema: z.object({
      step: z.enum(['INTERVIEW_PROPOSED']), approachId: token(64), ...context,
    }).strict(),
  });

  registerFabricEvent({
    type: 'coach.negotiation.cancelled',
    describes: 'An approach was withdrawn by the club that made it',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
  });
  registerFabricSchema({
    eventType: 'coach.negotiation.cancelled', version: 1,
    describes: 'That the approaching club withdrew. Never why',
    schema: z.object({ approachId: token(64), ...context }).strict(),
  });

  // ── the hire ───────────────────────────────────────────────────────────────

  registerFabricEvent({
    type: 'coach.hired',
    describes: 'A staff member joined a club',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'coach.hired', version: 1,
    // The other side of `coach.offer.accepted`, on the same commit and NOT the
    // same fact: one is an approach reaching its end, the other is an
    // engagement and a membership beginning. Each fires exactly once.
    describes: 'That an engagement began, and in which team context. Never its terms',
    schema: z.object({ teamContext, approachId: token(64), ...context }).strict(),
  });

  // ── what a club is looking for ─────────────────────────────────────────────

  registerFabricEvent({
    type: 'staff.need.created',
    describes: 'A club advertised a staff vacancy',
    classification: 'CONFIDENTIAL',
    entityType: 'CLUB',
  });
  registerFabricSchema({
    eventType: 'staff.need.created', version: 1,
    // Not the salary band, the licence requirement, the languages or the note.
    // A vacancy's terms are read through the market, which authorises the read.
    describes: 'Which role, at which priority. Never the salary band or the note',
    schema: z.object({
      needId: token(64), priority: token(24), ...context,
    }).strict(),
  });

  registerFabricEvent({
    type: 'staff.need.closed',
    describes: 'A club withdrew a staff vacancy',
    classification: 'CONFIDENTIAL',
    entityType: 'CLUB',
  });
  registerFabricSchema({
    eventType: 'staff.need.closed', version: 1,
    describes: 'Which vacancy closed. Never whether it was filled',
    schema: z.object({ needId: token(64), ...context }).strict(),
  });

  // ── declared, produced by nothing ──────────────────────────────────────────

  // A `StaffNeed` is created and closed; nothing edits one in place, so there
  // is no update to observe.
  registerFabricEvent({
    type: 'staff.need.updated',
    describes: 'A staff vacancy’s terms were amended',
    classification: 'CONFIDENTIAL',
    entityType: 'CLUB',
    produced: false,
  });
  registerFabricSchema({
    eventType: 'staff.need.updated', version: 1,
    describes: 'How many fields moved. Never which, and never to what',
    schema: z.object({
      needId: token(64), changedFieldCount: z.number().int().min(0).max(200), ...context,
    }).strict(),
  });

  // An approach reaching COMPLETED IS the hire: one transaction, one moment.
  // `coach.offer.accepted` and `coach.hired` already name the two distinct
  // facts in it — the approach ending and the engagement beginning — and a
  // third name for the same commit is the double-publish the brief warns
  // about. Reserved for a flow where a negotiation concludes without a hire.
  registerFabricEvent({
    type: 'coach.negotiation.completed',
    describes: 'A negotiation concluded without becoming a hire',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
    produced: false,
  });
  registerFabricSchema({
    eventType: 'coach.negotiation.completed', version: 1,
    describes: 'That terms were settled. Never the terms',
    schema: z.object({ approachId: token(64), ...context }).strict(),
  });

  // There is no contact entity: a club reaches a staff member by making an
  // APPROACH, which is `coach.offer.created`. A separate contact event would
  // be a second name for the same row.
  registerFabricEvent({
    type: 'coach.contact.started',
    describes: 'A club made first contact with a staff member',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
    produced: false,
  });
  registerFabricSchema({
    eventType: 'coach.contact.started', version: 1,
    describes: 'That contact was made. Never what was said',
    schema: z.object({ ...context }).strict(),
  });

  // Familista has no staff invitation distinct from an approach. `ClubInvitation`
  // is how a PERSON joins the platform and belongs to the Users domain, which
  // already publishes it.
  for (const [type, describes] of [
    ['coach.invitation.created', 'A staff member was invited to a club'],
    ['coach.invitation.accepted', 'A staff invitation was accepted'],
    ['coach.invitation.rejected', 'A staff invitation was refused'],
  ] as const) {
    registerFabricEvent({
      type, describes, classification: 'CONFIDENTIAL', entityType: 'STAFF', produced: false,
    });
    registerFabricSchema({
      eventType: type, version: 1,
      describes: 'The club and the role. Never the message',
      schema: z.object({ ...context }).strict(),
    });
  }

  // `moveStaffMember` does exactly this: it changes the membership's team, its
  // role, or both, closes the open engagement and opens a new one. This comment
  // used to claim nothing moved a staff member within a club, and two audits
  // repeated the claim rather than checking it. The flow was there all along.
  registerFabricEvent({
    type: 'coach.assignment.changed',
    describes: 'A staff member was moved to a different team',
    classification: 'CONFIDENTIAL',
    entityType: 'STAFF',
  });
  registerFabricSchema({
    eventType: 'coach.assignment.changed', version: 1,
    describes: 'Which way the assignment moved, as team contexts',
    schema: z.object({ from: teamContext, to: teamContext, ...context }).strict(),
  });
}

registerCoachMarketProducer();

// ── the helpers the Coach Market calls ───────────────────────────────────────

/**
 * Whose record, and whose action.
 *
 * `staffUserId` is the envelope's subject. `STAFF` is deliberately NOT one of
 * the board's safe subject kinds, so `project()` replaces the id with null and
 * the observability surface never learns who — while a consumer with authority
 * to read the market keeps the link it needs.
 */
export interface CoachMarketContext {
  /** The staff member the event is about. Redacted on the board. */
  staffUserId: string;
  /** The club whose action this is. */
  clubId: string;
  /** The other club, when there is one. */
  counterpartyClubId?: string | null;
  staffRole?: string | null;
  actorUserId?: string | null;
  sourceType?: EventSourceType;
}

type Stage = z.infer<typeof stage>;

function publish(
  eventType: string,
  ctx: CoachMarketContext,
  stageOf: Stage,
  extra: Record<string, unknown> = {},
): void {
  publishFabricEventDetached({
    eventType,
    // ONE canonical event per action, scoped to the club that acted. A staff
    // move involves two clubs and is not published twice for that reason.
    clubId: ctx.clubId,
    teamId: null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'STAFF',
    subjectId: ctx.staffUserId,
    sourceType: ctx.sourceType ?? 'USER',
    payload: {
      ...extra,
      staffRole: ctx.staffRole ?? null,
      counterpartyClubId: ctx.counterpartyClubId ?? null,
      stage: stageOf,
    },
  });
}

export function publishCoachProfileCreated(ctx: CoachMarketContext): void {
  publish('coach.profile.created', ctx, 'PROFILE');
}

export function publishCoachProfileUpdated(ctx: CoachMarketContext, fieldsTouched: number): void {
  publish('coach.profile.updated', ctx, 'PROFILE', {
    changedFieldCount: Math.max(0, Math.min(200, Math.round(fieldsTouched))),
  });
}

export function publishCoachAvailabilityChanged(
  ctx: CoachMarketContext, from: string | null, to: string | null,
): void {
  publish('coach.availability.changed', ctx, 'PROFILE', { from: from ?? null, to: to ?? null });
}

export function publishCoachCareerIntentChanged(
  ctx: CoachMarketContext, from: string | null, to: string | null,
): void {
  publish('coach.career_intent.changed', ctx, 'PROFILE', { from: from ?? null, to: to ?? null });
}

export function publishCoachContractStatusChanged(ctx: CoachMarketContext): void {
  publish('coach.contract.status.changed', ctx, 'PROFILE');
}

export function publishCoachShortlisted(ctx: CoachMarketContext): void {
  publish('coach.shortlisted', ctx, 'SHORTLIST');
}

export function publishCoachUnshortlisted(ctx: CoachMarketContext): void {
  publish('coach.unshortlisted', ctx, 'SHORTLIST');
}

/** The four states of one approach. One helper, so they cannot drift apart. */
export function publishCoachOffer(
  ctx: CoachMarketContext,
  state: 'CREATED' | 'UPDATED' | 'ACCEPTED' | 'REJECTED',
  approachId: string,
): void {
  publish(`coach.offer.${state.toLowerCase()}`, ctx, 'APPROACH', { approachId });
}

export function publishCoachNegotiationStarted(ctx: CoachMarketContext, approachId: string): void {
  publish('coach.negotiation.started', ctx, 'NEGOTIATION', { approachId });
}

export function publishCoachNegotiationUpdated(
  ctx: CoachMarketContext, approachId: string, step: 'INTERVIEW_PROPOSED' = 'INTERVIEW_PROPOSED',
): void {
  publish('coach.negotiation.updated', ctx, 'NEGOTIATION', { approachId, step });
}

export function publishCoachNegotiationCancelled(ctx: CoachMarketContext, approachId: string): void {
  publish('coach.negotiation.cancelled', ctx, 'NEGOTIATION', { approachId });
}

/**
 * A staff member joined a club.
 *
 * Published beside — and not instead of — `coach.offer.accepted`, on the same
 * commit. The two describe different things: an approach reaching its end, and
 * an engagement and a membership beginning. Each fires exactly once, which is
 * what the tests pin.
 */
export function publishCoachHired(
  ctx: CoachMarketContext, approachId: string, team: string | null,
): void {
  publish('coach.hired', ctx, 'HIRE', { approachId, teamContext: team ?? null });
}

/**
 * A staff member was moved to a different job inside the same club.
 *
 * Called by `moveStaffMember` after its transaction, and never for a request
 * that moves nothing — the service returns `{ moved: false }` before writing
 * when neither the role nor the team changed.
 *
 * `from` and `to` are team CONTEXTS, the same kind of value `coach.hired`
 * already carries: the label an engagement recorded, never a person and never
 * a team id.
 */
export function publishCoachAssignmentChanged(
  ctx: CoachMarketContext, from: string | null, to: string | null,
): void {
  publish('coach.assignment.changed', ctx, 'HIRE', { from: from ?? null, to: to ?? null });
}

export function publishStaffNeedCreated(
  clubId: string, needId: string, role: string | null, priority: string | null,
  actorUserId?: string | null,
): void {
  publishNeed('staff.need.created', clubId, needId, role, actorUserId, { priority: priority ?? null });
}

export function publishStaffNeedClosed(
  clubId: string, needId: string, role: string | null, actorUserId?: string | null,
): void {
  publishNeed('staff.need.closed', clubId, needId, role, actorUserId);
}

/**
 * A vacancy is the CLUB's statement, not a person's.
 *
 * So its subject is the club — which is not a person and may be named on the
 * board — rather than a staff member who has not been chosen and may not exist.
 */
function publishNeed(
  eventType: string, clubId: string, needId: string, role: string | null,
  actorUserId?: string | null, extra: Record<string, unknown> = {},
): void {
  publishFabricEventDetached({
    eventType,
    clubId,
    teamId: null,
    actorUserId: actorUserId ?? null,
    subjectType: 'CLUB',
    subjectId: clubId,
    sourceType: 'USER',
    payload: {
      ...extra, needId, staffRole: role ?? null,
      counterpartyClubId: null, stage: 'NEED',
    },
  });
}

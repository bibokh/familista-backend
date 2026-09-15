// The player Transfers domain, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// PLAYERS ONLY. The Coach Market — staff availability, coach negotiations, the
// staff shortlist — is a separate Familista module with its own service, its
// own tables and its own realtime channel, and nothing in this file touches it.
// It will get its own producer; routing it through Transfers would merge two
// markets that the platform deliberately keeps apart, and the merge would be
// invisible to anybody reading the board.
//
// ONE SOURCE, FIVE FAMILIES
//
// Listings, offers, negotiations, the shortlist and completed moves are one
// source and one lane. They are told apart by their event NAME and by the
// `transferStage` each carries — not by a card of their own, which is what the
// registry exists to make unnecessary.
//
// WHAT NEVER TRAVELS, AND WHY THIS DOMAIN IS THE STRICTEST SO FAR
//
// A transfer is made of money and of private words. An offer carries a fee, a
// wage and a message; a listing carries an asking price and a release clause; a
// shortlist entry carries a scout's own notes about a player who is frequently
// a child; a bid carries an amount; a negotiation carries whatever two clubs
// said to each other.
//
// NONE of it travels. Not the fee, not the wage, not the clause, not the
// message, not the note, not the bid — and not, by default, any amount at all.
// The observability policy this platform already follows is that a figure is
// withheld unless something explicitly permits it, and nothing does. What
// travels is that a stage was reached, which two clubs were in it, and which
// footballer it concerned.
//
// WHAT THE SUBJECT IS
//
// The subject is the TRANSFER ARTIFACT — the listing, the offer, the registered
// interest, the shortlist entry — and never the footballer. `playerId` rides in
// the payload, where the board's frame builder cannot reach it: `project()`
// reads the envelope and never a payload, so an id that is safe for an
// authorised consumer is still not on the observability surface.

import { z } from 'zod';
import { registerFabricEvent } from '../registry/event-registry';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';
import type { EventSourceType } from '../event-envelope';

/** The source every event in this file belongs to. Registered in `source-registry`. */
export const TRANSFERS_SOURCE_ID = 'transfers';

const clubId = z.string().min(1).max(64);

/** The other club in the room. A tenant id, which the board already shows. */
const counterpartyClubId = clubId.nullable();

/**
 * Which footballer the artifact concerns.
 *
 * An opaque key, not a fact about a person: no name, no age, no nationality,
 * no contract and no note. It is here because a consumer authorised to read a
 * listing cannot otherwise join it to the player it advertises without a second
 * round trip, and because the Players domain already keys its own events on it.
 */
const playerId = clubId.nullable();

/**
 * Which family of the market this event belongs to.
 *
 * Carried so a consumer can filter the lane without knowing every event name —
 * the five families the brief names, as one token.
 */
const transferStage = z.enum(['LISTING', 'OFFER', 'NEGOTIATION', 'SHORTLIST', 'COMPLETION']);

/** How a player was put on the market. A shape, not a price. */
const listingKind = z.enum(['FIXED_PRICE', 'AUCTION', 'OPEN_MARKET']);

/** How a completed move was settled. The same three routes the market has. */
const settledBy = z.enum(['PURCHASE', 'OFFER_ACCEPTED', 'AUCTION']);

/** On every event in this file, and on nothing else. */
const context = { playerId, counterpartyClubId, transferStage };

/** What a listing event says beyond the common context. */
const listingContext = { listingKind, ...context };

export function registerTransfersProducer(): void {
  // `transfer.offered` and `transfer.completed` are already registered in
  // `event-taxonomy.ts`. Registering either again with different settings would
  // be refused, correctly; only `transfer.completed`'s payload shape is
  // declared here, because it is the one this file produces.

  // ── listings ───────────────────────────────────────────────────────────────

  registerFabricEvent({
    type: 'transfer.listed',
    describes: 'A player was put on the market',
    classification: 'CONFIDENTIAL',
    entityType: 'TRANSFER',
  });
  registerFabricSchema({
    eventType: 'transfer.listed', version: 1,
    describes: 'How he was listed. Never the asking price, never the clause',
    schema: z.object({ ...listingContext }).strict(),
  });

  registerFabricEvent({
    type: 'transfer.listing.updated',
    describes: 'A live listing’s terms of exposure changed',
    classification: 'CONFIDENTIAL',
    entityType: 'TRANSFER',
  });
  registerFabricSchema({
    eventType: 'transfer.listing.updated', version: 1,
    describes: 'That the listing changed, and which kind it is. Never what it now asks',
    schema: z.object({ ...listingContext }).strict(),
  });

  registerFabricEvent({
    type: 'transfer.listing.withdrawn',
    describes: 'A player was taken off the market without a sale',
    classification: 'CONFIDENTIAL',
    entityType: 'TRANSFER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'transfer.listing.withdrawn', version: 1,
    // An auction that ends with nobody bidding and an advert the seller pulls
    // are the same fact about the market — the player came off it, unsold —
    // and `withdrawnBy` is the whole difference between them.
    describes: 'Which kind of listing ended, and at whose hand. Never the reason',
    schema: z.object({
      withdrawnBy: z.enum(['SELLER', 'EXPIRY']),
      ...listingContext,
    }).strict(),
  });

  // ── offers ─────────────────────────────────────────────────────────────────
  //
  // Five states of one conversation between two clubs. Each is its own name so
  // a consumer can subscribe to acceptance without reading every counter, and
  // each carries the two clubs and nothing else — an offer's FEE, its WAGE and
  // its MESSAGE are the substance of a private negotiation.

  for (const [type, describes, audit] of [
    ['transfer.offer.created',   'An offer was made for a player', false],
    ['transfer.offer.updated',   'An offer was countered',         false],
    ['transfer.offer.accepted',  'An offer was accepted',          true],
    ['transfer.offer.rejected',  'An offer was refused',           false],
    ['transfer.offer.withdrawn', 'An offer was taken back',        false],
  ] as const) {
    registerFabricEvent({
      type,
      describes,
      classification: 'CONFIDENTIAL',
      entityType: 'TRANSFER',
      auditRelevant: audit,
    });
    registerFabricSchema({
      eventType: type, version: 1,
      describes: 'The two clubs in the room. Never the fee, the wage or the message',
      schema: z.object({ ...context }).strict(),
    });
  }

  // ── auctions ───────────────────────────────────────────────────────────────
  //
  // A bid is a durable row and a committed budget, so it is a platform action
  // and not a gesture. Without it an auction is a black box between the day it
  // opens and the day it settles. The AMOUNT is the one thing it does not say.

  registerFabricEvent({
    type: 'transfer.bid.placed',
    describes: 'A club bid on an auctioned player',
    classification: 'CONFIDENTIAL',
    entityType: 'TRANSFER',
  });
  registerFabricSchema({
    eventType: 'transfer.bid.placed', version: 1,
    // Every bid the engine accepts has to beat what is on the table, so
    // "did it lead" would be the constant `true` and would say nothing. What
    // varies — and what the seller and the outbid club both act on — is
    // whether there was somebody to displace.
    describes: 'That a bid was placed and whether it displaced a leader. Never the amount',
    schema: z.object({ displacedLeader: z.boolean(), ...context }).strict(),
  });

  // ── negotiations ───────────────────────────────────────────────────────────
  //
  // A registered interest is where a negotiation begins; the owner's answer is
  // where it moves; a formal offer is where it ends. Those are the three
  // PERSISTED transitions the platform has. Nothing here fires for a UI step, a
  // search, a filter or a message being typed — each of the three is a row
  // written to the database before it is announced.

  registerFabricEvent({
    type: 'transfer.negotiation.started',
    describes: 'A club registered interest in another club’s player',
    classification: 'CONFIDENTIAL',
    entityType: 'TRANSFER',
  });
  registerFabricSchema({
    eventType: 'transfer.negotiation.started', version: 1,
    describes: 'The two clubs. Never the message that opened it',
    schema: z.object({ ...context }).strict(),
  });

  registerFabricEvent({
    type: 'transfer.negotiation.updated',
    describes: 'The owning club answered a registered interest',
    classification: 'CONFIDENTIAL',
    entityType: 'TRANSFER',
  });
  registerFabricSchema({
    eventType: 'transfer.negotiation.updated', version: 1,
    // The ANSWER is a token from the platform's own enum — invited, declined,
    // not for sale — and is the operationally interesting half. What was said
    // alongside it is not on the event.
    describes: 'Which way the answer went, as a token. Never the words',
    schema: z.object({
      outcome: z.enum(['INVITED', 'DECLINED', 'NOT_FOR_SALE']),
      ...context,
    }).strict(),
  });

  registerFabricEvent({
    type: 'transfer.negotiation.completed',
    describes: 'A registered interest was superseded by a formal offer',
    classification: 'CONFIDENTIAL',
    entityType: 'TRANSFER',
  });
  registerFabricSchema({
    eventType: 'transfer.negotiation.completed', version: 1,
    describes: 'That the interest reached a priced offer. Never the price',
    schema: z.object({ ...context }).strict(),
  });

  // Declared, not produced. Familista has no flow that cancels a negotiation:
  // an interest is answered, superseded or closed by a sale, and each of those
  // already has its own name above. The type exists so a future flow registers
  // nothing new, and so the catalogue says plainly that the capability is
  // there and unused — which is the honest answer, and better than a producer
  // invented to fill a row.
  registerFabricEvent({
    type: 'transfer.negotiation.cancelled',
    describes: 'A negotiation was abandoned before any answer',
    classification: 'CONFIDENTIAL',
    entityType: 'TRANSFER',
    produced: false,
  });
  registerFabricSchema({
    eventType: 'transfer.negotiation.cancelled', version: 1,
    describes: 'The two clubs. Never the words',
    schema: z.object({ ...context }).strict(),
  });

  // ── the shortlist ──────────────────────────────────────────────────────────
  //
  // Both are DURABLE: a `TransferTarget` row created, and the same row
  // archived. Neither fires for a hover, a filter or a profile being opened —
  // there is no code path on which they could, because both are written to the
  // database before they are announced, and the add publishes only when a row
  // was really created rather than when an identical one was found.

  registerFabricEvent({
    type: 'transfer.shortlisted',
    describes: 'A club added a player to its transfer shortlist',
    classification: 'CONFIDENTIAL',
    entityType: 'TRANSFER',
  });
  registerFabricSchema({
    eventType: 'transfer.shortlisted', version: 1,
    // A shortlist entry carries a scout's own notes about a player who is
    // frequently a child. The note is not on the event, and the schema has
    // nowhere to put one.
    describes: 'The club whose list it is. Never the scouting note',
    schema: z.object({ ...context }).strict(),
  });

  registerFabricEvent({
    type: 'transfer.unshortlisted',
    describes: 'A club took a player off its transfer shortlist',
    classification: 'CONFIDENTIAL',
    entityType: 'TRANSFER',
  });
  registerFabricSchema({
    eventType: 'transfer.unshortlisted', version: 1,
    describes: 'The club whose list it was',
    schema: z.object({ ...context }).strict(),
  });

  // ── completion ─────────────────────────────────────────────────────────────

  registerFabricSchema({
    eventType: 'transfer.completed', version: 1,
    // No fee. What a club paid is commercially confidential, it is in the
    // transfer record read under authorisation, and the default this platform
    // already follows is to withhold a figure unless something explicitly
    // permits it. Nothing does.
    //
    // No `counterpartyClubId` either: naming both clubs outright says the same
    // thing without making a reader work out which side the envelope's tenant
    // was on.
    describes: 'Which club he left, which he joined, and how it settled. Never what it cost',
    schema: z.object({
      originatingClubId: clubId,
      destinationClubId: clubId,
      settledBy,
      playerId, transferStage,
    }).strict(),
  });

  // Declared, not produced, for the same reason as the cancelled negotiation
  // above: nothing in Familista reverses a completed transfer. The player has
  // moved, the money has moved and the history row is written; undoing it is
  // not a flow the platform has, and a producer for one would be fiction.
  registerFabricEvent({
    type: 'transfer.cancelled',
    describes: 'A concluded transfer was reversed',
    classification: 'CONFIDENTIAL',
    entityType: 'TRANSFER',
    auditRelevant: true,
    produced: false,
  });
  registerFabricSchema({
    eventType: 'transfer.cancelled', version: 1,
    describes: 'Which move was reversed. Never what it cost',
    schema: z.object({
      originatingClubId: clubId,
      destinationClubId: clubId,
      playerId, transferStage,
    }).strict(),
  });
}

registerTransfersProducer();

// ── the helpers the Transfers services call ──────────────────────────────────

/**
 * Who is acting, and on what artifact.
 *
 * `transferId` is the LISTING, the OFFER, the registered INTEREST or the
 * shortlist entry — the transfer artifact — and never the footballer.
 */
export interface TransferContext {
  /** The listing, offer, interest or shortlist-entry id. Never a player id. */
  transferId: string;
  /** The club whose action this is. The envelope's tenant. */
  actingClubId: string;
  /** The other club, when there is one. */
  counterpartyClubId?: string | null;
  /** Which footballer the artifact concerns. An opaque key, in the payload. */
  playerId?: string | null;
  actorUserId?: string | null;
  sourceType?: EventSourceType;
}

function publish(
  eventType: string,
  ctx: TransferContext,
  stage: z.infer<typeof transferStage>,
  extra: Record<string, unknown> = {},
): void {
  publishFabricEventDetached({
    eventType,
    // ONE canonical event per action, scoped to the club that acted. A transfer
    // involves two clubs and is not published twice for that reason; the other
    // one is named in the payload.
    clubId: ctx.actingClubId,
    teamId: null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'TRANSFER',
    subjectId: ctx.transferId,
    sourceType: ctx.sourceType ?? 'USER',
    payload: {
      ...extra,
      playerId: ctx.playerId ?? null,
      counterpartyClubId: ctx.counterpartyClubId ?? null,
      transferStage: stage,
    },
  });
}

export type ListingKind = z.infer<typeof listingKind>;
export type TransferSettledBy = z.infer<typeof settledBy>;

export function publishTransferListed(ctx: TransferContext, kind: ListingKind): void {
  publish('transfer.listed', ctx, 'LISTING', { listingKind: kind });
}

export function publishTransferListingUpdated(ctx: TransferContext, kind: ListingKind): void {
  publish('transfer.listing.updated', ctx, 'LISTING', { listingKind: kind });
}

export function publishTransferListingWithdrawn(
  ctx: TransferContext, kind: ListingKind, by: 'SELLER' | 'EXPIRY' = 'SELLER',
): void {
  publish('transfer.listing.withdrawn', ctx, 'LISTING', { listingKind: kind, withdrawnBy: by });
}

/** The five states of one offer. One helper, so they cannot drift apart. */
export function publishTransferOffer(
  ctx: TransferContext,
  state: 'CREATED' | 'UPDATED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN',
): void {
  publish(`transfer.offer.${state.toLowerCase()}`, ctx, 'OFFER');
}

export function publishTransferBidPlaced(ctx: TransferContext, displacedLeader: boolean): void {
  publish('transfer.bid.placed', ctx, 'OFFER', { displacedLeader });
}

export function publishTransferNegotiationStarted(ctx: TransferContext): void {
  publish('transfer.negotiation.started', ctx, 'NEGOTIATION');
}

export function publishTransferNegotiationUpdated(
  ctx: TransferContext,
  outcome: 'INVITED' | 'DECLINED' | 'NOT_FOR_SALE',
): void {
  publish('transfer.negotiation.updated', ctx, 'NEGOTIATION', { outcome });
}

export function publishTransferNegotiationCompleted(ctx: TransferContext): void {
  publish('transfer.negotiation.completed', ctx, 'NEGOTIATION');
}

export function publishTransferShortlisted(ctx: TransferContext): void {
  publish('transfer.shortlisted', ctx, 'SHORTLIST');
}

export function publishTransferUnshortlisted(ctx: TransferContext): void {
  publish('transfer.unshortlisted', ctx, 'SHORTLIST');
}

/**
 * A completed move.
 *
 * Published from the one function all three settlement routes already go
 * through, beside — and not instead of — the Players domain's own
 * `player.transferred`. The two describe different things: one is the deal
 * closing, the other is the footballer's club changing. Each fires exactly
 * once, which is what the tests pin.
 *
 * The envelope's tenant is the ACQUIRING club, which is where the player now
 * is; both clubs are named in the payload so neither has to be inferred.
 */
export function publishTransferCompleted(
  ctx: Omit<TransferContext, 'counterpartyClubId'>,
  originatingClubId: string,
  how: TransferSettledBy,
): void {
  publishFabricEventDetached({
    eventType: 'transfer.completed',
    clubId: ctx.actingClubId,
    teamId: null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'TRANSFER',
    subjectId: ctx.transferId,
    sourceType: ctx.sourceType ?? 'USER',
    payload: {
      originatingClubId: String(originatingClubId),
      destinationClubId: ctx.actingClubId,
      settledBy: how,
      playerId: ctx.playerId ?? null,
      transferStage: 'COMPLETION',
    },
  });
}

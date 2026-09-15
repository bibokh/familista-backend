// Familista — what the market announces, and to whom
// ─────────────────────────────────────────────────────────────────────────────
// Every routing decision the transfer module makes about realtime lives here,
// once. A service calls the verb for the thing that just happened; it does not
// decide who may hear about it, and it cannot accidentally broadcast something
// private by choosing the wrong publish function at the call site.
//
// The rule is the same one the read endpoints already follow. A listing, an
// auction, a completed transfer and a published need are public facts — they
// are already readable by every club through /market, /auctions, /feed and
// /needs, so the fact that they changed is public too. A fee, a message, a bid
// amount, a balance and a private note are not, so events about them are
// addressed to the clubs entitled to them and carry no figures.
//
// Nothing here is emitted until the transaction that caused it has committed.
// An event announcing a transfer that then rolled back would be worse than a
// late one.
//
// ── and what it records ─────────────────────────────────────────────────────
//
// The same functions now also tell the Data Fabric. One funnel, two audiences:
// realtime answers "who should see this change now", the fabric answers "what
// happened, durably, for anyone later authorised to ask". Putting both here is
// what stops the two drifting — a route added tomorrow reaches the board and
// the record together or reaches neither, and there is no second place to
// forget.
//
// The fabric half NEVER carries money. Not a fee, not a bid, not an asking
// price, not a wage, not a clause, not a message and not a scouting note. See
// `fabric/producers/transfers.producer.ts` for what each event may contain.

import { publishPublic, publishToClubs, MarketSurface } from '../realtime/market-channel';
import { logger } from '../utils/logger';
import {
  publishTransferListed, publishTransferListingUpdated, publishTransferListingWithdrawn,
  publishTransferOffer, publishTransferBidPlaced,
  publishTransferNegotiationStarted, publishTransferNegotiationUpdated,
  publishTransferNegotiationCompleted,
  publishTransferShortlisted, publishTransferUnshortlisted, publishTransferCompleted,
  type ListingKind,
} from '../fabric/producers/transfers.producer';

export type { ListingKind };

type Ids = { playerId?: string | null; listingId?: string | null; offerId?: string | null; needId?: string | null };

// A publish must never be able to fail a transfer that already happened.
const safePublic = (kind: Parameters<typeof publishPublic>[0]['kind'], surfaces: MarketSurface[], ids: Ids = {}) => {
  try { publishPublic({ kind, surfaces, ...ids }); }
  catch (err) { logger.warn('[market-events] public publish failed', { kind, err: (err as Error)?.message }); }
};
const safeClubs = (clubIds: Array<string | null | undefined>, kind: Parameters<typeof publishToClubs>[1]['kind'], surfaces: MarketSurface[], ids: Ids = {}) => {
  try { publishToClubs(clubIds, { kind, surfaces, ...ids }); }
  catch (err) { logger.warn('[market-events] club publish failed', { kind, err: (err as Error)?.message }); }
};

/**
 * The same promise, for the fabric.
 *
 * `publishFabricEventDetached` is already incapable of rejecting into a caller,
 * so this guards the step before it: building the arguments. A transfer that
 * has completed must not be undone, delayed or reported as failed because an
 * observability call threw on a value it did not expect. Business transaction
 * first, record second.
 */
const safeFabric = (what: string, publish: () => void) => {
  try { publish(); }
  catch (err) { logger.warn('[market-events] fabric publish failed', { what, err: (err as Error)?.message }); }
};

/** Nothing below carries a player when the caller could not name one. */
const asId = (v: string | null | undefined) => (v ? String(v) : null);

// ── the market ──────────────────────────────────────────────────────────────
// A listing is an advert. Its existence, its price and its withdrawal are what
// the market is for, so they go to everyone; the seller additionally re-reads
// its own desk.
export function emitListingCreated(sellerClubId: string, playerId: string, listingId: string, actorUserId?: string | null) {
  safePublic('LISTING_CREATED', ['market', 'feed', 'discover'], { playerId, listingId });
  safeClubs([sellerClubId], 'LISTING_CREATED', ['activity', 'market'], { playerId, listingId });
  safeFabric('transfer.listed', () => publishTransferListed(
    { transferId: listingId, actingClubId: sellerClubId, playerId: asId(playerId), actorUserId }, 'FIXED_PRICE',
  ));
}
export function emitListingWithdrawn(
  sellerClubId: string, playerId: string | null, listingId: string,
  kind: ListingKind = 'FIXED_PRICE', actorUserId?: string | null,
) {
  safePublic('LISTING_WITHDRAWN', ['market', 'feed', 'discover'], { playerId, listingId });
  safeClubs([sellerClubId], 'LISTING_WITHDRAWN', ['activity', 'market'], { playerId, listingId });
  safeFabric('transfer.listing.withdrawn', () => publishTransferListingWithdrawn(
    { transferId: listingId, actingClubId: sellerClubId, playerId: asId(playerId), actorUserId }, kind, 'SELLER',
  ));
}

/**
 * The seller gave a live listing longer to run.
 *
 * Fabric only: extending a deadline changes nothing any board is currently
 * drawing, and the screens that care re-read /market. It is still a real,
 * persisted change to how a player is exposed, which is what the record is for.
 * The new deadline is NOT on the event — a listing's terms are read from the
 * listing, under the authorisation that already governs it.
 */
export function emitListingExtended(
  sellerClubId: string, playerId: string | null, listingId: string,
  kind: ListingKind = 'OPEN_MARKET', actorUserId?: string | null,
) {
  safeFabric('transfer.listing.updated', () => publishTransferListingUpdated(
    { transferId: listingId, actingClubId: sellerClubId, playerId: asId(playerId), actorUserId }, kind,
  ));
}

// ── auctions ────────────────────────────────────────────────────────────────
// An auction is public and so is the fact that it moved. The AMOUNT is not on
// the event — the board re-reads /auctions, which decides what each club may
// see — so a bid tells the market only that there has been one.
export function emitAuctionCreated(
  sellerClubId: string, playerId: string, listingId: string,
  kind: ListingKind = 'AUCTION', actorUserId?: string | null,
) {
  safePublic('AUCTION_CREATED', ['auctions', 'feed', 'discover'], { playerId, listingId });
  safeClubs([sellerClubId], 'AUCTION_CREATED', ['activity', 'auctions'], { playerId, listingId });
  safeFabric('transfer.listed', () => publishTransferListed(
    { transferId: listingId, actingClubId: sellerClubId, playerId: asId(playerId), actorUserId }, kind,
  ));
}

/**
 * A player published to the open market, with or without bidding.
 *
 * Realtime is unchanged by this function's existence: only a listing that
 * accepts bids is an auction, and only an auction announces itself as one. The
 * FABRIC records both, because a published price is as much a listing as a
 * published auction — and before this, a seller who turned bidding off left no
 * trace on the record at all.
 */
export function emitOpenMarketPublished(
  sellerClubId: string, playerId: string, listingId: string,
  bidding: boolean, actorUserId?: string | null,
) {
  if (bidding) { emitAuctionCreated(sellerClubId, playerId, listingId, 'OPEN_MARKET', actorUserId); return; }
  safeFabric('transfer.listed', () => publishTransferListed(
    { transferId: listingId, actingClubId: sellerClubId, playerId: asId(playerId), actorUserId }, 'OPEN_MARKET',
  ));
}

export function emitAuctionBid(listingId: string, playerId: string | null, sellerClubId: string, bidderClubId: string, previousLeaderClubId: string | null, actorUserId?: string | null) {
  safePublic('AUCTION_BID', ['auctions'], { playerId, listingId });
  // The seller sees money on the table; the bidder sees its own commitment
  // change; whoever led before is no longer leading.
  safeClubs([sellerClubId], 'AUCTION_BID', ['activity', 'notifications'], { playerId, listingId });
  safeClubs([bidderClubId], 'AUCTION_BID', ['activity', 'balance'], { playerId, listingId });
  if (previousLeaderClubId && previousLeaderClubId !== bidderClubId) {
    safeClubs([previousLeaderClubId], 'AUCTION_OUTBID', ['auctions', 'activity', 'balance', 'notifications'], { playerId, listingId });
  }
  // The bidder acted; the seller is the club on the other side of it. The
  // AMOUNT is on neither the realtime event nor the record.
  safeFabric('transfer.bid.placed', () => publishTransferBidPlaced(
    {
      transferId: listingId, actingClubId: bidderClubId, counterpartyClubId: sellerClubId,
      playerId: asId(playerId), actorUserId,
    },
    !!previousLeaderClubId && previousLeaderClubId !== bidderClubId,
  ));
}
export function emitAuctionCancelled(listingId: string, playerId: string | null, sellerClubId: string, bidderClubIds: string[], actorUserId?: string | null) {
  safePublic('AUCTION_CANCELLED', ['auctions', 'feed', 'discover'], { playerId, listingId });
  safeClubs([sellerClubId], 'AUCTION_CANCELLED', ['activity', 'auctions'], { playerId, listingId });
  // Their money is no longer committed, and they have been told why.
  safeClubs(bidderClubIds, 'AUCTION_CANCELLED', ['auctions', 'activity', 'balance', 'notifications'], { playerId, listingId });
  safeFabric('transfer.listing.withdrawn', () => publishTransferListingWithdrawn(
    { transferId: listingId, actingClubId: sellerClubId, playerId: asId(playerId), actorUserId }, 'AUCTION', 'SELLER',
  ));
}
export function emitAuctionSettled(
  listingId: string, playerId: string | null,
  sellerClubId: string, winnerClubId: string | null, loserClubIds: string[],
) {
  safePublic('AUCTION_SETTLED', ['auctions', 'feed', 'market', 'discover'], { playerId, listingId });
  safeClubs([sellerClubId], 'AUCTION_SETTLED', ['activity', 'balance', 'notifications'], { playerId, listingId });
  if (winnerClubId) {
    safeClubs([winnerClubId], 'AUCTION_SETTLED', ['activity', 'balance', 'shortlist', 'notifications'], { playerId, listingId });
  }
  safeClubs(loserClubIds, 'AUCTION_SETTLED', ['auctions', 'activity', 'balance', 'notifications'], { playerId, listingId });
  // An auction that sold is a COMPLETED TRANSFER, and the caller announces it
  // as one through `emitTransferCompleted` — publishing a second event here
  // would record one move twice. An auction that ended with nobody bidding
  // sold nothing: the player came off the market, by the clock rather than by
  // the seller's hand, and that is the only case this records.
  if (!winnerClubId) {
    safeFabric('transfer.listing.withdrawn', () => publishTransferListingWithdrawn(
      { transferId: listingId, actingClubId: sellerClubId, playerId: asId(playerId), sourceType: 'SERVICE' },
      'AUCTION', 'EXPIRY',
    ));
  }
}

// ── negotiation ─────────────────────────────────────────────────────────────
// None of this is public. An interest, an offer, a counter and a rejection are
// between two clubs, and the event goes to exactly those two.
export function emitInterest(
  ownerClubId: string, interestedClubId: string, playerId: string,
  interestId?: string | null, actorUserId?: string | null,
) {
  safeClubs([ownerClubId], 'INTEREST_REGISTERED', ['activity', 'notifications'], { playerId });
  safeClubs([interestedClubId], 'INTEREST_REGISTERED', ['activity', 'discover'], { playerId });
  // The club that asked is the one that acted. The MESSAGE it asked with is on
  // neither the realtime event nor the record.
  if (interestId) {
    safeFabric('transfer.negotiation.started', () => publishTransferNegotiationStarted({
      transferId: interestId, actingClubId: interestedClubId, counterpartyClubId: ownerClubId,
      playerId: asId(playerId), actorUserId,
    }));
  }
}
export function emitInterestAnswered(
  ownerClubId: string, interestedClubId: string, playerId: string,
  interestId?: string | null, outcome?: InterestOutcome, actorUserId?: string | null,
) {
  safeClubs([ownerClubId, interestedClubId], 'INTEREST_ANSWERED', ['activity', 'discover', 'notifications'], { playerId });
  // The OWNER answered, so the owner acted. The answer itself is a token from
  // the platform's own enum; what was said alongside it is not carried.
  if (interestId && outcome) {
    safeFabric('transfer.negotiation.updated', () => publishTransferNegotiationUpdated({
      transferId: interestId, actingClubId: ownerClubId, counterpartyClubId: interestedClubId,
      playerId: asId(playerId), actorUserId,
    }, outcome));
  }
}

/** The three answers an owning club may give. Mirrors `TransferInterestStatus`. */
export type InterestOutcome = 'INVITED' | 'DECLINED' | 'NOT_FOR_SALE';

/**
 * A registered interest reached a priced offer.
 *
 * Fabric only, and the one place a negotiation is recorded as having ENDED
 * well: the interest closes because the club that registered it has escalated
 * to a formal offer, which is what a registered interest is for. Published
 * beside `transfer.offer.created` and not instead of it — the two are different
 * facts about the same commit, and a consumer tracking negotiations should not
 * have to infer the end of one from the start of something else.
 *
 * Nothing is published when no live interest was closed, so a club that offers
 * out of the blue produces one event, not two.
 */
export function emitNegotiationSuperseded(
  interestId: string | null | undefined, ownerClubId: string, interestedClubId: string,
  playerId: string, actorUserId?: string | null,
) {
  if (!interestId) return;
  safeFabric('transfer.negotiation.completed', () => publishTransferNegotiationCompleted({
    transferId: interestId, actingClubId: interestedClubId, counterpartyClubId: ownerClubId,
    playerId: asId(playerId), actorUserId,
  }));
}

export function emitOffer(kind: 'OFFER_CREATED' | 'OFFER_COUNTERED' | 'OFFER_ACCEPTED' | 'OFFER_REJECTED' | 'OFFER_WITHDRAWN',
                          sellerClubId: string, buyerClubId: string, playerId: string, offerId: string,
                          actingClubId?: string | null, actorUserId?: string | null) {
  safeClubs([sellerClubId, buyerClubId], kind, ['offers', 'activity', 'balance', 'notifications'], { playerId, offerId });
  // One canonical event, scoped to whichever of the two clubs did the thing.
  // A transfer involves two clubs; publishing it once per club would record one
  // negotiation twice and make every count on the board double.
  const acting = actingClubId ?? buyerClubId;
  safeFabric(`transfer.offer.${OFFER_STATE[kind].toLowerCase()}`, () => publishTransferOffer({
    transferId: offerId, actingClubId: acting,
    counterpartyClubId: acting === sellerClubId ? buyerClubId : sellerClubId,
    playerId: asId(playerId), actorUserId,
  }, OFFER_STATE[kind]));
}

/**
 * The realtime kind, as the state the record calls it.
 *
 * `OFFER_COUNTERED` is `updated`: a counter is the same negotiation at a
 * different figure, not a new one, and the record follows the registry's names
 * rather than the channel's.
 */
const OFFER_STATE = {
  OFFER_CREATED:   'CREATED',
  OFFER_COUNTERED: 'UPDATED',
  OFFER_ACCEPTED:  'ACCEPTED',
  OFFER_REJECTED:  'REJECTED',
  OFFER_WITHDRAWN: 'WITHDRAWN',
} as const;
export function emitPlayerOffered(fromClubId: string, toClubId: string, playerId: string, needId?: string | null) {
  safeClubs([fromClubId, toClubId], 'PLAYER_OFFERED', ['offers', 'activity', 'needs', 'notifications'], { playerId, needId });
}

// ── a player changes hands ──────────────────────────────────────────────────
// Where a footballer went is a public fact — it is already in the public
// transfer history and on the completed-market feed. What it cost the two
// clubs in budget is not, and does not travel.
export function emitTransferCompleted(
  sellerClubId: string, buyerClubId: string, playerId: string,
  ids: { listingId?: string | null; offerId?: string | null } = {},
  settledBy: TransferSettlement = 'PURCHASE',
  actorUserId?: string | null,
) {
  safePublic('TRANSFER_COMPLETED', ['feed', 'market', 'discover', 'auctions'], { playerId, ...ids });
  safeClubs([sellerClubId, buyerClubId], 'TRANSFER_COMPLETED',
    ['activity', 'balance', 'offers', 'shortlist', 'market', 'notifications'], { playerId, ...ids });

  // TWO events, deliberately, and each exactly once.
  //
  // `transfer.completed` is the DEAL closing: an offer or a listing reached its
  // end, between these two clubs, by this route. `player.transferred` is the
  // FOOTBALLER's club changing, which is a fact about him and belongs to the
  // Players domain whether or not a market was involved. They are not two
  // names for one occurrence, and neither is published a second time anywhere
  // else — this function is the single funnel all three settlement routes
  // already pass through.
  safeFabric('transfer.completed', () => publishTransferCompleted({
    transferId: ids.offerId ?? ids.listingId ?? playerId,
    actingClubId: buyerClubId, playerId: asId(playerId), actorUserId,
  }, sellerClubId, settledBy));
  publishTransferToFabric(sellerClubId, playerId, settledBy);
}

// ── the shortlist ───────────────────────────────────────────────────────────
// Fabric only. A club's shortlist is its own; nothing about it is broadcast to
// anybody, and these do not touch the realtime channel. Both are DURABLE — a
// `TransferTarget` row created, and the same row archived — and the add fires
// only when a row was really created, so asking twice is one event, not two.
//
// The scouting NOTE on the entry never travels. It is a staff member's private
// assessment of a footballer who is frequently a child.
export function emitShortlisted(clubId: string, playerId: string, targetId: string, actorUserId?: string | null) {
  safeFabric('transfer.shortlisted', () => publishTransferShortlisted({
    transferId: targetId, actingClubId: clubId, playerId: asId(playerId), actorUserId,
  }));
}
export function emitUnshortlisted(clubId: string, playerId: string, targetId: string, actorUserId?: string | null) {
  safeFabric('transfer.unshortlisted', () => publishTransferUnshortlisted({
    transferId: targetId, actingClubId: clubId, playerId: asId(playerId), actorUserId,
  }));
}

/** How a transfer was settled. Three routes, one fact. */
export type TransferSettlement = 'PURCHASE' | 'OFFER_ACCEPTED' | 'AUCTION';

/**
 * Tell the Data Fabric a player changed clubs.
 *
 * ONE call, from the one function all three settlement routes already go
 * through. A direct purchase, an accepted offer and a settled auction are three
 * ways of reaching the same fact, and publishing from each of them separately
 * is how the same transfer comes to be recorded two or three times the day
 * somebody adds a fourth route.
 *
 * Detached and self-reading. The player row is, at this point, already the new
 * state — the transaction has committed — so one read gives the envelope its
 * tenant, its team and the squad kind, and the caller waits for none of it. A
 * transfer that has completed must not be undone, delayed, or reported as
 * failed because the fabric was slow.
 *
 * What it does NOT carry is the fee. What a club paid for a player is
 * commercially confidential; the figure is in the transfer record, read under
 * authorisation, and an observability surface gets the fact and the two clubs.
 */
function publishTransferToFabric(
  sellerClubId: string, playerId: string, settledBy: TransferSettlement,
): void {
  void (async () => {
    const { prisma } = require('../config/database') as typeof import('../config/database');
    const { publishPlayerTransferred } = require('../fabric/producers/players.producer') as typeof import('../fabric/producers/players.producer');

    const player = await prisma.player.findUnique({
      where: { id: playerId },
      select: { id: true, clubId: true, teamId: true, team: { select: { kind: true } } },
    });
    if (!player) return;

    publishPlayerTransferred(
      {
        playerId: player.id,
        // The ACQUIRING club. An event has one tenant, and from the moment this
        // commits the player's tenant is the buyer; the club he left is named
        // in the payload instead.
        clubId: player.clubId,
        teamId: player.teamId ?? null,
        sourceType: 'SERVICE',
      },
      sellerClubId,
      settledBy,
      player.team?.kind ?? null,
    );
  })().catch((err) => {
    logger.warn('[market-events] could not record a transfer on the fabric', {
      playerId, err: (err as Error)?.message,
    });
  });
}

// ── club needs ──────────────────────────────────────────────────────────────
// A published need is a public statement; its private note is not on the event
// and the board re-reads /needs, which already withholds it from everyone but
// the author.
export function emitNeedPublished(clubId: string, needId: string) {
  safePublic('NEED_PUBLISHED', ['needs', 'feed', 'discover'], { needId });
  safeClubs([clubId], 'NEED_PUBLISHED', ['needs', 'activity'], { needId });
}
export function emitNeedUpdated(clubId: string, needId: string) {
  safePublic('NEED_UPDATED', ['needs', 'discover'], { needId });
  safeClubs([clubId], 'NEED_UPDATED', ['needs', 'activity'], { needId });
}
export function emitNeedClosed(clubId: string, needId: string) {
  safePublic('NEED_CLOSED', ['needs', 'feed', 'discover'], { needId });
  safeClubs([clubId], 'NEED_CLOSED', ['needs', 'activity'], { needId });
}

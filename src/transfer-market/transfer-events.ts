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

import { publishPublic, publishToClubs, MarketSurface } from '../realtime/market-channel';
import { logger } from '../utils/logger';

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

// ── the market ──────────────────────────────────────────────────────────────
// A listing is an advert. Its existence, its price and its withdrawal are what
// the market is for, so they go to everyone; the seller additionally re-reads
// its own desk.
export function emitListingCreated(sellerClubId: string, playerId: string, listingId: string) {
  safePublic('LISTING_CREATED', ['market', 'feed', 'discover'], { playerId, listingId });
  safeClubs([sellerClubId], 'LISTING_CREATED', ['activity', 'market'], { playerId, listingId });
}
export function emitListingWithdrawn(sellerClubId: string, playerId: string | null, listingId: string) {
  safePublic('LISTING_WITHDRAWN', ['market', 'feed', 'discover'], { playerId, listingId });
  safeClubs([sellerClubId], 'LISTING_WITHDRAWN', ['activity', 'market'], { playerId, listingId });
}

// ── auctions ────────────────────────────────────────────────────────────────
// An auction is public and so is the fact that it moved. The AMOUNT is not on
// the event — the board re-reads /auctions, which decides what each club may
// see — so a bid tells the market only that there has been one.
export function emitAuctionCreated(sellerClubId: string, playerId: string, listingId: string) {
  safePublic('AUCTION_CREATED', ['auctions', 'feed', 'discover'], { playerId, listingId });
  safeClubs([sellerClubId], 'AUCTION_CREATED', ['activity', 'auctions'], { playerId, listingId });
}
export function emitAuctionBid(listingId: string, playerId: string | null, sellerClubId: string, bidderClubId: string, previousLeaderClubId: string | null) {
  safePublic('AUCTION_BID', ['auctions'], { playerId, listingId });
  // The seller sees money on the table; the bidder sees its own commitment
  // change; whoever led before is no longer leading.
  safeClubs([sellerClubId], 'AUCTION_BID', ['activity', 'notifications'], { playerId, listingId });
  safeClubs([bidderClubId], 'AUCTION_BID', ['activity', 'balance'], { playerId, listingId });
  if (previousLeaderClubId && previousLeaderClubId !== bidderClubId) {
    safeClubs([previousLeaderClubId], 'AUCTION_OUTBID', ['auctions', 'activity', 'balance', 'notifications'], { playerId, listingId });
  }
}
export function emitAuctionCancelled(listingId: string, playerId: string | null, sellerClubId: string, bidderClubIds: string[]) {
  safePublic('AUCTION_CANCELLED', ['auctions', 'feed', 'discover'], { playerId, listingId });
  safeClubs([sellerClubId], 'AUCTION_CANCELLED', ['activity', 'auctions'], { playerId, listingId });
  // Their money is no longer committed, and they have been told why.
  safeClubs(bidderClubIds, 'AUCTION_CANCELLED', ['auctions', 'activity', 'balance', 'notifications'], { playerId, listingId });
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
}

// ── negotiation ─────────────────────────────────────────────────────────────
// None of this is public. An interest, an offer, a counter and a rejection are
// between two clubs, and the event goes to exactly those two.
export function emitInterest(ownerClubId: string, interestedClubId: string, playerId: string) {
  safeClubs([ownerClubId], 'INTEREST_REGISTERED', ['activity', 'notifications'], { playerId });
  safeClubs([interestedClubId], 'INTEREST_REGISTERED', ['activity', 'discover'], { playerId });
}
export function emitInterestAnswered(ownerClubId: string, interestedClubId: string, playerId: string) {
  safeClubs([ownerClubId, interestedClubId], 'INTEREST_ANSWERED', ['activity', 'discover', 'notifications'], { playerId });
}
export function emitOffer(kind: 'OFFER_CREATED' | 'OFFER_COUNTERED' | 'OFFER_ACCEPTED' | 'OFFER_REJECTED' | 'OFFER_WITHDRAWN',
                          sellerClubId: string, buyerClubId: string, playerId: string, offerId: string) {
  safeClubs([sellerClubId, buyerClubId], kind, ['offers', 'activity', 'balance', 'notifications'], { playerId, offerId });
}
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
) {
  safePublic('TRANSFER_COMPLETED', ['feed', 'market', 'discover', 'auctions'], { playerId, ...ids });
  safeClubs([sellerClubId, buyerClubId], 'TRANSFER_COMPLETED',
    ['activity', 'balance', 'offers', 'shortlist', 'market', 'notifications'], { playerId, ...ids });
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

// Familista — Realtime transfer-market channel
// ─────────────────────────────────────────────────────────────────────────
// The same thin in-process pub/sub the match channel already is, with a
// different topic. A match's topic is its matchId; here it is a CLUB — plus
// one shared PUBLIC topic for the things the whole market may see.
//
// What travels on it is deliberately not state. An event says WHICH SURFACES
// went stale and, where the identifier is already public, what it was about.
// It never carries a fee, a message, a balance, a bid, a squad or a note. The
// client re-reads the canonical endpoint, which is already authorised, so the
// socket cannot leak anything an HTTP request would have refused — and there
// is no second copy of transfer state to diverge from the database.
//
// Two consequences worth naming. Receiving the same event twice costs one
// extra read and changes nothing, because an invalidation is idempotent. And
// an event that arrives late, or after the screen already refreshed for its
// own reasons, is equally harmless.

export type MarketSurface =
  | 'market'        // the fixed-price board
  | 'auctions'      // the auction board and its detail
  | 'offers'        // direct offers, counters, the negotiation timeline
  | 'needs'         // the club needs board
  | 'activity'      // My Activity / MY CLUB
  | 'feed'          // the public market activity feed
  | 'discover'      // scouting search results
  | 'shortlist'     // the club's TransferTarget list
  | 'balance'       // budget, committed, available
  | 'notifications';

export type MarketEventKind =
  // market
  | 'LISTING_CREATED' | 'LISTING_UPDATED' | 'LISTING_WITHDRAWN' | 'LISTING_COMPLETED'
  // auctions
  | 'AUCTION_CREATED' | 'AUCTION_BID' | 'AUCTION_OUTBID' | 'AUCTION_CANCELLED' | 'AUCTION_SETTLED'
  // negotiation
  | 'INTEREST_REGISTERED' | 'INTEREST_ANSWERED'
  | 'OFFER_CREATED' | 'OFFER_COUNTERED' | 'OFFER_ACCEPTED' | 'OFFER_REJECTED' | 'OFFER_WITHDRAWN'
  | 'PLAYER_OFFERED'
  // needs
  | 'NEED_PUBLISHED' | 'NEED_UPDATED' | 'NEED_CLOSED'
  // ownership
  | 'TRANSFER_COMPLETED';

/** Where an event may go. PUBLIC reaches every connected club; CLUB reaches
 *  exactly the clubs named on it. */
export type MarketScope = 'PUBLIC' | 'CLUB';

export interface MarketEvent {
  kind: MarketEventKind;
  scope: MarketScope;
  /** Which screens this makes stale. The client re-reads only these. */
  surfaces: MarketSurface[];
  /** Public identifiers only, and only when the identifier is already public.
   *  A private event carries the ids the two clubs in it can already read. */
  playerId?: string | null;
  listingId?: string | null;
  offerId?: string | null;
  needId?: string | null;
  at: string;
}

type Subscriber = (event: MarketEvent) => void;

// clubId -> subscribers of that club's private stream
const clubSubscribers: Map<string, Set<Subscriber>> = new Map();
// everyone connected, for the public stream
const publicSubscribers: Set<Subscriber> = new Set();

export function subscribeClub(clubId: string, fn: Subscriber): () => void {
  let set = clubSubscribers.get(clubId);
  if (!set) { set = new Set(); clubSubscribers.set(clubId, set); }
  set.add(fn);
  return () => {
    const cur = clubSubscribers.get(clubId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) clubSubscribers.delete(clubId);
  };
}

export function subscribePublic(fn: Subscriber): () => void {
  publicSubscribers.add(fn);
  return () => publicSubscribers.delete(fn);
}

/** Publish to the whole market. Only for facts the market may see. */
export function publishPublic(event: Omit<MarketEvent, 'scope' | 'at'>): void {
  const full: MarketEvent = { ...event, scope: 'PUBLIC', at: new Date().toISOString() };
  for (const fn of publicSubscribers) {
    try { fn(full); } catch (_err) { /* one bad socket never stops the rest */ }
  }
}

/** Publish to named clubs only. Duplicates in `clubIds` are collapsed, and a
 *  club is never sent the same event twice for being named twice. */
export function publishToClubs(clubIds: Array<string | null | undefined>, event: Omit<MarketEvent, 'scope' | 'at'>): void {
  const full: MarketEvent = { ...event, scope: 'CLUB', at: new Date().toISOString() };
  for (const clubId of new Set(clubIds.filter(Boolean) as string[])) {
    const set = clubSubscribers.get(clubId);
    if (!set) continue;
    for (const fn of set) {
      try { fn(full); } catch (_err) { /* swallow */ }
    }
  }
}

export function marketSubscriberCount(clubId?: string): number {
  if (clubId) return clubSubscribers.get(clubId)?.size ?? 0;
  let n = 0;
  for (const s of clubSubscribers.values()) n += s.size;
  return n;
}

// Familista — the Open Market
// ─────────────────────────────────────────────────────────────────────────────
// A public marketplace every eligible club sees, containing only the players
// their clubs have explicitly published to it. It is not "every registered
// player": nothing appears here that a club did not put here.
//
// It is not a second market either. An Open Market listing IS the MarketplaceItem
// a listing has always been, with one field added to its payload saying which
// channel it belongs to. When bidding is enabled it also carries `mode:
// 'AUCTION'`, which is what makes the bidding engine that already exists work on
// it unchanged — the same TransferBid rows, the same eight checks inside the
// same transaction, the same "highest bid is MAX() over the rows and therefore
// cannot be corrupted by two clubs bidding in the same instant".
//
// So there is exactly one bidding implementation, one settlement path, and one
// place a player can be on the market. What this file adds is the publication
// with its terms, the public read, and the two things a seller may do to a
// listing whose time is up: extend the row it already has, or close it.

import { MarketplaceItem, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { publicClubSelect, publicPlayerSelect, toPublicPlayer, UNKNOWN_CLUB } from './public-player';
import {
  MarketActor, findActiveListingForPlayer, pendingOfferForPlayer, setAvailability, isOpenMarket,
} from './transfer-market.service';
import { requiredBid, settleDueAuctions } from './transfer-auction.service';
import { emitAuctionCreated, emitListingWithdrawn } from './transfer-events';

const KIND = 'TRANSFER_LISTING' as const;
export const OPEN_MARKET = 'OPEN_MARKET' as const;

// Which channel a listing belongs to. Everything written before this existed
// has no channel and is a direct listing, which is what it has always been —
// so the Live Market keeps showing exactly what it showed.
export function channelOf(item: { payload: Prisma.JsonValue }): string {
  const pl = (item.payload ?? {}) as Record<string, unknown>;
  return typeof pl.channel === 'string' ? pl.channel : 'DIRECT';
}
export { isOpenMarket };

const terms = (item: MarketplaceItem) => {
  const pl = (item.payload ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    playerId: typeof pl.playerId === 'string' ? pl.playerId : null,
    askingPriceEur: num(pl.askingPriceEur) ?? num(pl.startingPriceEur) ?? 0,
    minAcceptableEur: num(pl.minAcceptableEur),
    biddingEnabled: pl.mode === 'AUCTION',
    negotiationAllowed: pl.negotiationAllowed !== false,
    note: typeof pl.note === 'string' ? pl.note : null,
  };
};

function readMoneyOrNull(v: unknown, where: string): number | null {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequestError(`${where} is not a number`);
  if (n < 0) throw new BadRequestError(`${where} cannot be negative`);
  return Math.round(n);
}

// ── publishing ───────────────────────────────────────────────────────────────
export interface OpenMarketDto {
  playerId: string;
  askingPriceEur: number;
  minAcceptableEur?: number | null;
  biddingEnabled?: boolean;
  durationMinutes?: number;
  expiresAt?: string | null;
  negotiationAllowed?: boolean;
  note?: string | null;
}

const MAX_DURATION_MIN = 60 * 24 * 30;   // a month is the longest a listing runs
const DEFAULT_DURATION_MIN = 60 * 24 * 7;

export async function publish(actor: MarketActor, dto: OpenMarketDto): Promise<MarketplaceItem> {
  if (!dto?.playerId) throw new BadRequestError('playerId required');
  const asking = readMoneyOrNull(dto.askingPriceEur, 'askingPriceEur');
  if (asking === null) throw new BadRequestError('askingPriceEur required');
  const minAcceptable = readMoneyOrNull(dto.minAcceptableEur, 'minAcceptableEur');
  if (minAcceptable !== null && minAcceptable > asking) {
    throw new BadRequestError('minAcceptableEur cannot be above the asking price');
  }

  const player = await prisma.player.findUnique({ where: { id: dto.playerId } });
  if (!player) throw new NotFoundError('Player');
  // Ownership is the player row's, never the request's. Any team the club owns
  // is eligible — the First Team and every age group alike, because nothing
  // here asks which team he is in.
  if (player.clubId !== actor.clubId) throw new ForbiddenError('That player belongs to another club');
  if (player.isActive === false) throw new BadRequestError('That player is not active');

  // One place on the market at a time. The same guard the auction and the
  // fixed-price listing already share, so publishing here cannot produce a
  // second listing for a player who is already on it.
  const open = await findActiveListingForPlayer(dto.playerId);
  if (open) throw new ConflictError('That player is already on the market');
  const pending = await pendingOfferForPlayer(dto.playerId);
  if (pending) throw new ConflictError('That player has an open transfer offer — answer it before publishing him');

  let until: Date;
  if (dto.expiresAt) {
    until = new Date(dto.expiresAt);
    if (Number.isNaN(until.getTime())) throw new BadRequestError('expiresAt is not a date');
    if (until.getTime() <= Date.now()) throw new BadRequestError('expiresAt must be in the future');
  } else {
    const mins = Math.min(MAX_DURATION_MIN, Math.max(15, Math.round(dto.durationMinutes ?? DEFAULT_DURATION_MIN)));
    until = new Date(Date.now() + mins * 60_000);
  }

  const bidding = dto.biddingEnabled !== false;
  const row = await prisma.$transaction(async (tx) => {
    const item = await tx.marketplaceItem.create({
      data: {
        clubId: actor.clubId, kind: KIND,
        title: `${player.firstName} ${player.lastName} · ${player.position}`,
        status: 'ACTIVE',
        validFrom: new Date(),
        validUntil: until,
        createdById: actor.userId,
        payload: {
          playerId: player.id, sellerClubId: actor.clubId, sellerTeamId: player.teamId ?? null,
          channel: OPEN_MARKET,
          // `mode: AUCTION` is what lets the existing bidding engine act on this
          // listing. Without bidding it is a published price, and placeBid
          // refuses it exactly as it refuses any non-auction listing.
          ...(bidding ? { mode: 'AUCTION', startingPriceEur: asking } : {}),
          askingPriceEur: asking,
          minAcceptableEur: minAcceptable,
          negotiationAllowed: dto.negotiationAllowed !== false,
          note: dto.note ? String(dto.note).slice(0, 500) : null,
        } as Prisma.InputJsonValue,
      },
    });
    await setAvailability(tx, player, actor, true);
    return item;
  });

  if (bidding) emitAuctionCreated(actor.clubId, player.id, row.id);
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'OPEN_MARKET_PUBLISHED', entityType: 'MarketplaceItem', entityId: row.id,
    payload: { playerId: player.id, askingPriceEur: asking, biddingEnabled: bidding, validUntil: until.toISOString() },
  });
  return row;
}

// ── the public board ─────────────────────────────────────────────────────────
// Platform-wide: every eligible club reads the same listings. A club's own
// listing is returned too — it is public, and hiding it would mean the seller
// could not see what everybody else sees — but flagged, and the bidding engine
// refuses a bid from the owning club regardless of what any screen shows.
export async function readOpenMarket(actor: MarketActor, opts: { includeClosed?: boolean } = {}) {
  await settleDueAuctions();
  const rows = await prisma.marketplaceItem.findMany({
    where: {
      kind: KIND,
      status: opts.includeClosed ? { in: ['ACTIVE', 'SOLD', 'UNSOLD', 'CANCELLED'] } : 'ACTIVE',
    },
    orderBy: [{ validUntil: 'asc' }], take: 200,
  });
  const open = rows.filter(isOpenMarket);
  if (!open.length) return { items: [], total: 0 };

  const ids = open.map((o) => o.id);
  const playerIds = open.map((o) => terms(o).playerId).filter(Boolean) as string[];
  const [bids, players, clubs] = await Promise.all([
    prisma.transferBid.findMany({ where: { listingId: { in: ids } }, orderBy: { amountEur: 'desc' } }),
    prisma.player.findMany({ where: { id: { in: playerIds } }, select: publicPlayerSelect }),
    prisma.club.findMany({
      where: { id: { in: [...new Set(open.map((o) => o.clubId))] } }, select: publicClubSelect,
    }),
  ]);
  const bidderIds = [...new Set(bids.map((b) => b.bidderClubId))];
  const extra = await prisma.club.findMany({ where: { id: { in: bidderIds } }, select: publicClubSelect });
  const all = [...clubs, ...extra.filter((e) => !clubs.some((c) => c.id === e.id))];
  const club = (id: string | null) => (id ? all.find((c) => c.id === id) ?? UNKNOWN_CLUB(id) : null);

  const items = open.map((o) => {
    const t = terms(o);
    const mine = bids.filter((b) => b.listingId === o.id);
    const top = mine[0] ?? null;                          // ordered by amount desc
    const highest = top ? Number(top.amountEur) : null;
    const myBids = mine.filter((b) => b.bidderClubId === actor.clubId);
    const p = players.find((x) => x.id === t.playerId);
    return {
      listingId: o.id,
      status: o.status,
      player: p ? toPublicPlayer(p) : null,
      playerId: t.playerId,
      sellerClub: club(o.clubId),
      askingPriceEur: t.askingPriceEur,
      // The floor is the seller's business, not the market's: it is returned to
      // the club that set it and to nobody else.
      minAcceptableEur: o.clubId === actor.clubId ? t.minAcceptableEur : null,
      biddingEnabled: t.biddingEnabled,
      negotiationAllowed: t.negotiationAllowed,
      note: t.note,
      highestBidEur: highest,
      highestBidderClub: top ? club(top.bidderClubId) : null,
      bidCount: mine.length,
      requiredBidEur: t.biddingEnabled ? requiredBid(t.askingPriceEur, highest) : null,
      validUntil: o.validUntil,
      expired: !!o.validUntil && o.validUntil.getTime() <= Date.now(),
      isMine: o.clubId === actor.clubId,
      myBidEur: myBids.length ? Math.max(...myBids.map((b) => Number(b.amountEur))) : null,
      iLead: !!top && top.bidderClubId === actor.clubId,
      settledAt: o.settledAt,
      winnerClub: club(o.winnerClubId),
      finalPriceEur: o.finalPriceEur === null ? null : Number(o.finalPriceEur),
    };
  });
  return { items, total: items.length };
}

// One listing with its bid history, oldest first — the drawer's read.
export async function readOpenListing(actor: MarketActor, listingId: string) {
  const item = await prisma.marketplaceItem.findUnique({ where: { id: listingId } });
  if (!item || item.kind !== KIND || !isOpenMarket(item)) throw new NotFoundError('Open market listing');
  const t = terms(item);
  const [bids, player, seller] = await Promise.all([
    prisma.transferBid.findMany({ where: { listingId }, orderBy: { createdAt: 'asc' } }),
    t.playerId ? prisma.player.findUnique({ where: { id: t.playerId }, select: publicPlayerSelect }) : null,
    prisma.club.findUnique({ where: { id: item.clubId }, select: publicClubSelect }),
  ]);
  const bidderIds = [...new Set(bids.map((b) => b.bidderClubId))];
  const clubs = await prisma.club.findMany({ where: { id: { in: bidderIds } }, select: publicClubSelect });
  const name = (id: string) => clubs.find((c) => c.id === id) ?? UNKNOWN_CLUB(id);
  const highest = bids.length ? Math.max(...bids.map((b) => Number(b.amountEur))) : null;
  return {
    listingId: item.id,
    status: item.status,
    player: player ? toPublicPlayer(player) : null,
    sellerClub: seller ?? UNKNOWN_CLUB(item.clubId),
    askingPriceEur: t.askingPriceEur,
    minAcceptableEur: item.clubId === actor.clubId ? t.minAcceptableEur : null,
    biddingEnabled: t.biddingEnabled,
    negotiationAllowed: t.negotiationAllowed,
    note: t.note,
    validUntil: item.validUntil,
    expired: !!item.validUntil && item.validUntil.getTime() <= Date.now(),
    isMine: item.clubId === actor.clubId,
    highestBidEur: highest,
    requiredBidEur: t.biddingEnabled ? requiredBid(t.askingPriceEur, highest) : null,
    // The history, as it happened. Immutable rows, in the order they were made.
    bids: bids.map((b) => ({
      id: b.id, club: name(b.bidderClubId), amountEur: Number(b.amountEur),
      createdAt: b.createdAt, isMine: b.bidderClubId === actor.clubId,
    })),
    winnerClub: item.winnerClubId ? name(item.winnerClubId) : null,
    finalPriceEur: item.finalPriceEur === null ? null : Number(item.finalPriceEur),
  };
}

// ── extending, and closing without a sale ────────────────────────────────────
// Extending moves the deadline on the row that already exists. It never creates
// a second listing, and the bids already lodged against it stay exactly where
// they are — which is the whole point of extending rather than relisting.
export async function extendListing(actor: MarketActor, listingId: string, minutes: number) {
  const mins = Math.min(MAX_DURATION_MIN, Math.max(15, Math.round(Number(minutes) || 0)));
  if (!mins) throw new BadRequestError('minutes required');
  const item = await prisma.marketplaceItem.findUnique({ where: { id: listingId } });
  if (!item || item.kind !== KIND || !isOpenMarket(item)) throw new NotFoundError('Open market listing');
  if (item.clubId !== actor.clubId) throw new ForbiddenError('Only the selling club may extend its listing');
  if (item.status !== 'ACTIVE') throw new ConflictError('That listing is no longer open');

  // From now, or from the deadline if it has not passed — extending a listing
  // with an hour left should add to it, not restart it.
  const base = item.validUntil && item.validUntil.getTime() > Date.now() ? item.validUntil.getTime() : Date.now();
  const until = new Date(base + mins * 60_000);
  const row = await prisma.marketplaceItem.update({
    where: { id: listingId }, data: { validUntil: until },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'OPEN_MARKET_EXTENDED', entityType: 'MarketplaceItem', entityId: listingId,
    payload: { minutes: mins, validUntil: until.toISOString() },
  });
  return { listingId, validUntil: row.validUntil };
}

// Closing without a sale. The player was never anywhere but his own squad, so
// nothing moves; the listing simply stops being on the market.
export async function closeListing(actor: MarketActor, listingId: string) {
  const item = await prisma.marketplaceItem.findUnique({ where: { id: listingId } });
  if (!item || item.kind !== KIND || !isOpenMarket(item)) throw new NotFoundError('Open market listing');
  if (item.clubId !== actor.clubId) throw new ForbiddenError('Only the selling club may close its listing');
  if (item.status !== 'ACTIVE') return { listingId, status: item.status };

  const t = terms(item);
  const row = await prisma.$transaction(async (tx) => {
    const claimed = await tx.marketplaceItem.updateMany({
      where: { id: listingId, status: 'ACTIVE' },
      data: { status: 'CANCELLED', settledAt: new Date() },
    });
    if (!claimed.count) throw new ConflictError('That listing is no longer open');
    if (t.playerId) {
      const p = await tx.player.findUnique({ where: { id: t.playerId } });
      if (p) await setAvailability(tx, p, actor, false);
    }
    return tx.marketplaceItem.findUnique({ where: { id: listingId } });
  });
  emitListingWithdrawn(actor.clubId, t.playerId ?? '', listingId);
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'OPEN_MARKET_CLOSED', entityType: 'MarketplaceItem', entityId: listingId,
    payload: { playerId: t.playerId },
  });
  return { listingId, status: row?.status ?? 'CANCELLED' };
}

// Familista — real, server-held auctions
// ─────────────────────────────────────────────────────────────────────────────
// This is not a second transfer engine. An auction is the MarketplaceItem a
// listing already was, TransferBid is the one thing that had no home, and the
// money, the ownership and the history all move through the same records every
// other transfer on this platform moves through.
import { MarketplaceItem, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { getBalance, setAvailability, defaultTeamFor, findActiveListingForPlayer,
         pendingOfferForPlayer, closeCompetingState, archiveShortlistAfterTransfer } from './transfer-market.service';
import { notifyClub, fmt as fmtEur } from './transfer-negotiation.service';
import { publicClubSelect, publicPlayerSelect, toPublicPlayer, UNKNOWN_CLUB } from './public-player';

// the same actor shape the rest of the module uses
export interface MarketActor { userId: string; clubId: string; role?: string }

const KIND = 'TRANSFER_LISTING' as const;

async function clubName(clubId: string) {
  const c = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });
  return c?.name ?? 'Unknown / unavailable club';
}

// ══════════════════════════════════════════════════════════════════════════════
// AUCTIONS — a real one, held by the server
// ══════════════════════════════════════════════════════════════════════════════
// An auction is the same MarketplaceItem a fixed-price listing is, with
// `mode: 'AUCTION'` in its payload and a deadline in validUntil. What makes it
// an auction is TransferBid: one immutable row per bid.
//
// The current highest bid is never stored. It is MAX(amountEur) over those
// rows, which is the reason two clubs bidding in the same instant cannot
// corrupt it — there is nothing to overwrite, and the answer is the same
// whichever order the two inserts commit in. Both bids are real, both are kept,
// and the lower one is simply outbid.
//
// The one place that genuinely races is settlement, and it is settled the way
// purchase() already claims a listing: exactly one caller may take the row out
// of ACTIVE, and everything else happens inside that same transaction.
const AUCTION_MIN_STEP = 100_000;                 // €100k, the smallest raise

/** The least a club may bid next: the highest bid so far plus a step, or the
 *  starting price if nobody has bid. Derived, never stored. */
export function requiredBid(startingPriceEur: number, highestEur: number | null): number {
  if (highestEur === null) return Math.max(0, Math.round(startingPriceEur));
  const step = Math.max(AUCTION_MIN_STEP, Math.round((highestEur * 0.05) / AUCTION_MIN_STEP) * AUCTION_MIN_STEP);
  return highestEur + step;
}

const auctionPayload = (item: MarketplaceItem) => {
  const pl = (item.payload ?? {}) as Record<string, unknown>;
  return {
    playerId: typeof pl.playerId === 'string' ? pl.playerId : null,
    startingPriceEur: typeof pl.startingPriceEur === 'number' ? pl.startingPriceEur
      : typeof pl.askingPriceEur === 'number' ? pl.askingPriceEur : 0,
    isAuction: pl.mode === 'AUCTION',
  };
};

// ── listing a player for auction ────────────────────────────────────────────
export interface AuctionDto { playerId: string; startingPriceEur: number; minutes?: number }

export async function listAuction(actor: MarketActor, dto: AuctionDto): Promise<MarketplaceItem> {
  if (!dto?.playerId || typeof dto.startingPriceEur !== 'number' || dto.startingPriceEur < 0) {
    throw new BadRequestError('playerId + startingPriceEur required');
  }
  const player = await prisma.player.findUnique({ where: { id: dto.playerId } });
  if (!player) throw new NotFoundError('Player');
  // Ownership is the player row's, never the request's.
  if (player.clubId !== actor.clubId) throw new ForbiddenError('That player belongs to another club');
  if (player.isActive === false) throw new BadRequestError('That player is not active');
  const open = await findActiveListingForPlayer(dto.playerId);
  if (open) throw new ConflictError('That player is already on the market');
  // And he cannot be auctioned while a direct negotiation is open on him. An
  // auction that ends has to award the player; an offer that is accepted has to
  // move him. Only one of the two can be true.
  const pending = await pendingOfferForPlayer(dto.playerId);
  if (pending) throw new ConflictError('That player has an open transfer offer — answer it before auctioning him');

  const minutes = Math.min(60 * 24 * 7, Math.max(1, Math.round(dto.minutes ?? 15)));
  const row = await prisma.$transaction(async (tx) => {
    const item = await tx.marketplaceItem.create({
      data: {
        clubId: actor.clubId, kind: KIND,
        title: `${player.firstName} ${player.lastName} · ${player.position}`,
        status: 'ACTIVE',
        validFrom: new Date(),
        validUntil: new Date(Date.now() + minutes * 60_000),
        createdById: actor.userId,
        payload: {
          playerId: player.id, sellerClubId: actor.clubId, sellerTeamId: player.teamId ?? null,
          mode: 'AUCTION',
          startingPriceEur: Math.round(dto.startingPriceEur),
          // kept so every reader of a listing, auction or not, finds a price
          askingPriceEur: Math.round(dto.startingPriceEur),
        } as Prisma.InputJsonValue,
      },
    });
    await setAvailability(tx, player, actor, true);
    return item;
  });

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'AUCTION_LISTED', entityType: 'MarketplaceItem', entityId: row.id,
    payload: { playerId: player.id, startingPriceEur: Math.round(dto.startingPriceEur), minutes },
  });
  return row;
}

// ── bidding ─────────────────────────────────────────────────────────────────
// Eight checks, all inside the transaction that writes the bid, all answered
// from the database rather than from anything the browser said.
export async function placeBid(actor: MarketActor, listingId: string, amountEur: number) {
  const amount = Math.round(Number(amountEur));
  if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestError('amountEur must be a positive number');

  // 6 · the bidder is a canonical club, resolved server-side
  const bidder = await prisma.club.findUnique({ where: { id: actor.clubId }, select: { id: true, name: true } });
  if (!bidder) throw new ForbiddenError('Unknown club');

  const result = await prisma.$transaction(async (tx) => {
    // 1 · the listing exists and is an auction
    const item = await tx.marketplaceItem.findUnique({ where: { id: listingId } });
    if (!item || item.kind !== KIND) throw new NotFoundError('Auction');
    const { playerId, startingPriceEur, isAuction } = auctionPayload(item);
    if (!isAuction) throw new BadRequestError('That listing is not an auction');
    if (!playerId) throw new BadRequestError('Listing is missing its player');
    // 2 · it is open
    if (item.status !== 'ACTIVE') throw new ConflictError('That auction is no longer open');
    // 3 · and has not expired
    if (!item.validUntil || item.validUntil.getTime() <= Date.now()) throw new ConflictError('That auction has closed');
    // 5 · the seller cannot bid on his own player
    if (item.clubId === actor.clubId) throw new ForbiddenError('A club cannot bid on its own player');
    // 4 · the seller still owns him
    const player = await tx.player.findUnique({ where: { id: playerId } });
    if (!player) throw new NotFoundError('Player');
    if (player.clubId !== item.clubId) throw new ConflictError('That player no longer belongs to the selling club');

    // 7 · the bid beats what is on the table
    const top = await tx.transferBid.findFirst({
      where: { listingId }, orderBy: [{ amountEur: 'desc' }, { createdAt: 'asc' }],
    });
    const highest = top ? Number(top.amountEur) : null;
    const need = requiredBid(startingPriceEur, highest);
    if (amount < need) throw new ConflictError(`The next bid must be at least ${fmtEur(need)}`);

    // 8 · and the club can cover it. Its other live bids are committed money
    // too — a club cannot lead three auctions it can only afford one of.
    const balance = await getBalance(actor.clubId);
    const otherLeads = await leadingCommitment(tx, actor.clubId, listingId);
    if (balance.availableEur - otherLeads < amount) throw new BadRequestError('Insufficient transfer budget');

    const bid = await tx.transferBid.create({
      data: { listingId, bidderClubId: actor.clubId, amountEur: BigInt(amount), createdById: actor.userId },
    });
    return { bid, item, playerId, player, previousLeader: top?.bidderClubId ?? null, highest };
  });

  // The seller hears that money is on the table; whoever led before hears that
  // they no longer do. Both kinds already exist.
  const player = result.player;
  const name = `${player.firstName} ${player.lastName}`;
  await notifyClub(result.item.clubId, 'AUCTION_BID_RECEIVED',
    `${bidder.name} bid ${fmtEur(amount)} for ${name}.`, null,
    { type: 'AUCTION_BID_RECEIVED', listingId, playerId: result.playerId, clubId: bidder.id, amountEur: amount });
  if (result.previousLeader && result.previousLeader !== actor.clubId) {
    await notifyClub(result.previousLeader, 'AUCTION_LOST',
      `You have been outbid on ${name} — the bid is now ${fmtEur(amount)}.`, null,
      { type: 'OUTBID', listingId, playerId: result.playerId, amountEur: amount });
  }

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'AUCTION_BID_PLACED', entityType: 'MarketplaceItem', entityId: listingId,
    payload: { bidId: result.bid.id, amountEur: amount, playerId: result.playerId },
  });
  return { bidId: result.bid.id, listingId, amountEur: amount, playerId: result.playerId };
}

// What a club has already committed by leading other live auctions.
// What this club's live auction leads already promise. purchase() and
// acceptOffer() need the same figure placeBid() has always used — a euro
// promised to an auction it is winning is not a euro it can also spend on a
// listing — so the transaction-scoped version is wrapped for callers that
// have their own transaction, and for those that do not.
export async function leadingCommitmentInTx(tx: Prisma.TransactionClient, clubId: string) {
  return leadingCommitment(tx, clubId, '');
}
export async function leadingCommitmentFor(clubId: string) {
  return leadingCommitment(prisma as unknown as Prisma.TransactionClient, clubId, '');
}

async function leadingCommitment(tx: Prisma.TransactionClient, clubId: string, exceptListingId: string) {
  const live = await tx.marketplaceItem.findMany({
    where: { kind: KIND, status: 'ACTIVE', id: { not: exceptListingId }, validUntil: { gt: new Date() } },
    select: { id: true }, take: 200,
  });
  if (!live.length) return 0;
  let total = 0;
  for (const l of live) {
    const top = await tx.transferBid.findFirst({
      where: { listingId: l.id }, orderBy: [{ amountEur: 'desc' }, { createdAt: 'asc' }],
    });
    if (top && top.bidderClubId === clubId) total += Number(top.amountEur);
  }
  return total;
}

// ── the seller withdraws ────────────────────────────────────────────────────
export async function cancelAuction(actor: MarketActor, listingId: string) {
  const item = await prisma.marketplaceItem.findUnique({ where: { id: listingId } });
  if (!item || item.kind !== KIND) throw new NotFoundError('Auction');
  if (item.clubId !== actor.clubId) throw new ForbiddenError('That listing belongs to another club');
  if (item.status !== 'ACTIVE') throw new ConflictError('That auction is no longer open');

  const claimed = await prisma.marketplaceItem.updateMany({
    where: { id: listingId, status: 'ACTIVE' }, data: { status: 'CANCELLED', settledAt: new Date() },
  });
  if (claimed.count === 0) throw new ConflictError('That auction is no longer open');
  const { playerId } = auctionPayload(item);
  if (playerId) {
    const player = await prisma.player.findUnique({ where: { id: playerId } });
    if (player) await prisma.$transaction((tx) => setAvailability(tx, player, actor, false));
  }
  // Every club that had money on the table hears that it came off. Their bids
  // stay on the record — a bid is an immutable event — but nothing of theirs is
  // still committed to an auction that no longer exists, and none of them
  // should have to discover that by looking. The kind is the one the enum
  // already has; the message says which of the two things happened, because
  // "cancelled by the seller" and "outbid" are not the same news.
  await notifyBiddersOfCancellation(listingId, playerId, actor.clubId, 'the selling club withdrew it');

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'AUCTION_CANCELLED', entityType: 'MarketplaceItem', entityId: listingId, payload: { playerId },
  });
  return { listingId, status: 'CANCELLED' as const };
}

// One message per bidding club, never one per bid, and never to a club that was
// not in the auction.
async function notifyBiddersOfCancellation(
  listingId: string, playerId: string | null, sellerClubId: string, because: string,
) {
  const bids = await prisma.transferBid.findMany({
    where: { listingId }, select: { bidderClubId: true },
  });
  const clubs = [...new Set(bids.map((b) => b.bidderClubId))].filter((c) => c !== sellerClubId);
  if (!clubs.length) return 0;
  const [player, seller] = await Promise.all([
    playerId ? prisma.player.findUnique({ where: { id: playerId }, select: { firstName: true, lastName: true } }) : null,
    clubName(sellerClubId),
  ]);
  const name = player ? `${player.firstName} ${player.lastName}` : 'that player';
  for (const c of clubs) {
    await notifyClub(c, 'AUCTION_LOST',
      `The auction for ${name} was cancelled — ${because}.`,
      `${seller} ended the auction before it closed. Nobody won it, and your bid no longer stands.`,
      { type: 'AUCTION_CANCELLED', listingId, playerId, clubId: sellerClubId, outcome: 'CANCELLED' });
  }
  return clubs.length;
}

// ── A2 · the defensive path ─────────────────────────────────────────────────
// With a direct offer and an auction now mutually exclusive, accepting an offer
// should never meet a live auction on the same player. If one is somehow there
// anyway, it is CANCELLED — the status Group 5 introduced for exactly this
// outcome — never CLOSED, and the clubs that were bidding are told. The player
// does not vanish out of an auction in silence.
export async function cancelAuctionForSettlement(
  tx: Prisma.TransactionClient, listingId: string, playerId: string | null, sellerClubId: string,
): Promise<{ listingId: string; playerId: string | null; sellerClubId: string } | null> {
  const claimed = await tx.marketplaceItem.updateMany({
    where: { id: listingId, status: 'ACTIVE' },
    data: { status: 'CANCELLED', settledAt: new Date() },
  });
  if (claimed.count === 0) return null;
  // The notification is sent after the transaction commits — see notifyCancelled
  // below — because a message about a transfer that then rolled back is worse
  // than a late one.
  return { listingId, playerId, sellerClubId };
}
export async function notifyCancelled(
  pending: { listingId: string; playerId: string | null; sellerClubId: string } | null,
) {
  if (!pending) return;
  await notifyBiddersOfCancellation(pending.listingId, pending.playerId, pending.sellerClubId,
    'the player was transferred in a direct deal');
}

// ── settlement ──────────────────────────────────────────────────────────────
// An auction ends because its deadline passed, not because a screen said so.
// Every read of the market settles whatever is due first, so the answer a club
// gets is never one settlement behind. It is safe to call from anywhere and at
// any time: the claim below can succeed exactly once per listing.
export async function settleDueAuctions(): Promise<Array<{ listingId: string; status: string }>> {
  // Auctions only. A fixed-price listing also carries a deadline and also
  // lapses, but it has no bids to award and nothing to settle — and if the
  // sweep did not say so, a market holding twenty lapsed listings would spend
  // its whole budget on them and never reach the auction that needs deciding.
  const due = await prisma.marketplaceItem.findMany({
    where: {
      kind: KIND, status: 'ACTIVE', validUntil: { lte: new Date() },
      payload: { path: ['mode'], equals: 'AUCTION' },
    },
    select: { id: true }, take: 20,
  });
  const out: Array<{ listingId: string; status: string }> = [];
  for (const d of due) {
    try { out.push(await settleAuction(d.id)); } catch (_) { /* another caller took it */ }
  }
  return out;
}

export async function settleAuction(listingId: string): Promise<{ listingId: string; status: string }> {
  const settled = await prisma.$transaction(async (tx) => {
    const item = await tx.marketplaceItem.findUnique({ where: { id: listingId } });
    if (!item || item.kind !== KIND) throw new NotFoundError('Auction');
    const { playerId, isAuction } = auctionPayload(item);
    if (!isAuction) throw new BadRequestError('That listing is not an auction');
    if (item.status !== 'ACTIVE') throw new ConflictError('That auction is already settled');
    if (!item.validUntil || item.validUntil.getTime() > Date.now()) throw new ConflictError('That auction is still running');

    const top = await tx.transferBid.findFirst({
      where: { listingId }, orderBy: [{ amountEur: 'desc' }, { createdAt: 'asc' }],
    });

    // Nobody bid: the player stays, no money moves, and nothing is written to
    // his history — he never went anywhere.
    if (!top) {
      const claimed = await tx.marketplaceItem.updateMany({
        where: { id: listingId, status: 'ACTIVE' },
        data: { status: 'UNSOLD', settledAt: new Date() },
      });
      if (claimed.count === 0) throw new ConflictError('That auction is already settled');
      await tx.playerContractStatus.updateMany({ where: { playerId: playerId ?? '' }, data: { isAvailableForTransfer: false } });
      return { listingId, status: 'UNSOLD' as const, winnerClubId: null, feeEur: 0, playerId, bids: 0, sellerClubId: item.clubId, name: '' };
    }

    const feeEur = Number(top.amountEur);
    const winnerClubId = top.bidderClubId;

    const player = await tx.player.findUnique({ where: { id: playerId ?? '' } });
    if (!player) throw new NotFoundError('Player');
    if (player.clubId !== item.clubId) throw new ConflictError('That player no longer belongs to the selling club');

    // The claim. Exactly one caller can take this auction out of ACTIVE, and
    // everything below happens with it.
    const claimed = await tx.marketplaceItem.updateMany({
      where: { id: listingId, status: 'ACTIVE' },
      data: { status: 'SOLD', winnerClubId, finalPriceEur: BigInt(feeEur), settledAt: new Date() },
    });
    if (claimed.count === 0) throw new ConflictError('That auction is already settled');

    // the player changes hands — the same row, once
    const team = await defaultTeamFor(tx, winnerClubId, player.position);
    await tx.player.update({ where: { id: player.id }, data: { clubId: winnerClubId, teamId: team?.id ?? null } });
    // the winner pays, once
    await tx.clubTransferBalance.upsert({
      where: { clubId: winnerClubId },
      update: { spentEur: { increment: BigInt(feeEur) } },
      create: { clubId: winnerClubId, spentEur: BigInt(feeEur) },
    });
    // the seller is paid, once
    await tx.clubTransferBalance.upsert({
      where: { clubId: item.clubId },
      update: { earnedEur: { increment: BigInt(feeEur) } },
      create: { clubId: item.clubId, earnedEur: BigInt(feeEur) },
    });
    // everything else open on this player closes with the auction. There can be
    // no second listing on him — one live advert per player — so this finds
    // pending offers, interests and proposals, and nothing else.
    await closeCompetingState(tx, player.id, item.clubId);

    // one completed transfer, in the shape the platform already records
    await tx.athleteTransferHistory.create({
      data: {
        athleteId: player.id, fromClubRef: item.clubId, toClubRef: winnerClubId,
        feeCents: BigInt(feeEur) * BigInt(100), currency: 'EUR', occurredAt: new Date(),
        payload: { listingId, type: 'AUCTION', bidId: top.id,
                   fromTeamId: player.teamId ?? null, toTeamId: team?.id ?? null } as Prisma.InputJsonValue,
      },
    });

    const bids = await tx.transferBid.count({ where: { listingId } });
    return { listingId, status: 'SOLD' as const, winnerClubId, feeEur, playerId: player.id, bids,
             sellerClubId: item.clubId, name: `${player.firstName} ${player.lastName}` };
  }, { timeout: 20_000, maxWait: 10_000 });

  // Everyone who took part hears the result, through the inbox that already
  // exists and with the kinds the enum already declared.
  if (settled.status === 'SOLD' && settled.winnerClubId) {
    const [seller, winner] = await Promise.all([clubName(settled.sellerClubId), clubName(settled.winnerClubId)]);
    const note = { type: 'AUCTION_SETTLED', listingId, playerId: settled.playerId, feeEur: settled.feeEur,
                   from: settled.sellerClubId, to: settled.winnerClubId, bids: settled.bids };
    await notifyClub(settled.winnerClubId, 'AUCTION_WON',
      `You won ${settled.name} for ${fmtEur(settled.feeEur)}.`, null, note);
    await notifyClub(settled.sellerClubId, 'TRANSFER_COMPLETED',
      `${settled.name} has left for ${winner} for ${fmtEur(settled.feeEur)}.`, null, note);
    await notifyClub(settled.winnerClubId, 'TRANSFER_COMPLETED',
      `${settled.name} has joined from ${seller} for ${fmtEur(settled.feeEur)}.`, null, note);
    // every club that bid and did not win
    const losers = await prisma.transferBid.findMany({
      where: { listingId, bidderClubId: { not: settled.winnerClubId } }, select: { bidderClubId: true },
    });
    for (const c of new Set(losers.map((l) => l.bidderClubId))) {
      await notifyClub(c, 'AUCTION_LOST',
        `${settled.name} went to ${winner} for ${fmtEur(settled.feeEur)}.`, null, note);
    }
    await archiveShortlistAfterTransfer(settled.playerId ?? '', settled.winnerClubId);
  } else if (settled.status === 'UNSOLD') {
    await notifyClub(settled.sellerClubId, 'AUCTION_ENDING',
      'Your auction ended with no bids.', null, { type: 'AUCTION_UNSOLD', listingId, playerId: settled.playerId });
  }
  return { listingId: settled.listingId, status: settled.status };
}

// ── reading auctions ────────────────────────────────────────────────────────
export async function readAuctions(actor: MarketActor) {
  await settleDueAuctions();
  const rows = await prisma.marketplaceItem.findMany({
    where: { kind: KIND, status: { in: ['ACTIVE', 'SOLD', 'UNSOLD', 'CANCELLED'] } },
    orderBy: [{ status: 'asc' }, { validUntil: 'asc' }], take: 120,
  });
  const auctions = rows.filter((r) => auctionPayload(r).isAuction);
  const ids = auctions.map((a) => a.id);
  const [bids, players, clubs] = await Promise.all([
    prisma.transferBid.findMany({ where: { listingId: { in: ids } }, orderBy: { amountEur: 'desc' } }),
    prisma.player.findMany({
      where: { id: { in: auctions.map((a) => auctionPayload(a).playerId).filter(Boolean) as string[] } },
      select: publicPlayerSelect,
    }),
    prisma.club.findMany({
      where: { id: { in: [...new Set(auctions.map((a) => a.clubId)
        .concat(auctions.map((a) => a.winnerClubId).filter(Boolean) as string[])
        ) ] } },
      select: publicClubSelect,
    }),
  ]);
  const bidderIds = [...new Set(bids.map((b) => b.bidderClubId))];
  const extraClubs = await prisma.club.findMany({ where: { id: { in: bidderIds } }, select: publicClubSelect });
  const allClubs = [...clubs, ...extraClubs.filter((e) => !clubs.some((c) => c.id === e.id))];
  const club = (id: string | null) => (id
    ? allClubs.find((c) => c.id === id) ?? UNKNOWN_CLUB(id)
    : null);

  const items = auctions.map((a) => {
    const { playerId, startingPriceEur } = auctionPayload(a);
    const mine = bids.filter((b) => b.listingId === a.id);
    const top = mine[0] ?? null;                  // already ordered by amount desc
    const myBids = mine.filter((b) => b.bidderClubId === actor.clubId);
    const highest = top ? Number(top.amountEur) : null;
    return {
      listingId: a.id,
      status: a.status,
      sellerClub: club(a.clubId),
      player: (() => { const p = players.find((x) => x.id === playerId); return p ? toPublicPlayer(p) : null; })(),
      startingPriceEur,
      highestBidEur: highest,
      highestBidderClub: top ? club(top.bidderClubId) : null,
      bidCount: mine.length,
      requiredBidEur: requiredBid(startingPriceEur, highest),
      validUntil: a.validUntil,
      settledAt: a.settledAt,
      winnerClub: club(a.winnerClubId),
      finalPriceEur: a.finalPriceEur === null ? null : Number(a.finalPriceEur),
      isMine: a.clubId === actor.clubId,
      myBidEur: myBids.length ? Math.max(...myBids.map((b) => Number(b.amountEur))) : null,
      iLead: !!top && top.bidderClubId === actor.clubId,
    };
  });
  return { items };
}

// One auction, with the bids in the order they were made.
export async function readAuction(actor: MarketActor, listingId: string) {
  await settleDueAuctions();
  const item = await prisma.marketplaceItem.findUnique({ where: { id: listingId } });
  if (!item || item.kind !== KIND) throw new NotFoundError('Auction');
  const { playerId, startingPriceEur, isAuction } = auctionPayload(item);
  if (!isAuction) throw new BadRequestError('That listing is not an auction');

  const [bids, player, seller] = await Promise.all([
    prisma.transferBid.findMany({ where: { listingId }, orderBy: { createdAt: 'asc' } }),
    playerId ? prisma.player.findUnique({ where: { id: playerId }, select: publicPlayerSelect }) : null,
    prisma.club.findUnique({ where: { id: item.clubId }, select: publicClubSelect }),
  ]);
  const clubIds = [...new Set(bids.map((b) => b.bidderClubId).concat(item.winnerClubId ? [item.winnerClubId] : []))];
  const clubs = await prisma.club.findMany({ where: { id: { in: clubIds } }, select: publicClubSelect });
  const club = (id: string) => clubs.find((c) => c.id === id) ?? UNKNOWN_CLUB(id);

  const highest = bids.length ? Math.max(...bids.map((b) => Number(b.amountEur))) : null;
  const myBids = bids.filter((b) => b.bidderClubId === actor.clubId);
  return {
    listingId: item.id,
    status: item.status,
    sellerClub: seller ?? UNKNOWN_CLUB(item.clubId),
    player: player ? toPublicPlayer(player) : null,
    startingPriceEur,
    highestBidEur: highest,
    bidCount: bids.length,
    requiredBidEur: requiredBid(startingPriceEur, highest),
    validUntil: item.validUntil,
    settledAt: item.settledAt,
    winnerClub: item.winnerClubId ? club(item.winnerClubId) : null,
    finalPriceEur: item.finalPriceEur === null ? null : Number(item.finalPriceEur),
    isMine: item.clubId === actor.clubId,
    myBidEur: myBids.length ? Math.max(...myBids.map((b) => Number(b.amountEur))) : null,
    // The timeline is public: a bid is a club and an amount, and nothing else
    // about either club travels with it.
    timeline: bids.map((b) => ({
      id: b.id, club: club(b.bidderClubId), amountEur: Number(b.amountEur), at: b.createdAt,
      mine: b.bidderClubId === actor.clubId,
    })),
  };
}

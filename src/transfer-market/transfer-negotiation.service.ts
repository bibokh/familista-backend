// Familista — club-to-club negotiation
// ─────────────────────────────────────────────────────────────────────────────
// A public auction is one way a player changes clubs, and it is the only way
// the market had. It suits a club that will sell to anyone; it suits nobody who
// wants to sell to a particular club, or to ask about a player who is not for
// sale at all. This module is the private half of the same market:
//
//   • interest        — a club says it would like to talk, and names no money
//   • offer           — a club names a fee, and the owner answers it
//   • counter         — the owner names a different fee, pointing at the offer
//   • need            — a club publishes what it is looking for
//   • player offered  — an owner takes a player to a club whose need he fits
//
// It reuses what already exists rather than restating it: ClubTransferBalance
// for the money, Player.clubId for ownership, AthleteTransferHistory for the
// completed move, and the platform's own notification inbox for every message.
// Settlement is the same four movements the auction already performs, in one
// transaction, written once here and shared.
//
// One rule runs through all of it: the club a request is answered for is read
// from the session, never from the request body, and every mutation is checked
// against the row's own sellerClubId / buyerClubId / clubId before it is
// allowed. A club can only ever act as itself.

import { Prisma, TransferOffer, UserNotificationKind } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { getBalance, activeAuctionForPlayer, closeCompetingState, assertCanSpend,
         archiveShortlistAfterTransfer } from './transfer-market.service';
import { settleDueAuctions, leadingCommitmentFor, cancelAuctionForSettlement,
         notifyCancelled } from './transfer-auction.service';
import {
  PublicClub, publicClubSelect, publicPlayerSelect, scoringShape, toPublicPlayer, UNKNOWN_CLUB,
} from './public-player';
import { notifyClub, fmt } from './transfer-notify';
import {
  emitInterest, emitInterestAnswered, emitOffer, emitPlayerOffered,
  emitTransferCompleted, emitNeedPublished, emitNeedUpdated, emitNeedClosed,
} from './transfer-events';

export interface MarketActor { userId: string; clubId: string; role?: string }

const OFFER_TTL_MS = 3 * 24 * 60 * 60 * 1000;   // an unanswered offer lapses

// ── notifications ────────────────────────────────────────────────────────────
// The implementation moved to transfer-notify so the purchase path can reach it
// too; it is re-exported here because half the module already imports it from
// this file, and there is still only one of it.
export { notifyClub, fmt } from './transfer-notify';

// What a club may know about another club: its name and crest. Never its
// budget, its needs' internal notes, or who else it is talking to.
export async function publicClub(clubId: string): Promise<PublicClub> {
  const c = await prisma.club.findUnique({ where: { id: clubId }, select: publicClubSelect });
  // Every club shown anywhere in Transfers comes from this table. A reference
  // that no longer resolves says so; it never gets an invented identity.
  return c ?? UNKNOWN_CLUB(clubId);
}

async function playerOr404(playerId: string) {
  const p = await prisma.player.findUnique({ where: { id: playerId } });
  if (!p) throw new NotFoundError('Player');
  return p;
}

const money = (v: bigint | number) => Number(v);

// ══════════════════════════════════════════════════════════════════════════════
// INTEREST — a club asks about a player it does not own
// ══════════════════════════════════════════════════════════════════════════════
export async function registerInterest(actor: MarketActor, playerId: string, message?: string) {
  const player = await playerOr404(playerId);
  if (player.clubId === actor.clubId) throw new BadRequestError('That player already belongs to your club');

  // Asking twice is the same question, not a second one.
  const open = await prisma.transferInterest.findFirst({
    where: { playerId, interestedClubId: actor.clubId, status: { in: ['OPEN', 'INVITED'] } },
  });
  if (open) return open;

  const row = await prisma.transferInterest.create({
    data: {
      playerId, ownerClubId: player.clubId, interestedClubId: actor.clubId,
      message: message?.slice(0, 500) ?? null, createdById: actor.userId,
    },
  });
  const buyer = await publicClub(actor.clubId);
  await notifyClub(player.clubId, 'TRANSFER_INTEREST',
    `${buyer.name} is interested in ${player.firstName} ${player.lastName}.`,
    message?.slice(0, 500) ?? null,
    { type: 'TRANSFER_INTEREST', interestId: row.id, playerId, clubId: buyer.id, hasFormalOffer: false });

  emitInterest(player.clubId, actor.clubId, playerId);
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'TRANSFER_INTEREST_REGISTERED', entityType: 'TransferInterest', entityId: row.id,
    payload: { playerId, owner: player.clubId },
  });
  return row;
}

// The owner answers: invite an offer, decline, or say he is not for sale. Only
// the owning club may.
export async function respondToInterest(actor: MarketActor, interestId: string, status: 'INVITED' | 'DECLINED' | 'NOT_FOR_SALE') {
  const row = await prisma.transferInterest.findUnique({ where: { id: interestId } });
  if (!row) throw new NotFoundError('Interest');
  if (row.ownerClubId !== actor.clubId) throw new ForbiddenError('That interest was registered with another club');
  if (!['INVITED', 'DECLINED', 'NOT_FOR_SALE'].includes(status)) throw new BadRequestError('Unknown response');

  const updated = await prisma.transferInterest.update({
    where: { id: interestId }, data: { status, respondedAt: new Date() },
  });
  const player = await playerOr404(row.playerId);
  const owner = await publicClub(actor.clubId);
  const said = status === 'INVITED' ? 'invites an offer for' : status === 'DECLINED' ? 'declined your interest in' : 'is not selling';
  await notifyClub(row.interestedClubId, 'TRANSFER_INTEREST',
    `${owner.name} ${said} ${player.firstName} ${player.lastName}.`, null,
    { type: 'TRANSFER_INTEREST', interestId: row.id, playerId: row.playerId, clubId: owner.id, hasFormalOffer: false });
  emitInterestAnswered(actor.clubId, row.interestedClubId, row.playerId);
  return updated;
}

// ══════════════════════════════════════════════════════════════════════════════
// OFFERS — a fee, named by one club and answered by the other
// ══════════════════════════════════════════════════════════════════════════════
// The fee is the number the lifecycle turns on. The three below ride with it:
// they are what the two clubs are agreeing besides the fee, and they are
// carried through a counter so neither side loses what the other proposed.
export interface OfferDto {
  playerId: string; feeEur: number; message?: string; parentOfferId?: string;
  addOnsEur?: number | null; sellOnPct?: number | null; preferredDate?: string | null;
}

// Read the extras off a bid. Absent stays absent — an offer made without them
// is stored exactly as it was before they existed.
function offerExtras(dto: { addOnsEur?: number | null; sellOnPct?: number | null; preferredDate?: string | null }) {
  const addOns = readMoneyOrNull(dto.addOnsEur, 'addOnsEur');
  let sellOn: number | null = null;
  if (dto.sellOnPct !== undefined && dto.sellOnPct !== null && String(dto.sellOnPct).trim() !== '') {
    const n = Number(dto.sellOnPct);
    if (!Number.isFinite(n)) throw new BadRequestError('sellOnPct is not a number');
    if (n < 0 || n > 100) throw new BadRequestError('sellOnPct must be between 0 and 100');
    sellOn = Math.round(n);
  }
  return {
    addOnsEur: addOns === null ? null : BigInt(addOns),
    sellOnPct: sellOn,
    preferredDate: readDate(dto.preferredDate, 'preferredDate'),
  };
}

export async function makeOffer(actor: MarketActor, dto: OfferDto) {
  if (!dto?.playerId) throw new BadRequestError('playerId required');
  const feeEur = Math.round(Number(dto.feeEur));
  if (!Number.isFinite(feeEur) || feeEur <= 0) throw new BadRequestError('feeEur must be a positive number');

  const player = await playerOr404(dto.playerId);
  if (player.clubId === actor.clubId) throw new BadRequestError('That player already belongs to your club');
  if (player.isActive === false) throw new BadRequestError('That player is not active');
  // A player at auction is being sold by auction. Buying him around it would
  // mean tearing down a live auction other clubs are bidding in — which is
  // exactly what used to happen. Bid, or wait for it to end.
  const auction = await activeAuctionForPlayer(dto.playerId);
  if (auction) throw new ConflictError('That player is in an auction — place a bid instead');

  // A club may not offer money it does not have. The auctions it is currently
  // leading are money too: it cannot promise the same euro twice.
  const balance = await getBalance(actor.clubId);
  const committed = await leadingCommitmentFor(actor.clubId);
  if (balance.availableEur - committed < feeEur) throw new BadRequestError('Insufficient transfer budget');

  const row = await prisma.transferOffer.create({
    data: {
      playerId: dto.playerId, sellerClubId: player.clubId, buyerClubId: actor.clubId,
      feeEur: BigInt(feeEur), message: dto.message?.slice(0, 500) ?? null,
      createdByClubId: actor.clubId, createdById: actor.userId,
      expiresAt: new Date(Date.now() + OFFER_TTL_MS),
      ...offerExtras(dto),
    },
  });
  // Interest, once it has a price on it, has been answered.
  await prisma.transferInterest.updateMany({
    where: { playerId: dto.playerId, interestedClubId: actor.clubId, status: { in: ['OPEN', 'INVITED'] } },
    data: { status: 'CLOSED', respondedAt: new Date() },
  });

  const buyer = await publicClub(actor.clubId);
  await notifyClub(player.clubId, 'TRANSFER_OFFER_RECEIVED',
    `${buyer.name} submitted a ${fmt(feeEur)} offer for ${player.firstName} ${player.lastName}.`,
    dto.message?.slice(0, 500) ?? null,
    { type: 'TRANSFER_OFFER_RECEIVED', offerId: row.id, playerId: dto.playerId, clubId: buyer.id, feeEur });

  emitOffer('OFFER_CREATED', player.clubId, actor.clubId, dto.playerId, row.id);
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'TRANSFER_OFFER_MADE', entityType: 'TransferOffer', entityId: row.id,
    payload: { playerId: dto.playerId, feeEur, seller: player.clubId },
  });
  return hydrateOffer(row);
}

// ── a club answers another club's need with one of its own players ──────────
// The seller starts this conversation, which is the only thing that makes it
// different from makeOffer: the same TransferOffer carries it, the same
// counter engine answers it, and the same acceptOffer settles it. There is no
// second negotiation model and no second settlement path.
//
// Two rows are written, both of which already exist. TransferOffer is the
// negotiable instrument — it is what gets countered, accepted and settled.
// PlayerOfferToClub is the platform's existing record of "offered against your
// need", and it is the one that carries needId, so the need stays linked
// without a column being added anywhere. They share (playerId, fromClub,
// toClub), which is how the offer finds its need again when it is read.
export async function offerPlayerToNeed(
  actor: MarketActor,
  dto: { playerId: string; needId: string; askingPriceEur: number; message?: string },
) {
  const feeEur = Math.round(Number(dto?.askingPriceEur));
  if (!Number.isFinite(feeEur) || feeEur <= 0) throw new BadRequestError('askingPriceEur must be a positive number');

  // Ownership is read from the player row, never from the request.
  const player = await playerOr404(dto.playerId);
  if (player.clubId !== actor.clubId) throw new ForbiddenError('That player belongs to another club');
  if (player.isActive === false) throw new BadRequestError('That player is not active');

  // The seller-initiated path is still an offer, and an offer on a player who
  // is at auction collides with it the same way.
  const ownAuction = await activeAuctionForPlayer(dto.playerId);
  if (ownAuction) throw new ConflictError('That player is in an auction — cancel it before offering him directly');

  const need = await prisma.clubRecruitmentNeed.findUnique({ where: { id: dto.needId } });
  if (!need) throw new NotFoundError('Need');
  if (need.clubId === actor.clubId) throw new BadRequestError('That is your own club’s need');
  if (!need.isActive || (need.expiresAt && need.expiresAt.getTime() <= Date.now())) {
    throw new ConflictError('That need is no longer open');
  }

  // One live proposal per player per club. Offering him twice is the same
  // conversation, not two.
  const already = await prisma.transferOffer.findFirst({
    where: { playerId: dto.playerId, sellerClubId: actor.clubId, buyerClubId: need.clubId, status: 'PENDING' },
    select: { id: true },
  });
  if (already) throw new ConflictError('You already have an open offer for this player with that club');

  const m = matchPlayerToNeed(player, {
    positions: need.positions.split(',').filter(Boolean),
    ageMin: need.ageMin, ageMax: need.ageMax, ratingMin: need.ratingMin, ratingMax: need.ratingMax,
    budgetMinEur: need.budgetMinEur === null ? null : Number(need.budgetMinEur),
    budgetMaxEur: need.budgetMaxEur === null ? null : Number(need.budgetMaxEur),
    nationality: need.nationality, preferredFoot: need.preferredFoot, playstyle: need.playstyle,
  }, feeEur);

  const row = await prisma.$transaction(async (tx) => {
    const offer = await tx.transferOffer.create({
      data: {
        playerId: dto.playerId, sellerClubId: actor.clubId, buyerClubId: need.clubId,
        feeEur: BigInt(feeEur), message: dto.message?.slice(0, 500) ?? null,
        createdByClubId: actor.clubId, createdById: actor.userId,
        expiresAt: new Date(Date.now() + OFFER_TTL_MS),
      },
    });
    await tx.playerOfferToClub.create({
      data: {
        playerId: dto.playerId, fromClubId: actor.clubId, toClubId: need.clubId,
        needId: need.id, askingPriceEur: BigInt(feeEur), matchPct: m.pct,
        message: dto.message?.slice(0, 500) ?? null, createdById: actor.userId,
      },
    });
    return offer;
  });

  const from = await publicClub(actor.clubId);
  await notifyClub(need.clubId, 'PLAYER_OFFERED_TO_CLUB',
    `${from.name} offered you ${player.firstName} ${player.lastName} for ${fmt(feeEur)}.`,
    dto.message?.slice(0, 500) ?? `${player.position} · OVR ${player.overallRating} · answers your ${need.positions} requirement.`,
    { type: 'PLAYER_OFFERED_TO_CLUB', offerId: row.id, playerId: dto.playerId, needId: need.id,
      clubId: from.id, feeEur, matchPct: m.pct });

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'PLAYER_OFFERED_TO_NEED', entityType: 'TransferOffer', entityId: row.id,
    payload: { playerId: dto.playerId, needId: need.id, feeEur, to: need.clubId },
  });
  emitPlayerOffered(actor.clubId, need.clubId, dto.playerId, need.id);
  emitOffer('OFFER_CREATED', actor.clubId, need.clubId, dto.playerId, row.id);
  return hydrateOffer(row);
}

// ══════════════════════════════════════════════════════════════════════════════
// THE MARKET'S ACTIVITY — what happened, and who is allowed to know
// ══════════════════════════════════════════════════════════════════════════════
// Two streams, decided here and not by the screen.
//
// PUBLIC is what a football market publishes about itself: a club has said it
// is looking for a player, a club has put one up for sale, and a player has
// moved from one club to another for a fee. All three are statements the clubs
// involved made deliberately, or facts the whole market can see afterwards.
//
// CLUB is the negotiation itself — who offered what to whom, who countered,
// who refused. That reaches the two clubs in it and nobody else, which is the
// same line readOffer and readNegotiation already draw. A club's private note
// on its own need never appears in either stream.
//
// Nothing is stored for this. Every event is read from the rows the platform
// already writes, bounded, and merged newest first.
export type FeedScope = 'PUBLIC' | 'CLUB';
const FEED_TAKE = 30;

export async function readMarketFeed(actor: MarketActor) {
  // Anything whose deadline has passed is settled first, so the feed never
  // reports a market one settlement behind.
  await settleDueAuctions();
  const [needs, listings, history, offers, offered] = await Promise.all([
    // a club said what it is looking for
    prisma.clubRecruitmentNeed.findMany({
      where: { isActive: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'desc' }, take: FEED_TAKE,
    }),
    // a club put a player on the market, or an auction of one ended
    prisma.marketplaceItem.findMany({
      where: { kind: 'TRANSFER_LISTING', status: { in: ['ACTIVE', 'SOLD', 'UNSOLD', 'CANCELLED'] } },
      orderBy: { createdAt: 'desc' }, take: FEED_TAKE,
    }),
    // a player changed clubs
    prisma.athleteTransferHistory.findMany({ orderBy: { occurredAt: 'desc' }, take: FEED_TAKE }),
    // and, for this club alone, the negotiations it is part of
    prisma.transferOffer.findMany({
      where: { OR: [{ sellerClubId: actor.clubId }, { buyerClubId: actor.clubId }] },
      orderBy: { updatedAt: 'desc' }, take: FEED_TAKE,
    }),
    prisma.playerOfferToClub.findMany({
      where: { OR: [{ fromClubId: actor.clubId }, { toClubId: actor.clubId }] },
      orderBy: { createdAt: 'desc' }, take: FEED_TAKE,
    }),
  ]);

  // one lookup per distinct club and player, not one per event
  const clubIds = new Set<string>(), playerIds = new Set<string>();
  needs.forEach((n) => clubIds.add(n.clubId));
  listings.forEach((l) => { clubIds.add(l.clubId); const pl = (l.payload ?? {}) as Record<string, unknown>;
    if (typeof pl.playerId === 'string') playerIds.add(pl.playerId); });
  history.forEach((h) => { if (h.fromClubRef) clubIds.add(h.fromClubRef); if (h.toClubRef) clubIds.add(h.toClubRef); playerIds.add(h.athleteId); });
  offers.forEach((o) => { clubIds.add(o.sellerClubId); clubIds.add(o.buyerClubId); playerIds.add(o.playerId); });
  offered.forEach((o) => { clubIds.add(o.fromClubId); clubIds.add(o.toClubId); playerIds.add(o.playerId); });

  const [clubRows, playerRows] = await Promise.all([
    prisma.club.findMany({ where: { id: { in: [...clubIds] } }, select: { id: true, name: true, shortName: true, emblem: true, crestUrl: true } }),
    prisma.player.findMany({
      where: { id: { in: [...playerIds] } },
      select: { id: true, firstName: true, lastName: true, position: true, overallRating: true, avatar: true },
    }),
  ]);
  const club = (id: string | null) => {
    if (!id) return null;
    return clubRows.find((c) => c.id === id) ?? { id, name: 'Unknown / unavailable club', shortName: null, emblem: null, crestUrl: null };
  };
  const player = (id: string | null) => (id ? playerRows.find((p) => p.id === id) ?? null : null);

  type Item = {
    id: string; at: Date; kind: string; scope: FeedScope; mine: boolean;
    player: unknown; fromClub: unknown; toClub: unknown;
    feeEur: number | null; status: string | null; need: unknown;
  };
  const items: Item[] = [];

  for (const n of needs) {
    items.push({
      id: 'need:' + n.id, at: n.createdAt, kind: 'NEED_PUBLISHED', scope: 'PUBLIC',
      mine: n.clubId === actor.clubId, player: null,
      fromClub: club(n.clubId), toClub: null, feeEur: null, status: n.priority,
      // the criteria the club published — never its private note
      need: { positions: n.positions.split(',').filter(Boolean), ageMin: n.ageMin, ageMax: n.ageMax,
              ratingMin: n.ratingMin, budgetMaxEur: n.budgetMaxEur === null ? null : Number(n.budgetMaxEur) },
    });
  }
  for (const l of listings) {
    const pl = (l.payload ?? {}) as Record<string, unknown>;
    const auction = pl.mode === 'AUCTION';
    // An auction says how it ended because the listing now records it. A
    // completed sale is already carried by the history event below, so what an
    // auction adds here is the listing and the two endings that move nobody.
    const kind = !auction ? 'PLAYER_LISTED'
      : l.status === 'UNSOLD' ? 'AUCTION_UNSOLD'
        : l.status === 'CANCELLED' ? 'AUCTION_CANCELLED'
          : l.status === 'SOLD' ? 'AUCTION_SOLD' : 'AUCTION_LISTED';
    if (!auction && l.status !== 'ACTIVE') continue;   // a bought listing is its transfer
    items.push({
      id: 'listing:' + l.id,
      at: l.status === 'ACTIVE' ? l.createdAt : (l.settledAt ?? l.updatedAt),
      kind, scope: 'PUBLIC',
      mine: l.clubId === actor.clubId || l.winnerClubId === actor.clubId,
      player: player(typeof pl.playerId === 'string' ? pl.playerId : null),
      fromClub: club(l.clubId), toClub: club(l.winnerClubId),
      feeEur: l.finalPriceEur !== null ? Number(l.finalPriceEur)
        : typeof pl.startingPriceEur === 'number' ? pl.startingPriceEur
          : typeof pl.askingPriceEur === 'number' ? pl.askingPriceEur : null,
      status: l.status, need: null,
    });
  }
  for (const h of history) {
    const payload = (h.payload ?? {}) as Record<string, unknown>;
    items.push({
      id: 'transfer:' + h.id, at: h.occurredAt, kind: 'TRANSFER_COMPLETED', scope: 'PUBLIC',
      mine: h.fromClubRef === actor.clubId || h.toClubRef === actor.clubId,
      player: player(h.athleteId), fromClub: club(h.fromClubRef), toClub: club(h.toClubRef),
      feeEur: Number(h.feeCents) / 100,
      status: typeof payload.type === 'string' ? payload.type : payload.listingId ? 'LISTING' : 'TRANSFER',
      need: null,
    });
  }
  for (const o of offers) {
    const kind = o.status === 'ACCEPTED' ? 'OFFER_ACCEPTED'
      : o.status === 'REJECTED' ? 'OFFER_REJECTED'
        : o.status === 'WITHDRAWN' ? 'OFFER_WITHDRAWN'
          : o.status === 'COUNTERED' ? 'OFFER_COUNTERED'
            : o.parentOfferId ? 'COUNTER_MADE'
              : o.createdByClubId === o.sellerClubId ? 'PLAYER_OFFERED' : 'OFFER_MADE';
    items.push({
      id: 'offer:' + o.id, at: o.updatedAt ?? o.createdAt, kind, scope: 'CLUB', mine: true,
      player: player(o.playerId), fromClub: club(o.sellerClubId), toClub: club(o.buyerClubId),
      feeEur: money(o.feeEur), status: o.status, need: null,
    });
  }
  for (const o of offered) {
    items.push({
      id: 'p2c:' + o.id, at: o.createdAt, kind: 'PLAYER_OFFERED_TO_CLUB', scope: 'CLUB', mine: true,
      player: player(o.playerId), fromClub: club(o.fromClubId), toClub: club(o.toClubId),
      feeEur: o.askingPriceEur === null ? null : Number(o.askingPriceEur), status: o.status, need: null,
    });
  }

  items.sort((a, b) => b.at.getTime() - a.at.getTime());
  return {
    items: items.slice(0, 60),
    counts: {
      listings: listings.length,
      needs: needs.length,
      negotiations: offers.filter((o) => o.status === 'PENDING').length,
      completed: history.filter((h) => h.fromClubRef === actor.clubId || h.toClubRef === actor.clubId).length,
    },
  };
}

// ── the market's completed moves, for everyone ──────────────────────────────
// Where players actually went. A completed transfer is a public fact — both
// clubs, the fee and the date — and it is read from the history settlement
// writes, never from anything the screen believes.
export async function readMarketCompleted() {
  const rows = await prisma.athleteTransferHistory.findMany({ orderBy: { occurredAt: 'desc' }, take: 60 });
  const items = await Promise.all(rows.map(async (h) => {
    const payload = (h.payload ?? {}) as Record<string, unknown>;
    const [from, to, player] = await Promise.all([
      h.fromClubRef ? publicClub(h.fromClubRef) : null,
      h.toClubRef ? publicClub(h.toClubRef) : null,
      prisma.player.findUnique({
        where: { id: h.athleteId },
        select: { id: true, firstName: true, lastName: true, position: true, overallRating: true, avatar: true },
      }),
    ]);
    return {
      id: h.id, playerId: h.athleteId, player, from, to,
      feeEur: Number(h.feeCents) / 100, occurredAt: h.occurredAt,
      type: typeof payload.type === 'string' ? payload.type : payload.listingId ? 'LISTING' : 'TRANSFER',
    };
  }));
  return { items };
}

// ── what a club has actually done: the completed moves ──────────────────────
// Read out of AthleteTransferHistory, which settlement already writes once per
// transfer. Nothing is recorded here and nothing is recomputed: this is the
// existing record, with the two clubs named so a manager can see where the
// player he sold actually went.
export async function readCompletedDeals(actor: MarketActor) {
  const rows = await prisma.athleteTransferHistory.findMany({
    where: { OR: [{ fromClubRef: actor.clubId }, { toClubRef: actor.clubId }] },
    orderBy: { occurredAt: 'desc' }, take: 100,
  });
  const items = await Promise.all(rows.map(async (h) => {
    const payload = (h.payload ?? {}) as Record<string, unknown>;
    const [from, to, player] = await Promise.all([
      h.fromClubRef ? publicClub(h.fromClubRef) : null,
      h.toClubRef ? publicClub(h.toClubRef) : null,
      prisma.player.findUnique({
        where: { id: h.athleteId },
        select: { id: true, firstName: true, lastName: true, position: true, overallRating: true, avatar: true },
      }),
    ]);
    return {
      id: h.id, playerId: h.athleteId, player,
      from, to, feeEur: Number(h.feeCents) / 100, occurredAt: h.occurredAt,
      // The origin as settlement recorded it: a direct transfer names itself,
      // a listing carries its listingId. Nothing is guessed.
      type: typeof payload.type === 'string' ? payload.type
        : payload.listingId ? 'LISTING' : 'TRANSFER',
      direction: h.toClubRef === actor.clubId ? 'IN' : 'OUT',
    };
  }));
  return { items };
}

// Which side of an offer this club is on. Anyone else is not entitled to know
// the offer exists at all.
function sideOf(offer: TransferOffer, clubId: string): 'seller' | 'buyer' {
  if (offer.sellerClubId === clubId) return 'seller';
  if (offer.buyerClubId === clubId) return 'buyer';
  throw new ForbiddenError('That negotiation is between two other clubs');
}

export async function readOffer(actor: MarketActor, offerId: string) {
  const offer = await prisma.transferOffer.findUnique({ where: { id: offerId } });
  if (!offer) throw new NotFoundError('Offer');
  sideOf(offer, actor.clubId);                      // membership check, throws otherwise
  return hydrateOffer(offer);
}

async function hydrateOffer(o: TransferOffer) {
  const [player, seller, buyer, linked] = await Promise.all([
    prisma.player.findUnique({ where: { id: o.playerId }, select: publicPlayerSelect }),
    publicClub(o.sellerClubId),
    publicClub(o.buyerClubId),
    // The need this player was offered against, if he was. The link lives on
    // PlayerOfferToClub, which the seller-initiated path writes alongside the
    // offer and which already has a needId column.
    prisma.playerOfferToClub.findFirst({
      where: { playerId: o.playerId, fromClubId: o.sellerClubId, toClubId: o.buyerClubId, needId: { not: null } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  const need = linked?.needId
    ? await prisma.clubRecruitmentNeed.findUnique({ where: { id: linked.needId } })
    : null;
  return {
    id: o.id, playerId: o.playerId, player: player ? toPublicPlayer(player) : null,
    sellerClub: seller, buyerClub: buyer,
    feeEur: money(o.feeEur), status: o.status, message: o.message,
    parentOfferId: o.parentOfferId, createdByClubId: o.createdByClubId,
    createdAt: o.createdAt, expiresAt: o.expiresAt, respondedAt: o.respondedAt,
    // "answers your ST requirement" — the criteria only, never the note.
    need: need ? { ...needShape(need, false), club: await publicClub(need.clubId) } : null,
    matchPct: linked?.matchPct ?? null,
  };
}

// ── the negotiation, in order ───────────────────────────────────────────────
// Every offer in this conversation, oldest first, read back along the chain
// TransferOffer already keeps in parentOfferId. Nothing is stored for this and
// nothing is invented: each step is an offer that was really made.
export async function readNegotiation(actor: MarketActor, offerId: string) {
  const offer = await prisma.transferOffer.findUnique({ where: { id: offerId } });
  if (!offer) throw new NotFoundError('Offer');
  sideOf(offer, actor.clubId);                      // in this negotiation, or nothing

  // Walk back to the first offer, then forward through its answers. The offer
  // we started from is part of the conversation, not a boundary of it, so the
  // cycle guard is the chain itself rather than a set seeded with that id.
  const chain: TransferOffer[] = [offer];
  let cur = offer;
  while (cur.parentOfferId) {
    const parent = await prisma.transferOffer.findUnique({ where: { id: cur.parentOfferId } });
    if (!parent || chain.some((o) => o.id === parent.id)) break;
    chain.unshift(parent);
    cur = parent;
  }
  for (;;) {
    const next = await prisma.transferOffer.findFirst({
      where: { parentOfferId: chain[chain.length - 1].id }, orderBy: { createdAt: 'asc' },
    });
    if (!next || chain.some((o) => o.id === next.id)) break;
    chain.push(next);
  }
  const steps = await Promise.all(chain.map(async (o, i) => ({
    id: o.id,
    club: await publicClub(o.createdByClubId),
    feeEur: money(o.feeEur),
    status: o.status,
    at: o.createdAt,
    kind: i === 0 ? (o.createdByClubId === o.sellerClubId ? 'OFFERED_PLAYER' : 'OFFERED') : 'COUNTERED',
    message: o.message,
  })));
  return { offerId: offer.id, steps, current: await hydrateOffer(chain[chain.length - 1]) };
}

// The seller accepts: the player moves, the money moves, and everything else
// open on that player is closed — all of it or none of it.
export async function acceptOffer(actor: MarketActor, offerId: string) {
  const offer = await prisma.transferOffer.findUnique({ where: { id: offerId } });
  if (!offer) throw new NotFoundError('Offer');
  // Only the club being offered money may accept it. A counter reverses the
  // roles: it is created by the seller, so the buyer is the one who accepts.
  const answering = offer.createdByClubId === offer.buyerClubId ? offer.sellerClubId : offer.buyerClubId;
  if (actor.clubId !== answering) throw new ForbiddenError('Only the club that received this offer may accept it');
  if (offer.status !== 'PENDING') throw new ConflictError('That offer is no longer open');
  if (offer.expiresAt && offer.expiresAt.getTime() < Date.now()) {
    await prisma.transferOffer.update({ where: { id: offerId }, data: { status: 'EXPIRED' } });
    throw new ConflictError('That offer has expired');
  }

  const feeEur = money(offer.feeEur);
  const buyerBalance = await getBalance(offer.buyerClubId);
  if (buyerBalance.availableEur < feeEur) throw new BadRequestError('The buying club can no longer cover that fee');

  let cancelledAuction: { listingId: string; playerId: string | null; sellerClubId: string } | null = null;
  const result = await prisma.$transaction(async (tx) => {
    // The claim: exactly one caller takes this offer out of PENDING.
    const claimed = await tx.transferOffer.updateMany({
      where: { id: offerId, status: 'PENDING' },
      data: { status: 'ACCEPTED', respondedAt: new Date() },
    });
    if (claimed.count === 0) throw new ConflictError('That offer is no longer open');

    // 0 · the money, re-checked here rather than before the transaction, and
    // with the buyer's balance row locked for its duration. Two acceptances in
    // the same instant now queue instead of both reading the same figure.
    await assertCanSpend(tx, offer.buyerClubId, feeEur);

    const player = await tx.player.findUnique({ where: { id: offer.playerId } });
    if (!player) throw new NotFoundError('Player');
    if (player.clubId !== offer.sellerClubId) throw new ConflictError('That player no longer belongs to the selling club');

    // 1 · the same Player row changes hands — one identity, one record
    const team = await tx.team.findFirst({
      where: { clubId: offer.buyerClubId, isActive: true, kind: 'SENIOR' }, orderBy: { createdAt: 'asc' },
    }) ?? await tx.team.findFirst({
      where: { clubId: offer.buyerClubId, isActive: true }, orderBy: { createdAt: 'asc' },
    });
    await tx.player.update({
      where: { id: offer.playerId },
      data: { clubId: offer.buyerClubId, teamId: team?.id ?? null },
    });

    // 2 · the buyer pays, once
    await tx.clubTransferBalance.upsert({
      where: { clubId: offer.buyerClubId },
      update: { spentEur: { increment: BigInt(feeEur) } },
      create: { clubId: offer.buyerClubId, spentEur: BigInt(feeEur) },
    });
    // 3 · the seller is paid, once
    await tx.clubTransferBalance.upsert({
      where: { clubId: offer.sellerClubId },
      update: { earnedEur: { increment: BigInt(feeEur) } },
      create: { clubId: offer.sellerClubId, earnedEur: BigInt(feeEur) },
    });

    // 4 · everything else open on this player closes with it — the same cleanup
    // the other two settlements now run. An auction is handed back rather than
    // closed here: it ends as CANCELLED, with the clubs that were bidding told.
    const { auctionListingId } = await closeCompetingState(tx, offer.playerId, offer.sellerClubId, { exceptOfferId: offerId });
    if (auctionListingId) {
      cancelledAuction = await cancelAuctionForSettlement(tx, auctionListingId, offer.playerId, offer.sellerClubId);
    }

    const history = await tx.athleteTransferHistory.create({
      data: {
        athleteId: offer.playerId,
        fromClubRef: offer.sellerClubId, toClubRef: offer.buyerClubId,
        feeCents: BigInt(feeEur) * BigInt(100), currency: 'EUR', occurredAt: new Date(),
        payload: { offerId, type: 'DIRECT_TRANSFER', fromTeamId: player.teamId ?? null, toTeamId: team?.id ?? null } as Prisma.InputJsonValue,
      },
    });
    return { playerId: offer.playerId, feeEur, historyId: history.id, name: `${player.firstName} ${player.lastName}` };
  }, { timeout: 20_000, maxWait: 10_000 });

  // Anybody who was bidding on an auction this deal had to cancel hears about
  // it, once the transfer itself has actually committed.
  await notifyCancelled(cancelledAuction);
  await archiveShortlistAfterTransfer(offer.playerId, offer.buyerClubId);

  const [seller, buyer] = await Promise.all([publicClub(offer.sellerClubId), publicClub(offer.buyerClubId)]);
  const note = { type: 'TRANSFER_COMPLETED', offerId, playerId: offer.playerId, feeEur, from: seller.id, to: buyer.id };
  await notifyClub(offer.buyerClubId, 'TRANSFER_OFFER_ACCEPTED',
    `${seller.name} accepted your ${fmt(feeEur)} offer for ${result.name}.`, null,
    { ...note, type: 'TRANSFER_OFFER_ACCEPTED' });
  await notifyClub(offer.buyerClubId, 'TRANSFER_COMPLETED',
    `${result.name} has joined from ${seller.name} for ${fmt(feeEur)}.`, null, note);
  await notifyClub(offer.sellerClubId, 'TRANSFER_COMPLETED',
    `${result.name} has left for ${buyer.name} for ${fmt(feeEur)}.`, null, note);

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'TRANSFER_SETTLED', entityType: 'TransferOffer', entityId: offerId,
    payload: { playerId: result.playerId, feeEur, from: offer.sellerClubId, to: offer.buyerClubId, type: 'DIRECT' },
  });
  emitOffer('OFFER_ACCEPTED', offer.sellerClubId, offer.buyerClubId, offer.playerId, offerId);
  emitTransferCompleted(offer.sellerClubId, offer.buyerClubId, offer.playerId, { offerId });
  return { ...result, sellerClubId: offer.sellerClubId, buyerClubId: offer.buyerClubId, type: 'DIRECT_TRANSFER' };
}

export async function rejectOffer(actor: MarketActor, offerId: string) {
  const offer = await prisma.transferOffer.findUnique({ where: { id: offerId } });
  if (!offer) throw new NotFoundError('Offer');
  const answering = offer.createdByClubId === offer.buyerClubId ? offer.sellerClubId : offer.buyerClubId;
  if (actor.clubId !== answering) throw new ForbiddenError('Only the club that received this offer may reject it');
  if (offer.status !== 'PENDING') throw new ConflictError('That offer is no longer open');

  const rejected = await prisma.transferOffer.update({
    where: { id: offerId }, data: { status: 'REJECTED', respondedAt: new Date() },
  });
  const player = await playerOr404(offer.playerId);
  const me = await publicClub(actor.clubId);
  await notifyClub(offer.createdByClubId, 'TRANSFER_OFFER_REJECTED',
    `${me.name} rejected your ${fmt(money(offer.feeEur))} offer for ${player.firstName} ${player.lastName}.`, null,
    { type: 'TRANSFER_OFFER_REJECTED', offerId, playerId: offer.playerId, clubId: me.id });
  emitOffer('OFFER_REJECTED', offer.sellerClubId, offer.buyerClubId, offer.playerId, offerId);
  return hydrateOffer(rejected);
}

// The club that made an offer can take it off the table while it is still open.
export async function withdrawOffer(actor: MarketActor, offerId: string) {
  const offer = await prisma.transferOffer.findUnique({ where: { id: offerId } });
  if (!offer) throw new NotFoundError('Offer');
  if (offer.createdByClubId !== actor.clubId) throw new ForbiddenError('Only the club that made this offer may withdraw it');
  if (offer.status !== 'PENDING') throw new ConflictError('That offer is no longer open');

  const withdrawn = await prisma.transferOffer.update({
    where: { id: offerId }, data: { status: 'WITHDRAWN', respondedAt: new Date() },
  });
  const player = await playerOr404(offer.playerId);
  const me = await publicClub(actor.clubId);
  const other = offer.createdByClubId === offer.buyerClubId ? offer.sellerClubId : offer.buyerClubId;
  await notifyClub(other, 'TRANSFER_OFFER_WITHDRAWN',
    `${me.name} withdrew the ${fmt(money(offer.feeEur))} offer for ${player.firstName} ${player.lastName}.`, null,
    { type: 'TRANSFER_OFFER_WITHDRAWN', offerId, playerId: offer.playerId, clubId: me.id });
  emitOffer('OFFER_WITHDRAWN', offer.sellerClubId, offer.buyerClubId, offer.playerId, offerId);
  return hydrateOffer(withdrawn);
}

// A counter is a new offer at a different fee, pointing back at the one it
// answers. The club that receives a counter is the one that made the original.
export async function counterOffer(
  actor: MarketActor, offerId: string, feeEur: number, message?: string,
  extras?: { addOnsEur?: number | null; sellOnPct?: number | null; preferredDate?: string | null },
) {
  const parent = await prisma.transferOffer.findUnique({ where: { id: offerId } });
  if (!parent) throw new NotFoundError('Offer');
  const answering = parent.createdByClubId === parent.buyerClubId ? parent.sellerClubId : parent.buyerClubId;
  if (actor.clubId !== answering) throw new ForbiddenError('Only the club that received this offer may counter it');
  if (parent.status !== 'PENDING') throw new ConflictError('That offer is no longer open');
  const fee = Math.round(Number(feeEur));
  if (!Number.isFinite(fee) || fee <= 0) throw new BadRequestError('feeEur must be a positive number');

  const row = await prisma.$transaction(async (tx) => {
    const claimed = await tx.transferOffer.updateMany({
      where: { id: offerId, status: 'PENDING' },
      data: { status: 'COUNTERED', respondedAt: new Date() },
    });
    if (claimed.count === 0) throw new ConflictError('That offer is no longer open');
    return tx.transferOffer.create({
      data: {
        playerId: parent.playerId, sellerClubId: parent.sellerClubId, buyerClubId: parent.buyerClubId,
        feeEur: BigInt(fee), message: message?.slice(0, 500) ?? null,
        parentOfferId: parent.id, createdByClubId: actor.clubId, createdById: actor.userId,
        expiresAt: new Date(Date.now() + OFFER_TTL_MS),
        // The counter answers the offer in front of it, so what it does not
        // restate it carries forward rather than silently dropping.
        ...(extras ? offerExtras(extras) : {
          addOnsEur: parent.addOnsEur, sellOnPct: parent.sellOnPct, preferredDate: parent.preferredDate,
        }),
      },
    });
  });

  const player = await playerOr404(parent.playerId);
  const me = await publicClub(actor.clubId);
  await notifyClub(parent.createdByClubId, 'TRANSFER_COUNTER_OFFER',
    `${me.name} countered at ${fmt(fee)} for ${player.firstName} ${player.lastName}.`,
    message?.slice(0, 500) ?? null,
    { type: 'TRANSFER_COUNTER_OFFER', offerId: row.id, parentOfferId: parent.id, playerId: parent.playerId, clubId: me.id, feeEur: fee });
  emitOffer('OFFER_COUNTERED', parent.sellerClubId, parent.buyerClubId, parent.playerId, row.id);
  return hydrateOffer(row);
}

// ── what a club may read ─────────────────────────────────────────────────────
// Its own side of everything, and nothing from a negotiation it is not in.
export async function readOffersForPlayer(actor: MarketActor, playerId: string) {
  const player = await playerOr404(playerId);
  const owner = player.clubId === actor.clubId;
  const offers = await prisma.transferOffer.findMany({
    where: owner
      ? { playerId, sellerClubId: actor.clubId }             // the owner sees offers made to it
      : { playerId, buyerClubId: actor.clubId },             // anyone else sees only its own
    orderBy: { createdAt: 'desc' }, take: 100,
  });
  const interests = await prisma.transferInterest.findMany({
    where: owner ? { playerId, ownerClubId: actor.clubId } : { playerId, interestedClubId: actor.clubId },
    orderBy: { createdAt: 'desc' }, take: 100,
  });
  const hydrated = await Promise.all(offers.map(hydrateOffer));
  const interestRows = await Promise.all(interests.map(async (i) => ({
    id: i.id, playerId: i.playerId, status: i.status, message: i.message, createdAt: i.createdAt,
    club: await publicClub(owner ? i.interestedClubId : i.ownerClubId),
  })));
  const history = await prisma.athleteTransferHistory.findMany({
    where: { athleteId: playerId }, orderBy: { occurredAt: 'desc' }, take: 20,
  });
  return {
    isOwner: owner,
    incoming: hydrated.filter((o) => o.createdByClubId !== actor.clubId),
    outgoing: hydrated.filter((o) => o.createdByClubId === actor.clubId),
    interest: interestRows,
    history: await Promise.all(history.map(async (h) => ({
      id: h.id, occurredAt: h.occurredAt, feeEur: Number(h.feeCents) / 100,
      from: await publicClub(h.fromClubRef ?? ''), to: await publicClub(h.toClubRef ?? ''),
    }))),
  };
}

// Everything this club is currently negotiating, either way.
export async function readActivity(actor: MarketActor) {
  const [incoming, outgoing, interestIn, interestOut, offeredIn, offeredOut] = await Promise.all([
    // Everything waiting on an answer from this club — whichever side of the
    // deal it is on. A buyer's bid for our player and a seller's offer of
    // theirs are both offers we have to answer, and the club that wrote one is
    // never the club that answers it.
    prisma.transferOffer.findMany({
      where: {
        OR: [{ sellerClubId: actor.clubId }, { buyerClubId: actor.clubId }],
        createdByClubId: { not: actor.clubId },
      },
      orderBy: { createdAt: 'desc' }, take: 50,
    }),
    prisma.transferOffer.findMany({ where: { createdByClubId: actor.clubId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.transferInterest.findMany({ where: { ownerClubId: actor.clubId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.transferInterest.findMany({ where: { interestedClubId: actor.clubId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.playerOfferToClub.findMany({ where: { toClubId: actor.clubId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.playerOfferToClub.findMany({ where: { fromClubId: actor.clubId }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  const light = async (rows: Array<{ id: string; playerId: string; status: string; createdAt: Date }>, clubKey: (r: never) => string) =>
    Promise.all(rows.map(async (r) => ({
      id: r.id, playerId: r.playerId, status: r.status, createdAt: r.createdAt,
      player: await prisma.player.findUnique({
        where: { id: r.playerId },
        select: { id: true, firstName: true, lastName: true, position: true, overallRating: true, avatar: true },
      }),
      club: await publicClub(clubKey(r as never)),
    })));
  return {
    incomingOffers: await Promise.all(incoming.map(hydrateOffer)),
    outgoingOffers: await Promise.all(outgoing.map(hydrateOffer)),
    interestReceived: await light(interestIn as never, (r: never) => (r as { interestedClubId: string }).interestedClubId),
    interestSent:     await light(interestOut as never, (r: never) => (r as { ownerClubId: string }).ownerClubId),
    offeredToUs:      await light(offeredIn as never, (r: never) => (r as { fromClubId: string }).fromClubId),
    offeredByUs:      await light(offeredOut as never, (r: never) => (r as { toClubId: string }).toClubId),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// RECRUITMENT NEEDS — what a club is looking for
// ══════════════════════════════════════════════════════════════════════════════
const needShape = (n: {
  id: string; clubId: string; positions: string; ageMin: number | null; ageMax: number | null;
  ratingMin: number | null; ratingMax: number | null; budgetMinEur: bigint | null; budgetMaxEur: bigint | null;
  nationality: string | null; preferredFoot: string | null; playstyle: string | null;
  contractPreference: string | null; priority: string; note: string | null;
  isActive: boolean; expiresAt: Date | null; createdAt: Date;
}, includeNote: boolean) => ({
  id: n.id, clubId: n.clubId, positions: n.positions.split(',').filter(Boolean),
  ageMin: n.ageMin, ageMax: n.ageMax, ratingMin: n.ratingMin, ratingMax: n.ratingMax,
  budgetMinEur: n.budgetMinEur === null ? null : Number(n.budgetMinEur),
  budgetMaxEur: n.budgetMaxEur === null ? null : Number(n.budgetMaxEur),
  nationality: n.nationality, preferredFoot: n.preferredFoot, playstyle: n.playstyle,
  contractPreference: n.contractPreference, priority: n.priority,
  // The note is the club's own working text. It stays inside the club.
  ...(includeNote ? { note: n.note } : {}),
  isActive: n.isActive, expiresAt: n.expiresAt, createdAt: n.createdAt,
});

export interface NeedDto {
  positions?: string | string[];
  ageMin?: number; ageMax?: number; ratingMin?: number; ratingMax?: number;
  budgetMinEur?: number; budgetMaxEur?: number;
  nationality?: string; preferredFoot?: string; playstyle?: string; contractPreference?: string;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH'; note?: string; expiresAt?: string;
}
const asPositions = (v: NeedDto['positions']) =>
  (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim().toUpperCase()).filter(Boolean);

const num = (v: unknown) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

export async function createNeed(actor: MarketActor, dto: NeedDto) {
  const positions = asPositions(dto.positions);
  if (!positions.length) throw new BadRequestError('positions required');
  const min = num(dto.budgetMinEur), max = num(dto.budgetMaxEur);
  const created = await prisma.clubRecruitmentNeed.create({
    data: {
      clubId: actor.clubId, positions: positions.join(','),
      ageMin: num(dto.ageMin), ageMax: num(dto.ageMax),
      ratingMin: num(dto.ratingMin), ratingMax: num(dto.ratingMax),
      budgetMinEur: min === null ? null : BigInt(min),
      budgetMaxEur: max === null ? null : BigInt(max),
      nationality: dto.nationality?.trim() || null,
      preferredFoot: dto.preferredFoot?.trim().toUpperCase() || null,
      playstyle: dto.playstyle?.trim() || null,
      contractPreference: dto.contractPreference?.trim() || null,
      priority: dto.priority ?? 'MEDIUM',
      note: dto.note?.slice(0, 500) ?? null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      createdById: actor.userId,
    },
  });
  emitNeedPublished(actor.clubId, created.id);
  return needShape(created, true);
}

export async function updateNeed(actor: MarketActor, needId: string, dto: NeedDto & { isActive?: boolean }) {
  const row = await prisma.clubRecruitmentNeed.findUnique({ where: { id: needId } });
  if (!row) throw new NotFoundError('Need');
  if (row.clubId !== actor.clubId) throw new ForbiddenError('That need belongs to another club');
  const positions = dto.positions !== undefined ? asPositions(dto.positions) : null;
  const min = num(dto.budgetMinEur), max = num(dto.budgetMaxEur);
  const updated = await prisma.clubRecruitmentNeed.update({
    where: { id: needId },
    data: {
      ...(positions && positions.length ? { positions: positions.join(',') } : {}),
      ...(dto.ageMin !== undefined ? { ageMin: num(dto.ageMin) } : {}),
      ...(dto.ageMax !== undefined ? { ageMax: num(dto.ageMax) } : {}),
      ...(dto.ratingMin !== undefined ? { ratingMin: num(dto.ratingMin) } : {}),
      ...(dto.ratingMax !== undefined ? { ratingMax: num(dto.ratingMax) } : {}),
      ...(dto.budgetMinEur !== undefined ? { budgetMinEur: min === null ? null : BigInt(min) } : {}),
      ...(dto.budgetMaxEur !== undefined ? { budgetMaxEur: max === null ? null : BigInt(max) } : {}),
      ...(dto.nationality !== undefined ? { nationality: dto.nationality?.trim() || null } : {}),
      ...(dto.preferredFoot !== undefined ? { preferredFoot: dto.preferredFoot?.trim().toUpperCase() || null } : {}),
      ...(dto.playstyle !== undefined ? { playstyle: dto.playstyle?.trim() || null } : {}),
      ...(dto.contractPreference !== undefined ? { contractPreference: dto.contractPreference?.trim() || null } : {}),
      ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
      ...(dto.note !== undefined ? { note: dto.note?.slice(0, 500) ?? null } : {}),
      ...(dto.expiresAt !== undefined ? { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null } : {}),
      ...(dto.isActive !== undefined ? { isActive: !!dto.isActive } : {}),
    },
  });
  if (updated.isActive) emitNeedUpdated(actor.clubId, needId);
  else emitNeedClosed(actor.clubId, needId);
  return needShape(updated, true);
}

export async function deleteNeed(actor: MarketActor, needId: string) {
  const row = await prisma.clubRecruitmentNeed.findUnique({ where: { id: needId } });
  if (!row) throw new NotFoundError('Need');
  if (row.clubId !== actor.clubId) throw new ForbiddenError('That need belongs to another club');
  await prisma.clubRecruitmentNeed.update({ where: { id: needId }, data: { isActive: false } });
  emitNeedClosed(actor.clubId, needId);
  return { id: needId, isActive: false };
}

export async function readOwnNeeds(actor: MarketActor) {
  const rows = await prisma.clubRecruitmentNeed.findMany({
    where: { clubId: actor.clubId }, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }], take: 100,
  });
  return { items: rows.map((n) => needShape(n, true)) };
}

// The public board: what every club is looking for. A need is a public
// statement — the club chose to publish it — but its private note is not.
export async function readMarketNeeds(actor: MarketActor) {
  const rows = await prisma.clubRecruitmentNeed.findMany({
    where: { isActive: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }], take: 200,
  });
  // How many of this club's own players fit each need, so the board can show
  // the opportunity without a request per card. One query for the squad, then
  // arithmetic — the count is never a count of anybody else's players.
  const squad = (await prisma.player.findMany({
    where: { clubId: actor.clubId, isActive: true }, select: publicPlayerSelect, take: 500,
  })).map(scoringShape);
  const items = await Promise.all(rows.map(async (n) => ({
    ...needShape(n, n.clubId === actor.clubId),
    club: await publicClub(n.clubId),
    isMine: n.clubId === actor.clubId,
    myMatches: n.clubId === actor.clubId ? 0 : scoreSquadAgainstNeed(squad, n).filter((r) => r.eligible).length,
  })));
  return { items };
}

// ══════════════════════════════════════════════════════════════════════════════
// MATCHING — a player against a club's stated need
// ══════════════════════════════════════════════════════════════════════════════
// Deterministic and explainable: every criterion the need actually states is
// scored, the score is the share of those criteria the player satisfies, and
// the reasons are the criteria themselves. A need that states nothing matches
// everyone at 100% — it asked for nothing. Nothing here is learned, guessed or
// generated; the same player and need always produce the same number.
export interface MatchCriterion { key: string; label: string; ok: boolean; weight: number; detail: string }

const ageOf = (dob: Date | null) => {
  if (!dob) return null;
  return Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000));
};

export function matchPlayerToNeed(
  player: { position: string; trainedPositions?: string | null; roles?: string | null;
            dateOfBirth: Date | null; overallRating: number; marketValue: number;
            preferredFoot?: string | null; nationality?: string | null },
  need: { positions: string[]; ageMin: number | null; ageMax: number | null;
          ratingMin: number | null; ratingMax: number | null;
          budgetMinEur: number | null; budgetMaxEur: number | null;
          nationality: string | null; preferredFoot: string | null; playstyle: string | null },
  askingPriceEur?: number | null,
): { pct: number; criteria: MatchCriterion[]; reasons: string[] } {
  const criteria: MatchCriterion[] = [];
  const secondary = String(player.trainedPositions ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const main = String(player.position ?? '').toUpperCase();

  if (need.positions.length) {
    const isMain = need.positions.includes(main);
    const isAlt = !isMain && secondary.some((s) => need.positions.includes(s));
    criteria.push({
      key: 'position', label: 'Position', ok: isMain || isAlt, weight: isMain ? 3 : 3,
      detail: isMain ? `${main} needed` : isAlt ? `covers ${need.positions.filter((p) => secondary.includes(p)).join('/')}` : `needs ${need.positions.join('/')}`,
    });
  }
  const age = ageOf(player.dateOfBirth);
  if (need.ageMin !== null || need.ageMax !== null) {
    const ok = age !== null && (need.ageMin === null || age >= need.ageMin) && (need.ageMax === null || age <= need.ageMax);
    criteria.push({ key: 'age', label: 'Age', ok, weight: 2,
      detail: ok ? 'Age compatible' : `wants ${need.ageMin ?? '—'}–${need.ageMax ?? '—'}, he is ${age ?? '—'}` });
  }
  if (need.ratingMin !== null || need.ratingMax !== null) {
    const q = player.overallRating;
    const ok = (need.ratingMin === null || q >= need.ratingMin) && (need.ratingMax === null || q <= need.ratingMax);
    criteria.push({ key: 'rating', label: 'Quality', ok, weight: 2,
      detail: ok ? `OVR ${q} within range` : `wants ${need.ratingMin ?? '—'}–${need.ratingMax ?? '—'}, he is ${q}` });
  }
  if (need.budgetMinEur !== null || need.budgetMaxEur !== null) {
    const price = Math.round(askingPriceEur ?? player.marketValue ?? 0);
    const ok = (need.budgetMinEur === null || price >= need.budgetMinEur) && (need.budgetMaxEur === null || price <= need.budgetMaxEur);
    criteria.push({ key: 'budget', label: 'Budget', ok, weight: 2,
      detail: ok ? 'Budget compatible' : `budget ${fmt(need.budgetMinEur ?? 0)}–${fmt(need.budgetMaxEur ?? 0)}, asking ${fmt(price)}` });
  }
  if (need.preferredFoot) {
    const ok = need.preferredFoot === 'ANY' || String(player.preferredFoot ?? '').toUpperCase() === need.preferredFoot;
    criteria.push({ key: 'foot', label: 'Foot', ok, weight: 1,
      detail: ok ? 'Preferred foot matches' : `wants ${need.preferredFoot.toLowerCase()}` });
  }
  if (need.nationality) {
    const ok = String(player.nationality ?? '').toLowerCase() === need.nationality.toLowerCase();
    criteria.push({ key: 'nationality', label: 'Nationality', ok, weight: 1,
      detail: ok ? 'Nationality matches' : `wants ${need.nationality}` });
  }
  if (need.playstyle) {
    const ok = String(player.roles ?? '').toLowerCase().includes(need.playstyle.toLowerCase());
    criteria.push({ key: 'playstyle', label: 'Playstyle', ok, weight: 1,
      detail: ok ? 'Playstyle match' : `wants ${need.playstyle}` });
  }

  const total = criteria.reduce((a, c) => a + c.weight, 0);
  const hit = criteria.filter((c) => c.ok).reduce((a, c) => a + c.weight, 0);
  const pct = total === 0 ? 100 : Math.round((hit / total) * 100);
  const reasons = criteria.filter((c) => c.ok).sort((a, b) => b.weight - a.weight).map((c) => c.detail);
  return { pct, criteria, reasons };
}

// The clubs whose stated needs this player fits, best first. Only needs their
// clubs published, and only the fields they published.
export async function matchesForPlayer(actor: MarketActor, playerId: string, askingPriceEur?: number) {
  const player = await playerOr404(playerId);
  if (player.clubId !== actor.clubId) throw new ForbiddenError('That player belongs to another club');

  const needs = await prisma.clubRecruitmentNeed.findMany({
    where: {
      isActive: true, clubId: { not: actor.clubId },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    take: 200,
  });
  const rows = await Promise.all(needs.map(async (n) => {
    const shaped = needShape(n, false);
    const m = matchPlayerToNeed(player, {
      positions: shaped.positions, ageMin: shaped.ageMin, ageMax: shaped.ageMax,
      ratingMin: shaped.ratingMin, ratingMax: shaped.ratingMax,
      budgetMinEur: shaped.budgetMinEur, budgetMaxEur: shaped.budgetMaxEur,
      nationality: shaped.nationality, preferredFoot: shaped.preferredFoot, playstyle: shaped.playstyle,
    }, askingPriceEur ?? null);
    const already = await prisma.playerOfferToClub.findFirst({
      where: { playerId, toClubId: n.clubId, status: { in: ['OPEN', 'INVITED'] } }, select: { id: true },
    });
    return {
      needId: n.id, club: await publicClub(n.clubId), need: shaped,
      matchPct: m.pct, reasons: m.reasons, criteria: m.criteria,
      alreadyOffered: !!already,
    };
  }));
  return { items: rows.sort((a, b) => b.matchPct - a.matchPct) };
}

// ── the other direction: which of MY players fit THAT club's need ───────────
// The market board asks two questions at once — "who is looking for a player"
// and "do I own one" — and both have to be answered without a request per
// player. One query reads the need, one reads this club's own squad, and the
// scoring is the same pure function the rest of the module uses. Nothing is
// read from the client: the squad is the authenticated club's, always, so a
// club can only ever be told about players it already owns.
//
// "Matching" is deliberately strict about position and generous about the
// rest: a need that names positions is not satisfied by a player who plays
// none of them, whatever his age and price. Everything else is a share of the
// criteria the need actually stated.
export const MATCH_FLOOR = 60;

// The stored need, in the vocabulary matchPlayerToNeed reads. Exported because
// discovery scores other clubs' players against THIS club's needs and must use
// the same translation — a second copy of this is a second definition of what a
// need means.
export interface NeedRowShape {
  positions: string; ageMin: number | null; ageMax: number | null;
  ratingMin: number | null; ratingMax: number | null;
  budgetMinEur: bigint | null; budgetMaxEur: bigint | null;
  nationality: string | null; preferredFoot: string | null; playstyle: string | null;
}
export function needSpec(need: NeedRowShape) {
  return {
    positions: need.positions.split(',').filter(Boolean),
    ageMin: need.ageMin, ageMax: need.ageMax, ratingMin: need.ratingMin, ratingMax: need.ratingMax,
    budgetMinEur: need.budgetMinEur === null ? null : Number(need.budgetMinEur),
    budgetMaxEur: need.budgetMaxEur === null ? null : Number(need.budgetMaxEur),
    nationality: need.nationality, preferredFoot: need.preferredFoot, playstyle: need.playstyle,
  };
}

// Whether a score counts as a match at all: the position must be one the need
// actually asked for, and the weighted score must clear the floor. One rule,
// used by the needs board and by discovery alike.
export function matchIsEligible(m: { pct: number; criteria: MatchCriterion[] }): boolean {
  const position = m.criteria.find((c) => c.key === 'position');
  return (!position || position.ok) && m.pct >= MATCH_FLOOR;
}

function scoreSquadAgainstNeed(
  players: Array<{ position: string; trainedPositions: string | null; roles: string | null;
                   dateOfBirth: Date | null; overallRating: number; marketValue: number;
                   preferredFoot: string | null; nationality: string | null }>,
  need: NeedRowShape,
) {
  const spec = needSpec(need);
  return players.map((p) => {
    const m = matchPlayerToNeed(p, spec);
    return { m, eligible: matchIsEligible(m) };
  });
}

export async function matchesForNeed(actor: MarketActor, needId: string) {
  const need = await prisma.clubRecruitmentNeed.findUnique({ where: { id: needId } });
  if (!need) throw new NotFoundError('Need');
  // A need that has lapsed or been withdrawn is not something to match against.
  if (!need.isActive || (need.expiresAt && need.expiresAt.getTime() <= Date.now())) {
    throw new ConflictError('That need is no longer open');
  }
  const club = await publicClub(need.clubId);
  const mine = need.clubId === actor.clubId;
  // Only ever this club's own squad. A need belonging to another club never
  // gives its author a window into anybody's roster.
  const players = mine ? [] : await prisma.player.findMany({
    where: { clubId: actor.clubId, isActive: true }, select: publicPlayerSelect, take: 500,
  });
  const scored = scoreSquadAgainstNeed(players.map(scoringShape), need);
  const items = players.map((p, i) => ({
    // The same projection every other club-facing surface uses. These are the
    // caller's own players, but a need match is answered TO another club and
    // the shape must not differ from the one that leaves the building.
    player: toPublicPlayer(p),
    matchPct: scored[i].m.pct,
    eligible: scored[i].eligible,
    criteria: scored[i].m.criteria,
  })).filter((r) => r.eligible).sort((a, b) => b.matchPct - a.matchPct);

  return { needId: need.id, club, need: needShape(need, mine), isMine: mine, items };
}

// ── the owner takes his player to those clubs ────────────────────────────────
export interface OfferToClubsDto {
  playerId: string;
  clubIds?: string[];
  // "every eligible club" instead of a named list. The set is resolved here
  // from the clubs that exist, never from a list the browser sends.
  targetAll?: boolean;
  askingPriceEur?: number;
  minAcceptableEur?: number | null;
  allowNegotiation?: boolean;
  preferredDate?: string | null;
  expiresAt?: string | null;
  message?: string;
}

// Which clubs may be approached about a player: every active club that is not
// the one that owns him. Declared once so the board, the publish and the
// "already offered" check all mean the same thing by "eligible".
async function eligibleTargetClubs(ownerClubId: string): Promise<string[]> {
  const rows = await prisma.club.findMany({
    where: { id: { not: ownerClubId } }, select: { id: true }, take: 500,
  });
  return rows.map((r) => r.id);
}

function readDate(v: unknown, where: string): Date | null {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime())) throw new BadRequestError(`${where} is not a date: ${JSON.stringify(v)}`);
  return d;
}
function readMoneyOrNull(v: unknown, where: string): number | null {
  if (v === undefined || v === null || (typeof v === 'string' && String(v).trim() === '')) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequestError(`${where} is not a number`);
  if (n < 0) throw new BadRequestError(`${where} cannot be negative`);
  return Math.round(n);
}

export async function offerPlayerToClubs(
  actor: MarketActor,
  dto: OfferToClubsDto,
) {
  const player = await playerOr404(dto.playerId);
  if (player.clubId !== actor.clubId) throw new ForbiddenError('That player belongs to another club');
  const targets = dto.targetAll
    ? await eligibleTargetClubs(actor.clubId)
    : Array.from(new Set((dto.clubIds || []).filter((c) => c && c !== actor.clubId)));
  if (!targets.length) throw new BadRequestError('clubIds required');

  // The terms he is published with. Read before anything is written, so a bad
  // date refuses the publish rather than leaving half the clubs approached.
  const minAcceptable = readMoneyOrNull(dto.minAcceptableEur, 'minAcceptableEur');
  const preferredDate = readDate(dto.preferredDate, 'preferredDate');
  const expiresAt = readDate(dto.expiresAt, 'expiresAt');
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new BadRequestError('expiresAt must be in the future');
  }
  const allowNegotiation = dto.allowNegotiation === undefined ? null : !!dto.allowNegotiation;

  const from = await publicClub(actor.clubId);
  const price = dto.askingPriceEur === undefined ? null : Math.round(Number(dto.askingPriceEur));
  const made: string[] = [];
  for (const toClubId of targets) {
    const open = await prisma.playerOfferToClub.findFirst({
      where: { playerId: dto.playerId, toClubId, status: { in: ['OPEN', 'INVITED'] } }, select: { id: true },
    });
    if (open) { made.push(open.id); continue; }
    const need = await prisma.clubRecruitmentNeed.findFirst({
      where: { clubId: toClubId, isActive: true }, orderBy: { createdAt: 'desc' },
    });
    const m = need ? matchPlayerToNeed(player, {
      positions: need.positions.split(',').filter(Boolean),
      ageMin: need.ageMin, ageMax: need.ageMax, ratingMin: need.ratingMin, ratingMax: need.ratingMax,
      budgetMinEur: need.budgetMinEur === null ? null : Number(need.budgetMinEur),
      budgetMaxEur: need.budgetMaxEur === null ? null : Number(need.budgetMaxEur),
      nationality: need.nationality, preferredFoot: need.preferredFoot, playstyle: need.playstyle,
    }, price) : null;

    const row = await prisma.playerOfferToClub.create({
      data: {
        playerId: dto.playerId, fromClubId: actor.clubId, toClubId,
        needId: need?.id ?? null,
        askingPriceEur: price === null ? null : BigInt(price),
        matchPct: m?.pct ?? null,
        message: dto.message?.slice(0, 500) ?? null,
        createdById: actor.userId,
        minAcceptableEur: minAcceptable === null ? null : BigInt(minAcceptable),
        allowNegotiation, preferredDate, expiresAt,
      },
    });
    made.push(row.id);
    await notifyClub(toClubId, 'PLAYER_OFFERED_TO_CLUB',
      `${from.name} has offered you ${player.firstName} ${player.lastName}${price !== null ? ' for ' + fmt(price) : ''}.`,
      dto.message?.slice(0, 500) ?? null,
      { type: 'PLAYER_OFFERED_TO_CLUB', playerOfferId: row.id, playerId: dto.playerId, clubId: from.id,
        askingPriceEur: price, matchPct: m?.pct ?? null });
    emitPlayerOffered(actor.clubId, toClubId, dto.playerId, null);
  }
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'PLAYER_OFFERED_TO_CLUBS', entityType: 'Player', entityId: dto.playerId,
    payload: { clubs: targets.length },
  });
  return { offered: made.length, ids: made };
}

// ══════════════════════════════════════════════════════════════════════════════
// OFFERED TO CLUBS — the board, and the seller's own desk for it
// ─────────────────────────────────────────────────────────────────────────────
// A player offered to clubs is not on the market: he has no listing, no auction
// and no price anybody can simply take. He is an approach his club has made,
// and this is the surface the clubs approached read it on.
//
// Two questions, deliberately answered by two different reads, because they are
// asked by different clubs about different rows:
//   • what has been offered TO me      — the board a buyer browses
//   • what I have offered to others    — the desk a seller manages
// Neither can ever answer the other: a club's own player is never a buying
// opportunity, and the board is scoped to toClubId inside the service.
// ══════════════════════════════════════════════════════════════════════════════

const LIVE_APPROACH = ['OPEN', 'INVITED'] as const;

// Not expired, according to the clock rather than to a status somebody has to
// remember to write. A row with no expiry never expires.
function notExpired() {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
}

// One published approach, in the shape both surfaces read.
async function hydrateApproach(r: {
  id: string; playerId: string; fromClubId: string; toClubId: string; status: string;
  askingPriceEur: bigint | null; minAcceptableEur: bigint | null; allowNegotiation: boolean | null;
  preferredDate: Date | null; expiresAt: Date | null; message: string | null;
  matchPct: number | null; createdAt: Date;
}) {
  const [player, from, to] = await Promise.all([
    prisma.player.findUnique({ where: { id: r.playerId }, select: publicPlayerSelect }),
    publicClub(r.fromClubId),
    publicClub(r.toClubId),
  ]);
  // What the two clubs are already saying to each other about him. The board
  // must show NEGOTIATING rather than a stale "offered", and the record it
  // reads is the negotiation itself — never a second copy of its state.
  const chain = await prisma.transferOffer.findMany({
    where: { playerId: r.playerId, sellerClubId: r.fromClubId, buyerClubId: r.toClubId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, feeEur: true, createdByClubId: true, parentOfferId: true },
  });
  const agreed = chain.find((o) => o.status === 'ACCEPTED');
  const live = chain.find((o) => o.status === 'PENDING' || o.status === 'COUNTERED');
  // Once one offer has answered another, the two clubs are negotiating —
  // whatever the newest step's own status happens to be. A counter is itself a
  // PENDING offer, so reading only that status called an active negotiation an
  // untouched approach.
  const exchanged = chain.some((o) => !!o.parentOfferId || o.status === 'COUNTERED');
  const state = agreed ? 'AGREEMENT_REACHED'
    : live ? (exchanged ? 'NEGOTIATING' : 'OFFER_RECEIVED')
    : 'OFFERED_TO_CLUBS';
  return {
    id: r.id,
    playerId: r.playerId,
    player: player ? toPublicPlayer(player) : null,
    fromClub: from, toClub: to,
    status: r.status,
    state,
    negotiationId: live?.id ?? agreed?.id ?? null,
    askingPriceEur: r.askingPriceEur === null ? null : Number(r.askingPriceEur),
    minAcceptableEur: r.minAcceptableEur === null ? null : Number(r.minAcceptableEur),
    allowNegotiation: r.allowNegotiation,
    preferredDate: r.preferredDate,
    expiresAt: r.expiresAt,
    message: r.message,
    matchPct: r.matchPct,
    createdAt: r.createdAt,
  };
}

// The board: players other clubs have offered to this one. Scoped to toClubId,
// so a club can never be shown its own player here.
export async function readOfferedToClubs(actor: MarketActor) {
  const rows = await prisma.playerOfferToClub.findMany({
    where: {
      toClubId: actor.clubId,
      fromClubId: { not: actor.clubId },
      status: { in: [...LIVE_APPROACH] },
      ...notExpired(),
    },
    orderBy: { createdAt: 'desc' }, take: 120,
  });
  const items = await Promise.all(rows.map(hydrateApproach));
  // A player whose transfer has completed is no longer an opportunity. His
  // approach is closed by settlement; this also drops anything settlement has
  // not reached yet, by asking who owns him now rather than who offered him.
  const owners = await prisma.player.findMany({
    where: { id: { in: items.map((i) => i.playerId) } }, select: { id: true, clubId: true, isActive: true },
  });
  const ownerOf = new Map(owners.map((o) => [o.id, o]));
  const live = items.filter((i) => {
    const o = ownerOf.get(i.playerId);
    return !!o && o.isActive !== false && o.clubId === i.fromClub.id;
  });
  return { items: live, total: live.length };
}

// The seller's own desk: what this club has published, and to how many clubs.
// Grouped by player, because one publish is one decision about one footballer
// however many clubs it was sent to.
export async function readMyOffersToClubs(actor: MarketActor) {
  const rows = await prisma.playerOfferToClub.findMany({
    where: { fromClubId: actor.clubId, status: { in: [...LIVE_APPROACH] }, ...notExpired() },
    orderBy: { createdAt: 'desc' }, take: 200,
  });
  const byPlayer = new Map<string, typeof rows>();
  rows.forEach((r) => {
    const list = byPlayer.get(r.playerId) || [];
    list.push(r); byPlayer.set(r.playerId, list);
  });
  const items = await Promise.all(Array.from(byPlayer.values()).map(async (list) => {
    const head = await hydrateApproach(list[0]);
    return { ...head, clubCount: list.length, clubIds: list.map((r) => r.toClubId) };
  }));
  return { items, total: items.length };
}

// Is he already published? One active approach per player per club is the rule
// the publish already enforces; this is the same question asked about the
// player as a whole, which is what the profile button needs.
export async function readMyOfferForPlayer(actor: MarketActor, playerId: string) {
  const rows = await prisma.playerOfferToClub.findMany({
    where: { fromClubId: actor.clubId, playerId, status: { in: [...LIVE_APPROACH] }, ...notExpired() },
    orderBy: { createdAt: 'desc' },
  });
  if (!rows.length) return { published: false };
  const head = await hydrateApproach(rows[0]);
  return { published: true, ...head, clubCount: rows.length, clubIds: rows.map((r) => r.toClubId) };
}

// Editing the published terms. It rewrites the approaches this club already
// made about this player — it never creates a second set, and it cannot reach
// another club's rows.
export async function updateOfferToClubs(
  actor: MarketActor, playerId: string,
  dto: Omit<OfferToClubsDto, 'playerId' | 'clubIds' | 'targetAll'>,
) {
  const player = await playerOr404(playerId);
  if (player.clubId !== actor.clubId) throw new ForbiddenError('That player belongs to another club');
  const price = dto.askingPriceEur === undefined ? undefined : readMoneyOrNull(dto.askingPriceEur, 'askingPriceEur');
  const minAcceptable = dto.minAcceptableEur === undefined ? undefined : readMoneyOrNull(dto.minAcceptableEur, 'minAcceptableEur');
  const preferredDate = dto.preferredDate === undefined ? undefined : readDate(dto.preferredDate, 'preferredDate');
  const expiresAt = dto.expiresAt === undefined ? undefined : readDate(dto.expiresAt, 'expiresAt');
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw new BadRequestError('expiresAt must be in the future');

  const res = await prisma.playerOfferToClub.updateMany({
    where: { fromClubId: actor.clubId, playerId, status: { in: [...LIVE_APPROACH] } },
    data: {
      ...(price === undefined ? {} : { askingPriceEur: price === null ? null : BigInt(price) }),
      ...(minAcceptable === undefined ? {} : { minAcceptableEur: minAcceptable === null ? null : BigInt(minAcceptable) }),
      ...(dto.allowNegotiation === undefined ? {} : { allowNegotiation: !!dto.allowNegotiation }),
      ...(preferredDate === undefined ? {} : { preferredDate }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(dto.message === undefined ? {} : { message: dto.message ? dto.message.slice(0, 500) : null }),
    },
  });
  if (!res.count) throw new NotFoundError('Published offer');
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'PLAYER_OFFER_TO_CLUBS_UPDATED', entityType: 'Player', entityId: playerId,
    payload: { rows: res.count },
  });
  return readMyOfferForPlayer(actor, playerId);
}

// Withdrawing him. The approaches close; nothing about the player moves, and a
// negotiation already under way is left alone — withdrawing an approach is not
// the same act as refusing an offer, and the offer has its own answer.
export async function withdrawOfferToClubs(actor: MarketActor, playerId: string) {
  const player = await playerOr404(playerId);
  if (player.clubId !== actor.clubId) throw new ForbiddenError('That player belongs to another club');
  const res = await prisma.playerOfferToClub.updateMany({
    where: { fromClubId: actor.clubId, playerId, status: { in: [...LIVE_APPROACH] } },
    data: { status: 'CLOSED', respondedAt: new Date() },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'PLAYER_OFFER_TO_CLUBS_WITHDRAWN', entityType: 'Player', entityId: playerId,
    payload: { rows: res.count },
  });
  return { withdrawn: res.count };
}

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
import { getBalance } from './transfer-market.service';

export interface MarketActor { userId: string; clubId: string; role?: string }

const OFFER_TTL_MS = 3 * 24 * 60 * 60 * 1000;   // an unanswered offer lapses

// ── notifications ────────────────────────────────────────────────────────────
// Transfers talk to a club, and a club is people: every active member of the
// receiving club gets the row, so whoever is logged in sees it. The payload
// carries what the UI needs to open the right thing and nothing more — no
// budgets, no scouting, no internal notes.
async function notifyClub(
  clubId: string,
  kind: UserNotificationKind,
  title: string,
  body: string | null,
  payload: Record<string, unknown>,
) {
  const members = await prisma.membership.findMany({
    where: { clubId, isActive: true }, select: { userId: true }, take: 200,
  });
  const legacy = await prisma.user.findMany({
    where: { OR: [{ clubId }, { currentClubId: clubId }], isActive: true },
    select: { id: true }, take: 200,
  });
  const ids = Array.from(new Set(members.map((m) => m.userId).concat(legacy.map((u) => u.id))));
  if (!ids.length) return 0;
  await prisma.userNotification.createMany({
    data: ids.map((userId) => ({
      clubId, userId, kind, title, body,
      payload: payload as Prisma.InputJsonValue,
    })),
  });
  return ids.length;
}

// What a club may know about another club: its name and crest. Never its
// budget, its needs' internal notes, or who else it is talking to.
async function publicClub(clubId: string) {
  const c = await prisma.club.findUnique({
    where: { id: clubId }, select: { id: true, name: true, shortName: true, emblem: true },
  });
  return c ?? { id: clubId, name: 'Unknown club', shortName: null, emblem: null };
}

async function playerOr404(playerId: string) {
  const p = await prisma.player.findUnique({ where: { id: playerId } });
  if (!p) throw new NotFoundError('Player');
  return p;
}

const money = (v: bigint | number) => Number(v);
const fmt = (eur: number) =>
  eur >= 1_000_000 ? '€' + (eur / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
    : eur >= 1_000 ? '€' + Math.round(eur / 1_000) + 'K' : '€' + eur;

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
  return updated;
}

// ══════════════════════════════════════════════════════════════════════════════
// OFFERS — a fee, named by one club and answered by the other
// ══════════════════════════════════════════════════════════════════════════════
export interface OfferDto { playerId: string; feeEur: number; message?: string; parentOfferId?: string }

export async function makeOffer(actor: MarketActor, dto: OfferDto) {
  if (!dto?.playerId) throw new BadRequestError('playerId required');
  const feeEur = Math.round(Number(dto.feeEur));
  if (!Number.isFinite(feeEur) || feeEur <= 0) throw new BadRequestError('feeEur must be a positive number');

  const player = await playerOr404(dto.playerId);
  if (player.clubId === actor.clubId) throw new BadRequestError('That player already belongs to your club');
  if (player.isActive === false) throw new BadRequestError('That player is not active');

  // A club may not offer money it does not have.
  const balance = await getBalance(actor.clubId);
  if (balance.availableEur < feeEur) throw new BadRequestError('Insufficient transfer budget');

  const row = await prisma.transferOffer.create({
    data: {
      playerId: dto.playerId, sellerClubId: player.clubId, buyerClubId: actor.clubId,
      feeEur: BigInt(feeEur), message: dto.message?.slice(0, 500) ?? null,
      createdByClubId: actor.clubId, createdById: actor.userId,
      expiresAt: new Date(Date.now() + OFFER_TTL_MS),
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

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'TRANSFER_OFFER_MADE', entityType: 'TransferOffer', entityId: row.id,
    payload: { playerId: dto.playerId, feeEur, seller: player.clubId },
  });
  return hydrateOffer(row);
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
  const [player, seller, buyer] = await Promise.all([
    prisma.player.findUnique({
      where: { id: o.playerId },
      select: { id: true, firstName: true, lastName: true, position: true, overallRating: true,
                marketValue: true, avatar: true, clubId: true, dateOfBirth: true, nationality: true, flag: true },
    }),
    publicClub(o.sellerClubId),
    publicClub(o.buyerClubId),
  ]);
  return {
    id: o.id, playerId: o.playerId, player,
    sellerClub: seller, buyerClub: buyer,
    feeEur: money(o.feeEur), status: o.status, message: o.message,
    parentOfferId: o.parentOfferId, createdByClubId: o.createdByClubId,
    createdAt: o.createdAt, expiresAt: o.expiresAt, respondedAt: o.respondedAt,
  };
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

  const result = await prisma.$transaction(async (tx) => {
    // The claim: exactly one caller takes this offer out of PENDING.
    const claimed = await tx.transferOffer.updateMany({
      where: { id: offerId, status: 'PENDING' },
      data: { status: 'ACCEPTED', respondedAt: new Date() },
    });
    if (claimed.count === 0) throw new ConflictError('That offer is no longer open');

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

    // 4 · everything else open on this player closes with it. A sold player is
    // not still for sale, not still being negotiated, and not still on offer.
    await tx.playerContractStatus.updateMany({
      where: { playerId: offer.playerId }, data: { isAvailableForTransfer: false },
    });
    await tx.transferOffer.updateMany({
      where: { playerId: offer.playerId, status: 'PENDING', id: { not: offerId } },
      data: { status: 'REJECTED', respondedAt: new Date() },
    });
    await tx.transferInterest.updateMany({
      where: { playerId: offer.playerId, status: { in: ['OPEN', 'INVITED'] } },
      data: { status: 'CLOSED', respondedAt: new Date() },
    });
    await tx.playerOfferToClub.updateMany({
      where: { playerId: offer.playerId, status: { in: ['OPEN', 'INVITED'] } },
      data: { status: 'CLOSED', respondedAt: new Date() },
    });
    const listings = await tx.marketplaceItem.findMany({
      where: { kind: 'TRANSFER_LISTING', clubId: offer.sellerClubId, status: 'ACTIVE' },
      select: { id: true, payload: true },
    });
    for (const l of listings) {
      const pl = (l.payload ?? {}) as Record<string, unknown>;
      if (pl.playerId === offer.playerId) {
        await tx.marketplaceItem.update({ where: { id: l.id }, data: { status: 'CLOSED' } });
      }
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
  return hydrateOffer(withdrawn);
}

// A counter is a new offer at a different fee, pointing back at the one it
// answers. The club that receives a counter is the one that made the original.
export async function counterOffer(actor: MarketActor, offerId: string, feeEur: number, message?: string) {
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
      },
    });
  });

  const player = await playerOr404(parent.playerId);
  const me = await publicClub(actor.clubId);
  await notifyClub(parent.createdByClubId, 'TRANSFER_COUNTER_OFFER',
    `${me.name} countered at ${fmt(fee)} for ${player.firstName} ${player.lastName}.`,
    message?.slice(0, 500) ?? null,
    { type: 'TRANSFER_COUNTER_OFFER', offerId: row.id, parentOfferId: parent.id, playerId: parent.playerId, clubId: me.id, feeEur: fee });
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
    prisma.transferOffer.findMany({ where: { sellerClubId: actor.clubId, createdByClubId: { not: actor.clubId } }, orderBy: { createdAt: 'desc' }, take: 50 }),
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
  return needShape(updated, true);
}

export async function deleteNeed(actor: MarketActor, needId: string) {
  const row = await prisma.clubRecruitmentNeed.findUnique({ where: { id: needId } });
  if (!row) throw new NotFoundError('Need');
  if (row.clubId !== actor.clubId) throw new ForbiddenError('That need belongs to another club');
  await prisma.clubRecruitmentNeed.update({ where: { id: needId }, data: { isActive: false } });
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
  const items = await Promise.all(rows.map(async (n) => ({
    ...needShape(n, n.clubId === actor.clubId),
    club: await publicClub(n.clubId),
    isMine: n.clubId === actor.clubId,
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

// ── the owner takes his player to those clubs ────────────────────────────────
export async function offerPlayerToClubs(
  actor: MarketActor,
  dto: { playerId: string; clubIds: string[]; askingPriceEur?: number; message?: string },
) {
  const player = await playerOr404(dto.playerId);
  if (player.clubId !== actor.clubId) throw new ForbiddenError('That player belongs to another club');
  const targets = Array.from(new Set((dto.clubIds || []).filter((c) => c && c !== actor.clubId)));
  if (!targets.length) throw new BadRequestError('clubIds required');

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
      },
    });
    made.push(row.id);
    await notifyClub(toClubId, 'PLAYER_OFFERED_TO_CLUB',
      `${from.name} has offered you ${player.firstName} ${player.lastName}${price !== null ? ' for ' + fmt(price) : ''}.`,
      dto.message?.slice(0, 500) ?? null,
      { type: 'PLAYER_OFFERED_TO_CLUB', playerOfferId: row.id, playerId: dto.playerId, clubId: from.id,
        askingPriceEur: price, matchPct: m?.pct ?? null });
  }
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'PLAYER_OFFERED_TO_CLUBS', entityType: 'Player', entityId: dto.playerId,
    payload: { clubs: targets.length },
  });
  return { offered: made.length, ids: made };
}

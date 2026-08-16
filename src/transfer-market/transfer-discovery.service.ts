// Familista — scouting: finding a real footballer at another real club
// ─────────────────────────────────────────────────────────────────────────────
// Until now the only players a club could see were the ones somebody had put on
// the market, and the Scouting tab filled that silence with invented names. This
// is the search that makes it unnecessary: every active player at every other
// canonical club, read from the Player table, shaped by the one public
// projection, and paginated by the server.
//
// The distinction the whole module turns on is that BEING FOUND IS NOT BEING FOR
// SALE. A club may look at any footballer on the platform; what it may then DO
// about him is decided here, from what his own club actually did — put him in an
// auction, publish a price, mark him available, or none of those. The browser is
// told which actions exist; it does not get to decide.
//
// Nothing here scores anything new. The need matching is matchPlayerToNeed, the
// same deterministic function the needs board uses, run against this club's own
// open needs.

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, NotFoundError } from '../utils/errors';
import {
  actionsFor, ageFrom, PublicClub, publicClubSelect, publicPlayerSelect, PublicPlayerRow,
  scoringShape, toPublicPlayer, TransferState, UNKNOWN_CLUB,
} from './public-player';
import {
  matchIsEligible, matchPlayerToNeed, MatchCriterion, needSpec,
} from './transfer-negotiation.service';

export interface MarketActor { userId: string; clubId: string; role?: string }

const KIND = 'TRANSFER_LISTING' as const;

// A page is bounded so a search can never ask the database for the whole
// platform, and the in-memory work below is bounded by SCAN_CAP for the same
// reason. Ordering is total — rating, then id — so page 2 cannot repeat or skip
// a row that page 1 already showed.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SCAN_CAP = 500;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

export interface DiscoverFilters {
  search?: string;
  clubId?: string;
  nationality?: string;
  position?: string;
  secondaryPosition?: string;
  ageMin?: number; ageMax?: number;
  ovrMin?: number; ovrMax?: number;
  valueMin?: number; valueMax?: number;
  preferredFoot?: string;
  transferStatus?: string;      // AUCTION | LISTED | AVAILABLE | NOT_AVAILABLE
  listedOnly?: boolean;
  auctionOnly?: boolean;
  matchesMyNeeds?: boolean;
  shortlistedOnly?: boolean;
  page?: number; limit?: number;
  // The one internal use: a club looking at its own squad through the same
  // lens. Discovery is other clubs by default and callers must ask for this.
  includeOwnPlayers?: boolean;
}

// ── what the market has already said about a player ──────────────────────────
// One query for every active listing, indexed by player, rather than a question
// per row. A club's market is tens of listings, not thousands.
interface MarketState {
  listingId: string;
  mode: 'AUCTION' | 'FIXED';
  askingPriceEur: number;
  validUntil: Date | null;
  sellerClubId: string;
}

async function activeListingsByPlayer(): Promise<Map<string, MarketState>> {
  const rows = await prisma.marketplaceItem.findMany({
    where: {
      kind: KIND, status: 'ACTIVE',
      OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'desc' }, take: 1000,
  });
  const map = new Map<string, MarketState>();
  for (const r of rows) {
    const pl = (r.payload ?? {}) as Record<string, unknown>;
    const playerId = typeof pl.playerId === 'string' ? pl.playerId : null;
    if (!playerId || map.has(playerId)) continue;
    map.set(playerId, {
      listingId: r.id,
      mode: pl.mode === 'AUCTION' ? 'AUCTION' : 'FIXED',
      askingPriceEur: typeof pl.askingPriceEur === 'number' ? pl.askingPriceEur
        : typeof pl.startingPriceEur === 'number' ? pl.startingPriceEur : 0,
      validUntil: r.validUntil,
      sellerClubId: r.clubId,
    });
  }
  return map;
}

// The state a player is actually in, derived and never asserted by the caller.
function stateOf(
  playerId: string, ownerClubId: string, actorClubId: string,
  market: Map<string, MarketState>, available: Set<string>,
): TransferState {
  if (ownerClubId === actorClubId) return 'OWN';
  const listing = market.get(playerId);
  if (listing) return listing.mode === 'AUCTION' ? 'AUCTION' : 'LISTED';
  return available.has(playerId) ? 'AVAILABLE' : 'NOT_AVAILABLE';
}

// ── the search ───────────────────────────────────────────────────────────────
export async function discover(actor: MarketActor, f: DiscoverFilters = {}) {
  const page = Math.max(1, Math.floor(Number(f.page) || 1));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(f.limit) || DEFAULT_LIMIT)));

  // Filters that restrict WHICH players are candidates have to be resolved
  // before the page is cut, so they are read first and folded into the query.
  const market = await activeListingsByPlayer();

  const wantsListing = !!f.listedOnly || !!f.auctionOnly
    || f.transferStatus === 'LISTED' || f.transferStatus === 'AUCTION';
  const wantsAvailable = f.transferStatus === 'AVAILABLE';
  const wantsUnavailable = f.transferStatus === 'NOT_AVAILABLE';

  // The ids the market filters allow, when one is on.
  let listingIds: string[] | null = null;
  if (wantsListing) {
    listingIds = [...market.entries()]
      .filter(([, m]) => {
        if (f.auctionOnly || f.transferStatus === 'AUCTION') return m.mode === 'AUCTION';
        if (f.transferStatus === 'LISTED') return m.mode === 'FIXED';
        return true;                                    // listedOnly: either kind
      })
      .map(([playerId]) => playerId);
  }

  // Availability is a column on PlayerContractStatus, so it can be asked for
  // directly rather than inferred.
  const availableRows = await prisma.playerContractStatus.findMany({
    where: { isAvailableForTransfer: true }, select: { playerId: true }, take: 5000,
  });
  const available = new Set(availableRows.map((r) => r.playerId));

  // The club's own shortlist, read once — both to filter by it and to mark the
  // rows that are on it.
  const shortlistIds = await shortlistedPlayerIds(actor.clubId);

  const idFilters: string[][] = [];
  if (listingIds) idFilters.push(listingIds);
  if (wantsAvailable) idFilters.push([...available].filter((id) => !market.has(id)));
  if (f.shortlistedOnly) idFilters.push(shortlistIds);

  // An intersection of the id sets each active filter allows. An empty set here
  // is a legitimate answer — no player is in every one of them.
  let allowedIds: string[] | null = null;
  for (const set of idFilters) {
    allowedIds = allowedIds === null ? set : allowedIds.filter((id) => set.includes(id));
  }
  if (allowedIds !== null && allowedIds.length === 0) {
    return emptyPage(page, limit);
  }

  const now = Date.now();
  const where: Prisma.PlayerWhereInput = {
    // Active players only, and never a player whose club row has gone: an
    // invented club cannot appear here because a club that is not in the Club
    // table has no players in the Player table.
    isActive: true,
    club: { is: {} },
    ...(f.includeOwnPlayers ? {} : { clubId: { not: actor.clubId } }),
    ...(f.clubId ? { clubId: f.clubId } : {}),
    ...(allowedIds ? { id: { in: allowedIds } } : {}),
    // NOT_AVAILABLE is the absence of both a listing and an availability flag,
    // so it is expressed as an exclusion rather than an id set.
    ...(wantsUnavailable
      ? { id: { notIn: [...new Set([...market.keys(), ...available])] } }
      : {}),
    ...(f.nationality ? { nationality: { equals: f.nationality, mode: 'insensitive' } } : {}),
    ...(f.position ? { position: f.position as never } : {}),
    ...(f.secondaryPosition
      ? { trainedPositions: { contains: f.secondaryPosition, mode: 'insensitive' } } : {}),
    ...(f.preferredFoot ? { preferredFoot: f.preferredFoot as never } : {}),
    ...((f.ovrMin != null || f.ovrMax != null) && {
      overallRating: {
        ...(f.ovrMin != null ? { gte: Math.round(f.ovrMin) } : {}),
        ...(f.ovrMax != null ? { lte: Math.round(f.ovrMax) } : {}),
      },
    }),
    ...((f.valueMin != null || f.valueMax != null) && {
      marketValue: {
        ...(f.valueMin != null ? { gte: f.valueMin } : {}),
        ...(f.valueMax != null ? { lte: f.valueMax } : {}),
      },
    }),
    // Age is asked for in years and stored as a birth date. The boundaries are
    // computed with the same year length ageFrom() uses, so a player shown as
    // 23 is a player an ageMax of 23 returns.
    ...((f.ageMin != null || f.ageMax != null) && {
      dateOfBirth: {
        ...(f.ageMin != null ? { lte: new Date(now - Number(f.ageMin) * YEAR_MS) } : {}),
        ...(f.ageMax != null ? { gt: new Date(now - (Number(f.ageMax) + 1) * YEAR_MS) } : {}),
      },
    }),
    ...(f.search ? {
      OR: [
        { firstName: { contains: f.search, mode: 'insensitive' } },
        { lastName: { contains: f.search, mode: 'insensitive' } },
        { nationality: { contains: f.search, mode: 'insensitive' } },
      ],
    } : {}),
  };

  // This club's own open needs. Read on every search, not only when filtering
  // by them, so each row can say which of our requirements it answers — that is
  // the whole point of scouting against a stated need.
  const needs = await prisma.clubRecruitmentNeed.findMany({
    where: {
      clubId: actor.clubId, isActive: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }], take: 20,
  });

  const order: Prisma.PlayerOrderByWithRelationInput[] = [{ overallRating: 'desc' }, { id: 'asc' }];

  if (f.matchesMyNeeds) {
    if (!needs.length) return emptyPage(page, limit);
    const scan = await prisma.player.findMany({
      where, select: publicPlayerSelect, orderBy: order, take: SCAN_CAP,
    });
    const matched = scan
      .map((p) => ({ p, needMatches: scoreAgainstNeeds(p, needs) }))
      .filter((r) => r.needMatches.length > 0)
      .sort((a, b) => (b.needMatches[0].matchPct - a.needMatches[0].matchPct)
        || (b.p.overallRating - a.p.overallRating)
        || a.p.id.localeCompare(b.p.id));
    const total = matched.length;
    const slice = matched.slice((page - 1) * limit, (page - 1) * limit + limit);
    return {
      items: await shapeRows(actor, slice.map((r) => r.p), market, available, shortlistIds, needs),
      total, page, limit, scanned: scan.length, scanCapped: scan.length >= SCAN_CAP,
    };
  }

  const [rows, total] = await Promise.all([
    prisma.player.findMany({
      where, select: publicPlayerSelect, orderBy: order,
      skip: (page - 1) * limit, take: limit,
    }),
    prisma.player.count({ where }),
  ]);

  return {
    items: await shapeRows(actor, rows, market, available, shortlistIds, needs),
    total, page, limit, scanned: rows.length, scanCapped: false,
  };
}

function emptyPage(page: number, limit: number) {
  return { items: [], total: 0, page, limit, scanned: 0, scanCapped: false };
}

// The deterministic part, unchanged: matchPlayerToNeed, the same weights, the
// same eligibility rule, the same reasons. A player and a need always produce
// the same number.
type NeedRow = Prisma.ClubRecruitmentNeedGetPayload<Record<string, never>>;

export interface NeedMatch {
  needId: string; matchPct: number; reasons: string[]; criteria: MatchCriterion[];
}

function scoreAgainstNeeds(p: PublicPlayerRow, needs: NeedRow[]): NeedMatch[] {
  const shape = scoringShape(p);
  return needs
    .map((n) => ({ n, m: matchPlayerToNeed(shape, needSpec(n)) }))
    .filter((r) => matchIsEligible(r.m))
    .map((r) => ({ needId: r.n.id, matchPct: r.m.pct, reasons: r.m.reasons, criteria: r.m.criteria }))
    .sort((a, b) => b.matchPct - a.matchPct || a.needId.localeCompare(b.needId));
}

// One club lookup for the whole page, then the rows. No request per player.
async function shapeRows(
  actor: MarketActor,
  rows: PublicPlayerRow[],
  market: Map<string, MarketState>,
  available: Set<string>,
  shortlistIds: string[],
  needs: NeedRow[],
) {
  const clubIds = [...new Set(rows.map((r) => r.clubId))];
  const clubs = await prisma.club.findMany({ where: { id: { in: clubIds } }, select: publicClubSelect });
  const clubOf = (id: string): PublicClub => clubs.find((c) => c.id === id) ?? UNKNOWN_CLUB(id);
  const short = new Set(shortlistIds);

  return rows.map((p) => {
    const state = stateOf(p.id, p.clubId, actor.clubId, market, available);
    const listing = market.get(p.id) ?? null;
    return {
      player: toPublicPlayer(p),
      club: clubOf(p.clubId),
      transferState: state,
      actions: actionsFor(state),
      // Only the market's own figures. A player who is not for sale carries no
      // price here, because his club never named one.
      listingId: listing?.listingId ?? null,
      askingPriceEur: listing?.askingPriceEur ?? null,
      auctionEndsAt: listing?.mode === 'AUCTION' ? listing.validUntil : null,
      shortlisted: short.has(p.id),
      needMatches: scoreAgainstNeeds(p, needs),
    };
  });
}

// ── one player, publicly ─────────────────────────────────────────────────────
// GET /players/:id stays what it is: own club only. This is the other question —
// what any club may know about any footballer — and it is a different read with
// a different shape, not a relaxation of that guard.
export async function readPublicPlayer(actor: MarketActor, playerId: string) {
  const p = await prisma.player.findUnique({ where: { id: playerId }, select: publicPlayerSelect });
  if (!p || p.isActive === false) throw new NotFoundError('Player');

  const [market, availableRow, shortlistIds, needs, club] = await Promise.all([
    activeListingsByPlayer(),
    prisma.playerContractStatus.findUnique({
      where: { playerId }, select: { isAvailableForTransfer: true, contractExpiry: true },
    }),
    shortlistedPlayerIds(actor.clubId),
    prisma.clubRecruitmentNeed.findMany({
      where: {
        clubId: actor.clubId, isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }], take: 20,
    }),
    prisma.club.findUnique({ where: { id: p.clubId }, select: publicClubSelect }),
  ]);

  const available = new Set(availableRow?.isAvailableForTransfer ? [playerId] : []);
  const state = stateOf(playerId, p.clubId, actor.clubId, market, available);
  const listing = market.get(playerId) ?? null;

  // The move record is public — it is what the two clubs did, not what either
  // one knows. It is already read this way by the offers screen.
  const history = await prisma.athleteTransferHistory.findMany({
    where: { athleteId: playerId }, orderBy: { occurredAt: 'desc' }, take: 20,
  });
  const historyClubIds = [...new Set(history.flatMap((h) => [h.fromClubRef, h.toClubRef]).filter(Boolean) as string[])];
  const historyClubs = await prisma.club.findMany({
    where: { id: { in: historyClubIds } }, select: publicClubSelect,
  });
  const hClub = (id: string | null) => (id
    ? historyClubs.find((c) => c.id === id) ?? UNKNOWN_CLUB(id)
    : null);

  return {
    player: toPublicPlayer(p),
    club: club ?? UNKNOWN_CLUB(p.clubId),
    transferState: state,
    actions: actionsFor(state),
    listingId: listing?.listingId ?? null,
    askingPriceEur: listing?.askingPriceEur ?? null,
    auctionEndsAt: listing?.mode === 'AUCTION' ? listing.validUntil : null,
    contractUntil: p.contractUntil ?? availableRow?.contractExpiry ?? null,
    shortlisted: shortlistIds.includes(playerId),
    needMatches: state === 'OWN' ? [] : scoreAgainstNeeds(p, needs),
    history: history.map((h) => ({
      id: h.id,
      occurredAt: h.occurredAt,
      feeEur: h.feeCents === null ? null : Number(h.feeCents) / 100,
      from: hClub(h.fromClubRef),
      to: hClub(h.toClubRef),
    })),
  };
}

// ── the shortlist ────────────────────────────────────────────────────────────
// TransferTarget, which already exists, is already club-scoped, already audited
// and already refuses a duplicate. Scouting does not get a second store; it gets
// the one the platform has, hydrated through the public projection.
async function shortlistedPlayerIds(clubId: string): Promise<string[]> {
  const rows = await prisma.transferTarget.findMany({
    where: { clubId, archivedAt: null }, select: { playerId: true }, take: 500,
  });
  return rows.map((r) => r.playerId);
}

export async function readShortlist(actor: MarketActor) {
  const targets = await prisma.transferTarget.findMany({
    where: { clubId: actor.clubId, archivedAt: null },
    orderBy: [{ priorityScore: 'desc' }, { updatedAt: 'desc' }], take: 200,
  });
  if (!targets.length) return { items: [] };

  const [players, market, availableRows, needs] = await Promise.all([
    prisma.player.findMany({
      where: { id: { in: targets.map((t) => t.playerId) } }, select: publicPlayerSelect,
    }),
    activeListingsByPlayer(),
    prisma.playerContractStatus.findMany({
      where: { playerId: { in: targets.map((t) => t.playerId) }, isAvailableForTransfer: true },
      select: { playerId: true },
    }),
    prisma.clubRecruitmentNeed.findMany({
      where: {
        clubId: actor.clubId, isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }], take: 20,
    }),
  ]);
  const available = new Set(availableRows.map((r) => r.playerId));
  const rows = await shapeRows(
    actor, players, market, available, targets.map((t) => t.playerId), needs,
  );

  // A shortlisted player whose row has gone — sold on, deactivated — is reported
  // as gone rather than quietly dropped, because the club put him there.
  return {
    items: targets.map((t) => {
      const row = rows.find((r) => r.player.id === t.playerId) ?? null;
      return {
        targetId: t.id,
        playerId: t.playerId,
        stage: t.stage,
        priorityScore: t.priorityScore,
        notes: t.notes,
        addedAt: t.createdAt,
        ...(row ?? { player: null, club: null, transferState: null, actions: [], unavailable: true }),
      };
    }),
  };
}

export async function addToShortlist(actor: MarketActor, playerId: string, notes?: string) {
  if (!playerId) throw new BadRequestError('playerId required');
  const player = await prisma.player.findUnique({
    where: { id: playerId }, select: { id: true, clubId: true, isActive: true },
  });
  if (!player) throw new NotFoundError('Player');
  if (player.isActive === false) throw new BadRequestError('That player is not active');

  // Asking twice is the same shortlist entry, not a second one — the same rule
  // the existing pipeline enforces.
  const existing = await prisma.transferTarget.findFirst({
    where: { clubId: actor.clubId, playerId, archivedAt: null },
  });
  if (existing) return existing;

  return prisma.transferTarget.create({
    data: {
      clubId: actor.clubId, playerId, stage: 'SHORTLIST',
      notes: notes?.slice(0, 500) ?? null, createdBy: actor.userId,
    },
  });
}

export async function removeFromShortlist(actor: MarketActor, playerId: string) {
  // Scoped by the acting club, so a club can only ever take a player off its
  // own list. Archived rather than deleted: the pipeline keeps its history, and
  // re-adding him later is a new entry.
  const done = await prisma.transferTarget.updateMany({
    where: { clubId: actor.clubId, playerId, archivedAt: null },
    data: { archivedAt: new Date() },
  });
  if (!done.count) throw new NotFoundError('Shortlist entry');
  return { removed: done.count, playerId };
}

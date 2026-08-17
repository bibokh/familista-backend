// Familista — club-to-club transfer market controller
// Delegates every decision to transfer-market.service.ts

import { Request, Response, NextFunction } from 'express';
import * as svc from '../transfer-market/transfer-market.service';
import * as neg from '../transfer-market/transfer-negotiation.service';
import * as auc from '../transfer-market/transfer-auction.service';
import * as dis from '../transfer-market/transfer-discovery.service';
import { sendSuccess, sendCreated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUUID(id: string | undefined, name: string): string {
  if (!id || !UUID_RE.test(id)) throw new BadRequestError(`${name} must be a valid UUID`);
  return id;
}
function actor(req: Request): svc.MarketActor {
  return { userId: req.user!.id, clubId: req.user!.clubId, role: req.user!.role };
}

export async function readMarket(req: Request, res: Response, next: NextFunction) {
  try {
    const page  = req.query.page  ? parseInt(String(req.query.page), 10)  : 1;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    return sendSuccess(res, await svc.readMarket(actor(req), { page, limit }));
  } catch (err) { return next(err); }
}

export async function readOwnListings(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.readOwnListings(actor(req))); }
  catch (err) { return next(err); }
}

export async function getBalance(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.getBalance(req.user!.clubId)); }
  catch (err) { return next(err); }
}

export async function listPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = req.body as svc.ListDto;
    requireUUID(dto?.playerId, 'playerId');
    return sendCreated(res, await svc.listPlayer(actor(req), dto));
  } catch (err) { return next(err); }
}

export async function delistPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.listingId, 'listingId');
    return sendSuccess(res, await svc.delistPlayer(actor(req), id));
  } catch (err) { return next(err); }
}

export async function purchase(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.listingId, 'listingId');
    return sendSuccess(res, await svc.purchase(actor(req), id));
  } catch (err) { return next(err); }
}

export async function bootstrapRoster(req: Request, res: Response, next: NextFunction) {
  try {
    const teams = (req.body?.teams ?? []) as svc.BootstrapTeamDto[];
    return sendSuccess(res, await svc.bootstrapRoster(actor(req), teams));
  } catch (err) { return next(err); }
}

// ── club-to-club negotiation ─────────────────────────────────────────────────
// Every handler passes the acting club from the session; none of them reads a
// club id out of the request body.

export async function registerInterest(req: Request, res: Response, next: NextFunction) {
  try {
    const playerId = requireUUID(req.body?.playerId, 'playerId');
    return sendCreated(res, await neg.registerInterest(actor(req), playerId, req.body?.message));
  } catch (err) { return next(err); }
}

export async function respondToInterest(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.interestId, 'interestId');
    return sendSuccess(res, await neg.respondToInterest(actor(req), id, req.body?.status));
  } catch (err) { return next(err); }
}

export async function makeOffer(req: Request, res: Response, next: NextFunction) {
  try {
    requireUUID(req.body?.playerId, 'playerId');
    return sendCreated(res, await neg.makeOffer(actor(req), req.body as neg.OfferDto));
  } catch (err) { return next(err); }
}

export async function readOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.offerId, 'offerId');
    return sendSuccess(res, await neg.readOffer(actor(req), id));
  } catch (err) { return next(err); }
}

export async function acceptOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.offerId, 'offerId');
    return sendSuccess(res, await neg.acceptOffer(actor(req), id));
  } catch (err) { return next(err); }
}

export async function rejectOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.offerId, 'offerId');
    return sendSuccess(res, await neg.rejectOffer(actor(req), id));
  } catch (err) { return next(err); }
}

export async function withdrawOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.offerId, 'offerId');
    return sendSuccess(res, await neg.withdrawOffer(actor(req), id));
  } catch (err) { return next(err); }
}

export async function counterOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.offerId, 'offerId');
    return sendCreated(res, await neg.counterOffer(actor(req), id, req.body?.feeEur, req.body?.message));
  } catch (err) { return next(err); }
}

export async function readOffersForPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.playerId, 'playerId');
    return sendSuccess(res, await neg.readOffersForPlayer(actor(req), id));
  } catch (err) { return next(err); }
}

export async function readActivity(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await neg.readActivity(actor(req))); }
  catch (err) { return next(err); }
}

// ── recruitment needs ────────────────────────────────────────────────────────
export async function createNeed(req: Request, res: Response, next: NextFunction) {
  try { return sendCreated(res, await neg.createNeed(actor(req), req.body as neg.NeedDto)); }
  catch (err) { return next(err); }
}
export async function updateNeed(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.needId, 'needId');
    return sendSuccess(res, await neg.updateNeed(actor(req), id, req.body as neg.NeedDto));
  } catch (err) { return next(err); }
}
export async function deleteNeed(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.needId, 'needId');
    return sendSuccess(res, await neg.deleteNeed(actor(req), id));
  } catch (err) { return next(err); }
}
export async function readOwnNeeds(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await neg.readOwnNeeds(actor(req))); }
  catch (err) { return next(err); }
}
export async function readMarketNeeds(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await neg.readMarketNeeds(actor(req))); }
  catch (err) { return next(err); }
}

// ── matching and targeted offering ───────────────────────────────────────────
export async function matchesForPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.playerId, 'playerId');
    const ask = req.query.askingPriceEur ? Number(req.query.askingPriceEur) : undefined;
    return sendSuccess(res, await neg.matchesForPlayer(actor(req), id, ask));
  } catch (err) { return next(err); }
}

// Which of the caller's own players fit another club's published need. The
// club is the authenticated one, never a parameter — see matchesForNeed.
export async function matchesForNeed(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.needId, 'needId');
    return sendSuccess(res, await neg.matchesForNeed(actor(req), id));
  } catch (err) { return next(err); }
}

// The seller answers another club's need with one of its own players. The
// offer it creates is an ordinary TransferOffer, so it counters and settles
// through the paths that already exist.
export async function offerPlayerToNeed(req: Request, res: Response, next: NextFunction) {
  try {
    requireUUID(req.body?.playerId, 'playerId');
    requireUUID(req.body?.needId, 'needId');
    return sendCreated(res, await neg.offerPlayerToNeed(actor(req), req.body));
  } catch (err) { return next(err); }
}

export async function readNegotiation(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.offerId, 'offerId');
    return sendSuccess(res, await neg.readNegotiation(actor(req), id));
  } catch (err) { return next(err); }
}

// ── auctions ────────────────────────────────────────────────────────────────
// Every one of these resolves the acting club from the session; none of them
// reads an owner, a bidder or a price ceiling from the request body.
export async function listAuction(req: Request, res: Response, next: NextFunction) {
  try {
    requireUUID(req.body?.playerId, 'playerId');
    return sendCreated(res, await auc.listAuction(actor(req), req.body));
  } catch (err) { return next(err); }
}

export async function readAuctions(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await auc.readAuctions(actor(req)));
  } catch (err) { return next(err); }
}

export async function readAuction(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.listingId, 'listingId');
    return sendSuccess(res, await auc.readAuction(actor(req), id));
  } catch (err) { return next(err); }
}

export async function placeBid(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.listingId, 'listingId');
    return sendCreated(res, await auc.placeBid(actor(req), id, Number(req.body?.amountEur)));
  } catch (err) { return next(err); }
}

export async function cancelAuction(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.listingId, 'listingId');
    return sendSuccess(res, await auc.cancelAuction(actor(req), id));
  } catch (err) { return next(err); }
}

// The market's activity. The service decides what is public and what belongs
// to the caller's own club — the request cannot ask for another club's side.
export async function readMarketFeed(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await neg.readMarketFeed(actor(req)));
  } catch (err) { return next(err); }
}

export async function readMarketCompleted(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await neg.readMarketCompleted());
  } catch (err) { return next(err); }
}

export async function readCompletedDeals(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await neg.readCompletedDeals(actor(req)));
  } catch (err) { return next(err); }
}

export async function offerPlayerToClubs(req: Request, res: Response, next: NextFunction) {
  try {
    requireUUID(req.body?.playerId, 'playerId');
    return sendCreated(res, await neg.offerPlayerToClubs(actor(req), req.body));
  } catch (err) { return next(err); }
}

// ── scouting: discovery, the public player, the shortlist ───────────────────
// Every filter is parsed here and handed to the service as a typed value. The
// acting club is never read from the query — a club can only ever search as
// itself, and `includeOwnPlayers` is deliberately not accepted from the wire.
const bool = (v: unknown) => String(v) === 'true' || v === true;
const int  = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v));
const str  = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' || s.toUpperCase() === 'ALL' ? undefined : s;
};

export async function discover(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query;
    return sendSuccess(res, await dis.discover(actor(req), {
      search:            str(q.search),
      clubId:            str(q.clubId),
      nationality:       str(q.nationality),
      position:          str(q.position),
      secondaryPosition: str(q.secondaryPosition),
      preferredFoot:     str(q.preferredFoot),
      transferStatus:    str(q.transferStatus),
      ageMin:            int(q.ageMin),   ageMax:   int(q.ageMax),
      ovrMin:            int(q.ovrMin),   ovrMax:   int(q.ovrMax),
      valueMin:          int(q.valueMin), valueMax: int(q.valueMax),
      listedOnly:        bool(q.listedOnly),
      auctionOnly:       bool(q.auctionOnly),
      matchesMyNeeds:    bool(q.matchesMyNeeds),
      shortlistedOnly:   bool(q.shortlistedOnly),
      page:              int(q.page),
      limit:             int(q.limit),
    }));
  } catch (err) { return next(err); }
}

export async function readPublicPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.playerId, 'playerId');
    return sendSuccess(res, await dis.readPublicPlayer(actor(req), id));
  } catch (err) { return next(err); }
}

export async function readShortlist(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await dis.readShortlist(actor(req))); }
  catch (err) { return next(err); }
}

export async function addToShortlist(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.body?.playerId, 'playerId');
    return sendCreated(res, await dis.addToShortlist(actor(req), id, req.body?.notes));
  } catch (err) { return next(err); }
}

export async function removeFromShortlist(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.playerId, 'playerId');
    return sendSuccess(res, await dis.removeFromShortlist(actor(req), id));
  } catch (err) { return next(err); }
}

// The club's own transfer desk: everything it has on the market, everything
// being negotiated either way, and where its players actually went. One read,
// club-scoped inside the service.
export async function readMyClub(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await dis.readMyClub(actor(req))); }
  catch (err) { return next(err); }
}

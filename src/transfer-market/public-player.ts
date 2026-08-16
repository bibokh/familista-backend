// Familista — the one public player projection
// ─────────────────────────────────────────────────────────────────────────────
// A Player row carries two very different kinds of fact. Some of it is football
// — where he plays, how good he is, what he is worth — and belongs to anyone who
// can see him on a market. The rest is a child's contact details, his guardian's
// phone number, his medical state, whether his club has been paid, and the notes
// his coaches keep. None of that has ever been anybody else's business.
//
// This module is the only place a player is shaped for a club that does not own
// him. It exists because the alternative — reading the whole row and trusting
// each screen to leave the private half alone — had already failed: the market
// listing read handed every other club the full record, guardian phone number
// included.
//
// Two rules keep it honest:
//   1. The SELECT is explicit. A column that is not named here is never loaded,
//      so a new private column added to Player tomorrow cannot leak by default.
//   2. The projection is BUILT, field by field. Nothing is spread, so a column
//      that is loaded for scoring (roles, dateOfBirth) still cannot reach the
//      response unless it is written out on purpose.
//
// Age is emitted; dateOfBirth is not. The date is read because matching needs
// it and because age has to be derived from something, but a birth date is
// identifying in a way that "23" is not.

import { Prisma } from '@prisma/client';

// ── what is read from the database ───────────────────────────────────────────
// Everything here is either emitted publicly or used to derive something that
// is. Nothing else is loaded.
export const publicPlayerSelect = {
  id: true,
  firstName: true,
  lastName: true,
  number: true,
  position: true,
  trainedPositions: true,
  nationality: true,
  flag: true,
  avatar: true,
  overallRating: true,
  potential: true,
  preferredFoot: true,
  marketValue: true,
  contractUntil: true,
  clubId: true,
  // read, never emitted: age is derived from this, and the need-matching engine
  // takes the date itself.
  dateOfBirth: true,
  // read, never emitted: the playstyle criterion of matchPlayerToNeed reads it.
  roles: true,
  // read, never emitted: discovery shows active players only.
  isActive: true,
} as const;

export type PublicPlayerRow = Prisma.PlayerGetPayload<{ select: typeof publicPlayerSelect }>;

// ── what leaves the server ───────────────────────────────────────────────────
export interface PublicPlayer {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  number: number;
  position: string;
  trainedPositions: string[];
  nationality: string;
  flag: string;
  avatar: string | null;
  age: number | null;
  overallRating: number;
  potential: number;
  preferredFoot: string;
  marketValue: number;
  contractUntil: Date | null;
  clubId: string;
}

// Every private column on Player, named. Nothing uses this list at runtime —
// it is here so the regression tests can assert against the same enumeration
// the projection was written from, and so the next person to add a column to
// Player has somewhere obvious to declare which half it belongs to.
export const PRIVATE_PLAYER_FIELDS = [
  'email', 'parentName', 'parentEmail', 'parentPhone', 'notes',
  'medicalStatus', 'paymentStatus', 'condition', 'form', 'morale',
  'isInjured', 'weeklyWage', 'height', 'weight', 'legacyId',
  'isCaptain', 'isViceCaptain', 'teamId', 'joinedAt', 'dateOfBirth',
  'attributes', 'gpsData', 'gpsSessions', 'injuries', 'injuryRecords',
  'device', 'auditLogs', 'matchStats', 'trainingStats', 'workloadRecords',
  'roles', 'isActive',
] as const;

export function ageFrom(dob: Date | null): number | null {
  if (!dob) return null;
  return Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000));
}

// The projection itself. Written out one field at a time, deliberately: a spread
// here would put every future Player column on the public wire.
export function toPublicPlayer(p: PublicPlayerRow): PublicPlayer {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    name: `${p.firstName} ${p.lastName}`.trim(),
    number: p.number,
    position: String(p.position),
    trainedPositions: String(p.trainedPositions ?? '')
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    nationality: p.nationality,
    flag: p.flag,
    avatar: p.avatar ?? null,
    age: ageFrom(p.dateOfBirth),
    overallRating: p.overallRating,
    potential: p.potential,
    preferredFoot: String(p.preferredFoot),
    marketValue: p.marketValue,
    contractUntil: p.contractUntil ?? null,
    clubId: p.clubId,
  };
}

// The shape matchPlayerToNeed takes. Same row, same read — the scoring engine
// needs the birth date and the playstyle string that the public shape drops, so
// it is handed those separately rather than the projection being widened.
export function scoringShape(p: PublicPlayerRow) {
  return {
    position: String(p.position),
    trainedPositions: p.trainedPositions,
    roles: p.roles,
    dateOfBirth: p.dateOfBirth,
    overallRating: p.overallRating,
    marketValue: p.marketValue,
    preferredFoot: String(p.preferredFoot),
    nationality: p.nationality,
  };
}

// ── the public club ──────────────────────────────────────────────────────────
export const publicClubSelect = {
  id: true, name: true, shortName: true, emblem: true,
} as const;

export interface PublicClub {
  id: string; name: string; shortName: string | null; emblem: string | null;
}

export const UNKNOWN_CLUB = (id: string): PublicClub =>
  ({ id, name: 'Unknown / unavailable club', shortName: null, emblem: null });

// ── transfer state ───────────────────────────────────────────────────────────
// Being visible in a search is not the same as being for sale, and the two were
// never allowed to blur into each other. The state below is derived from what
// the owning club actually did — listed him, auctioned him, marked him
// available — and never from what the reader would like to be true.
export type TransferState = 'OWN' | 'AUCTION' | 'LISTED' | 'AVAILABLE' | 'NOT_AVAILABLE';

// What the reader may do about him, decided here rather than in the browser.
export type TransferAction =
  | 'VIEW_AUCTION' | 'VIEW_LISTING' | 'PURCHASE' | 'MAKE_OFFER' | 'REGISTER_INTEREST';

export function actionsFor(state: TransferState): TransferAction[] {
  switch (state) {
    // His club is selling him by auction: the bid is the only way in.
    case 'AUCTION':        return ['VIEW_AUCTION'];
    // A price is published, so it can simply be paid — or negotiated.
    case 'LISTED':         return ['VIEW_LISTING', 'PURCHASE', 'MAKE_OFFER'];
    // His club says he may go, without naming a price.
    case 'AVAILABLE':      return ['MAKE_OFFER', 'REGISTER_INTEREST'];
    // Nobody said he was for sale. You may ask; you may not table a fee as
    // though he were on the market.
    case 'NOT_AVAILABLE':  return ['REGISTER_INTEREST'];
    // Our own player. There is no transfer action to take on him here.
    case 'OWN':            return [];
  }
}

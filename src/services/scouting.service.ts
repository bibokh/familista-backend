// Familista — Scouting & Recruitment Center
// ─────────────────────────────────────────────────────────────────────────────
// Complete external player scouting database with:
//   • Prospect CRUD (external players, no Player FK required)
//   • Technical / physical / mental evaluation (22 attributes, 1–100)
//   • Auto-calculated ratings: currentRating, potentialRating, recommendationScore
//   • Position fit engine (8 positions)
//   • Risk assessment engine (4 risk dimensions)
//   • Watchlist management (4 categories)
//   • Recruitment pipeline (8 stages)
//   • Scout dashboard KPIs and distribution data
//   • Side-by-side comparison engine
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma, ScoutProspect } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';

export interface ScoutActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline stages (ordered)
// ─────────────────────────────────────────────────────────────────────────────

export const PIPELINE_STAGES = [
  'IDENTIFIED', 'SCOUTED', 'REVIEWED', 'NEGOTIATION',
  'TRIAL', 'APPROVED', 'SIGNED', 'REJECTED',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

const STAGE_ORDER: Record<string, number> = {
  IDENTIFIED: 0, SCOUTED: 1, REVIEWED: 2, NEGOTIATION: 3,
  TRIAL: 4, APPROVED: 5, SIGNED: 6, REJECTED: 6,
};

const TERMINAL_STAGES = new Set(['SIGNED', 'REJECTED']);

// ─────────────────────────────────────────────────────────────────────────────
// Recommendation levels
// ─────────────────────────────────────────────────────────────────────────────

export const RECOMMENDATION_LEVELS = [
  'REJECT', 'MONITOR', 'INTERESTING', 'STRONG_TARGET', 'PRIORITY_TARGET',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateProspectDto {
  playerName:         string;
  position:           string;
  dateOfBirth?:       string;   // ISO date
  age?:               number;
  nationality?:       string;
  currentClub?:       string;
  league?:            string;
  secondaryPositions?: string[];
  preferredFoot?:     string;
  heightCm?:          number;
  weightKg?:          number;
  marketValueEur?:    number;
  contractUntil?:     string;   // ISO date
  agentName?:         string;
  scoutName?:         string;
  reportDate?:        string;   // ISO date
  status?:            string;

  // Technical (optional on creation)
  pace?:              number;
  acceleration?:      number;
  agility?:           number;
  dribbling?:         number;
  ballControl?:       number;
  passing?:           number;
  vision?:            number;
  crossing?:          number;
  finishing?:         number;
  shooting?:          number;
  heading?:           number;
  tackling?:          number;
  positioning?:       number;
  composure?:         number;
  decisionMaking?:    number;

  // Physical
  strength?:          number;
  stamina?:           number;
  endurance?:         number;
  balance?:           number;
  mobility?:          number;
  explosiveness?:     number;

  // Mental
  leadership?:        number;
  discipline?:        number;
  concentration?:     number;
  workRate?:          number;
  determination?:     number;
  professionalism?:   number;
  coachability?:      number;

  // Report fields
  strengths?:           string;
  weaknesses?:          string;
  tacticalFit?:         string;
  developmentAreas?:    string;
  comments?:            string;
  finalRecommendation?: string;

  // Watchlist
  isOnWatchlist?:      boolean;
  watchlistCategory?:  string;
  watchlistPriority?:  number;
  followUpDate?:       string;
}

export type UpdateProspectDto = Partial<CreateProspectDto>;

// ─────────────────────────────────────────────────────────────────────────────
// Attribute validation
// ─────────────────────────────────────────────────────────────────────────────

const ATTR_FIELDS = [
  'pace','acceleration','agility','dribbling','ballControl','passing',
  'vision','crossing','finishing','shooting','heading','tackling',
  'positioning','composure','decisionMaking',
  'strength','stamina','endurance','balance','mobility','explosiveness',
  'leadership','discipline','concentration','workRate','determination',
  'professionalism','coachability',
] as const;

type AttrField = (typeof ATTR_FIELDS)[number];

function _validateAttributes(dto: Partial<Record<AttrField, number>>): void {
  for (const key of ATTR_FIELDS) {
    const v = (dto as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isInteger(v as number) || (v as number) < 1 || (v as number) > 100) {
      throw new BadRequestError(`${key} must be an integer between 1 and 100`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Calculated scores
// ─────────────────────────────────────────────────────────────────────────────

function _avg(vals: (number | null | undefined)[]): number | null {
  const clean = vals.filter((v): v is number => typeof v === 'number' && v > 0);
  return clean.length ? +(clean.reduce((s, v) => s + v, 0) / clean.length).toFixed(1) : null;
}

/** Current rating = weighted average of all attribute groups */
function _computeCurrentRating(dto: Partial<Record<AttrField, number>>): number | null {
  const technical = _avg([
    dto.pace, dto.acceleration, dto.agility, dto.dribbling, dto.ballControl,
    dto.passing, dto.vision, dto.crossing, dto.finishing, dto.shooting,
    dto.heading, dto.tackling, dto.positioning, dto.composure, dto.decisionMaking,
  ]);
  const physical  = _avg([dto.strength, dto.stamina, dto.endurance, dto.balance, dto.mobility, dto.explosiveness]);
  const mental    = _avg([dto.leadership, dto.discipline, dto.concentration, dto.workRate, dto.determination, dto.professionalism, dto.coachability]);

  const parts = [technical, physical, mental].filter((v): v is number => v !== null);
  if (!parts.length) return null;
  // Technical weighted 50%, physical 30%, mental 20%
  const weights = [0.5, 0.3, 0.2];
  let weightSum = 0;
  let total     = 0;
  [technical, physical, mental].forEach((v, i) => {
    if (v !== null) { total += v * weights[i]; weightSum += weights[i]; }
  });
  return weightSum > 0 ? +(total / weightSum).toFixed(1) : null;
}

/** Potential rating: younger players with high current rating have higher potential */
function _computePotentialRating(currentRating: number | null, age: number | null | undefined): number | null {
  if (!currentRating) return null;
  const a = age ?? 24;
  // Young players (≤20) get +15 potential, tapering to 0 at 30+
  const youthBonus = Math.max(0, (30 - a) * 1.5);
  return Math.min(100, +(currentRating + youthBonus).toFixed(1));
}

/** Recommendation score 0–100 from current+potential+age factor */
function _computeRecommendationScore(current: number | null, potential: number | null, age: number | null | undefined): number | null {
  if (!current) return null;
  const p = potential ?? current;
  const a = age ?? 24;
  const ageFactor = Math.max(0, (32 - a) / 32); // younger = higher
  const score = (current * 0.5 + p * 0.3) * 0.7 + ageFactor * 30;
  return Math.min(100, +score.toFixed(1));
}

/** Map recommendation score to level */
function _recommendationLevel(score: number | null): string | null {
  if (score === null) return null;
  if (score >= 80) return 'PRIORITY_TARGET';
  if (score >= 70) return 'STRONG_TARGET';
  if (score >= 55) return 'INTERESTING';
  if (score >= 40) return 'MONITOR';
  return 'REJECT';
}

// ─────────────────────────────────────────────────────────────────────────────
// Position fit engine
// ─────────────────────────────────────────────────────────────────────────────

function _computePositionFit(dto: Partial<Record<AttrField, number>>): Record<string, number | null> {
  const fit = (weights: Array<[AttrField, number]>): number | null => {
    const scored = weights.filter(([k]) => dto[k] != null);
    if (scored.length < 3) return null;
    const total = scored.reduce((s, [k, w]) => s + (dto[k]! * w), 0);
    const wSum  = scored.reduce((s, [, w]) => s + w, 0);
    return wSum > 0 ? Math.round(total / wSum) : null;
  };

  return {
    fitGK:     fit([['positioning',3],['composure',3],['concentration',3],['leadership',2],['strength',2],['balance',2]]),
    fitCB:     fit([['tackling',3],['heading',3],['strength',3],['positioning',3],['concentration',2],['pace',1]]),
    fitFB:     fit([['pace',3],['crossing',3],['stamina',2],['tackling',2],['agility',2],['dribbling',1]]),
    fitDM:     fit([['tackling',3],['positioning',3],['workRate',3],['passing',2],['concentration',2],['stamina',2]]),
    fitCM:     fit([['passing',3],['vision',3],['stamina',2],['workRate',2],['decisionMaking',3],['composure',2]]),
    fitAM:     fit([['vision',3],['passing',3],['dribbling',3],['decisionMaking',3],['composure',2],['shooting',1]]),
    fitWinger: fit([['pace',3],['dribbling',3],['crossing',3],['agility',2],['shooting',2],['stamina',2]]),
    fitStriker:fit([['finishing',3],['shooting',3],['pace',2],['heading',2],['composure',3],['positioning',3]]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk assessment engine
// ─────────────────────────────────────────────────────────────────────────────

function _computeRiskAssessment(
  dto: Partial<Record<AttrField, number>>,
  age: number | null | undefined,
  marketValueEur: number | null | undefined,
): Record<string, string> {
  // Injury risk: lower stamina/strength/balance → higher risk
  const injAttr = _avg([dto.stamina, dto.strength, dto.balance, dto.endurance]);
  const injuryRisk = !injAttr ? 'MEDIUM'
    : injAttr >= 70 ? 'LOW'
    : injAttr >= 50 ? 'MEDIUM'
    : 'HIGH';

  // Adaptation risk: lower workRate/coachability/discipline → higher risk
  const adaptAttr = _avg([dto.workRate, dto.coachability, dto.concentration, dto.professionalism]);
  const adaptationRisk = !adaptAttr ? 'MEDIUM'
    : adaptAttr >= 70 ? 'LOW'
    : adaptAttr >= 50 ? 'MEDIUM'
    : 'HIGH';

  // Discipline risk: lower discipline/professionalism → higher risk
  const discAttr = _avg([dto.discipline, dto.professionalism, dto.determination]);
  const disciplineRisk = !discAttr ? 'LOW'
    : discAttr >= 70 ? 'LOW'
    : discAttr >= 50 ? 'MEDIUM'
    : 'HIGH';

  // Financial risk: based on market value relative to club budget
  const mv = marketValueEur ?? 0;
  const financialRisk = mv === 0 ? 'LOW'
    : mv > 20_000_000 ? 'HIGH'
    : mv > 8_000_000  ? 'MEDIUM'
    : 'LOW';

  return { injuryRisk, adaptationRisk, disciplineRisk, financialRisk };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build computed fields from dto
// ─────────────────────────────────────────────────────────────────────────────

function _buildComputedFields(dto: CreateProspectDto | UpdateProspectDto) {
  const attrs = dto as Partial<Record<AttrField, number>>;
  const currentRating      = _computeCurrentRating(attrs);
  const potentialRating    = _computePotentialRating(currentRating, dto.age ?? null);
  const recommendationScore= _computeRecommendationScore(currentRating, potentialRating, dto.age ?? null);
  const recommendation     = _recommendationLevel(recommendationScore);
  const positionFit        = _computePositionFit(attrs);
  const risks              = _computeRiskAssessment(attrs, dto.age ?? null, dto.marketValueEur ?? null);

  return {
    currentRating:       currentRating     ?? undefined,
    potentialRating:     potentialRating   ?? undefined,
    recommendationScore: recommendationScore ?? undefined,
    recommendation:      recommendation    ?? undefined,
    ...positionFit,
    ...risks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Prisma data object from DTO
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _dtoToPrisma(dto: CreateProspectDto | UpdateProspectDto, computed: Record<string, any>) {
  return {
    ...(dto.playerName         !== undefined ? { playerName:         dto.playerName }                                : {}),
    ...(dto.position           !== undefined ? { position:           dto.position }                                   : {}),
    ...(dto.dateOfBirth        !== undefined ? { dateOfBirth:        dto.dateOfBirth ? new Date(dto.dateOfBirth) : null } : {}),
    ...(dto.age                !== undefined ? { age:                dto.age }                                         : {}),
    ...(dto.nationality        !== undefined ? { nationality:        dto.nationality }                                 : {}),
    ...(dto.currentClub        !== undefined ? { currentClub:        dto.currentClub }                                 : {}),
    ...(dto.league             !== undefined ? { league:             dto.league }                                      : {}),
    ...(dto.secondaryPositions !== undefined ? { secondaryPositions: dto.secondaryPositions ?? [] }                   : {}),
    ...(dto.preferredFoot      !== undefined ? { preferredFoot:      dto.preferredFoot }                               : {}),
    ...(dto.heightCm           !== undefined ? { heightCm:           dto.heightCm }                                    : {}),
    ...(dto.weightKg           !== undefined ? { weightKg:           dto.weightKg }                                    : {}),
    ...(dto.marketValueEur     !== undefined ? { marketValueEur:     dto.marketValueEur }                              : {}),
    ...(dto.contractUntil      !== undefined ? { contractUntil:      dto.contractUntil ? new Date(dto.contractUntil) : null } : {}),
    ...(dto.agentName          !== undefined ? { agentName:          dto.agentName }                                   : {}),
    ...(dto.scoutName          !== undefined ? { scoutName:          dto.scoutName }                                   : {}),
    ...(dto.reportDate         !== undefined ? { reportDate:         dto.reportDate ? new Date(dto.reportDate) : null } : {}),
    ...(dto.status             !== undefined ? { status:             dto.status }                                       : {}),
    // Technical
    ...(dto.pace               !== undefined ? { pace:               dto.pace }               : {}),
    ...(dto.acceleration       !== undefined ? { acceleration:       dto.acceleration }       : {}),
    ...(dto.agility            !== undefined ? { agility:            dto.agility }             : {}),
    ...(dto.dribbling          !== undefined ? { dribbling:          dto.dribbling }           : {}),
    ...(dto.ballControl        !== undefined ? { ballControl:        dto.ballControl }         : {}),
    ...(dto.passing            !== undefined ? { passing:            dto.passing }             : {}),
    ...(dto.vision             !== undefined ? { vision:             dto.vision }               : {}),
    ...(dto.crossing           !== undefined ? { crossing:           dto.crossing }             : {}),
    ...(dto.finishing          !== undefined ? { finishing:          dto.finishing }             : {}),
    ...(dto.shooting           !== undefined ? { shooting:           dto.shooting }             : {}),
    ...(dto.heading            !== undefined ? { heading:            dto.heading }               : {}),
    ...(dto.tackling           !== undefined ? { tackling:           dto.tackling }             : {}),
    ...(dto.positioning        !== undefined ? { positioning:        dto.positioning }           : {}),
    ...(dto.composure          !== undefined ? { composure:          dto.composure }             : {}),
    ...(dto.decisionMaking     !== undefined ? { decisionMaking:     dto.decisionMaking }       : {}),
    // Physical
    ...(dto.strength           !== undefined ? { strength:           dto.strength }             : {}),
    ...(dto.stamina            !== undefined ? { stamina:            dto.stamina }               : {}),
    ...(dto.endurance          !== undefined ? { endurance:          dto.endurance }             : {}),
    ...(dto.balance            !== undefined ? { balance:            dto.balance }               : {}),
    ...(dto.mobility           !== undefined ? { mobility:           dto.mobility }               : {}),
    ...(dto.explosiveness      !== undefined ? { explosiveness:      dto.explosiveness }         : {}),
    // Mental
    ...(dto.leadership         !== undefined ? { leadership:         dto.leadership }             : {}),
    ...(dto.discipline         !== undefined ? { discipline:         dto.discipline }             : {}),
    ...(dto.concentration      !== undefined ? { concentration:      dto.concentration }         : {}),
    ...(dto.workRate           !== undefined ? { workRate:           dto.workRate }               : {}),
    ...(dto.determination      !== undefined ? { determination:      dto.determination }         : {}),
    ...(dto.professionalism    !== undefined ? { professionalism:    dto.professionalism }       : {}),
    ...(dto.coachability       !== undefined ? { coachability:       dto.coachability }           : {}),
    // Report
    ...(dto.strengths              !== undefined ? { strengths:              dto.strengths }           : {}),
    ...(dto.weaknesses             !== undefined ? { weaknesses:             dto.weaknesses }          : {}),
    ...(dto.tacticalFit            !== undefined ? { tacticalFit:            dto.tacticalFit }         : {}),
    ...(dto.developmentAreas       !== undefined ? { developmentAreas:       dto.developmentAreas }    : {}),
    ...(dto.comments               !== undefined ? { comments:               dto.comments }             : {}),
    ...(dto.finalRecommendation    !== undefined ? { finalRecommendation:    dto.finalRecommendation } : {}),
    // Watchlist
    ...(dto.isOnWatchlist      !== undefined ? { isOnWatchlist:      dto.isOnWatchlist }         : {}),
    ...(dto.watchlistCategory  !== undefined ? { watchlistCategory:  dto.watchlistCategory }     : {}),
    ...(dto.watchlistPriority  !== undefined ? { watchlistPriority:  dto.watchlistPriority }     : {}),
    ...(dto.followUpDate       !== undefined ? { followUpDate:       dto.followUpDate ? new Date(dto.followUpDate) : null } : {}),
    // Computed fields
    ...(computed.currentRating       !== undefined ? { currentRating:       computed.currentRating }       : {}),
    ...(computed.potentialRating     !== undefined ? { potentialRating:     computed.potentialRating }     : {}),
    ...(computed.recommendationScore !== undefined ? { recommendationScore: computed.recommendationScore } : {}),
    ...(computed.recommendation      !== undefined ? { recommendation:      computed.recommendation }      : {}),
    ...(computed.fitGK               !== undefined ? { fitGK:               computed.fitGK ?? undefined }  : {}),
    ...(computed.fitCB               !== undefined ? { fitCB:               computed.fitCB ?? undefined }  : {}),
    ...(computed.fitFB               !== undefined ? { fitFB:               computed.fitFB ?? undefined }  : {}),
    ...(computed.fitDM               !== undefined ? { fitDM:               computed.fitDM ?? undefined }  : {}),
    ...(computed.fitCM               !== undefined ? { fitCM:               computed.fitCM ?? undefined }  : {}),
    ...(computed.fitAM               !== undefined ? { fitAM:               computed.fitAM ?? undefined }  : {}),
    ...(computed.fitWinger           !== undefined ? { fitWinger:           computed.fitWinger ?? undefined } : {}),
    ...(computed.fitStriker          !== undefined ? { fitStriker:          computed.fitStriker ?? undefined } : {}),
    ...(computed.injuryRisk          !== undefined ? { injuryRisk:          computed.injuryRisk }          : {}),
    ...(computed.adaptationRisk      !== undefined ? { adaptationRisk:      computed.adaptationRisk }      : {}),
    ...(computed.disciplineRisk      !== undefined ? { disciplineRisk:      computed.disciplineRisk }      : {}),
    ...(computed.financialRisk       !== undefined ? { financialRisk:       computed.financialRisk }       : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function createProspect(
  actor: ScoutActor,
  dto: CreateProspectDto,
): Promise<ScoutProspect> {
  if (!dto.playerName?.trim()) throw new BadRequestError('playerName is required');
  if (!dto.position?.trim())   throw new BadRequestError('position is required');
  _validateAttributes(dto as Partial<Record<AttrField, number>>);

  const computed = _buildComputedFields(dto);

  return prisma.scoutProspect.create({
    data: {
      clubId:    actor.clubId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
      playerName:         dto.playerName.trim(),
      position:           dto.position.trim(),
      secondaryPositions: dto.secondaryPositions ?? [],
      status:             dto.status ?? 'IDENTIFIED',
      ..._dtoToPrisma(dto, computed),
    },
  });
}

export async function updateProspect(
  actor: ScoutActor,
  prospectId: string,
  dto: UpdateProspectDto,
): Promise<ScoutProspect> {
  const prospect = await _assertOwner(actor, prospectId);
  _validateAttributes(dto as Partial<Record<AttrField, number>>);

  // Merge with existing attrs to recompute scores
  const merged: Partial<Record<AttrField, number>> = {};
  for (const k of ATTR_FIELDS) {
    const val = (dto as Record<string, unknown>)[k] ?? (prospect as Record<string, unknown>)[k];
    if (typeof val === 'number') merged[k] = val;
  }
  const age       = dto.age       ?? prospect.age       ?? undefined;
  const marketVal = dto.marketValueEur ?? prospect.marketValueEur ?? undefined;
  const computed  = _buildComputedFields({ ...merged, age, marketValueEur: marketVal });

  return prisma.scoutProspect.update({
    where: { id: prospectId },
    data: {
      updatedBy: actor.userId,
      ..._dtoToPrisma(dto, computed),
    },
  });
}

export async function getProspect(
  actor: ScoutActor,
  prospectId: string,
): Promise<ScoutProspect> {
  return _assertOwner(actor, prospectId);
}

export async function listProspects(
  actor: ScoutActor,
  opts: {
    status?:         string;
    position?:       string;
    recommendation?: string;
    isOnWatchlist?:  boolean;
    watchlistCategory?: string;
    search?:         string;   // playerName contains
    limit?:          number;
    offset?:         number;
    sortBy?:         string;
    sortDir?:        'asc' | 'desc';
  } = {},
): Promise<{ items: ScoutProspect[]; total: number }> {
  const { limit = 20, offset = 0 } = opts;

  const where: Prisma.ScoutProspectWhereInput = {
    clubId: actor.clubId,
    ...(opts.status         ? { status: opts.status }             : {}),
    ...(opts.position       ? { position: opts.position }         : {}),
    ...(opts.recommendation ? { recommendation: opts.recommendation } : {}),
    ...(opts.isOnWatchlist  !== undefined ? { isOnWatchlist: opts.isOnWatchlist } : {}),
    ...(opts.watchlistCategory ? { watchlistCategory: opts.watchlistCategory } : {}),
    ...(opts.search         ? { playerName: { contains: opts.search, mode: 'insensitive' } } : {}),
  };

  const orderByField = opts.sortBy ?? 'createdAt';
  const orderByDir   = opts.sortDir ?? 'desc';
  const validSortFields = ['createdAt', 'playerName', 'currentRating', 'potentialRating', 'recommendationScore', 'age', 'marketValueEur'];
  const orderBy = validSortFields.includes(orderByField)
    ? { [orderByField]: orderByDir }
    : { createdAt: 'desc' as const };

  const [items, total] = await Promise.all([
    prisma.scoutProspect.findMany({
      where,
      orderBy,
      take: Math.min(limit, 200),
      skip: offset,
    }),
    prisma.scoutProspect.count({ where }),
  ]);

  return { items, total };
}

export async function deleteProspect(
  actor: ScoutActor,
  prospectId: string,
): Promise<void> {
  await _assertOwner(actor, prospectId);
  await prisma.scoutProspect.delete({ where: { id: prospectId } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline management
// ─────────────────────────────────────────────────────────────────────────────

export async function advancePipelineStatus(
  actor: ScoutActor,
  prospectId: string,
  newStatus: string,
): Promise<ScoutProspect> {
  const prospect = await _assertOwner(actor, prospectId);

  if (!PIPELINE_STAGES.includes(newStatus as PipelineStage)) {
    throw new BadRequestError(`Unknown pipeline status: ${newStatus}. Valid: ${PIPELINE_STAGES.join(', ')}`);
  }

  const currentOrder = STAGE_ORDER[prospect.status] ?? 0;
  const nextOrder    = STAGE_ORDER[newStatus];

  // Allow moving to REJECTED from any stage; otherwise forward-only except reset to IDENTIFIED
  if (nextOrder < currentOrder && newStatus !== 'REJECTED' && newStatus !== 'IDENTIFIED') {
    throw new BadRequestError(`Cannot move backwards from ${prospect.status} to ${newStatus} (except REJECTED/IDENTIFIED reset)`);
  }

  return prisma.scoutProspect.update({
    where: { id: prospectId },
    data:  { status: newStatus, updatedBy: actor.userId },
  });
}

export async function getPipelineBoard(
  actor: ScoutActor,
): Promise<Record<string, ScoutProspect[]>> {
  const prospects = await prisma.scoutProspect.findMany({
    where:   { clubId: actor.clubId, status: { notIn: ['REJECTED'] } },
    orderBy: [{ recommendationScore: 'desc' }, { createdAt: 'desc' }],
  });

  const board: Record<string, ScoutProspect[]> = {};
  for (const stage of PIPELINE_STAGES.filter((s) => s !== 'REJECTED')) {
    board[stage] = [];
  }
  board['REJECTED'] = [];

  for (const p of prospects) {
    if (board[p.status]) board[p.status].push(p);
  }

  return board;
}

// ─────────────────────────────────────────────────────────────────────────────
// Watchlist
// ─────────────────────────────────────────────────────────────────────────────

export interface WatchlistUpdateDto {
  isOnWatchlist:      boolean;
  watchlistCategory?: string;   // TRANSFER_TARGET | FUTURE_PROSPECT | TRIAL_CANDIDATE | ACADEMY_PROSPECT
  watchlistPriority?: number;   // 0–100
  followUpDate?:      string;   // ISO date
}

export async function updateWatchlist(
  actor: ScoutActor,
  prospectId: string,
  dto: WatchlistUpdateDto,
): Promise<ScoutProspect> {
  await _assertOwner(actor, prospectId);

  if (dto.watchlistPriority !== undefined && (dto.watchlistPriority < 0 || dto.watchlistPriority > 100)) {
    throw new BadRequestError('watchlistPriority must be 0–100');
  }

  const validCategories = ['TRANSFER_TARGET', 'FUTURE_PROSPECT', 'TRIAL_CANDIDATE', 'ACADEMY_PROSPECT'];
  if (dto.watchlistCategory && !validCategories.includes(dto.watchlistCategory)) {
    throw new BadRequestError(`watchlistCategory must be one of: ${validCategories.join(', ')}`);
  }

  return prisma.scoutProspect.update({
    where: { id: prospectId },
    data:  {
      isOnWatchlist:     dto.isOnWatchlist,
      watchlistCategory: dto.watchlistCategory   ?? null,
      watchlistPriority: dto.watchlistPriority   ?? 50,
      followUpDate:      dto.followUpDate ? new Date(dto.followUpDate) : null,
      updatedBy:         actor.userId,
    },
  });
}

export async function getWatchlist(
  actor: ScoutActor,
  category?: string,
): Promise<ScoutProspect[]> {
  return prisma.scoutProspect.findMany({
    where: {
      clubId:       actor.clubId,
      isOnWatchlist: true,
      ...(category ? { watchlistCategory: category } : {}),
    },
    orderBy: [{ watchlistPriority: 'desc' }, { recommendationScore: 'desc' }],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison engine
// ─────────────────────────────────────────────────────────────────────────────

export interface ComparisonResult {
  prospectA: ScoutProspect;
  prospectB: ScoutProspect;
  technicalComparison: Record<string, { a: number | null; b: number | null; winner: 'A' | 'B' | 'TIE' }>;
  physicalComparison:  Record<string, { a: number | null; b: number | null; winner: 'A' | 'B' | 'TIE' }>;
  mentalComparison:    Record<string, { a: number | null; b: number | null; winner: 'A' | 'B' | 'TIE' }>;
  overallComparison: {
    currentRating:      { a: number | null; b: number | null; winner: 'A' | 'B' | 'TIE' };
    potentialRating:    { a: number | null; b: number | null; winner: 'A' | 'B' | 'TIE' };
    recommendationScore:{ a: number | null; b: number | null; winner: 'A' | 'B' | 'TIE' };
    marketValueEur:     { a: number | null; b: number | null; winner: 'A' | 'B' | 'TIE' };
  };
  positionFitComparison: Record<string, { a: number | null; b: number | null; winner: 'A' | 'B' | 'TIE' }>;
  riskComparison: {
    injuryRisk:      { a: string | null; b: string | null };
    adaptationRisk:  { a: string | null; b: string | null };
    disciplineRisk:  { a: string | null; b: string | null };
    financialRisk:   { a: string | null; b: string | null };
  };
  verdict: 'A' | 'B' | 'TIE';
}

function _compareNum(a: number | null | undefined, b: number | null | undefined): 'A' | 'B' | 'TIE' {
  const av = a ?? 0;
  const bv = b ?? 0;
  if (av > bv) return 'A';
  if (bv > av) return 'B';
  return 'TIE';
}

export async function compareProspects(
  actor: ScoutActor,
  prospectAId: string,
  prospectBId: string,
): Promise<ComparisonResult> {
  const [pA, pB] = await Promise.all([
    _assertOwner(actor, prospectAId),
    _assertOwner(actor, prospectBId),
  ]);

  const techFields   = ['pace','acceleration','agility','dribbling','ballControl','passing','vision','crossing','finishing','shooting','heading','tackling','positioning','composure','decisionMaking'] as const;
  const physFields   = ['strength','stamina','endurance','balance','mobility','explosiveness'] as const;
  const mentalFields = ['leadership','discipline','concentration','workRate','determination','professionalism','coachability'] as const;
  const fitFields    = ['fitGK','fitCB','fitFB','fitDM','fitCM','fitAM','fitWinger','fitStriker'] as const;

  const makeSection = (fields: readonly string[]) => {
    const out: Record<string, { a: number | null; b: number | null; winner: 'A' | 'B' | 'TIE' }> = {};
    for (const f of fields) {
      const av = (pA as Record<string, unknown>)[f] as number | null;
      const bv = (pB as Record<string, unknown>)[f] as number | null;
      out[f] = { a: av ?? null, b: bv ?? null, winner: _compareNum(av, bv) };
    }
    return out;
  };

  const technicalComparison  = makeSection(techFields);
  const physicalComparison   = makeSection(physFields);
  const mentalComparison     = makeSection(mentalFields);
  const positionFitComparison = makeSection(fitFields);

  const overallComparison = {
    currentRating:       { a: pA.currentRating ?? null,       b: pB.currentRating ?? null,       winner: _compareNum(pA.currentRating, pB.currentRating) },
    potentialRating:     { a: pA.potentialRating ?? null,     b: pB.potentialRating ?? null,     winner: _compareNum(pA.potentialRating, pB.potentialRating) },
    recommendationScore: { a: pA.recommendationScore ?? null, b: pB.recommendationScore ?? null, winner: _compareNum(pA.recommendationScore, pB.recommendationScore) },
    marketValueEur:      { a: pA.marketValueEur ?? null,      b: pB.marketValueEur ?? null,      winner: _compareNum(pA.marketValueEur, pB.marketValueEur) },
  };

  const riskComparison = {
    injuryRisk:     { a: pA.injuryRisk,     b: pB.injuryRisk },
    adaptationRisk: { a: pA.adaptationRisk, b: pB.adaptationRisk },
    disciplineRisk: { a: pA.disciplineRisk, b: pB.disciplineRisk },
    financialRisk:  { a: pA.financialRisk,  b: pB.financialRisk },
  };

  // Verdict: who wins more tech+physical+mental comparisons
  let aWins = 0; let bWins = 0;
  for (const s of [technicalComparison, physicalComparison, mentalComparison]) {
    for (const v of Object.values(s)) {
      if (v.winner === 'A') aWins++;
      else if (v.winner === 'B') bWins++;
    }
  }
  const verdict: 'A' | 'B' | 'TIE' = aWins > bWins ? 'A' : bWins > aWins ? 'B' : 'TIE';

  return {
    prospectA: pA,
    prospectB: pB,
    technicalComparison,
    physicalComparison,
    mentalComparison,
    overallComparison,
    positionFitComparison,
    riskComparison,
    verdict,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────

export async function getScoutDashboard(actor: ScoutActor) {
  const [
    allProspects,
    positionDist,
    nationalityDist,
    potentialDist,
    pipeline,
  ] = await Promise.all([
    prisma.scoutProspect.findMany({
      where: { clubId: actor.clubId },
      select: {
        id: true, status: true, recommendation: true,
        position: true, nationality: true,
        currentRating: true, potentialRating: true,
        recommendationScore: true, isOnWatchlist: true,
      },
    }),

    prisma.scoutProspect.groupBy({
      by: ['position'],
      where: { clubId: actor.clubId },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    }),

    prisma.scoutProspect.groupBy({
      by: ['nationality'],
      where: { clubId: actor.clubId, nationality: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),

    prisma.scoutProspect.groupBy({
      by: ['recommendation'],
      where: { clubId: actor.clubId, recommendation: { not: null } },
      _count: { id: true },
    }),

    getPipelineBoard(actor),
  ]);

  const total           = allProspects.length;
  const priorityTargets = allProspects.filter((p) => p.recommendation === 'PRIORITY_TARGET' || p.recommendation === 'STRONG_TARGET').length;
  const signed          = allProspects.filter((p) => p.status === 'SIGNED').length;
  const highPotential   = allProspects.filter((p) => (p.potentialRating ?? 0) >= 80).length;
  const watchlistCount  = allProspects.filter((p) => p.isOnWatchlist).length;

  return {
    kpis: {
      total,
      priorityTargets,
      signed,
      highPotential,
      watchlistCount,
      pipelineActive: total - signed - allProspects.filter((p) => p.status === 'REJECTED').length,
    },
    positionDistribution: positionDist.map((p) => ({ position: p.position, count: p._count.id })),
    nationalityDistribution: nationalityDist.map((n) => ({ nationality: n.nationality, count: n._count.id })),
    potentialDistribution: potentialDist.map((r) => ({ recommendation: r.recommendation, count: r._count.id })),
    pipeline: Object.fromEntries(
      Object.entries(pipeline).map(([stage, prospects]) => [stage, prospects.length])
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _assertOwner(actor: ScoutActor, prospectId: string): Promise<ScoutProspect> {
  const p = await prisma.scoutProspect.findUnique({ where: { id: prospectId } });
  if (!p) throw new NotFoundError('ScoutProspect');
  if (p.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return p;
}

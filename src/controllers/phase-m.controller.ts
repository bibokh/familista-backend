// Familista — Phase M bundled controller (Autonomous Sports Ecosystem).

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as twins   from '../twins/twin.service';
import * as exec    from '../executive/executive.service';
import * as council from '../executive/decision-council.service';
import * as recruit from '../recruitment/recruitment.service';
import * as plans   from '../training-engine/training-plan.service';
import * as econ    from '../economics/economics.service';
import * as sgraph  from '../scouting-graph/scouting-graph.service';
import * as market  from '../marketplace/marketplace.service';
import * as know    from '../knowledge/knowledge.service';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const ROLES        = ['SPORTING_DIRECTOR','RECRUITMENT','MEDICAL_EXEC','FINANCE_EXEC','MARKETING','ACADEMY_HEAD','PERFORMANCE'] as const;
const VOTE_TYPES   = ['APPROVE','REJECT','ABSTAIN'] as const;
const REC_STATUS   = ['LEAD','SCOUTED','EVALUATED','TARGETED','OFFERED','SIGNED','REJECTED','LOST'] as const;
const PLAN_STATUS  = ['DRAFT','ACTIVE','COMPLETED','CANCELED'] as const;
const MARKET_KINDS = ['TRANSFER_LISTING','DEVICE_LISTING','SERVICE_LISTING','ACADEMY_PROGRAM','GENERIC'] as const;
const MARKET_STAT  = ['DRAFT','ACTIVE','PAUSED','CLOSED'] as const;
const KNOW_KIND    = ['TACTICAL','MEDICAL','ECONOMIC','SCOUTING','GENERAL'] as const;
const SPORTS       = ['FOOTBALL','BASKETBALL','TENNIS','HANDBALL','ATHLETICS','CUSTOM'] as const;
const IMPACTS      = ['LOW','MEDIUM','HIGH'] as const;

function actor<A>(req: Request): A {
  if (!req.user) throw new BadRequestError('auth');
  return { userId: req.user.id, clubId: req.user.clubId, role: req.user.role } as unknown as A;
}
function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '));
}
function bigintSafe<T>(row: T): T {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) return row.map(bigintSafe) as unknown as T;
  if (typeof row === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      out[k] = typeof v === 'bigint' ? v.toString() : (v && typeof v === 'object' ? bigintSafe(v) : v);
    }
    return out as unknown as T;
  }
  return row;
}

// ── Twins ───────────────────────────────────────────────────────────────

const orgTwinSchema = z.object({ body: z.object({ snapshot: z.any() }).refine((v) => v.snapshot !== undefined, { message: 'snapshot required' }) });

export async function captureOrgTwin(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = orgTwinSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await twins.captureOrgTwin(actor(req), parsed.data.body.snapshot as never)));
  } catch (err) { return next(err); }
}

export async function listTwins(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, bigintSafe(await twins.listTwins(actor(req)))); }
  catch (err) { return next(err); }
}

const clubTwinSchema = z.object({ body: z.object({ sportingState: z.any().optional(), financialState: z.any().optional(), staffingState: z.any().optional(), hardwareState: z.any().optional(), playerState: z.any().optional(), trainingState: z.any().optional() }) });

export async function captureClubTwin(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = clubTwinSchema.safeParse({ body: req.body ?? {} }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await twins.captureClubTwin(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

const acadTwinSchema = z.object({ body: z.object({ academyName: z.string().trim().min(1).max(200), ageGroups: z.any().optional(), playerCount: z.number().int().min(0).optional(), staffCount: z.number().int().min(0).optional(), performanceScore: z.number().min(0).max(1).optional(), financialFlow: z.any().optional() }) });

export async function captureAcademyTwin(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = acadTwinSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await twins.captureAcademyTwin(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

const deptTwinSchema = z.object({ body: z.object({ department: z.string().trim().min(1).max(40), headStaffId: z.string().uuid().optional(), payload: z.any() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function captureDepartmentTwin(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = deptTwinSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await twins.captureDepartmentTwin(actor(req), { ...parsed.data.body, payload: parsed.data.body.payload as never })));
  } catch (err) { return next(err); }
}

const staffTwinSchema = z.object({ body: z.object({ staffUserId: z.string().uuid().optional(), staffKind: z.string().trim().min(1).max(40), payload: z.any() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function captureStaffTwin(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = staffTwinSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await twins.captureStaffTwin(actor(req), { ...parsed.data.body, payload: parsed.data.body.payload as never })));
  } catch (err) { return next(err); }
}

// ── Executive ──────────────────────────────────────────────────────────

const regExecSchema = z.object({ body: z.object({ role: z.enum(ROLES), label: z.string().trim().min(1).max(200), config: z.any().optional() }) });

export async function registerExecutive(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = regExecSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await exec.registerExecutive(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listExecutives(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await exec.listExecutives(actor(req))).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const decisionSchema = z.object({ body: z.object({ agentId: z.string().uuid().nullable().optional(), kind: z.string().trim().min(1).max(80), rationale: z.string().trim().min(1).max(10_000), payload: z.any(), confidence: z.number().min(0).max(1).optional(), tacticalImpact: z.enum(IMPACTS).optional() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function issueDecision(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = decisionSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await exec.issueDecision(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

export async function listDecisions(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await exec.listDecisions(actor(req), { kind: typeof req.query.kind === 'string' ? req.query.kind : undefined });
    return sendPaginated(res, out.items.map(bigintSafe), out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

// ── Council ────────────────────────────────────────────────────────────

const createCouncilSchema = z.object({ body: z.object({ topic: z.string().trim().min(1).max(200), agentIds: z.array(z.string()).min(1).max(50), payload: z.any() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function createCouncil(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createCouncilSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await council.createCouncil(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

const voteSchema = z.object({ body: z.object({ voterId: z.string().trim().min(1).max(120), voterKind: z.enum(['HUMAN','AGENT']), vote: z.enum(VOTE_TYPES), confidence: z.number().min(0).max(1).optional(), rationale: z.string().trim().max(2000).optional() }) });

export async function submitVote(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = voteSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await council.submitVote(actor(req), req.params.councilId, parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function closeCouncil(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, bigintSafe(await council.closeCouncil(actor(req), req.params.councilId))); }
  catch (err) { return next(err); }
}

export async function getCouncil(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, bigintSafe(await council.getCouncil(actor(req), req.params.councilId))); }
  catch (err) { return next(err); }
}

// ── Recruitment ────────────────────────────────────────────────────────

const createTargetSchema = z.object({ body: z.object({
  playerName:    z.string().trim().min(1).max(200),
  externalRef:   z.string().trim().max(200).optional(),
  playerId:      z.string().uuid().optional(),
  position:      z.string().trim().max(40).optional(),
  age:           z.number().int().min(8).max(60).optional(),
  currentClub:   z.string().trim().max(200).optional(),
  marketValue:   z.number().min(0).optional(),
  contractUntil: z.string().datetime().optional(),
  status:        z.enum(REC_STATUS).optional(),
  priority:      z.number().int().min(0).max(100).optional(),
  notes:         z.string().trim().max(4000).optional(),
}) });

export async function createTarget(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createTargetSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await recruit.createTarget(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listTargets(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await recruit.listTargets(actor(req), {
      status:   typeof req.query.status   === 'string' ? req.query.status as never : undefined,
      position: typeof req.query.position === 'string' ? req.query.position : undefined,
    });
    return sendPaginated(res, out.items.map(bigintSafe), out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

const scoutReportSchema = z.object({ body: z.object({ playerTargetId: z.string().uuid().optional(), playerId: z.string().uuid().optional(), reportKind: z.string().trim().min(1).max(40), payload: z.any(), score: z.number().min(0).max(100).optional(), notes: z.string().trim().max(4000).optional() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function createScoutReport(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = scoutReportSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await recruit.createScoutReport(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

const recScoreSchema = z.object({ body: z.object({
  playerTargetId: z.string().uuid().optional(),
  playerId:       z.string().uuid().optional(),
  input: z.object({
    scoutMean:       z.number().min(0).max(100),
    matchReadiness:  z.number().min(0).max(1),
    positionFit:     z.number().min(0).max(1),
    ageFit:          z.number().min(0).max(1),
    valueFit:        z.number().min(0).max(1),
  }),
}) });

export async function recordRecruitmentScore(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = recScoreSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await recruit.persistRecruitmentScore(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

const transferProbSchema = z.object({ body: z.object({
  playerTargetId: z.string().uuid().optional(),
  playerId:       z.string().uuid().optional(),
  horizonDays:    z.number().int().min(1).max(3650).optional(),
  input: z.object({
    contractRemainingMonths: z.number().min(0).max(120),
    satisfaction:            z.number().min(0).max(1),
    marketDemand:            z.number().min(0).max(1),
    wageGap:                 z.number().min(0).max(1),
  }),
}) });

export async function recordTransferProbability(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = transferProbSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await recruit.persistTransferProbability(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

const projectionSchema = z.object({ body: z.object({
  playerTargetId: z.string().uuid().optional(),
  playerId:       z.string().uuid().optional(),
  horizonYears:   z.number().int().min(1).max(15).optional(),
  input: z.object({
    currentOVR:        z.number().int().min(1).max(99),
    age:               z.number().int().min(8).max(60),
    growthAttribute:   z.number().min(0).max(100),
    injuryHistoryRisk: z.number().min(0).max(1),
  }),
}) });

export async function recordTalentProjection(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = projectionSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await recruit.persistTalentProjection(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

// ── Training ───────────────────────────────────────────────────────────

const optPlanSchema = z.object({ body: z.object({ teamId: z.string().uuid().optional(), weekStart: z.string().datetime(), payload: z.any() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function createOptPlan(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = optPlanSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await plans.createOptimizationPlan(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

const recoveryPlanSchema = z.object({ body: z.object({ playerId: z.string().uuid(), fromDate: z.string().datetime(), toDate: z.string().datetime(), payload: z.any() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function createRecovery(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = recoveryPlanSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await plans.createRecoveryPlan(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

const microSchema = z.object({ body: z.object({ teamId: z.string().uuid().optional(), weekStart: z.string().datetime(), dailyPayload: z.any() }).refine((v) => v.dailyPayload !== undefined, { message: 'dailyPayload required', path: ['dailyPayload'] }) });

export async function createMicrocycle(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = microSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await plans.createMicrocyclePlan(actor(req), { ...body, dailyPayload: body.dailyPayload as never })));
  } catch (err) { return next(err); }
}

const seasonSchema = z.object({ body: z.object({ season: z.string().trim().min(3).max(40), payload: z.any() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function upsertSeasonPlan(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = seasonSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await plans.upsertSeasonPlan(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

export async function listTrainingPlans(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, bigintSafe(await plans.listPlans(actor(req)))); }
  catch (err) { return next(err); }
}

// ── Economics ──────────────────────────────────────────────────────────

const assetSchema = z.object({ body: z.object({ playerId: z.string().uuid(), input: z.object({ age: z.number().int().min(8).max(60), ovr: z.number().int().min(1).max(99), contractMonths: z.number().int().min(0).max(120), marketDemand: z.number().min(0).max(1), injuryRisk: z.number().min(0).max(1) }) }) });

export async function recordAssetValue(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = assetSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await econ.persistAssetValue(actor(req), parsed.data.body.playerId, parsed.data.body.input)));
  } catch (err) { return next(err); }
}

const contractRiskSchema = z.object({ body: z.object({ playerId: z.string().uuid(), expiryDate: z.string().datetime().optional(), input: z.object({ monthsRemaining: z.number().min(0).max(120), satisfaction: z.number().min(0).max(1), alternativeOffers: z.number().int().min(0).max(50), ageBucket: z.enum(['YOUTH','PRIME','VETERAN']) }) }) });

export async function recordContractRisk(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractRiskSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await econ.persistContractRisk(actor(req), parsed.data.body.playerId, parsed.data.body.input, parsed.data.body.expiryDate)));
  } catch (err) { return next(err); }
}

// ── Scouting graph ─────────────────────────────────────────────────────

const talentGraphSchema = z.object({ body: z.object({ snapshot: z.any(), monotonicMs: z.number().int().min(0).optional() }).refine((v) => v.snapshot !== undefined, { message: 'snapshot required', path: ['snapshot'] }) });

export async function recordTalentGraph(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = talentGraphSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await sgraph.recordTalentGraph(actor(req), parsed.data.body.snapshot as never, parsed.data.body.monotonicMs)));
  } catch (err) { return next(err); }
}

const scoutSchema = z.object({ body: z.object({ scoutUserId: z.string().uuid(), regionCode: z.string().trim().max(20).optional(), languages: z.any().optional(), specialities: z.any().optional(), ratings: z.any().optional() }) });

export async function registerScout(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = scoutSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await sgraph.registerScout(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

export async function listScouts(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await sgraph.listScouts(actor(req))).map(bigintSafe)); }
  catch (err) { return next(err); }
}

// ── Marketplace ────────────────────────────────────────────────────────

const listingSchema = z.object({ body: z.object({ kind: z.enum(MARKET_KINDS), title: z.string().trim().min(1).max(200), description: z.string().trim().max(4000).optional(), payload: z.any(), validFrom: z.string().datetime().optional(), validUntil: z.string().datetime().optional() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function createListing(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listingSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await market.createListing(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

export async function activateListing(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, bigintSafe(await market.activateListing(actor(req), req.params.id))); }
  catch (err) { return next(err); }
}

export async function closeListing(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, bigintSafe(await market.closeListing(actor(req), req.params.id))); }
  catch (err) { return next(err); }
}

export async function listMarketplace(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await market.listMarketplace(actor(req), {
      kind:   typeof req.query.kind   === 'string' ? req.query.kind as never : undefined,
      status: typeof req.query.status === 'string' ? req.query.status as never : undefined,
    });
    return sendPaginated(res, out.items.map(bigintSafe), out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

// ── Knowledge ──────────────────────────────────────────────────────────

const docSchema = z.object({ body: z.object({ kind: z.enum(KNOW_KIND), title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(50_000), tags: z.any().optional(), global: z.boolean().optional() }) });

export async function createKnowledgeDoc(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = docSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await know.createDocument(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

export async function listKnowledgeDocs(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await know.listDocuments(actor(req), { kind: typeof req.query.kind === 'string' ? req.query.kind as never : undefined });
    return sendSuccess(res, out.map(bigintSafe));
  } catch (err) { return next(err); }
}

const patternSchema = z.object({ body: z.object({ sport: z.enum(SPORTS), pluginCode: z.string().trim().max(120).optional(), patternName: z.string().trim().min(1).max(200), payload: z.any(), tags: z.any().optional() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function publishTacticalPattern(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = patternSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await know.publishTacticalPattern(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

const medSchema = z.object({ body: z.object({ kind: z.string().trim().min(1).max(40), title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(50_000), tags: z.any().optional(), global: z.boolean().optional() }) });

export async function publishMedicalNode(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = medSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await know.publishMedicalNode(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

// ── One-call snapshot ──────────────────────────────────────────────────

export async function phaseMSnapshot(req: Request, res: Response, next: NextFunction) {
  try {
    const a = actor<{ userId: string; clubId: string; role?: string }>(req);
    const [twinsRow, execs, councils, plansRow] = await Promise.all([
      twins.listTwins(a),
      exec.listExecutives(a),
      council.listCouncils(a, { limit: 5 }),
      plans.listPlans(a),
    ]);
    return sendSuccess(res, bigintSafe({ twins: twinsRow, executives: execs, councils, plans: plansRow }));
  } catch (err) { return next(err); }
}

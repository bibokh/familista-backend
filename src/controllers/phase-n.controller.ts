// Familista — Phase N bundled controller (Global Knowledge + Universal Identity).

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as kg     from '../knowledge-graph/knowledge-graph.service';
import * as reason from '../knowledge-graph/reasoning.service';
import * as id     from '../identity/universal-identity.service';
import * as scout  from '../global-scouting/global-scouting.service';
import * as market from '../market-intelligence/market.service';
import * as sec    from '../security-n/signed-recommendations.service';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const NODE_KINDS  = ['PLAYER','CLUB','COACH','SCOUT','AGENT','TOURNAMENT','STADIUM','COMPETITION','COUNTRY','ACADEMY'] as const;
const EDGE_KINDS  = ['PLAYS_FOR','COACHES','REPRESENTS','HOSTS','IN_COMPETITION','BELONGS_TO','DEVELOPS','NATIVE_OF','SCOUTED_BY','SIGNED_WITH','CUSTOM'] as const;
const REASON_KIND = ['RECRUITMENT','TACTICAL','MEDICAL','ECONOMIC','DEVELOPMENT','CUSTOM'] as const;
const DISCOVERY   = ['PROSPECT','EVALUATING','CONFIRMED','RECOMMENDED','REJECTED','ARCHIVED'] as const;
const SPORTS      = ['FOOTBALL','BASKETBALL','TENNIS','HANDBALL','ATHLETICS','FUTSAL','VOLLEYBALL','CUSTOM'] as const;

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

// ── Knowledge graph ────────────────────────────────────────────────────

const nodeSchema = z.object({ body: z.object({ nodeKind: z.enum(NODE_KINDS), label: z.string().trim().min(1).max(200), payload: z.any(), externalRef: z.string().trim().max(200).optional(), global: z.boolean().optional() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function createNode(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = nodeSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await kg.createNode(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

export async function listNodes(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await kg.listNodes(actor(req), {
      nodeKind:    typeof req.query.nodeKind    === 'string' ? req.query.nodeKind as never : undefined,
      externalRef: typeof req.query.externalRef === 'string' ? req.query.externalRef : undefined,
      limit:       typeof req.query.limit       === 'string' ? parseInt(req.query.limit, 10) : undefined,
    });
    return sendSuccess(res, out.map(bigintSafe));
  } catch (err) { return next(err); }
}

const edgeSchema = z.object({ body: z.object({ fromNodeId: z.string().uuid(), toNodeId: z.string().uuid(), edgeKind: z.enum(EDGE_KINDS), weight: z.number().min(0).max(1).optional(), metadata: z.any().optional(), global: z.boolean().optional() }) });

export async function createEdge(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = edgeSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await kg.createEdge(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listEdges(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await kg.listEdges(actor(req), {
      fromNodeId: typeof req.query.fromNodeId === 'string' ? req.query.fromNodeId : undefined,
      toNodeId:   typeof req.query.toNodeId   === 'string' ? req.query.toNodeId : undefined,
      edgeKind:   typeof req.query.edgeKind   === 'string' ? req.query.edgeKind as never : undefined,
    });
    return sendSuccess(res, out.map(bigintSafe));
  } catch (err) { return next(err); }
}

export async function anchorGraph(req: Request, res: Response, next: NextFunction) {
  try {
    const asOf = typeof req.body?.asOf === 'string' ? req.body.asOf : undefined;
    return sendCreated(res, bigintSafe(await kg.anchorGraph(actor(req), asOf)));
  } catch (err) { return next(err); }
}

export async function listAnchors(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await kg.listAnchors(actor(req), typeof req.query.kind === 'string' ? req.query.kind : undefined)).map(bigintSafe)); }
  catch (err) { return next(err); }
}

export async function verifyAnchor(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await kg.verifyAnchor(actor(req), req.params.anchorId)); }
  catch (err) { return next(err); }
}

// ── Reasoning ──────────────────────────────────────────────────────────

const ruleSchema = z.object({ body: z.object({ code: z.string().trim().min(1).max(120), label: z.string().trim().min(1).max(200), kind: z.enum(REASON_KIND), rule: z.any(), global: z.boolean().optional() }).refine((v) => v.rule !== undefined, { message: 'rule required', path: ['rule'] }) });

export async function publishRule(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = ruleSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await reason.publishRule(actor(req), { ...body, rule: body.rule as never })));
  } catch (err) { return next(err); }
}

export async function listRules(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await reason.listRules(actor(req), typeof req.query.kind === 'string' ? req.query.kind as never : undefined)).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const reasonSchema = z.object({ body: z.object({ topic: z.string().trim().min(1).max(200), question: z.string().trim().min(1).max(2000), kind: z.enum(REASON_KIND), sources: z.array(z.string().trim().min(1).max(200)).max(50).optional(), inputs: z.record(z.any()) }) });

export async function runReason(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reasonSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await reason.reason(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listTraces(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await reason.listTraces(actor(req), typeof req.query.kind === 'string' ? req.query.kind as never : undefined)).map(bigintSafe)); }
  catch (err) { return next(err); }
}

// ── Universal identity ─────────────────────────────────────────────────

const regAthleteSchema = z.object({ body: z.object({ firstName: z.string().trim().min(1).max(120), lastName: z.string().trim().min(1).max(120), dateOfBirth: z.string().datetime(), sport: z.enum(SPORTS).optional(), playerId: z.string().uuid().optional(), confidence: z.number().min(0).max(1).optional() }) });

export async function registerAthlete(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = regAthleteSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await id.registerUniversalAthlete(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

const linkSchema = z.object({ body: z.object({ athleteIdHash: z.string().trim().length(64), playerId: z.string().uuid(), confidence: z.number().min(0).max(1).optional() }) });

export async function linkPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = linkSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await id.linkPlayer(actor(req), parsed.data.body.athleteIdHash, parsed.data.body.playerId, parsed.data.body.confidence)));
  } catch (err) { return next(err); }
}

const perfSchema = z.object({ body: z.object({ athleteId: z.string().uuid(), season: z.string().trim().min(3).max(40), payload: z.any() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function recordPerformance(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = perfSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await id.recordPerformance(actor(req), body.athleteId, body.season, body.payload as never)));
  } catch (err) { return next(err); }
}

const medSchema = z.object({ body: z.object({ athleteId: z.string().uuid(), recordKind: z.string().trim().min(1).max(40), plainPayload: z.any(), anonymisedPayload: z.any() }).refine((v) => v.plainPayload !== undefined && v.anonymisedPayload !== undefined, { message: 'plainPayload + anonymisedPayload required' }) });

export async function recordMedical(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = medSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await id.recordMedical(actor(req), body.athleteId, body.recordKind, body.plainPayload as never, body.anonymisedPayload as never)));
  } catch (err) { return next(err); }
}

const transferSchema = z.object({ body: z.object({ athleteId: z.string().uuid(), fromClubRef: z.string().trim().max(120).optional(), toClubRef: z.string().trim().max(120).optional(), feeCents: z.number().int().min(0).optional(), currency: z.string().trim().max(8).optional(), occurredAt: z.string().datetime(), payload: z.any().optional() }) });

export async function recordTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = transferSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await id.recordTransfer(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

// ── Global scouting ────────────────────────────────────────────────────

const nodeRegSchema = z.object({ body: z.object({ label: z.string().trim().min(1).max(200), regionCode: z.string().trim().max(20).optional(), countryCodes: z.any().optional(), specialities: z.any().optional(), global: z.boolean().optional() }) });

export async function registerScoutingNode(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = nodeRegSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await scout.registerNode(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

export async function listScoutingNodes(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await scout.listNodes(actor(req), { regionCode: typeof req.query.regionCode === 'string' ? req.query.regionCode : undefined })).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const discoverySchema = z.object({ body: z.object({ scoutingNodeId: z.string().uuid().optional(), athleteIdHash: z.string().trim().length(64).optional(), externalRef: z.string().trim().max(200).optional(), prospectName: z.string().trim().min(1).max(200), position: z.string().trim().max(40).optional(), age: z.number().int().min(8).max(60).optional(), region: z.string().trim().max(40).optional(), status: z.enum(DISCOVERY).optional(), payload: z.any() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function recordDiscovery(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = discoverySchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await scout.recordDiscovery(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

export async function listDiscoveries(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await scout.listDiscoveries(actor(req), { status: typeof req.query.status === 'string' ? req.query.status as never : undefined })).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const rankingSchema = z.object({ body: z.object({ discoveryId: z.string().uuid().optional(), athleteIdHash: z.string().trim().length(64).optional(), position: z.string().trim().max(40).optional(), input: z.object({ scoutScore: z.number().min(0).max(100), marketScarcity: z.number().min(0).max(1), positionalNeed: z.number().min(0).max(1), financialFit: z.number().min(0).max(1), developmentFit: z.number().min(0).max(1) }) }) });

export async function recordRanking(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = rankingSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await scout.recordRanking(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listRankings(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await scout.listRankings(actor(req), { position: typeof req.query.position === 'string' ? req.query.position : undefined })).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const evalSchema = z.object({ body: z.object({ discoveryId: z.string().uuid().optional(), athleteIdHash: z.string().trim().length(64).optional(), payload: z.any(), score: z.number().min(0).max(1).optional() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function recordEvaluation(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = evalSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await scout.recordEvaluation(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

// ── Market intelligence ────────────────────────────────────────────────

const transferPredSchema = z.object({ body: z.object({ athleteIdHash: z.string().trim().length(64).optional(), fromClubRef: z.string().trim().max(120).optional(), toClubRef: z.string().trim().max(120).optional(), horizonDays: z.number().int().min(1).max(3650).optional(), input: z.object({ positionScarcity: z.number().min(0).max(1), ageBracket: z.enum(['YOUTH','PRIME','VETERAN']), contractMonthsLeft: z.number().min(0).max(120), performanceTrend: z.number().min(-1).max(1), agentNetworkSignal: z.number().min(0).max(1) }) }) });

export async function recordMarketTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = transferPredSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await market.persistMarketTransferPrediction(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

const contractIntelSchema = z.object({ body: z.object({ athleteIdHash: z.string().trim().length(64).optional(), input: z.object({ monthsLeft: z.number().min(0).max(120), renewalSatisfaction: z.number().min(0).max(1), externalOffers: z.number().int().min(0).max(50), bosmanRisk: z.number().min(0).max(1) }), payload: z.any().optional() }) });

export async function recordContractIntel(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractIntelSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await market.recordContractIntelligence(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

const academyForecastSchema = z.object({ body: z.object({ academyName: z.string().trim().min(1).max(200), horizonYears: z.number().int().min(1).max(20).optional(), input: z.object({ squadSize: z.number().int().min(1).max(2000), avgTalentProjection: z.number().min(1).max(99), historicalROI: z.number().min(-1).max(10), pipelineStrength: z.number().min(0).max(1) }) }) });

export async function recordAcademyForecast(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = academyForecastSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await market.recordAcademyForecast(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

// ── Trust score ────────────────────────────────────────────────────────

const trustSchema = z.object({ body: z.object({ sourceKind: z.string().trim().min(1).max(40), sourceRef: z.string().trim().min(1).max(200), delta: z.number().min(0).max(1), components: z.any().optional() }) });

export async function updateTrust(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = trustSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await sec.updateTrust(actor(req), body.sourceKind, body.sourceRef, body.delta, (body.components ?? null) as never)));
  } catch (err) { return next(err); }
}

export async function listTrust(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await sec.listTrust(actor(req), { sourceKind: typeof req.query.sourceKind === 'string' ? req.query.sourceKind : undefined })).map(bigintSafe)); }
  catch (err) { return next(err); }
}

// ── Snapshot ───────────────────────────────────────────────────────────

import { prisma } from '../config/database';

export async function phaseNSnapshot(req: Request, res: Response, next: NextFunction) {
  try {
    const a = actor<{ userId: string; clubId: string; role?: string }>(req);
    const [nodes, edges, rankings, traces, anchors] = await Promise.all([
      prisma.globalKnowledgeNode.count({ where: { OR: [{ clubId: a.clubId }, { clubId: null }] } }),
      prisma.globalKnowledgeEdge.count({ where: { OR: [{ clubId: a.clubId }, { clubId: null }] } }),
      prisma.globalRecommendationRanking.count({ where: { clubId: a.clubId } }),
      prisma.reasoningTrace.count({ where: { clubId: a.clubId } }),
      prisma.cryptographicGraphAnchor.count({ where: { clubId: a.clubId } }),
    ]);
    return sendSuccess(res, { ts: new Date().toISOString(), kg: { nodes, edges }, scouting: { rankings }, reasoning: { traces }, security: { anchors } });
  } catch (err) { return next(err); }
}

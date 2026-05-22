// Familista — Phase L bundled controller.
// Composes the new services into a single REST surface mounted at
// /api/v1/phase-l/*.

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as hw     from '../hardware/hardware.service';
import * as attest from '../security-l/attestation.service';
import * as fed    from '../federated/federated.service';
import * as coach  from '../coaching/coach-agent.service';
import * as sim    from '../simulation/twin-simulation.service';
import * as graph  from '../cognitive/game-graph.service';
import * as bio    from '../biochem/biomech-expansion.service';
import * as cat    from '../sports-catalog/sport-catalog.service';
import { quantumRegistry } from '../quantum/quantum-interfaces';
import * as obs    from '../observability-l/health-aggregator.service';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const COACH_KINDS = ['TACTICAL','INJURY_RISK','SUBSTITUTION','TACTICAL_ADAPTATION','MATCH_ADJUSTMENT','FORMATION_OPTIMIZATION','CUSTOM'] as const;
const AGENT_KINDS = ['CLUB_MANAGER','TACTICAL','MEDICAL','SCOUTING','FINANCE','TRAINING','MATCH_OPS','COMMS','DEVICE_MGMT','BIG_DATA'] as const;
const SPORTS      = ['FOOTBALL','BASKETBALL','TENNIS','HANDBALL','ATHLETICS','CUSTOM'] as const;

function actor<A>(req: Request): A {
  if (!req.user) throw new BadRequestError('auth');
  return { userId: req.user.id, clubId: req.user.clubId, role: req.user.role } as unknown as A;
}
function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '));
}
// BigInt-safe JSON shim — converts every BigInt in a row to its string form.
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

// ─────────────────────────────────────────────────────────────────────────
// Hardware
// ─────────────────────────────────────────────────────────────────────────

const hwSessSchema = z.object({ body: z.object({ serial: z.string().trim().min(1).max(120), batchId: z.string().uuid().optional(), deviceId: z.string().uuid().optional(), notes: z.string().trim().max(2000).optional() }) });

export async function createHwSession(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = hwSessSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await hw.createSession(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

const hwStepSchema = z.object({ body: z.object({ name: z.string().trim().min(1).max(60), ok: z.boolean(), payload: z.any().optional() }) });

export async function recordHwStep(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = hwStepSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendSuccess(res, bigintSafe(await hw.recordStep(actor(req), req.params.id, parsed.data.body as never)));
  } catch (err) { return next(err); }
}

export async function listHwSessions(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await hw.listSessions(actor(req), {
      status: typeof req.query.status === 'string' ? req.query.status as never : undefined,
      page:   typeof req.query.page === 'string' ? parseInt(req.query.page, 10)  : undefined,
      limit:  typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined,
    });
    return sendPaginated(res, out.items.map(bigintSafe), out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

const capSchema = z.object({ body: z.object({ model: z.string().trim().min(1).max(120), hwRevision: z.string().trim().max(40).optional(), capabilities: z.any() }).refine((v) => v.capabilities !== undefined, { message: 'capabilities required', path: ['capabilities'] }) });

export async function publishCapability(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = capSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await hw.publishCapability(actor(req), { ...parsed.data.body, capabilities: parsed.data.body.capabilities as never })));
  } catch (err) { return next(err); }
}

const trustSchema = z.object({ body: z.object({ deviceId: z.string().uuid(), certFingerprint: z.string().trim().min(16).max(256), secureBootHash: z.string().trim().max(256).optional(), hwSerial: z.string().trim().max(120).optional(), issuer: z.string().trim().max(200).optional(), validUntil: z.string().datetime().optional() }) });

export async function publishTrustAnchor(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = trustSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await hw.publishTrustAnchor(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Attestation
// ─────────────────────────────────────────────────────────────────────────

const attestSchema = z.object({ body: z.object({ deviceId: z.string().uuid(), fwVersion: z.string().trim().max(40).optional(), secureBootHash: z.string().trim().max(256).optional(), nonce: z.string().trim().min(8).max(128), sigB64: z.string().trim().min(8).max(512) }) });

export async function recordAttestation(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = attestSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await attest.recordAttestation(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Federated
// ─────────────────────────────────────────────────────────────────────────

const boundarySchema = z.object({ body: z.object({ modelFamily: z.string().trim().min(1).max(120), dpEpsilon: z.number().min(0).max(10).optional(), kAnonymity: z.number().int().min(1).max(1000).optional(), aggregationOnly: z.boolean().optional(), notes: z.string().trim().max(2000).optional() }) });

export async function publishBoundary(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = boundarySchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await fed.publishPrivacyBoundary(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

const jobSchema = z.object({ body: z.object({ sport: z.enum(SPORTS).optional(), modelFamily: z.string().trim().min(1).max(120), clippingNormMax: z.number().min(0).optional(), metadata: z.any().optional() }) });

export async function createFedJob(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = jobSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await fed.createJob(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

const gradSchema = z.object({ body: z.object({ payloadHash: z.string().trim().length(64), blobRef: z.string().trim().max(800).optional(), nonce: z.string().trim().min(8).max(128), sigB64: z.string().optional(), normValue: z.number().min(0).optional() }) });

export async function submitGradient(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = gradSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await fed.submitGradient(actor(req), req.params.jobId, parsed.data.body)));
  } catch (err) { return next(err); }
}

const aggSchema = z.object({ body: z.object({ version: z.string().trim().min(3).max(40), blobRef: z.string().trim().max(800).optional() }) });

export async function aggregateRound(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = aggSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await fed.aggregate(actor(req), req.params.jobId, parsed.data.body.version, parsed.data.body.blobRef)));
  } catch (err) { return next(err); }
}

export async function listFedJobs(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await fed.listJobs({
      modelFamily: typeof req.query.modelFamily === 'string' ? req.query.modelFamily : undefined,
      status:      typeof req.query.status === 'string' ? req.query.status as never : undefined,
    });
    return sendSuccess(res, out.map(bigintSafe));
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Coach agents
// ─────────────────────────────────────────────────────────────────────────

const registerAgentSchema = z.object({ body: z.object({ label: z.string().trim().min(1).max(200), agentKind: z.enum(AGENT_KINDS), config: z.any().optional() }) });

export async function registerCoach(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = registerAgentSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await coach.registerAgent(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listCoaches(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await coach.listAgents(actor(req))).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const recSchema = z.object({ body: z.object({
  matchId:        z.string().uuid().nullable().optional(),
  teamId:         z.string().uuid().nullable().optional(),
  playerId:       z.string().uuid().nullable().optional(),
  agentId:        z.string().uuid().nullable().optional(),
  kind:           z.enum(COACH_KINDS),
  title:          z.string().trim().max(200).optional(),
  rationale:      z.string().trim().min(1).max(10_000),
  payload:        z.any(),
  confidence:     z.number().min(0).max(1).optional(),
  tacticalImpact: z.enum(['LOW','MEDIUM','HIGH']).optional(),
}).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function issueRecommendation(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = recSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await coach.issueRecommendation(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

export async function listRecommendations(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await coach.listRecommendations(actor(req), {
      matchId:  typeof req.query.matchId  === 'string' ? req.query.matchId  : undefined,
      kind:     typeof req.query.kind     === 'string' ? req.query.kind as never : undefined,
      playerId: typeof req.query.playerId === 'string' ? req.query.playerId : undefined,
    });
    return sendPaginated(res, out.items.map(bigintSafe), out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Simulation
// ─────────────────────────────────────────────────────────────────────────

const simCreateSchema = z.object({ body: z.object({ label: z.string().trim().min(1).max(200), matchId: z.string().uuid().optional(), sourceFrameId: z.string().uuid().optional(), notes: z.string().trim().max(2000).optional() }) });

export async function createSim(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = simCreateSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await sim.createSession(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listSims(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await sim.listSessions(actor(req), { matchId: typeof req.query.matchId === 'string' ? req.query.matchId : undefined })).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const branchSchema = z.object({ body: z.object({ label: z.string().trim().min(1).max(200), parentBranchId: z.string().uuid().optional(), divergencePayload: z.any() }).refine((v) => v.divergencePayload !== undefined, { message: 'divergencePayload required', path: ['divergencePayload'] }) });

export async function createBranch(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = branchSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await sim.createBranch(actor(req), req.params.sessionId, { label: body.label, parentBranchId: body.parentBranchId, divergencePayload: body.divergencePayload as never })));
  } catch (err) { return next(err); }
}

const stateSchema = z.object({ body: z.object({ branchId: z.string().uuid().optional(), tickMs: z.number().int().min(0), state: z.any() }).refine((v) => v.state !== undefined, { message: 'state required', path: ['state'] }) });

export async function recordSimState(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = stateSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await sim.recordState(actor(req), { sessionId: req.params.sessionId, branchId: parsed.data.body.branchId, tickMs: parsed.data.body.tickMs, state: parsed.data.body.state as never })));
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Cognitive graph
// ─────────────────────────────────────────────────────────────────────────

const graphSchema = z.object({ body: z.object({ matchId: z.string().uuid(), monotonicMs: z.number().int().min(0), nodes: z.any(), edges: z.any() }).refine((v) => v.nodes !== undefined && v.edges !== undefined, { message: 'nodes + edges required' }) });

export async function recordGameGraph(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = graphSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await graph.recordGameGraph(actor(req), { matchId: body.matchId, monotonicMs: body.monotonicMs, nodes: body.nodes as never, edges: body.edges as never })));
  } catch (err) { return next(err); }
}

export async function listGameGraphs(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await graph.listGameGraphs(actor(req), req.params.matchId, {
      fromMs: typeof req.query.fromMs === 'string' ? parseInt(req.query.fromMs, 10) : undefined,
      toMs:   typeof req.query.toMs   === 'string' ? parseInt(req.query.toMs, 10)   : undefined,
      limit:  typeof req.query.limit  === 'string' ? parseInt(req.query.limit, 10)  : undefined,
    });
    return sendSuccess(res, out.map(bigintSafe));
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Biochem expansion
// ─────────────────────────────────────────────────────────────────────────

const signalSchema = z.object({ body: z.object({ playerId: z.string().uuid().nullable().optional(), matchId: z.string().uuid().nullable().optional(), kind: z.string().trim().min(1).max(40), value: z.number(), unit: z.string().trim().max(40).optional(), monotonicMs: z.number().int().min(0).optional(), sourceDeviceId: z.string().uuid().nullable().optional() }) });

export async function recordBiochemSignal(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = signalSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await bio.recordBiochemSignal(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Sport catalog
// ─────────────────────────────────────────────────────────────────────────

const pluginSchema = z.object({ body: z.object({ sport: z.enum(SPORTS), code: z.string().trim().min(1).max(120), label: z.string().trim().min(1).max(200) }) });

export async function publishPlugin(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = pluginSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await cat.publishPlugin(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listPlugins(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await cat.listPlugins(typeof req.query.sport === 'string' ? req.query.sport as never : undefined)).map(bigintSafe)); }
  catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Quantum (research stubs)
// ─────────────────────────────────────────────────────────────────────────

export async function quantumPosture(_req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, {
      optimizationEngine: quantumRegistry.optimization.name,
      schedulingEngine:   quantumRegistry.scheduling.name,
      patternEngine:      quantumRegistry.pattern.name,
      kemRecommendation:  quantumRegistry.boundary.recommendedKemForFederated,
      sigRecommendation:  quantumRegistry.boundary.recommendedSigForDevices,
      posture:            quantumRegistry.boundary.posture(),
    });
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Observability snapshot
// ─────────────────────────────────────────────────────────────────────────

export async function phaseLSnapshot(_req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await obs.snapshotPhaseL()); }
  catch (err) { return next(err); }
}

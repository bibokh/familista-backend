// Familista — Federated Sports Intelligence (Phase L)
// ─────────────────────────────────────────────────────────────────────────
// Privacy-preserving multi-club aggregation. NO actual ML training here —
// this is the contract surface + lifecycle plumbing.
//
// Determinism: each FederatedTrainingJob carries `aggregationSeed`.
// Aggregation is implemented as a deterministic weighted sum over sorted
// clubIds; given the same seed + same envelopes, the checkpoint reproduces.
//
// Cyber Defense, R8:
//   · DEFAULT DENY — a club contributes to a model family only when the
//     platform has explicitly trusted it (FederatedTrustBoundary.trusted) AND
//     the club has allowed its data to be used for training
//     (ClubAiDataPolicy.trainingUse). No record is a refusal, not a pass.
//   · SERVER-SIDE NORM — the gradient itself is submitted; the server checks it
//     hashes to payloadHash and computes its L2 norm. A norm the client reports
//     is ignored. Above the job's clipping norm (or FED_CLIPPING_NORM_MAX) it is
//     refused.
//   · CAPS — one accepted contribution per club per round, and at most
//     FED_MAX_CONTRIBUTIONS_PER_DAY (default 20) per club per day.
//   · OUTLIERS — at aggregation, a contribution whose norm is more than
//     FED_OUTLIER_FACTOR (default 3) × the round's median is rejected and left
//     out; too few participants for the privacy boundary's k is a refusal.
//   · THE CALLER — trust is granted by the platform owner only, and a round is
//     aggregated by the platform owner or the club that started it.

import { AggregatedSportsModel, ClubModelPartition, FederatedGradientEnvelope, FederatedJobStatus, FederatedModelCheckpoint, FederatedTrainingJob, FederatedTrustBoundary, Prisma, PrivacyBoundary, SportKind } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { assertFreshAndRemember } from '../security/device-nonce.service';
import { createHash, randomBytes } from 'crypto';
import { clubAiPolicy } from '../platform/intelligence/club-ai-policy';
import { assertPlatformOwner } from '../platform/system.service';

export interface FedActor {
  userId: string;
  clubId: string;
  role?:  string;
  /** SUPER_ADMIN or an active PlatformAdmin, as `authenticate` resolved it. */
  isPlatformOwner?: boolean;
}

export const MAX_GRADIENT_LENGTH = 100_000;
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export const clippingNormDefault = () => num(process.env.FED_CLIPPING_NORM_MAX, 10);
export const maxContributionsPerDay = () => Math.floor(num(process.env.FED_MAX_CONTRIBUTIONS_PER_DAY, 20));
export const outlierFactor = () => num(process.env.FED_OUTLIER_FACTOR, 3);

/** SHA-256 (hex) of a gradient: its values as little-endian float64, in order. */
export function gradientHash(gradient: ReadonlyArray<number>): string {
  const buf = Buffer.alloc(gradient.length * 8);
  gradient.forEach((v, i) => buf.writeDoubleLE(v, i * 8));
  return createHash('sha256').update(buf).digest('hex');
}

/** The L2 norm, computed here. */
export function l2Norm(gradient: ReadonlyArray<number>): number {
  let sum = 0;
  for (const v of gradient) sum += v * v;
  return Math.sqrt(sum);
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// ─────────────────────────────────────────────────────────────────────────
// Privacy boundaries (per-modelFamily)
// ─────────────────────────────────────────────────────────────────────────

export interface PublishBoundaryDto {
  modelFamily:     string;
  dpEpsilon?:      number;
  kAnonymity?:     number;
  aggregationOnly?: boolean;
  notes?:          string;
}

export async function publishPrivacyBoundary(_actor: FedActor, dto: PublishBoundaryDto): Promise<PrivacyBoundary> {
  if (!dto.modelFamily) throw new BadRequestError('modelFamily required');
  return prisma.privacyBoundary.upsert({
    where:  { modelFamily: dto.modelFamily },
    create: { modelFamily: dto.modelFamily, dpEpsilon: dto.dpEpsilon ?? 1, kAnonymity: dto.kAnonymity ?? 5, aggregationOnly: dto.aggregationOnly ?? true, notes: dto.notes ?? null },
    update: { dpEpsilon: dto.dpEpsilon ?? 1, kAnonymity: dto.kAnonymity ?? 5, aggregationOnly: dto.aggregationOnly ?? true, notes: dto.notes ?? null, isActive: true },
  });
}

export async function listPrivacyBoundaries(): Promise<PrivacyBoundary[]> {
  return prisma.privacyBoundary.findMany({ where: { isActive: true }, orderBy: { modelFamily: 'asc' } });
}

// ─────────────────────────────────────────────────────────────────────────
// Trust boundaries — which clubs can join which family
// ─────────────────────────────────────────────────────────────────────────

/** Trust (or distrust) a club for a model family. The platform owner only. */
export async function publishTrust(actor: FedActor, modelFamily: string, clubId: string, trusted = true, reason?: string): Promise<FederatedTrustBoundary> {
  await assertPlatformOwner({ userId: actor.userId, clubId: actor.clubId, role: actor.role ?? null });
  if (!modelFamily || !clubId) throw new BadRequestError('modelFamily and clubId required');
  const row = await prisma.federatedTrustBoundary.upsert({
    where:  { modelFamily_clubId: { modelFamily, clubId } },
    create: { modelFamily, clubId, trusted, reason: reason ?? null },
    update: { trusted, reason: reason ?? null },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: trusted ? 'FED_CLUB_TRUSTED' : 'FED_CLUB_DISTRUSTED',
    entityType: 'FederatedTrustBoundary', entityId: row.id,
    payload: { modelFamily, clubId },
  });
  return row;
}

export async function listTrusted(modelFamily: string): Promise<FederatedTrustBoundary[]> {
  return prisma.federatedTrustBoundary.findMany({ where: { modelFamily, trusted: true }, orderBy: { clubId: 'asc' } });
}

// ─────────────────────────────────────────────────────────────────────────
// Club partitions
// ─────────────────────────────────────────────────────────────────────────

export async function createPartition(actor: FedActor, modelFamily: string, partitionKey: string): Promise<ClubModelPartition> {
  return prisma.clubModelPartition.upsert({
    where:  { clubId_modelFamily_partitionKey: { clubId: actor.clubId, modelFamily, partitionKey } },
    create: { clubId: actor.clubId, modelFamily, partitionKey, active: true },
    update: { active: true },
  });
}

export async function listPartitions(actor: FedActor, modelFamily?: string): Promise<ClubModelPartition[]> {
  return prisma.clubModelPartition.findMany({
    where: { clubId: actor.clubId, ...(modelFamily ? { modelFamily } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────────────────────────────────

export interface CreateJobDto {
  sport?:         SportKind;
  modelFamily:    string;
  clippingNormMax?: number;
  metadata?:      Prisma.InputJsonValue;
}

export async function createJob(actor: FedActor, dto: CreateJobDto): Promise<FederatedTrainingJob> {
  if (!dto.modelFamily) throw new BadRequestError('modelFamily required');
  const boundary = await prisma.privacyBoundary.findUnique({ where: { modelFamily: dto.modelFamily } });
  // Determine next round number for this family.
  const last = await prisma.federatedTrainingJob.findFirst({
    where:   { modelFamily: dto.modelFamily },
    orderBy: { roundNumber: 'desc' },
    select:  { roundNumber: true },
  });
  const nextRound = (last?.roundNumber ?? -1) + 1;
  // 64-bit deterministic seed from random.
  const seedBuf = randomBytes(8);
  const aggregationSeed = seedBuf.readBigUInt64BE(0);

  const job = await prisma.federatedTrainingJob.create({
    data: {
      initiatorClubId:   actor.clubId,
      sport:             dto.sport ?? 'FOOTBALL',
      modelFamily:       dto.modelFamily,
      roundNumber:       nextRound,
      aggregationSeed,
      privacyBoundaryId: boundary?.id ?? null,
      clippingNormMax:   dto.clippingNormMax ?? null,
      status:            'PENDING',
      metadata:          (dto.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'FED_JOB_CREATED',
    entityType: 'FederatedTrainingJob',
    entityId: job.id,
    payload: { modelFamily: dto.modelFamily, roundNumber: nextRound },
  });
  return job;
}

export async function listJobs(opts: { modelFamily?: string; status?: FederatedJobStatus; limit?: number } = {}): Promise<FederatedTrainingJob[]> {
  return prisma.federatedTrainingJob.findMany({
    where: {
      ...(opts.modelFamily ? { modelFamily: opts.modelFamily } : {}),
      ...(opts.status      ? { status: opts.status } : {}),
    },
    orderBy: { roundNumber: 'desc' },
    take:    Math.min(opts.limit ?? 100, 1000),
  });
}

export async function setJobStatus(jobId: string, status: FederatedJobStatus): Promise<FederatedTrainingJob> {
  return prisma.federatedTrainingJob.update({
    where: { id: jobId },
    data:  {
      status,
      ...(status === 'RUNNING'  ? { startedAt: new Date() } : {}),
      ...(status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELED' ? { closedAt: new Date() } : {}),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Gradient submission
// ─────────────────────────────────────────────────────────────────────────

export interface SubmitGradientDto {
  payloadHash: string;
  /** The gradient itself. The server hashes it and computes its norm. */
  gradient:    number[];
  blobRef?:    string;
  nonce:       string;
  sigB64?:     string;
  /** Accepted for compatibility and IGNORED: the norm is computed here. */
  normValue?:  number;
}

export async function submitGradient(actor: FedActor, jobId: string, dto: SubmitGradientDto): Promise<FederatedGradientEnvelope> {
  if (!dto.payloadHash || !dto.nonce) throw new BadRequestError('payloadHash + nonce required');
  if (!/^[a-f0-9]{64}$/i.test(dto.payloadHash))     throw new BadRequestError('payloadHash must be sha256 hex');
  const g = dto.gradient;
  if (!Array.isArray(g) || g.length === 0 || g.length > MAX_GRADIENT_LENGTH || !g.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new BadRequestError(`gradient must be 1..${MAX_GRADIENT_LENGTH} finite numbers`);
  }

  const job = await prisma.federatedTrainingJob.findUnique({ where: { id: jobId } });
  if (!job)                                  throw new NotFoundError('FederatedTrainingJob');
  if (job.status === 'COMPLETED' || job.status === 'CANCELED' || job.status === 'FAILED') {
    throw new ForbiddenError(`Job is ${job.status}`);
  }
  // Trust gate — default deny: no record is a refusal.
  const trust = await prisma.federatedTrustBoundary.findUnique({
    where: { modelFamily_clubId: { modelFamily: job.modelFamily, clubId: actor.clubId } },
  });
  if (!trust || !trust.trusted) throw new ForbiddenError(`Club not trusted for ${job.modelFamily}`);
  // The club's own consent to its data being used for training.
  if (!(await clubAiPolicy(actor.clubId)).trainingUse) {
    throw new ForbiddenError('Your club has not allowed its data to be used for training');
  }
  // The gradient is what was hashed; its norm is ours, not the client's.
  if (gradientHash(g) !== dto.payloadHash.toLowerCase()) throw new BadRequestError('payloadHash does not match the gradient');
  const norm = l2Norm(g);
  const clip = job.clippingNormMax ?? clippingNormDefault();
  if (norm > clip) throw new BadRequestError(`gradient norm exceeds the clipping norm ${clip}`);
  // Caps: one per round, and a daily ceiling.
  const already = await prisma.federatedGradientEnvelope.count({ where: { jobId, clubId: actor.clubId, acceptedAt: { not: null } } });
  if (already > 0) throw new BadRequestError('This club has already contributed to this round');
  const since = new Date(Date.now() - 24 * 3_600_000);
  const today = await prisma.federatedGradientEnvelope.count({ where: { clubId: actor.clubId, createdAt: { gte: since } } });
  if (today >= maxContributionsPerDay()) throw new BadRequestError('This club has reached its daily federated contribution limit');
  // Anti-replay.
  if (!await assertFreshAndRemember(`fed-grad:${jobId}:${actor.clubId}`, dto.nonce)) {
    throw new BadRequestError('Nonce already used for this (job, club)');
  }

  return prisma.federatedGradientEnvelope.create({
    data: {
      jobId,
      clubId:       actor.clubId,
      payloadHash:  dto.payloadHash.toLowerCase(),
      blobRef:      dto.blobRef ?? null,
      nonce:        dto.nonce,
      sigB64:       dto.sigB64 ?? null,
      normValue:    norm,
      acceptedAt:   new Date(),
    },
  });
}

export async function listGradients(jobId: string, opts: { limit?: number } = {}): Promise<FederatedGradientEnvelope[]> {
  return prisma.federatedGradientEnvelope.findMany({
    where:   { jobId },
    orderBy: { createdAt: 'asc' },
    take:    Math.min(opts.limit ?? 200, 5000),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Aggregation — DETERMINISTIC over sorted clubIds.
// ─────────────────────────────────────────────────────────────────────────

export async function aggregate(actor: FedActor, jobId: string, version: string, blobRef?: string): Promise<FederatedModelCheckpoint> {
  const job = await prisma.federatedTrainingJob.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundError('FederatedTrainingJob');
  // The platform owner, or the club that started the round. Nobody else.
  if (!actor.isPlatformOwner && actor.clubId !== job.initiatorClubId) {
    throw new ForbiddenError('A round is aggregated by the club that started it or the platform owner');
  }
  if (job.status === 'COMPLETED' || job.status === 'CANCELED' || job.status === 'FAILED') {
    throw new ForbiddenError(`Job is ${job.status}`);
  }
  if (job.status !== 'RUNNING' && job.status !== 'AGGREGATING') {
    await prisma.federatedTrainingJob.update({ where: { id: jobId }, data: { status: 'AGGREGATING' } });
  }
  // Read accepted envelopes sorted by clubId for determinism.
  const accepted = await prisma.federatedGradientEnvelope.findMany({
    where:   { jobId, rejectedReason: null, acceptedAt: { not: null } },
    orderBy: { clubId: 'asc' },
  });
  // Outliers: a norm far above the round's median is left out, and says so.
  const norms = accepted.map((e) => e.normValue).filter((n): n is number => typeof n === 'number');
  const med = norms.length >= 3 ? median(norms) : null;
  const limit = med !== null && med > 0 ? med * outlierFactor() : null;
  const envs = accepted.filter((e) => typeof e.normValue === 'number' && (limit === null || e.normValue <= limit));
  const outliers = accepted.filter((e) => !envs.includes(e));
  if (outliers.length) {
    await prisma.federatedGradientEnvelope.updateMany({
      where: { id: { in: outliers.map((e) => e.id) } },
      data:  { rejectedReason: 'outlier: norm above the round median limit' },
    });
  }
  // The privacy boundary's k: fewer participants than that is not aggregated.
  const boundary = job.privacyBoundaryId
    ? await prisma.privacyBoundary.findUnique({ where: { id: job.privacyBoundaryId } })
    : null;
  if (boundary && envs.length < boundary.kAnonymity) {
    throw new BadRequestError(`At least ${boundary.kAnonymity} participants are needed to aggregate this round`);
  }
  // The payloadHash list is the deterministic input — we fold them as
  // sha256(seed | hash1 | hash2 | …) → final checkpoint hash.
  const order = envs.map((e) => e.clubId);
  const seed  = job.aggregationSeed.toString();
  const accumulator = createHash('sha256');
  accumulator.update(seed);
  for (const e of envs) accumulator.update('|' + e.payloadHash);
  const payloadHash = accumulator.digest('hex');

  const checkpoint = await prisma.federatedModelCheckpoint.create({
    data: {
      jobId,
      version,
      payloadHash,
      blobRef:          blobRef ?? null,
      participants:     envs.length,
      participantOrder: order as unknown as Prisma.InputJsonValue,
    },
  });
  await prisma.federatedTrainingJob.update({ where: { id: jobId }, data: { status: 'COMPLETED', closedAt: new Date() } });
  appendAuditEventAsync({
    actor: { userId: null, clubId: job.initiatorClubId ?? 'PLATFORM', ipAddress: null, userAgent: null },
    action: 'FED_CHECKPOINT_PUBLISHED',
    entityType: 'FederatedModelCheckpoint',
    entityId: checkpoint.id,
    payload: { modelFamily: job.modelFamily, version, participants: envs.length, outliers: outliers.length, payloadHash },
  });
  return checkpoint;
}

// ─────────────────────────────────────────────────────────────────────────
// Aggregated model (downloadable)
// ─────────────────────────────────────────────────────────────────────────

export interface PublishAggregatedDto {
  modelFamily: string;
  version:     string;
  sha256:      string;
  downloadUrl?: string;
}

export async function publishAggregatedModel(_actor: FedActor, dto: PublishAggregatedDto): Promise<AggregatedSportsModel> {
  if (!/^[a-f0-9]{64}$/i.test(dto.sha256)) throw new BadRequestError('sha256 must be 64-char hex');
  return prisma.aggregatedSportsModel.upsert({
    where:  { modelFamily_version: { modelFamily: dto.modelFamily, version: dto.version } },
    create: { modelFamily: dto.modelFamily, version: dto.version, sha256: dto.sha256, downloadUrl: dto.downloadUrl ?? null, isActive: true },
    update: { sha256: dto.sha256, downloadUrl: dto.downloadUrl ?? null, isActive: true },
  });
}

export async function listAggregatedModels(modelFamily?: string): Promise<AggregatedSportsModel[]> {
  return prisma.aggregatedSportsModel.findMany({
    where: { isActive: true, ...(modelFamily ? { modelFamily } : {}) },
    orderBy: [{ modelFamily: 'asc' }, { publishedAt: 'desc' }],
  });
}

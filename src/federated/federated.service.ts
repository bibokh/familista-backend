// Familista — Federated Sports Intelligence (Phase L)
// ─────────────────────────────────────────────────────────────────────────
// Privacy-preserving multi-club aggregation. NO actual ML training here —
// this is the contract surface + lifecycle plumbing.
//
// Determinism: each FederatedTrainingJob carries `aggregationSeed`.
// Aggregation is implemented as a deterministic weighted sum over sorted
// clubIds; given the same seed + same envelopes, the checkpoint reproduces.

import { AggregatedSportsModel, ClubModelPartition, FederatedGradientEnvelope, FederatedJobStatus, FederatedModelCheckpoint, FederatedTrainingJob, FederatedTrustBoundary, Prisma, PrivacyBoundary, SportKind } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { assertFreshAndRemember } from '../security/device-nonce.service';
import { randomBytes } from 'crypto';

export interface FedActor {
  userId: string;
  clubId: string;
  role?:  string;
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

export async function publishTrust(_actor: FedActor, modelFamily: string, clubId: string, trusted = true, reason?: string): Promise<FederatedTrustBoundary> {
  return prisma.federatedTrustBoundary.upsert({
    where:  { modelFamily_clubId: { modelFamily, clubId } },
    create: { modelFamily, clubId, trusted, reason: reason ?? null },
    update: { trusted, reason: reason ?? null },
  });
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
  blobRef?:    string;
  nonce:       string;
  sigB64?:     string;
  normValue?:  number;
}

export async function submitGradient(actor: FedActor, jobId: string, dto: SubmitGradientDto): Promise<FederatedGradientEnvelope> {
  if (!dto.payloadHash || !dto.nonce) throw new BadRequestError('payloadHash + nonce required');
  if (!/^[a-f0-9]{64}$/i.test(dto.payloadHash))     throw new BadRequestError('payloadHash must be sha256 hex');

  const job = await prisma.federatedTrainingJob.findUnique({ where: { id: jobId } });
  if (!job)                                  throw new NotFoundError('FederatedTrainingJob');
  if (job.status === 'COMPLETED' || job.status === 'CANCELED' || job.status === 'FAILED') {
    throw new ForbiddenError(`Job is ${job.status}`);
  }
  // Trust gate.
  const trust = await prisma.federatedTrustBoundary.findUnique({
    where: { modelFamily_clubId: { modelFamily: job.modelFamily, clubId: actor.clubId } },
  });
  if (trust && !trust.trusted) throw new ForbiddenError(`Club not trusted for ${job.modelFamily}`);
  // Clipping gate.
  if (typeof dto.normValue === 'number' && job.clippingNormMax && dto.normValue > job.clippingNormMax) {
    throw new BadRequestError(`normValue exceeds clippingNormMax ${job.clippingNormMax}`);
  }
  // Anti-replay.
  if (!assertFreshAndRemember(`fed-grad:${jobId}:${actor.clubId}`, dto.nonce)) {
    throw new BadRequestError('Nonce already used for this (job, club)');
  }

  return prisma.federatedGradientEnvelope.create({
    data: {
      jobId,
      clubId:       actor.clubId,
      payloadHash:  dto.payloadHash,
      blobRef:      dto.blobRef ?? null,
      nonce:        dto.nonce,
      sigB64:       dto.sigB64 ?? null,
      normValue:    dto.normValue ?? null,
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

export async function aggregate(_actor: FedActor, jobId: string, version: string, blobRef?: string): Promise<FederatedModelCheckpoint> {
  const job = await prisma.federatedTrainingJob.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundError('FederatedTrainingJob');
  if (job.status !== 'RUNNING' && job.status !== 'AGGREGATING') {
    await prisma.federatedTrainingJob.update({ where: { id: jobId }, data: { status: 'AGGREGATING' } });
  }
  // Read accepted envelopes sorted by clubId for determinism.
  const envs = await prisma.federatedGradientEnvelope.findMany({
    where:   { jobId, rejectedReason: null, acceptedAt: { not: null } },
    orderBy: { clubId: 'asc' },
  });
  // The payloadHash list is the deterministic input — we fold them as
  // sha256(seed | hash1 | hash2 | …) → final checkpoint hash.
  const order = envs.map((e) => e.clubId);
  const seed  = job.aggregationSeed.toString();
  const accumulator = require('crypto').createHash('sha256');
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
    payload: { modelFamily: job.modelFamily, version, participants: envs.length, payloadHash },
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

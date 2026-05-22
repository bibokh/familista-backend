// Familista — Edge AI Vision Runtime service (Phase K)
// ─────────────────────────────────────────────────────────────────────────
// EdgeVisionRuntime is a vision-specific runtime hosted on a Phase J
// EdgeNode (or directly anchored to a Phase G Camera). It owns a list of
// EdgeModelManifest + EdgeModelVersion bindings and emits inference
// packets to /neuro/runtimes/:id/inference (HMAC-signed where possible).

import { EdgeModelManifest, EdgeModelVersion, EdgeVisionHealth, EdgeVisionInference, EdgeVisionRuntime, EdgeVisionRuntimeStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface EdgeVisionActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ── Runtimes ────────────────────────────────────────────────────────────

export interface ProvisionRuntimeDto {
  label:      string;
  edgeNodeId?: string;
  cameraId?:   string;
  fwVersion?:  string;
  os?:         string;
  hwClass?:    string;
  metadata?:   Prisma.InputJsonValue;
}

export async function provisionRuntime(actor: EdgeVisionActor, dto: ProvisionRuntimeDto): Promise<EdgeVisionRuntime> {
  if (!dto.label) throw new BadRequestError('label required');
  if (dto.edgeNodeId) {
    const n = await prisma.edgeNode.findUnique({ where: { id: dto.edgeNodeId }, select: { clubId: true } });
    if (!n || n.clubId !== actor.clubId) throw new ForbiddenError('EdgeNode not in club');
  }
  if (dto.cameraId) {
    const c = await prisma.camera.findUnique({ where: { id: dto.cameraId }, select: { clubId: true } });
    if (!c || c.clubId !== actor.clubId) throw new ForbiddenError('Camera not in club');
  }
  return prisma.edgeVisionRuntime.create({
    data: {
      clubId:     actor.clubId,
      edgeNodeId: dto.edgeNodeId ?? null,
      cameraId:   dto.cameraId ?? null,
      label:      dto.label,
      fwVersion:  dto.fwVersion ?? null,
      os:         dto.os ?? null,
      hwClass:    dto.hwClass ?? null,
      status:     'PROVISIONED',
      metadata:   (dto.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function listRuntimes(actor: EdgeVisionActor, opts: { status?: EdgeVisionRuntimeStatus; page?: number; limit?: number } = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.EdgeVisionRuntimeWhereInput = {
    clubId: actor.clubId,
    ...(opts.status ? { status: opts.status } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.edgeVisionRuntime.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: Math.min(limit, 200) }),
    prisma.edgeVisionRuntime.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getRuntime(actor: EdgeVisionActor, id: string): Promise<EdgeVisionRuntime> {
  const r = await prisma.edgeVisionRuntime.findUnique({ where: { id } });
  if (!r)                                                       throw new NotFoundError('EdgeVisionRuntime');
  if (r.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return r;
}

export async function setRuntimeStatus(actor: EdgeVisionActor, id: string, status: EdgeVisionRuntimeStatus): Promise<EdgeVisionRuntime> {
  const r = await getRuntime(actor, id);
  return prisma.edgeVisionRuntime.update({ where: { id: r.id }, data: { status, lastSeenAt: new Date() } });
}

// ── Model manifests + versions ──────────────────────────────────────────

export interface PublishManifestDto {
  code:        string;
  label:       string;
  family:      'detect' | 'pose' | 'ball' | 'tactical' | string;
  description?: string;
}

export async function publishManifest(_actor: EdgeVisionActor, dto: PublishManifestDto): Promise<EdgeModelManifest> {
  if (!dto.code || !dto.label || !dto.family) throw new BadRequestError('code, label, family required');
  return prisma.edgeModelManifest.upsert({
    where:  { code: dto.code },
    create: { code: dto.code, label: dto.label, family: dto.family, description: dto.description ?? null, isActive: true },
    update: { label: dto.label, family: dto.family, description: dto.description ?? null, isActive: true },
  });
}

export async function listManifests(): Promise<EdgeModelManifest[]> {
  return prisma.edgeModelManifest.findMany({ orderBy: [{ family: 'asc' }, { code: 'asc' }] });
}

export interface PublishModelVersionDto {
  manifestCode: string;
  version:      string;
  sha256:       string;
  sizeBytes?:   number;
  downloadUrl?: string;
}

export async function publishModelVersion(_actor: EdgeVisionActor, dto: PublishModelVersionDto): Promise<EdgeModelVersion> {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(dto.version)) throw new BadRequestError('version must be semver-like');
  if (!/^[a-f0-9]{64}$/i.test(dto.sha256))           throw new BadRequestError('sha256 must be 64-char hex');
  const manifest = await prisma.edgeModelManifest.findUnique({ where: { code: dto.manifestCode } });
  if (!manifest) throw new NotFoundError('EdgeModelManifest');
  return prisma.edgeModelVersion.upsert({
    where:  { manifestId_version: { manifestId: manifest.id, version: dto.version } },
    create: {
      manifestId:  manifest.id,
      version:     dto.version,
      sha256:      dto.sha256,
      sizeBytes:   dto.sizeBytes ?? 0,
      downloadUrl: dto.downloadUrl ?? null,
      isActive:    true,
    },
    update: { sha256: dto.sha256, sizeBytes: dto.sizeBytes ?? 0, downloadUrl: dto.downloadUrl ?? null, isActive: true },
  });
}

export async function listModelVersions(manifestCode?: string): Promise<EdgeModelVersion[]> {
  if (manifestCode) {
    const m = await prisma.edgeModelManifest.findUnique({ where: { code: manifestCode } });
    if (!m) return [];
    return prisma.edgeModelVersion.findMany({ where: { manifestId: m.id }, orderBy: { publishedAt: 'desc' } });
  }
  return prisma.edgeModelVersion.findMany({ orderBy: { publishedAt: 'desc' }, take: 100 });
}

// ── Inference packets ───────────────────────────────────────────────────

export interface RecordInferenceDto {
  matchId?:        string | null;
  cameraId?:       string | null;
  modelVersionId?: string | null;
  monotonicMs?:    number;
  kind:            string;
  payload:         Prisma.InputJsonValue;
  confidence?:     number;
  latencyMs?:      number;
  sigB64?:         string;
  nonce?:          string;
}

export async function recordInference(actor: EdgeVisionActor, runtimeId: string, dto: RecordInferenceDto): Promise<EdgeVisionInference> {
  const r = await getRuntime(actor, runtimeId);
  return prisma.edgeVisionInference.create({
    data: {
      runtimeId:      r.id,
      clubId:         r.clubId,
      matchId:        dto.matchId ?? null,
      cameraId:       dto.cameraId ?? r.cameraId ?? null,
      modelVersionId: dto.modelVersionId ?? null,
      monotonicMs:    BigInt(dto.monotonicMs ?? Date.now()),
      kind:           dto.kind,
      payload:        dto.payload,
      confidence:     Math.max(0, Math.min(1, dto.confidence ?? 0.5)),
      latencyMs:      dto.latencyMs ?? null,
      sigB64:         dto.sigB64 ?? null,
      nonce:          dto.nonce ?? null,
    },
  });
}

export async function listInferences(actor: EdgeVisionActor, runtimeId: string, opts: { limit?: number; kind?: string } = {}): Promise<EdgeVisionInference[]> {
  const r = await getRuntime(actor, runtimeId);
  return prisma.edgeVisionInference.findMany({
    where:   { runtimeId: r.id, ...(opts.kind ? { kind: opts.kind } : {}) },
    orderBy: { monotonicMs: 'desc' },
    take:    Math.min(opts.limit ?? 200, 2000),
  });
}

// ── Health snapshots ────────────────────────────────────────────────────

export async function recordHealth(actor: EdgeVisionActor, runtimeId: string, beat: { score: number; latencyP95Ms?: number; jobsPerMin?: number; failuresPerMin?: number }): Promise<EdgeVisionHealth> {
  const r = await getRuntime(actor, runtimeId);
  return prisma.$transaction(async (tx) => {
    await tx.edgeVisionRuntime.update({ where: { id: r.id }, data: { lastSeenAt: new Date(), status: beat.score >= 0.8 ? 'ACTIVE' : beat.score >= 0.4 ? 'DEGRADED' : 'OFFLINE' } });
    return tx.edgeVisionHealth.create({
      data: {
        runtimeId:      r.id,
        score:          Math.max(0, Math.min(1, beat.score)),
        latencyP95Ms:   beat.latencyP95Ms ?? null,
        jobsPerMin:     beat.jobsPerMin ?? 0,
        failuresPerMin: beat.failuresPerMin ?? 0,
      },
    });
  });
}

export async function listHealth(actor: EdgeVisionActor, runtimeId: string, limit = 50): Promise<EdgeVisionHealth[]> {
  const r = await getRuntime(actor, runtimeId);
  return prisma.edgeVisionHealth.findMany({ where: { runtimeId: r.id }, orderBy: { capturedAt: 'desc' }, take: Math.min(limit, 500) });
}

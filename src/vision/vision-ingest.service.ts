// Familista — Vision frame ingest (Phase G)
// ─────────────────────────────────────────────────────────────────────────
// Edge nodes POST detection bundles. We:
//   1. Verify the HMAC against the camera's secret.
//   2. Update the camera's clock-skew telemetry.
//   3. Persist the row in VisionFrame (append-only).
//   4. Best-effort: publishCustom('VISION_FRAME', …) → outbox + adapters.
//
// We DO NOT trigger spatial-engine compute here — the engine reads on
// demand (see src/spatial/cognitive-engine.ts). This keeps the ingest
// path bounded under 100 Hz from a 4-camera rig.

import { createHash } from 'crypto';
import { resolveCredential, signingKeyOf } from '../fabric/secrets/device-credentials';
import { VisionFrame, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError, UnauthorizedError } from '../utils/errors';
import { verifyCameraHmac } from './camera-registry.service';
import { publishCustom } from '../big-data/publisher';
import { assertFreshAndRemember } from '../security/device-nonce.service';
import { logDeviceSecurityEvent } from '../security/security-event.service';

/** How far a camera's signed clock may sit from ours before a frame is refused. */
const TS_SKEW_LIMIT_MS = 5 * 60_000;

export interface VisionIngestDto {
  /** Camera-local us timestamp. */
  cameraTsUs:  number;
  /** Detection bundle. */
  detections:  Prisma.InputJsonValue;
  /** Optional kind override: "RGB" | "EVENT_AGGREGATED" | "POSE_KEYPOINTS". */
  kind?:       string;
  /** Optional matchId — when this frame is part of a known live match. */
  matchId?:    string | null;
  /** Calibration version (denormalised). */
  calibrationVersion?: number;
  /** HMAC of `${cameraTsUs}.${sha256(detections-json)}`. Required. */
  sigB64:      string;
  /** Nonce for the HMAC to prevent replay. */
  nonce:       string;
}

export async function ingestVisionFrame(cameraId: string, dto: VisionIngestDto): Promise<VisionFrame> {
  if (!dto.sigB64 || !dto.nonce || typeof dto.cameraTsUs !== 'number') {
    throw new BadRequestError('cameraTsUs, sigB64, nonce required');
  }
  const cam = await prisma.camera.findUnique({ where: { id: cameraId } });
  if (!cam)                        throw new NotFoundError('Camera');
  if (cam.status === 'RETIRED')    throw new ForbiddenError('Camera retired');

  // HMAC over (cameraTsUs).(nonce).(sha256 of detections)
  const digest = createHash('sha256')
    .update(safeJson(dto.detections))
    .digest('hex');
  const msg = `${dto.cameraTsUs}.${dto.nonce}.${digest}`;
  // Resolved through the credential seam: the reference where the row has one,
  // the legacy column where it does not. Never `row.hmacSecret` directly. A
  // camera whose credential does not resolve is refused with the same answer a
  // wrong signature gets — never checked against an empty key anyone can sign
  // with.
  const key = signingKeyOf(await resolveCredential(cam));
  if (!key) {
    logDeviceSecurityEvent({ kind: 'DEVICE_REJECTED', severity: 'CRITICAL', clubId: cam.clubId, cameraId: cam.id, payload: { reason: 'credential_unresolved' } });
    throw new ForbiddenError('Invalid camera signature');
  }
  if (!verifyCameraHmac(key, msg, dto.sigB64)) {
    logDeviceSecurityEvent({ kind: 'DEVICE_REJECTED', severity: 'CRITICAL', clubId: cam.clubId, cameraId: cam.id, payload: { reason: 'hmac_mismatch' } });
    throw new ForbiddenError('Invalid camera signature');
  }

  // Replay. The camera's timestamp is inside the signature, so a frame whose
  // clock is more than five minutes from ours is refused, and inside that
  // window each nonce is accepted once per camera — the same two gates the
  // neuromorphic stream applies (event-stream.service.ts).
  const nowMs    = Date.now();
  const cameraMs = Math.round(dto.cameraTsUs / 1000);
  if (Math.abs(nowMs - cameraMs) > TS_SKEW_LIMIT_MS) {
    logDeviceSecurityEvent({ kind: 'DEVICE_TS_SKEW', severity: 'WARN', clubId: cam.clubId, cameraId: cam.id, payload: { skewMs: nowMs - cameraMs } });
    throw new ForbiddenError('Camera clock skew exceeds 5 min');
  }
  if (!await assertFreshAndRemember(`cam-frame:${cam.id}`, dto.nonce)) {
    logDeviceSecurityEvent({ kind: 'DEVICE_REPLAY', severity: 'CRITICAL', clubId: cam.clubId, cameraId: cam.id, payload: { reason: 'nonce_reused' } });
    throw new UnauthorizedError('Nonce already used');
  }

  const monotonicMs = BigInt(nowMs);
  const cameraTsUs  = BigInt(Math.round(dto.cameraTsUs));
  // Coarse clock-skew = nowMs - (cameraTsUs / 1000); persisted on the camera row.
  const clockSkewMs = Math.round(nowMs - Number(cameraTsUs) / 1000);

  // Persist + telemetry in one go.
  const [row] = await prisma.$transaction([
    prisma.visionFrame.create({
      data: {
        clubId:             cam.clubId,
        matchId:            dto.matchId ?? null,
        cameraId,
        monotonicMs,
        cameraTsUs,
        kind:               dto.kind ?? 'RGB',
        detections:         dto.detections,
        calibrationVersion: dto.calibrationVersion ?? null,
        sigB64:             dto.sigB64,
      },
    }),
    prisma.camera.update({
      where: { id: cameraId },
      data:  { lastClockSkewMs: clockSkewMs, status: cam.status === 'OFFLINE' ? 'ACTIVE' : cam.status },
    }),
  ]);

  // Best-effort big-data fan-out (outbox + adapters). NEVER throws back.
  publishCustom(cam.clubId, dto.matchId ?? null, 'VISION_FRAME', {
    visionFrameId: row.id,
    cameraId,
    monotonicMs:   row.monotonicMs.toString(),
    cameraTsUs:    row.cameraTsUs.toString(),
    kind:          row.kind,
  }, 'vision-ingest');

  return row;
}

export async function listVisionFrames(matchId: string, clubId: string, opts: { fromMs?: number; toMs?: number; cameraId?: string; limit?: number } = {}) {
  const where: Prisma.VisionFrameWhereInput = {
    matchId,
    clubId,
    ...(opts.cameraId && { cameraId: opts.cameraId }),
    ...((opts.fromMs || opts.toMs) && {
      monotonicMs: {
        ...(opts.fromMs ? { gte: BigInt(opts.fromMs) } : {}),
        ...(opts.toMs   ? { lte: BigInt(opts.toMs)   } : {}),
      },
    }),
  };
  return prisma.visionFrame.findMany({
    where,
    orderBy: { monotonicMs: 'asc' },
    take:    Math.min(opts.limit ?? 500, 5000),
  });
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v ?? null); } catch { return 'null'; }
}

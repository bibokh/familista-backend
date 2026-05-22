// Familista — Signed Recommendations + Trust Score (Phase N)
// ─────────────────────────────────────────────────────────────────────────
// HMAC-SHA256 signatures over recommendation payloads. The signing key is
// HKDF-derived from `config.jwt.secret + recommendationKind + clubId`.
// Compatible with the Phase I envelope-sign approach.
//
// TrustScore is a deterministic running average of confidence updates
// per (clubId, sourceKind, sourceRef).

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Prisma, RecommendationSignature, TrustScore } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { config } from '../config';
import { appendAuditEventAsync } from '../security/audit-chain.service';

const SIGNER_VERSION = 'n1';

function deriveKey(clubId: string, kind: string): Buffer {
  return createHmac('sha256', config.jwt.secret).update(`rec|${kind}|${clubId}`).digest();
}

function canonical(payload: unknown): string {
  // Sort keys for deterministic canonical form.
  if (payload === null || payload === undefined) return 'null';
  if (typeof payload !== 'object') return JSON.stringify(payload);
  return JSON.stringify(payload, Object.keys(payload as object).sort());
}

/** Sign a recommendation body. Returns the persisted signature row. */
export async function signRecommendation(
  clubId: string,
  recommendationId: string,
  kind: 'GLOBAL_RANKING' | 'EXPLAINABLE_DECISION' | string,
  payload: unknown,
): Promise<RecommendationSignature> {
  if (!clubId || !recommendationId || !kind) throw new BadRequestError('clubId + recommendationId + kind required');
  const body = canonical({ clubId, kind, payload });
  const key = deriveKey(clubId, kind);
  const sig = createHmac('sha256', key).update(body).digest('base64');
  const hash = createHash('sha256').update(body).digest('hex');

  // Mirror sig + hash into the source rows so callers see it inline.
  if (kind === 'GLOBAL_RANKING') {
    await prisma.globalRecommendationRanking.update({
      where: { id: recommendationId },
      data:  { signatureB64: sig },
    }).catch(() => undefined);
  }

  const row = await prisma.recommendationSignature.upsert({
    where:  { recommendationId_recommendationKind: { recommendationId, recommendationKind: kind } },
    create: { clubId, recommendationId, recommendationKind: kind, signatureB64: sig, payloadHash: hash, signerVersion: SIGNER_VERSION },
    update: { signatureB64: sig, payloadHash: hash, signerVersion: SIGNER_VERSION },
  });
  appendAuditEventAsync({
    actor: { userId: null, clubId, ipAddress: null, userAgent: null },
    action: `RECOMMENDATION_SIGNED:${kind}`,
    entityType: 'RecommendationSignature', entityId: row.id,
    payload: { recommendationId, hash },
  });
  return row;
}

/** Verify a signature against a payload. Pure function. */
export function verifyRecommendation(clubId: string, kind: string, payload: unknown, sigB64: string): boolean {
  try {
    const body = canonical({ clubId, kind, payload });
    const key = deriveKey(clubId, kind);
    const expected = createHmac('sha256', key).update(body).digest();
    const supplied = Buffer.from(sigB64, 'base64');
    if (supplied.length !== expected.length) return false;
    return timingSafeEqual(supplied, expected);
  } catch { return false; }
}

export async function getSignature(clubId: string, recommendationId: string, kind: string): Promise<RecommendationSignature> {
  const row = await prisma.recommendationSignature.findUnique({
    where: { recommendationId_recommendationKind: { recommendationId, recommendationKind: kind } },
  });
  if (!row)                               throw new NotFoundError('RecommendationSignature');
  if (row.clubId !== clubId)              throw new BadRequestError('Signature belongs to a different tenant');
  return row;
}

// ─────────────────────────────────────────────────────────────────────────
// Trust score
// ─────────────────────────────────────────────────────────────────────────

export interface TrustActor {
  userId: string;
  clubId: string;
  role?:  string;
}

/**
 * Deterministic running update:
 *   newScore = (oldScore * observations + delta) / (observations + 1)
 * where `delta` is the [0..1] outcome of the latest evaluation.
 */
export async function updateTrust(actor: TrustActor, sourceKind: string, sourceRef: string, delta: number, components?: Prisma.InputJsonValue): Promise<TrustScore> {
  if (!sourceKind || !sourceRef) throw new BadRequestError('sourceKind + sourceRef required');
  const clamped = Math.max(0, Math.min(1, delta));
  const existing = await prisma.trustScore.findUnique({
    where: { clubId_sourceKind_sourceRef: { clubId: actor.clubId, sourceKind, sourceRef } },
  });
  const oldScore = existing?.score ?? 0.5;
  const oldObs   = existing?.observations ?? 0;
  const newObs   = oldObs + 1;
  const newScore = Number(((oldScore * oldObs + clamped) / newObs).toFixed(4));
  const row = await prisma.trustScore.upsert({
    where:  { clubId_sourceKind_sourceRef: { clubId: actor.clubId, sourceKind, sourceRef } },
    create: { clubId: actor.clubId, sourceKind, sourceRef, score: newScore, observations: newObs, components: (components ?? Prisma.JsonNull) as Prisma.InputJsonValue, modelVersion: SIGNER_VERSION },
    update: { score: newScore, observations: newObs, components: (components ?? Prisma.JsonNull) as Prisma.InputJsonValue },
  });
  return row;
}

export async function listTrust(actor: TrustActor, opts: { sourceKind?: string; limit?: number } = {}): Promise<TrustScore[]> {
  return prisma.trustScore.findMany({
    where: { clubId: actor.clubId, ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}) },
    orderBy: [{ score: 'desc' }, { observations: 'desc' }],
    take: Math.min(opts.limit ?? 100, 1000),
  });
}

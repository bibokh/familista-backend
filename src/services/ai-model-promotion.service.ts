// Familista — how a model version becomes ACTIVE (Cyber Defense, R8)
// ─────────────────────────────────────────────────────────────────────────────
// A model in the registry is an artifact: slug, version, provider, domain,
// decision type, input and output schemas, parameters. Its SHA-256 is computed
// over the canonical JSON of exactly those fields.
//
//   request   someone asks for a version to be promoted; the artifact's hash is
//             recorded on a PENDING promotion.
//   approve   a DIFFERENT person approves it — no role bypasses this. If the
//             artifact has changed since the request, the promotion is refused.
//             The approval is signed with Ed25519 (MODEL_SIGNING_PRIVATE_KEY,
//             the same construction as the backup manifest signatures) over
//             {modelId, slug, version, artifactSha256, decidedById, decidedAt},
//             and only then is the model activated.
//   resolve   every decision resolves its model through
//             `assertModelVerified`: the latest approved promotion's signature
//             must verify (MODEL_SIGNING_PUBLIC_KEY, or derived from the private
//             key) and the artifact must still hash to what was signed. A
//             tampered parameter, schema or version fails here.
//
// There is no other way to ACTIVE: `activateModel` refuses a model without a
// verified approved promotion, `updateModel` cannot set isActive, and the seed
// requests promotions instead of activating.

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'crypto';
import type { AIModel, AIModelPromotion } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { canonical, keyId } from '../security/backup/backup-crypto';

export interface PromotionActor { userId: string; clubId?: string | null; ipAddress?: string | null; userAgent?: string | null }

type ArtifactFields = Pick<AIModel, 'slug' | 'version' | 'provider' | 'domain' | 'decisionType' | 'inputSchema' | 'outputSchema' | 'parameters'>;

/** SHA-256 (hex) of the model's artifact. */
export function artifactSha256(m: ArtifactFields): string {
  const artifact = {
    slug: m.slug, version: m.version, provider: m.provider, domain: m.domain, decisionType: m.decisionType,
    inputSchema: m.inputSchema, outputSchema: m.outputSchema, parameters: m.parameters,
  };
  return createHash('sha256').update(canonical(artifact)).digest('hex');
}

// ── keys ────────────────────────────────────────────────────────────────────

function importKey(b64: string, kind: 'private' | 'public'): KeyObject {
  const der = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  const key = kind === 'private'
    ? createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    : createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`model signing ${kind} key is not Ed25519`);
  return key;
}

function signingPrivateKey(): KeyObject | null {
  const b64 = process.env.MODEL_SIGNING_PRIVATE_KEY;
  return b64 ? importKey(b64, 'private') : null;
}

function signingPublicKey(): KeyObject | null {
  const b64 = process.env.MODEL_SIGNING_PUBLIC_KEY;
  if (b64) return importKey(b64, 'public');
  const priv = signingPrivateKey();
  return priv ? createPublicKey(priv) : null;
}

function signedStatement(p: { modelId: string; slug: string; version: string; artifactSha256: string; decidedById: string; decidedAt: Date }): Buffer {
  return Buffer.from(canonical({
    modelId: p.modelId, slug: p.slug, version: p.version, artifactSha256: p.artifactSha256,
    decidedById: p.decidedById, decidedAt: p.decidedAt.toISOString(),
  }));
}

// ── request / approve / reject ──────────────────────────────────────────────

export async function requestPromotion(actor: PromotionActor, modelId: string, notes?: string | null): Promise<AIModelPromotion> {
  const model = await prisma.aIModel.findUnique({ where: { id: modelId } });
  if (!model) throw new NotFoundError('Model not found');
  if (model.deprecatedAt) throw new BadRequestError('Cannot promote a deprecated model');
  const open = await prisma.aIModelPromotion.findFirst({ where: { modelId, status: 'PENDING' } });
  if (open) return open;
  const row = await prisma.aIModelPromotion.create({
    data: { modelId, artifactSha256: artifactSha256(model), status: 'PENDING', requestedById: actor.userId, notes: notes ?? null },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId ?? 'PLATFORM', ipAddress: actor.ipAddress ?? null, userAgent: actor.userAgent ?? null },
    action: 'MODEL_PROMOTION_REQUESTED', entityType: 'AIModelPromotion', entityId: row.id,
    payload: { modelId, artifactSha256: row.artifactSha256 },
  });
  return row;
}

export async function approvePromotion(actor: PromotionActor, promotionId: string): Promise<{ promotion: AIModelPromotion; model: AIModel }> {
  const p = await prisma.aIModelPromotion.findUnique({ where: { id: promotionId }, include: { model: true } });
  if (!p) throw new NotFoundError('Promotion not found');
  if (p.status !== 'PENDING') throw new BadRequestError(`Promotion is ${p.status.toLowerCase()}`);
  if (p.requestedById === actor.userId) {
    throw new ForbiddenError('A model is promoted by someone other than the person who requested it');
  }
  const priv = signingPrivateKey();
  if (!priv) throw new AppError('Model promotion signing is not configured on this server', 503);
  if (artifactSha256(p.model) !== p.artifactSha256) {
    await prisma.aIModelPromotion.update({
      where: { id: p.id },
      data: { status: 'REJECTED', decidedById: actor.userId, decidedAt: new Date(), notes: 'The model changed after the promotion was requested' },
    });
    throw new BadRequestError('The model changed after the promotion was requested; request it again');
  }
  const decidedAt = new Date();
  const signature = sign(null, signedStatement({
    modelId: p.modelId, slug: p.model.slug, version: p.model.version, artifactSha256: p.artifactSha256,
    decidedById: actor.userId, decidedAt,
  }), priv).toString('base64');
  const claimed = await prisma.aIModelPromotion.updateMany({
    where: { id: p.id, status: 'PENDING' },
    data: { status: 'APPROVED', decidedById: actor.userId, decidedAt, signature, keyId: keyId(createPublicKey(priv)) },
  });
  if (claimed.count !== 1) throw new BadRequestError('The promotion was decided meanwhile');
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId ?? 'PLATFORM', ipAddress: actor.ipAddress ?? null, userAgent: actor.userAgent ?? null },
    action: 'MODEL_PROMOTION_APPROVED', entityType: 'AIModelPromotion', entityId: p.id,
    payload: { modelId: p.modelId, artifactSha256: p.artifactSha256 },
  });
  const promotion = (await prisma.aIModelPromotion.findUnique({ where: { id: p.id } }))!;
  return { promotion, model: p.model };
}

export async function rejectPromotion(actor: PromotionActor, promotionId: string, reason?: string | null): Promise<AIModelPromotion> {
  const r = await prisma.aIModelPromotion.updateMany({
    where: { id: promotionId, status: 'PENDING' },
    data: { status: 'REJECTED', decidedById: actor.userId, decidedAt: new Date(), notes: reason ?? null },
  });
  if (r.count !== 1) throw new BadRequestError('No pending promotion with that id');
  return (await prisma.aIModelPromotion.findUnique({ where: { id: promotionId } }))!;
}

// ── verification ────────────────────────────────────────────────────────────

export type ModelVerification = { ok: true; promotionId: string } | { ok: false; reason: string };

/** Whether this model may be used: an approved, signed promotion for exactly this artifact. */
export async function verifyModel(model: AIModel): Promise<ModelVerification> {
  const p = await prisma.aIModelPromotion.findFirst({
    where: { modelId: model.id, status: 'APPROVED' },
    orderBy: { decidedAt: 'desc' },
  });
  if (!p || !p.signature || !p.decidedById || !p.decidedAt) return { ok: false, reason: 'no approved promotion' };
  let pub: KeyObject | null;
  try { pub = signingPublicKey(); } catch { return { ok: false, reason: 'the signing key is not valid' }; }
  if (!pub) return { ok: false, reason: 'model signing is not configured' };
  if (p.keyId && p.keyId !== keyId(pub)) return { ok: false, reason: 'signed with a different key' };
  let good = false;
  try {
    good = verify(null, signedStatement({
      modelId: model.id, slug: model.slug, version: model.version, artifactSha256: p.artifactSha256,
      decidedById: p.decidedById, decidedAt: p.decidedAt,
    }), pub, Buffer.from(p.signature, 'base64'));
  } catch { good = false; }
  if (!good) return { ok: false, reason: 'the promotion signature does not verify' };
  if (artifactSha256(model) !== p.artifactSha256) return { ok: false, reason: 'the model changed after it was approved' };
  return { ok: true, promotionId: p.id };
}

export async function assertModelVerified(model: AIModel): Promise<void> {
  const v = await verifyModel(model);
  if (!v.ok) throw new AppError(`Model ${model.slug}@${model.version} is not verified: ${v.reason}`, 409);
}

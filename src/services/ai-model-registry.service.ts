// Familista — AI Decision Engine
// File location: src/services/ai-model-registry.service.ts
//
// Versioned model registry. Models are immutable once active; new versions
// supersede old ones. Decisions reference the model that produced them, so
// historical replays remain accurate even after the active model changes.
//
// Each (domain, decisionType) has at most one ACTIVE model at a time.
// `activateModel` atomically deactivates any peer active model.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  AIDomain,
  AIDecisionType,
  AIModel,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeAIAudit } from './ai-audit.service';
import type {
  CreateModelInput,
  UpdateModelInput,
  ActivateModelInput,
} from '../utils/ai-engine.validators';
import type { AIActor } from '../types/ai-engine.types';

export async function createModel(actor: AIActor, input: CreateModelInput): Promise<AIModel> {
  const dup = await prisma.aIModel.findUnique({
    where: { slug_version: { slug: input.slug, version: input.version } },
  });
  if (dup) throw new ConflictError(`Model ${input.slug}@${input.version} already exists`);

  const created = await prisma.aIModel.create({
    data: {
      slug: input.slug,
      name: input.name,
      domain: input.domain,
      decisionType: input.decisionType,
      version: input.version,
      provider: input.provider,
      description: input.description ?? null,
      inputSchema: input.inputSchema as Prisma.InputJsonValue,
      outputSchema: input.outputSchema as Prisma.InputJsonValue,
      parameters: input.parameters as Prisma.InputJsonValue,
      isActive: false,
      createdBy: actor.userId,
    },
  });

  await writeAIAudit({
    modelId: created.id,
    userId: actor.userId,
    action: 'MODEL_REGISTERED',
    category: 'MODEL',
    metadata: { slug: created.slug, version: created.version, domain: created.domain, decisionType: created.decisionType },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateModel(actor: AIActor, id: string, input: UpdateModelInput): Promise<AIModel> {
  const existing = await prisma.aIModel.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Model not found');

  if (existing.isActive && input.isActive === false) {
    // Direct deactivation is allowed but warn via audit.
  }

  const updated = await prisma.aIModel.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description ?? undefined,
      parameters: input.parameters === undefined ? undefined : (input.parameters as Prisma.InputJsonValue),
      isActive: input.isActive,
      deprecatedAt:
        input.deprecatedAt === undefined ? undefined : input.deprecatedAt ? new Date(input.deprecatedAt) : null,
    },
  });

  await writeAIAudit({
    modelId: id,
    userId: actor.userId,
    action: 'MODEL_UPDATED',
    category: 'MODEL',
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function activateModel(
  actor: AIActor,
  id: string,
  input: ActivateModelInput,
): Promise<AIModel> {
  return await prisma.$transaction(async (tx) => {
    const existing = await tx.aIModel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Model not found');
    if (existing.deprecatedAt) throw new BadRequestError('Cannot activate a deprecated model');

    if (input.deactivatePeers !== false) {
      await tx.aIModel.updateMany({
        where: {
          domain: existing.domain,
          decisionType: existing.decisionType,
          isActive: true,
          NOT: { id },
        },
        data: { isActive: false },
      });
    }

    return await tx.aIModel.update({
      where: { id },
      data: { isActive: true, releasedAt: existing.releasedAt ?? new Date() },
    });
  }).then(async (model) => {
    await writeAIAudit({
      modelId: model.id,
      userId: actor.userId,
      action: 'MODEL_ACTIVATED',
      category: 'MODEL',
      metadata: { slug: model.slug, version: model.version, notes: input.notes },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return model;
  });
}

export async function deprecateModel(actor: AIActor, id: string, reason: string): Promise<AIModel> {
  const existing = await prisma.aIModel.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Model not found');

  const updated = await prisma.aIModel.update({
    where: { id },
    data: { isActive: false, deprecatedAt: new Date() },
  });

  await writeAIAudit({
    modelId: id,
    userId: actor.userId,
    action: 'MODEL_DEPRECATED',
    category: 'MODEL',
    metadata: { reason },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function getActiveModel(
  domain: AIDomain,
  decisionType: AIDecisionType,
): Promise<AIModel | null> {
  return await prisma.aIModel.findFirst({
    where: { domain, decisionType, isActive: true, deprecatedAt: null },
    orderBy: [{ releasedAt: 'desc' }],
  });
}

export async function resolveModel(
  domain: AIDomain,
  decisionType: AIDecisionType,
  forceSlug?: string,
  forceVersion?: string,
): Promise<AIModel> {
  if (forceSlug && forceVersion) {
    const m = await prisma.aIModel.findUnique({
      where: { slug_version: { slug: forceSlug, version: forceVersion } },
    });
    if (!m) throw new NotFoundError(`Model ${forceSlug}@${forceVersion} not found`);
    if (m.domain !== domain || m.decisionType !== decisionType) {
      throw new BadRequestError('Forced model does not match requested domain / decisionType');
    }
    return m;
  }

  const active = await getActiveModel(domain, decisionType);
  if (!active) throw new NotFoundError(`No active model for ${domain}/${decisionType}`);
  return active;
}

export async function listModels(opts: {
  domain?: AIDomain;
  decisionType?: AIDecisionType;
  activeOnly?: boolean;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.aIModel.findMany({
    where: {
      ...(opts.domain ? { domain: opts.domain } : {}),
      ...(opts.decisionType ? { decisionType: opts.decisionType } : {}),
      ...(opts.activeOnly ? { isActive: true, deprecatedAt: null } : {}),
    },
    orderBy: [{ domain: 'asc' }, { decisionType: 'asc' }, { releasedAt: 'desc' }, { createdAt: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function getModel(id: string): Promise<AIModel> {
  const m = await prisma.aIModel.findUnique({ where: { id } });
  if (!m) throw new NotFoundError('Model not found');
  return m;
}

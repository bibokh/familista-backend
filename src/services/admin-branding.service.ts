// Familista — Super Admin White-label Control Panel
// File location: src/services/admin-branding.service.ts
//
// Cross-tenant branding ops: read/update any club's white-label config,
// reset to defaults, manage palette templates (system + custom), apply
// palettes, snapshot/clone configs.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writePlatformAudit } from '../middleware/admin-rbac.middleware';
import { SYSTEM_PALETTES, findPresetBySlug } from '../data/palette-presets';
import type {
  AdminUpsertBrandingInput,
  ApplyPaletteInput,
  CreatePaletteInput,
  UpdatePaletteInput,
} from '../utils/admin.validators';
import type { PlatformActor } from '../types/admin.types';
import type { ColorPaletteTemplate, WhiteLabelConfig } from '@prisma/client';

const CONFIG_INCLUDE: Prisma.WhiteLabelConfigInclude = {
  domains: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
  assets: { where: { isActive: true } },
};

// ─────────────────────────────────────────────────────────────────────────────
// Branding (cross-tenant)
// ─────────────────────────────────────────────────────────────────────────────

export async function adminListConfigs(opts: { search?: string; cursor?: string; limit?: number }) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.search
    ? {
        OR: [
          { club: { name: { contains: opts.search, mode: 'insensitive' as const } } },
          { club: { city: { contains: opts.search, mode: 'insensitive' as const } } },
          { productName: { contains: opts.search, mode: 'insensitive' as const } },
        ],
      }
    : undefined;

  const items = await prisma.whiteLabelConfig.findMany({
    where,
    include: {
      club: { select: { id: true, name: true, city: true, country: true, plan: true } },
      domains: true,
      _count: { select: { assets: true, domains: true, audits: true } },
    },
    orderBy: [{ updatedAt: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function adminGetConfig(clubId: string) {
  const cfg = await prisma.whiteLabelConfig.findUnique({
    where: { clubId },
    include: CONFIG_INCLUDE,
  });
  if (!cfg) {
    return await adminEnsureConfig(clubId);
  }
  return cfg;
}

async function adminEnsureConfig(clubId: string) {
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError('Club not found');

  return await prisma.whiteLabelConfig.create({
    data: { clubId, productName: club.name, isActive: true },
    include: CONFIG_INCLUDE,
  });
}

export async function adminUpsertBranding(
  actor: PlatformActor,
  clubId: string,
  input: AdminUpsertBrandingInput,
) {
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError('Club not found');

  const data: Prisma.WhiteLabelConfigUncheckedUpdateInput = {
    ...input,
    metadata:
      input.metadata === undefined
        ? undefined
        : input.metadata === null
          ? Prisma.JsonNull
          : (input.metadata as Prisma.InputJsonValue),
    updatedBy: actor.userId,
  };

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.whiteLabelConfig.findUnique({ where: { clubId } });

    if (!existing) {
      const created = await tx.whiteLabelConfig.create({
        data: {
          ...(data as Prisma.WhiteLabelConfigUncheckedCreateInput),
          clubId,
          productName: input.productName ?? club.name,
        },
        include: CONFIG_INCLUDE,
      });
      return { config: created, changedFields: Object.keys(input) };
    }

    const updated = await tx.whiteLabelConfig.update({
      where: { clubId },
      data: { ...data, version: { increment: 1 } },
      include: CONFIG_INCLUDE,
    });
    const changedFields: string[] = [];
    const cmp = existing as unknown as Record<string, unknown>;
    const upd = updated as unknown as Record<string, unknown>;
    for (const k of Object.keys(input)) {
      if (JSON.stringify(cmp[k]) !== JSON.stringify(upd[k])) changedFields.push(k);
    }
    return { config: updated, changedFields };
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId,
    action: 'BRANDING_UPDATED',
    category: 'BRANDING',
    resourceType: 'WhiteLabelConfig',
    resourceId: result.config.id,
    metadata: { fields: result.changedFields },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return result.config;
}

export async function adminResetConfig(actor: PlatformActor, clubId: string) {
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError('Club not found');

  const result = await prisma.$transaction(async (tx) => {
    await tx.whiteLabelConfig.deleteMany({ where: { clubId } });
    return await tx.whiteLabelConfig.create({
      data: { clubId, productName: club.name, isActive: true },
      include: CONFIG_INCLUDE,
    });
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId,
    action: 'BRANDING_RESET',
    category: 'BRANDING',
    resourceType: 'WhiteLabelConfig',
    resourceId: result.id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Palettes
// ─────────────────────────────────────────────────────────────────────────────

export async function seedSystemPalettes(actor?: PlatformActor): Promise<number> {
  let count = 0;
  for (const preset of SYSTEM_PALETTES) {
    await prisma.colorPaletteTemplate.upsert({
      where: { slug: preset.slug },
      create: {
        slug: preset.slug,
        name: preset.name,
        description: preset.description,
        isSystem: true,
        category: preset.category,
        tokens: preset.tokens as unknown as Prisma.InputJsonValue,
      },
      update: {
        name: preset.name,
        description: preset.description,
        tokens: preset.tokens as unknown as Prisma.InputJsonValue,
        isSystem: true,
        category: preset.category,
      },
    });
    count++;
  }
  if (actor) {
    await writePlatformAudit({
      adminId: actor.adminId,
      userId: actor.userId,
      action: 'PALETTE_PRESETS_SEEDED',
      category: 'PALETTE',
      metadata: { count },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }
  return count;
}

export async function listPalettes(opts: { category?: string; includeCustom?: boolean } = {}) {
  return await prisma.colorPaletteTemplate.findMany({
    where: {
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.includeCustom === false ? { isSystem: true } : {}),
    },
    orderBy: [{ isSystem: 'desc' }, { usageCount: 'desc' }, { name: 'asc' }],
  });
}

export async function createPalette(
  actor: PlatformActor,
  input: CreatePaletteInput,
): Promise<ColorPaletteTemplate> {
  const conflict = await prisma.colorPaletteTemplate.findUnique({ where: { slug: input.slug } });
  if (conflict) throw new ConflictError(`Palette with slug "${input.slug}" already exists`);

  const created = await prisma.colorPaletteTemplate.create({
    data: {
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      category: input.category ?? 'custom',
      isPublic: input.isPublic ?? true,
      isSystem: false,
      tokens: input.tokens as unknown as Prisma.InputJsonValue,
      preview: input.preview ?? null,
      createdBy: actor.userId,
    },
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    action: 'PALETTE_CREATED',
    category: 'PALETTE',
    resourceType: 'ColorPaletteTemplate',
    resourceId: created.id,
    metadata: { slug: created.slug, name: created.name },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updatePalette(
  actor: PlatformActor,
  id: string,
  input: UpdatePaletteInput,
): Promise<ColorPaletteTemplate> {
  const existing = await prisma.colorPaletteTemplate.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Palette not found');
  if (existing.isSystem) throw new BadRequestError('System palettes cannot be modified');

  if (input.slug && input.slug !== existing.slug) {
    const conflict = await prisma.colorPaletteTemplate.findUnique({ where: { slug: input.slug } });
    if (conflict) throw new ConflictError(`Slug "${input.slug}" is already used`);
  }

  const updated = await prisma.colorPaletteTemplate.update({
    where: { id },
    data: {
      slug: input.slug,
      name: input.name,
      description: input.description ?? undefined,
      category: input.category,
      isPublic: input.isPublic,
      tokens: input.tokens ? (input.tokens as unknown as Prisma.InputJsonValue) : undefined,
      preview: input.preview ?? undefined,
    },
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    action: 'PALETTE_UPDATED',
    category: 'PALETTE',
    resourceType: 'ColorPaletteTemplate',
    resourceId: updated.id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function deletePalette(actor: PlatformActor, id: string): Promise<void> {
  const existing = await prisma.colorPaletteTemplate.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Palette not found');
  if (existing.isSystem) throw new BadRequestError('System palettes cannot be deleted');

  await prisma.colorPaletteTemplate.delete({ where: { id } });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    action: 'PALETTE_DELETED',
    category: 'PALETTE',
    resourceType: 'ColorPaletteTemplate',
    resourceId: id,
    metadata: { slug: existing.slug },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

export async function applyPaletteToClub(
  actor: PlatformActor,
  clubId: string,
  input: ApplyPaletteInput,
) {
  let palette: ColorPaletteTemplate | null = null;
  if (input.paletteId) {
    palette = await prisma.colorPaletteTemplate.findUnique({ where: { id: input.paletteId } });
  } else if (input.paletteSlug) {
    palette = await prisma.colorPaletteTemplate.findUnique({ where: { slug: input.paletteSlug } });
    if (!palette) {
      const preset = findPresetBySlug(input.paletteSlug);
      if (preset) {
        await seedSystemPalettes();
        palette = await prisma.colorPaletteTemplate.findUnique({ where: { slug: preset.slug } });
      }
    }
  }
  if (!palette) throw new NotFoundError('Palette not found');

  const tokens = palette.tokens as unknown as Record<string, string>;
  const required = ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'mutedText', 'border', 'error', 'success', 'warning'];
  for (const k of required) {
    if (typeof tokens[k] !== 'string') {
      throw new BadRequestError(`Palette is missing token "${k}"`);
    }
  }

  const updated = await adminUpsertBranding(actor, clubId, {
    primaryColor: tokens.primary,
    secondaryColor: tokens.secondary,
    accentColor: tokens.accent,
    backgroundColor: tokens.background,
    surfaceColor: tokens.surface,
    textColor: tokens.text,
    mutedTextColor: tokens.mutedText,
    borderColor: tokens.border,
    errorColor: tokens.error,
    successColor: tokens.success,
    warningColor: tokens.warning,
  });

  await prisma.colorPaletteTemplate.update({
    where: { id: palette.id },
    data: { usageCount: { increment: 1 } },
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId,
    action: 'PALETTE_APPLIED',
    category: 'PALETTE',
    resourceType: 'ColorPaletteTemplate',
    resourceId: palette.id,
    metadata: { slug: palette.slug, name: palette.name },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { config: updated, palette };
}

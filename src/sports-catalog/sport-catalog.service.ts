// Familista — Global Sports Catalog (Phase L)
// ─────────────────────────────────────────────────────────────────────────
// Admin-registerable per-sport extensions. The Phase G SportAdapter (in
// code) is the IMMUTABLE CORE. These catalog rows extend it at runtime
// for operators to configure pitch dimensions, ontologies, event kinds.

import { Prisma, SportEventTaxonomy, SportFieldGeometry, SportKind, SportPlugin, SportSpatialRules, TacticalDomain } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError } from '../utils/errors';

export interface CatalogActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ── Sport plugin (catalog entry) ────────────────────────────────────────

export interface PublishPluginDto {
  sport: SportKind;
  code:  string;
  label: string;
}

export async function publishPlugin(actor: CatalogActor, dto: PublishPluginDto): Promise<SportPlugin> {
  if (!dto.sport || !dto.code) throw new BadRequestError('sport + code required');
  return prisma.sportPlugin.upsert({
    where:  { sport_code: { sport: dto.sport, code: dto.code } },
    create: { sport: dto.sport, code: dto.code, label: dto.label, isActive: true, publishedBy: actor.userId },
    update: { label: dto.label, isActive: true, publishedBy: actor.userId },
  });
}

export async function listPlugins(sport?: SportKind): Promise<SportPlugin[]> {
  return prisma.sportPlugin.findMany({
    where: { isActive: true, ...(sport ? { sport } : {}) },
    orderBy: [{ sport: 'asc' }, { code: 'asc' }],
  });
}

// ── Tactical domain ontology ────────────────────────────────────────────

export interface PublishDomainDto {
  sport:       SportKind;
  code:        string;
  label:       string;
  parentCode?: string;
}

export async function publishDomain(_actor: CatalogActor, dto: PublishDomainDto): Promise<TacticalDomain> {
  return prisma.tacticalDomain.upsert({
    where:  { sport_code: { sport: dto.sport, code: dto.code } },
    create: { sport: dto.sport, code: dto.code, label: dto.label, parentCode: dto.parentCode ?? null, isActive: true },
    update: { label: dto.label, parentCode: dto.parentCode ?? null, isActive: true },
  });
}

export async function listDomains(sport?: SportKind): Promise<TacticalDomain[]> {
  return prisma.tacticalDomain.findMany({ where: { isActive: true, ...(sport ? { sport } : {}) }, orderBy: { code: 'asc' } });
}

// ── Field geometry override ─────────────────────────────────────────────

export interface PublishGeometryDto {
  sport:      SportKind;
  pluginCode?: string;
  widthM:     number;
  heightM:    number;
  zones?:     Prisma.InputJsonValue;
  targets?:   Prisma.InputJsonValue;
}

export async function publishGeometry(_actor: CatalogActor, dto: PublishGeometryDto): Promise<SportFieldGeometry> {
  if (!dto.widthM || !dto.heightM) throw new BadRequestError('widthM + heightM required');
  return prisma.sportFieldGeometry.upsert({
    where:  { sport_pluginCode: { sport: dto.sport, pluginCode: dto.pluginCode ?? null } as never },
    create: { sport: dto.sport, pluginCode: dto.pluginCode ?? null, widthM: dto.widthM, heightM: dto.heightM, zones: (dto.zones ?? Prisma.JsonNull) as Prisma.InputJsonValue, targets: (dto.targets ?? Prisma.JsonNull) as Prisma.InputJsonValue, isActive: true },
    update: { widthM: dto.widthM, heightM: dto.heightM, zones: (dto.zones ?? Prisma.JsonNull) as Prisma.InputJsonValue, targets: (dto.targets ?? Prisma.JsonNull) as Prisma.InputJsonValue, isActive: true },
  });
}

// ── Event taxonomy ──────────────────────────────────────────────────────

export interface PublishEventDto {
  sport:      SportKind;
  eventKind:  string;
  polarity:   'OFFENSE' | 'DEFENSE' | 'NEUTRAL';
  scoreDelta?: number;
}

export async function publishEvent(_actor: CatalogActor, dto: PublishEventDto): Promise<SportEventTaxonomy> {
  return prisma.sportEventTaxonomy.upsert({
    where:  { sport_eventKind: { sport: dto.sport, eventKind: dto.eventKind } },
    create: { sport: dto.sport, eventKind: dto.eventKind, polarity: dto.polarity, scoreDelta: dto.scoreDelta ?? 0, isActive: true },
    update: { polarity: dto.polarity, scoreDelta: dto.scoreDelta ?? 0, isActive: true },
  });
}

export async function listEvents(sport?: SportKind): Promise<SportEventTaxonomy[]> {
  return prisma.sportEventTaxonomy.findMany({ where: { isActive: true, ...(sport ? { sport } : {}) }, orderBy: { eventKind: 'asc' } });
}

// ── Spatial rules ───────────────────────────────────────────────────────

export interface PublishSpatialRulesDto {
  sport:      SportKind;
  pluginCode?: string;
  rules:      Prisma.InputJsonValue;
}

export async function publishSpatialRules(_actor: CatalogActor, dto: PublishSpatialRulesDto): Promise<SportSpatialRules> {
  return prisma.sportSpatialRules.upsert({
    where:  { sport_pluginCode: { sport: dto.sport, pluginCode: dto.pluginCode ?? null } as never },
    create: { sport: dto.sport, pluginCode: dto.pluginCode ?? null, rules: dto.rules, isActive: true },
    update: { rules: dto.rules, isActive: true },
  });
}

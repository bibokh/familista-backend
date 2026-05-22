// Familista — Production Monitoring + Backup ledger (Phase O)
// ─────────────────────────────────────────────────────────────────────────
// Append-only health checks, configurable alert rules, backup records.
// Composes with (does not replace) Phase J SystemMetric / RealtimeHealth.

import { AlertRuleState, BackupKind, BackupRecord, HealthCheckState, Prisma, ProductionAlertRule, ProductionHealthCheck } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';

export interface MonActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ── Health checks ───────────────────────────────────────────────────────

export async function recordHealth(args: { service: string; state: HealthCheckState; latencyMs?: number; payload?: Prisma.InputJsonValue }): Promise<ProductionHealthCheck> {
  if (!args.service || !args.state) throw new BadRequestError('service + state required');
  return prisma.productionHealthCheck.create({
    data: { service: args.service, state: args.state, latencyMs: args.latencyMs ?? null, payload: (args.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue },
  });
}

export async function listHealth(opts: { service?: string; state?: HealthCheckState; limit?: number } = {}): Promise<ProductionHealthCheck[]> {
  return prisma.productionHealthCheck.findMany({
    where: { ...(opts.service ? { service: opts.service } : {}), ...(opts.state ? { state: opts.state } : {}) },
    orderBy: { capturedAt: 'desc' },
    take: Math.min(opts.limit ?? 200, 2000),
  });
}

/** Composite snapshot — read on-demand without writing new rows. */
export async function healthSnapshot(): Promise<{
  generatedAt: string;
  services:    Array<{ service: string; state: HealthCheckState; lastSeenAt: string }>;
  recent:      ProductionHealthCheck[];
}> {
  const since = new Date(Date.now() - 5 * 60_000);
  const recent = await prisma.productionHealthCheck.findMany({ where: { capturedAt: { gte: since } }, orderBy: { capturedAt: 'desc' }, take: 200 });
  const byService = new Map<string, ProductionHealthCheck>();
  for (const r of recent) if (!byService.has(r.service)) byService.set(r.service, r);
  return {
    generatedAt: new Date().toISOString(),
    services: [...byService.values()].map((r) => ({ service: r.service, state: r.state, lastSeenAt: r.capturedAt.toISOString() })),
    recent: recent.slice(0, 50),
  };
}

// ── Alert rules ─────────────────────────────────────────────────────────

export interface UpsertAlertRuleDto {
  code:       string;
  label:      string;
  expression: string;
  threshold?: number;
  channelTargets?: Prisma.InputJsonValue;
  global?:    boolean;
}

export async function upsertAlertRule(actor: MonActor, dto: UpsertAlertRuleDto): Promise<ProductionAlertRule> {
  if (!dto.code || !dto.label || !dto.expression) throw new BadRequestError('code + label + expression required');
  if (dto.global && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError('Only SUPER_ADMIN may publish global alert rule');
  return prisma.productionAlertRule.upsert({
    where:  { clubId_code: { clubId: dto.global ? null : actor.clubId, code: dto.code } as never },
    create: {
      clubId:     dto.global ? null : actor.clubId,
      code:       dto.code,
      label:      dto.label,
      expression: dto.expression,
      threshold:  dto.threshold ?? null,
      channelTargets: (dto.channelTargets ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
    update: {
      label:      dto.label,
      expression: dto.expression,
      threshold:  dto.threshold ?? null,
      channelTargets: (dto.channelTargets ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      state:      'ACTIVE',
    },
  });
}

export async function setAlertRuleState(actor: MonActor, id: string, state: AlertRuleState): Promise<ProductionAlertRule> {
  const rule = await prisma.productionAlertRule.findUnique({ where: { id } });
  if (!rule)                                                                      throw new NotFoundError('ProductionAlertRule');
  if (rule.clubId && rule.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.productionAlertRule.update({ where: { id }, data: { state } });
}

export async function listAlertRules(actor: MonActor): Promise<ProductionAlertRule[]> {
  return prisma.productionAlertRule.findMany({
    where: { OR: [{ clubId: actor.clubId }, { clubId: null }] },
    orderBy: [{ clubId: 'asc' }, { code: 'asc' }],
  });
}

// ── Backup records ──────────────────────────────────────────────────────

export interface RecordBackupDto {
  kind:      BackupKind;
  ref?:      string;
  sizeBytes?: number;
  sha256?:   string;
  notes?:    string;
  ok?:       boolean;
  finishedAtIso?: string;
}

export async function recordBackup(actor: MonActor, dto: RecordBackupDto): Promise<BackupRecord> {
  if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'CLUB_ADMIN') throw new ForbiddenError('Backup records require admin role');
  return prisma.backupRecord.create({
    data: {
      kind:       dto.kind ?? 'MANUAL',
      ref:        dto.ref ?? null,
      sizeBytes:  typeof dto.sizeBytes === 'number' ? BigInt(dto.sizeBytes) : null,
      sha256:     dto.sha256 ?? null,
      notes:      dto.notes ?? null,
      ok:         dto.ok ?? true,
      finishedAt: dto.finishedAtIso ? new Date(dto.finishedAtIso) : null,
    },
  });
}

export async function listBackups(opts: { kind?: BackupKind; limit?: number } = {}): Promise<BackupRecord[]> {
  return prisma.backupRecord.findMany({
    where: { ...(opts.kind ? { kind: opts.kind } : {}) },
    orderBy: { startedAt: 'desc' },
    take: Math.min(opts.limit ?? 50, 500),
  });
}

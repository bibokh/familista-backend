// Familista — User Notifications + Reports (Phase O)
// ─────────────────────────────────────────────────────────────────────────
// Per-user notification channels (email/sms/push/in-app/webhook) and
// saved report templates + deterministic report runs. Dispatch adapters
// are not included in Phase O — only the registry + run ledger.

import { createHash } from 'crypto';
import { OpsReportRun, OpsReportTemplate, Prisma, UserNotificationChannel } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface NotifActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const ALLOWED_CHANNELS = new Set(['EMAIL', 'SMS', 'PUSH', 'IN_APP', 'WEBHOOK']);

// ── Channels ────────────────────────────────────────────────────────────

export interface RegisterChannelDto {
  channel:   string;
  target:    string;
  preferences?: Prisma.InputJsonValue;
}

export async function registerChannel(actor: NotifActor, dto: RegisterChannelDto): Promise<UserNotificationChannel> {
  if (!dto.channel || !dto.target) throw new BadRequestError('channel + target required');
  if (!ALLOWED_CHANNELS.has(dto.channel.toUpperCase())) throw new BadRequestError(`channel must be one of ${[...ALLOWED_CHANNELS].join(', ')}`);
  return prisma.userNotificationChannel.upsert({
    where:  { userId_channel_target: { userId: actor.userId, channel: dto.channel.toUpperCase(), target: dto.target } },
    create: { userId: actor.userId, channel: dto.channel.toUpperCase(), target: dto.target, preferences: (dto.preferences ?? Prisma.JsonNull) as Prisma.InputJsonValue },
    update: { preferences: (dto.preferences ?? Prisma.JsonNull) as Prisma.InputJsonValue, isActive: true },
  });
}

export async function listChannels(actor: NotifActor): Promise<UserNotificationChannel[]> {
  return prisma.userNotificationChannel.findMany({ where: { userId: actor.userId }, orderBy: { createdAt: 'desc' } });
}

export async function deactivateChannel(actor: NotifActor, id: string): Promise<UserNotificationChannel> {
  const c = await prisma.userNotificationChannel.findUnique({ where: { id } });
  if (!c)                                                       throw new NotFoundError('UserNotificationChannel');
  if (c.userId !== actor.userId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.userNotificationChannel.update({ where: { id }, data: { isActive: false } });
}

// ── Report templates ────────────────────────────────────────────────────

export interface PublishTemplateDto {
  code:       string;
  label:      string;
  definition: Prisma.InputJsonValue;
  global?:    boolean;
}

export async function publishTemplate(actor: NotifActor, dto: PublishTemplateDto): Promise<OpsReportTemplate> {
  if (!dto.code || !dto.label || dto.definition === undefined) throw new BadRequestError('code + label + definition required');
  if (dto.global && actor.role !== 'SUPER_ADMIN')              throw new ForbiddenError('Only SUPER_ADMIN may publish global templates');
  return prisma.opsReportTemplate.upsert({
    where:  { clubId_code: { clubId: dto.global ? null : actor.clubId, code: dto.code } as never },
    create: { clubId: dto.global ? null : actor.clubId, code: dto.code, label: dto.label, definition: dto.definition, publishedBy: actor.userId },
    update: { label: dto.label, definition: dto.definition, isActive: true, publishedBy: actor.userId },
  });
}

export async function listTemplates(actor: NotifActor): Promise<OpsReportTemplate[]> {
  return prisma.opsReportTemplate.findMany({
    where: { isActive: true, OR: [{ clubId: actor.clubId }, { clubId: null }] },
    orderBy: [{ clubId: 'asc' }, { code: 'asc' }],
  });
}

// ── Report runs (deterministic; results hashed for replay) ──────────────

export interface RunReportDto {
  templateId: string;
  parameters: Prisma.InputJsonValue;
  /** Caller-computed output blob — the engine that produces it is deterministic. */
  output:     Prisma.InputJsonValue;
}

export async function recordRun(actor: NotifActor, dto: RunReportDto): Promise<OpsReportRun> {
  if (!dto.templateId || dto.output === undefined) throw new BadRequestError('templateId + output required');
  // Verify template visibility.
  const tpl = await prisma.opsReportTemplate.findUnique({ where: { id: dto.templateId }, select: { clubId: true, isActive: true } });
  if (!tpl || !tpl.isActive)                                                              throw new NotFoundError('OpsReportTemplate');
  if (tpl.clubId && tpl.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')          throw new ForbiddenError();
  const canonical = JSON.stringify(dto.output);
  const outputHash = createHash('sha256').update(canonical).digest('hex');
  const row = await prisma.opsReportRun.create({
    data: {
      clubId:     actor.clubId,
      templateId: dto.templateId,
      parameters: dto.parameters,
      output:     dto.output,
      outputHash,
      finishedAt: new Date(),
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'REPORT_RUN_RECORDED', entityType: 'OpsReportRun', entityId: row.id,
    payload: { templateId: dto.templateId, outputHash },
  });
  return row;
}

export async function listRuns(actor: NotifActor, templateId?: string, limit = 50): Promise<OpsReportRun[]> {
  return prisma.opsReportRun.findMany({
    where: { clubId: actor.clubId, ...(templateId ? { templateId } : {}) },
    orderBy: { startedAt: 'desc' },
    take: Math.min(limit, 500),
  });
}

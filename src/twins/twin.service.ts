// Familista — Organization Digital Twin services (Phase M)
// ─────────────────────────────────────────────────────────────────────────
// 5 snapshot tables capturing organisation state at a point in time.
// All append-only. Replay-safe (server-set `capturedAt`, no mutation).

import { AcademyTwin, ClubTwin, DepartmentTwin, OrganizationTwin, Prisma, StaffTwin } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface TwinActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ── Organization (root) ─────────────────────────────────────────────────

export async function captureOrgTwin(actor: TwinActor, snapshot: Prisma.InputJsonValue): Promise<OrganizationTwin> {
  if (snapshot === undefined) throw new BadRequestError('snapshot required');
  const row = await prisma.organizationTwin.create({
    data: { clubId: actor.clubId, snapshot },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'ORG_TWIN_CAPTURED', entityType: 'OrganizationTwin', entityId: row.id,
    payload: { capturedAt: row.capturedAt },
  });
  return row;
}

export async function listOrgTwins(actor: TwinActor, limit = 50): Promise<OrganizationTwin[]> {
  return prisma.organizationTwin.findMany({
    where: { clubId: actor.clubId },
    orderBy: { capturedAt: 'desc' },
    take: Math.min(limit, 500),
  });
}

export async function latestOrgTwin(actor: TwinActor): Promise<OrganizationTwin | null> {
  return prisma.organizationTwin.findFirst({
    where: { clubId: actor.clubId },
    orderBy: { capturedAt: 'desc' },
  });
}

// ── Club (detailed) ─────────────────────────────────────────────────────

export interface CaptureClubTwinDto {
  sportingState?:  Prisma.InputJsonValue;
  financialState?: Prisma.InputJsonValue;
  staffingState?:  Prisma.InputJsonValue;
  hardwareState?:  Prisma.InputJsonValue;
  playerState?:    Prisma.InputJsonValue;
  trainingState?:  Prisma.InputJsonValue;
}

export async function captureClubTwin(actor: TwinActor, dto: CaptureClubTwinDto): Promise<ClubTwin> {
  return prisma.clubTwin.create({
    data: {
      clubId:         actor.clubId,
      sportingState:  (dto.sportingState  ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      financialState: (dto.financialState ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      staffingState:  (dto.staffingState  ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      hardwareState:  (dto.hardwareState  ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      playerState:    (dto.playerState    ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      trainingState:  (dto.trainingState  ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function latestClubTwin(actor: TwinActor): Promise<ClubTwin | null> {
  return prisma.clubTwin.findFirst({ where: { clubId: actor.clubId }, orderBy: { capturedAt: 'desc' } });
}

// ── Academy / Department / Staff ────────────────────────────────────────

export interface CaptureAcademyTwinDto {
  academyName:       string;
  ageGroups?:        Prisma.InputJsonValue;
  playerCount?:      number;
  staffCount?:       number;
  performanceScore?: number;
  financialFlow?:    Prisma.InputJsonValue;
}

export async function captureAcademyTwin(actor: TwinActor, dto: CaptureAcademyTwinDto): Promise<AcademyTwin> {
  if (!dto.academyName) throw new BadRequestError('academyName required');
  return prisma.academyTwin.create({
    data: {
      clubId:          actor.clubId,
      academyName:     dto.academyName,
      ageGroups:       (dto.ageGroups ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      playerCount:     dto.playerCount ?? 0,
      staffCount:      dto.staffCount ?? 0,
      performanceScore: dto.performanceScore ?? 0,
      financialFlow:   (dto.financialFlow ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export interface CaptureDepartmentTwinDto {
  department:  string;
  headStaffId?: string;
  payload:     Prisma.InputJsonValue;
}

export async function captureDepartmentTwin(actor: TwinActor, dto: CaptureDepartmentTwinDto): Promise<DepartmentTwin> {
  if (!dto.department || dto.payload === undefined) throw new BadRequestError('department + payload required');
  return prisma.departmentTwin.create({
    data: { clubId: actor.clubId, department: dto.department, headStaffId: dto.headStaffId ?? null, payload: dto.payload },
  });
}

export interface CaptureStaffTwinDto {
  staffUserId?: string;
  staffKind:    string;
  payload:      Prisma.InputJsonValue;
}

export async function captureStaffTwin(actor: TwinActor, dto: CaptureStaffTwinDto): Promise<StaffTwin> {
  if (!dto.staffKind || dto.payload === undefined) throw new BadRequestError('staffKind + payload required');
  return prisma.staffTwin.create({
    data: { clubId: actor.clubId, staffUserId: dto.staffUserId ?? null, staffKind: dto.staffKind, payload: dto.payload },
  });
}

export async function listTwins(actor: TwinActor): Promise<{
  org:        OrganizationTwin | null;
  club:       ClubTwin | null;
  academies:  AcademyTwin[];
  departments: DepartmentTwin[];
  staff:      StaffTwin[];
}> {
  const [org, club, academies, departments, staff] = await Promise.all([
    latestOrgTwin(actor),
    latestClubTwin(actor),
    prisma.academyTwin.findMany({ where: { clubId: actor.clubId }, orderBy: { capturedAt: 'desc' }, take: 20 }),
    prisma.departmentTwin.findMany({ where: { clubId: actor.clubId }, orderBy: { capturedAt: 'desc' }, take: 20 }),
    prisma.staffTwin.findMany({ where: { clubId: actor.clubId }, orderBy: { capturedAt: 'desc' }, take: 100 }),
  ]);
  return { org, club, academies, departments, staff };
}

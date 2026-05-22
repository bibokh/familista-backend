// Familista — Biomechanical + Biochemical expansion (Phase L)
// ─────────────────────────────────────────────────────────────────────────
// Derived metric writers + pure-function estimators. Sources:
//   - Phase K BiomechanicalPacket (lactate, glucose, hydration, cortisol)
//   - Phase B SensorPacket (HR, IMU)
//   - Phase G SpatialFrame (movement, sprints)
//
// All deterministic. All `detectorVersion = "l1"`. All append-only.

import { BiochemicalSignal, HydrationEstimate, NeuromuscularLoad, Prisma, StressIndex, TendonRiskEstimate } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';

export interface BiochemActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const VERSION = 'l1';

// ── Generic biochem signal writer ───────────────────────────────────────

export interface RecordSignalDto {
  playerId?:       string | null;
  matchId?:        string | null;
  kind:            string;             // SWEAT / GLUCOSE / LACTATE / CORTISOL / …
  value:           number;
  unit?:           string;
  monotonicMs?:    number;
  sourceDeviceId?: string | null;
}

export async function recordBiochemSignal(actor: BiochemActor, dto: RecordSignalDto): Promise<BiochemicalSignal> {
  return prisma.biochemicalSignal.create({
    data: {
      clubId:         actor.clubId,
      playerId:       dto.playerId ?? null,
      matchId:        dto.matchId ?? null,
      kind:           dto.kind,
      value:          dto.value,
      unit:           dto.unit ?? null,
      monotonicMs:    BigInt(dto.monotonicMs ?? Date.now()),
      sourceDeviceId: dto.sourceDeviceId ?? null,
      detectorVersion: VERSION,
    },
  });
}

export async function listBiochemSignals(actor: BiochemActor, opts: { playerId?: string; matchId?: string; kind?: string; limit?: number } = {}): Promise<BiochemicalSignal[]> {
  return prisma.biochemicalSignal.findMany({
    where: {
      clubId: actor.clubId,
      ...(opts.playerId ? { playerId: opts.playerId } : {}),
      ...(opts.matchId  ? { matchId: opts.matchId } : {}),
      ...(opts.kind     ? { kind: opts.kind } : {}),
    },
    orderBy: { monotonicMs: 'desc' },
    take:    Math.min(opts.limit ?? 200, 2000),
  });
}

// ── Hydration estimate ──────────────────────────────────────────────────

export interface RecordHydrationDto {
  playerId:   string;
  matchId?:   string | null;
  estimatePct: number;
  components?: Prisma.InputJsonValue;
}

export async function recordHydration(actor: BiochemActor, dto: RecordHydrationDto): Promise<HydrationEstimate> {
  return prisma.hydrationEstimate.create({
    data: {
      clubId:      actor.clubId,
      playerId:    dto.playerId,
      matchId:     dto.matchId ?? null,
      monotonicMs: BigInt(Date.now()),
      estimatePct: Math.max(0, Math.min(100, dto.estimatePct)),
      components:  (dto.components ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      detectorVersion: VERSION,
    },
  });
}

// Pure-function: hydrationFromSweat + intake (l1)
//   estimate = startingPct - α·sweatLoss + β·intake
export function hydrationEstimate(input: { startingPct: number; sweatLossMl: number; intakeMl: number }): { value: number; version: string } {
  const alpha = 0.05, beta = 0.04;
  const v = input.startingPct - alpha * input.sweatLossMl + beta * input.intakeMl;
  return { value: Number(Math.max(0, Math.min(100, v)).toFixed(2)), version: VERSION };
}

// ── Stress index ────────────────────────────────────────────────────────

export interface RecordStressDto {
  playerId:    string;
  matchId?:    string | null;
  index:       number;
  components?: Prisma.InputJsonValue;
}

export async function recordStress(actor: BiochemActor, dto: RecordStressDto): Promise<StressIndex> {
  return prisma.stressIndex.create({
    data: {
      clubId:      actor.clubId,
      playerId:    dto.playerId,
      matchId:     dto.matchId ?? null,
      monotonicMs: BigInt(Date.now()),
      index:       Math.max(0, Math.min(1, dto.index)),
      components:  (dto.components ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      detectorVersion: VERSION,
    },
  });
}

// Pure-function: stressIndex from cortisol + HRV + sleepDeficit
export function stressIndex(input: { cortisolProxy: number; hrvMs: number; sleepDeficitH: number }): { value: number; version: string } {
  const cortisolNorm = Math.max(0, Math.min(1, input.cortisolProxy / 30));     // 30 = saturated proxy
  const hrvNorm      = Math.max(0, Math.min(1, 1 - input.hrvMs / 80));         // lower HRV = more stress
  const sleepNorm    = Math.max(0, Math.min(1, input.sleepDeficitH / 4));
  const v = 0.5 * cortisolNorm + 0.3 * hrvNorm + 0.2 * sleepNorm;
  return { value: Number(v.toFixed(3)), version: VERSION };
}

// ── Neuromuscular load ──────────────────────────────────────────────────

export interface RecordLoadDto {
  playerId:    string;
  matchId?:    string | null;
  load:        number;
  asymmetry?:  number;
  components?: Prisma.InputJsonValue;
}

export async function recordLoad(actor: BiochemActor, dto: RecordLoadDto): Promise<NeuromuscularLoad> {
  return prisma.neuromuscularLoad.create({
    data: {
      clubId:      actor.clubId,
      playerId:    dto.playerId,
      matchId:     dto.matchId ?? null,
      monotonicMs: BigInt(Date.now()),
      load:        Math.max(0, dto.load),
      asymmetry:   dto.asymmetry ?? null,
      components:  (dto.components ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      detectorVersion: VERSION,
    },
  });
}

// Pure: NM load = α · accelMagIntegral + β · sprintCount + γ · asymmetry
export function neuromuscularLoad(input: { accelMagIntegral: number; sprintCount: number; asymmetry: number }): { value: number; version: string } {
  const alpha = 0.5, beta = 0.3, gamma = 0.2;
  const v = alpha * Math.log10(1 + input.accelMagIntegral)
          + beta  * Math.min(1, input.sprintCount / 30)
          + gamma * Math.max(0, Math.min(1, input.asymmetry));
  return { value: Number(v.toFixed(3)), version: VERSION };
}

// ── Tendon risk ─────────────────────────────────────────────────────────

export interface RecordTendonRiskDto {
  playerId:    string;
  matchId?:    string | null;
  risk:        number;
  region?:     string;
  components?: Prisma.InputJsonValue;
}

export async function recordTendonRisk(actor: BiochemActor, dto: RecordTendonRiskDto): Promise<TendonRiskEstimate> {
  return prisma.tendonRiskEstimate.create({
    data: {
      clubId:      actor.clubId,
      playerId:    dto.playerId,
      matchId:     dto.matchId ?? null,
      monotonicMs: BigInt(Date.now()),
      risk:        Math.max(0, Math.min(1, dto.risk)),
      region:      dto.region ?? null,
      components:  (dto.components ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      detectorVersion: VERSION,
    },
  });
}

// Pure: tendon risk from load history + asymmetry + recovery
export function tendonRisk(input: { load: number; asymmetry: number; recoveryH: number; priorInjuries: number }): { value: number; version: string } {
  const v = Math.max(0, Math.min(1,
    0.40 * Math.min(1, input.load)
  + 0.25 * Math.max(0, Math.min(1, input.asymmetry))
  + 0.20 * Math.max(0, Math.min(1, 1 - input.recoveryH / 48))
  + 0.15 * Math.min(1, input.priorInjuries / 3)));
  return { value: Number(v.toFixed(3)), version: VERSION };
}

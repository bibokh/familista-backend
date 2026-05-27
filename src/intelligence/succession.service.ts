// Familista — Position Succession Planning (Phase 11)
// Target: src/intelligence/succession.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Identifies which squad players can cover a given position and generates a
// squad-level future-planning report covering age curves, contract cliffs,
// and succession coverage gaps.

import { prisma } from '../config/database';
import { getPositionCompatibility } from './tactical-matrix.service';
import { ageDecayFactor } from './shared.utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SuccessionActor {
  userId: string;
  clubId: string;
}

export interface SuccessionCandidate {
  playerId:       string;
  firstName:      string;
  lastName:       string;
  position:       string | null;
  age:            number | null;
  compatibility:  number;       // 0–100 positional fit for the target position
  ageDecay:       number;       // 0–1 future-value multiplier
  contractExpiry: string | null;  // ISO date
  isPrimary:      boolean;      // exact position match
}

export interface PositionGroupPlan {
  group:              string;
  currentCount:       number;
  avgAge:             number | null;
  expiringCount:      number;   // contracts expiring within 2 years
  successionCoverage: number;   // 0–100
  atRisk:             boolean;
}

export interface SquadFuturePlan {
  generatedAt:    string;
  positionPlans:  PositionGroupPlan[];
  overallHealth:  number;   // 0–100 weighted average of succession coverage
  criticalAlerts: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const POS_GROUP: Readonly<Record<string, string>> = {
  GK: 'GK',
  DC: 'DEF', DL: 'DEF', DR: 'DEF',
  DMC: 'MID_D',
  MC: 'MID_C', ML: 'MID_C', MR: 'MID_C',
  AMC: 'MID_A', AML: 'MID_A', AMR: 'MID_A',
  ST: 'ATT',
};

function _age(dob: Date | null): number | null {
  if (!dob) return null;
  return Math.floor((Date.now() - dob.getTime()) / (365.25 * 86_400_000));
}

// ─── getSuccessionCandidates ──────────────────────────────────────────────────

/**
 * Returns current squad players who can cover the given target position.
 * Filters to compatibility ≥ 40; sorts by: primary first, then compatibility
 * desc, then age asc (youngest is the best long-term successor).
 */
export async function getSuccessionCandidates(
  actor: SuccessionActor,
  targetPosition: string,
): Promise<SuccessionCandidate[]> {
  const players = await prisma.player.findMany({
    where: { clubId: actor.clubId },
    select: {
      id: true, firstName: true, lastName: true, position: true, dateOfBirth: true,
      contractStatus: { select: { contractExpiry: true } },
    },
  });

  const candidates: SuccessionCandidate[] = players.map((p) => {
    const age          = _age(p.dateOfBirth);
    const compatibility = getPositionCompatibility(p.position, targetPosition);
    const expiry       = p.contractStatus?.contractExpiry ?? null;

    return {
      playerId:       p.id,
      firstName:      p.firstName,
      lastName:       p.lastName,
      position:       p.position,
      age,
      compatibility,
      ageDecay:       ageDecayFactor(age ?? 25),
      contractExpiry: expiry ? expiry.toISOString() : null,
      isPrimary:      p.position === targetPosition,
    };
  });

  return candidates
    .filter((c) => c.compatibility >= 40)
    .sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      if (b.compatibility !== a.compatibility) return b.compatibility - a.compatibility;
      return (a.age ?? 99) - (b.age ?? 99);
    });
}

// ─── getSquadFuturePlan ───────────────────────────────────────────────────────

/**
 * Generates a squad-level succession / future-planning report.
 * Per position group:
 *   • Current player count
 *   • Average age
 *   • Contracts expiring within 2 years
 *   • Succession coverage (proportion of under-26 players in the group)
 *   • At-risk flag
 */
export async function getSquadFuturePlan(
  actor: SuccessionActor,
): Promise<SquadFuturePlan> {
  const today    = new Date();
  const twoYears = new Date(today.getFullYear() + 2, today.getMonth(), today.getDate());

  const players = await prisma.player.findMany({
    where: { clubId: actor.clubId },
    select: {
      id: true, position: true, dateOfBirth: true,
      contractStatus: { select: { contractExpiry: true } },
    },
  });

  // Group players by POS_GROUP
  const groups: Map<string, typeof players> = new Map();
  for (const p of players) {
    const g = (p.position ? POS_GROUP[p.position] : null) ?? 'UNKNOWN';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(p);
  }
  groups.delete('UNKNOWN');

  const positionPlans: PositionGroupPlan[] = [];

  for (const [group, groupPlayers] of groups) {
    const ages = groupPlayers
      .map((p) => _age(p.dateOfBirth))
      .filter((a): a is number => a !== null);
    const avgAge = ages.length
      ? +(ages.reduce((s, a) => s + a, 0) / ages.length).toFixed(1)
      : null;

    const expiringCount = groupPlayers.filter((p) => {
      const ct = p.contractStatus;
      return ct && ct.contractExpiry <= twoYears;
    }).length;

    // Succession coverage: ratio of under-26 players + depth bonus
    const u26 = groupPlayers.filter((p) => (_age(p.dateOfBirth) ?? 99) < 26).length;
    const depthBonus = groupPlayers.length >= 3 ? 20 : groupPlayers.length === 2 ? 10 : 0;
    const successionCoverage = Math.min(
      100,
      Math.round((groupPlayers.length > 0 ? (u26 / groupPlayers.length) * 80 : 0) + depthBonus),
    );

    const atRisk =
      groupPlayers.length < 2 ||
      (avgAge !== null && avgAge > 30) ||
      expiringCount > 1;

    positionPlans.push({
      group,
      currentCount:       groupPlayers.length,
      avgAge,
      expiringCount,
      successionCoverage,
      atRisk,
    });
  }

  // Sort: at-risk first, then lowest succession coverage
  positionPlans.sort((a, b) => {
    if (a.atRisk !== b.atRisk) return a.atRisk ? -1 : 1;
    return a.successionCoverage - b.successionCoverage;
  });

  const overallHealth = positionPlans.length
    ? Math.round(
        positionPlans.reduce((s, p) => s + p.successionCoverage, 0) /
          positionPlans.length,
      )
    : 50;

  const criticalAlerts: string[] = [];
  for (const plan of positionPlans) {
    if (plan.currentCount < 2)
      criticalAlerts.push(`${plan.group}: only ${plan.currentCount} player(s) — critical depth shortage`);
    if (plan.expiringCount > 1)
      criticalAlerts.push(`${plan.group}: ${plan.expiringCount} contracts expire within 2 years`);
    if (plan.avgAge !== null && plan.avgAge > 31)
      criticalAlerts.push(`${plan.group}: avg age ${plan.avgAge} — ageing group, succession needed`);
  }

  return {
    generatedAt:    today.toISOString(),
    positionPlans,
    overallHealth,
    criticalAlerts,
  };
}

// Familista — Tactical Compatibility Matrix (Phase 11)
// Target: src/intelligence/tactical-matrix.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pure deterministic service — no database calls.
// Maps player positions to formation slots using a position-group compatibility
// matrix. Reusable across unified intelligence and succession services.

// ─── Formation registry ───────────────────────────────────────────────────────

export interface Formation {
  name:  string;
  slots: string[];   // canonical positions repeated for each player slot
}

/** Six common professional formations. */
export const FORMATIONS: ReadonlyArray<Formation> = [
  { name: '4-3-3',   slots: ['GK','DL','DC','DC','DR','MC','MC','MC','AML','ST','AMR'] },
  { name: '4-4-2',   slots: ['GK','DL','DC','DC','DR','ML','MC','MC','MR','ST','ST'] },
  { name: '4-2-3-1', slots: ['GK','DL','DC','DC','DR','DMC','DMC','AML','AMC','AMR','ST'] },
  { name: '3-5-2',   slots: ['GK','DC','DC','DC','ML','MC','DMC','MC','MR','ST','ST'] },
  { name: '4-5-1',   slots: ['GK','DL','DC','DC','DR','ML','MC','DMC','MC','MR','ST'] },
  { name: '5-3-2',   slots: ['GK','DL','DC','DC','DC','DR','MC','MC','MC','ST','ST'] },
];

// ─── Position groups ──────────────────────────────────────────────────────────

/** Mirrors POS_GROUP from scoring.service — independent copy so this module has no circular dep. */
const POS_GROUP: Readonly<Record<string, string>> = {
  GK: 'GK',
  DC: 'DEF', DL: 'DEF', DR: 'DEF',
  DMC: 'MID_D',
  MC: 'MID_C', ML: 'MID_C', MR: 'MID_C',
  AMC: 'MID_A', AML: 'MID_A', AMR: 'MID_A',
  ST: 'ATT',
};

/** Groups that are tactically adjacent (can fill in an emergency). */
const ADJACENT: Readonly<Record<string, ReadonlyArray<string>>> = {
  GK:    [],
  DEF:   ['MID_D'],
  MID_D: ['DEF', 'MID_C'],
  MID_C: ['MID_D', 'MID_A'],
  MID_A: ['MID_C', 'ATT'],
  ATT:   ['MID_A'],
};

// ─── Compatibility scoring ────────────────────────────────────────────────────

/**
 * Returns 0–100 positional compatibility between a player's position and a
 * formation slot:
 *   100 — exact position match
 *    70 — same position group (e.g. MC filling ML)
 *    40 — adjacent group (e.g. DMC filling MC)
 *    10 — incompatible (e.g. GK at ST)
 *    30 — unknown position (defensive neutral value)
 */
export function getPositionCompatibility(
  playerPos: string | null | undefined,
  slotPos: string,
): number {
  if (!playerPos) return 30;
  if (playerPos === slotPos) return 100;

  const pGroup = POS_GROUP[playerPos] ?? null;
  const sGroup = POS_GROUP[slotPos]   ?? null;
  if (!pGroup || !sGroup) return 15;
  if (pGroup === sGroup)  return 70;
  if ((ADJACENT[pGroup] ?? []).includes(sGroup)) return 40;
  return 10;
}

// ─── Formation compatibility matrix ──────────────────────────────────────────

export interface SlotCompatibility {
  slot:          string;
  compatibility: number;
}

export interface FormationCompatibility {
  formation:         string;
  slots:             SlotCompatibility[];
  bestSlot:          string;
  bestCompatibility: number;
}

/**
 * Returns compatibility of a given player position across all registered
 * formations, listing the best slot in each formation.
 */
export function getTacticalCompatibilityMatrix(
  playerPos: string | null | undefined,
): FormationCompatibility[] {
  return FORMATIONS.map((f) => {
    const slots: SlotCompatibility[] = f.slots.map((slot) => ({
      slot,
      compatibility: getPositionCompatibility(playerPos, slot),
    }));

    const best = slots.reduce(
      (b, s) => (s.compatibility > b.compatibility ? s : b),
      { slot: '', compatibility: 0 },
    );

    return {
      formation:         f.name,
      slots,
      bestSlot:          best.slot,
      bestCompatibility: best.compatibility,
    };
  });
}

/**
 * Returns the single best (formation, slot) pair for a player position.
 */
export function getBestFormationSlot(
  playerPos: string | null | undefined,
): { formation: string; slot: string; score: number } {
  return getTacticalCompatibilityMatrix(playerPos).reduce(
    (best, f) =>
      f.bestCompatibility > best.score
        ? { formation: f.formation, slot: f.bestSlot, score: f.bestCompatibility }
        : best,
    { formation: '', slot: '', score: 0 },
  );
}

/**
 * Returns a compact compatibility summary suitable for JSON responses:
 * per formation → best slot + score only (not full slot list).
 */
export function getCompactCompatibilityMatrix(
  playerPos: string | null | undefined,
): Array<{ formation: string; bestSlot: string; bestCompatibility: number }> {
  return getTacticalCompatibilityMatrix(playerPos).map(({ formation, bestSlot, bestCompatibility }) => ({
    formation,
    bestSlot,
    bestCompatibility,
  }));
}

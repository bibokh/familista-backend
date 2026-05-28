// tests/live-intelligence.unit.test.ts
// Phase 15 — Pure unit tests for Live Match Intelligence
// No DB, no network. Tests: computePlayerRating, computeFatigueIndex, buildDominanceSeries.

import {
  computePlayerRating,
  computeFatigueIndex,
  buildDominanceSeries,
} from '../src/live-intelligence/live-intelligence.service';

// ── computePlayerRating ───────────────────────────────────────────────────────

describe('computePlayerRating — base', () => {
  const base = {
    goals: 0, assists: 0, shotsOnTarget: 0, xa: 0,
    foulsCommitted: 0, yellowCards: 0, redCards: 0,
    tackles: 0, tacklesWon: 0, passes: 0, passAccuracy: 70, minutesPlayed: 90,
  };

  it('returns 6.0 for a zero-stat 90-min appearance', () => {
    expect(computePlayerRating(base)).toBe(6.0);
  });

  it('adds 1.5 per goal', () => {
    expect(computePlayerRating({ ...base, goals: 2 })).toBe(9.0);
  });

  it('adds 1.0 per assist', () => {
    expect(computePlayerRating({ ...base, assists: 1 })).toBe(7.0);
  });

  it('adds 0.15 per shot on target', () => {
    expect(computePlayerRating({ ...base, shotsOnTarget: 2 })).toBeCloseTo(6.3, 1);
  });

  it('deducts 0.5 per yellow card', () => {
    expect(computePlayerRating({ ...base, yellowCards: 1 })).toBe(5.5);
  });

  it('deducts 2.0 per red card', () => {
    expect(computePlayerRating({ ...base, redCards: 1 })).toBe(4.0);
  });

  it('deducts 0.1 per foul committed', () => {
    expect(computePlayerRating({ ...base, foulsCommitted: 3 })).toBeCloseTo(5.7, 1);
  });

  it('adds tackle win bonus when tackles > 0', () => {
    const r = computePlayerRating({ ...base, tackles: 4, tacklesWon: 4 });
    expect(r).toBeCloseTo(6.5, 1);
  });

  it('clamps at 10.0 — hat-trick + assist', () => {
    expect(computePlayerRating({ ...base, goals: 3, assists: 1 })).toBe(10.0);
  });

  it('clamps at 1.0 — red card + multiple fouls', () => {
    const r = computePlayerRating({ ...base, redCards: 2, foulsCommitted: 5, yellowCards: 2 });
    expect(r).toBe(1.0);
  });

  it('applies pass accuracy bonus for passes > 5', () => {
    // passAccuracy 70 → no bonus; 80 → +0.1
    const r70 = computePlayerRating({ ...base, passes: 10, passAccuracy: 70 });
    const r80 = computePlayerRating({ ...base, passes: 10, passAccuracy: 80 });
    expect(r80).toBeGreaterThan(r70);
  });

  it('caps rating at 6.5 for fewer than 15 minutes played', () => {
    const r = computePlayerRating({ ...base, minutesPlayed: 5 });
    expect(r).toBeLessThanOrEqual(6.5);
  });

  it('xa contributes positively', () => {
    const r = computePlayerRating({ ...base, xa: 0.5 });
    expect(r).toBeGreaterThan(6.0);
  });
});

// ── computeFatigueIndex ───────────────────────────────────────────────────────

describe('computeFatigueIndex', () => {
  it('returns 0 for a player with 0 minutes', () => {
    expect(computeFatigueIndex(0, 0, 0, null)).toBe(0);
  });

  it('returns ~85 for exactly 90 minutes, no pressure issues, no ACWR', () => {
    expect(computeFatigueIndex(90, 10, 10, null)).toBe(85);
  });

  it('adds 8 for poor pressure success (<40%)', () => {
    const withGoodPressure = computeFatigueIndex(90, 10, 8, null);  // 80% — no drain
    const withBadPressure  = computeFatigueIndex(90, 10, 3, null);  // 30% — drain
    expect(withBadPressure).toBe(withGoodPressure + 8);
  });

  it('adds 12 for ACWR > 1.3', () => {
    const base = computeFatigueIndex(60, 0, 0, null);
    const high = computeFatigueIndex(60, 0, 0, 1.4);
    expect(high - base).toBe(12);
  });

  it('adds 20 for ACWR > 1.5', () => {
    const base = computeFatigueIndex(60, 0, 0, null);
    const high = computeFatigueIndex(60, 0, 0, 1.6);
    expect(high - base).toBe(20);
  });

  it('clamps at 100', () => {
    expect(computeFatigueIndex(90, 10, 0, 2.0)).toBe(100);
  });

  it('treats pressures=0 as 100% success rate (no drain)', () => {
    const a = computeFatigueIndex(45, 0, 0, null);
    const b = computeFatigueIndex(45, 0, 0, null);
    expect(a).toBe(b);
  });

  it('returns proportional value for 45 minutes', () => {
    const fi = computeFatigueIndex(45, 0, 0, null);
    expect(fi).toBe(Math.round((45 / 90) * 85));
  });
});

// ── buildDominanceSeries ──────────────────────────────────────────────────────

describe('buildDominanceSeries — empty / edge cases', () => {
  it('returns empty array for maxMinute=0', () => {
    expect(buildDominanceSeries([], 0)).toEqual([]);
  });

  it('returns empty array for negative maxMinute', () => {
    expect(buildDominanceSeries([], -5)).toEqual([]);
  });

  it('returns one bin for maxMinute=5', () => {
    const result = buildDominanceSeries([], 5);
    expect(result).toHaveLength(1);
    expect(result[0].homeScore).toBe(50);
  });

  it('returns correct number of 5-min bins for a 45-min half', () => {
    const result = buildDominanceSeries([], 45);
    expect(result).toHaveLength(9);
  });
});

describe('buildDominanceSeries — home events', () => {
  it('GOAL by HOME increases homeScore above 50', () => {
    const result = buildDominanceSeries(
      [{ occurredAtMin: 2, kind: 'GOAL', side: 'HOME' }],
      10,
    );
    expect(result[0].homeScore).toBeGreaterThan(50);
  });

  it('GOAL by AWAY decreases homeScore below 50', () => {
    const result = buildDominanceSeries(
      [{ occurredAtMin: 2, kind: 'GOAL', side: 'AWAY' }],
      10,
    );
    expect(result[0].homeScore).toBeLessThan(50);
  });

  it('neutral events (no weight) do not change score', () => {
    const result = buildDominanceSeries(
      [{ occurredAtMin: 2, kind: 'TACTICAL_NOTE', side: 'HOME' }],
      10,
    );
    expect(result[0].homeScore).toBe(50);
  });

  it('assigns events to the correct bin', () => {
    const result = buildDominanceSeries(
      [{ occurredAtMin: 12, kind: 'GOAL', side: 'HOME' }],
      20,
    );
    // minute 12 → bin index 2 (12/5 = 2.4, floor = 2)
    expect(result[0].homeScore).toBe(50); // bin 0: 0–5
    expect(result[1].homeScore).toBe(50); // bin 1: 5–10
    expect(result[2].homeScore).toBeGreaterThan(50); // bin 2: 10–15
  });

  it('clamps homeScore to [0, 100]', () => {
    const manyGoals = Array.from({ length: 10 }, (_, i) => ({
      occurredAtMin: 0, kind: 'GOAL', side: 'HOME' as const,
    }));
    const result = buildDominanceSeries(manyGoals, 5);
    expect(result[0].homeScore).toBe(100);
  });

  it('label format is correct', () => {
    const result = buildDominanceSeries([], 10);
    expect(result[0].label).toBe("0'–5'");
    expect(result[1].label).toBe("5'–10'");
  });

  it('YELLOW_CARD reduces home dominance regardless of side', () => {
    const result = buildDominanceSeries(
      [{ occurredAtMin: 1, kind: 'YELLOW_CARD', side: 'HOME' }],
      10,
    );
    expect(result[0].homeScore).toBeLessThan(50);
  });

  it('CORNER by HOME adds positive dominance', () => {
    const result = buildDominanceSeries(
      [{ occurredAtMin: 3, kind: 'CORNER', side: 'HOME' }],
      10,
    );
    expect(result[0].homeScore).toBeGreaterThan(50);
  });
});

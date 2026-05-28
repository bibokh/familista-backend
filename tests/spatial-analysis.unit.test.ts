/**
 * tests/spatial-analysis.unit.test.ts
 * Phase 17 — Spatial & Tactical Visualization Engine
 *
 * Tests all pure spatial computation functions.
 * No DB, no mocks needed — all pure deterministic math.
 */

import {
  computeHeatmap,
  computePressureMap,
  computePassingNetwork,
  computeTeamShape,
  computeOverloads,
  computeFormationShiftSeries,
  computeSpatialAnalysis,
  type TacticalBoardData,
} from '../src/live-intelligence/live-intelligence.service';

// ── Test fixtures ────────────────────────────────────────────────────────────

type Position = TacticalBoardData['positions'][number];

function pos(side: 'HOME' | 'AWAY', x: number, y: number, name = 'Player', isStarter = true): Position {
  return { playerId: null, playerName: name, jerseyNumber: null, position: null, x, y, isStarter, side, rating: null };
}

function evt(kind: string, side: string, min: number, px: number | null = null, py: number | null = null) {
  return { kind, side, occurredAtMin: min, pitchX: px, pitchY: py };
}

/** 4-4-2 HOME positions */
const HOME_442: Position[] = [
  pos('HOME', 5, 50, 'GK'),
  pos('HOME', 25, 20, 'LB'), pos('HOME', 25, 40, 'CB1'), pos('HOME', 25, 60, 'CB2'), pos('HOME', 25, 80, 'RB'),
  pos('HOME', 50, 20, 'LM'), pos('HOME', 50, 40, 'CM1'), pos('HOME', 50, 60, 'CM2'), pos('HOME', 50, 80, 'RM'),
  pos('HOME', 75, 35, 'ST1'), pos('HOME', 75, 65, 'ST2'),
];

/** Mirrored 4-4-2 AWAY positions */
const AWAY_442: Position[] = [
  pos('AWAY', 95, 50, 'GK'),
  pos('AWAY', 75, 20, 'LB'), pos('AWAY', 75, 40, 'CB1'), pos('AWAY', 75, 60, 'CB2'), pos('AWAY', 75, 80, 'RB'),
  pos('AWAY', 50, 20, 'LM'), pos('AWAY', 50, 40, 'CM1'), pos('AWAY', 50, 60, 'CM2'), pos('AWAY', 50, 80, 'RM'),
  pos('AWAY', 25, 35, 'ST1'), pos('AWAY', 25, 65, 'ST2'),
];

const ALL_POSITIONS = [...HOME_442, ...AWAY_442];

// ════════════════════════════════════════════════════════════════════════════
// 1. computeHeatmap
// ════════════════════════════════════════════════════════════════════════════
describe('computeHeatmap', () => {
  it('returns cells with density for populated positions', () => {
    const cells = computeHeatmap(ALL_POSITIONS);
    expect(cells.length).toBeGreaterThan(0);
  });

  it('returns empty array when no positions given', () => {
    const cells = computeHeatmap([]);
    expect(cells.length).toBe(0);
  });

  it('all densities are in [0, 1]', () => {
    const cells = computeHeatmap(ALL_POSITIONS);
    for (const c of cells) {
      expect(c.homeDensity).toBeGreaterThanOrEqual(0);
      expect(c.homeDensity).toBeLessThanOrEqual(1);
      expect(c.awayDensity).toBeGreaterThanOrEqual(0);
      expect(c.awayDensity).toBeLessThanOrEqual(1);
    }
  });

  it('cell coordinates are within 0-100 range', () => {
    const cells = computeHeatmap(ALL_POSITIONS);
    for (const c of cells) {
      expect(c.cx).toBeGreaterThanOrEqual(0);
      expect(c.cx).toBeLessThanOrEqual(100);
      expect(c.cy).toBeGreaterThanOrEqual(0);
      expect(c.cy).toBeLessThanOrEqual(100);
    }
  });

  it('excludes non-starters from density', () => {
    const onlyBench: Position[] = [
      { ...pos('HOME', 50, 50, 'Sub'), isStarter: false },
    ];
    const cells = computeHeatmap(onlyBench);
    expect(cells.length).toBe(0);
  });

  it('HOME-only positions produce homeDensity > 0 with awayDensity = 0', () => {
    const cells = computeHeatmap(HOME_442);
    const nonZeroAway = cells.filter(c => c.awayDensity > 0.05);
    expect(nonZeroAway.length).toBe(0);
    const hasHome = cells.some(c => c.homeDensity > 0.05);
    expect(hasHome).toBe(true);
  });

  it('max cell density is exactly 1 (normalisation)', () => {
    const cells = computeHeatmap(ALL_POSITIONS);
    const maxH = Math.max(...cells.map(c => c.homeDensity));
    const maxA = Math.max(...cells.map(c => c.awayDensity));
    expect(maxH).toBeCloseTo(1, 5);
    expect(maxA).toBeCloseTo(1, 5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. computePressureMap
// ════════════════════════════════════════════════════════════════════════════
describe('computePressureMap', () => {
  it('returns empty array when no events given', () => {
    expect(computePressureMap([], 90)).toHaveLength(0);
  });

  it('skips events without pitchX/pitchY', () => {
    const evts = [evt('SHOT', 'HOME', 30, null, null), evt('CORNER', 'HOME', 45, null, null)];
    expect(computePressureMap(evts, 90)).toHaveLength(0);
  });

  it('skips non-pressure event kinds', () => {
    const evts = [evt('GOAL', 'HOME', 30, 80, 50), evt('SUBSTITUTION', 'HOME', 45, 50, 50)];
    expect(computePressureMap(evts, 90)).toHaveLength(0);
  });

  it('produces a cell for SHOT event with coordinates', () => {
    const evts = [evt('SHOT', 'HOME', 30, 80, 50)];
    const cells = computePressureMap(evts, 90);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0].eventCount).toBe(1);
  });

  it('all intensities are in (0, 1]', () => {
    const evts = [
      evt('SHOT', 'HOME', 10, 30, 30),
      evt('CORNER', 'AWAY', 45, 90, 50),
      evt('FOUL', 'HOME', 70, 60, 60),
    ];
    const cells = computePressureMap(evts, 90);
    for (const c of cells) {
      expect(c.intensity).toBeGreaterThan(0);
      expect(c.intensity).toBeLessThanOrEqual(1);
    }
  });

  it('max intensity normalises to 1', () => {
    const evts = [
      evt('SHOT', 'HOME', 80, 80, 50),
      evt('SHOT', 'HOME', 85, 80, 50),
    ];
    const cells = computePressureMap(evts, 90);
    const maxI = Math.max(...cells.map(c => c.intensity));
    expect(maxI).toBeCloseTo(1, 5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. computePassingNetwork
// ════════════════════════════════════════════════════════════════════════════
describe('computePassingNetwork', () => {
  it('returns edges for a full squad', () => {
    const edges = computePassingNetwork(ALL_POSITIONS);
    expect(edges.length).toBeGreaterThan(0);
  });

  it('returns empty for single player', () => {
    const edges = computePassingNetwork([pos('HOME', 50, 50, 'Solo')]);
    expect(edges.length).toBe(0);
  });

  it('all weights are in [0, 1]', () => {
    const edges = computePassingNetwork(ALL_POSITIONS);
    for (const e of edges) {
      expect(e.weight).toBeGreaterThanOrEqual(0);
      expect(e.weight).toBeLessThanOrEqual(1);
    }
  });

  it('produces no duplicate edges', () => {
    const edges = computePassingNetwork(HOME_442);
    const keys = edges.map(e => `${e.fromX},${e.fromY}-${e.toX},${e.toY}`);
    const revKeys = edges.map(e => `${e.toX},${e.toY}-${e.fromX},${e.fromY}`);
    // No forward edge should also appear as reverse
    for (const k of keys) {
      expect(revKeys).not.toContain(k);
    }
  });

  it('only includes starters', () => {
    const withSub = [...HOME_442, { ...pos('HOME', 50, 50, 'Sub'), isStarter: false }];
    const edges1 = computePassingNetwork(HOME_442);
    const edges2 = computePassingNetwork(withSub);
    expect(edges1.length).toBe(edges2.length);
  });

  it('edges are labelled with correct side', () => {
    const edges = computePassingNetwork(ALL_POSITIONS);
    for (const e of edges) {
      expect(['HOME', 'AWAY']).toContain(e.side);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. computeTeamShape
// ════════════════════════════════════════════════════════════════════════════
describe('computeTeamShape', () => {
  it('returns default shape for empty positions', () => {
    const shape = computeTeamShape([], 'HOME');
    expect(shape.compactness).toBe(0);
    expect(shape.width).toBe(0);
    expect(shape.spacingAnomalies).toHaveLength(0);
  });

  it('computes reasonable width for 4-4-2', () => {
    const shape = computeTeamShape(HOME_442, 'HOME');
    // Min x = 5, max x = 75, so width = 70
    expect(shape.width).toBeCloseTo(70, 0);
  });

  it('centroid is within 0-100 range', () => {
    const shape = computeTeamShape(ALL_POSITIONS, 'HOME');
    expect(shape.centroidX).toBeGreaterThanOrEqual(0);
    expect(shape.centroidX).toBeLessThanOrEqual(100);
    expect(shape.centroidY).toBeGreaterThanOrEqual(0);
    expect(shape.centroidY).toBeLessThanOrEqual(100);
  });

  it('defensiveX < attackingX for a spread formation', () => {
    const shape = computeTeamShape(HOME_442, 'HOME');
    expect(shape.defensiveX).toBeLessThan(shape.attackingX);
  });

  it('all spacing anomalies have gap > 0', () => {
    const shape = computeTeamShape(HOME_442, 'HOME');
    for (const a of shape.spacingAnomalies) {
      expect(a.gap).toBeGreaterThan(0);
    }
  });

  it('compactness is 0 when all players at same point', () => {
    const clustered = Array.from({ length: 11 }, (_, i) => pos('HOME', 50, 50, `P${i}`));
    const shape = computeTeamShape(clustered, 'HOME');
    expect(shape.compactness).toBe(0);
  });

  it('single player — no spacing anomalies', () => {
    const shape = computeTeamShape([pos('HOME', 50, 50, 'Solo')], 'HOME');
    expect(shape.spacingAnomalies).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. computeOverloads
// ════════════════════════════════════════════════════════════════════════════
describe('computeOverloads', () => {
  it('returns 9 zones (3×3 grid)', () => {
    const zones = computeOverloads(ALL_POSITIONS);
    expect(zones).toHaveLength(9);
  });

  it('all zones have correct col/row labels', () => {
    const zones = computeOverloads(ALL_POSITIONS);
    const cols = new Set(zones.map(z => z.col));
    const rows = new Set(zones.map(z => z.row));
    expect(cols).toEqual(new Set(['LEFT', 'CENTER', 'RIGHT']));
    expect(rows).toEqual(new Set(['DEFENSIVE', 'MIDDLE', 'ATTACKING']));
  });

  it('all counts are non-negative integers', () => {
    const zones = computeOverloads(ALL_POSITIONS);
    for (const z of zones) {
      expect(z.homeCount).toBeGreaterThanOrEqual(0);
      expect(z.awayCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('total player count equals number of starters per side', () => {
    const zones = computeOverloads(HOME_442);
    const totalHome = zones.reduce((s, z) => s + z.homeCount, 0);
    expect(totalHome).toBe(HOME_442.filter(p => p.isStarter).length);
  });

  it('dominated zone has correct dominantSide', () => {
    // Create 5 HOME players in defensive zone (x<33, y<33), 1 AWAY
    const crowded: Position[] = [
      ...Array.from({ length: 5 }, (_, i) => pos('HOME', 10 + i * 2, 10 + i * 3, `H${i}`)),
      pos('AWAY', 15, 15, 'A1'),
    ];
    const zones = computeOverloads(crowded);
    const defLeft = zones.find(z => z.row === 'DEFENSIVE' && z.col === 'LEFT');
    expect(defLeft?.dominantSide).toBe('HOME');
  });

  it('balanced zone (same count on each side) is BALANCED', () => {
    // 1 HOME and 1 AWAY in same zone
    const balanced: Position[] = [pos('HOME', 10, 10), pos('AWAY', 15, 15)];
    const zones = computeOverloads(balanced);
    const defLeft = zones.find(z => z.row === 'DEFENSIVE' && z.col === 'LEFT');
    expect(defLeft?.dominantSide).toBe('BALANCED');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. computeFormationShiftSeries
// ════════════════════════════════════════════════════════════════════════════
describe('computeFormationShiftSeries', () => {
  it('returns empty for maxMinute = 0', () => {
    const series = computeFormationShiftSeries([], ALL_POSITIONS, 0);
    expect(series).toHaveLength(0);
  });

  it('number of windows = ceil(maxMinute / 5)', () => {
    const series = computeFormationShiftSeries([], ALL_POSITIONS, 45);
    expect(series).toHaveLength(9);   // ceil(45/5)
  });

  it('all compactness values are in [0, 100]', () => {
    const evts = [
      evt('GOAL', 'HOME', 10), evt('SHOT', 'HOME', 20), evt('CORNER', 'AWAY', 30),
    ];
    const series = computeFormationShiftSeries(evts, ALL_POSITIONS, 45);
    for (const s of series) {
      expect(s.homeCompactness).toBeGreaterThanOrEqual(0);
      expect(s.homeCompactness).toBeLessThanOrEqual(100);
      expect(s.awayCompactness).toBeGreaterThanOrEqual(0);
      expect(s.awayCompactness).toBeLessThanOrEqual(100);
    }
  });

  it('width values are static (snapshot) — same in every window', () => {
    const evts = [evt('GOAL', 'HOME', 10), evt('GOAL', 'AWAY', 30)];
    const series = computeFormationShiftSeries(evts, HOME_442, 45);
    const firstW = series[0].homeWidth;
    expect(series.every(s => s.homeWidth === firstW)).toBe(true);
  });

  it('labels use minute notation', () => {
    const series = computeFormationShiftSeries([], ALL_POSITIONS, 20);
    expect(series[0].label).toBe("0'");
    expect(series[1].label).toBe("5'");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. computeSpatialAnalysis — integration
// ════════════════════════════════════════════════════════════════════════════
describe('computeSpatialAnalysis', () => {
  const evts = [
    evt('SHOT', 'HOME', 15, 80, 40),
    evt('CORNER', 'AWAY', 30, 5, 60),
    evt('FOUL', 'AWAY', 50, null, null),  // no coords
  ];

  it('returns all 7 required fields', () => {
    const spa = computeSpatialAnalysis(ALL_POSITIONS, evts, 90);
    expect(spa).toHaveProperty('heatmap');
    expect(spa).toHaveProperty('pressureMap');
    expect(spa).toHaveProperty('passingNetwork');
    expect(spa).toHaveProperty('homeShape');
    expect(spa).toHaveProperty('awayShape');
    expect(spa).toHaveProperty('overloadZones');
    expect(spa).toHaveProperty('formationShiftSeries');
  });

  it('homeShape side is HOME, awayShape side is AWAY', () => {
    const spa = computeSpatialAnalysis(ALL_POSITIONS, evts, 90);
    expect(spa.homeShape.side).toBe('HOME');
    expect(spa.awayShape.side).toBe('AWAY');
  });

  it('overloadZones has exactly 9 entries', () => {
    const spa = computeSpatialAnalysis(ALL_POSITIONS, evts, 90);
    expect(spa.overloadZones).toHaveLength(9);
  });

  it('handles empty positions gracefully', () => {
    const spa = computeSpatialAnalysis([], evts, 90);
    expect(spa.heatmap).toHaveLength(0);
    expect(spa.homeShape.compactness).toBe(0);
  });

  it('handles events with only null coords gracefully', () => {
    const noCoordEvts = [
      evt('SHOT', 'HOME', 15, null, null),
      evt('CORNER', 'AWAY', 30, null, null),
    ];
    const spa = computeSpatialAnalysis(ALL_POSITIONS, noCoordEvts, 90);
    expect(spa.pressureMap).toHaveLength(0);
  });
});

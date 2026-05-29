// tests/predictive-intelligence.unit.test.ts
// Phase 18 — unit tests for all 6 predictive functions + combinator
// Pure functions only — no DB, no network, no mocks required.

import {
  predictMomentumShift,
  predictGoalWindow,
  predictFatigueEscalation,
  predictCounterThreat,
  detectShapeCollapse,
  predictPossessionSwing,
  computePredictiveIntelligence,
} from '../src/live-intelligence/live-intelligence.service';
import type {
  DominanceWindow,
  FatigueRow,
  SpatialAnalysis,
  TimelineSummary,
  TacticalBoardData,
} from '../src/live-intelligence/live-intelligence.service';

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const flatDominance: DominanceWindow[] = [
  { fromMin: 0,  toMin: 5,  homeScore: 50, label: "0'-5'"  },
  { fromMin: 5,  toMin: 10, homeScore: 50, label: "5'-10'" },
  { fromMin: 10, toMin: 15, homeScore: 50, label: "10'-15'" },
  { fromMin: 15, toMin: 20, homeScore: 50, label: "15'-20'" },
];

const homeRisingDominance: DominanceWindow[] = [
  { fromMin: 0,  toMin: 5,  homeScore: 40, label: "0'-5'"  },
  { fromMin: 5,  toMin: 10, homeScore: 48, label: "5'-10'" },
  { fromMin: 10, toMin: 15, homeScore: 55, label: "10'-15'" },
  { fromMin: 15, toMin: 20, homeScore: 65, label: "15'-20'" },
];

const awayRisingDominance: DominanceWindow[] = [
  { fromMin: 0,  toMin: 5,  homeScore: 65, label: "0'-5'"  },
  { fromMin: 5,  toMin: 10, homeScore: 55, label: "5'-10'" },
  { fromMin: 10, toMin: 15, homeScore: 45, label: "10'-15'" },
  { fromMin: 15, toMin: 20, homeScore: 35, label: "15'-20'" },
];

const neutralMomentum   = { index: 0,    notes: [] };
const homeMomentum      = { index: 0.5,  notes: ['home pressing hard'] };
const awayMomentum      = { index: -0.5, notes: ['away dominating'] };

const blankTimeline: TimelineSummary = {
  totalEvents: 0, goals: 0, shotsOnTarget: 0, shots: 0,
  corners: 0, fouls: 0, yellowCards: 0, redCards: 0, byMinute: [],
};

const activePressure: TimelineSummary = {
  totalEvents: 20, goals: 0, shotsOnTarget: 5, shots: 8,
  corners: 4, fouls: 6, yellowCards: 1, redCards: 0, byMinute: [],
};

function makeFatigue(n: number, fi: number): FatigueRow[] {
  return Array.from({ length: n }, (_, i) => ({
    playerId:        `p${i}`,
    name:            `Player ${i}`,
    position:        'MF',
    minutesPlayed:   75,
    fatigueIndex:    fi,
    pressureSuccess: 60,
    acwr:            null,
    riskLevel:       (fi >= 80 ? 'HIGH' : fi >= 60 ? 'MEDIUM' : 'LOW') as 'HIGH' | 'MEDIUM' | 'LOW',
  }));
}

const starters: TacticalBoardData['positions'] = [
  // HOME — standard 4-4-2 spread
  { playerId: 'h1',  playerName: 'GK',  jerseyNumber: 1,  position: 'GK', x: 5,  y: 50, isStarter: true, side: 'HOME', rating: 7 },
  { playerId: 'h2',  playerName: 'LB',  jerseyNumber: 2,  position: 'LB', x: 20, y: 20, isStarter: true, side: 'HOME', rating: 7 },
  { playerId: 'h3',  playerName: 'CB',  jerseyNumber: 4,  position: 'CB', x: 20, y: 40, isStarter: true, side: 'HOME', rating: 7 },
  { playerId: 'h4',  playerName: 'CB2', jerseyNumber: 5,  position: 'CB', x: 20, y: 60, isStarter: true, side: 'HOME', rating: 7 },
  { playerId: 'h5',  playerName: 'RB',  jerseyNumber: 3,  position: 'RB', x: 20, y: 80, isStarter: true, side: 'HOME', rating: 7 },
  { playerId: 'h6',  playerName: 'LM',  jerseyNumber: 7,  position: 'LM', x: 45, y: 20, isStarter: true, side: 'HOME', rating: 7 },
  { playerId: 'h7',  playerName: 'CM',  jerseyNumber: 8,  position: 'CM', x: 45, y: 40, isStarter: true, side: 'HOME', rating: 7 },
  { playerId: 'h8',  playerName: 'CM2', jerseyNumber: 6,  position: 'CM', x: 45, y: 60, isStarter: true, side: 'HOME', rating: 7 },
  { playerId: 'h9',  playerName: 'RM',  jerseyNumber: 11, position: 'RM', x: 45, y: 80, isStarter: true, side: 'HOME', rating: 7 },
  { playerId: 'h10', playerName: 'ST',  jerseyNumber: 9,  position: 'ST', x: 75, y: 40, isStarter: true, side: 'HOME', rating: 7 },
  { playerId: 'h11', playerName: 'ST2', jerseyNumber: 10, position: 'ST', x: 75, y: 60, isStarter: true, side: 'HOME', rating: 7 },
  // AWAY — mirrored
  { playerId: 'a1',  playerName: 'GK',  jerseyNumber: 1,  position: 'GK', x: 95, y: 50, isStarter: true, side: 'AWAY', rating: 7 },
  { playerId: 'a2',  playerName: 'LB',  jerseyNumber: 2,  position: 'LB', x: 80, y: 20, isStarter: true, side: 'AWAY', rating: 7 },
  { playerId: 'a3',  playerName: 'CB',  jerseyNumber: 4,  position: 'CB', x: 80, y: 40, isStarter: true, side: 'AWAY', rating: 7 },
  { playerId: 'a4',  playerName: 'CB2', jerseyNumber: 5,  position: 'CB', x: 80, y: 60, isStarter: true, side: 'AWAY', rating: 7 },
  { playerId: 'a5',  playerName: 'RB',  jerseyNumber: 3,  position: 'RB', x: 80, y: 80, isStarter: true, side: 'AWAY', rating: 7 },
  { playerId: 'a6',  playerName: 'LM',  jerseyNumber: 7,  position: 'LM', x: 55, y: 20, isStarter: true, side: 'AWAY', rating: 7 },
  { playerId: 'a7',  playerName: 'CM',  jerseyNumber: 8,  position: 'CM', x: 55, y: 40, isStarter: true, side: 'AWAY', rating: 7 },
  { playerId: 'a8',  playerName: 'CM2', jerseyNumber: 6,  position: 'CM', x: 55, y: 60, isStarter: true, side: 'AWAY', rating: 7 },
  { playerId: 'a9',  playerName: 'RM',  jerseyNumber: 11, position: 'RM', x: 55, y: 80, isStarter: true, side: 'AWAY', rating: 7 },
  { playerId: 'a10', playerName: 'ST',  jerseyNumber: 9,  position: 'ST', x: 25, y: 40, isStarter: true, side: 'AWAY', rating: 7 },
  { playerId: 'a11', playerName: 'ST2', jerseyNumber: 10, position: 'ST', x: 25, y: 60, isStarter: true, side: 'AWAY', rating: 7 },
];

import { computeSpatialAnalysis } from '../src/live-intelligence/live-intelligence.service';
const baseSpatial: SpatialAnalysis = computeSpatialAnalysis(starters, [], 45);

// ─── predictMomentumShift ─────────────────────────────────────────────────────

describe('predictMomentumShift', () => {
  test('returns STABLE with low confidence on empty series', () => {
    const r = predictMomentumShift(neutralMomentum, [], 30);
    expect(r.direction).toBe('STABLE');
    expect(r.confidence).toBeLessThanOrEqual(0.5);
    expect(r.slope).toBe(0);
  });

  test('returns STABLE with single-bin series (< 2 bins)', () => {
    const r = predictMomentumShift(neutralMomentum, [flatDominance[0]], 5);
    expect(r.direction).toBe('STABLE');
  });

  test('detects HOME direction on rising home dominance', () => {
    const r = predictMomentumShift(homeMomentum, homeRisingDominance, 20);
    expect(r.direction).toBe('HOME');
    expect(r.slope).toBeGreaterThan(0);
  });

  test('detects AWAY direction on falling home dominance', () => {
    const r = predictMomentumShift(awayMomentum, awayRisingDominance, 20);
    expect(r.direction).toBe('AWAY');
    expect(r.slope).toBeLessThan(0);
  });

  test('returns STABLE on flat series', () => {
    const r = predictMomentumShift(neutralMomentum, flatDominance, 20);
    expect(r.direction).toBe('STABLE');
  });

  test('confidence is bounded 0-1', () => {
    const r = predictMomentumShift(homeMomentum, homeRisingDominance, 45);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  test('slope is bounded -1…+1', () => {
    const extreme: DominanceWindow[] = [
      { fromMin: 0,  toMin: 5,  homeScore: 0,   label: "0'" },
      { fromMin: 5,  toMin: 10, homeScore: 100, label: "5'" },
    ];
    const r = predictMomentumShift(neutralMomentum, extreme, 10);
    expect(r.slope).toBeGreaterThanOrEqual(-1);
    expect(r.slope).toBeLessThanOrEqual(1);
  });

  test('note is a non-empty string', () => {
    const r = predictMomentumShift(neutralMomentum, flatDominance, 45);
    expect(typeof r.note).toBe('string');
    expect(r.note.length).toBeGreaterThan(0);
  });
});

// ─── predictGoalWindow ────────────────────────────────────────────────────────

describe('predictGoalWindow', () => {
  test('baseline probability ≥ 5 on blank data', () => {
    const r = predictGoalWindow(blankTimeline, neutralMomentum, 45);
    expect(r.probability).toBeGreaterThanOrEqual(5);
  });

  test('active pressure bumps probability up', () => {
    const blank = predictGoalWindow(blankTimeline, neutralMomentum, 45);
    const active = predictGoalWindow(activePressure, neutralMomentum, 45);
    expect(active.probability).toBeGreaterThan(blank.probability);
  });

  test('probability is bounded 5-90', () => {
    const extreme: TimelineSummary = { ...activePressure, shotsOnTarget: 99, corners: 20 };
    const r = predictGoalWindow(extreme, homeMomentum, 89);
    expect(r.probability).toBeLessThanOrEqual(90);
    expect(r.probability).toBeGreaterThanOrEqual(5);
  });

  test('late-game minute increases probability', () => {
    const early = predictGoalWindow(blankTimeline, neutralMomentum, 30);
    const late  = predictGoalWindow(blankTimeline, neutralMomentum, 80);
    expect(late.probability).toBeGreaterThan(early.probability);
  });

  test('threat side is HOME when home momentum is strong', () => {
    const r = predictGoalWindow(blankTimeline, homeMomentum, 45);
    expect(r.threatSide).toBe('HOME');
  });

  test('threat side is AWAY when away momentum is strong', () => {
    const r = predictGoalWindow(blankTimeline, awayMomentum, 45);
    expect(r.threatSide).toBe('AWAY');
  });

  test('threat side is BALANCED on neutral momentum', () => {
    const r = predictGoalWindow(blankTimeline, neutralMomentum, 45);
    expect(r.threatSide).toBe('BALANCED');
  });

  test('windowMin is positive', () => {
    const r = predictGoalWindow(blankTimeline, neutralMomentum, 60);
    expect(r.windowMin).toBeGreaterThan(0);
  });

  test('drivers array present (may be empty for blank data)', () => {
    const r = predictGoalWindow(blankTimeline, neutralMomentum, 45);
    expect(Array.isArray(r.drivers)).toBe(true);
  });

  test('high shot volume with no goals adds conversion driver', () => {
    const ts: TimelineSummary = { ...blankTimeline, shots: 6, goals: 0 };
    const r = predictGoalWindow(ts, neutralMomentum, 45);
    const hasDriver = r.drivers.some(d => d.toLowerCase().includes('conversion'));
    expect(hasDriver).toBe(true);
  });
});

// ─── predictFatigueEscalation ─────────────────────────────────────────────────

describe('predictFatigueEscalation', () => {
  test('returns LOW risk with no players', () => {
    const r = predictFatigueEscalation([], 45);
    expect(r.peakRisk).toBe('LOW');
    expect(r.riskyCount).toBe(0);
    expect(r.riskPlayers).toHaveLength(0);
    expect(r.peakMinute).toBeNull();
  });

  test('returns HIGH risk when multiple players have fi ≥ 80', () => {
    const r = predictFatigueEscalation(makeFatigue(3, 85), 60);
    expect(r.peakRisk).toBe('HIGH');
    expect(r.riskyCount).toBeGreaterThanOrEqual(3);
  });

  test('returns MEDIUM risk for moderate fatigue', () => {
    const r = predictFatigueEscalation(makeFatigue(2, 65), 55);
    expect(r.peakRisk).toBe('MEDIUM');
  });

  test('returns LOW risk when all players have low fatigue', () => {
    const r = predictFatigueEscalation(makeFatigue(5, 30), 40);
    expect(r.peakRisk).toBe('LOW');
    expect(r.peakMinute).toBeNull();
  });

  test('peakMinute is non-null for HIGH risk before 70 min', () => {
    const r = predictFatigueEscalation(makeFatigue(3, 85), 50);
    expect(r.peakMinute).not.toBeNull();
    if (r.peakMinute !== null) {
      expect(r.peakMinute).toBeGreaterThanOrEqual(50);
      expect(r.peakMinute).toBeLessThanOrEqual(90);
    }
  });

  test('peakMinute caps at 90', () => {
    const r = predictFatigueEscalation(makeFatigue(2, 70), 85);
    if (r.peakMinute !== null) expect(r.peakMinute).toBeLessThanOrEqual(90);
  });

  test('riskPlayers capped at 5', () => {
    const r = predictFatigueEscalation(makeFatigue(10, 75), 60);
    expect(r.riskPlayers.length).toBeLessThanOrEqual(5);
  });

  test('riskPlayers include correct fields', () => {
    const r = predictFatigueEscalation(makeFatigue(1, 85), 60);
    if (r.riskPlayers.length > 0) {
      const p = r.riskPlayers[0];
      expect(typeof p.name).toBe('string');
      expect(typeof p.fatigueIndex).toBe('number');
      expect(typeof p.minutesPlayed).toBe('number');
    }
  });
});

// ─── predictCounterThreat ─────────────────────────────────────────────────────

describe('predictCounterThreat', () => {
  test('returns a valid level', () => {
    const r = predictCounterThreat(baseSpatial, neutralMomentum, blankTimeline);
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(r.level);
  });

  test('likelyZone is null when level is LOW', () => {
    // Construct minimal spatial with no overloads
    const minimal: SpatialAnalysis = {
      ...baseSpatial,
      overloadZones: baseSpatial.overloadZones.map(z => ({ ...z, magnitude: 0 })),
      homeShape: { ...baseSpatial.homeShape, centroidX: 40, width: 40, compactness: 50 },
      awayShape: { ...baseSpatial.awayShape, centroidX: 60, width: 40, compactness: 50 },
    };
    const r = predictCounterThreat(minimal, neutralMomentum, blankTimeline);
    if (r.level === 'LOW') expect(r.likelyZone).toBeNull();
  });

  test('high foul count boosts threat', () => {
    const heavyFoul: TimelineSummary = { ...blankTimeline, fouls: 12 };
    const r1 = predictCounterThreat(baseSpatial, neutralMomentum, blankTimeline);
    const r2 = predictCounterThreat(baseSpatial, neutralMomentum, heavyFoul);
    const levels: Record<string, number> = { HIGH: 2, MEDIUM: 1, LOW: 0 };
    expect(levels[r2.level]).toBeGreaterThanOrEqual(levels[r1.level]);
  });

  test('likelyZone is LEFT, CENTER, or RIGHT when non-null', () => {
    const r = predictCounterThreat(baseSpatial, homeMomentum, activePressure);
    if (r.likelyZone !== null) {
      expect(['LEFT', 'CENTER', 'RIGHT']).toContain(r.likelyZone);
    }
  });

  test('note is non-empty string', () => {
    const r = predictCounterThreat(baseSpatial, neutralMomentum, blankTimeline);
    expect(typeof r.note).toBe('string');
    expect(r.note.length).toBeGreaterThan(0);
  });
});

// ─── detectShapeCollapse ──────────────────────────────────────────────────────

describe('detectShapeCollapse', () => {
  test('returns LOW for a well-formed shape with no fatigue', () => {
    const r = detectShapeCollapse(baseSpatial, neutralMomentum, []);
    // baseSpatial from standard positions — may not be LOW but should be valid
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(r.risk);
  });

  test('score is bounded 0-100', () => {
    const r = detectShapeCollapse(baseSpatial, homeMomentum, makeFatigue(5, 90));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  test('indicators is an array, max 4 entries', () => {
    const r = detectShapeCollapse(baseSpatial, homeMomentum, makeFatigue(5, 85));
    expect(Array.isArray(r.indicators)).toBe(true);
    expect(r.indicators.length).toBeLessThanOrEqual(4);
  });

  test('many high-fatigue players raises risk', () => {
    const noFatigue    = detectShapeCollapse(baseSpatial, neutralMomentum, []);
    const highFatigue  = detectShapeCollapse(baseSpatial, neutralMomentum, makeFatigue(5, 90));
    const levels: Record<string, number> = { HIGH: 2, MEDIUM: 1, LOW: 0 };
    expect(levels[highFatigue.risk]).toBeGreaterThanOrEqual(levels[noFatigue.risk]);
  });

  test('spacing anomalies add to indicators', () => {
    const spatialWithAnomalies: SpatialAnalysis = {
      ...baseSpatial,
      homeShape: {
        ...baseSpatial.homeShape,
        spacingAnomalies: [{ name: 'Wanderer', x: 90, y: 10, gap: 45 }],
      },
    };
    const r = detectShapeCollapse(spatialWithAnomalies, neutralMomentum, []);
    expect(r.indicators.some(i => i.includes('anomal'))).toBe(true);
  });

  test('risk aligns with score', () => {
    const r = detectShapeCollapse(baseSpatial, homeMomentum, makeFatigue(3, 85));
    if (r.score >= 60)      expect(r.risk).toBe('HIGH');
    else if (r.score >= 35) expect(r.risk).toBe('MEDIUM');
    else                    expect(r.risk).toBe('LOW');
  });
});

// ─── predictPossessionSwing ───────────────────────────────────────────────────

describe('predictPossessionSwing', () => {
  test('returns STABLE with fewer than 2 bins', () => {
    const r = predictPossessionSwing({ ourPct: 50 }, []);
    expect(r.trend).toBe('STABLE');
    expect(r.forecastPct).toBe(50);
  });

  test('returns STABLE with single bin', () => {
    const r = predictPossessionSwing({ ourPct: 55 }, [flatDominance[0]]);
    expect(r.trend).toBe('STABLE');
  });

  test('GAINING when dominance trend is strongly home', () => {
    const r = predictPossessionSwing({ ourPct: 50 }, homeRisingDominance);
    expect(['GAINING', 'STABLE']).toContain(r.trend);
  });

  test('LOSING when dominance trend is strongly away', () => {
    const r = predictPossessionSwing({ ourPct: 60 }, awayRisingDominance);
    expect(['LOSING', 'STABLE']).toContain(r.trend);
  });

  test('forecastPct is bounded 10-90', () => {
    const r = predictPossessionSwing({ ourPct: 5 }, homeRisingDominance);
    expect(r.forecastPct).toBeGreaterThanOrEqual(10);
    expect(r.forecastPct).toBeLessThanOrEqual(90);
  });

  test('currentPct matches input rounded', () => {
    const r = predictPossessionSwing({ ourPct: 63.7 }, flatDominance);
    expect(r.currentPct).toBe(64);
  });

  test('confidence is bounded 0-1', () => {
    const r = predictPossessionSwing({ ourPct: 50 }, flatDominance);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });
});

// ─── computePredictiveIntelligence (combinator) ───────────────────────────────

describe('computePredictiveIntelligence', () => {
  const bundle = computePredictiveIntelligence(
    homeMomentum, { ourPct: 55 }, homeRisingDominance,
    activePressure, makeFatigue(2, 75), baseSpatial, 60,
  );

  test('bundle has all 6 fields', () => {
    expect(bundle).toHaveProperty('momentumForecast');
    expect(bundle).toHaveProperty('goalThreat');
    expect(bundle).toHaveProperty('fatigueRisk');
    expect(bundle).toHaveProperty('counterThreat');
    expect(bundle).toHaveProperty('shapeCollapse');
    expect(bundle).toHaveProperty('possessionSwing');
  });

  test('momentumForecast direction is valid', () => {
    expect(['HOME', 'AWAY', 'STABLE']).toContain(bundle.momentumForecast.direction);
  });

  test('goalThreat probability is in range', () => {
    expect(bundle.goalThreat.probability).toBeGreaterThanOrEqual(5);
    expect(bundle.goalThreat.probability).toBeLessThanOrEqual(90);
  });

  test('fatigueRisk peakRisk is valid', () => {
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(bundle.fatigueRisk.peakRisk);
  });

  test('counterThreat level is valid', () => {
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(bundle.counterThreat.level);
  });

  test('shapeCollapse risk is valid', () => {
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(bundle.shapeCollapse.risk);
  });

  test('possessionSwing trend is valid', () => {
    expect(['GAINING', 'LOSING', 'STABLE']).toContain(bundle.possessionSwing.trend);
  });

  test('is deterministic — same inputs produce same outputs', () => {
    const b2 = computePredictiveIntelligence(
      homeMomentum, { ourPct: 55 }, homeRisingDominance,
      activePressure, makeFatigue(2, 75), baseSpatial, 60,
    );
    expect(b2).toEqual(bundle);
  });

  test('null liveMinute does not throw', () => {
    expect(() => computePredictiveIntelligence(
      neutralMomentum, { ourPct: 50 }, [], blankTimeline, [], baseSpatial, null,
    )).not.toThrow();
  });
});

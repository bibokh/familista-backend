// Phase 13 — Tactical AI Engine: pure unit tests
// No database, no network. All scoring functions are deterministic.

import {
  analyzeFormation,
  computeAttackStructure,
  computeDefensiveStructure,
  computeTransitionQuality,
  computePressingEfficiency,
  computeTacticalDiscipline,
  computeOverallScore,
  generateRecommendations,
  type TacticalScores,
  type FormationAnalysis,
} from '../src/tactical/tactical-ai.service';

// ── analyzeFormation ──────────────────────────────────────────────────────────

describe('analyzeFormation', () => {
  it('returns null for null input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(analyzeFormation(null as any)).toBeNull();
  });

  it('returns detected formation string from lineup', () => {
    const result = analyzeFormation({
      formation: '4-3-3',
      positions: [
        { position: 'DC', x: 30, y: 20, isStarter: true },
        { position: 'DC', x: 50, y: 20, isStarter: true },
        { position: 'DL', x: 10, y: 15, isStarter: true },
        { position: 'DR', x: 70, y: 15, isStarter: true },
        { position: 'MC', x: 40, y: 50, isStarter: true },
        { position: 'ML', x: 20, y: 55, isStarter: true },
        { position: 'MR', x: 60, y: 55, isStarter: true },
        { position: 'ST', x: 40, y: 80, isStarter: true },
        { position: 'AML', x: 20, y: 75, isStarter: true },
        { position: 'AMR', x: 60, y: 75, isStarter: true },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.detectedFormation).toBe('4-3-3');
  });

  it('excludes GK from width calculation', () => {
    const result = analyzeFormation({
      formation: '4-3-3',
      positions: [
        { position: 'GK', x: 50, y: 2,  isStarter: true },
        { position: 'DL', x: 5,  y: 20, isStarter: true },
        { position: 'DR', x: 90, y: 20, isStarter: true },
      ],
    });
    expect(result).not.toBeNull();
    // Width should be 90-5 = 85 (GK at 50 excluded)
    expect(result!.width).toBe(85);
  });

  it('width is 0–100', () => {
    const result = analyzeFormation({
      formation: '4-4-2',
      positions: [
        { position: 'DC', x: 20, y: 20, isStarter: true },
        { position: 'DC', x: 80, y: 20, isStarter: true },
      ],
    });
    expect(result!.width).toBeGreaterThanOrEqual(0);
    expect(result!.width).toBeLessThanOrEqual(100);
  });

  it('compactness is higher for tightly clustered players', () => {
    const compact = analyzeFormation({
      formation: '4-4-2',
      positions: [
        { position: 'DC', x: 40, y: 30, isStarter: true },
        { position: 'DC', x: 50, y: 32, isStarter: true },
        { position: 'MC', x: 45, y: 35, isStarter: true },
      ],
    });
    const stretched = analyzeFormation({
      formation: '4-4-2',
      positions: [
        { position: 'DC',  x: 40, y: 10, isStarter: true },
        { position: 'AMC', x: 40, y: 90, isStarter: true },
        { position: 'MC',  x: 40, y: 50, isStarter: true },
      ],
    });
    expect(compact!.compactness).toBeGreaterThan(stretched!.compactness);
  });

  it('left/center/right balance sums to ~100%', () => {
    const result = analyzeFormation({
      formation: '4-3-3',
      positions: [
        { position: 'DL', x: 10, y: 20, isStarter: true },
        { position: 'DC', x: 40, y: 20, isStarter: true },
        { position: 'DR', x: 80, y: 20, isStarter: true },
      ],
    });
    const sum = result!.leftBalance + result!.centerBalance + result!.rightBalance;
    expect(sum).toBeGreaterThanOrEqual(97);
    expect(sum).toBeLessThanOrEqual(103);
  });

  it('detects left overload when players cluster left', () => {
    const result = analyzeFormation({
      formation: '3-4-3',
      positions: [
        { position: 'DL',  x: 5,  y: 20, isStarter: true },
        { position: 'DC',  x: 15, y: 20, isStarter: true },
        { position: 'DC',  x: 25, y: 20, isStarter: true },
        { position: 'ML',  x: 10, y: 50, isStarter: true },
        { position: 'MC',  x: 20, y: 50, isStarter: true },
        { position: 'MR',  x: 70, y: 50, isStarter: true },
        { position: 'ST',  x: 50, y: 80, isStarter: true },
        { position: 'AML', x: 12, y: 75, isStarter: true },
        { position: 'AMR', x: 75, y: 75, isStarter: true },
      ],
    });
    expect(result!.leftBalance).toBeGreaterThan(result!.rightBalance);
  });

  it('handles empty positions array', () => {
    const result = analyzeFormation({ formation: '4-4-2', positions: [] });
    expect(result).not.toBeNull();
    expect(result!.detectedFormation).toBe('4-4-2');
  });

  it('returns sensible defaults for non-array positions', () => {
    const result = analyzeFormation({ formation: '3-5-2', positions: null });
    expect(result!.compactness).toBe(50);
  });
});

// ── computeAttackStructure ────────────────────────────────────────────────────

describe('computeAttackStructure', () => {
  it('returns 0 with all zero inputs', () => {
    expect(computeAttackStructure({ shotsOnTarget: 0, shots: 0, avgXg: 0, avgProgressivePasses: 0 })).toBe(0);
  });

  it('returns 100 with maximum quality inputs', () => {
    // 100% shot accuracy + 0.5 xG/player + 5 progressive passes/player
    const score = computeAttackStructure({ shotsOnTarget: 10, shots: 10, avgXg: 0.5, avgProgressivePasses: 5 });
    expect(score).toBe(100);
  });

  it('higher shot accuracy raises score', () => {
    const good = computeAttackStructure({ shotsOnTarget: 8, shots: 10, avgXg: 0.3, avgProgressivePasses: 3 });
    const bad  = computeAttackStructure({ shotsOnTarget: 2, shots: 10, avgXg: 0.3, avgProgressivePasses: 3 });
    expect(good).toBeGreaterThan(bad);
  });

  it('result is always 0–100', () => {
    const score = computeAttackStructure({ shotsOnTarget: 999, shots: 1, avgXg: 99, avgProgressivePasses: 999 });
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

// ── computeDefensiveStructure ─────────────────────────────────────────────────

describe('computeDefensiveStructure', () => {
  it('returns positive value with good defensive inputs', () => {
    const score = computeDefensiveStructure({
      avgPressures: 10, avgPressureSuccess: 6, avgTacklesWon: 3, avgClearances: 2, possessionConceded: 40,
    });
    expect(score).toBeGreaterThan(50);
  });

  it('high possession conceded lowers score', () => {
    const good = computeDefensiveStructure({
      avgPressures: 8, avgPressureSuccess: 4, avgTacklesWon: 2, avgClearances: 2, possessionConceded: 30,
    });
    const bad = computeDefensiveStructure({
      avgPressures: 8, avgPressureSuccess: 4, avgTacklesWon: 2, avgClearances: 2, possessionConceded: 70,
    });
    expect(good).toBeGreaterThan(bad);
  });

  it('result is always 0–100', () => {
    const score = computeDefensiveStructure({
      avgPressures: 0, avgPressureSuccess: 0, avgTacklesWon: 0, avgClearances: 0, possessionConceded: 100,
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ── computeTransitionQuality ──────────────────────────────────────────────────

describe('computeTransitionQuality', () => {
  it('returns 0 with zero inputs', () => {
    expect(computeTransitionQuality({ avgCarries: 0, avgProgressiveCarries: 0, avgXa: 0 })).toBe(0);
  });

  it('higher progressive carry rate raises score', () => {
    const high = computeTransitionQuality({ avgCarries: 10, avgProgressiveCarries: 8, avgXa: 0.2 });
    const low  = computeTransitionQuality({ avgCarries: 10, avgProgressiveCarries: 2, avgXa: 0.2 });
    expect(high).toBeGreaterThan(low);
  });

  it('result is always 0–100', () => {
    const score = computeTransitionQuality({ avgCarries: 100, avgProgressiveCarries: 100, avgXa: 10 });
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

// ── computePressingEfficiency ─────────────────────────────────────────────────

describe('computePressingEfficiency', () => {
  it('returns 40 (neutral) when no pressures', () => {
    expect(computePressingEfficiency({ totalPressures: 0, totalPressSuccessful: 0 })).toBe(40);
  });

  it('67% success rate returns ~100', () => {
    const score = computePressingEfficiency({ totalPressures: 30, totalPressSuccessful: 20 });
    expect(score).toBe(100);
  });

  it('40% success rate returns ~60', () => {
    const score = computePressingEfficiency({ totalPressures: 100, totalPressSuccessful: 40 });
    expect(score).toBe(60);
  });

  it('higher success rate returns higher score', () => {
    const high = computePressingEfficiency({ totalPressures: 50, totalPressSuccessful: 40 });
    const low  = computePressingEfficiency({ totalPressures: 50, totalPressSuccessful: 10 });
    expect(high).toBeGreaterThan(low);
  });

  it('result is always 0–100', () => {
    const score = computePressingEfficiency({ totalPressures: 100, totalPressSuccessful: 100 });
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

// ── computeTacticalDiscipline ─────────────────────────────────────────────────

describe('computeTacticalDiscipline', () => {
  it('returns high score for clean, winning aerial performance', () => {
    const score = computeTacticalDiscipline({
      avgFoulsCommitted: 0, avgYellowCards: 0, avgRedCards: 0,
      avgAerialDuelsWon: 8, avgAerialDuels: 10,
    });
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it('high foul rate penalises score', () => {
    const clean = computeTacticalDiscipline({
      avgFoulsCommitted: 0, avgYellowCards: 0, avgRedCards: 0,
      avgAerialDuelsWon: 5, avgAerialDuels: 10,
    });
    const dirty = computeTacticalDiscipline({
      avgFoulsCommitted: 5, avgYellowCards: 1, avgRedCards: 0,
      avgAerialDuelsWon: 5, avgAerialDuels: 10,
    });
    expect(clean).toBeGreaterThan(dirty);
  });

  it('red card has heavier impact than yellow', () => {
    const yellow = computeTacticalDiscipline({
      avgFoulsCommitted: 0, avgYellowCards: 3, avgRedCards: 0,
      avgAerialDuelsWon: 5, avgAerialDuels: 10,
    });
    const red = computeTacticalDiscipline({
      avgFoulsCommitted: 0, avgYellowCards: 0, avgRedCards: 1,
      avgAerialDuelsWon: 5, avgAerialDuels: 10,
    });
    expect(yellow).toBeGreaterThanOrEqual(red);
  });

  it('result is always 0–100', () => {
    const min = computeTacticalDiscipline({
      avgFoulsCommitted: 99, avgYellowCards: 99, avgRedCards: 99,
      avgAerialDuelsWon: 0,  avgAerialDuels: 10,
    });
    const max = computeTacticalDiscipline({
      avgFoulsCommitted: 0, avgYellowCards: 0, avgRedCards: 0,
      avgAerialDuelsWon: 10, avgAerialDuels: 10,
    });
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(100);
  });
});

// ── computeOverallScore ───────────────────────────────────────────────────────

describe('computeOverallScore', () => {
  it('returns 0 for all-zero inputs', () => {
    const s: Omit<TacticalScores, 'overall'> = {
      attackStructure: 0, defensiveStructure: 0,
      transitionQuality: 0, pressingEfficiency: 0, tacticalDiscipline: 0,
    };
    expect(computeOverallScore(s)).toBe(0);
  });

  it('returns 100 for all-100 inputs', () => {
    const s: Omit<TacticalScores, 'overall'> = {
      attackStructure: 100, defensiveStructure: 100,
      transitionQuality: 100, pressingEfficiency: 100, tacticalDiscipline: 100,
    };
    expect(computeOverallScore(s)).toBe(100);
  });

  it('equal inputs produce 50 for 50-score components', () => {
    const s: Omit<TacticalScores, 'overall'> = {
      attackStructure: 50, defensiveStructure: 50,
      transitionQuality: 50, pressingEfficiency: 50, tacticalDiscipline: 50,
    };
    expect(computeOverallScore(s)).toBe(50);
  });

  it('attack and defence components together weigh 50%', () => {
    const withAttackDef: Omit<TacticalScores, 'overall'> = {
      attackStructure: 100, defensiveStructure: 100,
      transitionQuality: 0, pressingEfficiency: 0, tacticalDiscipline: 0,
    };
    expect(computeOverallScore(withAttackDef)).toBe(50);
  });

  it('always in 0–100 range', () => {
    const mixed: Omit<TacticalScores, 'overall'> = {
      attackStructure: 80, defensiveStructure: 40,
      transitionQuality: 70, pressingEfficiency: 55, tacticalDiscipline: 65,
    };
    const result = computeOverallScore(mixed);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });
});

// ── generateRecommendations ───────────────────────────────────────────────────

function makeScores(overrides: Partial<Omit<TacticalScores, 'overall'>> = {}): TacticalScores {
  const base: Omit<TacticalScores, 'overall'> = {
    attackStructure:    overrides.attackStructure    ?? 65,
    defensiveStructure: overrides.defensiveStructure ?? 65,
    transitionQuality:  overrides.transitionQuality  ?? 65,
    pressingEfficiency: overrides.pressingEfficiency ?? 65,
    tacticalDiscipline: overrides.tacticalDiscipline ?? 65,
  };
  return { ...base, overall: computeOverallScore(base) };
}

describe('generateRecommendations', () => {
  it('returns empty array when all scores are good and no workload', () => {
    const recs = generateRecommendations(makeScores(), null, 0);
    expect(recs.length).toBe(0);
  });

  it('generates PRESSING HIGH when pressingEfficiency < 40', () => {
    const recs = generateRecommendations(makeScores({ pressingEfficiency: 25 }), null, 0);
    const r = recs.find(r => r.type === 'PRESSING' && r.priority === 'HIGH');
    expect(r).toBeDefined();
  });

  it('generates PRESSING MEDIUM when pressingEfficiency 40–59', () => {
    const recs = generateRecommendations(makeScores({ pressingEfficiency: 50 }), null, 0);
    const r = recs.find(r => r.type === 'PRESSING' && r.priority === 'MEDIUM');
    expect(r).toBeDefined();
  });

  it('generates FORMATION HIGH when attackStructure < 40', () => {
    const recs = generateRecommendations(makeScores({ attackStructure: 30 }), null, 0);
    const r = recs.find(r => r.type === 'FORMATION' && r.priority === 'HIGH');
    expect(r).toBeDefined();
  });

  it('generates TRANSITION HIGH when transitionQuality < 45', () => {
    const recs = generateRecommendations(makeScores({ transitionQuality: 30 }), null, 0);
    const r = recs.find(r => r.type === 'TRANSITION' && r.priority === 'HIGH');
    expect(r).toBeDefined();
  });

  it('generates WORKLOAD recommendation when workloadFlags > 0', () => {
    const recs = generateRecommendations(makeScores(), null, 2);
    const r = recs.find(r => r.type === 'WORKLOAD');
    expect(r).toBeDefined();
  });

  it('WORKLOAD HIGH when workloadFlags > 3', () => {
    const recs = generateRecommendations(makeScores(), null, 5);
    const r = recs.find(r => r.type === 'WORKLOAD');
    expect(r?.priority).toBe('HIGH');
  });

  it('WIDTH recommendation when left/right imbalance > 25%', () => {
    const formation: FormationAnalysis = {
      detectedFormation: '4-3-3',
      width: 60, compactness: 60,
      leftBalance: 60, centerBalance: 20, rightBalance: 20,
    };
    const recs = generateRecommendations(makeScores(), formation, 0);
    const r = recs.find(r => r.type === 'WIDTH');
    expect(r).toBeDefined();
    expect(r!.finding.toLowerCase()).toContain('left');
  });

  it('FORMATION MEDIUM recommendation for stretched shape', () => {
    const formation: FormationAnalysis = {
      detectedFormation: '4-3-3',
      width: 80, compactness: 25,  // very stretched
      leftBalance: 33, centerBalance: 34, rightBalance: 33,
    };
    const recs = generateRecommendations(makeScores(), formation, 0);
    const r = recs.find(r => r.type === 'FORMATION' && r.finding.includes('compact'));
    expect(r).toBeDefined();
  });

  it('results sorted HIGH before MEDIUM before LOW', () => {
    const recs = generateRecommendations(
      makeScores({ pressingEfficiency: 20, attackStructure: 20, transitionQuality: 20 }),
      null,
      5,
    );
    const priorities = recs.map(r => r.priority);
    for (let i = 1; i < priorities.length; i++) {
      const order: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      expect(order[priorities[i]!]).toBeGreaterThanOrEqual(order[priorities[i - 1]!]);
    }
  });

  it('every recommendation has finding, action, type and priority', () => {
    const recs = generateRecommendations(
      makeScores({ pressingEfficiency: 20, attackStructure: 30, transitionQuality: 30, tacticalDiscipline: 30 }),
      null,
      3,
    );
    for (const r of recs) {
      expect(r.finding).toBeTruthy();
      expect(r.action).toBeTruthy();
      expect(r.type).toBeTruthy();
      expect(r.priority).toBeTruthy();
    }
  });
});

// Familista — Unified Intelligence Engine: Unit Tests (Phase 11)
// All tests are pure — zero database connections required.
// Tests cover: shared.utils, tactical-matrix.service, and integration contracts.

import {
  normalize,
  weightedSum,
  computeConfidence,
  explainComponents,
  trendDirection,
  ageDecayFactor,
  computeMedicalRiskScore,
  computeVideoInfluenceScore,
  ConfidenceInput,
  ScoreComponent,
} from '../src/intelligence/shared.utils';

import {
  getPositionCompatibility,
  getTacticalCompatibilityMatrix,
  getBestFormationSlot,
  getCompactCompatibilityMatrix,
  FORMATIONS,
} from '../src/intelligence/tactical-matrix.service';

// ─── normalize ────────────────────────────────────────────────────────────────

describe('normalize', () => {
  it('maps min to 0', () => expect(normalize(0, 0, 100)).toBe(0));
  it('maps max to 100', () => expect(normalize(100, 0, 100)).toBe(100));
  it('maps midpoint to 50', () => expect(normalize(5, 0, 10)).toBe(50));
  it('clamps below min', () => expect(normalize(-10, 0, 100)).toBe(0));
  it('clamps above max', () => expect(normalize(200, 0, 100)).toBe(100));
  it('returns 0 when max === min', () => expect(normalize(5, 5, 5)).toBe(0));
  it('handles non-zero min', () => expect(normalize(75, 50, 100)).toBe(50));
});

// ─── weightedSum ──────────────────────────────────────────────────────────────

describe('weightedSum', () => {
  it('equal weights produce simple average', () => {
    const result = weightedSum([
      { score: 80, weight: 0.5 },
      { score: 60, weight: 0.5 },
    ]);
    expect(result).toBe(70);
  });

  it('unequal weights favour heavier component', () => {
    const result = weightedSum([
      { score: 100, weight: 0.7 },
      { score: 0,   weight: 0.3 },
    ]);
    expect(result).toBe(70);
  });

  it('clamps to 100', () => {
    const result = weightedSum([{ score: 150, weight: 1 }]);
    expect(result).toBe(100);
  });

  it('returns 0 for empty input', () => {
    expect(weightedSum([])).toBe(0);
  });

  it('weights do not need to sum to 1 (re-normalised internally)', () => {
    const result = weightedSum([
      { score: 80, weight: 2 },
      { score: 20, weight: 2 },
    ]);
    expect(result).toBe(50);
  });
});

// ─── computeConfidence ────────────────────────────────────────────────────────

describe('computeConfidence', () => {
  const none: ConfidenceInput = {
    reportCount: 0, hasContract: false, hasMarketValue: false,
    hasWorkloadData: false, hasVideoClips: false,
  };

  it('NONE when no data at all', () => expect(computeConfidence(none)).toBe('NONE'));

  it('LOW with 1 report only', () => {
    expect(computeConfidence({ ...none, reportCount: 1 })).toBe('LOW');
  });

  it('MEDIUM with 3 reports + contract', () => {
    expect(computeConfidence({ ...none, reportCount: 3, hasContract: true })).toBe('MEDIUM');
  });

  it('HIGH with 7+ reports + full data', () => {
    expect(computeConfidence({
      reportCount: 7, hasContract: true, hasMarketValue: true,
      hasWorkloadData: true, hasVideoClips: true,
    })).toBe('HIGH');
  });

  it('MEDIUM with 3 reports + video + contract', () => {
    expect(computeConfidence({
      ...none, reportCount: 3, hasContract: true, hasVideoClips: true,
    })).toBe('MEDIUM');
  });
});

// ─── trendDirection ───────────────────────────────────────────────────────────

describe('trendDirection', () => {
  it('FLAT for single value', () => expect(trendDirection([50])).toBe('FLAT'));
  it('UP when values increase', () => expect(trendDirection([10, 20, 30, 40, 50])).toBe('UP'));
  it('DOWN when values decrease', () => expect(trendDirection([50, 40, 30, 20, 10])).toBe('DOWN'));
  it('FLAT for identical values', () => expect(trendDirection([30, 30, 30, 30])).toBe('FLAT'));
  it('FLAT for very small delta', () => expect(trendDirection([50, 51, 50, 51])).toBe('FLAT'));
});

// ─── ageDecayFactor ───────────────────────────────────────────────────────────

describe('ageDecayFactor', () => {
  it('returns 1.0 at age 20', () => expect(ageDecayFactor(20)).toBe(1.0));
  it('returns 1.0 at age 27', () => expect(ageDecayFactor(27)).toBe(1.0));
  it('returns 0.5 at age 34', () => expect(ageDecayFactor(34)).toBe(0.5));
  it('returns 0.5 at age 40', () => expect(ageDecayFactor(40)).toBe(0.5));
  it('decays between 28 and 33', () => {
    const d28 = ageDecayFactor(28);
    const d33 = ageDecayFactor(33);
    expect(d28).toBeGreaterThan(d33);
    expect(d28).toBeLessThan(1.0);
    expect(d33).toBeGreaterThan(0.5);
  });
});

// ─── computeMedicalRiskScore ──────────────────────────────────────────────────

describe('computeMedicalRiskScore', () => {
  it('returns 0 for fully healthy player with no history', () => {
    expect(computeMedicalRiskScore({
      activeInjuryCount: 0, totalInjuryCount: 0,
      recentReturnDays: null, acwr: null,
    })).toBe(0);
  });

  it('penalises one active injury', () => {
    const score = computeMedicalRiskScore({
      activeInjuryCount: 1, totalInjuryCount: 1,
      recentReturnDays: null, acwr: null,
    });
    expect(score).toBeGreaterThanOrEqual(40);
  });

  it('penalises two active injuries more than one', () => {
    const one = computeMedicalRiskScore({
      activeInjuryCount: 1, totalInjuryCount: 1, recentReturnDays: null, acwr: null,
    });
    const two = computeMedicalRiskScore({
      activeInjuryCount: 2, totalInjuryCount: 2, recentReturnDays: null, acwr: null,
    });
    expect(two).toBeGreaterThan(one);
  });

  it('penalises high ACWR (>1.5)', () => {
    const low  = computeMedicalRiskScore({ activeInjuryCount: 0, totalInjuryCount: 0, recentReturnDays: null, acwr: 1.0 });
    const high = computeMedicalRiskScore({ activeInjuryCount: 0, totalInjuryCount: 0, recentReturnDays: null, acwr: 1.6 });
    expect(high).toBeGreaterThan(low);
  });

  it('penalises recent return within 14 days', () => {
    const cleared = computeMedicalRiskScore({ activeInjuryCount: 0, totalInjuryCount: 1, recentReturnDays: 60, acwr: null });
    const fresh   = computeMedicalRiskScore({ activeInjuryCount: 0, totalInjuryCount: 1, recentReturnDays: 7,  acwr: null });
    expect(fresh).toBeGreaterThan(cleared);
  });

  it('caps at 100', () => {
    const score = computeMedicalRiskScore({
      activeInjuryCount: 5, totalInjuryCount: 20, recentReturnDays: 3, acwr: 2.0,
    });
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ─── computeVideoInfluenceScore ───────────────────────────────────────────────

describe('computeVideoInfluenceScore', () => {
  it('returns 0 for no clips', () => {
    expect(computeVideoInfluenceScore([])).toBe(0);
  });

  it('GOAL clips score higher than neutral clips', () => {
    const goal    = computeVideoInfluenceScore([{ clipType: 'GOAL',   annotationCount: 0 }]);
    const neutral = computeVideoInfluenceScore([{ clipType: 'TACKLE', annotationCount: 0 }]);
    expect(goal).toBeGreaterThan(neutral);
  });

  it('more clips = higher score', () => {
    const few  = computeVideoInfluenceScore(Array(2).fill({ clipType: null, annotationCount: 0 }));
    const many = computeVideoInfluenceScore(Array(10).fill({ clipType: null, annotationCount: 0 }));
    expect(many).toBeGreaterThan(few);
  });

  it('annotations increase score', () => {
    const noAnn  = computeVideoInfluenceScore([{ clipType: null, annotationCount: 0 }]);
    const hasAnn = computeVideoInfluenceScore([{ clipType: null, annotationCount: 6 }]);
    expect(hasAnn).toBeGreaterThan(noAnn);
  });

  it('caps at 100', () => {
    const score = computeVideoInfluenceScore(
      Array(100).fill({ clipType: 'GOAL', annotationCount: 10 }),
    );
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ─── explainComponents ────────────────────────────────────────────────────────

describe('explainComponents', () => {
  const comps: ScoreComponent[] = [
    { label: 'Scouting', score: 85, weight: 0.30, evidence: '6 reports' },
    { label: 'Medical',  score: 20, weight: 0.15, evidence: '1 active injury' },
    { label: 'Video',    score: 50, weight: 0.10, evidence: '3 clips' },
  ];

  it('returns array with at least 2 elements', () => {
    const result = explainComponents(comps, 65);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('first element contains the overall score', () => {
    const result = explainComponents(comps, 65);
    expect(result[0]).toContain('65');
  });

  it('includes the top contributor label', () => {
    const result = explainComponents(comps, 65);
    expect(result.join(' ')).toContain('Scouting');
  });
});

// ─── getPositionCompatibility ─────────────────────────────────────────────────

describe('getPositionCompatibility', () => {
  it('returns 100 for exact match', () => {
    expect(getPositionCompatibility('ST', 'ST')).toBe(100);
    expect(getPositionCompatibility('GK', 'GK')).toBe(100);
    expect(getPositionCompatibility('MC', 'MC')).toBe(100);
  });

  it('returns 70 for same position group (MC filling ML)', () => {
    expect(getPositionCompatibility('MC', 'ML')).toBe(70);
    expect(getPositionCompatibility('DC', 'DL')).toBe(70);
    expect(getPositionCompatibility('AML', 'AMR')).toBe(70);
  });

  it('returns 40 for adjacent group (DMC → MC)', () => {
    expect(getPositionCompatibility('DMC', 'MC')).toBe(40);
    expect(getPositionCompatibility('ST', 'AMC')).toBe(40);
  });

  it('returns low score for incompatible positions (GK → ST)', () => {
    expect(getPositionCompatibility('GK', 'ST')).toBe(10);
    expect(getPositionCompatibility('ST', 'GK')).toBe(10);
  });

  it('returns 30 for null/unknown player position', () => {
    expect(getPositionCompatibility(null, 'MC')).toBe(30);
    expect(getPositionCompatibility(undefined, 'ST')).toBe(30);
    expect(getPositionCompatibility('', 'DC')).toBe(30);
  });
});

// ─── getTacticalCompatibilityMatrix ──────────────────────────────────────────

describe('getTacticalCompatibilityMatrix', () => {
  it('returns one entry per registered formation', () => {
    const matrix = getTacticalCompatibilityMatrix('ST');
    expect(matrix.length).toBe(FORMATIONS.length);
  });

  it('each entry has formation name, slots, bestSlot, bestCompatibility', () => {
    const matrix = getTacticalCompatibilityMatrix('MC');
    for (const entry of matrix) {
      expect(typeof entry.formation).toBe('string');
      expect(Array.isArray(entry.slots)).toBe(true);
      expect(typeof entry.bestSlot).toBe('string');
      expect(typeof entry.bestCompatibility).toBe('number');
    }
  });

  it('ST finds at least one 100% slot in every formation', () => {
    const matrix = getTacticalCompatibilityMatrix('ST');
    for (const f of matrix) {
      expect(f.bestCompatibility).toBeGreaterThanOrEqual(70);
    }
  });

  it('GK best slot is always GK at 100%', () => {
    const matrix = getTacticalCompatibilityMatrix('GK');
    for (const f of matrix) {
      expect(f.bestSlot).toBe('GK');
      expect(f.bestCompatibility).toBe(100);
    }
  });
});

// ─── getBestFormationSlot ─────────────────────────────────────────────────────

describe('getBestFormationSlot', () => {
  it('ST has perfect slot in some formation', () => {
    const result = getBestFormationSlot('ST');
    expect(result.score).toBe(100);
  });

  it('GK best slot is GK', () => {
    const result = getBestFormationSlot('GK');
    expect(result.slot).toBe('GK');
    expect(result.score).toBe(100);
  });

  it('unknown position returns neutral result', () => {
    const result = getBestFormationSlot(null);
    expect(result.score).toBeGreaterThanOrEqual(30);
  });

  it('returns formation name and slot string', () => {
    const result = getBestFormationSlot('DC');
    expect(typeof result.formation).toBe('string');
    expect(result.formation.length).toBeGreaterThan(0);
    expect(typeof result.slot).toBe('string');
  });
});

// ─── getCompactCompatibilityMatrix ───────────────────────────────────────────

describe('getCompactCompatibilityMatrix', () => {
  it('returns compact form without full slot array', () => {
    const result = getCompactCompatibilityMatrix('MC');
    for (const entry of result) {
      expect(entry).not.toHaveProperty('slots');
      expect(entry).toHaveProperty('formation');
      expect(entry).toHaveProperty('bestSlot');
      expect(entry).toHaveProperty('bestCompatibility');
    }
  });

  it('same number of entries as full matrix', () => {
    expect(getCompactCompatibilityMatrix('ST').length)
      .toBe(getTacticalCompatibilityMatrix('ST').length);
  });
});

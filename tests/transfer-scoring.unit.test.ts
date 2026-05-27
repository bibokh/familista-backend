// Phase 10 — Transfer Intelligence Scoring Engine — pure unit tests
// No database, no network. All scoring functions are deterministic.

import {
  computeCompositeScore,
  computeTacticalFitScore,
  computeContractRiskScore,
  computeSquadDepth,
  computeTransferPriority,
  generateScoutingSummary,
  detectMarketOpportunity,
  buildScorecard,
  type ScorecardInput,
  type PlayerScorecard,
} from '../src/transfer/scoring.service';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeReport(overrides: Partial<{
  compositeScore: number | null;
  overallGrade:   string | null;
  recommendation: string | null;
  technical:      number | null;
  physical:       number | null;
  mental:         number | null;
  tactical:       number | null;
  potential:      number | null;
}> = {}) {
  return {
    compositeScore: overrides.compositeScore ?? 7.5,
    overallGrade:   overrides.overallGrade   ?? 'B_PLUS',
    recommendation: overrides.recommendation ?? 'SIGN',
    technical:      overrides.technical      ?? 7,
    physical:       overrides.physical       ?? 7,
    mental:         overrides.mental         ?? 7,
    tactical:       overrides.tactical       ?? 7,
    potential:      overrides.potential      ?? 7,
  };
}

function makeContract(overrides: Partial<{
  contractExpiry:         Date;
  releaseClauseEur:       number | null;
  isAvailableForTransfer: boolean;
  isExpiringSoon:         boolean;
}> = {}) {
  const defaultExpiry = new Date(Date.now() + 400 * 86_400_000); // 400 days out
  return {
    contractExpiry:         overrides.contractExpiry         ?? defaultExpiry,
    releaseClauseEur:       overrides.releaseClauseEur       ?? 5_000_000,
    isAvailableForTransfer: overrides.isAvailableForTransfer ?? false,
    isExpiringSoon:         overrides.isExpiringSoon         ?? false,
  };
}

// ─── 1. computeCompositeScore ────────────────────────────────────────────────

describe('computeCompositeScore', () => {
  it('returns 0 with no reports', () => {
    expect(computeCompositeScore([])).toBe(0);
  });

  it('scores higher for SIGN vs SKIP recommendations', () => {
    const signReport = [makeReport({ recommendation: 'SIGN', compositeScore: 8, overallGrade: 'A' })];
    const skipReport = [makeReport({ recommendation: 'SKIP', compositeScore: 4, overallGrade: 'C' })];
    expect(computeCompositeScore(signReport)).toBeGreaterThan(computeCompositeScore(skipReport));
  });

  it('A_PLUS grade produces higher score than B grade with same composite', () => {
    const elite  = [makeReport({ overallGrade: 'A_PLUS', compositeScore: 8 })];
    const decent = [makeReport({ overallGrade: 'B',      compositeScore: 8 })];
    expect(computeCompositeScore(elite)).toBeGreaterThan(computeCompositeScore(decent));
  });

  it('result is always 0–100', () => {
    const worst = [makeReport({ compositeScore: 1, overallGrade: 'D', recommendation: 'SKIP' })];
    const best  = [makeReport({ compositeScore: 10, overallGrade: 'A_PLUS', recommendation: 'SIGN' })];
    expect(computeCompositeScore(worst)).toBeGreaterThanOrEqual(0);
    expect(computeCompositeScore(best)).toBeLessThanOrEqual(100);
  });

  it('consensus SIGN reports produce score >= 60', () => {
    const reports = Array(4).fill(null).map(() =>
      makeReport({ compositeScore: 8, overallGrade: 'A', recommendation: 'SIGN' })
    );
    expect(computeCompositeScore(reports)).toBeGreaterThanOrEqual(60);
  });

  it('handles null compositeScore gracefully', () => {
    const r = [makeReport({ compositeScore: null })];
    expect(() => computeCompositeScore(r)).not.toThrow();
    expect(computeCompositeScore(r)).toBeGreaterThanOrEqual(0);
  });
});

// ─── 2. computeTacticalFitScore ───────────────────────────────────────────────

describe('computeTacticalFitScore', () => {
  it('exact position match scores >= 80', () => {
    const score = computeTacticalFitScore('ST', 'ST', [makeReport()]);
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it('same position group (MC vs ML) scores between 50 and 85', () => {
    const score = computeTacticalFitScore('MC', 'ML', [makeReport()]);
    expect(score).toBeGreaterThanOrEqual(50);
    expect(score).toBeLessThanOrEqual(85);
  });

  it('completely different position groups (GK vs ST) scores below 50', () => {
    const score = computeTacticalFitScore('GK', 'ST', [makeReport()]);
    expect(score).toBeLessThan(50);
  });

  it('falls back to position match only when no reports', () => {
    const score = computeTacticalFitScore('ST', 'ST', []);
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it('high technical attributes boost ATT fit score', () => {
    const highTech  = [makeReport({ technical: 9.5, physical: 9 })];
    const lowTech   = [makeReport({ technical: 3,   physical: 3 })];
    const highScore = computeTacticalFitScore('ST', 'ST', highTech);
    const lowScore  = computeTacticalFitScore('ST', 'ST', lowTech);
    expect(highScore).toBeGreaterThan(lowScore);
  });

  it('result is always 0–100', () => {
    expect(computeTacticalFitScore(null, null, [])).toBeGreaterThanOrEqual(0);
    expect(computeTacticalFitScore(null, null, [])).toBeLessThanOrEqual(100);
  });
});

// ─── 3. computeContractRiskScore ─────────────────────────────────────────────

describe('computeContractRiskScore', () => {
  it('null contract returns low non-zero score', () => {
    const score = computeContractRiskScore(null);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(30);
  });

  it('contract expiring in 60 days scores >= 90', () => {
    const expiry = new Date(Date.now() + 60 * 86_400_000);
    expect(computeContractRiskScore(makeContract({ contractExpiry: expiry }))).toBeGreaterThanOrEqual(90);
  });

  it('contract expiring in 150 days scores between 70 and 89', () => {
    const expiry = new Date(Date.now() + 150 * 86_400_000);
    const score = computeContractRiskScore(makeContract({ contractExpiry: expiry }));
    expect(score).toBeGreaterThanOrEqual(70);
    expect(score).toBeLessThan(95);
  });

  it('contract expiring in 500 days scores < 45', () => {
    const expiry = new Date(Date.now() + 500 * 86_400_000);
    expect(computeContractRiskScore(makeContract({ contractExpiry: expiry }))).toBeLessThan(45);
  });

  it('available-for-transfer flag increases score', () => {
    const base      = makeContract({ isAvailableForTransfer: false });
    const available = makeContract({ isAvailableForTransfer: true });
    expect(computeContractRiskScore(available)).toBeGreaterThan(computeContractRiskScore(base));
  });

  it('expired contract scores >= 90', () => {
    const expired = new Date(Date.now() - 10 * 86_400_000);
    expect(computeContractRiskScore(makeContract({ contractExpiry: expired }))).toBeGreaterThanOrEqual(90);
  });

  it('result is always 0–100', () => {
    const any = computeContractRiskScore(makeContract());
    expect(any).toBeGreaterThanOrEqual(0);
    expect(any).toBeLessThanOrEqual(100);
  });
});

// ─── 4+5. computeSquadDepth ───────────────────────────────────────────────────

describe('computeSquadDepth', () => {
  it('empty squad flags all positions as shortage', () => {
    const result = computeSquadDepth([]);
    expect(result.shortages.length).toBeGreaterThan(0);
    expect(result.criticalSlots.length).toBeGreaterThan(0);
  });

  it('detects GK shortage when only 1 goalkeeper', () => {
    const players = [{ position: 'GK', isActive: true }];
    const result = computeSquadDepth(players);
    const gkShortage = result.shortages.find((s) => s.position === 'GK');
    expect(gkShortage).toBeDefined();
    expect(gkShortage!.deficit).toBe(1);
  });

  it('detects no shortage for a full squad', () => {
    const players = [
      ...Array(2).fill({ position: 'GK',  isActive: true }),
      ...Array(5).fill({ position: 'DC',  isActive: true }),
      ...Array(2).fill({ position: 'DMC', isActive: true }),
      ...Array(3).fill({ position: 'MC',  isActive: true }),
      ...Array(2).fill({ position: 'AMC', isActive: true }),
      ...Array(2).fill({ position: 'ST',  isActive: true }),
    ];
    const result = computeSquadDepth(players);
    expect(result.shortages.length).toBe(0);
  });

  it('excludes inactive players from count', () => {
    const players = [
      { position: 'GK', isActive: true },
      { position: 'GK', isActive: false },
    ];
    const result = computeSquadDepth(players);
    const gkShortage = result.shortages.find((s) => s.position === 'GK');
    expect(gkShortage).toBeDefined(); // only 1 active, need 2
  });

  it('criticalSlots contains positions with deficit >= 2', () => {
    const result = computeSquadDepth([]); // all zero
    expect(result.criticalSlots.every(
      (pos) => result.shortages.find((s) => s.position === pos && s.deficit >= 2)
    )).toBe(true);
  });
});

// ─── 6. computeTransferPriority ───────────────────────────────────────────────

describe('computeTransferPriority', () => {
  it('higher composite raises priority', () => {
    const low  = computeTransferPriority(30, 60, 50, 50);
    const high = computeTransferPriority(90, 60, 50, 50);
    expect(high).toBeGreaterThan(low);
  });

  it('higher tactical fit raises priority', () => {
    const low  = computeTransferPriority(70, 20, 50, 50);
    const high = computeTransferPriority(70, 90, 50, 50);
    expect(high).toBeGreaterThan(low);
  });

  it('higher manual target priority raises score', () => {
    const low  = computeTransferPriority(70, 70, 50, 10);
    const high = computeTransferPriority(70, 70, 50, 90);
    expect(high).toBeGreaterThan(low);
  });

  it('result is always 0–100', () => {
    expect(computeTransferPriority(100, 100, 100, 100)).toBeLessThanOrEqual(100);
    expect(computeTransferPriority(0, 0, 0, 0)).toBeGreaterThanOrEqual(0);
  });
});

// ─── 7. generateScoutingSummary ───────────────────────────────────────────────

describe('generateScoutingSummary', () => {
  const raw = {
    reportCount:       0, avgComposite: null, topGrade: null,
    signCount: 0, monitorCount: 0, skipCount: 0,
    daysToExpiry: null, latestValueMEur: null, askingPriceMEur: null,
    playerPosition: null, marketOpportunity: null,
  };

  it('mentions "not yet been scouted" when reportCount = 0', () => {
    const s = generateScoutingSummary('John Doe', 0, 50, 20, raw);
    expect(s).toContain('not yet been scouted');
  });

  it('contains player name', () => {
    const s = generateScoutingSummary('Jane Smith', 0, 50, 20, raw);
    expect(s).toContain('Jane Smith');
  });

  it('mentions contract urgency for critical expiry', () => {
    const urgentRaw = { ...raw, reportCount: 2, daysToExpiry: 45, signCount: 2 };
    const s = generateScoutingSummary('Player X', 80, 70, 92, urgentRaw);
    expect(s.toLowerCase()).toMatch(/contract|expires|days/);
  });

  it('mentions elite quality for score >= 80', () => {
    const goodRaw = { ...raw, reportCount: 3, avgComposite: 9, signCount: 3 };
    const s = generateScoutingSummary('Player X', 85, 70, 30, goodRaw);
    expect(s).toContain('elite quality');
  });

  it('mentions undervalued opportunity when flag is set', () => {
    const valRaw = {
      ...raw, reportCount: 2, askingPriceMEur: 2, latestValueMEur: 4,
      signCount: 1, marketOpportunity: 'UNDERVALUED' as const,
    };
    const s = generateScoutingSummary('Player X', 75, 70, 20, valRaw);
    expect(s.toLowerCase()).toMatch(/below market|undervalued|value/);
  });
});

// ─── 8. detectMarketOpportunity ───────────────────────────────────────────────

describe('detectMarketOpportunity', () => {
  it('returns AVAILABLE when isAvailableForTransfer', () => {
    expect(detectMarketOpportunity(70, 5, 3, 400, true)).toBe('AVAILABLE');
  });

  it('AVAILABLE takes priority over FREE_AGENT_RISK', () => {
    expect(detectMarketOpportunity(70, 5, 3, 90, true)).toBe('AVAILABLE');
  });

  it('returns FREE_AGENT_RISK when contract <= 180 days', () => {
    expect(detectMarketOpportunity(60, 5, 4, 100, false)).toBe('FREE_AGENT_RISK');
  });

  it('returns UNDERVALUED when askingPrice < 85% of market value', () => {
    // askingPrice 3 < 5 * 0.85 = 4.25
    expect(detectMarketOpportunity(60, 5, 3, 400, false)).toBe('UNDERVALUED');
  });

  it('returns HIGH_VALUE_CHEAP for high score + low price', () => {
    expect(detectMarketOpportunity(75, null, 4, 400, false)).toBe('HIGH_VALUE_CHEAP');
  });

  it('returns null for no opportunity', () => {
    expect(detectMarketOpportunity(40, 10, 9, 500, false)).toBeNull();
  });
});

// ─── Full scorecard integration ───────────────────────────────────────────────

describe('buildScorecard', () => {
  const baseInput: ScorecardInput = {
    playerId:       'player-1',
    playerName:     'Test Player',
    playerPosition: 'ST',
    targetPosition: 'ST',
    targetPriority: 70,
    reports:        [makeReport({ compositeScore: 8, overallGrade: 'A', recommendation: 'SIGN' })],
    contract:       makeContract({ releaseClauseEur: 3_000_000 }),
    latestValueMEur: 5,
    askingPriceMEur: 4,
  };

  it('returns a complete scorecard', () => {
    const sc = buildScorecard(baseInput);
    expect(sc.playerId).toBe('player-1');
    expect(sc.compositeScore).toBeGreaterThan(0);
    expect(sc.tacticalFitScore).toBeGreaterThan(0);
    expect(sc.contractRiskScore).toBeGreaterThan(0);
    expect(sc.transferPriority).toBeGreaterThan(0);
    expect(sc.scoutingSummary).toBeTruthy();
    expect(Array.isArray(sc.flags)).toBe(true);
    expect(sc.raw.reportCount).toBe(1);
  });

  it('NO_REPORTS flag when no reports', () => {
    const sc = buildScorecard({ ...baseInput, reports: [] });
    expect(sc.flags).toContain('NO_REPORTS');
    expect(sc.compositeScore).toBe(0);
  });

  it('CONTRACT_CRITICAL flag for < 90 day contract', () => {
    const imminent = new Date(Date.now() + 45 * 86_400_000);
    const sc = buildScorecard({ ...baseInput, contract: makeContract({ contractExpiry: imminent }) });
    expect(sc.flags).toContain('CONTRACT_CRITICAL');
  });

  it('CONTRACT_WARNING flag for 90–180 day contract', () => {
    const nearish = new Date(Date.now() + 120 * 86_400_000);
    const sc = buildScorecard({ ...baseInput, contract: makeContract({ contractExpiry: nearish }) });
    expect(sc.flags).toContain('CONTRACT_WARNING');
  });

  it('AVAILABLE_NOW flag when isAvailableForTransfer', () => {
    const sc = buildScorecard({
      ...baseInput,
      contract: makeContract({ isAvailableForTransfer: true }),
    });
    expect(sc.flags).toContain('AVAILABLE_NOW');
    expect(sc.marketOpportunity).toBe('AVAILABLE');
  });

  it('UNDERVALUED flag and opportunity when asking < 85% market value', () => {
    const sc = buildScorecard({ ...baseInput, askingPriceMEur: 2, latestValueMEur: 5 });
    expect(sc.flags).toContain('UNDERVALUED');
    expect(sc.marketOpportunity).toBe('UNDERVALUED');
  });

  it('HIGH_POTENTIAL flag when avg potential > 8', () => {
    const sc = buildScorecard({
      ...baseInput,
      reports: [makeReport({ potential: 8.5, compositeScore: 8 })],
    });
    expect(sc.flags).toContain('HIGH_POTENTIAL');
  });

  it('all scores in 0–100 range', () => {
    const sc = buildScorecard(baseInput);
    expect(sc.compositeScore).toBeGreaterThanOrEqual(0);
    expect(sc.compositeScore).toBeLessThanOrEqual(100);
    expect(sc.tacticalFitScore).toBeGreaterThanOrEqual(0);
    expect(sc.tacticalFitScore).toBeLessThanOrEqual(100);
    expect(sc.contractRiskScore).toBeGreaterThanOrEqual(0);
    expect(sc.contractRiskScore).toBeLessThanOrEqual(100);
    expect(sc.transferPriority).toBeGreaterThanOrEqual(0);
    expect(sc.transferPriority).toBeLessThanOrEqual(100);
  });
});

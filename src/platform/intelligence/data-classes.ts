// What every piece of data the AI layer touches IS, in one place
// ─────────────────────────────────────────────────────────────────────────────
// Cyber Defense, R3 + R8. The same four classes the agent tool registry already
// uses (agents.ts), so an agent's reach and a prompt's content are measured in
// the same units:
//
//   PUBLIC        anyone may see it: a competition, an opponent's name.
//   INTERNAL      the club's own operational data: ids, counts, ratings.
//   CONFIDENTIAL  commercial or personal, but not sensitive: money, contracts,
//                 a person's age or workload.
//   RESTRICTED    special-category or child data: medical and injury details,
//                 health-risk scores, minors' personal data. Never leaves the
//                 platform and never trains anything unless the club has said
//                 so (ClubAiDataPolicy), and a minor's never trains anything.
//
// FEATURE_CLASSES classifies every feature the decision engine extracts
// (src/services/ai-feature-extraction.service.ts → types/ai-engine.types.ts).
// A feature that is not listed is treated as RESTRICTED: a new feature is
// withheld until somebody classifies it, never sent because nobody did.
// `tests/ai-egress-r3.unit.test.ts` fails when a feature type gains a key that
// is not listed here.

export type DataClass = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

const ORDER: Record<DataClass, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3 };

/** The highest of several classes. */
export function highest(classes: Iterable<DataClass>): DataClass {
  let top: DataClass = 'PUBLIC';
  for (const c of classes) if (ORDER[c] > ORDER[top]) top = c;
  return top;
}

export const FEATURE_CLASSES: Readonly<Record<string, DataClass>> = Object.freeze({
  // ── player
  playerId: 'INTERNAL',
  age: 'CONFIDENTIAL',
  position: 'INTERNAL',
  overallRating: 'INTERNAL',
  potential: 'INTERNAL',
  condition: 'RESTRICTED',            // physical condition is health data
  isInjured: 'RESTRICTED',
  contractDaysLeft: 'CONFIDENTIAL',
  marketValue: 'CONFIDENTIAL',
  weeklyWage: 'CONFIDENTIAL',
  recentMatchCount: 'INTERNAL',
  recentMatchRatingAvg: 'INTERNAL',
  recentGoalsPer90: 'INTERNAL',
  recentAssistsPer90: 'INTERNAL',
  recentMinutesPlayed: 'INTERNAL',
  avgPlayerLoad30d: 'CONFIDENTIAL',
  maxPlayerLoad30d: 'CONFIDENTIAL',
  playerLoadDelta14dVs30d: 'CONFIDENTIAL',
  avgRiskScore30d: 'RESTRICTED',      // an injury-risk score is a health inference
  daysSinceLastInjury: 'RESTRICTED',
  injuryCount365d: 'RESTRICTED',
  avgInjurySeverityScore: 'RESTRICTED',
  teamAvgRating: 'INTERNAL',
  positionAvgRating: 'INTERNAL',
  // ── match
  matchId: 'INTERNAL',
  competition: 'PUBLIC',
  scheduledAt: 'PUBLIC',
  isHome: 'PUBLIC',
  daysToMatch: 'PUBLIC',
  opponentName: 'PUBLIC',
  recentResultsForm: 'INTERNAL',
  opponentRecentForm: 'INTERNAL',
  // ── club
  clubId: 'INTERNAL',
  plan: 'CONFIDENTIAL',
  subscriptionStatus: 'CONFIDENTIAL',
  revenue90d: 'CONFIDENTIAL',
  revenuePrior90d: 'CONFIDENTIAL',
  expense90d: 'CONFIDENTIAL',
  netCashFlow90d: 'CONFIDENTIAL',
  playerCount: 'INTERNAL',
  injuredCount: 'INTERNAL',           // a squad-level count names nobody
  injuryRate: 'INTERNAL',
  averageSquadAge: 'INTERNAL',
  wagesPerMonth: 'CONFIDENTIAL',
  contractsExpiringNext180d: 'INTERNAL',
  overdueViolations: 'INTERNAL',
  // ── franchise
  unitId: 'INTERNAL',
  level: 'INTERNAL',
  status: 'INTERNAL',
  clubsActive: 'INTERNAL',
  clubsTotal: 'INTERNAL',
  revenueGrowthPct: 'CONFIDENTIAL',
  violationsOpen: 'INTERNAL',
  contractsExpiringSoon: 'INTERNAL',
  complianceScore: 'INTERNAL',
  childUnits: 'INTERNAL',
  hasExclusiveRights: 'CONFIDENTIAL',
  // ── investor
  investorId: 'INTERNAL',
  type: 'INTERNAL',
  kycStatus: 'CONFIDENTIAL',
  totalCommitted: 'CONFIDENTIAL',
  totalFunded: 'CONFIDENTIAL',
  totalRealized: 'CONFIDENTIAL',
  currentValue: 'CONFIDENTIAL',
  multiple: 'CONFIDENTIAL',
  netIrrEstimate: 'CONFIDENTIAL',
  portfolioConcentration: 'CONFIDENTIAL',
  exposureByEntityType: 'CONFIDENTIAL',
  daysSinceLastInvestment: 'CONFIDENTIAL',
  // ── investment entity
  entityId: 'INTERNAL',
  entityType: 'INTERNAL',
  currentValuation: 'CONFIDENTIAL',
  totalSharesIssued: 'CONFIDENTIAL',
  fullyDilutedShares: 'CONFIDENTIAL',
  activeRoundCount: 'CONFIDENTIAL',
  totalRaisedToDate: 'CONFIDENTIAL',
  growthPct: 'CONFIDENTIAL',
  // ── executive
  platformId: 'INTERNAL',
  platformName: 'INTERNAL',
  totalRevenue90d: 'CONFIDENTIAL',
  totalRevenuePrior90d: 'CONFIDENTIAL',
  activeClubs: 'INTERNAL',
  activeFranchiseUnits: 'INTERNAL',
  activeInvestors: 'INTERNAL',
  totalAum: 'CONFIDENTIAL',
  openCriticalViolations: 'INTERNAL',
  expansionOpportunityCount: 'INTERNAL',
});

/** A feature's class; anything unlisted is RESTRICTED. */
export function classOf(feature: string): DataClass {
  return FEATURE_CLASSES[feature] ?? 'RESTRICTED';
}

export interface FilteredFeatures<T> {
  features: Partial<T>;
  /** Names of the features withheld. */
  withheld: string[];
  /** The classes of what was kept. */
  classes: DataClass[];
}

/**
 * Keep only the features whose class is at most `ceiling`. Used for egress
 * (ceiling CONFIDENTIAL unless the club allows RESTRICTED) and for training.
 */
export function filterFeatures<T extends Record<string, unknown>>(features: T, ceiling: DataClass): FilteredFeatures<T> {
  const kept: Partial<T> = {};
  const withheld: string[] = [];
  const classes = new Set<DataClass>();
  for (const [k, v] of Object.entries(features)) {
    const c = classOf(k);
    if (ORDER[c] <= ORDER[ceiling]) { (kept as Record<string, unknown>)[k] = v; classes.add(c); }
    else withheld.push(k);
  }
  return { features: kept, withheld, classes: [...classes] };
}

/**
 * The decision engine's score factors (src/lib/ai-scoring.lib.ts and the
 * domain decision services), by the class of the data each one is computed
 * from. A factor about one player's health is RESTRICTED; a squad-level count
 * is INTERNAL. Unlisted factors are RESTRICTED.
 */
export const FACTOR_CLASSES: Readonly<Record<string, DataClass>> = Object.freeze({
  // one player's health
  currently_injured: 'RESTRICTED',
  low_condition: 'RESTRICTED',
  recent_injury_history: 'RESTRICTED',
  gps_risk_signal: 'RESTRICTED',
  recurring_injuries: 'RESTRICTED',
  condition_drop: 'RESTRICTED',
  recovery_priority: 'RESTRICTED',
  // age, workload, money
  age_factor: 'CONFIDENTIAL',
  age_curve: 'CONFIDENTIAL',
  aging_curve: 'CONFIDENTIAL',
  young_age: 'CONFIDENTIAL',
  load_spike: 'CONFIDENTIAL',
  cumulative_load: 'CONFIDENTIAL',
  high_minutes: 'CONFIDENTIAL',
  contract_running_down: 'CONFIDENTIAL',
  wage_pressure: 'CONFIDENTIAL',
  wage_revenue_ratio: 'CONFIDENTIAL',
  wage_to_revenue_ratio: 'CONFIDENTIAL',
  capital_idle: 'CONFIDENTIAL',
  concentration: 'CONFIDENTIAL',
  over_concentration: 'CONFIDENTIAL',
  under_diversified: 'CONFIDENTIAL',
  kyc_status: 'CONFIDENTIAL',
  multiple: 'CONFIDENTIAL',
  net_irr_estimate: 'CONFIDENTIAL',
  total_aum: 'CONFIDENTIAL',
  negative_cash_flow: 'CONFIDENTIAL',
  positive_cash_flow: 'CONFIDENTIAL',
  negative_runway: 'CONFIDENTIAL',
  revenue_growth: 'CONFIDENTIAL',
  revenue_growth_pct: 'CONFIDENTIAL',
  revenue_signal: 'CONFIDENTIAL',
  growth_pct: 'CONFIDENTIAL',
  platform_growth_pct: 'CONFIDENTIAL',
  value_per_revenue: 'CONFIDENTIAL',
  subscription_status: 'CONFIDENTIAL',
  active_round: 'CONFIDENTIAL',
  // performance, squad-level counts, operations
  active_franchise_units: 'INTERNAL',
  active_investors: 'INTERNAL',
  avg_squad_condition: 'INTERNAL',
  away_venue: 'INTERNAL',
  below_squad_quality: 'INTERNAL',
  club_activation_rate: 'INTERNAL',
  clubs_active: 'INTERNAL',
  compliance_score: 'INTERNAL',
  contracts_expiring: 'INTERNAL',
  critical_violations: 'INTERNAL',
  development_headroom: 'INTERNAL',
  expansion_opportunities: 'INTERNAL',
  fatigued_players: 'INTERNAL',
  form: 'INTERNAL',
  form_drop: 'INTERNAL',
  form_signal: 'INTERNAL',
  high_injury_rate: 'INTERNAL',
  home_advantage: 'INTERNAL',
  home_venue: 'INTERNAL',
  injured_players: 'INTERNAL',
  insufficient_eligible_players: 'INTERNAL',
  limited_role: 'INTERNAL',
  low_compliance: 'INTERNAL',
  low_playing_time: 'INTERNAL',
  many_contracts_expiring: 'INTERNAL',
  many_expiring_contracts: 'INTERNAL',
  no_risk_signals: 'INTERNAL',
  open_violations: 'INTERNAL',
  output_per_90: 'INTERNAL',
  peer_position_gap: 'INTERNAL',
  potential_gap: 'INTERNAL',
  recent_form: 'INTERNAL',
  short_rest: 'INTERNAL',
  short_turnaround: 'INTERNAL',
  squad_size: 'INTERNAL',
  starting_xi_avg_rating: 'INTERNAL',
  upside: 'INTERNAL',
  venue: 'INTERNAL',
  violations_block_expansion: 'INTERNAL',
  violations_open: 'INTERNAL',
});

/** A factor's class; anything unlisted is RESTRICTED. */
export function factorClassOf(name: string): DataClass {
  return FACTOR_CLASSES[name] ?? 'RESTRICTED';
}

/** At most `ceiling`, by the same rule as features. */
export function withinCeiling(c: DataClass, ceiling: DataClass): boolean {
  return ORDER[c] <= ORDER[ceiling];
}

/** A person is a minor until their eighteenth birthday. Unknown age is treated as a minor. */
export function isMinor(dateOfBirth: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!dateOfBirth) return true;
  const d = typeof dateOfBirth === 'string' ? new Date(dateOfBirth) : dateOfBirth;
  if (Number.isNaN(d.getTime())) return true;
  const eighteenth = new Date(Date.UTC(d.getUTCFullYear() + 18, d.getUTCMonth(), d.getUTCDate()));
  return now.getTime() < eighteenth.getTime();
}

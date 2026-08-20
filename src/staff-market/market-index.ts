/**
 * The Coach Exchange's three readings of a technical staff member.
 *
 * Every one of them is a pure function of stored data. Given the same record
 * they return the same number, on every request and on every render — nothing
 * here is seeded by a clock tick, a random draw or a request id, because a
 * market whose figures move when a page is refreshed is not a market.
 *
 * They are deliberately three separate things:
 *
 *   FCI          how strong the professional is
 *   OPPORTUNITY  how attractive hiring him is RIGHT NOW
 *   MOMENTUM     which way his market is moving, from activity that happened
 *
 * FCI is not a salary and not a valuation. A very strong coach who is under a
 * long contract and asking a fortune has a high FCI and a low opportunity; a
 * competent free agent nobody has noticed has a middling FCI and a very high
 * one. That gap is the whole point of the pair.
 */

export type EmploymentStatusName =
  | 'EMPLOYED' | 'OPEN_TO_OFFERS' | 'ACTIVELY_LOOKING'
  | 'FREE_AGENT' | 'CONTRACT_ENDING_SOON' | 'UNAVAILABLE';

/** What a licence is worth as a mark out of a hundred. */
const LICENCE_MARK: Record<string, number> = {
  UEFA_PRO: 100, PRO: 100,
  UEFA_A: 78, A: 78,
  UEFA_B: 56, B: 56,
  UEFA_C: 36, C: 36,
};

// A record with nothing on it still needs a number, and it must be the same
// number every time. This is that number — a deliberate middle, not a guess
// dressed up as a measurement.
export const FCI_NEUTRAL = 40;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export interface FciInput {
  reputation?: number | null;
  level?: number | null;
  yearsExperience?: number | null;
  licenceCode?: string | null;
  trophies?: number | null;
  /** The seven professional marks the evaluation holds, where it holds them. */
  evaluation?: Array<number | null | undefined>;
  /** How many jobs the career record holds, which is a length of service. */
  careerEntries?: number | null;
}

/**
 * FCI — the Familista Coach Index, 1–99.
 *
 * A weighted mean over the components the record actually has, renormalised
 * over the weights of the ones present: a coach with no trophies recorded is
 * not scored as a coach with zero trophies. A record holding nothing at all
 * returns the neutral constant rather than a zero that would read as "bad".
 */
export function fciOf(input: FciInput): number {
  const parts: Array<[number, number]> = []; // [weight, mark out of 100]
  const add = (weight: number, mark: number | null) => {
    if (mark == null || Number.isNaN(mark)) return;
    parts.push([weight, clamp(mark, 0, 100)]);
  };

  add(30, input.reputation ?? null);
  add(14, input.level ?? null);
  // Twenty-five years is a full career; beyond it the mark does not keep rising.
  add(14, input.yearsExperience == null ? null : (clamp(input.yearsExperience, 0, 25) / 25) * 100);
  add(20, input.licenceCode ? (LICENCE_MARK[String(input.licenceCode).toUpperCase()] ?? 20) : null);
  // Eight honours is a decorated career.
  add(10, input.trophies == null ? null : (clamp(input.trophies, 0, 8) / 8) * 100);

  const marks = (input.evaluation ?? []).filter((x): x is number => typeof x === 'number');
  if (marks.length) add(12, marks.reduce((a, b) => a + b, 0) / marks.length);

  // Six posts held is a long professional record.
  add(6, input.careerEntries == null ? null : (clamp(input.careerEntries, 0, 6) / 6) * 100);

  if (!parts.length) return FCI_NEUTRAL;
  const weight = parts.reduce((n, p) => n + p[0], 0);
  const total = parts.reduce((n, p) => n + p[0] * p[1], 0);
  return clamp(Math.round(total / weight), 1, 99);
}

export interface OpportunityInput {
  fci: number;
  employmentStatus: EmploymentStatusName;
  careerIntent?: string | null;
  /** Months until the current contract ends; null when none is recorded. */
  contractMonthsLeft?: number | null;
  wageExpectation?: number | null;
  /** What it would cost to take him — a clause or a compensation figure. */
  compensation?: number | null;
  availableFromMonths?: number | null;
  /** How many clubs are already watching him. */
  demand?: number | null;
}

/**
 * OPPORTUNITY — 0–100, how good a recruitment opportunity he is today.
 *
 * Strength counts, but only for a third of it: the rest is whether he can
 * actually be moved, how soon, and what it would cost. A coach six clubs are
 * already chasing is a worse opportunity than the same coach nobody has
 * noticed, which is what makes a hidden gem findable.
 */
export function opportunityOf(input: OpportunityInput): number {
  // strength — 32
  let n = (clamp(input.fci, 0, 100) / 100) * 32;

  // standing — 30
  const STATUS: Record<EmploymentStatusName, number> = {
    FREE_AGENT: 30, ACTIVELY_LOOKING: 28, OPEN_TO_OFFERS: 22,
    CONTRACT_ENDING_SOON: 18, EMPLOYED: 4, UNAVAILABLE: 0,
  };
  n += STATUS[input.employmentStatus] ?? 4;
  // a stated intent, on top of the standing it produces
  if (input.careerIntent === 'ACTIVELY_LOOKING') n += 3;
  else if (input.careerIntent === 'OPEN_TO_OFFERS') n += 2;

  // how soon he can be had — 15
  const left = input.contractMonthsLeft;
  if (left == null) n += 11;
  else if (left <= 0) n += 15;
  else if (left <= 6) n += 13;
  else if (left <= 12) n += 9;
  else if (left <= 24) n += 5;
  else n += 2;

  // what it would cost to take him — 12
  const fee = input.compensation;
  if (fee == null || fee <= 0) n += 12;
  else if (fee <= 100_000) n += 9;
  else if (fee <= 250_000) n += 6;
  else if (fee <= 500_000) n += 3;
  else n += 1;

  // what he is asking — 8
  const wage = input.wageExpectation;
  if (wage == null) n += 5;
  else if (wage <= 80_000) n += 8;
  else if (wage <= 150_000) n += 6;
  else if (wage <= 250_000) n += 4;
  else n += 2;

  // contested — the more clubs already on him, the worse the opportunity
  const d = input.demand ?? 0;
  if (d >= 6) n -= 7;
  else if (d >= 3) n -= 4;
  else if (d >= 1) n -= 1;

  return clamp(Math.round(n), 0, 100);
}

export interface MomentumInput {
  /** Approaches made for him inside the window. */
  recentApproaches?: number | null;
  /** Shortlist entries opened on him inside the window. */
  recentShortlists?: number | null;
  /** Days since he last changed his own market standing; null if never. */
  daysSinceStatusChange?: number | null;
  /** Days since he lost his last club; null while employed. */
  daysSinceLeftClub?: number | null;
  contractMonthsLeft?: number | null;
  employmentStatus: EmploymentStatusName;
  demand?: number | null;
}

/**
 * MOMENTUM — a signed figure, roughly -9…+12, from activity that HAPPENED.
 *
 * Every term is a count or an age of a stored record, so the arrow only moves
 * when the market moves. Refreshing the page cannot change it.
 */
export function momentumOf(input: MomentumInput): number {
  let n = 0;
  n += clamp(input.recentApproaches ?? 0, 0, 3) * 3;
  n += clamp(input.recentShortlists ?? 0, 0, 3) * 2;

  // Coming onto the market at all is the strongest single move there is.
  const since = input.daysSinceStatusChange;
  if (since != null && since <= 30
    && ['OPEN_TO_OFFERS', 'ACTIVELY_LOOKING'].includes(input.employmentStatus)) n += 4;

  const left = input.daysSinceLeftClub;
  if (left != null && left <= 45) n += 3;

  const months = input.contractMonthsLeft;
  if (months != null && months >= 0 && months <= 3) n += 2;

  if (input.employmentStatus === 'UNAVAILABLE') n -= 4;
  // Nobody watching, nobody asking, and not looking: the market has moved on.
  if (!(input.demand ?? 0) && !(input.recentApproaches ?? 0)
    && input.employmentStatus === 'EMPLOYED') n -= 3;

  return clamp(n, -9, 12);
}

/** RISING / STABLE / DECLINING, from the same figure. */
export function momentumBand(n: number): 'RISING' | 'STABLE' | 'DECLINING' {
  if (n >= 3) return 'RISING';
  if (n <= -2) return 'DECLINING';
  return 'STABLE';
}

/**
 * A hidden gem: strong, unnoticed, and gettable. The three conditions are the
 * whole definition — there is no separate score, so it can never disagree with
 * the two figures it is read from.
 */
export function isHiddenGem(fci: number, opportunity: number, demand: number): boolean {
  return fci >= 62 && demand <= 1 && opportunity >= 55;
}

/**
 * Familista manufacturing — how well a verified supplier fits a request (M7d), from what the Platform Owner recorded
 * about it and what the request froze. Production intelligence from configured data only: nothing is looked up, scored
 * by a model or guessed. A criterion whose record is missing is "not recorded", never assumed met or unmet.
 *
 *   forms      the supplier makes every garment form the request asks for (top, shorts, socks)
 *   minimum    the request's sets reach the supplier's minimum order
 *   leadTime   today plus the supplier's lead time is no later than the date the club needs the kit by
 *
 * Decoration methods are not judged: a request does not record one, so there is nothing to compare them with.
 */

export type Form = 'top' | 'shorts' | 'socks';
/** true: met; false: not met; null: not recorded (on the supplier's side, or the request's). */
export type Met = boolean | null;
export type Overall = 'fits' | 'incomplete' | 'does-not-fit';

export interface FitSupplier { forms: string[]; minOrderSets: number | null; leadTimeDays: number | null }
export interface FitRequest { forms: Form[]; sets: number; neededBy: Date | null }
export interface Fit {
  forms: { met: Met; missing: Form[] };
  minimum: { met: Met; minOrderSets: number | null; sets: number };
  leadTime: { met: Met; leadTimeDays: number | null; readyBy: string | null; neededBy: string | null };
  overall: Overall;
}

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The fit of one supplier to one request, on `today` (a UTC date). Pure: the same records give the same answer. */
export function supplierFit(s: FitSupplier, r: FitRequest, today: Date): Fit {
  const wanted = [...new Set(r.forms)].sort();
  const made = new Set(s.forms);
  const missing = wanted.filter((f) => !made.has(f)) as Form[];
  const forms = { met: s.forms.length ? missing.length === 0 : null, missing: s.forms.length ? missing : [] };

  const minimum = { met: s.minOrderSets === null ? null : r.sets >= s.minOrderSets, minOrderSets: s.minOrderSets, sets: r.sets };

  const readyBy = s.leadTimeDays === null ? null : new Date(today.getTime() + s.leadTimeDays * DAY);
  const leadTime = {
    met: readyBy === null || r.neededBy === null ? null : readyBy.getTime() <= r.neededBy.getTime(),
    leadTimeDays: s.leadTimeDays, readyBy: readyBy ? iso(readyBy) : null, neededBy: r.neededBy ? iso(r.neededBy) : null,
  };

  const all = [forms.met, minimum.met, leadTime.met];
  const overall: Overall = all.includes(false) ? 'does-not-fit' : all.every((m) => m === true) ? 'fits' : 'incomplete';
  return { forms, minimum, leadTime, overall };
}

const RANK: Record<Overall, number> = { fits: 0, incomplete: 1, 'does-not-fit': 2 };
/** Best first: those that fit, then those with something not recorded, then those that do not; then by name. */
export function byFit<T extends { name: string; fit: Fit }>(a: T, b: T): number {
  return RANK[a.fit.overall] - RANK[b.fit.overall] || a.name.localeCompare(b.name, 'en') || 0;
}

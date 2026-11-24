/**
 * Familista Manufacturing (M4) — the request workflow, as one table.
 *
 * Every change to a request is one of these actions, taken by the one kind of actor it names, from the statuses it
 * lists, to the status it names. Nothing else moves a request: the services ask `step()` and refuse what it refuses.
 * Pure and deterministic; pinned whole by tests/manufacturing-state.unit.test.ts.
 *
 *   SUBMITTED ─review→ IN_REVIEW ─quote→ QUOTED ─accept→ ACCEPTED ─order→ ORDERED ─produce→ IN_PRODUCTION ─ship→ SHIPPED ─deliver→ DELIVERED
 *        │                 │               │ └─decline→ DECLINED
 *        └──refuse─────────┴→ REFUSED      └──withdraw (last quotation)→ IN_REVIEW
 *   SUBMITTED, IN_REVIEW, QUOTED ─cancel→ CANCELLED
 *
 * The SUPPLIER actor is reserved for the Supplier Portal: no action names it yet.
 */
import { ManufacturingActorKind, ManufacturingRequestStatus as S } from '@prisma/client';

export type Action = 'submit' | 'review' | 'refuse' | 'quote' | 'withdraw' | 'cancel' | 'decline' | 'accept' | 'order' | 'produce' | 'ship' | 'deliver';

interface Rule { actors: ManufacturingActorKind[]; from: Array<S | null>; to: S | 'same'; note: 'required' | 'optional' | 'none' }

/** The workflow. `same` keeps the status (another quotation on a request already QUOTED). */
export const WORKFLOW: Readonly<Record<Action, Rule>> = Object.freeze({
  submit:   { actors: ['CLUB'],          from: [null],                         to: S.SUBMITTED,     note: 'optional' },
  review:   { actors: ['OWNER'],         from: [S.SUBMITTED],                  to: S.IN_REVIEW,     note: 'optional' },
  refuse:   { actors: ['OWNER'],         from: [S.SUBMITTED, S.IN_REVIEW],     to: S.REFUSED,       note: 'required' },
  quote:    { actors: ['OWNER'],         from: [S.IN_REVIEW, S.QUOTED],        to: S.QUOTED,        note: 'none' },
  withdraw: { actors: ['OWNER'],         from: [S.QUOTED],                     to: 'same',          note: 'required' },
  cancel:   { actors: ['CLUB'],          from: [S.SUBMITTED, S.IN_REVIEW, S.QUOTED], to: S.CANCELLED, note: 'optional' },
  decline:  { actors: ['CLUB'],          from: [S.QUOTED],                     to: S.DECLINED,      note: 'optional' },
  accept:   { actors: ['CLUB'],          from: [S.QUOTED],                     to: S.ACCEPTED,      note: 'none' },
  order:    { actors: ['OWNER'],         from: [S.ACCEPTED],                   to: S.ORDERED,       note: 'required' },
  produce:  { actors: ['OWNER'],         from: [S.ORDERED],                    to: S.IN_PRODUCTION, note: 'optional' },
  ship:     { actors: ['OWNER'],         from: [S.IN_PRODUCTION],              to: S.SHIPPED,       note: 'optional' },
  deliver:  { actors: ['CLUB', 'OWNER'], from: [S.SHIPPED],                    to: S.DELIVERED,     note: 'optional' },
});

/** Statuses a request never leaves. */
export const FINAL: ReadonlySet<S> = new Set([S.DELIVERED, S.CANCELLED, S.DECLINED, S.REFUSED]);

export type StepRefusal = 'not-your-step' | 'wrong-status' | 'note-required';

/** Where `action` takes a request in `from`, for `actor`; or why it may not. A withdrawal's status is the caller's. */
export function step(action: Action, actor: ManufacturingActorKind, from: S | null, note?: string | null): { to: S | 'same' } | { refused: StepRefusal } {
  const rule = WORKFLOW[action];
  if (!rule || !rule.actors.includes(actor)) return { refused: 'not-your-step' };
  if (!rule.from.includes(from)) return { refused: 'wrong-status' };
  if (rule.note === 'required' && !(note && note.trim().length >= 3)) return { refused: 'note-required' };
  return { to: rule.to };
}

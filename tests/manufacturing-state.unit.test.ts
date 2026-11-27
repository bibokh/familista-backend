/**
 * Manufacturing, M4 — the request workflow (src/platform/manufacturing/state.ts), pinned whole.
 *
 * Every action against every actor and every status: what the table allows lands where it says, and everything else is
 * refused with its reason (the negative controls are the other 400-odd combinations). The SUPPLIER actor is reserved and
 * takes no step; the final statuses are left by none.
 */
import { ManufacturingActorKind, ManufacturingRequestStatus as S } from '@prisma/client';
import { FINAL, step, WORKFLOW, type Action } from '../src/platform/manufacturing/state';

const ACTORS: ManufacturingActorKind[] = ['CLUB', 'OWNER', 'SUPPLIER'];
const FROM: Array<S | null> = [null, ...Object.values(S)];
const ACTIONS = Object.keys(WORKFLOW) as Action[];

const EXPECTED: Record<Action, [ManufacturingActorKind[], Array<S | null>, S | 'same']> = {
  submit: [['CLUB'], [null], S.SUBMITTED],
  review: [['OWNER'], [S.SUBMITTED], S.IN_REVIEW],
  refuse: [['OWNER'], [S.SUBMITTED, S.IN_REVIEW], S.REFUSED],
  quote: [['OWNER'], [S.IN_REVIEW, S.QUOTED], S.QUOTED],
  withdraw: [['OWNER'], [S.QUOTED], 'same'],
  cancel: [['CLUB'], [S.SUBMITTED, S.IN_REVIEW, S.QUOTED], S.CANCELLED],
  decline: [['CLUB'], [S.QUOTED], S.DECLINED],
  accept: [['CLUB'], [S.QUOTED], S.ACCEPTED],
  order: [['OWNER'], [S.ACCEPTED], S.ORDERED],
  produce: [['OWNER'], [S.ORDERED], S.IN_PRODUCTION],
  ship: [['OWNER'], [S.IN_PRODUCTION], S.SHIPPED],
  deliver: [['CLUB', 'OWNER'], [S.SHIPPED], S.DELIVERED],
};

describe('the workflow table', () => {
  it('is exactly the documented one', () => {
    expect(ACTIONS.sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const a of ACTIONS) expect([a, WORKFLOW[a].actors, WORKFLOW[a].from, WORKFLOW[a].to]).toEqual([a, ...EXPECTED[a]]);
  });

  it('allows each listed step and refuses every other combination, with the reason', () => {
    let allowed = 0, refused = 0;
    for (const a of ACTIONS) for (const actor of ACTORS) for (const from of FROM) {
      const [actors, froms, to] = EXPECTED[a];
      const r = step(a, actor, from, 'a note long enough');
      if (!actors.includes(actor)) { expect([a, actor, from, r]).toEqual([a, actor, from, { refused: 'not-your-step' }]); refused++; }
      else if (!froms.includes(from)) { expect([a, actor, from, r]).toEqual([a, actor, from, { refused: 'wrong-status' }]); refused++; }
      else { expect([a, actor, from, r]).toEqual([a, actor, from, { to }]); allowed++; }
    }
    expect(allowed).toBe(17);
    expect(refused).toBe(ACTIONS.length * ACTORS.length * FROM.length - 17);
  });

  it('requires a note where the table says, and only there', () => {
    expect(step('refuse', 'OWNER', S.SUBMITTED, null)).toEqual({ refused: 'note-required' });
    expect(step('refuse', 'OWNER', S.SUBMITTED, '  ')).toEqual({ refused: 'note-required' });
    expect(step('order', 'OWNER', S.ACCEPTED, '')).toEqual({ refused: 'note-required' });
    expect(step('withdraw', 'OWNER', S.QUOTED)).toEqual({ refused: 'note-required' });
    expect(step('order', 'OWNER', S.ACCEPTED, 'Confirmed by e-mail with the supplier')).toEqual({ to: S.ORDERED });
    expect(step('accept', 'CLUB', S.QUOTED, null)).toEqual({ to: S.ACCEPTED });
    expect(step('cancel', 'CLUB', S.SUBMITTED)).toEqual({ to: S.CANCELLED });
  });

  it('reserves the supplier: no step is theirs yet', () => {
    for (const a of ACTIONS) for (const from of FROM) expect(step(a, 'SUPPLIER', from, 'note')).toEqual({ refused: 'not-your-step' });
  });

  it('leaves the final statuses by no step, and every other status by at least one', () => {
    for (const s of Object.values(S)) {
      const leaves = ACTIONS.some((a) => ACTORS.some((actor) => { const r = step(a, actor, s, 'a note long enough'); return 'to' in r && r.to !== s && r.to !== 'same'; }));
      expect([s, leaves]).toEqual([s, !FINAL.has(s)]);
    }
  });
});

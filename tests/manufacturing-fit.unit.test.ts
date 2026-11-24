/**
 * M7d — how a verified supplier fits a request: from recorded data only, a missing record never counted either way.
 */
import { byFit, supplierFit, type Fit } from '../src/platform/manufacturing/fit';

const TODAY = new Date('2026-11-24T00:00:00Z');
const day = (s: string) => new Date(s + 'T00:00:00Z');
const kit = { forms: ['top', 'shorts', 'top'] as Array<'top' | 'shorts' | 'socks'>, sets: 30, neededBy: day('2027-01-23') };

describe('supplier fit (M7d)', () => {
  it('fits when it makes every form, the sets reach its minimum and its lead time ends by the date needed', () => {
    const f = supplierFit({ forms: ['top', 'shorts', 'socks'], minOrderSets: 20, leadTimeDays: 45 }, kit, TODAY);
    expect(f).toEqual({
      forms: { met: true, missing: [] },
      minimum: { met: true, minOrderSets: 20, sets: 30 },
      leadTime: { met: true, leadTimeDays: 45, readyBy: '2027-01-08', neededBy: '2027-01-23' },
      overall: 'fits',
    });
  });

  it('names what it does not make, and any one unmet criterion makes it not fit', () => {
    expect(supplierFit({ forms: ['top'], minOrderSets: 1, leadTimeDays: 1 }, kit, TODAY)).toMatchObject({ forms: { met: false, missing: ['shorts'] }, overall: 'does-not-fit' });
    expect(supplierFit({ forms: ['top', 'shorts'], minOrderSets: 31, leadTimeDays: 1 }, kit, TODAY)).toMatchObject({ minimum: { met: false }, overall: 'does-not-fit' });
    // the boundary: ready on the very day needed fits, a day later does not
    expect(supplierFit({ forms: ['top', 'shorts'], minOrderSets: 1, leadTimeDays: 60 }, kit, TODAY).leadTime).toMatchObject({ met: true, readyBy: '2027-01-23' });
    expect(supplierFit({ forms: ['top', 'shorts'], minOrderSets: 1, leadTimeDays: 61 }, kit, TODAY)).toMatchObject({ leadTime: { met: false, readyBy: '2027-01-24' }, overall: 'does-not-fit' });
  });

  it('never counts a missing record as met or unmet: it is "not recorded", and the fit is incomplete', () => {
    const f = supplierFit({ forms: [], minOrderSets: null, leadTimeDays: null }, kit, TODAY);
    expect(f).toEqual({
      forms: { met: null, missing: [] }, minimum: { met: null, minOrderSets: null, sets: 30 },
      leadTime: { met: null, leadTimeDays: null, readyBy: null, neededBy: '2027-01-23' }, overall: 'incomplete',
    });
    // a request without a needed-by date leaves the lead time unjudged, whatever the supplier recorded
    expect(supplierFit({ forms: ['top', 'shorts'], minOrderSets: 1, leadTimeDays: 10 }, { ...kit, neededBy: null }, TODAY))
      .toMatchObject({ leadTime: { met: null, readyBy: '2026-12-04', neededBy: null }, overall: 'incomplete' });
    // an unmet criterion still decides, whatever else is missing
    expect(supplierFit({ forms: ['socks'], minOrderSets: null, leadTimeDays: null }, kit, TODAY).overall).toBe('does-not-fit');
  });

  it('orders the best first: fits, then incomplete, then does not fit; then by name', () => {
    const f = (overall: Fit['overall']) => ({ overall } as Fit);
    const rows = [{ name: 'Zeta', fit: f('fits') }, { name: 'Beta', fit: f('does-not-fit') }, { name: 'Alpha', fit: f('incomplete') }, { name: 'Acme', fit: f('fits') }];
    expect(rows.sort(byFit).map((r) => r.name)).toEqual(['Acme', 'Zeta', 'Alpha', 'Beta']);
  });
});

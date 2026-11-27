/**
 * P5/P6, without a database: the browser's list of plan features is the server's; a plan's price typed in major units
 * becomes minor units in its currency's own digits; and the tech pack's CSV keeps a spreadsheet from running a cell while
 * a number stays a number.
 */
import path from 'path';
import { CLUB_PLAN_FEATURES, FEATURES } from '../src/platform/commercial/features';
import { techPackCsv } from '../src/platform/commercial/tech-pack';
import { PaymentsNotConfiguredError, selectPaymentProvider, paymentsConfiguration } from '../src/platform/commercial/payment-provider';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PLAN = require(path.join(__dirname, '..', 'public/product-design/pd-plan.js'));
const digits = (c: string) => new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits;

describe('plans in the browser are the server’s plans', () => {
  it('names exactly the server’s features, in its order, and the club plan’s', () => {
    expect(PLAN.FEATURES).toEqual([...FEATURES]);
    expect(PLAN.CLUB_FEATURES).toEqual([...CLUB_PLAN_FEATURES]);
  });

  it('sends a price in the currency’s minor units, and no currency or interval for a free plan', () => {
    const base = { key: 'p', audience: 'CREATOR', name: 'P', description: '', features: ['team_kit'], maxProjects: '', maxCollections: '3', maxShares: '', currency: 'EUR', interval: 'MONTH', isDefault: false, active: true, sortOrder: '' };
    expect(PLAN.bodyOf({ ...base, price: '9.90' }, true, digits)).toMatchObject({ key: 'p', audience: 'CREATOR', priceMinor: 990, currency: 'EUR', interval: 'MONTH', maxProjects: null, maxCollections: 3, sortOrder: 0 });
    expect(PLAN.bodyOf({ ...base, price: '9,90' }, true, digits).priceMinor).toBe(990);
    expect(PLAN.bodyOf({ ...base, price: '900', currency: 'jpy' }, false, digits)).toMatchObject({ priceMinor: 900, currency: 'JPY' });
    expect(PLAN.bodyOf({ ...base, price: '900', currency: 'JPY' }, false, digits).key).toBeUndefined();
    expect(PLAN.bodyOf({ ...base, price: '' }, true, digits)).toMatchObject({ priceMinor: null, currency: null, interval: null });
    // what is not a number is kept as one that is not, so the console refuses it instead of sending null (no limit)
    expect(PLAN.bodyOf({ ...base, price: 'nine' }, true, digits).priceMinor).toBeNaN();
    expect(PLAN.bodyOf({ ...base, price: '', maxProjects: 'ten' }, true, digits).maxProjects).toBeNaN();
    expect(PLAN.bodyOf({ ...base, price: '', audience: 'CLUB', maxShares: '4' }, true, digits).maxShares).toBeNull();
  });
});

describe('the tech pack’s CSV', () => {
  const row = { surface: 'Front', element: 'Crest', type: 'text', text: '=HYPERLINK("x")', font: 'Inter', colour: 'Navy', hex: '#112233', xMm: -12.5, yMm: 40, widthMm: 80, heightMm: 20, rotationDeg: -5, printed: true };
  it('writes a formula-looking text as text, a negative position as a number, with a BOM and CRLF', () => {
    const csv = techPackCsv([row, { ...row, text: '+1', element: '@me', xMm: null as unknown as number, printed: false }]);
    const lines = csv.split('\r\n');
    expect(lines[0].charCodeAt(0)).toBe(0xFEFF);
    expect(lines[1]).toBe(`Front,Crest,text,"'=HYPERLINK(""x"")",Inter,Navy,#112233,-12.5,40,80,20,-5,yes`);
    expect(lines[2]).toBe(`Front,'@me,text,'+1,Inter,Navy,#112233,,40,80,20,-5,no`);
    expect(lines[3]).toBe('');
  });
});

describe('payments, as configured today', () => {
  it('has no provider: checkout refuses with PAYMENTS_NOT_CONFIGURED, and an unknown provider name does not change that', () => {
    expect(paymentsConfiguration()).toMatchObject({ configured: false });
    for (const env of [{}, { PAYMENT_PROVIDER: 'stripe' }, { PAYMENT_PROVIDER: 'anything' }]) {
      const p = selectPaymentProvider(env as NodeJS.ProcessEnv);
      expect(p.isConfigured()).toBe(false);
      expect(p.configurationProblem()).toBeTruthy();
    }
    expect(new PaymentsNotConfiguredError('x').code).toBe('PAYMENTS_NOT_CONFIGURED');
  });
});

import { lg, rtl, tablet, mobile } from './_support.js';

const pct = (v) => v + '%';

export default {
  title: 'Familista/_lgVersus',
  parameters: { docs: { description: { component: 'Real `_lgVersus(label, a, b, opts)`. Both figures are real or the row is not drawn. Two zeroes leave the bar empty rather than colouring a lead. Bar widths are applied after render, as app.js does.' } } },
  args: { label: 'Possession', a: 58, b: 42, lowerIsBetter: false, showUnavailable: false, percent: true },
  render: (a) => lg._lgVersus(a.label, a.a === '' ? null : a.a, a.b === '' ? null : a.b,
    { lowerIsBetter: a.lowerIsBetter, showUnavailable: a.showUnavailable, fmt: a.percent ? pct : undefined }),
};

export const ALeads = {};
export const BLeads = { args: { label: 'Shots', a: 7, b: 14, percent: false } };
export const Level = { args: { label: 'Corners', a: 5, b: 5, percent: false } };
export const BothZeroIsFlat = { args: { label: 'Red cards', a: 0, b: 0, percent: false } };
export const OneSideMissing = { args: { label: 'xG', a: '', b: 1.4, percent: false } };
export const BothMissingShownAsUnavailable = { args: { label: 'Distance', a: '', b: '', showUnavailable: true, percent: false } };
export const LowerIsBetter = { args: { label: 'Fouls', a: 8, b: 14, lowerIsBetter: true, percent: false } };
export const Comparison = {
  render: () => lg._lgPanel('Team comparison', 'Riverside FC vs Northgate United',
    '<div style="padding:14px 16px;display:grid;gap:10px">'
    + lg._lgVersus('Possession', 58, 42, { fmt: pct }) + lg._lgVersus('Shots', 7, 14)
    + lg._lgVersus('Corners', 5, 5) + lg._lgVersus('Red cards', 0, 0)
    + lg._lgVersus('Fouls', 8, 14, { lowerIsBetter: true }) + lg._lgVersus('xG', null, 1.4)
    + lg._lgVersus('Distance', null, null, { showUnavailable: true }) + '</div>'),
};
export const RTL = { ...Comparison, ...rtl };
export const Tablet = { ...Comparison, ...tablet };
export const Mobile = { ...Comparison, ...mobile };

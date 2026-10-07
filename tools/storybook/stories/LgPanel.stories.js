import { lg, rtl, tablet, mobile } from './_support.js';

export default {
  title: 'Familista/_lgPanel',
  parameters: { docs: { description: { component: 'Real `_lgPanel(title, sub, inner, cls)`: the one surface the competition screens share.' } } },
  args: { title: 'Standings', sub: 'Matchday 12', inner: '<p style="padding:14px 16px;color:var(--tx-2)">Panel body</p>', cls: '' },
  argTypes: { cls: { control: 'select', options: ['', 'lg-panel--table', 'lg-panel--fill', 'lg-panel--pitch', 'lg-panel--tall', 'lg-panel--board'] } },
  render: (a) => lg._lgPanel(a.title, a.sub, a.inner, a.cls),
};

export const TitleAndBody = { args: { sub: '' } };
export const WithSubLine = {};
export const TablePanel = { args: { title: 'Player stats', cls: 'lg-panel--table', inner: '<table style="width:100%;border-collapse:collapse"><tr><td style="padding:10px 14px">B. Okafor</td><td style="padding:10px 14px;text-align:end">1,284</td></tr><tr><td style="padding:10px 14px">L. Moreau</td><td style="padding:10px 14px;text-align:end">1,176</td></tr></table>' } };
export const EmptyBody = { args: { title: 'Fixtures', sub: '', inner: lg._lgEmpty('No fixtures yet', 'Fixtures appear once the season is scheduled.') } };
export const Composed = {
  render: () => lg._lgPanel('Match summary', 'Matchday 12', '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:14px 16px">'
    + lg._lgMetric('Possession', '58%') + lg._lgMetric('Shots', '14') + lg._lgMetric('xG', null, 'Not recorded') + '</div>'),
};
export const RTL = { ...Composed, ...rtl };
export const Tablet = { ...Composed, ...tablet };
export const Mobile = { ...Composed, ...mobile };

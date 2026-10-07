import { lg, rtl, tablet, mobile } from './_support.js';

export default {
  title: 'Familista/_lgEmpty',
  parameters: { docs: { description: { component: 'Real `_lgEmpty(title, sub, icon)`: an empty state names what is missing and what would fill it. The `icon` argument is accepted but unused by the real function.' } } },
  args: { title: 'No fixtures yet', sub: 'Fixtures appear once the season is scheduled.' },
  render: (a) => lg._lgEmpty(a.title, a.sub),
};

export const TitleAndSub = {};
export const TitleOnly = { args: { title: 'Nothing to show', sub: '' } };
export const NotRecorded = { args: { title: 'Heart rate not recorded', sub: 'No ECG device was paired for this session. Pair a device to record it next time.' } };
export const InsideAPanel = { render: () => lg._lgPanel('Fixtures', '', lg._lgEmpty('No fixtures yet', 'Fixtures appear once the season is scheduled.'), 'lg-panel--fill') };
export const RTL = { ...InsideAPanel, ...rtl };
export const Tablet = { ...InsideAPanel, ...tablet };
export const Mobile = { ...InsideAPanel, ...mobile };

import { ds, rtl, tablet, mobile } from './_support.js';

export default {
  title: 'Familista/emptyState',
  parameters: { docs: { description: { component: 'Real Owner Kit `emptyState(title, why, extra)`, cut from public/design-system/design-system.js: what is missing, and why, in a role="status" region.' } } },
  args: { title: 'The tokens could not be read', why: 'The design-system manifest is not beside this server (run scripts/design-system-discover.js).' },
  render: (a) => ds.emptyState(a.title, a.why),
};

export const TitleAndReason = {};
export const TitleOnly = { args: { title: 'The components could not be read', why: '' } };
export const RTL = { ...TitleAndReason, ...rtl };
export const Tablet = { ...TitleAndReason, ...tablet };
export const Mobile = { ...TitleAndReason, ...mobile };

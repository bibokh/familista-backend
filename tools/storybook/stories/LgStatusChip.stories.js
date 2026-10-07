import { lg, rtl, tablet, mobile } from './_support.js';

const RAW = ['SCHEDULED', 'LIVE', 'HALFTIME', 'PLAYED', 'FT', 'POSTPONED', 'CANCELLED', 'ABANDONED'];

export default {
  title: 'Familista/_lgStatusChip',
  parameters: { docs: { description: { component: 'Real `_lgStatusChip(raw)`: one shape for a match status. Unknown input falls back to UPCOMING.' } } },
  args: { raw: 'LIVE' },
  argTypes: { raw: { control: 'select', options: [...RAW, 'nonsense', ''] } },
  render: (a) => lg._lgStatusChip(a.raw),
};

export const Live = {};
export const Upcoming = { args: { raw: 'SCHEDULED' } };
export const Finished = { args: { raw: 'PLAYED' } };
export const Postponed = { args: { raw: 'POSTPONED' } };
export const Cancelled = { args: { raw: 'CANCELLED' } };
export const UnknownFallsBackToUpcoming = { args: { raw: 'nonsense' } };
export const AllStatuses = { render: () => RAW.map((r) => lg._lgStatusChip(r)).join(' ') };
export const RTL = { ...AllStatuses, ...rtl };
export const Tablet = { ...AllStatuses, ...tablet };
export const Mobile = { ...AllStatuses, ...mobile };

import { lg, rtl, tablet, mobile } from './_support.js';

export default {
  title: 'Familista/_lgCrest',
  parameters: { docs: { description: { component: 'Real `_lgCrest(clubId, name, size)` from public/app.js. A club with no crest gets its own initials.' } } },
  args: { clubId: 'riverside', name: 'Riverside FC', size: 30 },
  argTypes: { clubId: { control: 'select', options: ['riverside', 'northgate', 'nobody', ''] }, size: { control: { type: 'number', min: 16, max: 160, step: 2 } } },
  render: (a) => lg._lgCrest(a.clubId || null, a.name, a.size),
};

export const WithCrest = {};
export const WithCrestLarge = { args: { size: 74 } };
export const KnownClubNoCrest = { args: { clubId: 'northgate', name: 'Northgate United' } };
export const InitialsMark = { args: { clubId: 'nobody', name: 'Eastfield Athletic' } };
export const NoNameNoClub = { args: { clubId: '', name: '' } };
export const RTL = { ...WithCrest, ...rtl };
export const Tablet = { ...InitialsMark, ...tablet };
export const Mobile = { ...InitialsMark, ...mobile };

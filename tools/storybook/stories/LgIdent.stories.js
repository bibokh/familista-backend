import { lg, rtl, tablet, mobile } from './_support.js';

export default {
  title: 'Familista/_lgIdent',
  parameters: { docs: { description: { component: 'Real `_lgIdent({clubId, name, sub, size, cls})`: crest, club name and the line under it.' } } },
  args: { clubId: 'riverside', name: 'Riverside FC', sub: 'Familista League · 3rd', size: 30 },
  argTypes: { clubId: { control: 'select', options: ['riverside', 'northgate', 'nobody', ''] } },
  render: (a) => lg._lgIdent({ clubId: a.clubId || null, name: a.name, sub: a.sub, size: a.size }),
};

export const CrestNameSub = {};
export const NoSubLine = { args: { sub: '' } };
export const InitialsFallback = { args: { clubId: 'nobody', name: 'Eastfield Athletic', sub: 'Away' } };
export const Large = { args: { size: 44, clubId: 'northgate', name: 'Northgate United', sub: 'Home' } };
export const LongName = { args: { name: 'The Very Long Named Football Club of Riverside and District', sub: 'A sub line that also runs long to test truncation' } };
export const MarkupIsEscaped = { args: { clubId: '', name: '<b>Bad</b> & "Co"', sub: '<i>x</i>' } };
export const RTL = { ...CrestNameSub, ...rtl, args: { name: 'نادي الريفرسايد', sub: 'دوري فاميليستا · الثالث' } };
export const Tablet = { ...LongName, ...tablet };
export const Mobile = { ...LongName, ...mobile };

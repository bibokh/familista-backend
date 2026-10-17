import { lg, rtl, tablet, mobile } from './_support.js';

// title:false throughout, as fourteen of the fifteen production call sites pass it.
const STEPS = [16, 20, 24, 26, 30, 34, 40, 44, 56, 64, 74, 88, 120, 160];

export default {
  title: 'Familista/clubLogoHtml',
  parameters: { docs: { description: { component: 'Real `clubLogoHtml(clubId, opts)`: the crest in a fixed size ladder, letterboxed, with the shield placeholder always underneath. A club without a crest shows the shield, never initials.' } } },
  args: { clubId: 'riverside', size: 'md', cls: '' },
  argTypes: {
    clubId: { control: 'select', options: ['riverside', 'northgate', 'nobody'] },
    size: { control: 'select', options: ['xs', 'sm', 'md', 'lg', 'xl'] },
    cls: { control: 'select', options: ['', 'club-logo--plain', 'club-logo--round', 'club-logo--ring'] },
  },
  render: (a) => lg.clubLogoHtml(a.clubId, { size: a.size, cls: a.cls, title: false }),
};

export const WithCrest = {};
export const WithoutCrest = { args: { clubId: 'northgate' } };
export const UnknownClub = { args: { clubId: 'nobody' } };
export const Shapes = {
  render: () => ['club-logo--plain', 'club-logo--round', 'club-logo--ring', 'club-logo--plain club-logo--round']
    .map((cls) => lg.clubLogoHtml('riverside', { size: 44, cls, title: false })).join(' '),
};
export const SizeLadder = { render: () => STEPS.map((px) => lg.clubLogoHtml('riverside', { size: px, title: false })).join(' ') };
export const RTL = { ...Shapes, ...rtl };
export const Tablet = { ...Shapes, ...tablet };
export const Mobile = { ...Shapes, ...mobile };

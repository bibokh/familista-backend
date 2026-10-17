import { lg, rtl, tablet, mobile } from './_support.js';

// The icons the Specimen Lab previews. `lock` is left out on purpose: it draws a
// <rect>, which the Lab's sanitizer does not carry (see tests/cases.mjs).
const NAMES = ['back', 'info', 'teams', 'trophy', 'cup', 'friendly', 'preseason', 'preparation', 'fixture', 'clock', 'weather'];

export default {
  title: 'Familista/_lgIcon',
  parameters: { docs: { description: { component: 'Real `_lgIcon(name)`: one 14px line icon on a 20-box, 1.75 stroke, inheriting the colour of its control. An unknown name draws nothing.' } } },
  args: { name: 'trophy' },
  argTypes: { name: { control: 'select', options: ['back', 'info', 'teams', 'trophy', 'cup', 'friendly', 'preseason', 'preparation', 'fixture', 'clock', 'weather'] } },
  render: (a) => lg._lgIcon(a.name),
};

export const One = {};
export const UnknownNameDrawsNothing = { args: { name: 'not-an-icon' } };
export const AllIcons = { render: () => NAMES.map((n) => lg._lgIcon(n)).join(' ') };
export const RTL = { ...AllIcons, ...rtl };
export const Tablet = { ...AllIcons, ...tablet };
export const Mobile = { ...AllIcons, ...mobile };

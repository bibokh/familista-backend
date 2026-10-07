import { lg, rtl, tablet, mobile } from './_support.js';

export default {
  title: 'Familista/_lgChip',
  parameters: { docs: { description: { component: 'Real `_lgChip(label, value, cls)`. Modifiers that exist in app.css: up, live, done, post, cancel, none, warn.' } } },
  args: { label: 'Form', value: 'WWDLW', cls: '' },
  argTypes: { cls: { control: 'select', options: ['', 'up', 'live', 'done', 'post', 'cancel', 'none', 'warn'] } },
  render: (a) => lg._lgChip(a.label, a.value === '' ? null : a.value, a.cls),
};

export const LabelAndValue = {};
export const ValueOnly = { args: { label: '', value: '2 – 1' } };
export const LabelOnly = { args: { label: 'Imported', value: '' } };
export const ZeroIsAValue = { args: { label: 'Goals', value: 0 } };
export const AllModifiers = {
  render: () => ['', 'up', 'live', 'done', 'post', 'cancel', 'none', 'warn']
    .map((c) => lg._lgChip(c || 'default', c ? c.toUpperCase() : null, c)).join(' '),
};
export const RTL = { ...AllModifiers, ...rtl };
export const Tablet = { ...AllModifiers, ...tablet };
export const Mobile = { ...AllModifiers, ...mobile };

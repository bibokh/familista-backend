import { ds, rtl, tablet, mobile } from './_support.js';

// 'row' is the only modifier production's CSS styles; the row counts are the ones production asks for.
export default {
  title: 'Familista/skeleton',
  parameters: { docs: { description: { component: 'Real Owner Kit `skeleton(n, cls)`, cut from public/design-system/design-system.js: a role="status" region named by its aria-label, with n decorative rows.' } } },
  args: { rows: 6 },
  argTypes: { rows: { control: 'select', options: [4, 6, 8, 10] } },
  render: (a) => ds.skeleton(a.rows, 'row'),
};

export const SixRows = {};
export const FourRows = { args: { rows: 4 } };
export const EightRows = { args: { rows: 8 } };
export const RTL = { ...SixRows, ...rtl };
export const Tablet = { ...SixRows, ...tablet };
export const Mobile = { ...SixRows, ...mobile };

import { lg, rtl, tablet, mobile } from './_support.js';

export default {
  title: 'Familista/_lgForm',
  parameters: { docs: { description: { component: 'Real `_lgForm(form)`: the last five results, newest last. Green and red here are results, which is what they are reserved for. No results renders a dash.' } } },
  args: { form: ['W', 'W', 'D', 'L', 'W'] },
  argTypes: { form: { control: 'object' } },
  render: (a) => lg._lgForm(a.form),
};

export const FiveResults = {};
export const OneResult = { args: { form: ['L'] } };
export const EmptyIsADash = { args: { form: [] } };
export const NullIsADash = { args: { form: null } };
export const RTL = { ...FiveResults, ...rtl };
export const Tablet = { ...FiveResults, ...tablet };
export const Mobile = { ...FiveResults, ...mobile };

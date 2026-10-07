import { lg, rtl, tablet, mobile } from './_support.js';

export default {
  title: 'Familista/_lgFloat',
  parameters: { layout: 'fullscreen', docs: { description: { component: 'Real `_lgFloat({close, head, body, foot, cls})`: a fixed backdrop and a card that animates on opacity and transform only. In production `data-action` is handled by app.js; here the close button is inert.' } } },
  args: { head: '<span class="lg-float-t">Match details</span>', body: '<p style="color:var(--tx-2)">Floating panel body. Opening one never moves what is underneath it.</p>', foot: '', cls: '' },
  argTypes: { cls: { control: 'select', options: ['', 'lg-float--md', 'lg-float--lg'] } },
  render: (a) => lg._lgFloat({ close: 'closeFloat', head: a.head, body: a.body, foot: a.foot, cls: a.cls }),
};

export const HeadAndBody = {};
export const WithFooter = { args: { head: '<span class="lg-float-t">Edit fixture</span>', foot: '<button type="button" class="btn">Cancel</button> <button type="button" class="btn btn-primary">Save</button>' } };
export const Medium = { args: { cls: 'lg-float--md', head: '<span class="lg-float-t">Medium</span>' } };
export const Large = { args: { cls: 'lg-float--lg', head: '<span class="lg-float-t">Large</span>' } };
export const LongBodyScrolls = { args: { body: Array.from({ length: 40 }, (_, i) => `<p style="color:var(--tx-2)">Line ${i + 1}</p>`).join('') } };
export const RTL = { ...WithFooter, ...rtl };
export const Tablet = { ...WithFooter, ...tablet };
export const Mobile = { ...WithFooter, ...mobile };

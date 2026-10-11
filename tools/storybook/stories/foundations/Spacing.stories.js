import { page, panel, tokenTable, under, varName } from './_kit.js';
export default {
  title: 'Foundations/Spacing',
  parameters: { layout: 'padded', docs: { description: { component: 'A 4px grid, from the live Club --sp-* scale (matching Vision --v-1…5 and React --gap-*).' } } },
};
export const SpacingScale = {
  render: () => page({ title: 'Spacing', lede: 'One grid for every context.' },
    panel('Scale', tokenTable(under('semantic.space'), (p) => `<div class="fam-fd-bar" style="width:var(${varName(p)});min-width:1px"></div>`))),
};

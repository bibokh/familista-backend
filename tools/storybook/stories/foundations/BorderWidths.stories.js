import { page, panel, tokenTable, under, varName } from './_kit.js';
export default {
  title: 'Foundations/Border widths',
  parameters: { layout: 'padded', docs: { description: { component: 'Hairline, strong (focus outline) and rule (accent edge).' } } },
};
export const BorderWidthScale = {
  render: () => page({ title: 'Border widths', lede: 'A highlight is an edge or a hairline, never a filled block.' },
    panel('Scale', tokenTable(under('semantic.border-width'), (p) => `<div style="width:160px;border-top:var(${varName(p)}) solid var(--fam-border-strong)"></div>`))),
};

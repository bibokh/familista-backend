import { page, panel, tokenTable, under, varName } from './_kit.js';
export default {
  title: 'Foundations/Radius',
  parameters: { layout: 'padded', docs: { description: { component: 'Corner radii. 16px is the Training panel radius (--lg-r); the live 10px and 14px Club radii are recorded as divergent in the legacy map.' } } },
};
export const RadiusScale = {
  render: () => page({ title: 'Radius', lede: 'Panels are 16px. Nothing is rounded like a marketing tile.' },
    panel('Scale', tokenTable(under('semantic.radius'), (p) => `<div class="fam-fd-box" style="border-radius:var(${varName(p)})"></div>`))),
};

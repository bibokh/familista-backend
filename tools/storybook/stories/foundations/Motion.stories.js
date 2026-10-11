import { page, panel, tokenTable, under, varName, literal, esc } from './_kit.js';
export default {
  title: 'Foundations/Motion',
  parameters: { layout: 'padded', docs: { description: { component: 'Durations and easing; every duration becomes 0ms under prefers-reduced-motion.' } } },
};
export const MotionTokens = {
  render: () => page({ title: 'Motion', lede: 'Panels animate on opacity and transform only. With reduced motion requested, every <code>--fam-duration-*</code> is 0ms.' },
    panel('Durations', tokenTable(under('semantic.duration'), (p) => `<span class="fam-fd-value">reduced motion: ${esc(literal(p, { media: 'reduced-motion' }))}</span>`)),
    panel('Easing', tokenTable(under('semantic.easing'))),
    panel('Live sample', `<div style="padding:var(--fam-space-3) 0"><div class="fam-fd-motion"></div></div>`, 'Animates with <code>--fam-duration-slow</code> and <code>--fam-easing-standard</code>; it stops when the system asks for reduced motion, and mirrors under right-to-left.')),
};

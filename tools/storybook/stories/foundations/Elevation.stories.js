import { page, panel, tokenTable, under, varName } from './_kit.js';
export default {
  title: 'Foundations/Elevation',
  parameters: { layout: 'padded', docs: { description: { component: 'Shadows, glows and backdrop blur.' } } },
};
const card = (css) => `<div class="fam-fd-box" style="border-radius:var(--fam-radius-lg);${css}"></div>`;
export const ShadowsGlowsBlur = {
  render: () => page({ title: 'Elevation, glow and blur', lede: 'Restrained glass: a soft shadow, a blurred backdrop, a hairline.' },
    panel('Shadow', tokenTable(under('semantic.shadow'), (p) => card(`box-shadow:var(${varName(p)})`))),
    panel('Glow', tokenTable(under('semantic.glow'), (p) => card(`box-shadow:var(${varName(p)})`))),
    panel('Backdrop blur', tokenTable(under('semantic.blur'), (p) => `<div style="position:relative;width:120px;height:56px;border-radius:var(--fam-radius-md);overflow:hidden;background:repeating-linear-gradient(90deg,var(--fam-brand-accent) 0 6px,var(--fam-surface-raised) 6px 14px)"><div style="position:absolute;inset:10px;border-radius:var(--fam-radius-sm);background:var(--fam-surface-panel);backdrop-filter:blur(var(${varName(p)}))"></div></div>`))),
};

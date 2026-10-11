import { page, panel, tokenTable, under, varName } from './_kit.js';
export default {
  title: 'Foundations/Sizing',
  parameters: { layout: 'padded', docs: { description: { component: 'Control heights, icon sizes, club crest sizes and layout dimensions.' } } },
};
export const ControlIconCrest = {
  render: () => page({ title: 'Control, icon and crest sizing', lede: 'Crest sizes are the live <code>.club-logo--sNN</code> set; control and icon sizes are the most frequent live values.' },
    panel('Controls', tokenTable(under('semantic.size.control'), (p) => `<div style="height:var(${varName(p)});width:120px;border-radius:var(--fam-radius-md);background:var(--fam-surface-raised);border:1px solid var(--fam-border-default)"></div>`)),
    panel('Icons', tokenTable(under('semantic.size.icon'), (p) => `<svg aria-hidden="true" viewBox="0 0 20 20" style="width:var(${varName(p)});height:var(${varName(p)});fill:var(--fam-text-secondary)"><path d="M10 2l2.5 5.2 5.5.8-4 3.9 1 5.6L10 15l-5 2.5 1-5.6-4-3.9 5.5-.8z"/></svg>`)),
    panel('Crests', tokenTable(under('semantic.size.crest'), (p) => `<div style="width:var(${varName(p)});height:var(${varName(p)});border-radius:50%;background:var(--fam-surface-raised);border:1px solid var(--fam-brand-accent)"></div>`)),
    panel('Layout', tokenTable(under('semantic.layout'), (p) => `<div class="fam-fd-bar" style="width:calc(var(${varName(p)}) / 2);background:var(--fam-surface-raised)"></div>`), 'Previews at half scale.')),
};

import { page, panel, swatches, tree, under, esc } from './_kit.js';

export default {
  title: 'Foundations/Colours',
  parameters: { layout: 'padded', docs: { description: { component: 'Reference palette: every raw colour the Design Core holds, each taken from a live production value. Product code never reads these directly; semantic tokens point at them.' } } },
};

const families = Object.keys(tree.ref.color).filter((k) => !k.startsWith('$'));
export const ReferencePalette = {
  render: () => page({ title: 'Reference palette', lede: `${under('ref.color').length} colours in ${families.length} families. Each swatch is painted by its own <code>--fam-ref-*</code> custom property; the value under it is resolved from the DTCG source.` },
    ...families.map((f) => panel(f, swatches(under(`ref.color.${f}`)), esc(tree.ref.color[f].$description || '')))),
};

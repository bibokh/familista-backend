import { page, panel, swatches, under } from './_kit.js';
export default {
  title: 'Foundations/Football',
  parameters: { layout: 'padded', docs: { description: { component: 'Pitch, team, position, result and pathway tokens.' } } },
};
export const PitchAndMatch = {
  render: () => page({ title: 'Football', lede: 'Amber is the current club; the opponent is steel. Green and red mean a result or availability and nothing else.' },
    panel('Pitch', swatches(under('semantic.pitch'))),
    panel('Team', swatches(under('semantic.team'))),
    panel('Positions', swatches(under('semantic.position'))),
    panel('Results', swatches(under('semantic.result'))),
    panel('Player pathway tiers', swatches(under('semantic.pathway')))),
};

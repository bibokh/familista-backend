import { page, panel, under, varName, literal, contrastBaseline, esc, badge } from './_kit.js';
export default {
  title: 'Foundations/Data visualisation',
  parameters: { layout: 'padded', docs: { description: { component: 'The categorical series the platform uses today (.sqlu-stat--* and .trn-stat--*), with contrast against the canvas.' } } },
};
export const Categorical = {
  render: () => {
    const rows = under('semantic.chart.categorical').map((p) => {
      const id = p.replace('semantic.', '');
      const club = contrastBaseline.pairs.find((x) => x.context === 'club' && x.fg === id && x.bg === 'surface.canvas');
      return `<tr><td class="fam-fd-mono"><span class="fam-fd-dot" style="background:var(${varName(p)})"></span>${esc(varName(p))}</td><td class="fam-fd-mono">${esc(literal(p))}</td>`
        + `<td>${club ? esc(club.ratio.toFixed(2)) + ':1 ' + (club.pass ? badge('Pass', 'pass') : badge('Below 3:1', 'fail')) : ''}</td></tr>`;
    }).join('');
    return page({ title: 'Data visualisation', lede: 'Seven live series colours, preserved. Series 2 (green) and 6 (red) collide with result meanings and series 7 is below 3:1 on the canvas — recorded for a Stage 3 decision, alongside the approved Figma data palette, which production does not use yet.' },
      panel('Categorical series', `<div class="fam-fd-table-wrap" tabindex="0" role="region" aria-label="Categorical series"><table class="fam-fd-table"><thead><tr><th>Token</th><th>Value</th><th>On canvas (Club)</th></tr></thead><tbody>${rows}</tbody></table></div>`));
  },
};

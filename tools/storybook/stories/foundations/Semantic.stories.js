import { page, panel, swatches, under, contrastBaseline, esc, badge, stats, varName } from './_kit.js';

export default {
  title: 'Foundations/Semantic',
  parameters: { layout: 'padded', docs: { description: { component: 'Semantic surfaces, text and borders in the current workspace context (toolbar: Context), and the recorded WCAG contrast baseline.' } } },
};

const surfaces = under('semantic.surface');
const texts = under('semantic.text');

function onSurfaces() {
  const rows = surfaces.map((s) => `<div class="fam-fd-row"><span class="fam-fd-name">${esc(varName(s))}</span>`
    + `<div style="background:var(${varName(s)});border-radius:var(--fam-radius-md);padding:var(--fam-space-3);display:flex;gap:var(--fam-space-4);flex-wrap:wrap;border:1px solid var(--fam-border-subtle)">`
    + texts.map((t) => `<span class="fam-sb-specimen" style="color:var(${varName(t)});font-size:var(--fam-font-size-base);font-weight:var(--fam-font-weight-semibold)">${t.split('.').pop()} Aa</span>`).join('')
    + `</div><span></span></div>`).join('');
  return `<div style="display:flex;flex-direction:column;gap:var(--fam-space-2)">${rows}</div>`;
}

export const SurfacesTextBorders = {
  // The specimens deliberately show pairs that fail contrast; the baseline records them.
  parameters: { a11y: { context: { exclude: ['.fam-sb-specimen'] } } },
  render: () => page({ title: 'Surfaces, text and borders', lede: 'Club Workspace values are the defaults (live today on every page); switch the toolbar Context to Owner / Global to see the Owner set. Text specimens deliberately include the pairs that fail contrast — see the baseline story.' },
    panel('Surfaces', swatches(surfaces)),
    panel('Text', swatches(texts)),
    panel('Borders', swatches(under('semantic.border'))),
    panel('Text on every surface', onSurfaces(), 'Translucent surfaces are shown over the context canvas, as the contrast baseline measures them.')),
};

export const ContrastBaseline = {
  render: () => {
    const pairs = contrastBaseline.pairs;
    const failing = pairs.filter((p) => p.role !== 'exempt' && !p.pass);
    const rows = pairs.map((p) => `<tr><td class="fam-fd-mono">${esc(p.context + (p.module ? ' / ' + p.module : ''))}</td><td class="fam-fd-mono">${esc(p.fg)}</td><td class="fam-fd-mono">${esc(p.bg)}</td>`
      + `<td>${esc(p.ratio.toFixed(2))}:1</td><td>${esc(p.role === 'exempt' ? 'recorded' : p.required + ':1')}</td>`
      + `<td>${p.role === 'exempt' ? badge('Exempt') : p.pass ? badge('Pass', 'pass') : badge('Baseline failure', 'fail')}</td></tr>`).join('');
    return page({ title: 'Contrast baseline', lede: 'WCAG 2.2 ratios for every pair the tokens claim, per context. Live values are preserved in Stage 2a, so today\'s failures are recorded, not fixed; the ratchet fails on any new one. Fixing them is a Stage 3 visual change that needs approval.' },
      stats([[pairs.length, 'pairs measured'], [pairs.length - failing.length, 'pass or exempt'], [failing.length, 'baseline failures']]),
      panel('Every pair', `<div class="fam-fd-table-wrap" tabindex="0" role="region" aria-label="Contrast pairs"><table class="fam-fd-table"><thead><tr><th>Context</th><th>Foreground</th><th>Surface</th><th>Ratio</th><th>Needs</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>`));
  },
};

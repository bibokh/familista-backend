import { page, panel, tokenTable, under, varName, tokens, esc } from './_kit.js';

export default {
  title: 'Foundations/Typography',
  parameters: { layout: 'padded', docs: { description: { component: 'Inter for interface text, JetBrains Mono for figures and identifiers, Noto Sans Arabic as the Arabic fallback. Sizes, weights, line heights and tracking taken from the live literal frequencies.' } } },
};

const family = (p, sample) => `<div style="display:flex;flex-direction:column;gap:var(--fam-space-1)"><span class="fam-fd-name">${esc(varName(p))}</span>`
  + `<span style="font-family:var(${varName(p)});font-size:var(--fam-font-size-3xl);font-weight:var(--fam-font-weight-semibold)">${sample}</span>`
  + `<span class="fam-fd-value">${esc(tokens.get(p).value.join(', '))}</span></div>`;

export const TypeFoundations = {
  render: () => page({ title: 'Typography', lede: 'No font-size, weight or line-height token exists in production today (3,511 font-size literals, 91 distinct). The scale below is the live distribution, named; nothing reads it yet.' },
    panel('Families', `<div class="fam-fd-cols">${family('semantic.font.family.sans', 'Match Centre 2–1 · مركز المباراة')}${family('semantic.font.family.mono', '0.84 xG · 12:45')}${family('semantic.font.family.arabic', 'مركز المباراة · ٢–١')}</div>`,
      'Noto Sans Arabic is not loaded by production yet (Stage 0: Storybook-only). Inter has no Arabic glyphs, so Arabic falls through to Noto glyph by glyph while Latin digits stay Inter.'),
    panel('Size', tokenTable(under('semantic.font.size'), (p) => `<span style="font-size:var(${varName(p)})">Squad readiness</span>`)),
    panel('Weight', tokenTable(under('semantic.font.weight'), (p) => `<span style="font-weight:var(${varName(p)});font-size:var(--fam-font-size-lg)">Squad readiness</span>`)),
    panel('Line height', tokenTable(under('semantic.font.line-height'), (p) => `<span style="display:block;max-width:220px;line-height:var(${varName(p)});font-size:var(--fam-font-size-md)">Two lines of interface copy wrapping inside a narrow cell.</span>`)),
    panel('Tracking', tokenTable(under('semantic.font.tracking'), (p) => `<span style="letter-spacing:var(${varName(p)});text-transform:uppercase;font-size:var(--fam-font-size-sm);font-weight:var(--fam-font-weight-bold)">Next fixture</span>`))),
};

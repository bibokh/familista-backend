import { page, panel, esc, literal, under, varName } from './_kit.js';

export default {
  title: 'Foundations/Arabic & RTL',
  parameters: { layout: 'padded', docs: { description: { component: 'Arabic and right-to-left foundation: tracking resolves to 0 under :lang(ar), Noto Sans Arabic is in every sans stack, and --fam-direction-multiplier mirrors horizontal motion under dir="rtl".' } } },
};

const tracking = under('semantic.font.tracking');

export const ArabicFoundation = {
  render: () => {
    const host = document.createElement('div');
    host.innerHTML = page({ title: 'Arabic & right-to-left', lede: 'Letter-spacing breaks Arabic cursive joining, so every tracking step is 0 in Arabic. The table reads the <em>computed</em> letter-spacing from the two specimens below, so it proves the generated CSS, not the source.' },
      panel('Specimens', `<div class="fam-fd-cols">`
        + `<div lang="en" dir="ltr" data-spec="en" style="font-family:var(--fam-font-family-sans);font-size:var(--fam-font-size-xl);letter-spacing:var(--fam-font-tracking-wider);text-transform:uppercase;font-weight:var(--fam-font-weight-bold)">Next fixture <span class="fam-fd-arrow">→</span></div>`
        + `<div lang="ar" dir="rtl" data-spec="ar" style="font-family:var(--fam-font-family-sans);font-size:var(--fam-font-size-xl);letter-spacing:var(--fam-font-tracking-wider);font-weight:var(--fam-font-weight-bold)">المباراة القادمة <span class="fam-fd-arrow">→</span></div></div>`,
        'Both specimens use <code>letter-spacing: var(--fam-font-tracking-wider)</code>. The arrow uses <code>scaleX(var(--fam-direction-multiplier))</code>.'),
      panel('Tracking by language (computed)', `<div class="fam-fd-table-wrap" tabindex="0" role="region" aria-label="Tracking by language"><table class="fam-fd-table"><thead><tr><th>Token</th><th>Default</th><th>:lang(ar)</th></tr></thead><tbody>`
        + tracking.map((p) => `<tr><td class="fam-fd-mono">${esc(varName(p))}</td><td class="fam-fd-mono">${esc(literal(p))}</td><td class="fam-fd-mono">${esc(literal(p, { lang: 'ar' }))}</td></tr>`).join('')
        + `</tbody></table></div><p class="fam-fd-note" data-computed>Computed in this browser: …</p>`),
      panel('Font stacks', `<p class="fam-fd-note"><code>--fam-font-family-sans</code>: ${esc(literal('semantic.font.family.sans'))}<br><code>--fam-font-family-arabic</code>: ${esc(literal('semantic.font.family.arabic'))}</p>`),
      panel('Direction', `<p class="fam-fd-note"><code>--fam-direction-multiplier</code> is ${esc(literal('semantic.direction.multiplier'))} by default and ${esc(literal('semantic.direction.multiplier', { dir: 'rtl' }))} under <code>[dir="rtl"]</code>. Switch the toolbar Direction to see the whole page mirror.</p>`));
    const el = host.firstElementChild;
    requestAnimationFrame(() => {
      const out = el.querySelector('[data-computed]');
      const en = el.querySelector('[data-spec="en"]'); const ar = el.querySelector('[data-spec="ar"]');
      if (out && en && ar) out.textContent = `Computed in this browser: English letter-spacing ${getComputedStyle(en).letterSpacing}; Arabic letter-spacing ${getComputedStyle(ar).letterSpacing}.`;
    });
    return el;
  },
};
export const ArabicFoundationRTL = { ...ArabicFoundation, name: 'Arabic foundation (RTL page)', globals: { direction: 'rtl' } };

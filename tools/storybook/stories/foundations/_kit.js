// Shared by the Foundations stories. Everything shown is read from the
// Familista Design Core (tools/tokens): the DTCG source, its resolver, the
// legacy map and the contrast baseline. Storybook renders; it owns nothing.
import tree from '../../../tokens/familista.tokens.json';
import legacyMap from '../../../tokens/legacy-map.json';
import contrastBaseline from '../../../tokens/contrast-baseline.json';
import { validate, cssName, resolvedCss, withVariants } from '../../../tokens/lib/dtcg.mjs';

export { tree, legacyMap, contrastBaseline };
export const { tokens } = validate(tree);
export const varName = (path) => cssName(path);
export const literal = (path, picks = {}) => resolvedCss(Object.keys(picks).length ? withVariants(tree, tokens, picks) : tokens, path);
export const under = (prefix) => [...tokens.keys()].filter((p) => p.startsWith(prefix + '.'));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export { esc };

/** A page: eyebrow, title, lede and panels (HTML strings). */
export function page({ eyebrow = 'Foundations', title, lede, attrs = '' }, ...panels) {
  return `<div class="fam-fd" ${attrs}><header class="fam-fd-head"><span class="fam-fd-eyebrow">${esc(eyebrow)}</span>`
    + `<h1 class="fam-fd-title">${esc(title)}</h1>${lede ? `<p class="fam-fd-lede">${lede}</p>` : ''}</header>${panels.join('')}</div>`;
}
export const panel = (title, body, note) =>
  `<section class="fam-fd-panel"><h2 class="fam-fd-panel-title">${esc(title)}</h2>${note ? `<p class="fam-fd-note">${note}</p>` : ''}${body}</section>`;

/** A colour swatch painted by the CSS custom property itself, not by a copied value. */
export const swatch = (path, picks) => `<div class="fam-fd-swatch"><div class="fam-fd-chip"><span style="background:var(${varName(path)})"></span></div>`
  + `<div class="fam-fd-meta"><span class="fam-fd-name">${esc(varName(path))}</span><span class="fam-fd-value">${esc(literal(path, picks))}</span></div></div>`;
export const swatches = (paths, picks) => `<div class="fam-fd-grid">${paths.map((p) => swatch(p, picks)).join('')}</div>`;

/** A table of tokens: name, literal value, and an optional visual cell. */
export function tokenTable(paths, visual = () => '', picks) {
  const rows = paths.map((p) => `<tr><td class="fam-fd-mono">${esc(varName(p))}</td><td class="fam-fd-mono">${esc(literal(p, picks))}</td>`
    + `<td>${visual(p)}</td><td class="fam-fd-mono">${esc((tokens.get(p).ext.source) || '')}</td></tr>`).join('');
  const label = 'Tokens: ' + paths[0].split('.').slice(1, -1).join(' ');
  return `<div class="fam-fd-table-wrap" tabindex="0" role="region" aria-label="${esc(label)}"><table class="fam-fd-table"><thead><tr><th>Token</th><th>Value</th><th>Preview</th><th>Live source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export const badge = (text, kind = '') => `<span class="fam-fd-badge${kind ? ' fam-fd-badge--' + kind : ''}">${esc(text)}</span>`;
export const stats = (items) => `<div class="fam-fd-stats">${items.map(([v, l]) => `<div class="fam-fd-stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>`;

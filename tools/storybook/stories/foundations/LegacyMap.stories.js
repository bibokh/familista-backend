import { page, panel, legacyMap, esc, badge, stats } from './_kit.js';
export default {
  title: 'Foundations/Legacy map',
  parameters: { layout: 'padded', docs: { description: { component: 'Every custom property production declares today, its exact live value, and the Design Core token it maps to.' } } },
};

const KIND = { equal: 'pass', diverges: 'accent' };
export const LegacyTokenMapping = {
  render: () => {
    const e = legacyMap.entries;
    const count = (s) => e.filter((x) => x.status === s).length;
    const host = document.createElement('div');
    const rows = e.map((x) => `<tr data-q="${esc((x.name + ' ' + x.file + ' ' + (x.target || '') + ' ' + x.status).toLowerCase())}"><td class="fam-fd-mono">${esc(x.name)}</td>`
      + `<td class="fam-fd-mono">${/^#|^rgba?\(/i.test(x.liveValue) ? `<span class="fam-fd-dot" style="background:${esc(x.liveValue)}"></span>` : ''}${esc(x.liveValue)}</td>`
      + `<td class="fam-fd-mono">${esc((x.target || '—').replace('semantic.', ''))}${x.variant ? ' · ' + esc(x.variant) : ''}</td><td>${badge(x.status, KIND[x.status] || '')}</td>`
      + `<td class="fam-fd-mono">${esc(x.file.replace('public/', ''))} · ${esc(x.selector.slice(0, 40))}</td></tr>`).join('');
    host.innerHTML = page({ title: 'Legacy token mapping', lede: 'No legacy name is renamed or aliased in Stage 2a. "Equal" means the token reproduces the live value exactly in that context (verified by the ratchet); "diverges" means the live value differs and is preserved verbatim until a Stage 3 decision.' },
      stats([[e.length, 'declarations'], [new Set(e.map((x) => x.name)).size, 'names'], [count('equal'), 'equal'], [count('diverges'), 'diverges'],
        [count('dead-redeclared') + count('dead-overridden'), 'dead'], [legacyMap.undefinedNames.css.length, 'undefined, protected']]),
      panel('Declarations', `<input class="fam-fd-filter" type="search" placeholder="Filter by name, file, token or status" aria-label="Filter legacy declarations">`
        + `<div class="fam-fd-table-wrap" tabindex="0" role="region" aria-label="Legacy declarations"><table class="fam-fd-table"><thead><tr><th>Legacy name</th><th>Live value</th><th>Design Core token</th><th>Status</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table></div>`),
      panel('Referenced but never declared', `<p class="fam-fd-note">${legacyMap.undefinedNames.css.map((u) => `<code>${esc(u.name)}</code> (${u.references}×${u.withFallback ? ', with fallback' : ', no fallback'})`).join(', ')}. app.js also references ${legacyMap.undefinedNames.appJs.map((u) => `<code>${esc(u.name)}</code>`).join(', ')}. None may be defined: each would visibly change production.</p>`));
    const el = host.firstElementChild;
    const input = el.querySelector('input');
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      el.querySelectorAll('tbody tr[data-q]').forEach((tr) => { tr.hidden = !!q && !tr.dataset.q.includes(q); });
    });
    return el;
  },
};

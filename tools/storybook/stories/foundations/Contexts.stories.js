import { page, panel, swatch, under, overrideList, esc } from './_contexts.js';

export default {
  title: 'Foundations/Contexts',
  parameters: { layout: 'padded', docs: { description: { component: 'Owner / Global and Club Workspace contexts side by side, and each module\'s identity accent. Contexts re-declare the same semantic names; pages read them through ordinary CSS inheritance.' } } },
};

const ROLES = ['semantic.surface.canvas', 'semantic.surface.base', 'semantic.surface.raised', 'semantic.text.primary', 'semantic.text.secondary',
  'semantic.text.tertiary', 'semantic.border.subtle', 'semantic.border.default', 'semantic.brand.accent', 'semantic.status.success',
  'semantic.status.warning', 'semantic.status.critical', 'semantic.status.info'];

const column = (ctx, label) => `<div data-fam-context="${ctx}" style="background:var(--fam-surface-canvas);border-radius:var(--fam-radius-panel);padding:var(--fam-space-4);display:flex;flex-direction:column;gap:var(--fam-space-3);border:1px solid var(--fam-border-default)">`
  + `<strong style="font-size:var(--fam-font-size-lg);color:var(--fam-text-primary)">${esc(label)}</strong>`
  + `<div class="fam-fd-grid">${ROLES.map((p) => swatch(p, { context: ctx })).join('')}</div></div>`;

export const OwnerVsClub = {
  render: () => page({ title: 'Owner / Global vs Club Workspace', lede: 'Same token names, two contexts. Club is the default (<code>:root</code>); Owner applies on every Owner module root and its floating panels, and on <code>[data-fam-context="owner"]</code>.' },
    panel('Side by side', `<div class="fam-fd-cols">${column('club', 'Club Workspace (default)')}${column('owner', 'Owner / Global')}</div>`),
    panel('What each context re-declares', overrideList())),
};

const MODULES = ['system', 'data-vault', 'infrastructure-city', 'source-core', 'vision', 'cybersecurity', 'algorithms', 'transfers', 'coach-market', 'coaches'];
const OWNER = new Set(MODULES.slice(0, 7));
export const ModuleIdentity = {
  render: () => page({ title: 'Module identity accents', lede: 'Each module keeps its live identity accent through <code>--fam-module-accent</code> / <code>-2</code>. Amber stays the brand and competition accent.' },
    panel('Modules', `<div class="fam-fd-grid">${MODULES.map((m) => `<div data-fam-context="${OWNER.has(m) ? 'owner' : 'club'}" data-fam-module="${m}" style="background:var(--fam-surface-canvas);border-radius:var(--fam-radius-lg);padding:var(--fam-space-3);display:flex;flex-direction:column;gap:var(--fam-space-2);border:1px solid var(--fam-border-subtle)">`
      + `<strong style="font-size:var(--fam-font-size-md)">${esc(m)}</strong><div class="fam-fd-bar"></div><div class="fam-fd-bar" style="background:var(--fam-module-accent-2)"></div>`
      + `<span class="fam-fd-value">${OWNER.has(m) ? 'Owner' : 'Club'}</span></div>`).join('')}</div>`)),
};

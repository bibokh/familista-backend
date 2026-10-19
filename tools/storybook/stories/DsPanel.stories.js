import { ds, rtl, tablet, mobile } from './_support.js';

// Untitled, as six production call sites write it (panel('', body)), and titled
// since M3/S2.2b-2, when the Specimen Lab's sanitizer gained class on h2.
const list = (rows) => '<div class="ds-kv-list">' + rows.map(([k, v]) => ds.kv(k, v)).join('') + '</div>';

export default {
  title: 'Familista/panel',
  parameters: { docs: { description: { component: 'Real Owner Kit `panel(title, body, note, extra)`, cut from public/design-system/design-system.js: the room\'s surface, untitled or with its title and note.' } } },
  render: () => ds.panel('', list([['Tokens', '128'], ['New failures', '0']])),
};

export const KeyValueList = {};
export const ListAndNote = {
  render: () => ds.panel('', list([['Usage telemetry', '—']]) + '<div class="ds-note">A layer with no tokens is a measured 0.</div>'),
};
export const NoteOnly = {
  render: () => ds.panel('', '<div class="ds-note">Ratios are computed from the token values; a translucent surface is measured over its context’s canvas.</div>'),
};
// design-system.js lines 527 and 528: the tokens room's own untitled bodies.
export const TokensCouldNotBeRead = {
  render: () => ds.panel('', ds.emptyState('The tokens could not be read', 'The design-system manifest is not beside this server (run scripts/design-system-discover.js).')),
};
export const TokensLoading = { render: () => ds.panel('', ds.skeleton(8, 'row')) };
export const Titled = {
  render: () => ds.panel('Contrast', '<div class="ds-kv-list">' + ds.kv('Pairs below their threshold', '0')
    + ds.kv('Failures beyond that record', ds.chip('ok', 'None', '', 'ds-chip--sm')) + '</div>'),
};
export const TitledWithNote = { render: () => ds.panel('Token layers', list([['Tokens', '128']]), '3 contexts · 9 modules') };
export const RTL = { ...TitledWithNote, ...rtl };
export const Tablet = { ...TitledWithNote, ...tablet };
export const Mobile = { ...TitledWithNote, ...mobile };

import { ds, rtl, tablet, mobile } from './_support.js';

// Untitled only, as six production call sites write it: panel('', body). A title
// draws <h2 class="ds-panel-title">, which the Specimen Lab's sanitizer does not
// allow; the titled form is left out on purpose (see tests/cases.mjs).
const list = (rows) => '<div class="ds-kv-list">' + rows.map(([k, v]) => ds.kv(k, v)).join('') + '</div>';

export default {
  title: 'Familista/panel',
  parameters: { docs: { description: { component: 'Real Owner Kit `panel(title, body, note, extra)`, cut from public/design-system/design-system.js: the room\'s surface. Shown untitled, with the room\'s own key-value list and note as its body.' } } },
  render: () => ds.panel('', list([['Tokens', '128'], ['New failures', '0']])),
};

export const KeyValueList = {};
export const ListAndNote = {
  render: () => ds.panel('', list([['Usage telemetry', '—']]) + '<div class="ds-note">A layer with no tokens is a measured 0.</div>'),
};
export const NoteOnly = {
  render: () => ds.panel('', '<div class="ds-note">Ratios are computed from the token values; a translucent surface is measured over its context’s canvas.</div>'),
};
export const RTL = { ...KeyValueList, ...rtl };
export const Tablet = { ...KeyValueList, ...tablet };
export const Mobile = { ...KeyValueList, ...mobile };

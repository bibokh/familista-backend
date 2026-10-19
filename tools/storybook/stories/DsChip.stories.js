import { ds, rtl, tablet, mobile } from './_support.js';

// Untitled only: a title writes title="…" on the span, which the Specimen Lab's
// sanitizer does not allow, so titled chips and evChip are left out (see tests/cases.mjs).
const KINDS = [['ok', 'Pass'], ['crit', 'New failure'], ['info', 'Platform Owner only'], ['warn', 'Known failure'], ['rec', 'Recorded'], ['none', 'Not recorded']];

export default {
  title: 'Familista/chip',
  parameters: { docs: { description: { component: 'Real Owner Kit `chip(kind, label, title, extra)`, cut from public/design-system/design-system.js: a state and its label, the dot decorative (aria-hidden). Shown untitled.' } } },
  args: { kind: 'ok', label: 'Pass', size: 'ds-chip--sm' },
  argTypes: {
    kind: { control: 'select', options: ['ok', 'warn', 'crit', 'info', 'rec', 'none'] },
    size: { control: 'select', options: ['ds-chip--sm', ''] },
  },
  render: (a) => ds.chip(a.kind, a.label, '', a.size),
};

export const Pass = {};
export const AllKinds = { render: () => KINDS.map(([k, l]) => ds.chip(k, l, '', 'ds-chip--sm')).join(' ') };
export const DefaultSize = { args: { kind: 'info', label: 'Read-only', size: '' } };
export const RTL = { ...AllKinds, ...rtl };
export const Tablet = { ...AllKinds, ...tablet };
export const Mobile = { ...AllKinds, ...mobile };

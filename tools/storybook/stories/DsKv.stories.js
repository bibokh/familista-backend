import { ds, rtl, tablet, mobile } from './_support.js';

export default {
  title: 'Familista/kv',
  parameters: { docs: { description: { component: 'Real Owner Kit `kv(label, value)`, cut from public/design-system/design-system.js with its own `T` and `esc`: a label and a value on one row. The label is escaped and translated; the value is HTML the caller composes. A measured zero is a value; “—” means the platform does not keep it.' } } },
  args: { label: 'Tokens', value: '128' },
  render: (a) => ds.kv(a.label, a.value),
};

export const LabelAndValue = {};
export const ZeroIsAValue = { args: { label: 'New failures', value: '0' } };
export const NotRecorded = { args: { label: 'Usage telemetry', value: '—' } };
export const LongLabel = { args: { label: 'Failures beyond the Stage 2a record', value: '3' } };
// Production lists rows inside .ds-kv-list, as the room's panels do.
export const InAList = {
  render: () => '<div class="ds-kv-list">' + [['Tokens', '128'], ['New failures', '0'], ['Usage telemetry', '—']]
    .map(([k, v]) => ds.kv(k, v)).join('') + '</div>',
};
export const RTL = { ...InAList, ...rtl };
export const Tablet = { ...InAList, ...tablet };
export const Mobile = { ...InAList, ...mobile };

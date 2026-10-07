import { lg, rtl, tablet, mobile } from './_support.js';

export default {
  title: 'Familista/_lgMetric',
  parameters: { docs: { description: { component: 'Real `_lgMetric(label, value, sub, cls)`. A measured zero renders `0`; a figure the platform does not keep (null or empty) renders `—`. They are different answers.' } } },
  args: { label: 'High-speed distance', value: '812 m', sub: 'last 28 days', cls: '' },
  argTypes: { cls: { control: 'select', options: ['', 'lg-metric--hero'] } },
  render: (a) => lg._lgMetric(a.label, a.value === 'null' ? null : a.value, a.sub, a.cls),
};

export const Value = {};
export const MeasuredZero = { args: { label: 'Sprints', value: 0, sub: '' } };
export const NotRecorded = { args: { label: 'Peak heart rate', value: 'null', sub: 'No ECG device paired' } };
export const EmptyString = { args: { label: 'Distance', value: '', sub: '' } };
export const Hero = { args: { label: 'Readiness', value: '86', sub: 'Ready', cls: 'lg-metric--hero' } };
export const Row = {
  render: () => '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">'
    + lg._lgMetric('Minutes played', '1,284') + lg._lgMetric('Sprints', 0) + lg._lgMetric('Peak heart rate', null, 'Not recorded')
    + lg._lgMetric('Readiness', '86', 'Ready', 'lg-metric--hero') + '</div>',
};
export const RTL = { ...Row, ...rtl };
export const Tablet = { ...Row, ...tablet };
export const Mobile = { ...Row, ...mobile };

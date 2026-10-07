// Shared by every story file. `lg` holds the REAL primitives, cut out of
// public/app.js by .storybook/lg-plugin.js; nothing here re-implements them.
import { lg } from 'virtual:familista-lg';
import { seedClubs } from '../tests/cases.mjs';

seedClubs(lg); // two sample clubs; app.js fills this registry at login in production

export { lg };

// Story-level globals for the review variants every primitive carries.
export const rtl = { globals: { direction: 'rtl' } };
export const tablet = { globals: { viewport: { value: 'tablet', isRotated: false } } };
export const mobile = { globals: { viewport: { value: 'mobile', isRotated: false } } };

export const note = (text) => ({ docs: { description: { story: text } } });

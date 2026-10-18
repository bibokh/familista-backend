// Turns the snippets taken from public/app.js into callable functions.
//
// This file is deliberately free of Node APIs so the browser (Storybook) and
// Node (the golden tests) run the identical code path. The snippets are the
// production source text, unmodified; nothing here rewrites or wraps a single
// production line other than placing them in one function scope.
//
// Sloppy mode on purpose: public/app.js is a classic script, and the snippets
// must behave exactly as they do there.

export const PRIMITIVES = [
  '_lgCrest', '_lgIdent', '_lgChip', '_lgStatusChip', '_lgForm',
  '_lgMetric', '_lgPanel', '_lgEmpty', '_lgFloat', '_lgVersus',
  // M3/S2.1b: the identity components, appended so the ten above keep their order.
  '_lgIcon', 'clubLogoHtml', 'clubIdentityHtml',
];

// Helpers the cases and stories read; one that is also a primitive is returned once.
const HELPERS = ['CLUB_IDENT', '_esc', '_lgIcon', '_lgInitials', '_lgStatus'];

// Owner Kit render functions, cut from the design-system.js IIFE: kv (M3/S2.2a), panel (M3/S2.2b-1),
// chip, emptyState and skeleton (M3/S2.2b-2).
export const DS_PRIMITIVES = ['kv', 'panel', 'chip', 'emptyState', 'skeleton'];

export function buildLg(snippets) {
  const body = snippets.map((s) => s.code).join('\n\n')
    + '\nreturn { ' + [...new Set([...HELPERS, ...PRIMITIVES])].map((n) => n + ': ' + n).join(', ') + ' };';
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

// The Owner Kit scope. Strict mode, as the IIFE the snippets come from is; the
// translator is the room's real T at its initial state, so every string is English.
export function buildDs(snippets) {
  const body = "'use strict';\n" + snippets.map((s) => s.code).join('\n\n')
    + '\nreturn { T: T, esc: esc, DS_LANG: DS_LANG, DS_DICT: DS_DICT, DS_SEEN: DS_SEEN, ' + DS_PRIMITIVES.map((n) => n + ': ' + n).join(', ') + ' };';
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

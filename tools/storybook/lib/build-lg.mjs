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
];

export function buildLg(snippets) {
  const body = snippets.map((s) => s.code).join('\n\n')
    + '\nreturn { CLUB_IDENT: CLUB_IDENT, _esc: _esc, _lgIcon: _lgIcon, _lgInitials: _lgInitials,'
    + ' _lgStatus: _lgStatus, ' + PRIMITIVES.map((n) => n + ': ' + n).join(', ') + ' };';
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

// Reads public/app.js (read-only) and cuts out the exact declarations the ten
// _lg* primitives and the three identity components (_lgIcon, clubLogoHtml,
// clubIdentityHtml) need. Nothing is executed here and nothing is written.
//
// M3/S2.2a: the Owner Kit's render functions live inside the one IIFE that is
// the whole of public/design-system/design-system.js. extractDs() cuts them from
// the top level of that IIFE with the same cutter, after removing its two-space
// indent; the IIFE itself is never run.
//
// app.js itself is never loaded: it starts the health monitor, auto-login,
// telemetry and a dozen page-wide listeners the moment it runs. Only these
// named declarations are taken from it, by name, and each one is syntax-checked.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const APP_JS = path.join(REPO_ROOT, 'public', 'app.js');
export const DS_JS = path.join(REPO_ROOT, 'public', 'design-system', 'design-system.js');

// Every declaration taken from production, in dependency order.
//   fn  — a top-level `function name(...) { ... }`
//   var — a top-level `var NAME = ...;`
// CLUB_IDENT is taken as the real empty registry; stories fill it with sample clubs.
export const WANTED = [
  ['fn', '_esc'],
  ['var', 'CLUB_IDENT'], ['var', '_CLUB_LOGO_STEPS'], ['var', '_CLUB_LOGO_NAMES'],
  ['fn', '_clubIdentOf'], ['fn', '_clubCrestUrl'], ['fn', '_clubNameOf'],
  ['fn', '_clubShieldSvg'], ['fn', '_clubLogoStep'], ['fn', 'clubLogoHtml'], ['fn', 'clubIdentityHtml'],
  ['fn', '_lgInitials'], ['fn', '_lgCrest'], ['var', '_LG_ICON'], ['fn', '_lgIcon'],
  ['fn', '_lgIdent'], ['var', '_LG_STATUS'], ['fn', '_lgStatus'], ['fn', '_lgStatusChip'],
  ['fn', '_lgChip'], ['fn', '_lgForm'], ['fn', '_lgMetric'], ['fn', '_lgPanel'],
  ['fn', '_lgEmpty'], ['fn', '_lgFloat'], ['fn', '_lgVersus'],
];

// The Owner Kit declarations, in dependency order, from the top level of the
// design-system.js IIFE: the room's real translator at its initial state (English,
// an empty dictionary), its escaper, and the render functions previewed.
export const DS_WANTED = [
  ['var', 'DS_DICT'], ['var', 'DS_LANG'], ['var', 'DS_SEEN'],
  ['fn', 'T'], ['fn', 'esc'], ['fn', 'kv'], ['fn', 'panel'],
];

function lineOf(src, index) { return src.slice(0, index).split('\n').length; }

function matchOne(src, re, what, file = 'public/app.js') {
  const all = [...src.matchAll(re)];
  if (all.length !== 1) {
    throw new Error(`${file}: expected exactly one ${what}, found ${all.length}. `
      + 'The Storybook extractor reads production source by name; if this was renamed or '
      + 'duplicated on purpose, update tools/storybook/lib/extract-lg.mjs.');
  }
  return all[0].index;
}

/**
 * The top level of the one IIFE a file consists of, with its two-space indent
 * removed, so a declaration at that level starts at column 0 and one nested any
 * deeper does not. Refuses a file that is not exactly one `(function () { ... }());`.
 */
export function iifeScope(src, file) {
  const open = [...src.matchAll(/^\(function \(\) \{$/gm)];
  const close = [...src.matchAll(/^\}\(\)\);$/gm)];
  if (open.length !== 1 || close.length !== 1 || close[0].index < open[0].index) {
    throw new Error(`${file}: expected exactly one top-level "(function () {" ... "}());", found ${open.length} and ${close.length}`);
  }
  const body = src.slice(open[0].index + open[0][0].length, close[0].index);
  if (!/^\n  'use strict';\n/.test(body)) throw new Error(`${file}: the IIFE does not begin with 'use strict'`);
  return body.replace(/^  /gm, '');
}

// Brace matching that skips string literals and comments, so '<path d="..."/>'
// and "// it's" cannot unbalance it.
function endOfFunction(src, start) {
  let i = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
    if (c === '/') {
      // A regex literal (after one of these characters a `/` cannot be division).
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      if (j < 0 || '(,=:[!&|?{};'.includes(src[j])) {
        i++;
        let inClass = false;
        while (i < src.length && (inClass || src[i] !== '/')) {
          if (src[i] === '\\') i++;
          else if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          i++;
        }
        i++; continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  throw new Error('unbalanced braces while reading a function from public/app.js');
}

function endOfVar(src, start) {
  const eol = src.indexOf('\n', start);
  if (/;\s*(\/\/.*)?$/.test(src.slice(start, eol))) return eol;
  const m = /\n\};?[ \t]*(\r?\n|$)/.exec(src.slice(start));
  if (!m) throw new Error('could not find the end of a multi-line var in public/app.js');
  return start + m.index + m[0].trimEnd().length;
}

function cut(src, wanted, file, whole = src) {
  return wanted.map(([kind, name]) => {
    // Anywhere in the file, at any depth, the name is declared once: a second
    // declaration nested elsewhere would make "the" function ambiguous.
    const anywhere = kind === 'fn' ? new RegExp(`\\bfunction ${name}\\s*\\(`, 'g') : new RegExp(`\\bvar ${name}\\b`, 'g');
    matchOne(whole, anywhere, `declaration of ${name} at any depth`, file);
    if (kind === 'fn' && new RegExp(`(?<![\\w$.])${name}\\s*=(?![=>])`).test(whole)) {
      throw new Error(`${file}: "${name}" is reassigned; the declaration cut is not the function that runs`);
    }
    const re = kind === 'fn'
      ? new RegExp(`^function ${name}\\(`, 'gm')
      : new RegExp(`^var ${name}\\b`, 'gm');
    const start = matchOne(src, re, `top-level ${kind === 'fn' ? 'function' : 'var'} ${name}`, file);
    const end = kind === 'fn' ? endOfFunction(src, start) : endOfVar(src, start);
    const code = src.slice(start, end);
    // Syntax-check each snippet on its own, so a bad cut names its culprit.
    try { new Function(code); } catch (e) { throw new Error(`snippet ${name} does not parse: ${e.message}`); }
    return { name, kind, line: lineOf(src, start), code };
  });
}

export function extractLg(appJs = APP_JS) {
  return cut(fs.readFileSync(appJs, 'utf8'), WANTED, 'public/app.js');
}

/** The Owner Kit snippets, cut from the top level of the design-system.js IIFE. Nothing in that file is run. */
export function extractDs(dsJs = DS_JS, wanted = DS_WANTED) {
  const whole = fs.readFileSync(dsJs, 'utf8');
  return cut(iifeScope(whole, 'public/design-system/design-system.js'), wanted, 'public/design-system/design-system.js', whole);
}

export function readAppJs(appJs = APP_JS) { return fs.readFileSync(appJs, 'utf8'); }

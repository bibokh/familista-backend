// Reads public/app.js (read-only) and cuts out the exact declarations the ten
// _lg* primitives need. Nothing is executed here and nothing is written.
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

// Every declaration taken from production, in dependency order.
//   fn  — a top-level `function name(...) { ... }`
//   var — a top-level `var NAME = ...;`
// CLUB_IDENT is taken as the real empty registry; stories fill it with sample clubs.
export const WANTED = [
  ['fn', '_esc'],
  ['var', 'CLUB_IDENT'], ['var', '_CLUB_LOGO_STEPS'], ['var', '_CLUB_LOGO_NAMES'],
  ['fn', '_clubIdentOf'], ['fn', '_clubCrestUrl'], ['fn', '_clubNameOf'],
  ['fn', '_clubShieldSvg'], ['fn', '_clubLogoStep'], ['fn', 'clubLogoHtml'],
  ['fn', '_lgInitials'], ['fn', '_lgCrest'], ['var', '_LG_ICON'], ['fn', '_lgIcon'],
  ['fn', '_lgIdent'], ['var', '_LG_STATUS'], ['fn', '_lgStatus'], ['fn', '_lgStatusChip'],
  ['fn', '_lgChip'], ['fn', '_lgForm'], ['fn', '_lgMetric'], ['fn', '_lgPanel'],
  ['fn', '_lgEmpty'], ['fn', '_lgFloat'], ['fn', '_lgVersus'],
];

function lineOf(src, index) { return src.slice(0, index).split('\n').length; }

function matchOne(src, re, what) {
  const all = [...src.matchAll(re)];
  if (all.length !== 1) {
    throw new Error(`public/app.js: expected exactly one ${what}, found ${all.length}. `
      + 'The Storybook extractor reads production source by name; if this was renamed or '
      + 'duplicated on purpose, update tools/storybook/lib/extract-lg.mjs.');
  }
  return all[0].index;
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

export function extractLg(appJs = APP_JS) {
  const src = fs.readFileSync(appJs, 'utf8');
  return WANTED.map(([kind, name]) => {
    const re = kind === 'fn'
      ? new RegExp(`^function ${name}\\(`, 'gm')
      : new RegExp(`^var ${name}\\b`, 'gm');
    const start = matchOne(src, re, `top-level ${kind === 'fn' ? 'function' : 'var'} ${name}`);
    const end = kind === 'fn' ? endOfFunction(src, start) : endOfVar(src, start);
    const code = src.slice(start, end);
    // Syntax-check each snippet on its own, so a bad cut names its culprit.
    try { new Function(code); } catch (e) { throw new Error(`snippet ${name} does not parse: ${e.message}`); }
    return { name, kind, line: lineOf(src, start), code };
  });
}

export function readAppJs(appJs = APP_JS) { return fs.readFileSync(appJs, 'utf8'); }

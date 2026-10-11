// Familista Design Core — production CSS inventory (pure, dependency-free).
//
// Reads CSS text and returns every custom-property declaration with its
// selector, enclosing at-rules and line, plus every var() reference. It never
// touches the file system: callers hand it text, so the same code runs in
// Node (the ratchet) and in a browser (Storybook's legacy-map story).
//
// It is a scanner for the CSS Familista ships, not a general CSS parser:
// comments, strings and parenthesised values (url(data:…;…), :is(…), var(…))
// are skipped as units so a semicolon or brace inside them cannot split a
// declaration.

/** @typedef {{ name: string, value: string, selector: string, atRules: string[], line: number }} Declaration */

const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?/g;

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

function squash(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/** Index of the character after a quoted string starting at i. */
function skipString(text, i) {
  const q = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== q) j += text[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** Index of the character after the parenthesised group starting at i. */
function skipParens(text, i) {
  let depth = 1;
  let j = i + 1;
  while (j < text.length && depth) {
    const c = text[j];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '"' || c === "'") { j = skipString(text, j); continue; }
    j++;
  }
  return j;
}

/**
 * Every custom-property declaration in `text`, in source order.
 * @param {string} text
 * @returns {Declaration[]}
 */
export function scanCustomProperties(text) {
  const out = [];
  const stack = [];
  const lineStarts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") { i = skipString(text, i); continue; }
    if (c === '(') { i = skipParens(text, i); continue; }
    if (c === '{') {
      stack.push(squash(stripComments(text.slice(start, i))));
      start = i + 1;
    } else if (c === ';' || c === '}') {
      const seg = text.slice(start, i);
      const decl = stripComments(seg).trim();
      if (decl.startsWith('--') && stack.length) {
        const colon = decl.indexOf(':');
        if (colon > 2) {
          const lead = seg.length - seg.trimStart().length;
          out.push({
            name: decl.slice(0, colon).trim(),
            value: squash(decl.slice(colon + 1)),
            selector: stack[stack.length - 1],
            atRules: stack.slice(0, -1).filter((s) => s.startsWith('@')),
            line: lineOf(start + lead),
          });
        }
      }
      if (c === '}') stack.pop();
      start = i + 1;
    }
    i++;
  }
  return out;
}

/**
 * Every var() reference in `text`: name → { count, withFallback }.
 * @param {string} text
 * @param {{ css?: boolean }} [opts]
 */
export function scanVarReferences(text, { css = true } = {}) {
  // CSS comments are removed so documentation cannot inflate a count. In
  // JavaScript "/*" can sit inside a string or a regex, so JS is scanned as is.
  const clean = css ? stripComments(text) : text;
  /** @type {Map<string, { count: number, withFallback: number }>} */
  const refs = new Map();
  for (const m of clean.matchAll(VAR_REF)) {
    const r = refs.get(m[1]) || { count: 0, withFallback: 0 };
    r.count++;
    if (m[2]) r.withFallback++;
    refs.set(m[1], r);
  }
  return refs;
}

/**
 * Stable identity for a declaration that does not move when unrelated CSS
 * moves: file, selector, at-rules, name, and which occurrence of that name it
 * is inside the same selector. Line numbers are reported, never keyed on.
 * @param {string} fileKey
 * @param {Declaration[]} decls
 */
export function keyDeclarations(fileKey, decls) {
  const seen = new Map();
  return decls.map((d) => {
    const base = [fileKey, d.atRules.join(' && '), d.selector, d.name].join(' | ');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return { key: base + ' | ' + n, file: fileKey, ...d };
  });
}

/** Normalise a file path whose name carries a build hash (Vite assets). */
export function fileKeyOf(relPath) {
  return relPath.replace(/-[A-Za-z0-9_-]{8}\.css$/, '-[hash].css');
}

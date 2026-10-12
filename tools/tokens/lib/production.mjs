// Familista Design Core — the production stylesheets, read-only (Node only).
//
// Finds every stylesheet production serves, assigns each to the page that
// loads it, and inventories its custom properties. It reads public/ and never
// writes to it.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCustomProperties, scanVarReferences, keyDeclarations, fileKeyOf } from './css-inventory.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC = join(REPO_ROOT, 'public');

/** The pages production serves and how each one finds its stylesheets. */
const SURFACES = [
  { id: 'main', label: 'Familista app (index.html)', html: 'public/index.html' },
  { id: 'admin', label: 'Admin console (familista-admin.html)', html: 'public/familista-admin.html' },
  { id: 'invite', label: 'Invitation page (invite/index.html)', html: 'public/invite/index.html' },
  { id: 'react', label: 'React SPA at /app (built assets)', dir: 'public/app/assets' },
  // Stage 3.1: a room the main app loads on demand (public/app.js, lazy loader).
  // It is not linked from index.html, so it is named here rather than missed.
  { id: 'lazy', label: 'Rooms loaded on demand by the main app', files: ['public/design-system/design-system.css', 'public/design-system/explorer.css', 'public/design-system/components.css'] },
];

const rel = (p) => relative(REPO_ROOT, p).split('\\').join('/');

/**
 * The Design Core's own published copy. It is the canonical source rendered,
 * not a legacy stylesheet: it is verified byte-for-byte against dist/ (see
 * verify.mjs), so the legacy inventory excludes it. Nothing else under
 * public/tokens/ is excluded.
 */
export const PUBLISHED_TOKENS = 'public/tokens/familista-tokens.css';

function linkedStylesheets(htmlRel, { canonical = false } = {}) {
  const html = readFileSync(join(REPO_ROOT, htmlRel), 'utf8');
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?stylesheet/i.test(tag)) continue;
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href || /^(https?:)?\/\//i.test(href)) continue; // third-party (fonts) is not ours to inventory
    const path = href.split('?')[0];
    const file = path.startsWith('/') ? join(PUBLIC, path) : join(REPO_ROOT, dirname(htmlRel), path);
    if (canonical || rel(file) !== PUBLISHED_TOKENS) out.push(rel(file));
  }
  return out;
}

function allCss(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allCss(p, acc);
    else if (name.endsWith('.css')) acc.push(rel(p));
  }
  return acc;
}

/**
 * Which stylesheets each surface loads, in load order, with nothing collapsed:
 * a stylesheet two pages load appears under both, and the canonical token CSS
 * is included (the inventory excludes it; a map of what loads what must not).
 * Read-only. Stage 3.2.1 (Visual Explorer).
 */
export function surfaceLoads() {
  return SURFACES.map((s) => {
    const list = s.files ? s.files : s.html
      ? linkedStylesheets(s.html, { canonical: true })
      : readdirSync(join(REPO_ROOT, s.dir)).filter((f) => f.endsWith('.css')).sort().map((f) => `${s.dir}/${f}`);
    return {
      id: s.id, label: s.label,
      via: s.files ? 'declared' : s.html ? 'link' : 'directory',
      origin: s.html || s.dir || 'tools/tokens/lib/production.mjs',
      files: list.filter((f) => existsSync(join(REPO_ROOT, f))),
    };
  });
}

/**
 * Every production stylesheet, by surface, in load order. `unassigned` lists
 * any .css under public/ that no surface loads — the inventory refuses to
 * call itself complete while that list is not empty.
 */
export function productionStylesheets() {
  const files = [];
  for (const s of SURFACES) {
    const list = s.files ? s.files : s.html
      ? linkedStylesheets(s.html)
      : readdirSync(join(REPO_ROOT, s.dir)).filter((f) => f.endsWith('.css')).sort().map((f) => `${s.dir}/${f}`);
    for (const f of list) if (existsSync(join(REPO_ROOT, f)) && !files.some((x) => x.file === f)) files.push({ surface: s.id, file: f });
  }
  const assigned = new Set(files.map((f) => f.file));
  const unassigned = allCss(PUBLIC).filter((f) => !assigned.has(f) && f !== PUBLISHED_TOKENS).sort();
  return { surfaces: SURFACES, files, unassigned };
}

/**
 * The full inventory: every custom-property declaration (keyed), every var()
 * reference, and the names referenced but declared nowhere.
 */
export function inventoryProduction() {
  const { surfaces, files, unassigned } = productionStylesheets();
  const declarations = [];
  const refs = new Map();
  for (const { surface, file } of files) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const d of keyDeclarations(fileKeyOf(file), scanCustomProperties(text))) declarations.push({ surface, ...d });
    for (const [n, r] of scanVarReferences(text)) {
      const acc = refs.get(n) || { count: 0, withFallback: 0, files: new Set() };
      acc.count += r.count; acc.withFallback += r.withFallback; acc.files.add(fileKeyOf(file));
      refs.set(n, acc);
    }
  }
  const declared = new Set(declarations.map((d) => d.name));
  // --fam-* is declared by the published token CSS, which this inventory
  // excludes on purpose; a room that reads it (Stage 3.1) is not an undefined name.
  const undefinedRefs = [...refs].filter(([n]) => !declared.has(n) && !n.startsWith('--fam-'))
    .map(([n, r]) => ({ name: n, count: r.count, withFallback: r.withFallback, files: [...r.files].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // app.js writes var(--…) into inline styles; names it uses that no
  // stylesheet declares are part of the same protection.
  const appJs = readFileSync(join(PUBLIC, 'app.js'), 'utf8');
  const jsRefs = scanVarReferences(appJs, { css: false });
  const undefinedInAppJs = [...jsRefs].filter(([n]) => !declared.has(n))
    .map(([n, r]) => ({ name: n, count: r.count, withFallback: r.withFallback }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { surfaces, files, unassigned, declarations, refs, undefinedRefs, undefinedInAppJs };
}

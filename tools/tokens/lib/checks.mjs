// Familista Design Core — verification logic shared by the CLI, the Jest
// ratchet and Storybook (pure, dependency-free).

import { validate, withVariants, resolvedCss, resolveValue, overrideLayers } from './dtcg.mjs';
import { parseColor, colorKey, composite, contrastRatio } from './color.mjs';

// ── Value normalisation ────────────────────────────────────────────────────
// Two CSS values are "equal" when a browser computes the same thing from
// them: #FBBF24 = rgba(251,191,36,1); .15s = 150ms; a shadow's omitted spread
// is 0; a gradient's first and last stops sit at 0% and 100%.

const COLOR_RE = /#[0-9a-f]{3,8}\b|rgba?\([^()]*\)/gi;

function splitTop(s) {
  const out = []; let depth = 0; let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
function normNumber(t) {
  let m = t.match(/^(-?\d*\.?\d+)(px|ms|s|em|%|deg)?$/);
  if (!m) return t;
  let n = parseFloat(m[1]); let unit = m[2] || '';
  if (unit === 's') { n = n * 1000; unit = 'ms'; }
  if (n === 0 && (unit === 'px' || unit === '')) return '0';
  return String(Math.round(n * 10000) / 10000) + unit;
}
function normShadow(part) {
  const toks = part.split(/\s+/);
  const inset = toks.includes('inset');
  const color = toks.find((t) => t.startsWith('rgba('));
  const lens = toks.filter((t) => t !== 'inset' && t !== color).map(normNumber);
  if (!color || lens.length < 2 || lens.length > 4 || !lens.every((l) => /^-?[\d.]+(px)?$|^0$/.test(l))) return null;
  while (lens.length < 4) lens.push('0');
  return [inset ? 'inset' : '', ...lens, color].filter(Boolean).join(' ');
}

/** Canonical form of a CSS value for equality. */
export function normalizeValue(v) {
  let s = String(v).trim().toLowerCase().replace(/\s*!important$/, '');
  s = s.replace(COLOR_RE, (c) => { const p = parseColor(c); return p ? colorKey(p) : c; });
  const g = s.match(/^linear-gradient\((.*)\)$/);
  if (g) {
    const parts = splitTop(g[1]).map((p) => p.replace(/\s+/g, ' '));
    const angle = /^-?[\d.]+deg$/.test(parts[0]) ? normNumber(parts.shift()) : '180deg';
    const stops = parts.map((p, i) => {
      const [c, pos] = p.split(' ');
      const implied = i === 0 ? '0%' : i === parts.length - 1 ? '100%' : null;
      return c + (pos && normNumber(pos) !== implied ? ' ' + normNumber(pos) : '');
    });
    return `linear-gradient(${angle},${stops.join(',')})`;
  }
  const parts = splitTop(s).map((p) => p.replace(/\s+/g, ' '));
  const shadows = parts.map(normShadow);
  if (shadows.every(Boolean)) return shadows.join(',');
  return parts.map((p) => p.split(' ').map(normNumber).join(' ').replace(/^['"]|['"]$/g, '')).join(',');
}

export const sameValue = (a, b) => normalizeValue(a) === normalizeValue(b);

// ── Contexts ──────────────────────────────────────────────────────────────

/** The token map as seen by a legacy declaration's context. */
export function viewFor(tree, tokens, { context, module }) {
  const picks = {};
  if (context === 'owner' || context === 'club') picks.context = context;
  if (module) picks.module = module;
  return withVariants(tree, tokens, picks);
}

// ── Legacy map ────────────────────────────────────────────────────────────

const COMPARABLE = new Set(['equal', 'diverges']);
export const STATUSES = new Set(['equal', 'diverges', 'component-param', 'no-canonical-role', 'dead-redeclared',
  'dead-overridden', 'light-theme', 'separate-surface']);

/**
 * Check the legacy map against a fresh production inventory and the token
 * source. Returns { errors, stats }.
 */
export function checkLegacyMap(map, inventory, tree) {
  const { tokens } = validate(tree);
  const errors = [];
  const live = new Map(inventory.declarations.map((d) => [d.key, d]));
  const mapped = new Map(map.entries.map((e) => [e.key, e]));
  for (const [key, d] of live) {
    const e = mapped.get(key);
    if (!e) { errors.push(`unmapped production custom property: ${key} = ${d.value} (line ${d.line}). Run node tools/tokens/scripts/inventory.mjs --write and classify it.`); continue; }
    if (e.liveValue !== d.value) errors.push(`${key}: production value is "${d.value}" but the map records "${e.liveValue}"`);
  }
  for (const key of mapped.keys()) if (!live.has(key)) errors.push(`map entry no longer in production: ${key}`);
  const stats = { entries: map.entries.length, byStatus: {}, byCategory: {}, verifiedEqual: 0, verifiedDiverges: 0 };
  for (const e of map.entries) {
    stats.byStatus[e.status] = (stats.byStatus[e.status] || 0) + 1;
    stats.byCategory[e.category] = (stats.byCategory[e.category] || 0) + 1;
    if (!STATUSES.has(e.status)) errors.push(`${e.key}: unknown status "${e.status}"`);
    if (!e.category || e.category === 'unmapped') errors.push(`${e.key}: not classified`);
    if (e.target && !tokens.has(e.target)) errors.push(`${e.key}: target ${e.target} is not a token`);
    if (COMPARABLE.has(e.status)) {
      if (!e.target) { errors.push(`${e.key}: status ${e.status} needs a target`); continue; }
      const view = viewFor(tree, tokens, e);
      const value = resolvedCss(view, e.target);
      const equal = sameValue(value, e.liveValue);
      if (equal !== (e.status === 'equal')) errors.push(`${e.key}: recorded "${e.status}" but ${e.target} resolves to ${value} against live ${e.liveValue}`);
      else if (equal) stats.verifiedEqual++; else stats.verifiedDiverges++;
    }
    if (e.status === 'dead-redeclared') {
      const later = map.entries.find((x) => x.file === e.file && x.selector === e.selector && x.name === e.name && x.atRules.join() === e.atRules.join() && x.key !== e.key && x.key > e.key);
      if (!later) errors.push(`${e.key}: marked dead-redeclared but nothing redeclares it later in the same block`);
    }
    if (e.status === 'dead-overridden') {
      for (const sel of e.overriddenBy || []) {
        if (!map.entries.some((x) => x.file === e.file && x.selector === sel && x.name === e.name)) errors.push(`${e.key}: marked overridden by ${sel}, which does not declare ${e.name}`);
      }
    }
  }
  return { errors, stats };
}

// ── Contrast ──────────────────────────────────────────────────────────────

export const THRESHOLDS = { text: 4.5, ui: 3, exempt: 0 };
const OPAQUE_SURFACES = ['canvas', 'sunken', 'base', 'raised', 'overlay'];
const LAYERED_SURFACES = ['panel', 'panel-muted', 'tile', 'tile-strong', 'glass'];

const rgbaOf = (c) => ({ r: c.components[0] * 255, g: c.components[1] * 255, b: c.components[2] * 255, a: c.alpha === undefined ? 1 : c.alpha });

function surfaceColors(view, name) {
  const canvas = rgbaOf(resolveValue(view, view.get('semantic.surface.canvas').value));
  const t = view.get(`semantic.surface.${name}`);
  const v = resolveValue(view, t.value);
  const layers = t.type === 'gradient' ? v.map((s) => rgbaOf(s.color)) : [rgbaOf(v)];
  return layers.map((c) => (c.a < 1 ? composite(c, canvas) : c));
}

/**
 * Every foreground/background pair Familista claims, per context, with its
 * WCAG ratio. A surface that is translucent is measured composited over the
 * context's canvas; a gradient by its worst stop.
 */
export function contrastPairs(tree) {
  const { tokens } = validate(tree);
  const layers = overrideLayers(tree, tokens).filter((l) => l.layer === 'module');
  const ownerModules = new Set(['system', 'data-vault', 'infrastructure-city', 'source-core', 'vision', 'cybersecurity', 'algorithms']);
  const out = [];
  const measure = (ctx, mod, view, fg, bgs, role) => {
    const c = rgbaOf(resolveValue(view, view.get(fg).value));
    if (c.a < 1) return;
    for (const bg of bgs) {
      const ratios = surfaceColors(view, bg).map((b) => contrastRatio(c, b));
      const ratio = Math.min(...ratios);
      const required = THRESHOLDS[role];
      out.push({ id: `${ctx}${mod ? '/' + mod : ''} ${fg.replace('semantic.', '')} on surface.${bg}`, context: ctx, module: mod || null,
        fg: fg.replace('semantic.', ''), bg: `surface.${bg}`, role, ratio, required, pass: ratio >= required });
    }
  };
  for (const ctx of ['club', 'owner']) {
    const view = withVariants(tree, tokens, { context: ctx });
    const all = [...OPAQUE_SURFACES, ...LAYERED_SURFACES];
    for (const t of ['primary', 'secondary', 'tertiary']) measure(ctx, null, view, `semantic.text.${t}`, all, 'text');
    measure(ctx, null, view, 'semantic.text.disabled', all, 'exempt');
    for (const t of ['brand.accent', 'focus.ring', ...['success', 'warning', 'critical', 'info', 'neutral', 'unverified'].map((s) => 'status.' + s)]) {
      measure(ctx, null, view, `semantic.${t}`, ['canvas', 'base', 'raised'], 'ui');
    }
    const domain = [...tokens.keys()].filter((p) => /^semantic\.(position|result|pathway|team|chart|pitch)\./.test(p));
    for (const p of domain) measure(ctx, null, view, p, ['canvas'], 'ui');
    for (const l of layers) {
      if ((ctx === 'owner') !== ownerModules.has(l.variant)) continue;
      const mview = withVariants(tree, tokens, { context: ctx, module: l.variant });
      for (const p of ['semantic.module.accent', 'semantic.module.accent-2']) measure(ctx, l.variant, mview, p, ['canvas', 'base'], 'ui');
    }
  }
  return out;
}

/** Failures that are not exempt and are not in the recorded baseline. */
export function newContrastFailures(pairs, baseline) {
  const known = new Set(baseline.failures);
  return pairs.filter((p) => p.role !== 'exempt' && !p.pass && !known.has(p.id));
}

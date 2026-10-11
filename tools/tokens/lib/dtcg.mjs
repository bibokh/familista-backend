// Familista Design Core — W3C Design Tokens Community Group (DTCG) format.
//
// Validates, resolves and formats a DTCG token tree. Pure and
// dependency-free: no file system, no Storybook, no browser API. The token
// file is the source of truth; everything that renders tokens (the CSS
// generator, Storybook, later the Owner Design System Control) consumes it
// through this module.
//
// Supported $type values (DTCG format, 2025.10): color, dimension, duration,
// cubicBezier, fontFamily, fontWeight, number, shadow, gradient.
// Familista additions live under $extensions["com.familista"] only:
//   unit     — CSS unit for a `number` token (letter-spacing in em)
//   angle    — CSS angle for a `gradient` token (DTCG gradients carry none)
//   source   — the live production value this token was taken from
//   overrides — on an override layer: the base subtree it re-declares
//   default  — on a context: it is the default; its values are re-asserted

export const EXT = 'com.familista';
const TYPES = new Set(['color', 'dimension', 'duration', 'cubicBezier', 'fontFamily', 'fontWeight', 'number', 'shadow', 'gradient']);
const REF = /^\{([^{}]+)\}$/;
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
  'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'BlinkMacSystemFont']);

export const isRef = (v) => typeof v === 'string' && REF.test(v);
export const refPath = (v) => v.match(REF)[1];

/**
 * Flatten a token tree. Groups carry $type to their descendants (DTCG
 * inheritance). Returns tokens in source order and every group's metadata.
 * @param {object} tree
 */
export function flatten(tree) {
  const tokens = new Map();
  const groups = new Map();
  const errors = [];
  (function walk(node, path, inheritedType, inheritedHints) {
    const type = node.$type || inheritedType;
    // Formatting hints (unit, angle) inherit down a group like $type does.
    const own = (node.$extensions && node.$extensions[EXT]) || {};
    const hints = { ...inheritedHints };
    for (const k of ['unit', 'angle']) if (own[k] !== undefined) hints[k] = own[k];
    if (path.length) groups.set(path.join('.'), { path: path.join('.'), node, type });
    for (const [k, child] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      if (/[{}.]/.test(k) || !k) errors.push(`${[...path, k].join('.')}: invalid name "${k}" (DTCG forbids "{", "}" and ".")`);
      if (child === null || typeof child !== 'object' || Array.isArray(child)) {
        errors.push(`${[...path, k].join('.')}: a group member must be a token or a group`);
        continue;
      }
      const p = [...path, k];
      if (Object.prototype.hasOwnProperty.call(child, '$value')) {
        tokens.set(p.join('.'), {
          path: p.join('.'), segments: p, type: child.$type || type, value: child.$value,
          description: child.$description || '', ext: { ...hints, ...((child.$extensions && child.$extensions[EXT]) || {}) },
        });
      } else {
        walk(child, p, type, hints);
      }
    }
  })(tree, [], undefined, {});
  return { tokens, groups, errors };
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const hex2 = (n) => Math.round(n).toString(16).padStart(2, '0');

function checkColor(v) {
  if (!v || typeof v !== 'object') return 'color must be an object { colorSpace, components, alpha?, hex? }';
  if (v.colorSpace !== 'srgb') return 'only the "srgb" colour space is used';
  if (!Array.isArray(v.components) || v.components.length !== 3 || !v.components.every((c) => isNum(c) && c >= 0 && c <= 1)) return 'components must be three numbers in 0–1';
  if (v.alpha !== undefined && !(isNum(v.alpha) && v.alpha >= 0 && v.alpha <= 1)) return 'alpha must be a number in 0–1';
  if (v.hex !== undefined) {
    if (!/^#[0-9a-f]{6}$/.test(v.hex)) return 'hex must be #rrggbb in lower case';
    const fromComponents = '#' + v.components.map((c) => hex2(c * 255)).join('');
    if (fromComponents !== v.hex) return `hex ${v.hex} does not match components (${fromComponents})`;
  }
  return null;
}
function checkDimension(v, units = ['px', 'rem']) {
  if (!v || typeof v !== 'object' || !isNum(v.value) || !units.includes(v.unit)) return `dimension must be { value: number, unit: ${units.join('|')} }`;
  return null;
}

/** Validate one raw (non-reference) value of a type; sub-values may be references. */
function checkValue(type, v, sub) {
  if (isRef(v)) return sub(v, type);
  switch (type) {
    case 'color': return checkColor(v);
    case 'dimension': return checkDimension(v);
    case 'duration': return checkDimension(v, ['ms', 's']);
    case 'cubicBezier':
      return Array.isArray(v) && v.length === 4 && v.every(isNum) && v[0] >= 0 && v[0] <= 1 && v[2] >= 0 && v[2] <= 1 ? null : 'cubicBezier must be [x1, y1, x2, y2] with x in 0–1';
    case 'fontFamily':
      return typeof v === 'string' || (Array.isArray(v) && v.length && v.every((s) => typeof s === 'string')) ? null : 'fontFamily must be a string or a non-empty array of strings';
    case 'fontWeight': return isNum(v) && v >= 1 && v <= 1000 ? null : 'fontWeight must be a number in 1–1000';
    case 'number': return isNum(v) ? null : 'number must be a finite number';
    case 'shadow': {
      const list = Array.isArray(v) ? v : [v];
      for (const s of list) {
        if (!s || typeof s !== 'object') return 'shadow must be an object or an array of objects';
        for (const k of ['offsetX', 'offsetY', 'blur', 'spread']) {
          const e = checkValue('dimension', s[k], sub); if (e) return `shadow.${k}: ${e}`;
        }
        const e = checkValue('color', s.color, sub); if (e) return `shadow.color: ${e}`;
        if (s.inset !== undefined && typeof s.inset !== 'boolean') return 'shadow.inset must be a boolean';
      }
      return null;
    }
    case 'gradient': {
      if (!Array.isArray(v) || v.length < 2) return 'gradient must be an array of at least two stops';
      for (const s of v) {
        const e = checkValue('color', s && s.color, sub); if (e) return `gradient stop colour: ${e}`;
        if (!(isNum(s.position) && s.position >= 0 && s.position <= 1)) return 'gradient stop position must be in 0–1';
      }
      return null;
    }
    default: return `unsupported $type "${type}"`;
  }
}

/**
 * Validate a token tree: names, types, value shapes, references (they must
 * exist and match the referring type) and loops.
 * @returns {{ tokens: Map, groups: Map, errors: string[] }}
 */
export function validate(tree) {
  const flat = flatten(tree);
  const { tokens, errors } = flat;
  // An override token takes its $type from the base token it re-declares.
  for (const layer of overrideLayers(tree, tokens)) {
    if (!layer.base) { errors.push(`${layer.layer}: override layer has no $extensions["${EXT}"].overrides`); continue; }
    for (const { path, basePath } of layer.entries) {
      const t = tokens.get(path);
      const base = tokens.get(basePath);
      if (!base) { errors.push(`${path}: re-declares ${basePath}, which does not exist`); continue; }
      if (!t.type) t.type = base.type;
      if (t.type !== base.type) errors.push(`${path}: is ${t.type} but ${basePath} is ${base.type}`);
      // Formatting hints (unit, angle) follow the base token; provenance does not.
      for (const k of ['unit', 'angle']) if (base.ext[k] !== undefined && t.ext[k] === undefined) t.ext = { ...t.ext, [k]: base.ext[k] };
    }
  }
  for (const t of tokens.values()) {
    if (!t.type) { errors.push(`${t.path}: no $type on the token or any ancestor group`); continue; }
    if (!TYPES.has(t.type)) { errors.push(`${t.path}: unsupported $type "${t.type}"`); continue; }
    const sub = (ref, expected) => {
      const target = tokens.get(refPath(ref));
      if (!target) return `reference ${ref} does not resolve`;
      if (target.type !== expected) return `reference ${ref} is ${target.type}, expected ${expected}`;
      return null;
    };
    const e = checkValue(t.type, t.value, sub);
    if (e) errors.push(`${t.path}: ${e}`);
    if (t.type === 'number' && t.ext.unit !== undefined && !['em', '%'].includes(t.ext.unit)) errors.push(`${t.path}: unsupported unit extension "${t.ext.unit}"`);
  }
  for (const path of tokens.keys()) {
    const seen = [];
    let cur = path;
    while (cur) {
      if (seen.includes(cur)) { errors.push(`${path}: reference loop ${[...seen, cur].join(' → ')}`); break; }
      seen.push(cur);
      const t = tokens.get(cur);
      cur = t && isRef(t.value) ? refPath(t.value) : null;
      if (cur && !tokens.has(cur)) break;
    }
    // Composite members can loop too: walk every reference they hold.
    const t = tokens.get(path);
    for (const r of refsIn(t.value)) {
      if (r === path || chainOf(tokens, r).includes(path)) errors.push(`${path}: composite reference loop through {${r}}`);
    }
  }
  return flat;
}

function refsIn(v) {
  if (isRef(v)) return [refPath(v)];
  if (Array.isArray(v)) return v.flatMap(refsIn);
  if (v && typeof v === 'object') return Object.values(v).flatMap(refsIn);
  return [];
}
function chainOf(tokens, path, seen = new Set()) {
  if (seen.has(path)) return [...seen];
  seen.add(path);
  const t = tokens.get(path);
  if (!t) return [...seen];
  for (const r of refsIn(t.value)) chainOf(tokens, r, seen);
  return [...seen];
}

/** Fully resolve a token's value (every reference replaced by its target's raw value). */
export function resolveValue(tokens, value, depth = 0) {
  if (depth > 32) throw new Error('reference depth exceeded');
  if (isRef(value)) {
    const t = tokens.get(refPath(value));
    if (!t) throw new Error(`unresolved reference ${value}`);
    return resolveValue(tokens, t.value, depth + 1);
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(tokens, v, depth + 1));
  if (value && typeof value === 'object' && !('colorSpace' in value) && !('unit' in value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(tokens, v, depth + 1)]));
  }
  return value;
}

const num = (n) => String(Math.round(n * 10000) / 10000);

function colorCss(v) {
  const [r, g, b] = v.components.map((c) => Math.round(c * 255));
  const a = v.alpha === undefined ? 1 : v.alpha;
  return a === 1 ? (v.hex || '#' + [r, g, b].map(hex2).join('')) : `rgba(${r}, ${g}, ${b}, ${num(a)})`;
}
function dimensionCss(v, type) {
  // A unitless 0 is valid for a length, never for a time.
  return v.value === 0 && type === 'dimension' ? '0' : num(v.value) + v.unit;
}
function familyCss(list) {
  return (Array.isArray(list) ? list : [list]).map((f) => (GENERIC_FAMILIES.has(f) ? f : `'${f.replace(/'/g, "\\'")}'`)).join(', ');
}

/**
 * Format a value as CSS. `refCss(path)` decides how a reference is written:
 * the generator writes var(--…), resolution writes the literal.
 */
export function toCss(type, value, ext, refCss) {
  if (isRef(value)) return refCss(refPath(value));
  const sub = (t, v) => toCss(t, v, {}, refCss);
  switch (type) {
    case 'color': return colorCss(value);
    case 'dimension': case 'duration': return dimensionCss(value, type);
    case 'cubicBezier': return `cubic-bezier(${value.map(num).join(', ')})`;
    case 'fontFamily': return familyCss(value);
    case 'fontWeight': return num(value);
    case 'number': return value === 0 ? '0' : num(value) + (ext.unit || '');
    case 'shadow':
      return (Array.isArray(value) ? value : [value]).map((s) =>
        [s.inset ? 'inset' : null, sub('dimension', s.offsetX), sub('dimension', s.offsetY), sub('dimension', s.blur),
          sub('dimension', s.spread), sub('color', s.color)].filter(Boolean).join(' ')).join(', ');
    case 'gradient':
      return `linear-gradient(${ext.angle || '180deg'}, ${value.map((s) => `${sub('color', s.color)} ${num(s.position * 100)}%`).join(', ')})`;
    default: throw new Error(`cannot format $type ${type}`);
  }
}

/** The literal CSS a token resolves to, with no var() left in it. */
export function resolvedCss(tokens, path) {
  const t = tokens.get(path);
  if (!t) throw new Error(`no token ${path}`);
  const literal = (p) => resolvedCss(tokens, p);
  return toCss(t.type, t.value, t.ext, literal);
}

/**
 * The CSS custom-property name for a token path.
 *   ref.color.navy.950        → --fam-ref-navy-950
 *   ref.<kind>.<rest>         → --fam-ref-<kind>-<rest>
 *   semantic.surface.canvas   → --fam-surface-canvas
 * Override layers are named after the base token they re-declare.
 */
export function cssName(path, prefix = 'fam') {
  const s = path.split('.');
  if (s[0] === 'ref') return `--${prefix}-ref-` + (s[1] === 'color' ? s.slice(2) : s.slice(1)).join('-');
  if (s[0] === 'semantic') return `--${prefix}-` + s.slice(1).join('-');
  throw new Error(`${path} is not a base token; override layers take the name of the token they re-declare`);
}

/**
 * Override layers (context, module, theme, lang, dir, media). Each declares
 * `$extensions["com.familista"].overrides` — the base subtree its members
 * re-declare — and contains one group per variant (owner, vision, ar, …).
 * Returns [{ layer, variant, base, isDefault, entries: [{ path, basePath }] }].
 */
export function overrideLayers(tree, tokens) {
  const out = [];
  for (const [layer, node] of Object.entries(tree)) {
    if (layer.startsWith('$') || layer === 'ref' || layer === 'semantic') continue;
    const base = node.$extensions && node.$extensions[EXT] && node.$extensions[EXT].overrides;
    for (const [variant, vnode] of Object.entries(node)) {
      if (variant.startsWith('$')) continue;
      const prefix = `${layer}.${variant}.`;
      const entries = [...tokens.keys()].filter((p) => p.startsWith(prefix))
        .map((p) => ({ path: p, basePath: `${base}.${p.slice(prefix.length)}` }));
      const isDefault = !!(vnode.$extensions && vnode.$extensions[EXT] && vnode.$extensions[EXT].default);
      out.push({ layer, variant, base, isDefault, description: vnode.$description || '', entries });
    }
  }
  return out;
}

/**
 * Base tokens whose value depends, through references, on any of `paths`.
 * CSS custom properties inherit their computed value, so when an override
 * block re-declares a token, every alias of it must be re-declared in the same
 * block or it would keep the value computed at :root.
 * @param {Map} tokens
 * @param {Iterable<string>} paths
 */
export function dependentsOf(tokens, paths) {
  const changed = new Set(paths);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [p, t] of tokens) {
      if (changed.has(p) || !(p.startsWith('semantic.') || p.startsWith('ref.'))) continue;
      if (refsIn(t.value).some((r) => changed.has(r))) { changed.add(p); grew = true; }
    }
  }
  for (const p of paths) changed.delete(p);
  return [...tokens.keys()].filter((p) => changed.has(p));
}

/**
 * A token map as seen inside a selection of override variants, e.g.
 * { context: 'owner', module: 'vision', lang: 'ar' }. Later layers in the
 * tree win, matching the generated CSS's source order.
 */
export function withVariants(tree, tokens, picks) {
  const view = new Map([...tokens].map(([k, v]) => [k, { ...v }]));
  for (const layer of overrideLayers(tree, tokens)) {
    if (picks[layer.layer] !== layer.variant) continue;
    for (const { path, basePath } of layer.entries) view.get(basePath).value = tokens.get(path).value;
  }
  return view;
}

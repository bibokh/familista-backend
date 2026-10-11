// Familista Design Core — DTCG → CSS custom properties (pure, deterministic).
//
// Same input, same bytes: tokens are emitted in source order, override layers
// in tree order, and nothing time- or machine-dependent is written. The output
// declares only --fam-* custom properties, so linking it can change nothing a
// reader sees until a rule chooses to read one of them.

import { validate, toCss, cssName, overrideLayers, dependentsOf } from './dtcg.mjs';

/**
 * @param {object} tree    the DTCG token tree (familista.tokens.json)
 * @param {object} target  the web binding (targets/web.json): prefix + selectors
 * @param {{ sourceHash?: string }} [opts]
 * @returns {string}
 */
export function buildCss(tree, target, opts = {}) {
  const { tokens, errors } = validate(tree);
  if (errors.length) throw new Error('token source is invalid:\n  ' + errors.join('\n  '));
  const prefix = target.prefix;
  const name = (p) => cssName(p, prefix);
  const varOf = (p) => `var(${name(p)})`;
  const decl = (cssProp, t, value) => `  ${cssProp}: ${toCss(t.type, value, t.ext, varOf)};`;
  const baseDecl = (p) => decl(name(p), tokens.get(p), tokens.get(p).value);

  const lines = [];
  lines.push('/*');
  lines.push(' * Familista Design Core — design tokens (generated; do not edit).');
  lines.push(' * Source: tools/tokens/familista.tokens.json (W3C DTCG format).');
  lines.push(' * Build:  node tools/tokens/scripts/build.mjs');
  if (opts.sourceHash) lines.push(` * Source SHA-256: ${opts.sourceHash}`);
  lines.push(' * Declares only --' + prefix + '-* custom properties. Nothing in production reads them yet.');
  lines.push(' */');
  lines.push('');

  const base = [...tokens.keys()].filter((p) => p.startsWith('ref.') || p.startsWith('semantic.'));
  lines.push(`${target.root} {`);
  let section = '';
  for (const p of base) {
    const s = p.split('.').slice(0, 2).join('.');
    if (s !== section) { lines.push(`  /* ${s} */`); section = s; }
    lines.push(baseDecl(p));
  }
  lines.push('}');

  const layers = overrideLayers(tree, tokens);
  for (const layer of layers) {
    const bind = target.selectors[layer.layer] && target.selectors[layer.layer][layer.variant];
    if (!bind) throw new Error(`targets/web.json has no selector for ${layer.layer}.${layer.variant}`);
    const own = layer.entries.map((e) => e.basePath);
    // A default variant re-asserts every base token its siblings override, so
    // it still wins when nested inside a sibling (a Club preview inside Owner).
    const reassert = layer.isDefault
      ? [...new Set(layers.filter((l) => l.layer === layer.layer && l !== layer).flatMap((l) => l.entries.map((e) => e.basePath)))]
      : [];
    const deps = dependentsOf(tokens, [...own, ...reassert]).filter((p) => !own.includes(p) && !reassert.includes(p));
    const body = [
      ...layer.entries.map((e) => decl(name(e.basePath), tokens.get(e.path), tokens.get(e.path).value)),
      ...reassert.filter((p) => !own.includes(p)).map(baseDecl),
      ...deps.map(baseDecl),
    ];
    lines.push('');
    lines.push(`/* ${layer.layer}: ${layer.variant}${layer.description ? ' — ' + layer.description : ''} */`);
    if (!body.length) { lines.push(`/* (reserved — no tokens yet) */`); continue; }
    const selectors = (bind.selector || bind).join(',\n');
    if (bind.media) {
      lines.push(`@media ${bind.media} {`);
      lines.push(selectors.split('\n').map((s) => '  ' + s).join('\n') + ' {');
      lines.push(...body.map((l) => '  ' + l));
      lines.push('  }');
      lines.push('}');
    } else {
      lines.push(selectors + ' {');
      lines.push(...body);
      lines.push('}');
    }
  }
  // Every selector in the binding must correspond to a variant in the source.
  for (const [layer, variants] of Object.entries(target.selectors)) {
    for (const variant of Object.keys(variants)) {
      if (!layers.some((l) => l.layer === layer && l.variant === variant)) throw new Error(`targets/web.json binds ${layer}.${variant}, which the token source does not declare`);
    }
  }
  return lines.join('\n') + '\n';
}

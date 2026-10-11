export * from './_kit.js';
import { tree, esc } from './_kit.js';

/** The tokens the Owner context re-declares, with both values. */
export function overrideList() {
  const owner = tree.context.owner;
  const rows = [];
  (function walk(node, path) {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      if (v && typeof v === 'object' && '$value' in v) rows.push([...path, k].join('.'));
      else if (v && typeof v === 'object') walk(v, [...path, k]);
    }
  })(owner, []);
  return `<p class="fam-fd-note">${rows.length} semantic tokens: ${rows.map((r) => `<code>${esc(r)}</code>`).join(', ')}. Tokens that alias them (module accent, team "us") are re-declared in the same block, so the cascade matches the model.</p>`;
}

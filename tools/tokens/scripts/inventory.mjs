#!/usr/bin/env node
// Production custom-property inventory and the legacy-map ratchet.
//   node tools/tokens/scripts/inventory.mjs          summary of production
//   node tools/tokens/scripts/inventory.mjs --check  exit 1 unless the map covers production exactly
//   node tools/tokens/scripts/inventory.mjs --write  refresh legacy-map.json's live columns
//
// --write never classifies anything. A new declaration is added as
// "unmapped" and a changed value is marked "review"; both keep --check (and
// the Jest ratchet) red until a person decides what the value means.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryProduction } from '../lib/production.mjs';
import { scanVarReferences } from '../lib/css-inventory.mjs';
import { checkLegacyMap } from '../lib/checks.mjs';
import { REPO_ROOT } from '../lib/production.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP = join(HERE, 'legacy-map.json');
const tree = () => JSON.parse(readFileSync(join(HERE, 'familista.tokens.json'), 'utf8'));
const inv = inventoryProduction();

if (process.argv.includes('--write')) {
  const map = JSON.parse(readFileSync(MAP, 'utf8'));
  const old = new Map(map.entries.map((e) => [e.key, e]));
  const jsRefs = scanVarReferences(readFileSync(join(REPO_ROOT, 'public', 'app.js'), 'utf8'), { css: false });
  let added = 0, changed = 0;
  map.entries = inv.declarations.map((d) => {
    const prev = old.get(d.key);
    const referenced = !!((inv.refs.get(d.name) || {}).count || (jsRefs.get(d.name) || {}).count);
    if (!prev) {
      added++;
      return { key: d.key, surface: d.surface, file: d.file, selector: d.selector, atRules: d.atRules, name: d.name, liveValue: d.value,
        context: null, module: null, theme: null, category: 'unmapped', target: null, variant: null, status: 'unmapped', referenced };
    }
    if (prev.liveValue !== d.value) { changed++; return { ...prev, liveValue: d.value, previousValue: prev.liveValue, status: 'review', referenced }; }
    return { ...prev, referenced };
  });
  map.undefinedNames = {
    css: inv.undefinedRefs.map((r) => ({ name: r.name, references: r.count, withFallback: r.withFallback, files: r.files })),
    appJs: inv.undefinedInAppJs.map((r) => ({ name: r.name, references: r.count, withFallback: r.withFallback })),
  };
  writeFileSync(MAP, JSON.stringify(map, null, 1) + '\n');
  console.log(`legacy-map.json: ${map.entries.length} entries; ${added} new (unmapped), ${changed} changed (review), ${old.size + added - map.entries.length} removed`);
} else if (process.argv.includes('--check')) {
  const map = JSON.parse(readFileSync(MAP, 'utf8'));
  const { errors, stats } = checkLegacyMap(map, inv, tree());
  if (inv.unassigned.length) errors.push(`stylesheets no production page loads (inventory would be incomplete): ${inv.unassigned.join(', ')}`);
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log(`legacy map covers all ${stats.entries} production declarations; ${stats.verifiedEqual} verified equal, ${stats.verifiedDiverges} verified divergent`);
} else {
  const bySurface = {};
  for (const d of inv.declarations) bySurface[d.surface] = (bySurface[d.surface] || 0) + 1;
  console.log(JSON.stringify({
    stylesheets: inv.files.length, unassigned: inv.unassigned, declarations: inv.declarations.length,
    names: new Set(inv.declarations.map((d) => d.name)).size, bySurface,
    undefinedCss: inv.undefinedRefs.map((r) => r.name), undefinedAppJs: inv.undefinedInAppJs.map((r) => r.name),
  }, null, 1));
}

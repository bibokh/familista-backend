#!/usr/bin/env node
// Generate tools/tokens/dist/familista-tokens.css from familista.tokens.json.
//   node tools/tokens/scripts/build.mjs          write the file
//   node tools/tokens/scripts/build.mjs --check  exit 1 if the file is stale
// Never writes outside tools/tokens/dist/.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCss } from '../lib/build-css.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = join(HERE, 'familista.tokens.json');
export const TARGET = join(HERE, 'targets', 'web.json');

export function generate() {
  const raw = readFileSync(SOURCE, 'utf8');
  const target = JSON.parse(readFileSync(TARGET, 'utf8'));
  const sourceHash = createHash('sha256').update(raw).digest('hex');
  return { css: buildCss(JSON.parse(raw), target, { sourceHash }), out: join(HERE, target.output) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { css, out } = generate();
  if (process.argv.includes('--check')) {
    const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
    if (current !== css) { console.error(`${out} is stale — run node tools/tokens/scripts/build.mjs`); process.exit(1); }
    console.log('familista-tokens.css is up to date');
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, css);
    console.log(`wrote ${out} (${css.length} bytes)`);
  }
}

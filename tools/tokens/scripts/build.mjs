#!/usr/bin/env node
// Generate tools/tokens/dist/familista-tokens.css from familista.tokens.json.
//   node tools/tokens/scripts/build.mjs          write the file(s)
//   node tools/tokens/scripts/build.mjs --check  exit 1 if either copy is stale
// Writes two byte-identical copies: dist/ (the build output Storybook reads)
// and public/tokens/ (the copy production serves). Nothing else is written.

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
  return {
    css: buildCss(JSON.parse(raw), target, { sourceHash }),
    out: join(HERE, target.output),
    publish: join(HERE, target.publish),
    version: target.version,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { css, out, publish } = generate();
  const copies = [out, publish];
  if (process.argv.includes('--check')) {
    const stale = copies.filter((f) => !existsSync(f) || readFileSync(f, 'utf8') !== css);
    if (stale.length) { console.error(`${stale.join(', ')} is stale — run node tools/tokens/scripts/build.mjs`); process.exit(1); }
    console.log('familista-tokens.css is up to date (dist and public/tokens, byte-identical)');
  } else {
    for (const f of copies) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, css);
      console.log(`wrote ${f} (${css.length} bytes)`);
    }
  }
}

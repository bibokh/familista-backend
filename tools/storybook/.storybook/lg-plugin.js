// A Vite plugin that exposes the real _lg* source to stories as `virtual:familista-lg`.
//
// It READS public/app.js at build time, cuts out only the named declarations
// (see lib/extract-lg.mjs) and hands them to stories as plain functions.
// app.js itself is never bundled or executed in Storybook.
//
// M3/S2.2a: the same module exports `ds`, the Owner Kit render functions cut from
// the top level of the design-system.js IIFE (extractDs); that file is never run either.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLg, extractDs, APP_JS, DS_JS } from '../lib/extract-lg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = 'virtual:familista-lg';
const RESOLVED = '\0' + ID;

export function familistaLg() {
  return {
    name: 'familista-lg',
    resolveId(id) { return id === ID ? RESOLVED : null; },
    load(id) {
      if (id !== RESOLVED) return null;
      this.addWatchFile(APP_JS);
      this.addWatchFile(DS_JS);
      const snippets = extractLg();
      const dsSnippets = extractDs();
      const buildPath = path.join(HERE, '..', 'lib', 'build-lg.mjs');
      return [
        `import { buildLg, buildDs } from ${JSON.stringify(buildPath)};`,
        `export const sources = ${JSON.stringify(snippets.map(({ name, line }) => ({ name, line })))};`,
        `export const lg = buildLg(${JSON.stringify(snippets)});`,
        `export const ds = buildDs(${JSON.stringify(dsSnippets)});`,
      ].join('\n');
    },
  };
}

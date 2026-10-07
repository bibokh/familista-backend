// A Vite plugin that exposes the real _lg* source to stories as `virtual:familista-lg`.
//
// It READS public/app.js at build time, cuts out only the named declarations
// (see lib/extract-lg.mjs) and hands them to stories as plain functions.
// app.js itself is never bundled or executed in Storybook.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLg, APP_JS } from '../lib/extract-lg.mjs';

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
      const snippets = extractLg();
      const buildPath = path.join(HERE, '..', 'lib', 'build-lg.mjs');
      return [
        `import { buildLg } from ${JSON.stringify(buildPath)};`,
        `export const sources = ${JSON.stringify(snippets.map(({ name, line }) => ({ name, line })))};`,
        `export const lg = buildLg(${JSON.stringify(snippets)});`,
      ].join('\n');
    },
  };
}

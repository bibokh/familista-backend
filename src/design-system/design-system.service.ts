// Familista Design System Control — read model.
//
// Serves the Owner-only room from ONE generated, committed manifest
// (src/design-system/generated/design-system-manifest.json, written by
// scripts/design-system-discover.js from tools/tokens/). It reads that file and
// nothing else: no database, no network, no request input, no environment
// value. It writes nothing and changes nothing; a design change is a reviewed
// change to tools/tokens/, merged and deployed by the CI-gated pipeline, never
// a request to this API.
//
// If the manifest is not beside the server, or is not the schema this code
// reads, the room says NOT_GENERATED and why. It never draws a figure it did
// not read.

import fs from 'fs';
import path from 'path';
import { config } from '../config';
import type { DesignManifest, DesignSystemOverview, DesignSystemTokens } from './types';

export const MANIFEST_SCHEMA = 1;
const MANIFEST_PATH = path.join(__dirname, 'generated', 'design-system-manifest.json');
const MISSING = 'The design-system manifest is not beside this server (run scripts/design-system-discover.js).';

let cached: { manifest: DesignManifest | null; reason: string | null } | null = null;

function isManifest(m: unknown): m is DesignManifest {
  const x = m as Partial<DesignManifest> | null;
  return !!x && x.schema === MANIFEST_SCHEMA && Array.isArray(x.sources) && Array.isArray(x.tokens)
    && Array.isArray(x.layers) && Array.isArray(x.contrast) && typeof x.overview === 'object' && x.overview !== null;
}

/** Read once per process: the manifest is part of the build and cannot change under a running server. */
function load(): { manifest: DesignManifest | null; reason: string | null } {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as unknown;
    cached = isManifest(parsed)
      ? { manifest: parsed, reason: null }
      : { manifest: null, reason: `The design-system manifest is not schema ${MANIFEST_SCHEMA}.` };
  } catch {
    cached = { manifest: null, reason: MISSING };
  }
  return cached;
}

/** Test seam: forget the cached read. */
export function resetDesignSystemCache(): void { cached = null; }

export function designSystemOverview(): DesignSystemOverview {
  const { manifest, reason } = load();
  const build = { commit: config.buildCommit };
  if (!manifest) {
    return { state: 'NOT_GENERATED', reason, readOnly: true, build, generator: null, sources: [], overview: null, layers: [] };
  }
  return {
    state: 'READY', reason: null, readOnly: true, build, generator: manifest.generator,
    sources: manifest.sources, overview: manifest.overview, layers: manifest.layers,
  };
}

export function designSystemTokens(): DesignSystemTokens {
  const { manifest, reason } = load();
  if (!manifest) return { state: 'NOT_GENERATED', reason, tokens: [], layers: [], contrast: [] };
  return { state: 'READY', reason: null, tokens: manifest.tokens, layers: manifest.layers, contrast: manifest.contrast };
}

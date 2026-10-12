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
import type {
  DesignManifest, DesignSystemOverview, DesignSystemTokens, GraphManifest, GraphView, GraphViewSummary,
  DesignSystemGraphIndex, DesignSystemGraphView,
  ComponentsManifest, ComponentRecord, ComponentSummary, DesignSystemComponentsIndex, DesignSystemComponentDetail,
  PreviewsManifest, DesignSystemPreviewsIndex, DesignSystemPreviewDetail,
} from './types';

// The one definition of a well-formed graph (plain JavaScript, copied to dist
// beside the compiled service by scripts/copy-runtime-assets.js).
interface GraphCore { VIEW_IDS: string[]; validateGraph(graph: unknown): string[] }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const graphCore: GraphCore = require('./graph-core.js');
// And the Components Registry's (Stage 3.2.2).
interface ComponentsCore { validateManifest(manifest: unknown): string[] }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const componentsCore: ComponentsCore = require('./components-core.js');
// And the Specimen Lab's (Stage 3.2.3), which shares one sanitizer with the browser.
interface PreviewsCore { validateManifest(manifest: unknown, ctx: { components: ComponentsManifest }): string[] }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const previewsCore: PreviewsCore = require('./previews-core.js');

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

// ── Visual Explorer (Stage 3.2.1) ────────────────────────────────────────────
//
// The graph manifest is read once and validated before a single node leaves the
// server: an unknown relationship, a missing source, a dangling edge or an
// overlapping node refuses the whole graph. A malformed graph is never repaired
// and never partly served.

export const GRAPH_SCHEMA = 1;
const GRAPH_PATH = path.join(__dirname, 'generated', 'design-system-graph.json');
const GRAPH_MISSING = 'The design-system graph manifest is not beside this server (run scripts/design-system-discover.js).';
const GRAPH_INVALID = 'The design-system graph manifest failed its integrity check, so none of it is served.';

let graphCached: { graph: GraphManifest | null; reason: string | null } | null = null;

function loadGraph(): { graph: GraphManifest | null; reason: string | null } {
  if (graphCached) return graphCached;
  try {
    const parsed = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8')) as unknown;
    graphCached = graphCore.validateGraph(parsed).length === 0
      ? { graph: parsed as GraphManifest, reason: null }
      : { graph: null, reason: GRAPH_INVALID };
  } catch {
    graphCached = { graph: null, reason: GRAPH_MISSING };
  }
  return graphCached;
}

/** Test seam: forget the cached graph read. */
export function resetDesignSystemGraphCache(): void { graphCached = null; }

/** The views a caller may ask for. Anything else is not a view. */
export function isGraphViewId(id: unknown): id is string {
  return typeof id === 'string' && graphCore.VIEW_IDS.indexOf(id) >= 0;
}

function summary(v: GraphView): GraphViewSummary {
  return { id: v.id, title: v.title, summary: v.summary, flow: v.flow, sources: v.sources, notes: v.notes, layout: v.layout, stats: v.stats };
}

export function designSystemGraphIndex(): DesignSystemGraphIndex {
  const { graph, reason } = loadGraph();
  if (!graph) return { state: 'NOT_GENERATED', reason, readOnly: true, generator: null, sources: [], views: [] };
  return { state: 'READY', reason: null, readOnly: true, generator: graph.generator, sources: graph.sources, views: graph.views.map(summary) };
}

/** `id` must already have passed isGraphViewId. */
export function designSystemGraphView(id: string): DesignSystemGraphView {
  const { graph, reason } = loadGraph();
  if (!graph) return { state: 'NOT_GENERATED', reason, sources: [], view: null };
  const view = graph.views.find((v) => v.id === id) ?? null;
  return { state: 'READY', reason: null, sources: graph.sources, view };
}

// ── Components Library (Stage 3.2.2) ─────────────────────────────────────────
//
// Read once and validated before a single component leaves the server, exactly
// as the graph is: a record that claims a tier its evidence does not earn, a
// call to a component that does not exist or a malformed field refuses the
// whole registry. Nothing is repaired and nothing is partly served. The manifest
// holds metadata and hashes, never source code.

export const COMPONENTS_SCHEMA = 1;
const COMPONENTS_PATH = path.join(__dirname, 'generated', 'design-system-components.json');
const COMPONENTS_MISSING = 'The design-system components manifest is not beside this server (run scripts/design-system-discover.js).';
const COMPONENTS_INVALID = 'The design-system components manifest failed its integrity check, so none of it is served.';

let componentsCached: { manifest: ComponentsManifest | null; ids: Set<string>; reason: string | null } | null = null;

function loadComponents(): { manifest: ComponentsManifest | null; ids: Set<string>; reason: string | null } {
  if (componentsCached) return componentsCached;
  try {
    const parsed = JSON.parse(fs.readFileSync(COMPONENTS_PATH, 'utf8')) as unknown;
    componentsCached = componentsCore.validateManifest(parsed).length === 0
      ? { manifest: parsed as ComponentsManifest, ids: new Set((parsed as ComponentsManifest).components.map((c) => c.id)), reason: null }
      : { manifest: null, ids: new Set(), reason: COMPONENTS_INVALID };
  } catch {
    componentsCached = { manifest: null, ids: new Set(), reason: COMPONENTS_MISSING };
  }
  return componentsCached;
}

/** Test seam: forget the cached components read. */
export function resetDesignSystemComponentsCache(): void { componentsCached = null; previewsCached = null; }

/** The components a caller may ask for. Anything else is not one. */
export function isComponentId(id: unknown): id is string {
  return typeof id === 'string' && loadComponents().ids.has(id);
}

function summarise(c: ComponentRecord): ComponentSummary {
  return {
    id: c.id, name: c.name, category: c.category, kind: c.kind, tier: c.tier, module: c.module, summary: c.summary,
    symbol: c.source.js ? c.source.js.symbol : null, sections: c.sections,
    counts: {
      rules: c.styling.rules, selectors: c.styling.selectorsTotal, variants: c.variants.length, anatomy: c.anatomy.length,
      cases: c.stories ? c.stories.cases.length : 0, facts: c.accessibility.facts.length,
      dependencies: c.dependencies.calls.length + c.dependencies.calledBy.length,
    },
  };
}

export function designSystemComponentsIndex(): DesignSystemComponentsIndex {
  const { manifest, reason } = loadComponents();
  if (!manifest) return { state: 'NOT_GENERATED', reason, readOnly: true, generator: null, sources: [], taxonomy: null, coverage: null, components: [] };
  return {
    state: 'READY', reason: null, readOnly: true, generator: manifest.generator, sources: manifest.sources,
    taxonomy: manifest.taxonomy, coverage: manifest.coverage, components: manifest.components.map(summarise),
  };
}

/** `id` must already have passed isComponentId. */
export function designSystemComponent(id: string): DesignSystemComponentDetail {
  const { manifest, reason } = loadComponents();
  if (!manifest) return { state: 'NOT_GENERATED', reason, sources: [], component: null };
  return { state: 'READY', reason: null, sources: manifest.sources, component: manifest.components.find((c) => c.id === id) ?? null };
}

// ── Specimen Lab (Stage 3.2.3 M1) ────────────────────────────────────────────
//
// The fixtures the Lab draws: markup the verified primitives produced for fixed
// inputs, already checked and neutralised by the shared sanitizer. Read once and
// validated before a single fixture leaves the server — every one is run back
// through the sanitizer, its hash and size recomputed, and its binding to the
// components manifest checked — so a fixture that is not exactly what the
// sanitizer would produce, or that has drifted from the source it was made from,
// refuses the whole manifest. The file is never placed under public/: it is
// reachable only through the owner-only router below.

export const PREVIEWS_SCHEMA = 1;
const PREVIEWS_PATH = path.join(__dirname, 'generated', 'design-system-previews.json');
const PREVIEWS_MISSING = 'The design-system previews manifest is not beside this server (run scripts/design-system-discover.js).';
const PREVIEWS_INVALID = 'The design-system previews manifest failed its integrity check, so none of it is served.';

let previewsCached: { manifest: PreviewsManifest | null; ids: Set<string>; reason: string | null } | null = null;

function loadPreviews(): { manifest: PreviewsManifest | null; ids: Set<string>; reason: string | null } {
  if (previewsCached) return previewsCached;
  try {
    const parsed = JSON.parse(fs.readFileSync(PREVIEWS_PATH, 'utf8')) as unknown;
    const components = loadComponents().manifest;
    previewsCached = components && previewsCore.validateManifest(parsed, { components }).length === 0
      ? { manifest: parsed as PreviewsManifest, ids: new Set((parsed as PreviewsManifest).components.map((c) => c.id)), reason: null }
      : { manifest: null, ids: new Set(), reason: PREVIEWS_INVALID };
  } catch {
    previewsCached = { manifest: null, ids: new Set(), reason: PREVIEWS_MISSING };
  }
  return previewsCached;
}

/** Test seam: forget the cached previews read. */
export function resetDesignSystemPreviewsCache(): void { previewsCached = null; }

/** The components that have fixtures. Anything else is not one. */
export function isPreviewId(id: unknown): id is string {
  return typeof id === 'string' && loadPreviews().ids.has(id);
}

export function designSystemPreviewsIndex(): DesignSystemPreviewsIndex {
  const { manifest, reason } = loadPreviews();
  if (!manifest) return { state: 'NOT_GENERATED', reason, readOnly: true, generator: null, sources: [], policy: null, coverage: null, availability: [], components: [] };
  return {
    state: 'READY', reason: null, readOnly: true, generator: manifest.generator, sources: manifest.sources, policy: manifest.policy,
    coverage: manifest.coverage, availability: manifest.availability,
    components: manifest.components.map((c) => ({ id: c.id, symbol: c.symbol, fixtures: c.fixtures.length, bytes: c.fixtures.reduce((n, f) => n + f.bytes, 0), variants: c.variants.length })),
  };
}

/** `id` must already have passed isPreviewId. */
export function designSystemPreview(id: string): DesignSystemPreviewDetail {
  const { manifest, reason } = loadPreviews();
  if (!manifest) return { state: 'NOT_GENERATED', reason, sources: [], component: null };
  return { state: 'READY', reason: null, sources: manifest.sources, component: manifest.components.find((c) => c.id === id) ?? null };
}

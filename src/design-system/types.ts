// Familista Design System Control — the shape of the generated manifest and of
// what the Owner-only API returns from it. The manifest is written by
// scripts/design-system-discover.js from tools/tokens/; nothing here is typed in.

/** How a figure is known. UNAVAILABLE is drawn as "—", never as 0. */
export type EvidenceState = 'MEASURED' | 'RECORDED';

export interface Evidence<T> { state: EvidenceState; value: T; source: string }

export interface ManifestSource { id: string; path: string; label: string; sha256: string; bytes: number }

export interface Unavailable { id: string; reason: string }

export interface DesignOverview {
  tokens: {
    total: Evidence<number>;
    byLayer: Evidence<Record<string, number>>;
    byType: Evidence<Record<string, number>>;
  };
  css: {
    prefix: string;
    version: string;
    declarations: Evidence<number>;
    bytes: Evidence<number>;
    publishedIdentical: Evidence<boolean>;
  };
  contexts: Evidence<number>;
  modules: Evidence<number>;
  legacyMap: {
    declarations: Evidence<number>;
    byStatus: Evidence<Record<string, number>>;
    undefinedNames: Evidence<{ css: number; appJs: number }>;
  };
  contrast: {
    pairs: Evidence<number>;
    byRole: Evidence<Record<string, number>>;
    failing: Evidence<number>;
    newFailures: Evidence<number>;
    baselineFailures: Evidence<number>;
    thresholds: Evidence<{ text: number; ui: number; exempt: string }>;
  };
  storybook: { storyFiles: Evidence<number>; foundationFiles: Evidence<number> };
  unavailable: Unavailable[];
}

export interface DesignToken {
  path: string;
  cssName: string;
  layer: string;
  type: string;
  declared: string;
  resolved: string;
  aliasOf: string | null;
  description: string | null;
  source: string | null;
}

export interface DesignLayer {
  layer: string;
  variant: string;
  base: string | null;
  isDefault: boolean;
  description: string | null;
  tokenCount: number;
  selectors: string[];
  media: string | null;
}

export interface ContrastPair {
  id: string;
  context: string;
  module: string | null;
  fg: string;
  bg: string;
  role: 'text' | 'ui' | 'exempt';
  ratio: number;
  required: number;
  pass: boolean;
  baseline: boolean;
}

export interface DesignManifest {
  schema: number;
  generator: string;
  description: string;
  sources: ManifestSource[];
  overview: DesignOverview;
  layers: DesignLayer[];
  tokens: DesignToken[];
  contrast: ContrastPair[];
}

export type Availability =
  | { state: 'READY' }
  | { state: 'NOT_GENERATED'; reason: string };

export interface DesignSystemOverview {
  state: 'READY' | 'NOT_GENERATED';
  reason: string | null;
  readOnly: true;
  build: { commit: string | null };
  generator: string | null;
  sources: ManifestSource[];
  overview: DesignOverview | null;
  layers: DesignLayer[];
}

export interface DesignSystemTokens {
  state: 'READY' | 'NOT_GENERATED';
  reason: string | null;
  tokens: DesignToken[];
  layers: DesignLayer[];
  contrast: ContrastPair[];
}

// ── Visual Explorer (Stage 3.2.1) ────────────────────────────────────────────
//
// The graph manifest is written by scripts/design-system-discover.js (built by
// scripts/design-system-graph.js, shaped and validated by graph-core.js).

export type GraphEvidence = 'MEASURED' | 'RECORDED';
export type GraphScalar = string | number | boolean | null;
export type GraphViewId = 'token-architecture' | 'legacy-to-canonical' | 'stylesheets-to-surfaces';
export type GraphNodeKind = 'reference' | 'semantic' | 'context' | 'module' | 'legacy' | 'stylesheet' | 'surface';
export type GraphEdgeKind = 'alias' | 'override' | 'maps-to' | 'loaded-by';

export interface GraphSource {
  id: string; path: string; label: string; sha256: string; bytes: number; basis: 'file' | 'derived';
}
export interface GraphProvenance { id: string; locator: string }

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  group: string;
  evidence: GraphEvidence;
  source: GraphProvenance;
  props: Record<string, GraphScalar>;
  w: number; h: number; isolated: boolean; x: number; y: number;
}
export interface GraphEdge {
  id: string;
  kind: GraphEdgeKind;
  from: string;
  to: string;
  evidence: GraphEvidence;
  source: GraphProvenance;
  count: number;
  props: Record<string, GraphScalar>;
}
export interface GraphColumn { id: string; label: string; x: number; y: number; w: number; count: number }
export interface GraphLayout { strategy: 'layered' | 'clusters'; width: number; height: number; nodeW: number; nodeH: number }
export interface GraphParked { x: number; y: number; w: number; count: number }
export interface GraphStats {
  nodes: number; edges: number; isolated: number;
  nodesByKind: Record<string, number>; edgesByKind: Record<string, number>;
  nodesByEvidence: Record<string, number>; edgesByEvidence: Record<string, number>;
}
export interface GraphViewSummary {
  id: GraphViewId; title: string; summary: string; flow: string[]; sources: string[]; notes: string[];
  layout: GraphLayout; stats: GraphStats;
}
export interface GraphView extends GraphViewSummary {
  columns: GraphColumn[];
  parked: GraphParked | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface GraphManifest {
  schema: number; generator: string; description: string; sources: GraphSource[]; views: GraphView[];
}

export interface DesignSystemGraphIndex {
  state: 'READY' | 'NOT_GENERATED';
  reason: string | null;
  readOnly: true;
  generator: string | null;
  sources: GraphSource[];
  views: GraphViewSummary[];
}
export interface DesignSystemGraphView {
  state: 'READY' | 'NOT_GENERATED';
  reason: string | null;
  sources: GraphSource[];
  view: GraphView | null;
}

// ── Components Library (Stage 3.2.2) ─────────────────────────────────────────
//
// The components manifest is written by scripts/design-system-discover.js (built
// by scripts/design-system-components.js from the reviewed
// tools/components/registry.json, shaped and validated by components-core.js).

export type ComponentKind = 'component' | 'primitive' | 'pattern' | 'css-family' | 'layout-utility' | 'page-specific' | 'candidate';
export type ComponentTier = 'verified' | 'catalogued' | 'listed';
export type ComponentEvidence = 'MEASURED' | 'RECORDED' | 'NONE';
export type ComponentSectionId = 'overview' | 'anatomy' | 'styling' | 'source' | 'variants' | 'stories' | 'accessibility' | 'dependencies';

export interface TaxonomyEntry { id: string; label: string; description?: string }
export interface ComponentsTaxonomy {
  categories: TaxonomyEntry[]; modules: TaxonomyEntry[]; kinds: TaxonomyEntry[]; tiers: TaxonomyEntry[];
}
export interface ComponentsCoverage {
  total: number; byKind: Record<string, number>; byTier: Record<string, number>; byCategory: Record<string, number>;
  withStories: number; withVariants: number; withSource: number;
}
export type ComponentSections = Record<ComponentSectionId, ComponentEvidence>;

export interface ComponentJsSource { file: string; symbol: string; sha256: string; bytes: number }
export interface ComponentCssSource { file: string; rules: number; sha256: string; bytes: number }
export interface ComponentPresence { file: string; matched: true }
export interface ComponentStyling {
  selectors: string[]; selectorsTotal: number; rules: number; states: string[]; mediaQueries: string[];
  customProperties: string[]; customPropertiesTotal: number; focusVisible: boolean; rtl: boolean; reducedMotion: boolean;
}
export interface ComponentPart { cls: string; rules: number; emitted: boolean | null }
export interface ComponentVariant { name: string; class: string; rules: number; cases: string[]; stories: string[]; exercised: boolean }
export interface ComponentStories {
  file: string; title: string; cases: string[]; golden: string[]; options: string[];
  review: { rtl: boolean; tablet: boolean; mobile: boolean };
}
export interface ComponentFact { id: string; label: string; evidence: 'MEASURED'; where: string }
export interface ComponentCall { symbol: string; component: string | null }

export interface ComponentRecord {
  id: string; name: string; category: string; kind: ComponentKind; tier: ComponentTier; module: string; summary: string;
  depth: 'full' | 'presence';
  source: { js: ComponentJsSource | null; css: ComponentCssSource[]; presence: ComponentPresence[] };
  styling: ComponentStyling;
  anatomy: ComponentPart[];
  variants: ComponentVariant[];
  stories: ComponentStories | null;
  accessibility: { facts: ComponentFact[] };
  dependencies: { calls: ComponentCall[]; calledBy: string[]; helpers: string[] };
  referencedIn: string[];
  sections: ComponentSections;
}
/** What the index lists: enough to search, filter, sort and draw a card; the rest comes with the component. */
export interface ComponentSummary {
  id: string; name: string; category: string; kind: ComponentKind; tier: ComponentTier; module: string; summary: string;
  symbol: string | null; sections: ComponentSections;
  counts: { rules: number; selectors: number; variants: number; anatomy: number; cases: number; facts: number; dependencies: number };
}
export interface ComponentsManifest {
  schema: number; generator: string; description: string; sources: GraphSource[];
  taxonomy: ComponentsTaxonomy; coverage: ComponentsCoverage; components: ComponentRecord[];
}
export interface DesignSystemComponentsIndex {
  state: 'READY' | 'NOT_GENERATED';
  reason: string | null;
  readOnly: true;
  generator: string | null;
  sources: GraphSource[];
  taxonomy: ComponentsTaxonomy | null;
  coverage: ComponentsCoverage | null;
  components: ComponentSummary[];
}
export interface DesignSystemComponentDetail {
  state: 'READY' | 'NOT_GENERATED';
  reason: string | null;
  sources: GraphSource[];
  component: ComponentRecord | null;
}

// ── Specimen Lab (Stage 3.2.3 M1) ────────────────────────────────────────────

export type PreviewReason = 'no-fixtures' | 'css-only' | 'application-shell' | 'utility' | 'css-family' | 'page-specific' | 'candidate';
export interface PreviewNeutralised { code: string; action: string; count: number }
export interface PreviewClass { name: string; owner: string; rules: number }
export interface PreviewFixture {
  id: string; label: string; call: string; html: string; sha256: string; bytes: number; nodes: number; elements: number; depth: number;
  tags: string[]; classes: PreviewClass[]; variantClasses: string[]; neutralised: PreviewNeutralised[]; goldenSha256: string;
}
export interface PreviewVariant { class: string; name: string; rules: number; exercisedBy: string[] }
export interface PreviewComponent {
  id: string; symbol: string;
  source: { js: ComponentJsSource; css: ComponentCssSource[] };
  mediaQueries: string[];
  variants: PreviewVariant[];
  fixtures: PreviewFixture[];
}
export interface PreviewAvailability { id: string; state: 'preview' | 'unavailable'; reason: PreviewReason | null }
export interface PreviewPolicyTag { ns: string; void: boolean; attributes: string[] }
export interface PreviewPolicy {
  version: number;
  tags: Record<string, PreviewPolicyTag>;
  limits: Record<string, number>;
  neutralised: { code: string; action: string }[];
}
export interface PreviewCoverage {
  registered: number; previewable: number; unavailable: number; fixtures: number; bytes: number; nodes: number;
  neutralised: Record<string, number>; byReason: Record<string, number>;
}
export interface PreviewsManifest {
  schema: number; generator: string; description: string; sources: GraphSource[];
  policy: PreviewPolicy; coverage: PreviewCoverage; components: PreviewComponent[]; availability: PreviewAvailability[];
}
/** The index never carries markup: counts and availability for every registered component, and the policy the markup was checked under. */
export interface PreviewComponentSummary { id: string; symbol: string; fixtures: number; bytes: number; variants: number }
export interface DesignSystemPreviewsIndex {
  state: 'READY' | 'NOT_GENERATED';
  reason: string | null;
  readOnly: true;
  generator: string | null;
  sources: GraphSource[];
  policy: PreviewPolicy | null;
  coverage: PreviewCoverage | null;
  availability: PreviewAvailability[];
  components: PreviewComponentSummary[];
}
export interface DesignSystemPreviewDetail {
  state: 'READY' | 'NOT_GENERATED';
  reason: string | null;
  sources: GraphSource[];
  component: PreviewComponent | null;
}

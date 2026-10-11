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

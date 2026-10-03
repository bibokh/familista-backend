// The evidence the Command Center reads — loaded once, never invented
// ─────────────────────────────────────────────────────────────────────────────
// Three files the Cyber Defense work already maintains, each regenerated or
// reviewed in CI:
//
//   generated/security-manifest.json   control statuses + the file proving each,
//                                      the API surface, crypto, supply chain
//   coverage-map.json                  38 trust boundaries; every discovered
//                                      component mapped onto them
//   posture-policy.json                required controls, known gaps, the RLS
//                                      pilot tables and reviewed system paths
//
// They are generated or reviewed at build and cannot change while the process
// runs, so they are read once (the Infrastructure City reads its manifest the
// same way). Both `dist/` and `src/` layouts are tried.
//
// What is kept is what the Command Center shows. Environment variable NAMES
// are dropped here — only their count leaves this module — and no value was
// ever in these files: the scanner refuses to write a manifest holding one.

import fs from 'fs';
import path from 'path';

export type ControlStatus = 'PRESENT' | 'PARTIAL' | 'ABSENT';

export interface ManifestControl { id: string; status: ControlStatus; evidence: string; note: string | null }

export interface ManifestMount { path: string; module: string; handlers: number; public: number; routerWideAuth: boolean }

export interface PostureEvidence {
  generatedAt: string;
  generator: string;
  controls: ManifestControl[];
  mounts: ManifestMount[];
  api: {
    routers: number; handlers: number; publicHandlers: number;
    dormantModules: number; outboundCallSites: number;
    authzByKind: Record<string, number>;
    authzByRouter: Record<string, Record<string, number>>;
    tenancy: { idParameters: number; guarded: number; exempt: number; unguarded: number };
    tenancyByRouter: Record<string, { guarded: number; exempt: number; unguarded: number }>;
  };
  secrets: { declared: number; secretNamed: number; inline: number };
  datastores: Array<{ kind: string; privateNetworkOnly: boolean }>;
  crypto: Array<{ primitive: string; algorithm: string }>;
  supplyChain: Record<string, unknown>;
  components: Record<string, number>;
}

export interface BoundaryRow {
  id: number;
  name: string;
  flow: string;
  trustBoundary: string;
  owner: string;
  dataClass: string;
  boundaryType: string;
  coverage: 'C' | 'P' | 'U';
  controls: string[];
  reason: string | null;
  plannedIn: string | null;
}

export interface CoverageEvidence {
  rows: BoundaryRow[];
  routers: Record<string, number[]>;
  ratchet: { U: number; P: number };
}

export interface PolicyEvidence {
  requiredControls: string[];
  knownGaps: Record<string, string>;
  rlsPilotTables: string[];
  rlsSystemPaths: Record<string, string>;
}

export type Loaded<T> = { state: 'READY'; value: T } | { state: 'NOT_GENERATED'; reason: string };

function candidates(...rel: string[]): string[] {
  return [
    path.join(__dirname, '..', ...rel),
    path.join(__dirname, '..', '..', '..', 'src', 'cyber-defense', ...rel),
  ];
}

function readFirst(paths: string[]): unknown | null {
  for (const p of paths) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { /* next */ }
  }
  return null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

function toPosture(m: Record<string, unknown>): PostureEvidence | null {
  if (!Array.isArray(m.controls)) return null;
  const api = obj(m.apiSurface);
  const authz = obj(api.authorization);
  const tenancy = obj(api.tenancy);
  const secrets = obj(m.secrets);
  const counts = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v)]));
  return {
    generatedAt: String(m.generatedAt ?? ''),
    generator: String(m.generator ?? ''),
    controls: (m.controls as Array<Record<string, unknown>>).map((c) => ({
      id: String(c.id), status: String(c.status) as ControlStatus,
      evidence: String(c.evidence ?? ''), note: c.note == null ? null : String(c.note),
    })),
    mounts: (Array.isArray(api.mounts) ? api.mounts as Array<Record<string, unknown>> : []).map((x) => ({
      path: String(x.path), module: String(x.module), handlers: num(x.handlers),
      public: num(x.public), routerWideAuth: x.routerWideAuth === true,
    })),
    api: {
      routers: num(api.mountedRouters),
      handlers: num(api.handlers),
      publicHandlers: num(api.publicHandlers),
      dormantModules: Array.isArray(api.dormantRouteModules) ? api.dormantRouteModules.length : 0,
      outboundCallSites: Array.isArray(api.outboundCallSites) ? api.outboundCallSites.length : 0,
      authzByKind: counts(obj(authz.byKind)),
      authzByRouter: Object.fromEntries(Object.entries(obj(authz.byRouter)).map(([k, v]) => [k, counts(obj(v))])),
      tenancy: {
        idParameters: num(tenancy.idParameters), guarded: num(tenancy.guarded), exempt: num(tenancy.exempt),
        unguarded: Array.isArray(tenancy.unguarded) ? tenancy.unguarded.length : num(tenancy.unguarded),
      },
      tenancyByRouter: Object.fromEntries(Object.entries(obj(tenancy.byRouter)).map(([k, v]) => {
        const r = obj(v);
        return [k, { guarded: num(r.guarded), exempt: num(r.exempt), unguarded: num(r.unguarded) }];
      })),
    },
    secrets: {
      declared: num(secrets.declared),
      secretNamed: num(secrets.secretNamed),
      inline: Array.isArray(secrets.secretNamedInline) ? secrets.secretNamedInline.length : 0,
    },
    datastores: (Array.isArray(m.datastores) ? m.datastores as Array<Record<string, unknown>> : [])
      .map((d) => ({ kind: String(d.kind), privateNetworkOnly: d.privateNetworkOnly === true })),
    crypto: (Array.isArray(m.crypto) ? m.crypto as Array<Record<string, unknown>> : [])
      .map((c) => ({ primitive: String(c.primitive), algorithm: String(c.algorithm) })),
    supplyChain: obj(m.supplyChain),
    components: counts(obj(obj(m.architecture).components)),
  };
}

function toCoverage(c: Record<string, unknown>): CoverageEvidence | null {
  const b = obj(c.boundaries);
  if (!Object.keys(b).length) return null;
  const rows: BoundaryRow[] = Object.entries(b).map(([id, raw]) => {
    const r = obj(raw);
    return {
      id: Number(id),
      name: String(r.name ?? ''), flow: String(r.flow ?? ''), trustBoundary: String(r.trustBoundary ?? ''),
      owner: String(r.owner ?? ''), dataClass: String(r.dataClass ?? ''), boundaryType: String(r.boundaryType ?? ''),
      coverage: (['C', 'P', 'U'].includes(String(r.coverage)) ? String(r.coverage) : 'U') as BoundaryRow['coverage'],
      controls: Array.isArray(r.controls) ? r.controls.map(String) : [],
      reason: r.reason == null ? null : String(r.reason),
      plannedIn: r.plannedIn == null ? null : String(r.plannedIn),
    };
  }).sort((x, y) => x.id - y.id);
  const routers = obj(obj(c.components).routers);
  const ratchet = obj(c.ratchet);
  return {
    rows,
    routers: Object.fromEntries(Object.entries(routers).map(([k, v]) => [k, Array.isArray(v) ? v.map(Number) : []])),
    ratchet: { U: num(ratchet.U), P: num(ratchet.P) },
  };
}

function toPolicy(p: Record<string, unknown>): PolicyEvidence | null {
  if (!Array.isArray(p.requiredControls)) return null;
  return {
    requiredControls: p.requiredControls.map(String),
    knownGaps: Object.fromEntries(Object.entries(obj(p.knownGaps)).map(([k, v]) => [k, String(v)])),
    rlsPilotTables: Array.isArray(p.rlsPilotTables) ? p.rlsPilotTables.map(String) : [],
    rlsSystemPaths: Object.fromEntries(Object.entries(obj(p.rlsSystemPaths)).map(([k, v]) => [k, String(v)])),
  };
}

let posture: Loaded<PostureEvidence> | null = null;
let coverage: Loaded<CoverageEvidence> | null = null;
let policy: Loaded<PolicyEvidence> | null = null;

function load<T>(paths: string[], shape: (x: Record<string, unknown>) => T | null, what: string): Loaded<T> {
  const raw = readFirst(paths);
  const value = raw ? shape(obj(raw)) : null;
  return value ? { state: 'READY', value } : { state: 'NOT_GENERATED', reason: `The ${what} was not found beside the server.` };
}

export function postureEvidence(): Loaded<PostureEvidence> {
  return posture ??= load(candidates('generated', 'security-manifest.json'), toPosture, 'security posture manifest');
}
export function coverageEvidence(): Loaded<CoverageEvidence> {
  return coverage ??= load(candidates('coverage-map.json'), toCoverage, 'coverage map');
}
export function policyEvidence(): Loaded<PolicyEvidence> {
  return policy ??= load(candidates('posture-policy.json'), toPolicy, 'posture policy');
}

/** Drop the caches. Tests only. */
export function resetPostureEvidence(): void { posture = null; coverage = null; policy = null; }

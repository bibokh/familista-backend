// The technology registry — what the platform is, read from its own repository
// ─────────────────────────────────────────────────────────────────────────────
// TWO LAYERS, AND THIS IS THE STATIC ONE
//
//   BUILD-TIME INVENTORY  (this file)      what exists, from the repository
// + LIVE RUNTIME HEALTH   (health.service) how it is right now
// = INFRASTRUCTURE CITY
//
// Keeping them apart is the point. The inventory changes when somebody commits;
// the health changes every few seconds. A design that mixed them would either
// re-read the filesystem on every poll, or cache a health reading until the
// next deploy — and both of those are worse than the split.
//
// WHERE THE INVENTORY COMES FROM
//
// `scripts/infrastructure-discover.js`, at build time, from package.json, the
// lockfile, tsconfig, the Prisma schema, render.yaml, the GitHub workflows and
// the mounted routers. Every entry carries the file that proves it. Nothing in
// this file invents a component, and there is no hand-written list of
// technologies anywhere in the frontend either — the city renders what the
// manifest says and nothing else.
//
// WHEN THE MANIFEST IS ABSENT
//
// A dev server started without a build has no manifest. That is reported as
// `NOT_GENERATED` with the command that fixes it, and the city draws an empty
// state. It is not an error and it is not an empty city pretending to be a
// small one.

import fs from 'fs';
import path from 'path';

export type ComponentStatus = 'ACTIVE' | 'NOT_CONFIGURED' | 'FUTURE' | 'UNKNOWN';

export interface InfraComponent {
  id: string;
  name: string;
  district: string;
  category: string;
  type: string;
  version: string | null;
  status: ComponentStatus;
  runtime: string | null;
  provider: string | null;
  region: string | null;
  repositoryPath: string | null;
  /** The file that proves this component exists. Never empty. */
  sourceEvidence: string;
  dependencies: string[];
  /** Which live signal, if any, reports on this component. Null = not instrumented. */
  healthKey: string | null;
  note: string | null;
}

export interface InfraDistrict {
  id: string;
  name: string;
  category: string;
  zone: string;
  priority: number;
  status: string;
}

export interface InfraRelationship {
  from: string;
  to: string;
  kind: string;
  evidence: string;
}

export interface InfraTechnology {
  id: string;
  name: string;
  category: string;
  version: string | null;
  usedBy: string[];
  sourceEvidence: string;
}

export interface InfraManifest {
  schemaVersion: number;
  generatedAt: string;
  generator: string;
  platform: { name: string; version: string };
  evidence: { filesRead: string[] };
  districts: InfraDistrict[];
  components: InfraComponent[];
  relationships: InfraRelationship[];
  technologies: InfraTechnology[];
  future: { id: string; name: string; district: string; reason: string }[];
  surface: Record<string, number>;
  database: {
    provider: string; models: number; enums: number;
    migrations: number; latestMigration: string | null;
  };
  typescript: Record<string, unknown> | null;
  deployment: {
    provider: string;
    services: { name: string; type: string; runtime: string | null; region: string | null; plan: string | null; autoDeploy: boolean | null; healthCheckPath: string | null }[];
    observable: boolean;
    observabilityNote: string;
  };
  ci: { workflows: { file: string; name: string; jobs: number; steps: string[]; services: string[]; runsOn: string[] }[] };
  /**
   * Every mounted router, with the verbs it declares.
   *
   * `writes` is what lets a provenance map tell an INGESTION point from a read
   * surface — the only honest discriminator, since the path name gets it wrong
   * in both directions.
   */
  mounts: { path: string; router: string; file: string | null; writes: number; reads: number }[];
  environment: { total: number; architectural: string[]; secretShapedCount: number };
  dependencies: { name: string; declared: string; resolved: string | null; classification: string; technology: string | null }[];
  counts: Record<string, number>;
}

export type RegistryState =
  | { state: 'READY'; manifest: InfraManifest; loadedAt: string }
  | { state: 'NOT_GENERATED'; reason: string; remedy: string };

/**
 * Where the manifest lives at runtime.
 *
 * `__dirname` is `dist/infra` in a built server and `src/infra` under ts-node,
 * and the generated file sits beside this module in both — `copy-runtime-assets`
 * puts it there on build. Both candidates are tried rather than assuming which
 * one is running.
 */
function candidatePaths(): string[] {
  return [
    path.join(__dirname, 'generated', 'infrastructure-manifest.json'),
    path.join(__dirname, '..', '..', 'src', 'infra', 'generated', 'infrastructure-manifest.json'),
  ];
}

let cached: RegistryState | null = null;

/**
 * The manifest, loaded once.
 *
 * Cached deliberately: the inventory cannot change while the process runs,
 * because it is generated at build. Re-reading it per request would put a file
 * read on a request path to learn something that cannot have changed.
 */
export function infrastructureRegistry(): RegistryState {
  if (cached) return cached;

  for (const p of candidatePaths()) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const manifest = JSON.parse(raw) as InfraManifest;
      if (!manifest || !Array.isArray(manifest.components)) continue;
      cached = { state: 'READY', manifest, loadedAt: new Date().toISOString() };
      return cached;
    } catch (_) { /* try the next candidate */ }
  }

  cached = {
    state: 'NOT_GENERATED',
    reason: 'No infrastructure manifest was found beside this module.',
    remedy: 'npm run infra:discover',
  };
  return cached;
}

/** Drop the cache. Tests, and a controlled refresh after a regeneration. */
export function resetInfrastructureRegistry(): void { cached = null; }

/** The manifest, or null when it has not been generated. */
export function manifestOrNull(): InfraManifest | null {
  const r = infrastructureRegistry();
  return r.state === 'READY' ? r.manifest : null;
}

export function componentById(id: string): InfraComponent | null {
  const m = manifestOrNull();
  if (!m) return null;
  return m.components.find((c) => c.id === id) ?? null;
}

/**
 * Who depends on this component.
 *
 * The inverse of `dependencies`, computed rather than stored — a stored inverse
 * is a second copy of the same fact, and the two drift.
 */
export function dependentsOf(id: string): string[] {
  const m = manifestOrNull();
  if (!m) return [];
  const out = new Set<string>();
  for (const c of m.components) if (c.dependencies.includes(id)) out.add(c.id);
  for (const r of m.relationships) if (r.to === id) out.add(r.from);
  return [...out].sort();
}

export function dependenciesOf(id: string): string[] {
  const c = componentById(id);
  const m = manifestOrNull();
  if (!c || !m) return [];
  const out = new Set<string>(c.dependencies);
  for (const r of m.relationships) if (r.from === id) out.add(r.to);
  return [...out].sort();
}

/**
 * Every component in a district, in a stable order.
 *
 * Sorted by the presence of a live signal first, then by name: a district's
 * instrumented components are the ones an operator looks at, so they lead.
 */
export function componentsInDistrict(districtId: string): InfraComponent[] {
  const m = manifestOrNull();
  if (!m) return [];
  return m.components
    .filter((c) => c.district === districtId)
    .sort((a, b) => Number(!!b.healthKey) - Number(!!a.healthKey) || a.name.localeCompare(b.name));
}

/**
 * Which components a technology is used by, resolved to real components.
 *
 * The manifest records `usedBy` as district ids, because that is what the
 * discovery script can prove from a package name. This widens it to the
 * components in those districts, which is the answer the Technology Map needs.
 */
export function technologyUsage(technologyId: string): { districts: string[]; components: string[] } {
  const m = manifestOrNull();
  if (!m) return { districts: [], components: [] };
  const t = m.technologies.find((x) => x.id === technologyId);
  if (!t) return { districts: [], components: [] };
  const comps = m.components
    .filter((c) => t.usedBy.includes(c.district))
    .map((c) => c.id)
    .sort();
  return { districts: [...t.usedBy].sort(), components: comps };
}

/**
 * The layout model.
 *
 * Districts carry a zone and a priority; components are placed WITHIN a
 * district by the interface. Nothing here holds an absolute coordinate, which
 * is the property that lets a newly discovered component appear next week
 * without anybody redrawing the city.
 */
export function cityLayout(): {
  zones: { zone: string; districts: { id: string; name: string; priority: number; components: number; future: number }[] }[];
} {
  const m = manifestOrNull();
  if (!m) return { zones: [] };

  const byZone = new Map<string, InfraDistrict[]>();
  for (const d of m.districts) {
    if (!byZone.has(d.zone)) byZone.set(d.zone, []);
    byZone.get(d.zone)!.push(d);
  }

  const ZONE_ORDER = ['centre', 'north', 'east', 'south', 'west'];
  const zones = [...byZone.entries()]
    .sort((a, b) => {
      const ia = ZONE_ORDER.indexOf(a[0]); const ib = ZONE_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .map(([zone, list]) => ({
      zone,
      districts: list
        .sort((a, b) => a.priority - b.priority)
        .map((d) => ({
          id: d.id,
          name: d.name,
          priority: d.priority,
          components: m.components.filter((c) => c.district === d.id).length,
          future: m.future.filter((f) => f.district === d.id).length,
        })),
    }));

  return { zones };
}

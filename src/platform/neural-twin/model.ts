/**
 * Familista Neural Digital Twin — the graph's contract (schemaVersion 1).
 *
 * The twin is the platform's real architecture as a graph: every node and every
 * edge comes from an authority the repository already keeps (the infrastructure
 * and security manifests, the coverage map, the SYSTEM module and agent
 * registries) or from the source itself (TypeScript imports, Prisma call sites).
 * Nothing here is runtime state: maturity is what the code and registries say,
 * never "it is running". Runtime health, history and impact analysis are later
 * layers over the same ids.
 *
 * The graph knows nothing about how it is drawn. The 3D room reads it; a 2D view,
 * a diff between two commits or an impact query can read the same JSON.
 */

export const TWIN_SCHEMA_VERSION = 1 as const;

/** What a node is. A system is a district of the infrastructure manifest; everything else nests under one. */
export const NODE_KINDS = ['system', 'component', 'module', 'file', 'api', 'model', 'agent', 'boundary', 'sysmodule', 'planned'] as const;
export type NodeKind = typeof NODE_KINDS[number];

/** Implementation maturity: what the authorities say is built. Never a statement about live operation. */
export const MATURITIES = ['IMPLEMENTED', 'PARTIAL', 'PLANNED', 'UNVERIFIED'] as const;
export type Maturity = typeof MATURITIES[number];

/**
 * Relationship kinds, each from one authority:
 *  IMPORTS        a TypeScript import, read with the compiler's own pre-processor
 *  DATA           a Prisma call site (sub: READS, WRITES or READS_WRITES)
 *  DEPENDS_ON     a component's `dependencies` in the infrastructure manifest
 *  INFRA          a relationship in the infrastructure manifest (sub: its kind, e.g. USES)
 *  IMPLEMENTED_BY a component's repository path resolved to the code node it names
 *  IN_BOUNDARY    the coverage map places a router, module, data section or component in a trust boundary
 *  USES_TOOLS     an agent manifest's tools, defined in the tool registry
 */
export const EDGE_KINDS = ['IMPORTS', 'DATA', 'DEPENDS_ON', 'INFRA', 'IMPLEMENTED_BY', 'IN_BOUNDARY', 'USES_TOOLS'] as const;
export type EdgeKind = typeof EDGE_KINDS[number];

/** Where a fact comes from. */
export const AUTHORITIES = [
  'infrastructure-manifest', 'security-manifest', 'coverage-map', 'posture-policy', 'system-modules',
  'agent-catalog', 'tool-registry', 'typescript-imports', 'prisma-calls', 'prisma-schema', 'repository', 'composer-rule',
] as const;
export type Authority = typeof AUTHORITIES[number];

/** One piece of evidence: the authority, the repository path that holds it, and a line where there is one. */
export interface Evidence { a: Authority; p: string; l?: number; n?: string }

export type FactValue = string | number | boolean | string[];

export interface TwinNode {
  id: string;
  kind: NodeKind;
  /** A name, as the authority writes it. Data: never translated. */
  label: string;
  /** The node it nests under. Only systems have none. */
  parent: string | null;
  maturity: Maturity;
  /** What the authority says the thing is for, in its own words. */
  summary?: string;
  facts?: Record<string, FactValue>;
  evidence: Evidence[];
  /** What is not known about this node, said rather than guessed. */
  unknown?: string[];
  /** An existing owner room that shows this thing in depth. */
  room?: string;
}

export interface TwinEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  sub?: string;
  /** How many times the authority records it (import statements, call sites). */
  weight: number;
  evidence: Evidence[];
}

export interface TwinDiscrepancy { id: string; subject: string; detail: string; evidence: Evidence[] }

export interface TwinProvenance { authority: Authority; path: string; sha256: string }

export interface TwinGraph {
  schemaVersion: typeof TWIN_SCHEMA_VERSION;
  provenance: TwinProvenance[];
  counts: { nodes: Record<string, number>; edges: Record<string, number> };
  nodes: TwinNode[];
  edges: TwinEdge[];
  discrepancies: TwinDiscrepancy[];
}

// ── invariants ──────────────────────────────────────────────────────────────

/**
 * Every problem with a graph, empty when it is sound. The composer refuses to
 * emit a graph with problems, and the tests hold it to the same rules with
 * negative controls.
 */
export function twinGraphProblems(g: TwinGraph, pathExists?: (p: string) => boolean): string[] {
  const out: string[] = [];
  if (g.schemaVersion !== TWIN_SCHEMA_VERSION) out.push('schemaVersion is not ' + TWIN_SCHEMA_VERSION);
  const byId = new Map<string, TwinNode>();
  for (const n of g.nodes) {
    if (byId.has(n.id)) out.push('duplicate node id ' + n.id);
    byId.set(n.id, n);
    if (!(NODE_KINDS as readonly string[]).includes(n.kind)) out.push(n.id + ': unknown kind ' + n.kind);
    if (!(MATURITIES as readonly string[]).includes(n.maturity)) out.push(n.id + ': unknown maturity ' + n.maturity);
    if (!n.evidence || !n.evidence.length) out.push(n.id + ': no evidence');
    for (const e of n.evidence || []) out.push(...evidenceProblems(n.id, e, pathExists));
    if (n.kind === 'system' && n.parent !== null) out.push(n.id + ': a system nests under nothing');
    if (n.kind !== 'system' && !n.parent) out.push(n.id + ': only a system has no parent');
    if (n.maturity === 'IMPLEMENTED' && !(n.evidence || []).some((e) => e.a !== 'composer-rule')) out.push(n.id + ': IMPLEMENTED without evidence from an authority');
    if (n.kind === 'planned' && n.maturity !== 'PLANNED') out.push(n.id + ': a planned node is PLANNED');
    if (n.kind === 'planned' && (n.evidence || []).some((e) => e.a === 'repository' || e.a === 'typescript-imports')) out.push(n.id + ': a planned node cites code as its own evidence');
  }
  for (const n of g.nodes) {
    if (n.parent && !byId.has(n.parent)) out.push(n.id + ': parent ' + n.parent + ' does not exist');
    // a parent chain ends at a system, never in a loop
    const seen = new Set<string>([n.id]);
    let p = n.parent;
    while (p) {
      if (seen.has(p)) { out.push(n.id + ': parent chain loops at ' + p); break; }
      seen.add(p);
      p = byId.get(p)?.parent ?? null;
    }
  }
  const pairs = new Set<string>();
  for (const e of g.edges) {
    const key = e.from + '\u0000' + e.to + '\u0000' + e.kind + '\u0000' + (e.sub || '');
    if (pairs.has(key)) out.push('duplicate edge ' + e.from + ' -> ' + e.to + ' ' + e.kind);
    pairs.add(key);
    if (!byId.has(e.from)) out.push('edge from a missing node ' + e.from);
    if (!byId.has(e.to)) out.push('edge to a missing node ' + e.to);
    if (e.from === e.to) out.push('edge from a node to itself ' + e.from);
    if (!(EDGE_KINDS as readonly string[]).includes(e.kind)) out.push('edge of unknown kind ' + e.kind);
    if (!e.evidence || !e.evidence.length) out.push('edge ' + e.from + ' -> ' + e.to + ' has no evidence');
    if (!(e.weight >= 1)) out.push('edge ' + e.from + ' -> ' + e.to + ' has no weight');
    for (const ev of e.evidence || []) out.push(...evidenceProblems(e.from + '->' + e.to, ev, pathExists));
  }
  return out;
}

function evidenceProblems(at: string, e: Evidence, pathExists?: (p: string) => boolean): string[] {
  const out: string[] = [];
  if (!(AUTHORITIES as readonly string[]).includes(e.a)) out.push(at + ': evidence from an unknown authority ' + e.a);
  if (!e.p || e.p.startsWith('/') || e.p.includes('..') || /^[a-z]+:/i.test(e.p)) out.push(at + ': evidence path is not a repository path: ' + e.p);
  else if (pathExists && !pathExists(e.p)) out.push(at + ': evidence path does not exist: ' + e.p);
  if (e.l != null && !(Number.isInteger(e.l) && e.l >= 1)) out.push(at + ': evidence line is not a line number');
  return out;
}

// ── exposure ────────────────────────────────────────────────────────────────

/**
 * What the graph must never carry, scanned on its serialized form: addresses,
 * hosts, credentials, environment variable names, e-mail addresses. Repository
 * paths and line numbers stay: they are already in the repository and are what
 * makes a node checkable. `envNames` is the security manifest's list.
 */
export function twinExposureProblems(json: string, envNames: readonly string[]): string[] {
  const out: string[] = [];
  const rules: Array<[string, RegExp]> = [
    ['a URL', /\b(?:https?|wss?|postgres(?:ql)?|redis|mongodb):\/\//i],
    ['a hosted address', /\b[a-z0-9-]+\.(?:onrender\.com|amazonaws\.com|herokuapp\.com|vercel\.app)\b/i],
    ['an IP address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
    ['an e-mail address', /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/],
    ['a secret-shaped value', /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bsk-ant-[A-Za-z0-9-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ];
  for (const [what, re] of rules) { const m = re.exec(json); if (m) out.push('the graph carries ' + what + ': ' + m[0]); }
  for (const name of envNames) {
    if (name.length >= 6 && new RegExp('\\b' + name.replace(/[^A-Z0-9_]/g, '') + '\\b').test(json)) out.push('the graph names an environment variable: ' + name);
  }
  return out;
}

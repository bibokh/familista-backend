/**
 * Familista Neural Digital Twin — the composer.
 *
 * Reads the authorities the repository already keeps, and the source itself,
 * and writes one graph. It discovers nothing an authority does not say, and it
 * resolves no conflict between authorities: a conflict is recorded in
 * `discrepancies` with both claims.
 *
 *   systems     the infrastructure manifest's districts
 *   components  the infrastructure manifest's components (and `future` items, PLANNED)
 *   modules     the directories under src/, placed in a system only where a component's
 *               repository path lies inside them; otherwise in "No district evidence"
 *   files       every .ts file under src/; a mounted router is an `api` node instead
 *   apis        the security manifest's mounted routers, with their handler counts
 *   models      the Prisma schema's sections
 *   agents      the agent registry (src/platform/agents/catalog.ts)
 *   sysmodules  the SYSTEM module registry (src/platform/system-modules.ts)
 *   boundaries  the coverage map's trust boundaries
 *
 * Edges: TypeScript imports (the compiler's own pre-processor), Prisma call
 * sites, the manifest's dependencies and relationships, component paths, the
 * coverage map's boundary rows, and each agent's tools.
 *
 * It runs at build time (scripts/neural-twin-build.js, after tsc) and in the
 * tests; never inside a request in production.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as ts from 'typescript';
import { SYSTEM_MODULES } from '../system-modules';
import { PLATFORM_AGENT_MANIFESTS } from '../agents/catalog';
import { TOOLS } from '../intelligence/agents';
import {
  TWIN_SCHEMA_VERSION, twinExposureProblems, twinGraphProblems,
  type Authority, type EdgeKind, type Evidence, type Maturity, type TwinDiscrepancy, type TwinEdge, type TwinGraph, type TwinNode,
} from './model';

export const TWIN_PATHS = {
  infra: 'src/infra/generated/infrastructure-manifest.json',
  security: 'src/cyber-defense/generated/security-manifest.json',
  coverage: 'src/cyber-defense/coverage-map.json',
  posture: 'src/cyber-defense/posture-policy.json',
  sysmodules: 'src/platform/system-modules.ts',
  catalog: 'src/platform/agents/catalog.ts',
  tools: 'src/platform/intelligence/agents.ts',
  schema: 'prisma/schema.prisma',
  routesIndex: 'src/routes/index.ts',
  start: 'scripts/render-start.sh',
} as const;

const PRISMA_OPS: Record<string, 'R' | 'W'> = {
  findUnique: 'R', findUniqueOrThrow: 'R', findFirst: 'R', findFirstOrThrow: 'R', findMany: 'R', count: 'R', aggregate: 'R', groupBy: 'R',
  create: 'W', createMany: 'W', createManyAndReturn: 'W', update: 'W', updateMany: 'W', upsert: 'W', delete: 'W', deleteMany: 'W',
};

/** The graph for the repository at `root`. Throws if the result breaks an invariant or the exposure rules. */
export function composeTwin(root: string): TwinGraph {
  const abs = (p: string) => path.join(root, p);
  const exists = (p: string) => fs.existsSync(abs(p.replace(/\/$/, '')));
  const read = (p: string) => fs.readFileSync(abs(p), 'utf8');
  const lineAt = (text: string, index: number) => (index < 0 ? undefined : text.slice(0, index).split('\n').length);
  const lineOf = (text: string, needle: string, from = 0) => lineAt(text, text.indexOf(needle, from));

  const nodes = new Map<string, TwinNode>();
  const edges = new Map<string, TwinEdge>();
  const discrepancies: TwinDiscrepancy[] = [];
  const addNode = (n: TwinNode) => {
    if (nodes.has(n.id)) throw new Error('neural twin: two authorities claim the node ' + n.id);
    nodes.set(n.id, n);
  };
  const addEdge = (from: string, to: string, kind: EdgeKind, ev: Evidence, sub?: string, weight = 1) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return false;
    const key = from + '\u0000' + to + '\u0000' + kind + '\u0000' + (sub || '');
    const e = edges.get(key);
    if (e) { e.weight += weight; if (e.evidence.length < 3) e.evidence.push(ev); return true; }
    const out: TwinEdge = { from, to, kind, weight, evidence: [ev] };
    if (sub) out.sub = sub;
    edges.set(key, out);
    return true;
  };
  const ev = (a: Authority, p: string, l?: number, n?: string): Evidence => {
    const e: Evidence = { a, p };
    if (l != null) e.l = l;
    if (n) e.n = n;
    return e;
  };

  // ── authorities ───────────────────────────────────────────────────────────
  const infraText = read(TWIN_PATHS.infra), secText = read(TWIN_PATHS.security), covText = read(TWIN_PATHS.coverage);
  const postureText = read(TWIN_PATHS.posture), catalogText = read(TWIN_PATHS.catalog), toolsText = read(TWIN_PATHS.tools);
  const sysmodText = read(TWIN_PATHS.sysmodules), schemaText = read(TWIN_PATHS.schema), indexText = read(TWIN_PATHS.routesIndex);
  const infra = JSON.parse(infraText), sec = JSON.parse(secText), cov = JSON.parse(covText), posture = JSON.parse(postureText);

  // ── systems: the districts ────────────────────────────────────────────────
  for (const d of infra.districts as Array<{ id: string; name: string; category: string; zone: string; priority: number; status: string }>) {
    addNode({
      id: 'system:' + d.id, kind: 'system', label: d.name, parent: null,
      maturity: d.status === 'ACTIVE' ? 'IMPLEMENTED' : 'PARTIAL',
      facts: { zone: d.zone, category: d.category, status: d.status },
      evidence: [ev('infrastructure-manifest', TWIN_PATHS.infra, lineOf(infraText, '"id": "' + d.id + '"'))],
      room: 'infrastructure-city',
    });
  }

  // ── components and planned items ──────────────────────────────────────────
  type InfraComponent = { id: string; name: string; district: string; category: string; type: string; status: string; repositoryPath: string | null; dependencies?: string[]; healthKey?: string | null; note?: string | null };
  const components = infra.components as InfraComponent[];
  const compStart = infraText.indexOf('"components"');
  for (const c of components) {
    const repo = (c.repositoryPath || '').replace(/\/$/, '');
    const e: Evidence[] = [ev('infrastructure-manifest', TWIN_PATHS.infra, lineOf(infraText, '"id": "' + c.id + '"', compStart))];
    if (repo && exists(repo)) e.push(ev('repository', repo));
    const facts: Record<string, string | boolean> = { category: c.category, type: c.type, status: c.status, healthSignal: !!c.healthKey };
    if (repo) facts.repositoryPath = repo;
    addNode({
      id: 'component:' + c.id, kind: 'component', label: c.name, parent: 'system:' + c.district,
      maturity: c.status === 'ACTIVE' ? 'IMPLEMENTED' : c.status === 'NOT_CONFIGURED' ? 'PARTIAL' : 'UNVERIFIED',
      summary: c.note || undefined, facts, evidence: e, room: 'infrastructure-city',
      unknown: c.status === 'ACTIVE' ? ['ACTIVE means the code or configuration exists; whether it is running is a runtime fact this graph does not hold.'] : undefined,
    });
  }
  const futureStart = infraText.indexOf('"future"');
  for (const f of infra.future as Array<{ id: string; name: string; district: string; reason: string }>) {
    addNode({
      id: 'planned:' + f.id, kind: 'planned', label: f.name, parent: 'system:' + f.district, maturity: 'PLANNED',
      summary: f.reason, evidence: [ev('infrastructure-manifest', TWIN_PATHS.infra, lineOf(infraText, '"id": "' + f.id + '"', futureStart))],
    });
  }

  // ── source: modules and files ─────────────────────────────────────────────
  const srcFiles: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(abs(dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = dir + '/' + ent.name;
      if (ent.isDirectory()) { if (ent.name !== 'node_modules' && ent.name !== 'generated') walk(rel); }
      else if (/\.ts$/.test(ent.name)) srcFiles.push(rel);
    }
  };
  walk('src');
  const moduleOf = (file: string) => { const parts = file.split('/'); return parts.length > 2 ? parts[1] : '(root)'; };
  const moduleId = (m: string) => 'module:' + (m === '(root)' ? 'src-root' : m);
  const moduleNames = [...new Set(srcFiles.map(moduleOf))].sort();

  // where a module sits: the district of the component whose repository path is the module,
  // else the district most of the components inside it belong to, else nowhere known
  const placement = new Map<string, { system: string; by: string[]; alsoIn: string[] }>();
  for (const m of moduleNames) {
    const dir = m === '(root)' ? null : 'src/' + m;
    const inside = components.filter((c) => {
      const p = (c.repositoryPath || '').replace(/\/$/, '');
      if (!p.startsWith('src/')) return false;
      return dir ? p === dir || p.startsWith(dir + '/') : p.split('/').length === 2;
    });
    if (!inside.length) continue;
    const exact = inside.filter((c) => (c.repositoryPath || '').replace(/\/$/, '') === dir).sort((a, b) => (a.id < b.id ? -1 : 1));
    let district: string;
    if (exact.length) district = exact[0].district;
    else {
      const tally = new Map<string, number>();
      for (const c of inside) tally.set(c.district, (tally.get(c.district) || 0) + 1);
      district = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    }
    placement.set(m, {
      system: 'system:' + district,
      by: inside.filter((c) => c.district === district).map((c) => c.id).sort(),
      alsoIn: [...new Set(inside.filter((c) => c.district !== district).map((c) => c.district))].sort(),
    });
  }
  const unplaced = moduleNames.filter((m) => !placement.has(m));
  if (unplaced.length) {
    addNode({
      id: 'system:unplaced', kind: 'system', label: 'No district evidence', parent: null, maturity: 'UNVERIFIED',
      summary: 'Code modules no infrastructure component points into. They are real code; which part of the platform they belong to is not recorded anywhere yet.',
      facts: { modules: unplaced.length },
      evidence: [ev('composer-rule', TWIN_PATHS.infra, undefined, 'no component repositoryPath lies inside these src/ directories')],
      unknown: ['Which system each of these modules belongs to. A reviewed mapping would place them; the composer does not guess.'],
    });
  }

  // mounted routers: the security manifest's mounts
  type Mount = { path: string; module: string; handlers: number; public: number; routerWideAuth: boolean };
  const mounts = sec.apiSurface.mounts as Mount[];
  const routerFile = new Map<string, string>();      // file -> router module
  for (const mt of mounts) {
    const f = 'src/routes/' + mt.module + '.ts';
    if (fs.existsSync(abs(f))) routerFile.set(f, mt.module);
    else discrepancies.push({ id: 'router-file:' + mt.module, subject: mt.module, detail: 'The security manifest mounts this router; no file src/routes/' + mt.module + '.ts exists.', evidence: [ev('security-manifest', TWIN_PATHS.security, lineOf(secText, '"module": "' + mt.module + '"'))] });
  }
  const nodeOfFile = (f: string) => (routerFile.has(f) ? 'api:' + routerFile.get(f) : 'file:' + f);

  // imports, read with the compiler's own pre-processor
  const texts = new Map<string, string>();
  for (const f of srcFiles) texts.set(f, read(f));
  const resolve = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    else if (spec.startsWith('@/')) base = 'src/' + spec.slice(2);
    else return null;
    for (const c of [base + '.ts', base + '/index.ts', base]) if (texts.has(c)) return c;
    return null;
  };
  const imports: Array<{ from: string; to: string; line: number }> = [];
  const graph = new Map<string, Set<string>>();
  for (const f of srcFiles) {
    const text = texts.get(f)!;
    const info = ts.preProcessFile(text, true, true);
    const out = new Set<string>();
    for (const imp of info.importedFiles) {
      const to = resolve(f, imp.fileName);
      if (!to || to === f) continue;
      imports.push({ from: f, to, line: lineAt(text, imp.pos) || 1 });
      out.add(to);
    }
    graph.set(f, out);
  }

  // what the production processes start from: the server, and the scripts the start script runs
  const startText = fs.existsSync(abs(TWIN_PATHS.start)) ? read(TWIN_PATHS.start) : '';
  const entries = ['src/server.ts', ...[...startText.matchAll(/node dist\/([\w/.-]+)\.js/g)].map((m) => 'src/' + m[1] + '.ts')]
    .filter((f, i, a) => texts.has(f) && a.indexOf(f) === i);
  const reachable = new Set<string>(entries);
  const queue = [...entries];
  while (queue.length) { const f = queue.shift()!; for (const t of graph.get(f) || []) if (!reachable.has(t)) { reachable.add(t); queue.push(t); } }

  // module nodes, then file and api nodes
  for (const m of moduleNames) {
    const files = srcFiles.filter((f) => moduleOf(f) === m);
    const place = placement.get(m);
    const dir = m === '(root)' ? 'src' : 'src/' + m;
    const evidence: Evidence[] = [ev('repository', dir)];
    if (place) evidence.push(ev('composer-rule', TWIN_PATHS.infra, undefined, 'placed by the component' + (place.by.length > 1 ? 's ' : ' ') + place.by.join(', ')));
    const facts: Record<string, string | number | string[]> = {
      files: files.length,
      lines: files.reduce((s, f) => s + texts.get(f)!.split('\n').length, 0),
      reachableFiles: files.filter((f) => reachable.has(f)).length,
    };
    if (place && place.alsoIn.length) facts.alsoIn = place.alsoIn;
    addNode({
      id: moduleId(m), kind: 'module', label: m === '(root)' ? 'src (root files)' : 'src/' + m,
      parent: place ? place.system : 'system:unplaced', maturity: 'IMPLEMENTED', facts, evidence,
      unknown: place ? undefined : ['No infrastructure component points into this module, so no system is recorded for it.'],
    });
  }
  const dormant = new Set<string>((sec.apiSurface.dormantRouteModules as string[]).map((d) => 'src/routes/' + d + '.ts'));
  const ownerRooms = posture.ownerRooms as Record<string, { mount: string }>;
  const byRouter = (sec.apiSurface.authorization.byRouter || {}) as Record<string, Record<string, number>>;
  const tenancy = (sec.apiSurface.tenancy.byRouter || {}) as Record<string, { guarded?: number; exempt?: number }>;
  for (const f of srcFiles) {
    const text = texts.get(f)!;
    const lines = text.split('\n').length;
    const reach = reachable.has(f);
    const unknown = reach ? undefined : ['No import from the server or a start-up script reaches this file. It may be loaded another way (a dynamic path, a separate process) or not at all; the graph does not decide which.'];
    if (routerFile.has(f)) {
      const mod = routerFile.get(f)!;
      const mt = mounts.find((x) => x.module === mod)!;
      const kinds = byRouter[mod] || {};
      const facts: Record<string, string | number | boolean | string[]> = {
        mount: '/api/v1' + mt.path, handlers: mt.handlers, publicHandlers: mt.public, routerWideAuth: mt.routerWideAuth,
        ownerOnly: Object.prototype.hasOwnProperty.call(ownerRooms, mod), lines, reachableFromEntry: reach,
        authorization: Object.keys(kinds).sort().map((k) => k + ' ' + kinds[k]),
      };
      if (tenancy[mod]) facts.tenancy = ['guarded ' + (tenancy[mod].guarded || 0), 'exempt ' + (tenancy[mod].exempt || 0)];
      addNode({
        id: 'api:' + mod, kind: 'api', label: '/api/v1' + mt.path, parent: moduleId(moduleOf(f)), maturity: 'IMPLEMENTED', facts,
        evidence: [ev('security-manifest', TWIN_PATHS.security, lineOf(secText, '"module": "' + mod + '"')), ev('repository', f), ev('repository', TWIN_PATHS.routesIndex, lineOf(indexText, "'" + mt.path + "'"))],
        unknown,
      });
    } else {
      const isDormant = dormant.has(f);
      addNode({
        id: 'file:' + f, kind: 'file', label: path.posix.basename(f), parent: moduleId(moduleOf(f)),
        maturity: isDormant ? 'PARTIAL' : 'IMPLEMENTED',
        facts: isDormant ? { path: f, lines, reachableFromEntry: reach, dormantRouter: true } : { path: f, lines, reachableFromEntry: reach },
        evidence: isDormant ? [ev('repository', f), ev('security-manifest', TWIN_PATHS.security, lineOf(secText, '"' + path.posix.basename(f, '.ts') + '"'), 'a router module no mount uses')] : [ev('repository', f)],
        unknown,
      });
    }
  }
  for (const im of imports) addEdge(nodeOfFile(im.from), nodeOfFile(im.to), 'IMPORTS', ev('typescript-imports', im.from, im.line));

  // the infrastructure manifest's route mounts and the security manifest's differ? say so
  const infraMountFiles = new Set<string>((infra.mounts as Array<{ file: string }>).map((m) => m.file));
  const missingInInfra = [...routerFile.keys()].filter((f) => !infraMountFiles.has(f)).sort();
  if (missingInInfra.length || infraMountFiles.size !== routerFile.size) {
    discrepancies.push({
      id: 'route-mounts', subject: 'API route mounts',
      detail: 'The security manifest mounts ' + routerFile.size + ' routers; the infrastructure manifest lists ' + infraMountFiles.size + ' mounts.' + (missingInInfra.length ? ' Not in the infrastructure manifest: ' + missingInInfra.join(', ') + '.' : ''),
      evidence: [ev('security-manifest', TWIN_PATHS.security), ev('infrastructure-manifest', TWIN_PATHS.infra)],
    });
  }

  // components point at code: their repository path, resolved to the node that holds it
  for (const c of components) {
    const p = (c.repositoryPath || '').replace(/\/$/, '');
    if (!p.startsWith('src')) continue;
    const target = texts.has(p) ? nodeOfFile(p) : p === 'src' ? null : p.split('/').length === 2 && moduleNames.includes(p.split('/')[1]) ? moduleId(p.split('/')[1]) : null;
    if (target) addEdge('component:' + c.id, target, 'IMPLEMENTED_BY', ev('infrastructure-manifest', TWIN_PATHS.infra, lineOf(infraText, '"repositoryPath": "' + c.repositoryPath + '"', compStart)));
  }
  for (const c of components) {
    for (const d of c.dependencies || []) {
      if (!addEdge('component:' + c.id, 'component:' + d, 'DEPENDS_ON', ev('infrastructure-manifest', TWIN_PATHS.infra, lineOf(infraText, '"id": "' + c.id + '"', compStart)))) {
        discrepancies.push({ id: 'dependency:' + c.id + '>' + d, subject: c.id, detail: 'Depends on ' + d + ', which is not a component.', evidence: [ev('infrastructure-manifest', TWIN_PATHS.infra)] });
      }
    }
  }
  const relStart = infraText.indexOf('"relationships"');
  for (const r of infra.relationships as Array<{ from: string; to: string; kind: string; evidence: string }>) {
    if (!addEdge('component:' + r.from, 'component:' + r.to, 'INFRA', ev('infrastructure-manifest', TWIN_PATHS.infra, lineOf(infraText, '"from": "' + r.from + '"', relStart), r.evidence), r.kind)) {
      discrepancies.push({ id: 'relationship:' + r.from + '>' + r.to, subject: r.from + ' ' + r.kind + ' ' + r.to, detail: 'A relationship between ids that are not both components.', evidence: [ev('infrastructure-manifest', TWIN_PATHS.infra)] });
    }
  }

  // ── data: the Prisma schema's sections and the call sites that use them ───
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'top';
  const sectionOfModel = new Map<string, string>();
  const sectionLine = new Map<string, number>();
  const sectionModels = new Map<string, string[]>();
  {
    const lines = schemaText.split('\n');
    const rule = /^\/\/\s*[─═━-]{10,}\s*$/;
    let cur = '(top)';
    sectionLine.set(cur, 1);
    for (let i = 0; i < lines.length; i += 1) {
      if (rule.test(lines[i]) && lines[i + 1] && lines[i + 1].startsWith('//') && !rule.test(lines[i + 1])) {
        let j = i + 1; const title: string[] = [];
        while (j < lines.length && lines[j].startsWith('//') && !rule.test(lines[j])) { title.push(lines[j].slice(2).trim()); j += 1; }
        if (j < lines.length && rule.test(lines[j])) { cur = title[0] || cur; if (!sectionLine.has(cur)) sectionLine.set(cur, i + 2); i = j; continue; }
      }
      const m = /^model (\w+)/.exec(lines[i]);
      if (m) { sectionOfModel.set(m[1], cur); (sectionModels.get(cur) || sectionModels.set(cur, []).get(cur)!).push(m[1]); }
    }
  }
  const sectionIds = new Map<string, string>();
  for (const [section, models] of [...sectionModels.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let id = 'model:' + slug(section);
    while (nodes.has(id)) id += '-x';
    sectionIds.set(section, id);
    addNode({
      id, kind: 'model', label: section, parent: 'component:postgres', maturity: 'IMPLEMENTED',
      facts: { models: [...models].sort() }, evidence: [ev('prisma-schema', TWIN_PATHS.schema, sectionLine.get(section))],
    });
  }
  const delegate = new Map<string, string>();
  for (const m of sectionOfModel.keys()) delegate.set(m.charAt(0).toLowerCase() + m.slice(1), m);
  const callRe = /\.\s*([a-z]\w*)\s*\.\s*([a-zA-Z]+)\s*\(/g;
  for (const f of srcFiles) {
    const text = texts.get(f)!;
    const acc = new Map<string, { r: number; w: number; line: number }>();
    for (const m of text.matchAll(callRe)) {
      const model = delegate.get(m[1]); const op = PRISMA_OPS[m[2]];
      if (!model || !op) continue;
      const target = sectionIds.get(sectionOfModel.get(model)!)!;
      const a = acc.get(target) || { r: 0, w: 0, line: lineAt(text, m.index!) || 1 };
      if (op === 'R') a.r += 1; else a.w += 1;
      acc.set(target, a);
    }
    for (const [target, a] of acc) {
      addEdge(nodeOfFile(f), target, 'DATA', ev('prisma-calls', f, a.line, (a.r ? a.r + ' read' + (a.r > 1 ? 's' : '') : '') + (a.r && a.w ? ', ' : '') + (a.w ? a.w + ' write' + (a.w > 1 ? 's' : '') : '')), a.r && a.w ? 'READS_WRITES' : a.w ? 'WRITES' : 'READS', a.r + a.w);
    }
  }

  // ── agents: the registry, and the tools each one is allowed ────────────────
  const toolsFileNode = nodeOfFile(TWIN_PATHS.tools);
  const toolKeys = new Set(TOOLS.map((t) => t.key));
  for (const a of PLATFORM_AGENT_MANIFESTS) {
    const maturity: Maturity = a.lifecycle === 'RUNNING' ? 'IMPLEMENTED' : a.lifecycle === 'DRAFT' ? 'PLANNED' : 'PARTIAL';
    addNode({
      id: 'agent:' + a.id, kind: 'agent', label: a.title, parent: 'system:ai', maturity, summary: a.purpose,
      facts: { domain: a.domain, scope: a.scope, lifecycle: a.lifecycle, autonomyCeiling: String(a.autonomyCeiling), supervisor: String(a.supervisor), tools: [...a.tools], reads: [...a.data.reads], writes: [...a.data.writes] },
      evidence: [ev('agent-catalog', TWIN_PATHS.catalog, lineOf(catalogText, "id: '" + a.id + "'"))],
      unknown: ['Lifecycle RUNNING is the registry\'s state, not a measurement of the agent working.', 'Which services carry out each tool is not mapped yet: the tool registry says what a tool does, not where it runs.'],
      room: 'agents-room',
    });
    const missing = a.tools.filter((t) => !toolKeys.has(t));
    if (missing.length) discrepancies.push({ id: 'agent-tools:' + a.id, subject: a.id, detail: 'Tools not in the tool registry: ' + missing.join(', '), evidence: [ev('agent-catalog', TWIN_PATHS.catalog), ev('tool-registry', TWIN_PATHS.tools)] });
    const toolEvidence = a.tools.filter((t) => toolKeys.has(t)).map((t) => ev('tool-registry', TWIN_PATHS.tools, lineOf(toolsText, "key: '" + t + "'"), t));
    if (toolEvidence.length) {
      addEdge('agent:' + a.id, toolsFileNode, 'USES_TOOLS', toolEvidence[0], undefined, toolEvidence.length);
      const e = [...edges.values()].find((x) => x.from === 'agent:' + a.id && x.to === toolsFileNode && x.kind === 'USES_TOOLS');
      if (e) e.evidence = toolEvidence;
    }
  }

  // ── SYSTEM modules: the owner's own platform modules and their readiness ───
  for (const m of SYSTEM_MODULES) {
    addNode({
      id: 'sysmodule:' + m.key, kind: 'sysmodule', label: m.label, parent: 'component:system-module',
      maturity: m.readiness === 'LIVE' ? 'IMPLEMENTED' : 'PARTIAL', summary: m.backing,
      facts: { group: m.group, readiness: m.readiness },
      evidence: [ev('system-modules', TWIN_PATHS.sysmodules, lineOf(sysmodText, "key: '" + m.key + "'"))],
      room: 'system',
    });
  }

  // ── trust boundaries, and what the coverage map places in each ─────────────
  type Boundary = { name: string; flow: string; trustBoundary: string; dataClass: string; boundaryType: string; coverage: string; controls: string[]; reason?: string; owner?: string };
  const boundaries = cov.boundaries as Record<string, Boundary>;
  const bStart = covText.indexOf('"boundaries"');
  for (const row of Object.keys(boundaries).sort((a, b) => Number(a) - Number(b))) {
    const b = boundaries[row];
    addNode({
      id: 'boundary:' + row, kind: 'boundary', label: b.name, parent: 'system:security',
      maturity: b.coverage === 'C' ? 'IMPLEMENTED' : b.coverage === 'P' ? 'PARTIAL' : 'UNVERIFIED', summary: b.reason,
      facts: { row: Number(row), flow: b.flow, trustBoundary: b.trustBoundary, dataClass: b.dataClass, boundaryType: b.boundaryType, coverage: b.coverage, controls: [...(b.controls || [])] },
      evidence: [ev('coverage-map', TWIN_PATHS.coverage, lineOf(covText, '"' + row + '": {', bStart))],
      room: 'cybersecurity',
    });
  }
  const sectionByTitle = (t: string) => sectionIds.get(t);
  const placeIn: Array<[string, (name: string) => string | undefined]> = [
    ['routers', (n) => (nodes.has('api:' + n) ? 'api:' + n : nodes.has('file:src/routes/' + n + '.ts') ? 'file:src/routes/' + n + '.ts' : undefined)],
    ['srcDomains', (n) => (nodes.has('module:' + n) ? 'module:' + n : undefined)],
    ['prismaSections', (n) => sectionByTitle(n)],
    ['infrastructureComponents', (n) => (nodes.has('component:' + n) ? 'component:' + n : undefined)],
  ];
  for (const [kind, nodeFor] of placeIn) {
    const table = (cov.components[kind] || {}) as Record<string, number[]>;
    const kStart = covText.indexOf('"' + kind + '"');
    for (const name of Object.keys(table).sort()) {
      const from = nodeFor(name);
      const line = lineOf(covText, '"' + name + '"', kStart);
      if (!from) { discrepancies.push({ id: 'coverage:' + kind + ':' + name, subject: name, detail: 'The coverage map places ' + kind + ' "' + name + '" in boundaries; the graph has no node for it.', evidence: [ev('coverage-map', TWIN_PATHS.coverage, line)] }); continue; }
      for (const row of table[name]) addEdge(from, 'boundary:' + row, 'IN_BOUNDARY', ev('coverage-map', TWIN_PATHS.coverage, line));
    }
  }

  // ── provenance: what the graph was composed from ──────────────────────────
  const normalized = (t: string) => t.replace(/"generatedAt":\s*"[^"]*",?\n/, '');
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  const srcDigest = createHash('sha256');
  for (const f of srcFiles) srcDigest.update(f + '\u0000' + texts.get(f)! + '\u0000');
  const provenance = [
    { authority: 'infrastructure-manifest' as const, path: TWIN_PATHS.infra, sha256: sha(normalized(infraText)) },
    { authority: 'security-manifest' as const, path: TWIN_PATHS.security, sha256: sha(normalized(secText)) },
    { authority: 'coverage-map' as const, path: TWIN_PATHS.coverage, sha256: sha(covText) },
    { authority: 'posture-policy' as const, path: TWIN_PATHS.posture, sha256: sha(postureText) },
    { authority: 'system-modules' as const, path: TWIN_PATHS.sysmodules, sha256: sha(sysmodText) },
    { authority: 'agent-catalog' as const, path: TWIN_PATHS.catalog, sha256: sha(catalogText) },
    { authority: 'tool-registry' as const, path: TWIN_PATHS.tools, sha256: sha(toolsText) },
    { authority: 'prisma-schema' as const, path: TWIN_PATHS.schema, sha256: sha(schemaText) },
    { authority: 'typescript-imports' as const, path: 'src', sha256: srcDigest.digest('hex') },
  ];

  const nodeList = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of nodeList) { if (n.unknown === undefined) delete n.unknown; if (n.summary === undefined) delete n.summary; }
  const edgeList = [...edges.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : (a.sub || '') < (b.sub || '') ? -1 : 1));
  const tally = <T>(list: T[], key: (x: T) => string) => list.reduce<Record<string, number>>((o, x) => { o[key(x)] = (o[key(x)] || 0) + 1; return o; }, {});
  const sortKeys = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const g: TwinGraph = {
    schemaVersion: TWIN_SCHEMA_VERSION,
    provenance,
    counts: { nodes: sortKeys(tally(nodeList, (n) => n.kind)), edges: sortKeys(tally(edgeList, (e) => e.kind)) },
    nodes: nodeList,
    edges: edgeList,
    discrepancies: discrepancies.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };

  const problems = twinGraphProblems(g, exists);
  if (problems.length) throw new Error('neural twin: the composed graph breaks its invariants:\n  ' + problems.slice(0, 20).join('\n  '));
  const envNames = Object.keys((cov.components && cov.components.envVars) || {});
  const exposure = twinExposureProblems(JSON.stringify(g), envNames);
  if (exposure.length) throw new Error('neural twin: the composed graph breaks the exposure rules:\n  ' + exposure.join('\n  '));
  return g;
}

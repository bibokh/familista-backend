/**
 * tests/neural-twin-phase2.unit.test.ts
 *
 * Familista Neural Digital Twin, Phase 2: architecture intelligence over the Phase 1 graph
 * (public/neural-twin/neural-twin-intel.js). It adds no fact to the graph; these tests hold it to that.
 *
 *   1. Impact: every node it returns is reached through the graph's own edges, in the fewest steps (an independent
 *      search written here agrees node for node), with a chain whose cited evidence is re-read from the source.
 *      Negative controls: a fabricated chain is caught, removing an edge changes the answer, direction matters.
 *   2. Status: each of the six statuses is exactly what one authority records (the security manifest's dormant
 *      routers, the infrastructure manifest's future items, the composer's reachability); "experimental" and
 *      "deprecated" are not statuses, because no authority records them.
 *   3. Access: owner-only, club-scoped and public, exactly as the posture policy and the security manifest say.
 *   4. The room: the module is pure and loaded between the layout and the room; five catalogues in step.
 */
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, { get: () => new Proxy({}, { get: () => async () => [] }) }),
}));

import { composeTwin } from '../src/platform/neural-twin/compose';
import type { TwinEdge, TwinGraph, TwinNode } from '../src/platform/neural-twin/model';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Intel = require('../public/neural-twin/neural-twin-intel.js');

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p));
const G: TwinGraph = composeTwin(ROOT);
const byId = new Map(G.nodes.map((n) => [n.id, n]));
const DEP: string[] = Intel.DEPENDENCY_KINDS;
type Result = { dir: 'up' | 'down'; depth: number; kinds: string[]; reached: Record<string, { depth: number; via: number }>; ids: string[]; steps: number; limited: boolean };
const impact = (g: TwinGraph, origins: string[], opts: { dir?: string; depth?: number; kinds?: string[] }): Result => Intel.impact(g, origins, opts);
const subtree = (g: TwinGraph, id: string) => {
  const kids = new Map<string, string[]>();
  for (const n of g.nodes) if (n.parent) (kids.get(n.parent) || kids.set(n.parent, []).get(n.parent)!).push(n.id);
  const out: string[] = []; const stack = [id];
  while (stack.length) { const x = stack.pop()!; out.push(x); stack.push(...(kids.get(x) || [])); }
  return out;
};

/** An independent breadth-first search, level by level over every edge: the fewest steps to each node. */
function independentSteps(g: TwinGraph, origins: string[], dir: 'up' | 'down', kinds: string[], limit: number) {
  const on = new Set(kinds.filter((k) => DEP.includes(k)));
  const start = new Set(origins), dist = new Map<string, number>();
  let frontier = new Set(origins), d = 0;
  while (frontier.size && (!limit || d < limit)) {
    d += 1;
    const next = new Set<string>();
    for (const e of g.edges) {
      if (!on.has(e.kind)) continue;
      const a = dir === 'up' ? e.to : e.from, b = dir === 'up' ? e.from : e.to;
      if (frontier.has(a) && !start.has(b) && !dist.has(b)) { dist.set(b, d); next.add(b); }
    }
    frontier = next;
  }
  return dist;
}

/** Everything wrong with a chain: each hop a followed graph edge, joined end to end, from inside the origins to the node. */
function chainProblems(g: TwinGraph, r: Result, origins: string[], id: string, hops: number[]) {
  const out: string[] = [];
  const inOrigin = new Set(origins);
  let at: string | null = null;
  hops.forEach((i, k) => {
    const e: TwinEdge | undefined = g.edges[i];
    if (!e) { out.push('hop ' + k + ' is not an edge'); return; }
    if (!r.kinds.includes(e.kind)) out.push('hop ' + k + ' follows ' + e.kind);
    const from = r.dir === 'up' ? e.to : e.from, to = r.dir === 'up' ? e.from : e.to;
    if (k === 0 && !inOrigin.has(from)) out.push('the chain does not start inside the origin');
    if (k > 0 && from !== at) out.push('hop ' + k + ' does not continue from ' + at);
    at = to;
  });
  if (at !== id) out.push('the chain ends at ' + at + ', not ' + id);
  if (hops.length !== r.reached[id].depth) out.push('the chain is ' + hops.length + ' long, the step count ' + r.reached[id].depth);
  return out;
}

const CASES: Array<[string, 'up' | 'down']> = [
  ['file:src/platform/neural-twin/model.ts', 'up'],
  ['api:neural-twin.routes', 'down'],
  ['module:platform', 'up'],
  ['component:postgres', 'up'],
  ['file:src/utils/errors.ts', 'up'],
];

describe('1. impact: every answer is reached through the graph\'s own edges', () => {
  it('the cases exist in the graph (so nothing below passes on an empty answer)', () => {
    for (const [id] of CASES) expect(byId.has(id)).toBe(true);
    const agent = G.nodes.find((n) => n.kind === 'agent');
    expect(agent).toBeDefined();
    expect(impact(G, [agent!.id], { dir: 'down' }).ids.length).toBeGreaterThan(0);
  });

  it('every node reached has a chain of real edges, as long as its step count, from inside the origin to it', () => {
    for (const [id, dir] of CASES) {
      const origins = subtree(G, id), r = impact(G, origins, { dir });
      expect(r.ids.length).toBeGreaterThan(0);
      for (const x of r.ids) expect([x, chainProblems(G, r, origins, x, Intel.chain(G, r, x))]).toEqual([x, []]);
    }
  });

  it('reaches each node in the fewest steps: an independent search agrees, node for node, at every depth', () => {
    for (const [id, dir] of CASES) {
      const origins = subtree(G, id);
      for (const depth of [1, 2, 3, 0]) {
        const r = impact(G, origins, { dir, depth });
        const ind = independentSteps(G, origins, dir, DEP, depth);
        expect(Object.keys(r.reached).sort()).toEqual([...ind.keys()].sort());
        for (const [x, d] of ind) expect([x, r.reached[x].depth]).toEqual([x, d]);
      }
    }
  });

  it('holds the step limit, and says when more lies beyond it', () => {
    for (const [id, dir] of CASES) {
      const origins = subtree(G, id), all = impact(G, origins, { dir });
      for (const depth of [1, 2, 3]) {
        const r = impact(G, origins, { dir, depth });
        expect(r.steps).toBeLessThanOrEqual(depth);
        expect(r.limited).toBe(all.ids.length > r.ids.length);
      }
      expect(all.limited).toBe(false);
    }
  });

  it('the evidence on an import chain is real: each hop\'s cited line imports the next file', () => {
    const r = impact(G, ['file:src/platform/neural-twin/model.ts'], { dir: 'up', kinds: ['IMPORTS'] });
    const target = 'api:neural-twin.routes';
    expect(r.reached[target]).toBeDefined();
    const hops: number[] = Intel.chain(G, r, target);
    expect(hops.length).toBeGreaterThanOrEqual(2);
    for (const i of hops) {
      const e = G.edges[i], ev = e.evidence[0];
      const to = byId.get(e.to)!, toPath = (to.facts && (to.facts.path as string)) || e.to.replace(/^file:/, '');
      const line = read(ev.p).split('\n')[(ev.l || 1) - 1];
      expect([ev.p + ':' + ev.l, line]).toEqual([ev.p + ':' + ev.l, expect.stringContaining(path.posix.basename(toPath, '.ts'))]);
      expect(line).toMatch(/\bimport\b|\bfrom\s+'|require\(/);
    }
  });

  it('never follows a trust boundary: the coverage map classifies a node, it does not make it depend on anything', () => {
    expect(DEP).not.toContain('IN_BOUNDARY');
    const b = G.nodes.find((n) => n.kind === 'boundary')!;
    const r = impact(G, [b.id], { dir: 'up', kinds: ['IN_BOUNDARY'] });
    expect(r.kinds).toEqual([]);
    expect(r.ids).toEqual([]);
  });

  it('counts a container from everything inside it, and never returns its own parts', () => {
    const origins = subtree(G, 'module:platform'), inside = new Set(origins);
    const r = impact(G, origins, { dir: 'up' });
    expect(r.ids.filter((x) => inside.has(x))).toEqual([]);
  });

  it('gives the same answer every time, whatever order the origins come in', () => {
    const origins = subtree(G, 'module:platform');
    const a = impact(G, origins, { dir: 'up', depth: 3 }), b = impact(G, origins.slice().reverse(), { dir: 'up', depth: 3 });
    expect(b).toEqual(a);
  });

  it('(control) a fabricated chain is caught by the same check', () => {
    const origins = ['file:src/platform/neural-twin/model.ts'], r = impact(G, origins, { dir: 'up' });
    const target = 'api:neural-twin.routes', hops: number[] = Intel.chain(G, r, target);
    const unrelated = G.edges.findIndex((e) => e.kind === 'IMPORTS' && e.from !== byId.get(target)!.id && !hops.includes(G.edges.indexOf(e)) && e.to !== 'file:src/platform/neural-twin/store.ts');
    const forged = hops.slice(); forged[forged.length - 1] = unrelated;
    expect(chainProblems(G, r, origins, target, forged).length).toBeGreaterThan(0);
    expect(chainProblems(G, r, origins, target, hops.slice(1)).length).toBeGreaterThan(0);
  });

  it('(control) removing the edge that reached a node changes the answer, and the independent search still agrees', () => {
    const origins = ['file:src/platform/neural-twin/model.ts'], r = impact(G, origins, { dir: 'up' });
    const target = 'api:neural-twin.routes', via = r.reached[target].via;
    const g2: TwinGraph = { ...G, edges: G.edges.filter((_e, i) => i !== via) };
    const r2 = impact(g2, origins, { dir: 'up' });
    expect(!r2.reached[target] || r2.reached[target].depth > r.reached[target].depth || g2.edges[r2.reached[target].via] !== G.edges[via]).toBe(true);
    const ind = independentSteps(g2, origins, 'up', DEP, 0);
    for (const [x, d] of ind) expect([x, r2.reached[x].depth]).toEqual([x, d]);
  });

  it('(control) direction matters: what a file depends on does not include what imports it', () => {
    const down = impact(G, ['file:src/platform/neural-twin/model.ts'], { dir: 'down' });
    const up = impact(G, ['file:src/platform/neural-twin/model.ts'], { dir: 'up', depth: 1 });
    expect(up.ids).toContain('file:src/platform/neural-twin/store.ts');
    expect(down.ids).not.toContain('file:src/platform/neural-twin/store.ts');
  });
});

describe('2. status: what the authorities record, and nothing they do not', () => {
  const statusOf = (n: TwinNode): string => Intel.statusOf(n);
  const of = (st: string) => G.nodes.filter((n) => statusOf(n) === st).map((n) => n.id).sort();

  it('every node has exactly one of the six statuses, and they add up to the graph', () => {
    expect(Intel.STATUS_ORDER).toEqual(['implemented', 'partial', 'unreached', 'dormant', 'planned', 'unverified']);
    const tally = new Map<string, number>();
    for (const n of G.nodes) tally.set(statusOf(n), (tally.get(statusOf(n)) || 0) + 1);
    expect([...tally.keys()].every((k) => Intel.STATUS_ORDER.includes(k))).toBe(true);
    expect([...tally.values()].reduce((a, b) => a + b, 0)).toBe(G.nodes.length);
  });

  it('dormant is the security manifest\'s list of router modules no mount uses, node for node', () => {
    const sec = json('src/cyber-defense/generated/security-manifest.json');
    const expected = (sec.apiSurface.dormantRouteModules as string[]).map((m) => 'file:src/routes/' + m + '.ts').filter((id) => byId.has(id)).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(of('dormant')).toEqual(expected);
  });

  it('planned is the infrastructure manifest\'s future list, node for node', () => {
    const infra = json('src/infra/generated/infrastructure-manifest.json');
    expect(of('planned')).toEqual((infra.future as Array<{ id: string }>).map((f) => 'planned:' + f.id).sort());
  });

  it('not reached is the composer\'s own reachability from the server and the start-up scripts, and never a dormant router', () => {
    const dormant = new Set(of('dormant'));
    const expected = G.nodes.filter((n) => n.facts && n.facts.reachableFromEntry === false && !dormant.has(n.id) && n.maturity !== 'PLANNED' && n.maturity !== 'UNVERIFIED').map((n) => n.id).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(of('unreached')).toEqual(expected);
  });

  it('partial and unverified are the authorities\' own maturities; implemented is the rest, and never a dormant or unreached node', () => {
    expect(of('unverified')).toEqual(G.nodes.filter((n) => n.maturity === 'UNVERIFIED').map((n) => n.id).sort());
    for (const id of of('partial')) expect(byId.get(id)!.maturity).toBe('PARTIAL');
    for (const id of of('implemented')) {
      const n = byId.get(id)!;
      expect([id, n.maturity, !!(n.facts && n.facts.dormantRouter), n.facts && n.facts.reachableFromEntry === false]).toEqual([id, 'IMPLEMENTED', false, false]);
    }
  });

  it('"experimental" and "deprecated" are not statuses: no authority records either, and the room says so', () => {
    expect(Intel.STATUS_ORDER).not.toContain('experimental');
    expect(Intel.STATUS_ORDER).not.toContain('deprecated');
    const sentence = 'No authority in the repository records a component as experimental or deprecated, so no node is shown as either. A file that nothing reaches is said to be not reached, not called dead.';
    expect(read('public/neural-twin/neural-twin.js')).toContain(sentence);
    for (const l of ['en', 'de', 'ar', 'fr', 'es']) expect(json('public/neural-twin/i18n/' + l + '.json')[sentence]).toBeTruthy();
  });

  it('(control) the status follows the facts: a dormant fact, a planned maturity, an unreached file each change it', () => {
    const f = G.nodes.find((n) => n.kind === 'file' && statusOf(n) === 'implemented')!;
    expect(statusOf({ ...f, facts: { ...f.facts, dormantRouter: true } })).toBe('dormant');
    expect(statusOf({ ...f, facts: { ...f.facts, reachableFromEntry: false } })).toBe('unreached');
    expect(statusOf({ ...f, maturity: 'PLANNED' })).toBe('planned');
    expect(statusOf({ ...f, maturity: 'PARTIAL' })).toBe('partial');
  });
});

describe('3. access: as the posture policy and the security manifest record it', () => {
  const sec = json('src/cyber-defense/generated/security-manifest.json');
  const posture = json('src/cyber-defense/posture-policy.json');
  const apis = G.nodes.filter((n) => n.kind === 'api');

  it('owner only is exactly the posture policy\'s owner rooms that are mounted', () => {
    const owner = apis.filter((n) => Intel.accessOf(n).owner).map((n) => n.id).sort();
    expect(owner).toEqual(Object.keys(posture.ownerRooms).map((m) => 'api:' + m).filter((id) => byId.has(id)).sort());
    expect(owner).toContain('api:neural-twin.routes');
  });

  it('club-scoped and public handler counts are the security manifest\'s, router by router', () => {
    const tenancy = sec.apiSurface.tenancy.byRouter || {};
    for (const n of apis) {
      const mod = n.id.slice(4), a = Intel.accessOf(n);
      const mount = (sec.apiSurface.mounts as Array<{ module: string; public: number; handlers: number }>).find((m) => m.module === mod)!;
      expect([mod, a.clubGuarded, a.publicHandlers, a.handlers]).toEqual([mod, (tenancy[mod] && tenancy[mod].guarded) || 0, mount.public, mount.handlers]);
    }
    expect(Intel.accessOf(G.nodes.find((n) => n.kind === 'file'))).toBeNull();
  });
});

describe('4. the room: the module is pure, loaded in order, and every language is in step', () => {
  const ROOM = read('public/neural-twin/neural-twin.js');

  it('is pure, and the room loads it between the layout and itself', () => {
    const src = read('public/neural-twin/neural-twin-intel.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/\bdocument\b|\bwindow\.|\blocalStorage\b|Math\.random|Date\.now|performance\.now|fetch\(|XMLHttpRequest/);
    expect(read('public/app.js')).toMatch(/\['\/neural-twin\/neural-twin-layout\.js', '\/neural-twin\/neural-twin-intel\.js', '\/neural-twin\/neural-twin\.js'\]/);
    expect(ROOM).toMatch(/function I\(\) \{ return window\.FamilistaTwinIntel; \}/);
  });

  it('asks the server for nothing new: the room still reads one graph from one owner-only endpoint', () => {
    expect([...ROOM.matchAll(/api\('([^']+)'\)/g)].map((m) => m[1])).toEqual(['/system/neural-twin']);
    expect(read('public/neural-twin/neural-twin-intel.js')).not.toMatch(/\/api\/|\/system\//);
  });

  it('keeps the five catalogues in step: the same keys, every %d kept, nothing empty', () => {
    const en = json('public/neural-twin/i18n/en.json') as Record<string, string>;
    for (const l of ['de', 'ar', 'fr', 'es']) {
      const c = json('public/neural-twin/i18n/' + l + '.json') as Record<string, string>;
      expect([l, Object.keys(c).sort()]).toEqual([l, Object.keys(en).sort()]);
      for (const k of Object.keys(en)) {
        expect([l, k, (c[k].match(/%d/g) || []).length]).toEqual([l, k, (k.match(/%d/g) || []).length]);
        expect(c[k].trim()).not.toBe('');
      }
    }
  });

  it('draws its controls as labelled groups of pressed-or-not buttons, and says whether a chain is open', () => {
    expect(ROOM).toMatch(/<div class="nt-seg" role="group" aria-labelledby="nt-seg-' \+ attr \+ '">/);
    expect(ROOM).toMatch(/data-nt-' \+ attr \+ '="' \+ o\[0\] \+ '" aria-pressed="/);
    expect(ROOM).toMatch(/data-nt-why="' \+ esc\(id\) \+ '" aria-expanded="' \+ open \+ '"/);
    // the 3D view turns by keyboard, the same way in every language
    expect(ROOM).toMatch(/function cameraKey\(key\)/);
    expect(ROOM).toMatch(/if \(key === 'ArrowLeft'\) c\.alpha -= turn;/);
  });
});

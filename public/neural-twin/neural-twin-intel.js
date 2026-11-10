/**
 * Familista Neural Digital Twin — architecture intelligence (Phase 2).
 *
 * Pure and deterministic, like the layout: no DOM, no randomness, no clock. The
 * room calls it in the browser (window.FamilistaTwinIntel) and the unit tests call
 * it in Node, on the same graph the API serves.
 *
 * It answers questions about the graph the composer wrote and adds no fact to it.
 * Every node it returns is reached through the graph's own edges, each of which
 * carries the evidence it came from; a relationship the graph does not hold (a
 * call resolved at run time, an HTTP request, a queue) is not in any answer.
 *
 *   impact(graph, origins, opts)   what the origins depend on (down), or what depends on them (up),
 *                                  step by step along the dependency relationships, to a depth
 *   chain(graph, result, id)       the edges, in the order walked, that reached a node: the "why"
 *   statusOf(node)                 the node's status, from the facts its authority recorded
 *   accessOf(node)                 an API router's access, from the security manifest's facts
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaTwinIntel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The relationships along which a change travels. IN_BOUNDARY is not one of them: the coverage map places a node in a
   * trust boundary, which classifies the node and is not something it depends on.
   */
  var DEPENDENCY_KINDS = ['IMPORTS', 'DATA', 'DEPENDS_ON', 'INFRA', 'IMPLEMENTED_BY', 'USES_TOOLS'];

  /**
   * What a node's own authority says about it, most decisive first. A node takes the first that applies.
   *   planned      the infrastructure manifest lists it under `future`: nothing is built
   *   unverified   no authority places or confirms it
   *   dormant      the security manifest records the router module as mounted nowhere
   *   unreached    no import chain from the server or a start-up script reaches it (the composer's reachability)
   *   partial      its authority records it as partly built, not configured, or partly covered
   *   implemented  its authority records it as built; never a statement that it is running
   * "Experimental" and "deprecated" are not here: no authority in the repository records either for an architecture
   * node, and this module does not infer them.
   */
  var STATUS_ORDER = ['implemented', 'partial', 'unreached', 'dormant', 'planned', 'unverified'];
  var STATUS_AUTHORITY = {
    planned: 'infrastructure-manifest', unverified: 'composer-rule', dormant: 'security-manifest',
    unreached: 'typescript-imports', partial: 'authority', implemented: 'authority',
  };

  function statusOf(n) {
    var f = (n && n.facts) || {};
    if (!n) return null;
    if (n.kind === 'planned' || n.maturity === 'PLANNED') return 'planned';
    if (n.maturity === 'UNVERIFIED') return 'unverified';
    if (f.dormantRouter === true) return 'dormant';
    if (f.reachableFromEntry === false) return 'unreached';
    if (n.maturity === 'PARTIAL') return 'partial';
    return 'implemented';
  }

  /**
   * An API router's access, as the security manifest records it (the composer copied it into the node's facts):
   * whether the posture policy keeps it for the platform owner, how many handlers take a club id under the tenancy
   * guard, and how many are public. Null for anything that is not an API router.
   */
  function accessOf(n) {
    if (!n || n.kind !== 'api') return null;
    var f = n.facts || {}, guarded = 0;
    (f.tenancy || []).forEach(function (t) { var m = /^guarded (\d+)$/.exec(String(t)); if (m) guarded = Number(m[1]); });
    return { owner: f.ownerOnly === true, clubGuarded: guarded, publicHandlers: Number(f.publicHandlers) || 0, handlers: Number(f.handlers) || 0, signIn: f.routerWideAuth === true };
  }

  /** Edge indices by the node they leave from (down) or arrive at (up), in the graph's own edge order. */
  function adjacency(edges, dir, on) {
    var adj = {};
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      if (!on[e.kind]) continue;
      var at = dir === 'up' ? e.to : e.from;
      (adj[at] || (adj[at] = [])).push(i);
    }
    return adj;
  }

  /**
   * Breadth first from the origins, so each node is reached in the fewest steps, and by the first such edge in the
   * graph's order (the composer sorts its edges), so the answer is the same every time.
   * @param {{nodes:object[], edges:object[]}} graph
   * @param {string[]} origins  the node asked about, and everything inside it; edges between two origins are not followed
   * @param {{dir?:'up'|'down', kinds?:string[], depth?:number}} opts  depth: the most steps (0 for no limit)
   * @returns {{dir:string, depth:number, kinds:string[], reached:Object<string,{depth:number, via:number}>, ids:string[], steps:number, walked:number, limited:boolean}}
   */
  function impact(graph, origins, opts) {
    opts = opts || {};
    var dir = opts.dir === 'up' ? 'up' : 'down';
    var depth = opts.depth > 0 ? Math.floor(opts.depth) : 0;
    var kinds = (opts.kinds || DEPENDENCY_KINDS).filter(function (k) { return DEPENDENCY_KINDS.indexOf(k) >= 0; });
    var on = {};
    kinds.forEach(function (k) { on[k] = true; });
    var adj = adjacency(graph.edges, dir, on);
    var start = {}, reached = {}, queue = [], at = {}, walked = 0, limited = false, steps = 0;
    (origins || []).slice().sort().forEach(function (id) { if (!start[id]) { start[id] = true; at[id] = 0; queue.push(id); } });
    for (var q = 0; q < queue.length; q++) {
      var cur = queue[q], d = at[cur], list = adj[cur] || [];
      for (var j = 0; j < list.length; j++) {
        var i = list[j], e = graph.edges[i], next = dir === 'up' ? e.from : e.to;
        if (start[next] || reached[next]) continue;
        if (depth && d >= depth) { limited = true; break; }
        walked++;
        reached[next] = { depth: d + 1, via: i };
        at[next] = d + 1;
        if (d + 1 > steps) steps = d + 1;
        queue.push(next);
      }
    }
    var ids = Object.keys(reached).sort(function (a, b) { return reached[a].depth - reached[b].depth || (a < b ? -1 : a > b ? 1 : 0); });
    return { dir: dir, depth: depth, kinds: kinds, reached: reached, ids: ids, steps: steps, walked: walked, limited: limited };
  }

  /**
   * The edges that reached `id`, from the origin outward: each one a graph edge index, so each carries its evidence.
   * Downstream the chain runs along the edges (origin → … → id); upstream it runs against them (id → … → origin is the
   * direction each edge points).
   */
  function chain(graph, result, id) {
    var out = [], cur = id, guard = 0;
    while (result.reached[cur] && guard++ <= graph.edges.length) {
      var i = result.reached[cur].via, e = graph.edges[i];
      out.unshift(i);
      cur = result.dir === 'up' ? e.to : e.from;
    }
    return out;
  }

  return { DEPENDENCY_KINDS: DEPENDENCY_KINDS, STATUS_ORDER: STATUS_ORDER, STATUS_AUTHORITY: STATUS_AUTHORITY, impact: impact, chain: chain, statusOf: statusOf, accessOf: accessOf };
});

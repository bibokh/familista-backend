/**
 * Familista Neural Digital Twin — the layout.
 *
 * Pure and deterministic: no DOM, no randomness, no clock. The room calls it in
 * the browser (window.FamilistaTwinLayout) and the unit tests call it in Node.
 *
 * Position on this map says one thing only: where a node sits in the graph's own
 * nesting. A system's components, modules and agents are packed on its platform,
 * a module's files on its platform, and the systems are grouped by the zone the
 * infrastructure manifest gives them. Nothing is placed near something else
 * because they are related; relationships are the lines, and only the lines.
 *
 *   pack(circles, hole)      collision-free circle packing around an empty hole
 *   layout(spec)             every visible node's position, and the platforms
 *   lift(edges, ...)         graph edges raised to the nearest visible node
 *   shortestPath(lifted, a, b)   the fewest drawn hops from a to b, by direction
 *   declutter(boxes, pad)    which labels can be shown without overlapping
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaTwinLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Spacing, in scene units. Kept here so the tests and the room agree. */
  var SPACE = {
    leafPad: 0.55,      // around a closed node: half the gap between two neighbours
    holePad: 1.6,       // between an open node's own body and the first ring of what is inside it
    margin: [3.2, 1.4], // inside a platform's edge, for a system and for anything deeper
    zoneMargin: 2.4,    // inside a zone's boundary
    zoneGap: 4,         // between two zones
    unplacedGap: 10,    // the extra distance that keeps unclassified nodes visibly apart
    level: 1.1,         // how far each level of nesting floats above the one it sits on
  };
  /** Where the manifest's zones sit around the centre, on the floor (x, z). The camera starts south of the
   *  centre looking north, so north is the top of the screen and east its right, in either reading direction. */
  var ZONE_DIRS = { north: [0, 1], east: [1, 0], south: [0, -1], west: [-1, 0] };
  var ZONE_ORDER = ['centre', 'north', 'east', 'south', 'west'];

  function hyp(x, z) { return Math.sqrt(x * x + z * z); }

  /**
   * Circles placed one after another on an outward spiral, each at the first
   * point where it touches nothing already placed. Deterministic for a given
   * order; no two circles overlap; nothing enters the hole at the centre.
   * @param {{id:string,r:number}[]} circles in placement order
   * @param {number} hole the radius kept empty at the centre (0: the first circle sits there)
   * @returns {Object<string,[number,number]>} each circle's centre
   */
  function pack(circles, hole) {
    var placed = [], out = {}, resume = {};
    hole = hole > 0 ? hole : 0;
    for (var i = 0; i < circles.length; i++) {
      var c = circles[i], r = c.r;
      if (!placed.length && hole === 0) { out[c.id] = [0, 0]; placed.push([0, 0, r]); continue; }
      // a spot refused to one circle is refused to the next of the same size: placing only ever adds obstacles
      var key = r.toFixed(6), th = resume[key] || 0, pitch = Math.max(r, 0.35) / (2 * Math.PI), x = 0, z = 0;
      for (var guard = 0; guard < 400000; guard++) {
        var rho = hole + r + pitch * th;
        x = rho * Math.cos(th); z = rho * Math.sin(th);
        if (clear(placed, x, z, r)) break;
        th += Math.min(0.3, Math.max(0.002, (0.3 * r) / rho));
      }
      resume[key] = th;
      out[c.id] = [x, z];
      placed.push([x, z, r]);
    }
    return out;
  }
  function clear(placed, x, z, r) {
    for (var j = 0; j < placed.length; j++) {
      var p = placed[j], dx = p[0] - x, dz = p[1] - z, rr = p[2] + r;
      if (dx * dx + dz * dz < rr * rr - 1e-9) return false;
    }
    return true;
  }
  /** The smallest circle, centred on the bounding box, that holds every circle. */
  function enclose(pos, circles) {
    if (!circles.length) return { x: 0, z: 0, r: 0 };
    var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    circles.forEach(function (c) { var p = pos[c.id]; x0 = Math.min(x0, p[0] - c.r); x1 = Math.max(x1, p[0] + c.r); z0 = Math.min(z0, p[1] - c.r); z1 = Math.max(z1, p[1] + c.r); });
    var cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = 0;
    circles.forEach(function (c) { var p = pos[c.id]; r = Math.max(r, hyp(p[0] - cx, p[1] - cz) + c.r); });
    return { x: cx, z: cz, r: r };
  }

  /**
   * Every visible node's position, and the platforms and zones to draw under them.
   * @param {object} spec
   *   roots: [{id, zone}]       the systems on screen, in order ('' or an unknown zone: no district evidence)
   *   kids(id): string[]        the node's children on screen, in order
   *   open(id): boolean         whether the node is open
   *   body(id): number          the radius the node is drawn at
   */
  function layout(spec) {
    var bubble = {}, local = {}, platforms = [];
    function size(id, depth) {
      var ks = spec.open(id) ? spec.kids(id) : [], b = spec.body(id);
      // a closed node keeps clear space around it in proportion to its size, so a large body never crowds its label
      if (!ks.length) return (bubble[id] = b + Math.max(SPACE.leafPad, b * 0.6));
      var circles = ks.map(function (k, i) { return { id: k, r: size(k, depth + 1), i: i, open: spec.open(k) && spec.kids(k).length > 0 }; });
      // what is open goes in first, largest first, so it sits next to its parent; the rest keep their order
      circles.sort(function (a, c) { return (c.open - a.open) || (a.open ? c.r - a.r : 0) || a.i - c.i; });
      var hole = b + SPACE.holePad, pos = pack(circles, hole), R = hole;
      circles.forEach(function (c) { var p = pos[c.id]; R = Math.max(R, hyp(p[0], p[1]) + c.r); });
      local[id] = pos;
      return (bubble[id] = R + SPACE.margin[Math.min(depth, 1)]);
    }
    var zones = {}, zoneList = [];
    spec.roots.forEach(function (s) {
      size(s.id, 0);
      var z = Object.prototype.hasOwnProperty.call(ZONE_DIRS, s.zone) || s.zone === 'centre' ? s.zone : '';
      if (!zones[z]) { zones[z] = []; zoneList.push(z); }
      zones[z].push({ id: s.id, r: bubble[s.id] });
    });
    // each zone packed on its own, then the zones arranged by the manifest's compass
    var zoneBox = {};
    zoneList.forEach(function (z) {
      var cs = zones[z], pos = pack(cs, 0), e = enclose(pos, cs);
      zoneBox[z] = { pos: pos, cx: e.x, cz: e.z, r: e.r + SPACE.zoneMargin };
    });
    var placedZones = [], zoneAt = {};
    function overlapsZone(x, z, r, gap) {
      return placedZones.some(function (p) { return hyp(p[0] - x, p[1] - z) < p[2] + r + gap - 1e-9; });
    }
    var named = ZONE_ORDER.filter(function (z) { return zoneBox[z]; });
    named.forEach(function (z, i) {
      var box = zoneBox[z], x = 0, y = 0;
      if (i > 0 || z !== 'centre') {
        var d = z === 'centre' ? [0, 0] : ZONE_DIRS[z], c0 = placedZones.length ? placedZones[0] : [0, 0, 0];
        var dist = placedZones.length ? c0[2] + box.r + SPACE.zoneGap : 0;
        x = d[0] * dist; y = d[1] * dist;
        while (placedZones.length && overlapsZone(x, y, box.r, SPACE.zoneGap)) { dist += 1; x = d[0] * dist; y = d[1] * dist; }
      }
      placedZones.push([x, y, box.r]);
      zoneAt[z] = [x, y];
    });
    if (zoneBox['']) {
      // what has no district evidence stands apart, south-east of everything else, with clear space between
      var ub = zoneBox[''], s2 = Math.SQRT1_2, dist = 0, ux = 0, uz = 0;
      if (placedZones.length) {
        do { dist += 1; ux = s2 * dist; uz = -s2 * dist; } while (overlapsZone(ux, uz, ub.r, SPACE.unplacedGap));
      }
      zoneAt[''] = [ux, uz];
      placedZones.push([ux, uz, ub.r]);
    }
    var pos = {};
    function put(id, x, z, depth) {
      pos[id] = [x, depth * SPACE.level, z];
      var l = local[id];
      if (!l) return;
      platforms.push({ id: id, x: x, z: z, y: depth * SPACE.level, r: bubble[id] - SPACE.margin[Math.min(depth, 1)] * 0.45, depth: depth });
      Object.keys(l).forEach(function (k) { put(k, x + l[k][0], z + l[k][1], depth + 1); });
    }
    var zoneRings = [];
    zoneList.forEach(function (z) {
      var box = zoneBox[z], at = zoneAt[z];
      zoneRings.push({ zone: z, x: at[0], z: at[1], r: box.r, unplaced: z === '' });
      zones[z].forEach(function (c) { var p = box.pos[c.id]; put(c.id, at[0] + p[0] - box.cx, at[1] + p[1] - box.cz, 0); });
    });
    var extent = 0;
    zoneRings.forEach(function (z) { extent = Math.max(extent, hyp(z.x, z.z) + z.r); });
    return { pos: pos, bubble: bubble, platforms: platforms, zones: zoneRings, extent: extent };
  }

  /**
   * Graph edges drawn between what is on screen: each end raised to its nearest
   * visible ancestor-or-self, and edges that land on the same pair, of the same
   * kind, counted together. An edge with an end that has no visible ancestor, or
   * whose two ends land on one node, is not drawn. Nothing is added.
   * @returns {{from,to,kind,weight,n}[]} sorted, so the same input draws the same lines
   */
  function lift(edges, visible, parentOf, kindOn) {
    var rep = {};
    function repOf(id) {
      if (rep[id] !== undefined) return rep[id];
      var r = null, cur = id;
      while (cur) { if (visible[cur]) { r = cur; break; } cur = parentOf(cur); }
      return (rep[id] = r);
    }
    var agg = {};
    edges.forEach(function (e) {
      if (kindOn && !kindOn(e.kind)) return;
      var a = repOf(e.from), b = repOf(e.to);
      if (!a || !b || a === b) return;
      var key = a + '\u0000' + b + '\u0000' + e.kind;
      var x = agg[key] || (agg[key] = { from: a, to: b, kind: e.kind, weight: 0, n: 0 });
      x.weight += e.weight; x.n += 1;
    });
    return Object.keys(agg).sort().map(function (k) { return agg[k]; });
  }

  /**
   * The fewest drawn edges from a to b, following each edge's own direction.
   * When there is none, the fewest from b to a. Ties are broken by id, so the
   * answer does not change between calls. Never mixes directions.
   * @returns {{nodes:string[], edges:number[], reversed:boolean}|null} edges index into lifted
   */
  function shortestPath(lifted, a, b) {
    if (!a || !b || a === b) return null;
    function bfs(from, to) {
      var adj = {};
      lifted.forEach(function (e, i) { (adj[e.from] = adj[e.from] || []).push(i); });
      Object.keys(adj).forEach(function (k) { adj[k].sort(function (x, y) { var p = lifted[x], q = lifted[y]; return p.to < q.to ? -1 : p.to > q.to ? 1 : (p.kind < q.kind ? -1 : p.kind > q.kind ? 1 : 0); }); });
      var prev = {}, seen = {}, queue = [from];
      seen[from] = true;
      while (queue.length) {
        var cur = queue.shift();
        if (cur === to) break;
        (adj[cur] || []).forEach(function (i) { var nx = lifted[i].to; if (!seen[nx]) { seen[nx] = true; prev[nx] = i; queue.push(nx); } });
      }
      if (!seen[to]) return null;
      var nodes = [to], es = [], c = to;
      while (c !== from) { var i = prev[c]; es.unshift(i); c = lifted[i].from; nodes.unshift(c); }
      return { nodes: nodes, edges: es };
    }
    var p = bfs(a, b);
    if (p) { p.reversed = false; return p; }
    p = bfs(b, a);
    if (p) { p.reversed = true; return p; }
    return null;
  }

  /**
   * Which labels to show: in priority order (lower first), each label is kept
   * only if its box, grown by pad, touches no label already kept.
   * @param {{id,x,y,w,h,pri}[]} boxes screen rectangles, x and y their top-left corner
   * @returns {Object<string,true>} the labels kept
   */
  function declutter(boxes, pad) {
    pad = pad || 0;
    var order = boxes.slice().sort(function (a, b) { return a.pri - b.pri || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    var cell = 96, grid = {}, kept = {};
    function cells(b) {
      var out = [], x0 = Math.floor((b.x - pad) / cell), x1 = Math.floor((b.x + b.w + pad) / cell), y0 = Math.floor((b.y - pad) / cell), y1 = Math.floor((b.y + b.h + pad) / cell);
      for (var i = x0; i <= x1; i++) for (var j = y0; j <= y1; j++) out.push(i + ',' + j);
      return out;
    }
    order.forEach(function (b) {
      var cs = cells(b), hit = false;
      for (var c = 0; c < cs.length && !hit; c++) {
        var list = grid[cs[c]] || [];
        for (var k = 0; k < list.length; k++) {
          var o = list[k];
          if (b.x - pad < o.x + o.w && o.x < b.x + b.w + pad && b.y - pad < o.y + o.h && o.y < b.y + b.h + pad) { hit = true; break; }
        }
      }
      if (hit) return;
      kept[b.id] = true;
      cs.forEach(function (c) { (grid[c] = grid[c] || []).push(b); });
    });
    return kept;
  }

  return { SPACE: SPACE, ZONE_DIRS: ZONE_DIRS, pack: pack, layout: layout, lift: lift, shortestPath: shortestPath, declutter: declutter };
});

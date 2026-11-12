/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN STUDIO — DS-1c — the garment, in three dimensions

   Pure and deterministic: from the product template's own flat surfaces (the
   millimetre outlines pd-core.js validates and the editor draws), the geometry
   of a 3D jersey, its trims, its seams and the camera presets that look at it.
   No DOM, no WebGL, no Babylon: pd-3d.js turns what this returns into meshes,
   and the Jest suite checks it directly (tests/product-design-garment.unit.test.ts).

   WHAT THIS IS, AND WHAT IT IS NOT

   A procedural prototype of a shirt's form, built from the template's flat
   panels. It is NOT a manufacturing pattern, a graded size or a measured body:
   the torso is an elliptical cylinder sized to each panel row, the shoulders
   are a blend, the sleeves are cones. What it guarantees is the mapping:

     · every vertex's texture coordinate is its position on the flat surface
       (u = x / width, v = 1 − y / height), so the artwork the 2D editor draws
       is the artwork the 3D garment shows, element for element;
     · below the shoulders, each body row is wrapped by arc length, so a
       distance across the panel in millimetres is the same distance around the
       3D surface (the wrap is isometric along rows); around each sleeve, the
       circumference is the sleeve's flat width at that row;
     · front and back meet at the side seams and along the shoulders (the top
       edge of each panel's convex hull), and each sleeve closes on its
       underarm seam;
     · nothing is mirrored: the front reads left to right from the front, the
       back from behind, each sleeve from its own side.

   COORDINATES

   Metres, Babylon's left-handed frame: x to the viewer's right when looking at
   the front, y up, z away from that viewer (the front faces −z). The wearer's
   right is −x, as the template's front view draws it (its right sleeve on the
   viewer's left).
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FamilistaProductDesignGarment = factory();
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var MM = 0.001;
  /** Torso depth over width: an elliptical section, 0.6 deep for 1 wide. */
  var DEPTH = 0.6;
  /** The default mesh: below the shoulder tip, rows every this many millimetres, and this many columns across. */
  var ROW_MM = 6;
  var COLS = 72;
  /** The sleeve's angle below the horizontal, in degrees: a relaxed arm. */
  var SLEEVE_DEG = 52;
  var ARC_STEPS = 512;

  // ── the half-ellipse, by arc length ───────────────────────────────────────
  // A unit half-ellipse (half-width 1, half-depth DEPTH) from θ = π to 0, with
  // its cumulative arc length, so a fraction of the way along a row finds its
  // angle. Every row is this curve scaled, so one table serves them all.
  var ARC = (function () {
    var th = [], len = [0];
    for (var i = 0; i <= ARC_STEPS; i++) th.push(Math.PI * (1 - i / ARC_STEPS));
    for (var j = 1; j <= ARC_STEPS; j++) {
      var dx = Math.cos(th[j]) - Math.cos(th[j - 1]), dz = DEPTH * (Math.sin(th[j]) - Math.sin(th[j - 1]));
      len.push(len[j - 1] + Math.sqrt(dx * dx + dz * dz));
    }
    return { th: th, len: len, total: len[ARC_STEPS] };
  }());
  /** The angle at fraction f (0…1) of the way along the half-ellipse. */
  function thetaAt(f) {
    var target = Math.max(0, Math.min(1, f)) * ARC.total, lo = 0, hi = ARC_STEPS;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (ARC.len[mid] < target) lo = mid; else hi = mid; }
    var span = ARC.len[hi] - ARC.len[lo], t = span ? (target - ARC.len[lo]) / span : 0;
    return ARC.th[lo] + (ARC.th[hi] - ARC.th[lo]) * t;
  }

  // ── reading the template ──────────────────────────────────────────────────

  /** A polygon from an outline: [x, y] points; [x, y, cx, cy] a quadratic curve to (x, y) through control (cx, cy). */
  function flatten(outline, steps) {
    // As pd-core.js flattens an outline (its first point is never a curve), with a chosen number of steps per curve.
    steps = steps || 12;
    var out = [[outline[0][0], outline[0][1]]];
    for (var i = 1; i < outline.length; i++) {
      var p = outline[i], prev = out[out.length - 1];
      if (p.length === 4) {
        for (var k = 1; k <= steps; k++) {
          var t = k / steps, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
          out.push([a * prev[0] + b * p[2] + c * p[0], a * prev[1] + b * p[3] + c * p[1]]);
        }
      } else out.push([p[0], p[1]]);
    }
    return out;
  }
  /** Where a horizontal line at y crosses the polygon: the leftmost and rightmost x, or null. */
  function rowExtent(poly, y) {
    var xs = [];
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    if (xs.length < 2) return null;
    return [Math.min.apply(null, xs), Math.max.apply(null, xs)];
  }
  function surfaceOf(template, id) {
    for (var i = 0; i < template.surfaces.length; i++) if (template.surfaces[i].id === id) return template.surfaces[i];
    return null;
  }
  /** The outline's vertices (not curve controls) as [x, y]. */
  function vertices(outline) { return outline.map(function (p) { return [p[0], p[1]]; }); }
  function minY(poly) { return poly.reduce(function (m, p) { return Math.min(m, p[1]); }, Infinity); }
  function maxY(poly) { return poly.reduce(function (m, p) { return Math.max(m, p[1]); }, -Infinity); }

  /**
   * The top edge of the polygon's convex hull, left to right: the line a
   * shoulder seam follows, bridging the neck opening. As a function of x.
   */
  function topLine(poly) {
    var pts = poly.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }), chain = [];
    pts.forEach(function (p) {
      while (chain.length >= 2) {
        var o = chain[chain.length - 2], a = chain[chain.length - 1];
        if ((a[0] - o[0]) * (p[1] - o[1]) - (a[1] - o[1]) * (p[0] - o[0]) <= 0) chain.pop(); else break;
      }
      chain.push(p);
    });
    return function (x) {
      if (x <= chain[0][0]) return chain[0][1];
      for (var i = 1; i < chain.length; i++) {
        if (x <= chain[i][0]) {
          var a = chain[i - 1], b = chain[i], span = b[0] - a[0];
          return span ? a[1] + (b[1] - a[1]) * (x - a[0]) / span : Math.min(a[1], b[1]);
        }
      }
      return chain[chain.length - 1][1];
    };
  }

  /**
   * A row's extent, with y held between two rows of the outline's own straight
   * sides: above `lo` (a shoulder, a sleeve head) and below `hi` (the hem's or
   * the cuff's corners) the rows keep the width there, and what lies outside the
   * outline is cut away by the artwork's own transparency.
   */
  function extentFn(poly, lo, hi, width) {
    var cache = {};
    return function (y) {
      var yy = Math.min(Math.max(y, lo), hi), key = Math.round(yy * 100);
      if (!cache[key]) cache[key] = rowExtent(poly, yy) || [0, width];
      return cache[key];
    };
  }

  /**
   * The body's landmarks, read from the outline itself: the armpit is its
   * left-most vertex, the shoulder tip the left-most vertex above it, the top
   * and the hem its extremes, the hem's corners its lowest vertex.
   */
  function landmarks(ts) {
    var vs = vertices(ts.outline), poly = flatten(ts.outline);
    var armpit = vs.reduce(function (m, p) { return p[0] < m[0] ? p : m; });
    var above = vs.filter(function (p) { return p[1] < armpit[1]; });
    var tip = above.reduce(function (m, p) { return p[0] < m[0] ? p : m; }, above[0]);
    var corner = vs.reduce(function (m, p) { return Math.max(m, p[1]); }, -Infinity);
    return { armpit: armpit, tip: tip, top: minY(poly), hem: maxY(poly), corner: corner, poly: poly };
  }

  // ── the body ──────────────────────────────────────────────────────────────

  /**
   * One body panel's mapping. `side` is 'front' (faces −z) or 'back' (+z). A
   * row below the shoulder tip spans the outline's own width there and wraps a
   * half-ellipse of exactly that arc length; above it, rows keep the tip's
   * width and fold back over the shoulder, reaching z = 0 on the hull's top
   * edge, where the other panel's shoulder reaches it too.
   */
  function bodyMapper(ts, side, lm) {
    var extent = extentFn(lm.poly, lm.tip[1], lm.corner - 0.25, ts.width);
    var top = topLine(lm.poly);
    var yMid = (lm.top + lm.hem) / 2, sign = side === 'front' ? 1 : -1;
    function at(x, y) {
      var e = extent(y), w = e[1] - e[0];
      var a = (w / ARC.total) * MM;
      var th = thetaAt((x - e[0]) / w);
      var X = sign * a * Math.cos(th);
      var Z = -sign * DEPTH * a * Math.sin(th);
      if (y < lm.tip[1]) {
        var span = lm.tip[1] - top(x);
        var t = span > 0.5 ? Math.min(1, (lm.tip[1] - y) / span) : 1;
        Z *= 1 - t * t * (3 - 2 * t);
      }
      return [X, (yMid - y) * MM, Z];
    }
    return { at: at, extent: extent, top: top };
  }

  // ── the sleeves ───────────────────────────────────────────────────────────

  /**
   * One sleeve's mapping: a cone along the arm whose circumference at each row
   * is the sleeve's flat width there, the underarm seam at the flat edges and
   * the middle of the sleeve on the outside of the arm. `side` is the wearer's
   * side: 'right' hangs at −x, 'left' at +x.
   */
  function sleeveMapper(ts, side, anchor) {
    var poly = flatten(ts.outline), vs = vertices(ts.outline);
    var capBase = vs[0][1], corner = vs.reduce(function (m, p) { return Math.max(m, p[1]); }, -Infinity);
    var top = minY(poly);
    var extent = extentFn(poly, capBase, corner - 0.25, ts.width);
    var a = SLEEVE_DEG * Math.PI / 180, sx = side === 'left' ? 1 : -1;
    var u = [sx * Math.cos(a), -Math.sin(a), 0];          // along the arm
    var n = [sx * Math.sin(a), Math.cos(a), 0];           // the outside of the arm
    var t = [0, 0, side === 'left' ? 1 : -1];             // across the outside, as the side view reads
    var e0 = extent(capBase), r0 = (e0[1] - e0[0]) / (2 * Math.PI) * MM;
    // The axis starts so that the top of the sleeve head sits on the shoulder tip.
    var origin = [anchor[0] - r0 * n[0], anchor[1] - r0 * n[1], anchor[2] - r0 * n[2]];
    return {
      at: function (x, y) {
        var e = extent(y), w = e[1] - e[0], r = w / (2 * Math.PI) * MM;
        var phi = 2 * Math.PI * ((x - e[0]) / w) - Math.PI;
        var d = (y - top) * MM;
        return [
          origin[0] + d * u[0] + r * (Math.cos(phi) * n[0] + Math.sin(phi) * t[0]),
          origin[1] + d * u[1] + r * (Math.cos(phi) * n[1] + Math.sin(phi) * t[1]),
          origin[2] + d * u[2] + r * (Math.cos(phi) * n[2] + Math.sin(phi) * t[2]),
        ];
      },
      extent: extent, top: top, bottom: maxY(poly),
      axis: u, outside: n, across: t, origin: origin,
    };
  }

  /**
   * The outward normal at a point of a surface, from the mapping itself: the
   * surface's x direction crossed with its y direction (y runs down the flat
   * panel), which points away from the body on every panel as built here.
   */
  function outward(at, x, y) {
    var p = at(x, y), px = at(x + 1, y), py = at(x, y + 1);
    var ux = [px[0] - p[0], px[1] - p[1], px[2] - p[2]], uy = [py[0] - p[0], py[1] - p[1], py[2] - p[2]];
    var n = [ux[1] * uy[2] - ux[2] * uy[1], ux[2] * uy[0] - ux[0] * uy[2], ux[0] * uy[1] - ux[1] * uy[0]];
    var l = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  }

  // ── meshes ────────────────────────────────────────────────────────────────

  /** A grid over the surface's rows, mapped through `at`; rows and columns run between the outline's own extents. */
  function panelMesh(ts, at, yFrom, yTo, extent, rowMm, cols) {
    var rows = [];
    for (var y = yFrom; y < yTo - 1e-9; y += rowMm) rows.push(y);
    rows.push(yTo);
    var positions = [], uvs = [], indices = [], flat = [];
    rows.forEach(function (y) {
      var e = extent(y);
      for (var c = 0; c <= cols; c++) {
        var x = e[0] + (e[1] - e[0]) * (c / cols);
        var p = at(x, y);
        positions.push(p[0], p[1], p[2]);
        uvs.push(x / ts.width, 1 - y / ts.height);
        flat.push(x, y);
      }
    });
    var stride = cols + 1;
    for (var r = 0; r < rows.length - 1; r++) {
      for (var k = 0; k < cols; k++) {
        var i0 = r * stride + k, i1 = i0 + 1, i2 = i0 + stride, i3 = i2 + 1;
        indices.push(i0, i2, i1, i1, i2, i3);
      }
    }
    return { positions: positions, uvs: uvs, indices: indices, flat: flat, rows: rows.length, cols: stride };
  }

  /**
   * The whole garment from a validated template. `opts.rowMm` and `opts.cols`
   * set the mesh density (the quality levels). Returns plain arrays.
   */
  function build(template, opts) {
    opts = opts || {};
    var rowMm = opts.rowMm > 0 ? opts.rowMm : ROW_MM, cols = opts.cols > 0 ? Math.round(opts.cols) : COLS;
    var front = surfaceOf(template, 'front'), back = surfaceOf(template, 'back');
    var sr = surfaceOf(template, 'sleeve-right'), sl = surfaceOf(template, 'sleeve-left');
    if (!front || !back || !sr || !sl) throw new Error('garment: the template needs front, back and both sleeves');
    var lf = landmarks(front), lb = landmarks(back);
    var mf = bodyMapper(front, 'front', lf), mb = bodyMapper(back, 'back', lb);
    // The sleeves hang from the shoulder tips, as the front panel places them.
    var tipR = mf.at(lf.tip[0], lf.tip[1]), tipL = mf.at(front.width - lf.tip[0], lf.tip[1]);
    var mR = sleeveMapper(sr, 'right', tipR), mL = sleeveMapper(sl, 'left', tipL);
    var panels = [
      { surface: 'front', size: { w: front.width, h: front.height }, mesh: panelMesh(front, mf.at, lf.top, lf.hem, mf.extent, rowMm, cols) },
      { surface: 'back', size: { w: back.width, h: back.height }, mesh: panelMesh(back, mb.at, lb.top, lb.hem, mb.extent, rowMm, cols) },
      { surface: 'sleeve-right', size: { w: sr.width, h: sr.height }, mesh: panelMesh(sr, mR.at, mR.top, mR.bottom, mR.extent, rowMm, cols) },
      { surface: 'sleeve-left', size: { w: sl.width, h: sl.height }, mesh: panelMesh(sl, mL.at, mL.top, mL.bottom, mL.extent, rowMm, cols) },
    ];
    var mappers = { front: mf.at, back: mb.at, 'sleeve-right': mR.at, 'sleeve-left': mL.at };
    return {
      units: 'm', mmToUnits: MM, panels: panels, mappers: mappers,
      extents: { front: mf.extent, back: mb.extent, 'sleeve-right': mR.extent, 'sleeve-left': mL.extent },
      landmarks: { front: { tip: lf.tip, armpit: lf.armpit, top: lf.top, hem: lf.hem, corner: lf.corner }, back: { tip: lb.tip, armpit: lb.armpit, top: lb.top, hem: lb.hem, corner: lb.corner } },
      shoulders: { front: mf.top, back: mb.top },
      presets: presets({ 'sleeve-right': mR.at((mR.extent(mR.bottom)[0] + mR.extent(mR.bottom)[1]) / 2, (sr.outline[0][1] + mR.bottom) / 2),
        'sleeve-left': mL.at((mL.extent(mL.bottom)[0] + mL.extent(mL.bottom)[1]) / 2, (sl.outline[0][1] + mL.bottom) / 2) }),
      trims: trims(template, mappers),
      seams: seams(template, mappers),
      sleeves: { 'sleeve-right': { axis: mR.axis, outside: mR.outside, across: mR.across, origin: mR.origin }, 'sleeve-left': { axis: mL.axis, outside: mL.outside, across: mL.across, origin: mL.origin } },
      bounds: bounds(panels),
    };
  }

  /** The collar (the views' collar lines, on the body) and the cuffs (a ring at each sleeve's end). */
  function trims(template, mappers) {
    var out = { collar: [], cuffs: {} };
    template.views.forEach(function (v) {
      if (v.collar && (v.surface === 'front' || v.surface === 'back')) {
        var line = flatten(v.collar, 10);
        out.collar.push(line.map(function (p) { return mappers[v.surface](p[0], p[1]); }));
      }
      if (v.cuff && mappers[v.surface]) {
        var y = v.cuff[0][1], ring = [];
        for (var i = 0; i <= 48; i++) ring.push(mappers[v.surface](v.cuff[0][0] + (v.cuff[1][0] - v.cuff[0][0]) * (i / 48), y));
        out.cuffs[v.surface] = ring;
      }
    });
    return out;
  }
  /** Each panel's edge, in 3D: the seams and hems a viewer can check artwork against. */
  function seams(template, mappers) {
    var out = {};
    Object.keys(mappers).forEach(function (id) {
      var ts = surfaceOf(template, id);
      out[id] = flatten(ts.outline, 16).map(function (p) { return mappers[id](p[0], p[1]); });
    });
    return out;
  }
  function bounds(panels) {
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    panels.forEach(function (p) {
      for (var i = 0; i < p.mesh.positions.length; i += 3) for (var k = 0; k < 3; k++) {
        var v = p.mesh.positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    });
    return { min: min, max: max, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
  }

  // ── cameras ───────────────────────────────────────────────────────────────

  /**
   * The presets, as an orbit around the garment: alpha around the vertical
   * axis, beta from the top, radius in metres. Babylon's ArcRotateCamera puts
   * the eye at target + radius·(cos α sin β, cos β, sin α sin β).
   */
  var PRESETS = {
    front: { alpha: -Math.PI / 2, beta: 1.42, radius: 1.35 },
    back: { alpha: Math.PI / 2, beta: 1.42, radius: 1.35 },
    'sleeve-right': { alpha: Math.PI, beta: 1.15, radius: 0.85 },
    'sleeve-left': { alpha: 0, beta: 1.15, radius: 0.85 },
    collar: { alpha: -Math.PI / 2, beta: 1.12, radius: 0.85 },
  };
  /**
   * The presets for a built garment: the front, the back and the collar look at its centre; each side looks at the
   * middle of the outside of its sleeve, from outside and a little above, so the sleeve's artwork is read face on.
   */
  function presets(sleeveCentres) {
    var out = {};
    Object.keys(PRESETS).forEach(function (k) {
      var p = PRESETS[k], c = sleeveCentres[k];
      out[k] = { alpha: p.alpha, beta: p.beta, radius: p.radius, target: c ? c.slice() : [0, 0, 0] };
    });
    return out;
  }
  function eye(p, target) {
    target = target || p.target || [0, 0, 0];
    return [target[0] + p.radius * Math.cos(p.alpha) * Math.sin(p.beta), target[1] + p.radius * Math.cos(p.beta), target[2] + p.radius * Math.sin(p.alpha) * Math.sin(p.beta)];
  }
  /** The screen's rightward direction for a preset, as Babylon's left-handed LookAt computes it: up × forward. */
  function screenRight(p, target) {
    target = target || p.target || [0, 0, 0];
    var e = eye(p, target), f = [target[0] - e[0], target[1] - e[1], target[2] - e[2]];
    var r = [1 * f[2] - 0 * f[1], 0 * f[0] - 0 * f[2], 0 * f[1] - 1 * f[0]];
    var l = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]) || 1;
    return [r[0] / l, r[1] / l, r[2] / l];
  }
  /** A preset that faces a point on the garment from outside, close enough to inspect it. */
  function facing(point, normal, radius) {
    var nx = normal[0], ny = normal[1], nz = normal[2];
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    var beta = Math.acos(Math.max(-0.95, Math.min(0.95, ny)));
    var alpha = Math.atan2(nz, nx);
    return { alpha: alpha, beta: beta, radius: radius || 0.75, target: point.slice() };
  }

  return Object.freeze({
    MM: MM, DEPTH: DEPTH, SLEEVE_DEG: SLEEVE_DEG, PRESETS: PRESETS,
    build: build, flatten: flatten, rowExtent: rowExtent, thetaAt: thetaAt, arcTotal: ARC.total,
    outward: outward, eye: eye, screenRight: screenRight, facing: facing,
  });
}));

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
  function arcTable(depth) {
    var th = [], len = [0];
    for (var i = 0; i <= ARC_STEPS; i++) th.push(Math.PI * (1 - i / ARC_STEPS));
    for (var j = 1; j <= ARC_STEPS; j++) {
      var dx = Math.cos(th[j]) - Math.cos(th[j - 1]), dz = depth * (Math.sin(th[j]) - Math.sin(th[j - 1]));
      len.push(len[j - 1] + Math.sqrt(dx * dx + dz * dz));
    }
    var table = { depth: depth, th: th, len: len, total: len[ARC_STEPS] };
    /** The angle at fraction f (0…1) of the way along the half-ellipse. */
    table.at = function (f) {
      var target = Math.max(0, Math.min(1, f)) * table.total, lo = 0, hi = ARC_STEPS;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (len[mid] < target) lo = mid; else hi = mid; }
      var span = len[hi] - len[lo], t = span ? (target - len[lo]) / span : 0;
      return th[lo] + (th[hi] - th[lo]) * t;
    };
    return table;
  }
  var ARC = arcTable(DEPTH);
  /** The angle at fraction f (0…1) of the way along the torso's half-ellipse. */
  function thetaAt(f) { return ARC.at(f); }

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
    var form = template.form || 'top';
    if (form === 'shorts') return buildShorts(template, opts);
    if (form === 'socks') return buildSocks(template, opts);
    if (form !== 'top') throw new Error('garment: no builder for the form ' + form);
    return buildTop(template, opts);
  }
  /** The mesh density asked for: rows every `rowMm` millimetres, `cols` columns across. */
  function density(opts) {
    opts = opts || {};
    return { rowMm: opts.rowMm > 0 ? opts.rowMm : ROW_MM, cols: opts.cols > 0 ? Math.round(opts.cols) : COLS };
  }
  function buildTop(template, opts) {
    var d = density(opts), rowMm = d.rowMm, cols = d.cols;
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
      form: 'top', home: 'front', across: [1, 0, 0],
      units: 'm', mmToUnits: MM, panels: panels, mappers: mappers,
      extents: { front: mf.extent, back: mb.extent, 'sleeve-right': mR.extent, 'sleeve-left': mL.extent },
      landmarks: { front: { tip: lf.tip, armpit: lf.armpit, top: lf.top, hem: lf.hem, corner: lf.corner }, back: { tip: lb.tip, armpit: lb.armpit, top: lb.top, hem: lb.hem, corner: lb.corner } },
      shoulders: { front: mf.top, back: mb.top },
      presets: presets({ 'sleeve-right': mR.at((mR.extent(mR.bottom)[0] + mR.extent(mR.bottom)[1]) / 2, (sr.outline[0][1] + mR.bottom) / 2),
        'sleeve-left': mL.at((mL.extent(mL.bottom)[0] + mL.extent(mL.bottom)[1]) / 2, (sl.outline[0][1] + mL.bottom) / 2) }, panels),
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

  // ── legwear: shorts and socks ─────────────────────────────────────────────
  //
  // SHORTS: a front and a back panel, each holding both legs. Above the rise a row wraps half the hip, a half-ellipse
  // as the torso's; below the crotch each leg's part of the row wraps half that leg, a rounder half-ellipse, the legs
  // apart by the flat gap between them. Over the rise (RISE_MM above the crotch) the one section becomes two: the hip's
  // and the touching legs' sections are blended, and the blend is re-measured and scaled so that it too has exactly the
  // row's flat width. So every row is wrapped by arc length, rise included. Front and back meet at the side seams, the
  // inseams and the crotch; the waist and the leg openings are open.
  //
  // SOCKS: the sock as it is pressed flat to be printed, seen from its outer and from its inner side. Each face is half
  // the knitted tube; they meet along the shin and instep in front, and along the calf, heel and sole behind. The leg's
  // sections are the panel's rows, the foot's its columns, and round the ankle the rays from the bend's centre (the
  // surface's `ankle`), so the three join without a seam. Each section is wrapped round half a circle by arc length. The
  // flat drawing has the toes to the right on the outer side and to the left on the inner side, as each is seen, and the
  // inner face must be the outer's exact mirror. The 3D sock is a right sock: its outer side faces −x, its toes −z.

  var LEG_DEPTH = 0.85;
  var LEG_ARC = arcTable(LEG_DEPTH);
  /** The height over which the hip's one section becomes two legs, above the crotch, in millimetres. */
  var RISE_MM = 110;
  var BLEND_STEPS = 128;

  function smooth(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }
  /** Where a line crosses the polygon, as sorted pairs: the spans inside it. `axis` 1 is a row at y = v, 0 a column at x = v. */
  function spans(poly, v, axis) {
    var o = 1 - axis, cuts = [];
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[axis] <= v && b[axis] > v) || (b[axis] <= v && a[axis] > v)) cuts.push(a[o] + (v - a[axis]) * (b[o] - a[o]) / (b[axis] - a[axis]));
    }
    cuts.sort(function (p, q) { return p - q; });
    var out = [];
    for (var k = 0; k + 1 < cuts.length; k += 2) out.push([cuts[k], cuts[k + 1]]);
    return out;
  }
  /** Where the ray from `p` along the unit direction `d` crosses the polygon: the distances, nearest first. */
  function rayCuts(poly, p, d) {
    var ts = [];
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length], ex = b[0] - a[0], ey = b[1] - a[1];
      var den = d[0] * ey - d[1] * ex;
      if (Math.abs(den) < 1e-12) continue;
      var ax = a[0] - p[0], ay = a[1] - p[1], t = (ax * ey - ay * ex) / den, u = (ax * d[1] - ay * d[0]) / den;
      if (t > 1e-9 && u >= 0 && u < 1) ts.push(t);
    }
    return ts.sort(function (x, y) { return x - y; });
  }
  /** A memo for a row's or a ray's computed section, bounded so that a long session does not grow it without end. */
  function memo() {
    var m = {}, n = 0;
    return function (key, make) {
      if (!m[key]) { if (++n > 4096) { m = {}; n = 1; } m[key] = make(); }
      return m[key];
    };
  }

  /**
   * A grid over a surface: `lines[i][j]` is the j-th flat point of the i-th section, in the surface's own millimetres,
   * every section with as many points, consecutive sections side by side. The triangles are wound as panelMesh winds
   * them, whichever way the sections run across the flat surface, so their front faces are the garment's outside.
   */
  function gridMesh(ts, at, lines) {
    var positions = [], uvs = [], indices = [], flat = [], n = lines[0].length;
    lines.forEach(function (line) {
      line.forEach(function (q) {
        var p = at(q[0], q[1]);
        positions.push(p[0], p[1], p[2]);
        uvs.push(q[0] / ts.width, 1 - q[1] / ts.height);
        flat.push(q[0], q[1]);
      });
    });
    // panelMesh's cells run +x along a row and +y from row to row; a grid turned the other way is wound the other way.
    var a = lines[0][0], b = lines[0][n - 1], c = lines[lines.length - 1][0];
    var flip = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0;
    for (var r = 0; r < lines.length - 1; r++) {
      for (var k = 0; k < n - 1; k++) {
        var i0 = r * n + k, i1 = i0 + 1, i2 = i0 + n, i3 = i2 + 1;
        if (flip) indices.push(i0, i1, i2, i1, i3, i2); else indices.push(i0, i2, i1, i1, i2, i3);
      }
    }
    return { positions: positions, uvs: uvs, indices: indices, flat: flat, rows: lines.length, cols: n };
  }
  /** Several meshes of one surface as one. */
  function mergeMeshes(list) {
    var out = { positions: [], uvs: [], indices: [], flat: [], parts: [] };
    list.forEach(function (m) {
      var base = out.positions.length / 3;
      out.parts.push({ start: base, rows: m.rows, cols: m.cols });
      Array.prototype.push.apply(out.positions, m.positions);
      Array.prototype.push.apply(out.uvs, m.uvs);
      Array.prototype.push.apply(out.flat, m.flat);
      m.indices.forEach(function (i) { out.indices.push(base + i); });
    });
    return out;
  }
  /** A straight flat line, mapped: `n` + 1 points from a to b. */
  function mappedLine(at, a, b, n) {
    var out = [];
    for (var i = 0; i <= n; i++) out.push(at(a[0] + (b[0] - a[0]) * (i / n), a[1] + (b[1] - a[1]) * (i / n)));
    return out;
  }
  /** Values from a to b, every `step`, ending on b. */
  function steps(a, b, step) {
    var out = [];
    for (var v = a; v < b - 1e-9; v += step) out.push(v);
    out.push(b);
    return out;
  }

  // ── shorts ────────────────────────────────────────────────────────────────

  /** The panel's landmarks: its top and hem, and the crotch, the one vertex below the top lower than both neighbours. */
  function shortsLandmarks(ts) {
    var vs = vertices(ts.outline), poly = flatten(ts.outline), top = minY(poly), crotch = null;
    vs.forEach(function (p, i) {
      var a = vs[(i + vs.length - 1) % vs.length], b = vs[(i + 1) % vs.length];
      if (p[1] > top + 1 && p[1] < a[1] && p[1] < b[1] && (!crotch || p[1] < crotch[1])) crotch = p;
    });
    if (!crotch) throw new Error('garment: the shorts panel ' + ts.id + ' has no crotch between its legs');
    return { poly: poly, top: top, hem: maxY(poly), crotch: [crotch[0], crotch[1]] };
  }
  /** One shorts panel's mapping. `side` is 'front' (faces −z) or 'back' (+z); `yMid` is the height both share. */
  function shortsMapper(ts, side, lm, yMid) {
    var sign = side === 'front' ? 1 : -1, xc = lm.crotch[0], yc = lm.crotch[1], low = lm.hem - 0.25;
    var hipMemo = memo(), legMemo = memo(), blendMemo = memo();
    function hip(y) {
      var yy = Math.min(Math.max(y, lm.top), yc - 0.01);
      return hipMemo(Math.round(yy * 100), function () { return rowExtent(lm.poly, yy) || [0, ts.width]; });
    }
    function legs(y) {
      var yy = Math.min(Math.max(y, yc + 0.01), low);
      return legMemo(Math.round(yy * 100), function () {
        var s = spans(lm.poly, yy, 1);
        if (s.length !== 2) throw new Error('garment: below the crotch a row of the shorts panel ' + ts.id + ' must cross two legs');
        return s;
      });
    }
    /** [X, Z] on the hip's half-ellipse of the row's width. */
    function hipAt(x, e) {
      var w = e[1] - e[0], a = w / ARC.total * MM, th = ARC.at((x - e[0]) / w);
      return [sign * a * Math.cos(th), -sign * DEPTH * a * Math.sin(th)];
    }
    /** [X, Z] on a leg: the flat left span is the outer edge to the inseam, the right span the inseam to the outer edge. */
    function legAt(x, sp) {
      var L = sp[0], R = sp[1], g = (R[0] - L[1]) / 2 * MM;
      if (x <= (L[1] + R[0]) / 2) {
        var wl = L[1] - L[0], a = wl / LEG_ARC.total * MM, th = LEG_ARC.at((x - L[0]) / wl);
        return [sign * (-(a + g) + a * Math.cos(th)), -sign * LEG_DEPTH * a * Math.sin(th)];
      }
      var wr = R[1] - R[0], b = wr / LEG_ARC.total * MM, t2 = LEG_ARC.at((x - R[0]) / wr);
      return [sign * (b + g + b * Math.cos(t2)), -sign * LEG_DEPTH * b * Math.sin(t2)];
    }
    /** The rise: the hip's section and the touching legs', blended by height, re-measured and scaled to the row's width. */
    function blend(y) {
      return blendMemo(Math.round(y * 100), function () {
        var e = hip(y), s = smooth((y - (yc - RISE_MM)) / RISE_MM), sp = [[e[0], xc], [xc, e[1]]], pts = [], cum = [0];
        for (var j = 0; j <= BLEND_STEPS; j++) {
          var x = e[0] + (e[1] - e[0]) * (j / BLEND_STEPS), h = hipAt(x, e), l = legAt(x, sp);
          pts.push([(1 - s) * h[0] + s * l[0], (1 - s) * h[1] + s * l[1]]);
          if (j) cum.push(cum[j - 1] + Math.sqrt(Math.pow(pts[j][0] - pts[j - 1][0], 2) + Math.pow(pts[j][1] - pts[j - 1][1], 2)));
        }
        var k = (e[1] - e[0]) * MM / cum[BLEND_STEPS];
        return { e: e, pts: pts.map(function (p) { return [p[0] * k, p[1] * k]; }), cum: cum.map(function (c) { return c * k; }) };
      });
    }
    function blendAt(x, y) {
      var row = blend(y), target = Math.max(0, Math.min(row.cum[BLEND_STEPS], (x - row.e[0]) * MM)), lo = 0, hi = BLEND_STEPS;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (row.cum[mid] < target) lo = mid; else hi = mid; }
      var span = row.cum[hi] - row.cum[lo], t = span ? (target - row.cum[lo]) / span : 0, a = row.pts[lo], b = row.pts[hi];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    function at(x, y) {
      var xz = y >= yc ? legAt(x, legs(y)) : y <= yc - RISE_MM ? hipAt(x, hip(y)) : blendAt(x, y);
      return [xz[0], (yMid - y) * MM, xz[1]];
    }
    return { at: at, hip: hip, legs: legs, crotch: lm.crotch, top: lm.top, hem: lm.hem };
  }
  /** One shorts panel's mesh: the hip down to the crotch, then each leg. Their shared row has the same points. */
  function shortsMesh(ts, m, o) {
    var yc = m.crotch[1];
    var hip = panelMesh(ts, m.at, m.top, yc, m.hip, o.rowMm, 2 * o.cols);
    var left = panelMesh(ts, m.at, yc, m.hem, function (y) { return m.legs(y)[0]; }, o.rowMm, o.cols);
    var right = panelMesh(ts, m.at, yc, m.hem, function (y) { return m.legs(y)[1]; }, o.rowMm, o.cols);
    return mergeMeshes([hip, left, right]);
  }
  function buildShorts(template, opts) {
    var o = density(opts), front = surfaceOf(template, 'front'), back = surfaceOf(template, 'back');
    if (!front || !back || template.surfaces.length !== 2) throw new Error('garment: shorts need a front and a back, and nothing else');
    var lf = shortsLandmarks(front), lb = shortsLandmarks(back), yMid = (lf.top + lf.hem) / 2;
    var mf = shortsMapper(front, 'front', lf, yMid), mb = shortsMapper(back, 'back', lb, yMid);
    var panels = [
      { surface: 'front', size: { w: front.width, h: front.height }, mesh: shortsMesh(front, mf, o) },
      { surface: 'back', size: { w: back.width, h: back.height }, mesh: shortsMesh(back, mb, o) },
    ];
    var mappers = { front: mf.at, back: mb.at }, cuffs = {}, collar = [];
    [['front', mf], ['back', mb]].forEach(function (pm) {
      var m = pm[1], w = m.hip(m.top), l = m.legs(m.hem);
      collar.push(mappedLine(m.at, [w[0], m.top], [w[1], m.top], 48));
      cuffs[pm[0] + '-l'] = mappedLine(m.at, [l[0][0], m.hem], [l[0][1], m.hem], 24);
      cuffs[pm[0] + '-r'] = mappedLine(m.at, [l[1][0], m.hem], [l[1][1], m.hem], 24);
    });
    return legwear('shorts', template, panels, mappers,
      { front: function (y) { return mf.hip(y); }, back: function (y) { return mb.hip(y); } },
      { front: lf, back: lb }, { collar: collar, cuffs: cuffs });
  }

  // ── socks ─────────────────────────────────────────────────────────────────

  /**
   * A sock face's sections, in the outer side's frame (toes to the right): the leg's rows above the ankle's centre, the
   * foot's columns ahead of it, the rays from it between. A section is its flat centre `c`, its direction `d` from the
   * front (shin, instep) end to the back (calf, heel, sole) end, and its flat width `w`.
   */
  function sockGeometry(ts, mirror) {
    var W = ts.width, poly = flatten(ts.outline, 24).map(function (p) { return mirror ? [W - p[0], p[1]] : p; });
    var P = [mirror ? W - ts.ankle[0] : ts.ankle[0], ts.ankle[1]], top = minY(poly), sole = maxY(poly), toe = -Infinity;
    var tipY = 0;
    poly.forEach(function (p) { if (p[0] > toe) { toe = p[0]; tipY = p[1]; } });
    var rowMemo = memo(), colMemo = memo(), rayMemo = memo();
    function row(y) {
      var yy = Math.min(Math.max(y, top), P[1]);
      return rowMemo(Math.round(yy * 100), function () {
        var e = rowExtent(poly, yy) || [0, W];
        return { c: [(e[0] + e[1]) / 2, yy], d: [-1, 0], w: e[1] - e[0] };
      });
    }
    function col(x) {
      var xx = Math.min(Math.max(x, P[0]), toe);
      return colMemo(Math.round(xx * 100), function () {
        // The last quarter-millimetre closes on the toe's tip, where the two faces meet in a point.
        var cx = Math.min(xx, toe - 0.25), k = xx > cx ? (toe - xx) / 0.25 : 1;
        var s = spans(poly, cx, 0).filter(function (sp) { return sp[1] > P[1]; }), t = s[0][0], b = s[s.length - 1][1];
        return { c: [xx, tipY + ((t + b) / 2 - tipY) * k], d: [0, 1], w: (b - t) * k };
      });
    }
    function ray(th) {
      var tt = Math.min(Math.max(th, 0), Math.PI / 2);
      return rayMemo(Math.round(tt * 1e5), function () {
        var d = [-Math.cos(tt), Math.sin(tt)], cuts = rayCuts(poly, P, d), r0 = cuts[0], r1 = cuts[cuts.length - 1];
        return { c: [P[0] + d[0] * (r0 + r1) / 2, P[1] + d[1] * (r0 + r1) / 2], d: d, w: r1 - r0 };
      });
    }
    /** The section through a flat point (outer frame), and how far along it the point is, 0 at the front end. */
    function locate(x, y) {
      var sec = y <= P[1] ? row(y) : x >= P[0] ? col(x) : ray(Math.atan2(y - P[1], P[0] - x));
      var f = sec.w > 0 ? ((x - sec.c[0]) * sec.d[0] + (y - sec.c[1]) * sec.d[1]) / sec.w + 0.5 : 0.5;
      return { sec: sec, f: Math.max(0, Math.min(1, f)) };
    }
    return { poly: poly, P: P, top: top, sole: sole, toe: toe, tip: [toe, tipY], row: row, col: col, ray: ray, locate: locate };
  }
  /** One sock face's mapping. `side` −1 is the outer face (−x), +1 the inner; `ref` places the flat drawing in 3D. */
  function sockMapper(ts, g, mirror, side, ref) {
    var W = ts.width;
    return function at(x, y) {
      var L = g.locate(mirror ? W - x : x, y), s = L.sec, r = s.w * MM / Math.PI, ph = Math.PI * L.f;
      var cy = (ref[1] - s.c[1]) * MM, cz = -(s.c[0] - ref[0]) * MM, dy = -s.d[1], dz = -s.d[0];
      var k = -Math.cos(ph) * r;
      return [side * Math.sin(ph) * r, cy + k * dy, cz + k * dz];
    };
  }
  /** The sections of a sock face, front end to back end, `cols` + 1 points each: leg rows, ankle rays, foot columns. */
  function sockLines(g, o, mirror, W) {
    var secs = [];
    steps(g.top, g.P[1], o.rowMm).forEach(function (y) { secs.push(g.row(y)); });
    var far = rayCuts(g.poly, g.P, [-Math.SQRT1_2, Math.SQRT1_2]).pop() || 100;
    var n = Math.max(8, Math.ceil((Math.PI / 2) * far / o.rowMm));
    for (var i = 1; i < n; i++) secs.push(g.ray((Math.PI / 2) * (i / n)));
    // Towards the toe the sections narrow quickly, so the last 30 mm are cut four times as finely; the last one is the tip.
    var fine = Math.max(g.P[0], g.toe - 30);
    steps(g.P[0], fine, o.rowMm).concat(steps(fine, g.toe, o.rowMm / 4).slice(1)).forEach(function (x) { secs.push(g.col(x)); });
    return secs.map(function (s) {
      var line = [];
      for (var j = 0; j <= o.cols; j++) {
        var t = j / o.cols - 0.5, x = s.c[0] + s.d[0] * s.w * t, y = s.c[1] + s.d[1] * s.w * t;
        line.push([mirror ? W - x : x, y]);
      }
      return line;
    });
  }
  function buildSocks(template, opts) {
    var o = density(opts), outer = surfaceOf(template, 'outer'), inner = surfaceOf(template, 'inner');
    if (!outer || !inner || template.surfaces.length !== 2) throw new Error('garment: socks need an outer and an inner face, and nothing else');
    if (!outer.ankle || !inner.ankle) throw new Error('garment: each sock face names the centre of its ankle’s bend');
    var go = sockGeometry(outer, false), gi = sockGeometry(inner, true);
    // The two faces are one tube: the inner one must be the outer one's mirror, point for point.
    var same = go.poly.length === gi.poly.length && Math.abs(go.P[0] - gi.P[0]) < 0.01 && Math.abs(go.P[1] - gi.P[1]) < 0.01 &&
      go.poly.every(function (p) { return gi.poly.some(function (q) { return Math.abs(p[0] - q[0]) < 0.01 && Math.abs(p[1] - q[1]) < 0.01; }); });
    if (!same) throw new Error('garment: the inner face of a sock must mirror the outer face exactly');
    var ref = [(Math.min.apply(null, go.poly.map(function (p) { return p[0]; })) + go.toe) / 2, (go.top + go.sole) / 2];
    var mo = sockMapper(outer, go, false, -1, ref), mi = sockMapper(inner, gi, true, 1, ref);
    var panels = [
      { surface: 'outer', size: { w: outer.width, h: outer.height }, mesh: gridMesh(outer, mo, sockLines(go, o, false, outer.width)) },
      { surface: 'inner', size: { w: inner.width, h: inner.height }, mesh: gridMesh(inner, mi, sockLines(gi, o, true, inner.width)) },
    ];
    var mappers = { outer: mo, inner: mi }, collar = [];
    [[outer, go, mo, false], [inner, gi, mi, true]].forEach(function (q) {
      var e = q[1].row(q[1].top), a = q[3] ? q[0].width - e.c[0] - e.w / 2 : e.c[0] - e.w / 2;
      collar.push(mappedLine(q[2], [a, q[1].top], [a + e.w, q[1].top], 48));
    });
    return legwear('socks', template, panels, mappers, null, { outer: { ankle: go.P, top: go.top, sole: go.sole, toe: go.toe, tip: go.tip } },
      { collar: collar, cuffs: {} });
  }

  // ── what every legwear garment returns ─────────────────────────────────────

  /** The cameras of the template's views, each looking straight at the garment, framing it whole. */
  var VIEW_PRESETS = {
    front: { alpha: -Math.PI / 2, beta: 1.42, radius: 1.35 },
    back: { alpha: Math.PI / 2, beta: 1.42, radius: 1.35 },
    outer: { alpha: Math.PI, beta: 1.42, radius: 1.0 },
    inner: { alpha: 0, beta: 1.42, radius: 1.0 },
  };
  /** A unit direction's reach across a box of half-extents h: how far the box extends along it, either way. */
  function reach(u, h) { return Math.abs(u[0]) * h[0] + Math.abs(u[1]) * h[1] + Math.abs(u[2]) * h[2]; }
  function legwear(form, template, panels, mappers, extents, landmarks, trimLines) {
    var b = bounds(panels), half = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2], out = {};
    template.views.forEach(function (v) {
      var p = VIEW_PRESETS[v.id];
      if (!p) throw new Error('garment: no camera for the view ' + v.id);
      var fwd = [-Math.cos(p.alpha), 0, -Math.sin(p.alpha)], right = [fwd[2], 0, -fwd[0]];
      var fit = { hw: reach(right, half), hh: half[1], hd: reach(fwd, half), fill: 0.86 };
      out[v.id] = { alpha: p.alpha, beta: p.beta, radius: Math.max(p.radius, fitRadius(fit, DEFAULT_FOV, 1)), target: b.center.slice(), fit: fit };
    });
    var home = template.views[0].id, hp = VIEW_PRESETS[home];
    return {
      form: form, home: home, across: [Math.round(-Math.sin(hp.alpha)), 0, Math.round(Math.cos(hp.alpha))],
      units: 'm', mmToUnits: MM, panels: panels, mappers: mappers, extents: extents, landmarks: landmarks,
      presets: out, trims: trimLines, seams: seams(template, mappers), bounds: b,
    };
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
  /** pd-3d.js's vertical field of view, in radians: a preset's default distance is chosen for it. */
  var DEFAULT_FOV = 0.6;
  /**
   * The presets for a built garment: the front, the back and the collar look at its centre; each side looks at the
   * middle of the outside of its sleeve, from outside and a little above, so the sleeve's artwork is read face on.
   * Each preset but the collar's close-up also carries `fit`: the half-extents of what it must show, so that `frame`
   * can choose its distance for any canvas.
   */
  function presets(sleeveCentres, panels) {
    var b = bounds(panels), out = {};
    var whole = { hw: (b.max[0] - b.min[0]) / 2, hh: (b.max[1] - b.min[1]) / 2, hd: (b.max[2] - b.min[2]) / 2, fill: 0.86 };
    Object.keys(PRESETS).forEach(function (k) {
      var p = PRESETS[k], c = sleeveCentres[k], fit = null;
      if (k === 'front' || k === 'back') fit = whole;
      else if (c) {
        // A side frames its own sleeve: the sphere round the sleeve's centre that holds every one of its vertices.
        var m = panels.filter(function (x) { return x.surface === k; })[0].mesh, r = 0;
        for (var i = 0; i < m.positions.length; i += 3) r = Math.max(r, Math.sqrt(Math.pow(m.positions[i] - c[0], 2) + Math.pow(m.positions[i + 1] - c[1], 2) + Math.pow(m.positions[i + 2] - c[2], 2)));
        fit = { hw: r, hh: r, hd: r, fill: 0.8 };
      }
      // The default distance (used only when no canvas shape is known; pd-3d.js frames for the real canvas) shows what
      // the preset frames on a square canvas, and is never closer than the reviewed static distance.
      var radius = fit ? Math.max(p.radius, fitRadius(fit, DEFAULT_FOV, 1)) : p.radius;
      out[k] = { alpha: p.alpha, beta: p.beta, radius: radius, target: c ? c.slice() : k === 'collar' ? [0, 0, 0] : b.center.slice(), fit: fit };
    });
    return out;
  }
  /**
   * The distance at which a box of half-extents hw (across the view), hh (up) and hd (towards the camera) is seen whole,
   * its larger relative side filling `fill` of the canvas: its nearest face, at distance r − hd, must hold hh within
   * the vertical half-angle and hw within the horizontal one. `fov` is vertical; `aspect` is width / height.
   */
  function fitRadius(fit, fov, aspect) {
    var tv = Math.tan(fov / 2), th = tv * aspect;
    return Math.max(fit.hh / (tv * fit.fill), fit.hw / (th * fit.fill)) + fit.hd;
  }
  /** A preset placed for a canvas: its distance fitted to what it shows, or as it is when it has nothing to fit. */
  function frame(p, aspect, fov, fit) {
    var f = fit || p.fit;
    if (!f || !(aspect > 0) || !(fov > 0)) return p;
    return { alpha: p.alpha, beta: p.beta, radius: fitRadius(f, fov, aspect), target: (p.target || [0, 0, 0]).slice(), fit: f };
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
    MM: MM, DEPTH: DEPTH, LEG_DEPTH: LEG_DEPTH, RISE_MM: RISE_MM, SLEEVE_DEG: SLEEVE_DEG, PRESETS: PRESETS, VIEW_PRESETS: VIEW_PRESETS,
    build: build, flatten: flatten, rowExtent: rowExtent, spans: spans, thetaAt: thetaAt, arcTotal: ARC.total, legArcTotal: LEG_ARC.total,
    outward: outward, eye: eye, screenRight: screenRight, facing: facing, frame: frame, fitRadius: fitRadius,
  });
}));

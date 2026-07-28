/* ════════════════════════════════════════════════════════════════════════════
   Familista — AI Pitch Registration Engine (Phase 4 foundation)
   ---------------------------------------------------------------------------
   Automatic pitch-line detection + per-frame homography, built on OpenCV.js
   (vendored at /vendor/opencv.js). Pipeline:
     1. HSV green mask → the pitch region (excludes goal net, boards, crowd),
     2. white mask ∩ pitch region → line candidates ON the grass,
     3. HoughLinesP → clean line segments,
     4. line-based homography registration: project a pitch line-model with the
        current H, match detected segments to model lines, refine H (DLT LS),
        iterate — initialized from the previous frame for temporal continuity.
   Output = per-frame pitch→image homography (and landmark positions) that feed
   the telestration engine's teCamKeys interface → the Babylon camera updates
   automatically. Foundation first: detection + registration; accuracy improves
   with tuning / a trained model, but the pipeline is real (no faking).
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var AI = {}; var _loading = false, _queue = [];

  AI.ready = function () { return !!(window.cv && window.cv.Mat && window.cv.HoughLinesP); };
  AI.load = function (cb) {
    if (AI.ready()) { cb(true); return; }
    _queue.push(cb); if (_loading) return; _loading = true;
    var s = document.createElement('script'); s.src = '/vendor/opencv.js'; s.async = true;
    s.onload = function () {
      var t0 = Date.now();
      (function poll() {
        if (AI.ready()) { _loading = false; var q = _queue.slice(); _queue = []; q.forEach(function (f) { try { f(true); } catch (e) {} }); return; }
        if (window.cv && !window.cv.Mat && typeof window.cv === 'object') { try { window.cv.onRuntimeInitialized = poll; } catch (e) {} }
        if (Date.now() - t0 > 30000) { _loading = false; var q2 = _queue.slice(); _queue = []; q2.forEach(function (f) { try { f(AI.ready()); } catch (e) {} }); return; }
        setTimeout(poll, 120);
      })();
    };
    s.onerror = function () { _loading = false; var q = _queue.slice(); _queue = []; q.forEach(function (f) { try { f(false); } catch (e) {} }); };
    document.head.appendChild(s);
  };

  // Right-goal attacking half pitch model (px along length 0..100, goal px=100; py width 0..100)
  var MODEL = [
    { id: 'goal', a: [100, 20.4], b: [100, 79.6], kind: 'v' },
    { id: 'pa_front', a: [84.3, 20.4], b: [84.3, 79.6], kind: 'v' },
    { id: 'pa_top', a: [84.3, 20.4], b: [100, 20.4], kind: 'h' },
    { id: 'pa_bot', a: [84.3, 79.6], b: [100, 79.6], kind: 'h' },
    { id: 'ga_front', a: [94.8, 36.5], b: [94.8, 63.5], kind: 'v' },
    { id: 'ga_top', a: [94.8, 36.5], b: [100, 36.5], kind: 'h' },
    { id: 'ga_bot', a: [94.8, 63.5], b: [100, 63.5], kind: 'h' }
  ];
  AI.MODEL = MODEL;

  function applyH(h, x, y) { var d = h[6] * x + h[7] * y + h[8]; if (Math.abs(d) < 1e-9) d = 1e-9; return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d]; }
  AI.applyH = applyH;
  function gauss(M0, b0) { var n = b0.length, M = M0.map(function (r, i) { return r.slice().concat([b0[i]]); }), i, j, k; for (i = 0; i < n; i++) { var p = i; for (j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j; var t = M[i]; M[i] = M[p]; M[p] = t; if (Math.abs(M[i][i]) < 1e-12) return null; for (j = i + 1; j < n; j++) { var f = M[j][i] / M[i][i]; for (k = i; k <= n; k++) M[j][k] -= f * M[i][k]; } } var x = new Array(n); for (i = n - 1; i >= 0; i--) { var s = M[i][n]; for (j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; } return x; }
  function solveHLS(src, dst) { var n = src.length; if (n < 4) return null; var A = [], b = [], i; for (i = 0; i < n; i++) { var x = src[i][0], y = src[i][1], X = dst[i][0], Y = dst[i][1]; A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X); A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y); } var N = 8, ATA = [], ATb = new Array(N).fill(0), r, c, kk; for (r = 0; r < N; r++) ATA.push(new Array(N).fill(0)); for (kk = 0; kk < A.length; kk++) { var row = A[kk], bk = b[kk]; for (r = 0; r < N; r++) { ATb[r] += row[r] * bk; for (c = 0; c < N; c++) ATA[r][c] += row[r] * row[c]; } } var h = gauss(ATA, ATb); if (!h) return null; h.push(1); return h; }
  AI.solveHLS = solveHLS;

  // ── Detection: green pitch → white lines on pitch → Hough segments ──
  AI.detect = function (canvas, opts) {
    opts = opts || {}; var cv = window.cv; if (!cv || !cv.Mat) return null;
    var src = cv.imread(canvas); var hsv = new cv.Mat(); var rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    var green = new cv.Mat(), white = new cv.Mat(), lines = new cv.Mat();
    var gl = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [32, 30, 30, 0]);
    var gh = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [95, 255, 255, 255]);
    cv.inRange(hsv, gl, gh, green);
    var kBig = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(21, 21));
    cv.morphologyEx(green, green, cv.MORPH_CLOSE, kBig);
    var pitch = new cv.Mat(); cv.dilate(green, pitch, kBig);
    var wl = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 150, 0]);
    var wh = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 65, 255, 255]);
    cv.inRange(hsv, wl, wh, white);
    cv.bitwise_and(white, pitch, lines);
    var kSm = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    cv.morphologyEx(lines, lines, cv.MORPH_CLOSE, kSm);
    var lm = new cv.Mat();
    cv.HoughLinesP(lines, lm, 1, Math.PI / 180, opts.thresh || 28, opts.minLen || 22, opts.maxGap || 10);
    var segs = []; var data = lm.data32S; for (var i = 0; i < lm.rows; i++) segs.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]]);
    var out = { segs: segs, W: src.cols, H: src.rows };
    if (opts.previews) { out.pitchMaskDataURL = matToDataURL(cv, green); out.lineMaskDataURL = matToDataURL(cv, lines); }
    [src, hsv, rgb, green, white, lines, pitch, gl, gh, wl, wh, kBig, kSm, lm].forEach(function (m) { try { m.delete(); } catch (e) {} });
    return out;
  };
  function matToDataURL(cv, mat) { var tmp = document.createElement('canvas'); var rgba = new cv.Mat(); cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA); cv.imshow(tmp, rgba); rgba.delete(); return tmp.toDataURL('image/jpeg', 0.7); }

  // ── Registration: refine H (pitch→normalized image) against detected segments ──
  function segAngle(s) { return Math.atan2(s[3] - s[1], s[2] - s[0]); }
  function angDiff(a, b) { var d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); }
  function ptSegDist(px, py, s) { var x1 = s[0], y1 = s[1], x2 = s[2], y2 = s[3]; var dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1; var t = ((px - x1) * dx + (py - y1) * dy) / L2; t = Math.max(0, Math.min(1, t)); var cx = x1 + t * dx, cy = y1 + t * dy; return { d: Math.hypot(px - cx, py - cy), x: cx, y: cy }; }
  // Perpendicular foot on the INFINITE line through s (no clamp) — correct point-on-line target.
  function footOnLine(px, py, s) { var x1 = s[0], y1 = s[1], x2 = s[2], y2 = s[3]; var dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1; var t = ((px - x1) * dx + (py - y1) * dy) / L2; var cx = x1 + t * dx, cy = y1 + t * dy; return { d: Math.hypot(px - cx, py - cy), x: cx, y: cy }; }
  // Build correspondences (model point ↔ foot on the single best-matching detected line) for the current H.
  function correspondences(segs, hpix, angTol, distTol, perLine) {
    var src = [], dst = [], cost = 0;
    for (var li = 0; li < MODEL.length; li++) {
      var seg = MODEL[li]; var pa = applyH(hpix, seg.a[0], seg.a[1]), pb = applyH(hpix, seg.b[0], seg.b[1]);
      var mAng = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]), mmx = (pa[0] + pb[0]) / 2, mmy = (pa[1] + pb[1]) / 2;
      var best = null, bestD = distTol;
      for (var si = 0; si < segs.length; si++) { var s = segs[si]; if (angDiff(segAngle(s), mAng) > angTol) continue; var f = footOnLine(mmx, mmy, s); if (f.d < bestD) { bestD = f.d; best = s; } }
      if (!best) continue;
      for (var k = 0; k <= perLine; k++) { var t = k / perLine; var mpx = seg.a[0] + (seg.b[0] - seg.a[0]) * t, mpy = seg.a[1] + (seg.b[1] - seg.a[1]) * t; var proj = applyH(hpix, mpx, mpy); var foot = footOnLine(proj[0], proj[1], best); src.push([mpx, mpy]); dst.push([foot.x, foot.y]); cost += foot.d; }
    }
    return { src: src, dst: dst, cost: src.length ? cost / src.length : 1e9, n: src.length };
  }
  // hNorm: pitch(0..100)→normalized image(0..1). Guarded ICP-to-lines: never returns a worse fit than the input.
  AI.refine = function (segs, W, H, hNorm, opts) {
    opts = opts || {}; var iters = opts.iters || 6, angTol = (opts.angTol || 12) * Math.PI / 180, distTol = opts.distTol || 26, perLine = opts.perLine || 8;
    function toPix(hn) { return [hn[0] * W, hn[1] * W, hn[2] * W, hn[3] * H, hn[4] * H, hn[5] * H, hn[6], hn[7], hn[8]]; }
    function toNorm(hp) { return [hp[0] / W, hp[1] / W, hp[2] / W, hp[3] / H, hp[4] / H, hp[5] / H, hp[6], hp[7], hp[8]]; }
    var hpix = toPix(hNorm);
    var base = correspondences(segs, hpix, angTol, distTol, perLine);
    var bestH = hpix, bestCost = base.cost, bestN = base.n;
    for (var it = 0; it < iters; it++) {
      var c = correspondences(segs, hpix, angTol, distTol, perLine); if (c.n < 8) break;
      var hnew = solveHLS(c.src, c.dst); if (!hnew) break;
      var cn = correspondences(segs, hnew, angTol, distTol, perLine);
      if (cn.cost < bestCost) { bestCost = cn.cost; bestH = hnew; bestN = cn.n; hpix = hnew; } else { break; } // guard: stop if no improvement
    }
    return { h: toNorm(bestH), inliers: bestN, cost: bestCost };
  };

  AI.registerFrame = function (canvas, hInit, opts) {
    var det = AI.detect(canvas, opts); if (!det) return null; var r = AI.refine(det.segs, det.W, det.H, hInit, opts);
    return { h: r.h, inliers: r.inliers, nsegs: det.segs.length };
  };
  AI.landmarks = function (h, pitchPts) { return pitchPts.map(function (p) { var q = applyH(h, p.px, p.py); return { ix: q[0], iy: q[1] }; }); };

  window.TE_PitchAI = AI;
})();

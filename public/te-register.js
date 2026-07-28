/* ════════════════════════════════════════════════════════════════════════════
   Familista — Telestration pitch registration (real line-based homography refine)
   ---------------------------------------------------------------------------
   Given a video frame + an INITIAL pitch→image homography (from manual anchor /
   interpolated keyframes), snap the homography onto the real white pitch lines:
     1. build a white-line response image (top-hat on luminance + whiteness gate),
     2. project a known pitch line-model into the image with the current H,
     3. for sample points along each projected line, search perpendicular for the
        nearest strong line response → line-point correspondences,
     4. re-solve the homography (overdetermined DLT, normal equations),
     5. iterate.
   This is genuine per-frame registration (no grass optical flow, which fails on a
   low-texture pitch). It reduces drift by locking graphics to the painted lines.
   Output feeds the engine's existing teCamKeys interface (per-frame landmarks).
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var R = {};

  // Right-goal attacking half (px along length 0..100, goal at px=100; py width 0..100).
  // Pitch 105×68 → penalty area px 84.3..100, py 20.4..79.6; 6-yд box px 94.8..100, py 36.5..63.5.
  var MODEL = [
    { a: [100, 20.4], b: [100, 79.6] },   // goal line (penalty-area portion)
    { a: [84.3, 20.4], b: [84.3, 79.6] },  // penalty area front
    { a: [84.3, 20.4], b: [100, 20.4] },   // penalty area top
    { a: [84.3, 79.6], b: [100, 79.6] },   // penalty area bottom
    { a: [94.8, 36.5], b: [94.8, 63.5] },  // 6-yard front
    { a: [94.8, 36.5], b: [100, 36.5] },   // 6-yard top
    { a: [94.8, 63.5], b: [100, 63.5] }    // 6-yard bottom
  ];

  function applyH(h, x, y) { var d = h[6] * x + h[7] * y + h[8]; if (Math.abs(d) < 1e-9) d = 1e-9; return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d]; }

  // Overdetermined homography src(px,py)→dst(px,py) via normalized DLT + normal equations.
  function solveHLS(src, dst) {
    var n = src.length; if (n < 4) return null;
    var A = [], b = [], i;
    for (i = 0; i < n; i++) {
      var x = src[i][0], y = src[i][1], X = dst[i][0], Y = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
    }
    // normal equations: (A^T A) h = A^T b  (8×8)
    var N = 8, ATA = [], ATb = new Array(N).fill(0), r, c, k;
    for (r = 0; r < N; r++) { ATA.push(new Array(N).fill(0)); }
    for (k = 0; k < A.length; k++) {
      var row = A[k], bk = b[k];
      for (r = 0; r < N; r++) { ATb[r] += row[r] * bk; for (c = 0; c < N; c++) ATA[r][c] += row[r] * row[c]; }
    }
    var h = gauss(ATA, ATb); if (!h) return null; h.push(1); return h;
  }
  function gauss(M0, b0) {
    var n = b0.length, M = M0.map(function (r, i) { return r.slice().concat([b0[i]]); }), i, j, k;
    for (i = 0; i < n; i++) {
      var p = i; for (j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
      var t = M[i]; M[i] = M[p]; M[p] = t; if (Math.abs(M[i][i]) < 1e-12) return null;
      for (j = i + 1; j < n; j++) { var f = M[j][i] / M[i][i]; for (k = i; k <= n; k++) M[j][k] -= f * M[i][k]; }
    }
    var x = new Array(n); for (i = n - 1; i >= 0; i--) { var s = M[i][n]; for (j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
    return x;
  }

  // White-line response for an ImageData: top-hat (lum - local mean) gated by whiteness.
  function lineResponse(img, W, H) {
    var d = img.data, lum = new Float32Array(W * H), white = new Uint8Array(W * H), i, n = W * H;
    for (i = 0; i < n; i++) { var r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2]; lum[i] = 0.3 * r + 0.59 * g + 0.11 * b; white[i] = (Math.min(r, g, b) > 110 && (r + g + b) > 420) ? 1 : 0; }
    // integral image for box-mean
    var integ = new Float64Array((W + 1) * (H + 1)), x, y;
    for (y = 0; y < H; y++) { var rs = 0; for (x = 0; x < W; x++) { rs += lum[y * W + x]; integ[(y + 1) * (W + 1) + (x + 1)] = integ[y * (W + 1) + (x + 1)] + rs; } }
    function mean(x0, y0, x1, y1) { x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1); var a = (x1 - x0) * (y1 - y0); if (a <= 0) return 0; var s = integ[y1 * (W + 1) + x1] - integ[y0 * (W + 1) + x1] - integ[y1 * (W + 1) + x0] + integ[y0 * (W + 1) + x0]; return s / a; }
    var resp = new Float32Array(n), rad = 7;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) { i = y * W + x; if (!white[i]) { resp[i] = 0; continue; } var m = mean(x - rad, y - rad, x + rad, y + rad); var v = lum[i] - m - 12; resp[i] = v > 0 ? v : 0; }
    return resp;
  }

  // Refine a pitch→image(normalized 0..1) homography against one frame's ImageData.
  R.refine = function (img, W, H, hNorm, opts) {
    opts = opts || {}; var iters = opts.iters || 3, search = opts.search || 10, perLine = opts.perLine || 9, minResp = opts.minResp || 6;
    var resp = lineResponse(img, W, H);
    // work in pixel space: hpix maps pitch→pixel
    var hpix = hNorm.slice(); // convert: pixel = norm * [W,H]; fold scale into rows 0..5 and 3..5
    hpix = [hNorm[0] * W, hNorm[1] * W, hNorm[2] * W, hNorm[3] * H, hNorm[4] * H, hNorm[5] * H, hNorm[6], hNorm[7], hNorm[8]];
    var used = 0;
    for (var it = 0; it < iters; it++) {
      var src = [], dst = [];
      for (var li = 0; li < MODEL.length; li++) {
        var seg = MODEL[li];
        for (var s = 0; s <= perLine; s++) {
          var f = s / perLine; var mpx = seg.a[0] + (seg.b[0] - seg.a[0]) * f, mpy = seg.a[1] + (seg.b[1] - seg.a[1]) * f;
          var p = applyH(hpix, mpx, mpy); var px = p[0], py = p[1]; if (px < 2 || px > W - 2 || py < 2 || py > H - 2) continue;
          // image direction of the line at this point
          var pa = applyH(hpix, seg.a[0], seg.a[1]), pb = applyH(hpix, seg.b[0], seg.b[1]);
          var dx = pb[0] - pa[0], dy = pb[1] - pa[1], dl = Math.hypot(dx, dy) || 1; var nx = -dy / dl, ny = dx / dl;
          var best = -1, bestS = 0;
          for (var q = -search; q <= search; q++) { var sx = Math.round(px + nx * q), sy = Math.round(py + ny * q); if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue; var rv = resp[sy * W + sx]; if (rv > best) { best = rv; bestS = q; } }
          if (best >= minResp) { src.push([mpx, mpy]); dst.push([px + nx * bestS, py + ny * bestS]); }
        }
      }
      used = src.length; if (src.length < 6) break; // not enough line evidence → keep current
      var hnew = solveHLS(src, dst); if (!hnew) break; hpix = hnew;
    }
    // back to normalized
    var hn = [hpix[0] / W, hpix[1] / W, hpix[2] / W, hpix[3] / H, hpix[4] / H, hpix[5] / H, hpix[6], hpix[7], hpix[8]];
    return { h: hn, evidence: used };
  };

  // Convenience: refine and return the image positions (0..1) of given pitch landmarks.
  R.landmarks = function (img, W, H, hNorm, pitchPts, opts) {
    var r = R.refine(img, W, H, hNorm, opts); var out = pitchPts.map(function (p) { var q = applyH(r.h, p.px, p.py); return { ix: q[0], iy: q[1] }; });
    return { img: out, h: r.h, evidence: r.evidence };
  };

  R.MODEL = MODEL; R.applyH = applyH; R.solveHLS = solveHLS;
  window.TE_Register = R;
})();

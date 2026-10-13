/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN SYSTEM CONTROL — SPECIMEN LAB — Stage 3.2.3 M2 / S1 — View maths

   Pure, deterministic arithmetic for the Lab's zoom: no DOM, no state, no time.
   Every input is validated and clamped, so a value that is not a finite number can
   never reach the stylesheet: what comes out is always a number inside the limits,
   and the caller applies it through the CSSOM.

   Loaded by design-system.js before lab.js (a `pre` script of the lazy section),
   and required directly by the Jest suite.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root) {
  'use strict';

  var MIN = 0.25;
  var MAX = 2;
  // The ladder Zoom in / Zoom out walk. 100% is on it, and so are both limits.
  var STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  var EPS = 1e-6;

  function finite(n) { return typeof n === 'number' && isFinite(n); }
  function round2(n) { return Math.round(n * 100) / 100; }

  /** Any value in, a scale between MIN and MAX out (two decimals). Not a finite number: 100%. */
  function clamp(s) {
    if (!finite(s)) return 1;
    return round2(Math.min(MAX, Math.max(MIN, s)));
  }

  /** The next step above `s`, or MAX. */
  function zoomIn(s) {
    var v = clamp(s);
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i] > v + EPS) return STEPS[i];
    return MAX;
  }

  /** The next step below `s`, or MIN. */
  function zoomOut(s) {
    var v = clamp(s);
    for (var i = STEPS.length - 1; i >= 0; i--) if (STEPS[i] < v - EPS) return STEPS[i];
    return MIN;
  }

  /**
   * The largest scale at which content of contentW × contentH fits in availW × availH,
   * never above 100% (fit only ever shrinks) and never below MIN. Rounded DOWN to two
   * decimals so the result really fits. Any size that is not a positive finite number: 100%.
   */
  function fit(availW, availH, contentW, contentH) {
    var all = [availW, availH, contentW, contentH];
    for (var i = 0; i < all.length; i++) if (!finite(all[i]) || all[i] <= 0) return 1;
    var r = Math.min(1, availW / contentW, availH / contentH);
    return Math.max(MIN, Math.floor(r * 100 + EPS) / 100);
  }

  /** Whole percent for a scale, for a label. */
  function percent(s) { return Math.round(clamp(s) * 100); }

  /** The canvas scales from its inline-start top corner, so it grows away from the edge it is aligned to. */
  function origin(dir) { return dir === 'rtl' ? 'top right' : 'top left'; }

  /** The frame's size for a canvas of w × h at scale s: whole pixels, never negative. */
  function frameSize(w, h, s) {
    var k = clamp(s);
    return { width: finite(w) && w > 0 ? Math.ceil(w * k) : 0, height: finite(h) && h > 0 ? Math.ceil(h * k) : 0 };
  }

  /** The transform for a scale: none at exactly 100%, so the unzoomed stage is the M1 stage. */
  function transform(s) {
    var k = clamp(s);
    return k === 1 ? 'none' : 'scale(' + k + ')';
  }

  var api = {
    MIN: MIN, MAX: MAX, STEPS: STEPS.slice(),
    clamp: clamp, zoomIn: zoomIn, zoomOut: zoomOut, fit: fit,
    percent: percent, origin: origin, frameSize: frameSize, transform: transform,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaLabView = api;
}(typeof window !== 'undefined' ? window : this));

/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN SYSTEM CONTROL — SPECIMEN LAB — Stage 3.2.3 M2 / S1–S2 — View maths

   Pure, deterministic arithmetic for the Lab's zoom (S1) and width (S2): no DOM, no
   state, no time.
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

  // ── width (M2 / S2) ──────────────────────────────────────────────────────
  //
  // A width is the width of the component's content container, in whole CSS pixels.
  // It is a width simulation, not a device: the browser window, its media queries,
  // its viewport units and its pixel ratio stay what they are.

  var WIDTH_MIN = 320;
  var WIDTH_MAX = 1600;
  var PRESETS = { desktop: 1280, tablet: 834, mobile: 390 };
  // Digits, optionally a decimal part, optionally surrounded by spaces. No sign, no
  // exponent, no unit, no hex: anything else is not a width.
  var WIDTH_RE = /^\s*\d{1,5}(\.\d{1,4})?\s*$/;

  /** A finite, positive number in, a whole width between WIDTH_MIN and WIDTH_MAX out. Anything else: null. */
  function clampWidth(n) {
    if (!finite(n) || n <= 0) return null;
    return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(n)));
  }

  /**
   * What a reader typed, read strictly. Returns null when it is not a width at all, otherwise
   * { value, clamped } where value is inside the limits and clamped says it had to be moved there.
   */
  function parseWidth(raw) {
    var n;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string' && WIDTH_RE.test(raw)) n = parseFloat(raw);
    else return null;
    var v = clampWidth(n);
    if (v === null) return null;
    return { value: v, clamped: v !== Math.round(n) };
  }

  /**
   * How far content reaches past the box it is laid out in, in whole pixels. Under 1px is
   * sub-pixel rounding and reads 0. Either size not a finite number (or the box empty): null,
   * which the Lab shows as "—", never as 0.
   */
  function overflowPx(contentW, boxW) {
    if (!finite(contentW) || !finite(boxW) || boxW <= 0 || contentW < 0) return null;
    var d = contentW - boxW;
    return d > 1 ? Math.round(d) : 0;
  }

  /** One condition list of a media query (the part between commas) at a window width. */
  function mqPart(part, w) {
    var p = part.trim().toLowerCase().replace(/^only\s+/, '');
    if (!p || /^not\b/.test(p)) return null;
    p = p.replace(/^(all|screen)(\s+and\s+|$)/, '');
    if (!p) return true;
    var conds = p.split(/\s+and\s+/), unknown = false;
    for (var i = 0; i < conds.length; i++) {
      var m = /^\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(conds[i].trim());
      if (!m) { unknown = true; continue; }
      var n = parseFloat(m[2]);
      if (m[1] === 'max' ? w > n : w < n) return false;
    }
    return unknown ? null : true;
  }

  /**
   * Would this recorded media query match a browser window `w` pixels wide? Only plain
   * min-width and max-width in px are judged; anything else (height, orientation, em, hover,
   * a feature this reads no further than its name) makes the answer null: not knowable from a
   * width alone. A list matches when any of its parts does. This reads text; it never asks the
   * browser, and nothing is executed or applied.
   */
  function mqAt(query, w) {
    if (typeof query !== 'string' || !finite(w)) return null;
    var s = query.trim();
    if (/^@/.test(s)) {
      if (!/^@media\b/i.test(s)) return null;
      s = s.replace(/^@media\s*/i, '');
    }
    if (!s) return null;
    var parts = s.split(','), unknown = false;
    for (var i = 0; i < parts.length; i++) {
      var r = mqPart(parts[i], w);
      if (r === true) return true;
      if (r === null) unknown = true;
    }
    return unknown ? null : false;
  }

  var api = {
    MIN: MIN, MAX: MAX, STEPS: STEPS.slice(),
    clamp: clamp, zoomIn: zoomIn, zoomOut: zoomOut, fit: fit,
    percent: percent, origin: origin, frameSize: frameSize, transform: transform,
    WIDTH_MIN: WIDTH_MIN, WIDTH_MAX: WIDTH_MAX, PRESETS: { desktop: PRESETS.desktop, tablet: PRESETS.tablet, mobile: PRESETS.mobile },
    clampWidth: clampWidth, parseWidth: parseWidth, overflowPx: overflowPx, mqAt: mqAt,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaLabView = api;
}(typeof window !== 'undefined' ? window : this));

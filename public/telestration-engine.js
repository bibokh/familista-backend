/* ════════════════════════════════════════════════════════════════════════════
   Familista — Telestration Engine (Phase 1 foundation)
   ---------------------------------------------------------------------------
   An isolated, reusable GPU/WebGL telestration engine built on Babylon.js
   (already vendored at /vendor/babylon.js). It is NOT coupled to any page,
   formation or renderer. Tactical objects are stored in PITCH-SPACE
   coordinates (x,y in 0..100) and projected to the ground plane, so the same
   object works in a top-down (orthographic) or perspective ("on the grass")
   camera and — later — over calibrated match video.

   Public surface (window.FamilistaTE):
     PitchCoordinateSystem, CameraProjection, ObjectRegistry, AnimationTimeline,
     TelestrationEngine, primitives {TacticalArrow, TacticalZone, PlayerRing,
     TacticalLabel}, easings, loadBabylon(cb), openTest().

   Phase-1 scope only: 4 premium primitives + ortho/perspective projection +
   deterministic timeline + a self-contained test panel. No CV, no tracking,
   no calibration, no changes to existing features.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var TE = {};

  /* ── Babylon lazy loader (reuses the already-vendored engine) ───────────── */
  var _blLoading = false, _blQueue = [];
  TE.loadBabylon = function (cb) {
    if (window.BABYLON) { cb(true); return; }
    _blQueue.push(cb); if (_blLoading) return; _blLoading = true;
    var s = document.createElement('script'); s.src = '/vendor/babylon.js'; s.async = true;
    s.onload = function () { _blLoading = false; var q = _blQueue.slice(); _blQueue = []; q.forEach(function (f) { try { f(!!window.BABYLON); } catch (e) {} }); };
    s.onerror = function () { _blLoading = false; var q = _blQueue.slice(); _blQueue = []; q.forEach(function (f) { try { f(false); } catch (e) {} }); };
    document.head.appendChild(s);
  };

  /* ── Easing functions (deterministic) ───────────────────────────────────── */
  var E = TE.easings = {
    linear: function (t) { return t; },
    easeInQuad: function (t) { return t * t; },
    easeOutQuad: function (t) { return 1 - (1 - t) * (1 - t); },
    easeInOutQuad: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    easeOutCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
    easeInOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  };
  function ease(name, t) { var f = E[name] || E.easeInOutCubic; return f(Math.max(0, Math.min(1, t))); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* ── Universal pitch-space coordinate system ────────────────────────────── */
  // Pitch coords: x,y ∈ [0,100]. World: XZ ground plane, +Y up, metres (105×68).
  function PitchCoordinateSystem(opts) {
    opts = opts || {};
    this.bounds = { x: opts.x || 100, y: opts.y || 100 };
    this.LX = opts.LX || 105; this.LZ = opts.LZ || 68;
  }
  PitchCoordinateSystem.prototype.setPitchBounds = function (b) { if (b) { this.bounds.x = b.x || this.bounds.x; this.bounds.y = b.y || this.bounds.y; } };
  PitchCoordinateSystem.prototype.pitchToWorld = function (x, y, yUp) {
    return new BABYLON.Vector3((x / this.bounds.x - 0.5) * this.LX, yUp || 0, (y / this.bounds.y - 0.5) * this.LZ);
  };
  PitchCoordinateSystem.prototype.metresPerUnitX = function () { return this.LX / this.bounds.x; };
  PitchCoordinateSystem.prototype.worldToScreen = function (v, scene, engine) {
    var vp = scene.activeCamera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    return BABYLON.Vector3.Project(v, BABYLON.Matrix.Identity(), scene.getTransformMatrix(), vp);
  };
  PitchCoordinateSystem.prototype.screenToPitch = function (px, py, scene) {
    var ray = scene.createPickingRay(px, py, BABYLON.Matrix.Identity(), scene.activeCamera);
    var d = ray.direction; if (Math.abs(d.y) < 1e-6) return null;
    var t = -ray.origin.y / d.y; if (t < 0) return null;
    var wx = ray.origin.x + d.x * t, wz = ray.origin.z + d.z * t;
    return { x: (wx / this.LX + 0.5) * this.bounds.x, y: (wz / this.LZ + 0.5) * this.bounds.y };
  };
  TE.PitchCoordinateSystem = PitchCoordinateSystem;

  /* ── Camera projection layer (ortho tactical / perspective pitch) ───────── */
  var MODES = { ORTHOGRAPHIC_TACTICAL: 'ORTHOGRAPHIC_TACTICAL', PERSPECTIVE_PITCH: 'PERSPECTIVE_PITCH' };
  function CameraProjection(scene, coords) {
    this.scene = scene; this.coords = coords;
    var cam = new BABYLON.ArcRotateCamera('te-cam', -Math.PI / 2, 0.85, 150, BABYLON.Vector3.Zero(), scene);
    cam.minZ = 0.1; cam.maxZ = 2000; cam.fov = 0.62; cam.lowerBetaLimit = 0.01; cam.upperBetaLimit = 1.45;
    this.camera = cam; this.mode = null; this.setProjectionMode(MODES.PERSPECTIVE_PITCH);
  }
  CameraProjection.prototype.setProjectionMode = function (mode) {
    var cam = this.camera, LX = this.coords.LX, LZ = this.coords.LZ;
    if (mode === MODES.ORTHOGRAPHIC_TACTICAL) {
      cam.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA; cam.beta = 0.02; cam.alpha = -Math.PI / 2; cam.radius = 220;
      this._applyOrtho();
    } else {
      cam.mode = BABYLON.Camera.PERSPECTIVE_CAMERA; cam.beta = 0.86; cam.alpha = -Math.PI / 2; cam.radius = 150;
    }
    this.mode = mode; return mode;
  };
  CameraProjection.prototype._applyOrtho = function () {
    var cam = this.camera, eng = this.scene.getEngine();
    var aspect = eng.getRenderWidth() / Math.max(1, eng.getRenderHeight());
    var half = this.coords.LZ * 0.62; // fit pitch height with margin
    cam.orthoTop = half; cam.orthoBottom = -half; cam.orthoLeft = -half * aspect; cam.orthoRight = half * aspect;
  };
  CameraProjection.prototype.onResize = function () { if (this.mode === MODES.ORTHOGRAPHIC_TACTICAL) this._applyOrtho(); };
  CameraProjection.MODES = MODES;
  TE.CameraProjection = CameraProjection;
  TE.MODES = MODES;

  /* ── Scene object registry ──────────────────────────────────────────────── */
  function ObjectRegistry(engine) { this.engine = engine; this.map = {}; this.order = []; this.selected = null; }
  ObjectRegistry.prototype.add = function (obj) { this.map[obj.id] = obj; this.order.push(obj.id); obj.build(this.engine); this._applyDepth(); return obj; };
  ObjectRegistry.prototype.get = function (id) { return this.map[id] || null; };
  ObjectRegistry.prototype.update = function (id, patch) { var o = this.map[id]; if (!o) return; o.applyPatch(patch); };
  ObjectRegistry.prototype.select = function (id) { var self = this; this.selected = id; this.order.forEach(function (k) { var o = self.map[k]; if (o.setSelected) o.setSelected(k === id); }); };
  ObjectRegistry.prototype.setVisible = function (id, v) { var o = this.map[id]; if (o) o.setVisible(v); };
  ObjectRegistry.prototype.remove = function (id) { var o = this.map[id]; if (!o) return; o.dispose(); delete this.map[id]; var i = this.order.indexOf(id); if (i >= 0) this.order.splice(i, 1); };
  ObjectRegistry.prototype.clear = function () { var self = this; this.order.slice().forEach(function (id) { self.remove(id); }); this.order = []; this.map = {}; this.selected = null; };
  ObjectRegistry.prototype.each = function (fn) { var self = this; this.order.forEach(function (id) { fn(self.map[id]); }); };
  ObjectRegistry.prototype._applyDepth = function () { this.order.sort(function () { return 0; }); var r = 0.001; this.each(function (o) { if (o.setRenderOrder) o.setRenderOrder(o.spec.z || 0); }); };
  ObjectRegistry.prototype.serialize = function () { var out = []; this.each(function (o) { out.push(JSON.parse(JSON.stringify(o.spec))); }); return { objects: out }; };
  ObjectRegistry.prototype.load = function (data, engine) {
    this.clear(); var self = this; (data && data.objects || []).forEach(function (spec) { var o = TE.createObject(spec); if (o) self.add(o); });
  };
  TE.ObjectRegistry = ObjectRegistry;

  /* ── Animation timeline (deterministic) ─────────────────────────────────── */
  function AnimationTimeline(duration) {
    this.duration = duration || 6; this.time = 0; this.speed = 1; this.playing = false; this._cb = null;
  }
  AnimationTimeline.prototype.play = function () { if (this.time >= this.duration - 1e-4) this.time = 0; this.playing = true; };
  AnimationTimeline.prototype.pause = function () { this.playing = false; };
  AnimationTimeline.prototype.reset = function () { this.time = 0; this.playing = false; };
  AnimationTimeline.prototype.seek = function (t) { this.time = Math.max(0, Math.min(this.duration, t)); };
  AnimationTimeline.prototype.setSpeed = function (s) { this.speed = s; };
  AnimationTimeline.prototype.advance = function (dtSec) { if (this.playing) { this.time += dtSec * this.speed; if (this.time >= this.duration) { this.time = this.duration; this.playing = false; } } if (this._cb) this._cb(this.time, this.duration, this.playing); };
  AnimationTimeline.prototype.on = function (cb) { this._cb = cb; };
  TE.AnimationTimeline = AnimationTimeline;

  /* ── Shared material helpers (GPU) ──────────────────────────────────────── */
  function col3(hex) { return BABYLON.Color3.FromHexString(hex); }
  function emissiveMat(scene, hex, alpha) {
    var m = new BABYLON.StandardMaterial('m' + Math.random().toString(36).slice(2), scene);
    var c = col3(hex); m.diffuseColor = c.scale(0.2); m.emissiveColor = c.scale(0.9); m.specularColor = new BABYLON.Color3(0, 0, 0);
    m.alpha = alpha == null ? 1 : alpha; m.backFaceCulling = false; m.disableLighting = false; return m;
  }

  /* ── Base primitive ─────────────────────────────────────────────────────── */
  function Primitive(spec) { this.id = spec.id; this.type = spec.type; this.spec = spec; this.meshes = []; this.engine = null; this.visible = spec.visible !== false; }
  Primitive.prototype.setVisible = function (v) { this.visible = v; this.meshes.forEach(function (m) { m.setEnabled(v); }); };
  Primitive.prototype.setRenderOrder = function () {};
  Primitive.prototype.setSelected = function () {};
  Primitive.prototype.applyPatch = function (patch) { for (var k in patch) this.spec[k] = patch[k]; if (this.rebuild && this.engine) this.rebuild(); };
  Primitive.prototype.dispose = function () { this.meshes.forEach(function (m) { try { if (m.material) m.material.dispose(); m.dispose(); } catch (e) {} }); this.meshes = []; };
  Primitive.prototype.window = function () {};
  Primitive.prototype.startEnd = function () { var a = this.spec.animation || {}; var s = (this.spec.start || 0) + (a.delay || 0); return { s: s, d: a.dur || a.duration || 1, type: a.type || 'fade', ease: a.easing || 'easeInOutCubic', end: this.spec.end }; };
  Primitive.prototype.localProgress = function (t) { var se = this.startEnd(); return ease(se.ease, clamp01((t - se.s) / (se.d || 1e-6))); };

  /* helper: quadratic bezier sample in pitch space → world Vector3[] */
  function bezierWorld(coords, a, c, b, n, yUp) {
    var pts = [], i; for (i = 0; i <= n; i++) { var t = i / n, mt = 1 - t; var x = mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x, y = mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y; pts.push(coords.pitchToWorld(x, y, yUp)); }
    return pts;
  }
  function trimWorld(pts, reveal) {
    if (reveal >= 1) return pts.slice();
    var total = 0, seg = [], i; for (i = 1; i < pts.length; i++) { var l = BABYLON.Vector3.Distance(pts[i], pts[i - 1]); seg.push(l); total += l; }
    var target = total * reveal, acc = 0, out = [pts[0]];
    for (i = 1; i < pts.length; i++) { if (acc + seg[i - 1] >= target) { var r = (target - acc) / (seg[i - 1] || 1e-6); out.push(BABYLON.Vector3.Lerp(pts[i - 1], pts[i], r)); break; } acc += seg[i - 1]; out.push(pts[i]); }
    return out.length > 1 ? out : [pts[0], pts[0].add(new BABYLON.Vector3(0.001, 0, 0))];
  }

  /* ── 1) Tactical Arrow (tapered ribbon + head + glow + shadow + travel) ──── */
  function TacticalArrow(spec) { Primitive.call(this, spec); }
  TacticalArrow.prototype = Object.create(Primitive.prototype);
  TacticalArrow.prototype.build = function (engine) {
    this.engine = engine; var scene = engine.scene, st = this.spec.style || {}, g = this.spec.geometry;
    this.mat = emissiveMat(scene, st.color || '#f2c230', st.opacity == null ? 0.95 : st.opacity);
    this.headMat = emissiveMat(scene, st.color || '#f2c230', st.opacity == null ? 0.95 : st.opacity);
    this.shadowMat = new BABYLON.StandardMaterial('sh', scene); this.shadowMat.diffuseColor = new BABYLON.Color3(0, 0, 0); this.shadowMat.specularColor = new BABYLON.Color3(0, 0, 0); this.shadowMat.alpha = 0.28 * (st.shadow == null ? 1 : st.shadow); this.shadowMat.backFaceCulling = false;
    this._reveal = -1; this.rebuild(1);
    if (st.travel !== false) { this.spark = BABYLON.MeshBuilder.CreateDisc('spark', { radius: 0.9, tessellation: 16 }, scene); this.spark.rotation.x = Math.PI / 2; this.spark.material = emissiveMat(scene, '#ffffff', 0.95); this.meshes.push(this.spark); this.spark.setEnabled(false); }
    this.setVisible(this.visible);
  };
  TacticalArrow.prototype.rebuild = function (reveal) {
    var engine = this.engine; if (!engine) return; var scene = engine.scene, st = this.spec.style || {}, g = this.spec.geometry, coords = engine.coords;
    if (this.ribbon) { this.ribbon.dispose(); } if (this.head) { this.head.dispose(); } if (this.shadow) { this.shadow.dispose(); }
    var thick = (st.thickness == null ? 0.8 : st.thickness), hw0 = thick * 1.15, hw1 = thick * 0.42; // metres, tapered
    var full = bezierWorld(coords, g.start, g.control || { x: (g.start.x + g.end.x) / 2, y: (g.start.y + g.end.y) / 2 }, g.end, 48, (this.spec.depth || 0.06));
    var pts = trimWorld(full, clamp01(reveal == null ? 1 : reveal));
    var left = [], right = [], i, n = pts.length;
    for (i = 0; i < n; i++) {
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)]; var dx = b.x - a.x, dz = b.z - a.z, dl = Math.hypot(dx, dz) || 1; var nx = -dz / dl, nz = dx / dl; var f = n > 1 ? i / (n - 1) : 0; var hw = hw0 + (hw1 - hw0) * f;
      left.push(new BABYLON.Vector3(pts[i].x + nx * hw, pts[i].y, pts[i].z + nz * hw));
      right.push(new BABYLON.Vector3(pts[i].x - nx * hw, pts[i].y, pts[i].z - nz * hw));
    }
    this.ribbon = BABYLON.MeshBuilder.CreateRibbon('arw', { pathArray: [left, right], sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene); this.ribbon.material = this.mat;
    // ground shadow (flatter, offset, darker) just under body
    var sl = left.map(function (p) { return new BABYLON.Vector3(p.x, 0.008, p.z); }), sr = right.map(function (p) { return new BABYLON.Vector3(p.x, 0.008, p.z); });
    this.shadow = BABYLON.MeshBuilder.CreateRibbon('arwsh', { pathArray: [sl, sr], sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene); this.shadow.material = this.shadowMat; this.shadow.position.x += 0.3; this.shadow.position.z += 0.3;
    // arrowhead
    var tip = pts[n - 1], prev = pts[Math.max(0, n - 3)]; var ang = Math.atan2(tip.x - prev.x, tip.z - prev.z);
    var hs = Math.max(1.4, hw0 * ((st.headScale) || 3.0)); this.head = BABYLON.MeshBuilder.CreateDisc('arwh', { radius: hs, tessellation: 3 }, scene); this.head.rotation.x = Math.PI / 2; this.head.rotation.y = ang; this.head.position = new BABYLON.Vector3(tip.x, (this.spec.depth || 0.06) + 0.005, tip.z); this.head.material = this.headMat;
    this.meshes = this.meshes.filter(function (m) { return m === this.spark; }, this).concat([this.ribbon, this.shadow, this.head]);
    this._lastTip = tip; this.setVisible(this.visible);
  };
  TacticalArrow.prototype.updateAt = function (t) {
    var se = this.startEnd(); if (t < se.s) { this.setVisible(false); return; } this.setVisible(this.visible);
    var reveal = se.type === 'draw-on' ? this.localProgress(t) : 1; var alpha = se.type === 'fade' ? this.localProgress(t) : (this.spec.style && this.spec.style.opacity != null ? this.spec.style.opacity : 0.95);
    if (Math.abs(reveal - this._reveal) > 0.012 || reveal >= 1 && this._reveal < 1) { this._reveal = reveal; this.rebuild(reveal); }
    this.mat.alpha = alpha; this.headMat.alpha = alpha;
    if (this.spark) { var on = reveal > 0.02 && reveal < 0.995; this.spark.setEnabled(on && this.visible); if (on && this._lastTip) { this.spark.position = new BABYLON.Vector3(this._lastTip.x, (this.spec.depth || 0.06) + 0.02, this._lastTip.z); var s = 0.8 + 0.3 * Math.sin(t * 12); this.spark.scaling.set(s, s, s); } }
  };
  TE.TacticalArrow = TacticalArrow;

  /* ── 2) Tactical Zone (ground quad, striped fill, stroke, reveal) ───────── */
  function TacticalZone(spec) { Primitive.call(this, spec); }
  TacticalZone.prototype = Object.create(Primitive.prototype);
  TacticalZone.prototype.build = function (engine) {
    this.engine = engine; var scene = engine.scene, coords = engine.coords, st = this.spec.style || {}, g = this.spec.geometry;
    var corners = g.corners || [g.a, { x: g.b.x, y: g.a.y }, g.b, { x: g.a.x, y: g.b.y }];
    var w = corners.map(function (p) { return coords.pitchToWorld(p.x, p.y, 0.02); });
    // fill as a two-row ribbon (quad)
    this.fill = BABYLON.MeshBuilder.CreateRibbon('zone', { pathArray: [[w[0], w[3]], [w[1], w[2]]], sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    var tex = new BABYLON.DynamicTexture('ztex', { width: 512, height: 512 }, scene, false); var cx = tex.getContext();
    this._paintStripes(cx, st); tex.update(); tex.hasAlpha = true;
    var m = new BABYLON.StandardMaterial('zm', scene); m.diffuseTexture = tex; m.emissiveTexture = tex; m.emissiveColor = new BABYLON.Color3(1, 1, 1); m.opacityTexture = tex; m.specularColor = new BABYLON.Color3(0, 0, 0); m.backFaceCulling = false; m.useAlphaFromDiffuseTexture = true;
    this.fill.material = m; this.fillMat = m; this._baseAlpha = (st.opacity == null ? 0.9 : st.opacity);
    // boundary stroke
    var loop = [w[0], w[1], w[2], w[3], w[0]].map(function (p) { return new BABYLON.Vector3(p.x, 0.03, p.z); });
    this.stroke = BABYLON.MeshBuilder.CreateLines('zst', { points: loop }, scene); this.stroke.color = col3(st.color || '#5ec8ff'); this.stroke.alpha = 0.8;
    this.meshes = [this.fill, this.stroke]; this.setVisible(this.visible);
  };
  TacticalZone.prototype._paintStripes = function (cx, st) {
    var hex = (st.color || '#5ec8ff'); var c = col3(hex); var rgb = Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255);
    cx.clearRect(0, 0, 512, 512); cx.fillStyle = 'rgba(' + rgb + ',0.16)'; cx.fillRect(0, 0, 512, 512);
    var step = st.stripeSpacing || 34, ang = (st.stripeAngle == null ? 45 : st.stripeAngle) * Math.PI / 180;
    cx.save(); cx.strokeStyle = 'rgba(' + rgb + ',0.5)'; cx.lineWidth = Math.max(2, step * 0.18); cx.translate(256, 256); cx.rotate(ang); cx.translate(-256, -256);
    for (var x = -512; x < 1024; x += step) { cx.beginPath(); cx.moveTo(x, -512); cx.lineTo(x, 1024); cx.stroke(); } cx.restore();
  };
  TacticalZone.prototype.updateAt = function (t) {
    var se = this.startEnd(); if (t < se.s) { this.setVisible(false); return; } this.setVisible(this.visible);
    var p = (se.type === 'reveal' || se.type === 'fade' || se.type === 'draw-on') ? this.localProgress(t) : 1;
    if (this.fillMat) this.fillMat.alpha = this._baseAlpha * p; if (this.stroke) this.stroke.alpha = 0.8 * p;
  };
  TE.TacticalZone = TacticalZone;

  /* ── 3) Player Ring (ground ellipse, glow, pulse, label) ────────────────── */
  function PlayerRing(spec) { Primitive.call(this, spec); }
  PlayerRing.prototype = Object.create(Primitive.prototype);
  PlayerRing.prototype.build = function (engine) {
    this.engine = engine; var scene = engine.scene, coords = engine.coords, st = this.spec.style || {}, g = this.spec.geometry;
    var pos = coords.pitchToWorld(g.at.x, g.at.y, 0.03); var rad = (st.radius || 2.2);
    this.ring = BABYLON.MeshBuilder.CreateTorus('ring', { diameter: rad * 2, thickness: rad * 0.16, tessellation: 48 }, scene);
    this.ring.position = pos; this.ring.scaling.z = 0.62; // ellipse on ground
    this.ring.material = emissiveMat(scene, st.color || '#ffffff', st.opacity == null ? 0.95 : st.opacity);
    this.inner = BABYLON.MeshBuilder.CreateTorus('ring2', { diameter: rad * 1.25, thickness: rad * 0.10, tessellation: 40 }, scene);
    this.inner.position = pos.clone(); this.inner.scaling.z = 0.62; this.inner.material = emissiveMat(scene, st.color || '#ffffff', 0.75);
    this._pos = pos; this._rad = rad; this.meshes = [this.ring, this.inner]; this.setVisible(this.visible);
  };
  PlayerRing.prototype.setSelected = function (on) { if (this.ring) this.ring.material.emissiveColor = col3((this.spec.style && this.spec.style.color) || '#ffffff').scale(on ? 1.4 : 0.9); };
  PlayerRing.prototype.updateAt = function (t) {
    var se = this.startEnd(); if (t < se.s) { this.setVisible(false); return; } this.setVisible(this.visible);
    var appear = clamp01((t - se.s) / 0.4); var pulse = 1 + 0.05 * Math.sin(t * 4.2);
    var s = appear * pulse; if (this.ring) { this.ring.scaling.x = s; this.ring.scaling.z = 0.62 * s; } if (this.inner) { this.inner.scaling.x = s; this.inner.scaling.z = 0.62 * s; }
  };
  TE.PlayerRing = PlayerRing;

  /* ── 4) Tactical Label (world-anchored billboard, plate, leader) ────────── */
  function TacticalLabel(spec) { Primitive.call(this, spec); }
  TacticalLabel.prototype = Object.create(Primitive.prototype);
  TacticalLabel.prototype.build = function (engine) {
    this.engine = engine; var scene = engine.scene, coords = engine.coords, st = this.spec.style || {}, g = this.spec.geometry;
    var anchor = coords.pitchToWorld(g.at.x, g.at.y, 0.05); var up = (st.height || 6);
    var tw = 512, th = 128; var tex = new BABYLON.DynamicTexture('ltex', { width: tw, height: th }, scene, true); var cx = tex.getContext();
    var accent = st.color || '#f2c230'; var c = col3(accent); var rgb = Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255);
    cx.clearRect(0, 0, tw, th); cx.fillStyle = 'rgba(12,16,22,0.94)'; roundRect(cx, 8, 30, tw - 16, th - 60, 14); cx.fill();
    cx.fillStyle = 'rgb(' + rgb + ')'; roundRect(cx, 8, 30, 12, th - 60, 6); cx.fill();
    cx.fillStyle = '#f4f7fb'; cx.font = '700 40px Inter, Arial, sans-serif'; cx.textBaseline = 'middle'; cx.textAlign = 'left'; cx.fillText(String(this.spec.text || 'Label'), 34, th / 2 + 1); tex.update();
    var plane = BABYLON.MeshBuilder.CreatePlane('lbl', { width: 14, height: 14 * th / tw }, scene);
    var m = new BABYLON.StandardMaterial('lm', scene); m.diffuseTexture = tex; m.emissiveColor = new BABYLON.Color3(1, 1, 1); m.opacityTexture = tex; m.specularColor = new BABYLON.Color3(0, 0, 0); m.backFaceCulling = false; plane.material = m;
    plane.position = new BABYLON.Vector3(anchor.x, up, anchor.z); plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    this.plane = plane; this.mat = m;
    this.leader = BABYLON.MeshBuilder.CreateLines('lld', { points: [new BABYLON.Vector3(anchor.x, 0.05, anchor.z), new BABYLON.Vector3(anchor.x, up - 1.3, anchor.z)] }, scene); this.leader.color = c; this.leader.alpha = 0.7;
    this.meshes = [plane, this.leader]; this.setVisible(this.visible);
  };
  TacticalLabel.prototype.updateAt = function (t) {
    var se = this.startEnd(); if (t < se.s) { this.setVisible(false); return; } this.setVisible(this.visible);
    var a = this.localProgress(t); if (this.mat) this.mat.alpha = a; if (this.leader) this.leader.alpha = 0.7 * a;
  };
  TE.TacticalLabel = TacticalLabel;

  /* ── 5) Spotlight (illuminated ground pocket + real light pooling) ───────── */
  function Spotlight(spec) { Primitive.call(this, spec); }
  Spotlight.prototype = Object.create(Primitive.prototype);
  Spotlight.prototype.build = function (engine) {
    this.engine = engine; var scene = engine.scene, coords = engine.coords, st = this.spec.style || {}, g = this.spec.geometry;
    var pos = coords.pitchToWorld(g.at.x, g.at.y, 0.012); var rad = st.radius || 9;
    var disc = BABYLON.MeshBuilder.CreateDisc('spot', { radius: rad, tessellation: 48 }, scene); disc.rotation.x = Math.PI / 2; disc.position = pos; disc.scaling.y = 0.62;
    var tex = new BABYLON.DynamicTexture('sptex', { width: 256, height: 256 }, scene, false); var cx = tex.getContext();
    var c = col3(st.color || '#ffffff'); var rgb = Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255);
    var grd = cx.createRadialGradient(128, 128, 8, 128, 128, 128); grd.addColorStop(0, 'rgba(' + rgb + ',0.5)'); grd.addColorStop(0.5, 'rgba(' + rgb + ',0.15)'); grd.addColorStop(1, 'rgba(' + rgb + ',0)'); cx.fillStyle = grd; cx.fillRect(0, 0, 256, 256); tex.update(); tex.hasAlpha = true;
    var m = new BABYLON.StandardMaterial('spm', scene); m.diffuseTexture = tex; m.emissiveTexture = tex; m.emissiveColor = new BABYLON.Color3(1, 1, 1); m.opacityTexture = tex; m.specularColor = new BABYLON.Color3(0, 0, 0); m.backFaceCulling = false; disc.material = m; this.mat = m; this._base = st.opacity == null ? 1 : st.opacity;
    try { var sl = new BABYLON.SpotLight('sl', new BABYLON.Vector3(pos.x, 24, pos.z), new BABYLON.Vector3(0, -1, 0), Math.PI / 3, 10, scene); sl.diffuse = c; sl.specular = new BABYLON.Color3(0, 0, 0); sl.intensity = st.light == null ? 0.7 : st.light; this.light = sl; this._lightBase = sl.intensity; } catch (e) {}
    this.meshes = [disc]; this.setVisible(this.visible);
  };
  Spotlight.prototype.setVisible = function (v) { Primitive.prototype.setVisible.call(this, v); if (this.light) this.light.setEnabled(v); };
  Spotlight.prototype.dispose = function () { if (this.light) { try { this.light.dispose(); } catch (e) {} } Primitive.prototype.dispose.call(this); };
  Spotlight.prototype.updateAt = function (t) {
    var se = this.startEnd(); if (t < se.s) { this.setVisible(false); return; } this.setVisible(this.visible);
    var p = this.localProgress(t); if (this.mat) this.mat.alpha = this._base * p; if (this.light) this.light.intensity = (this._lightBase || 0.7) * p;
    var pulse = 1 + 0.03 * Math.sin(t * 3); if (this.meshes[0]) this.meshes[0].scaling.x = pulse;
  };
  TE.Spotlight = Spotlight;

  /* ── 6) Passing Lane (soft, wide, translucent tapered ground ribbon) ────── */
  function PassingLane(spec) {
    spec.style = spec.style || {};
    if (spec.style.thickness == null) spec.style.thickness = 1.15;
    if (spec.style.opacity == null) spec.style.opacity = 0.5;
    if (spec.style.headScale == null) spec.style.headScale = 1.7;
    if (spec.style.travel == null) spec.style.travel = false;
    TacticalArrow.call(this, spec);
  }
  PassingLane.prototype = Object.create(TacticalArrow.prototype);
  PassingLane.prototype.constructor = PassingLane;
  TE.PassingLane = PassingLane;

  /* ── 7) Connection Line (ground dashed line + metre label) ──────────────── */
  function ConnectionLine(spec) { Primitive.call(this, spec); }
  ConnectionLine.prototype = Object.create(Primitive.prototype);
  ConnectionLine.prototype.build = function (engine) {
    this.engine = engine; var scene = engine.scene, coords = engine.coords, st = this.spec.style || {}, g = this.spec.geometry;
    var wa = coords.pitchToWorld(g.a.x, g.a.y, 0.05), wb = coords.pitchToWorld(g.b.x, g.b.y, 0.05); this._wa = wa; this._wb = wb;
    this.line = BABYLON.MeshBuilder.CreateDashedLines('conn', { points: [wa, wb], dashSize: 3, gapSize: 2, dashNb: 46 }, scene); this.line.color = col3(st.color || '#5ec8ff');
    var dots = [wa, wb].map(function (p) { var d = BABYLON.MeshBuilder.CreateDisc('cd', { radius: 0.55, tessellation: 14 }, scene); d.rotation.x = Math.PI / 2; d.scaling.y = 0.62; d.position = p.clone(); d.material = emissiveMat(scene, st.color || '#5ec8ff', 1); return d; });
    // metres from pitch-space distance
    var metres = Math.hypot((g.b.x - g.a.x) / coords.bounds.x * coords.LX, (g.b.y - g.a.y) / coords.bounds.y * coords.LZ);
    var mid = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
    this.lbl = new TacticalLabel({ id: this.id + '-m', type: 'tactical-label', text: metres.toFixed(1) + ' m', geometry: { at: mid }, style: { color: st.color || '#5ec8ff', height: 3.4 }, animation: { type: 'fade', delay: (this.spec.animation && this.spec.animation.delay || 0), duration: 0.4 }, start: this.spec.start || 0 });
    this.lbl.build(engine);
    this.meshes = [this.line].concat(dots).concat(this.lbl.meshes);
    this._lineMat = null; this.setVisible(this.visible);
  };
  ConnectionLine.prototype.updateAt = function (t) {
    var se = this.startEnd(); if (t < se.s) { this.setVisible(false); return; } this.setVisible(this.visible);
    var p = this.localProgress(t); if (this.line) this.line.alpha = p; if (this.lbl) this.lbl.updateAt(t);
  };
  TE.ConnectionLine = ConnectionLine;

  /* ── 8) Receiver Ring (ground ring + one arrival pulse) ─────────────────── */
  function ReceiverRing(spec) { PlayerRing.call(this, spec); }
  ReceiverRing.prototype = Object.create(PlayerRing.prototype);
  ReceiverRing.prototype.constructor = ReceiverRing;
  ReceiverRing.prototype.build = function (engine) {
    PlayerRing.prototype.build.call(this, engine); var scene = engine.scene, st = this.spec.style || {};
    this.pulse = BABYLON.MeshBuilder.CreateTorus('rpulse', { diameter: (st.radius || 2.3) * 2, thickness: (st.radius || 2.3) * 0.12, tessellation: 40 }, scene);
    this.pulse.position = this._pos.clone(); this.pulse.scaling.z = 0.62; this.pulse.material = emissiveMat(scene, st.color || '#ffffff', 0.6);
    this.meshes.push(this.pulse); this.setVisible(this.visible);
  };
  ReceiverRing.prototype.updateAt = function (t) {
    PlayerRing.prototype.updateAt.call(this, t); var se = this.startEnd();
    if (this.pulse) { var appear = clamp01((t - se.s) / 0.6); if (appear < 1 && t >= se.s) { var s = 1 + 0.9 * appear; this.pulse.scaling.x = s; this.pulse.scaling.z = 0.62 * s; if (this.pulse.material) this.pulse.material.alpha = 0.6 * (1 - appear); this.pulse.setEnabled(this.visible); } else { this.pulse.setEnabled(false); } }
  };
  TE.ReceiverRing = ReceiverRing;

  function roundRect(cx, x, y, w, h, r) { cx.beginPath(); cx.moveTo(x + r, y); cx.arcTo(x + w, y, x + w, y + h, r); cx.arcTo(x + w, y + h, x, y + h, r); cx.arcTo(x, y + h, x, y, r); cx.arcTo(x, y, x + w, y, r); cx.closePath(); }

  /* ── Factory ────────────────────────────────────────────────────────────── */
  var TYPES = { 'tactical-arrow': TacticalArrow, 'tactical-zone': TacticalZone, 'player-ring': PlayerRing, 'tactical-label': TacticalLabel, 'spotlight': Spotlight, 'passing-lane': PassingLane, 'connection-line': ConnectionLine, 'receiver-ring': ReceiverRing };
  TE.createObject = function (spec) { var C = TYPES[spec.type]; return C ? new C(spec) : null; };

  /* ── The engine (renderer + scene + pitch + single render loop) ─────────── */
  function TelestrationEngine(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, alpha: true, antialias: true }, true);
    // Compile shaders synchronously so the first rendered frame is deterministic
    // (reliable screenshots/thumbnails; no blank frame while parallel compile
    // resolves across rAF ticks). Telestration scenes are small — negligible cost.
    try { var _caps = this.engine.getCaps(); if (_caps) _caps.parallelShaderCompile = undefined; } catch (e) {}
    this.engine.setHardwareScalingLevel(1 / Math.min(2, window.devicePixelRatio || 1));
    var scene = new BABYLON.Scene(this.engine); scene.clearColor = new BABYLON.Color4(0.03, 0.05, 0.08, opts.transparent ? 0 : 1); this.scene = scene;
    this.coords = new PitchCoordinateSystem(opts.pitch || {});
    scene.coords = this.coords; this.engineRef = this; scene.getEngine();
    // lights
    var hemi = new BABYLON.HemisphericLight('h', new BABYLON.Vector3(0, 1, 0), scene); hemi.intensity = 0.9;
    var dir = new BABYLON.DirectionalLight('d', new BABYLON.Vector3(-0.4, -1, 0.6), scene); dir.intensity = 0.6;
    // glow layer (GPU) for controlled soft glow on emissive primitives
    try { this.glow = new BABYLON.GlowLayer('glow', scene, { blurKernelSize: 24 }); this.glow.intensity = 0.5; } catch (e) {}
    // professional depth: gentle exponential fog toward the far pitch
    try { scene.fogMode = BABYLON.Scene.FOGMODE_EXP2; scene.fogColor = new BABYLON.Color3(0.03, 0.05, 0.08); scene.fogDensity = opts.transparent ? 0 : 0.0035; } catch (e) {}
    this._pitchOn = opts.pitch !== false && !opts.noPitch;
    if (this._pitchOn) this._buildPitch();
    this.projection = new CameraProjection(scene, this.coords);
    this.registry = new ObjectRegistry(this);
    this.timeline = new AnimationTimeline(opts.duration || 6);
    // expose coords for primitives via engine.scene + engine.coords
    this.scene = scene;
    var self = this; this._last = performance.now();
    this._loop = function () { var now = performance.now(); var dt = Math.min(0.05, (now - self._last) / 1000); self._last = now; self.timeline.advance(dt); self.registry.each(function (o) { if (o.updateAt) o.updateAt(self.timeline.time); }); scene.render(); };
    this._onResize = function () { self.engine.resize(); self.projection.onResize(); };
    window.addEventListener('resize', this._onResize);
  }
  TelestrationEngine.prototype._buildPitch = function () {
    var scene = this.scene, c = this.coords;
    var g = BABYLON.MeshBuilder.CreateGround('pitch', { width: c.LX, height: c.LZ, subdivisions: 1 }, scene);
    var tex = new BABYLON.DynamicTexture('pt', { width: 1050, height: 680 }, scene, true); var x = tex.getContext();
    // grass mow stripes
    for (var i = 0; i < 14; i++) { x.fillStyle = (i % 2 ? '#1f6f38' : '#238a45'); x.fillRect(i / 14 * 1050, 0, 1050 / 14 + 1, 680); }
    // markings
    x.strokeStyle = 'rgba(255,255,255,.82)'; x.lineWidth = 3;
    x.strokeRect(14, 14, 1050 - 28, 680 - 28); x.beginPath(); x.moveTo(525, 14); x.lineTo(525, 666); x.stroke();
    x.beginPath(); x.arc(525, 340, 66, 0, 6.2832); x.stroke();
    x.strokeRect(14, 190, 150, 300); x.strokeRect(1050 - 14 - 150, 190, 150, 300);
    x.strokeRect(14, 265, 55, 150); x.strokeRect(1050 - 14 - 55, 265, 55, 150);
    tex.update();
    var m = new BABYLON.StandardMaterial('pm', scene); m.diffuseTexture = tex; m.specularColor = new BABYLON.Color3(0.02, 0.05, 0.03); m.emissiveColor = new BABYLON.Color3(0.16, 0.22, 0.16); g.material = m; this.pitch = g;
  };
  TelestrationEngine.prototype.setProjectionMode = function (mode) { return this.projection.setProjectionMode(mode); };
  TelestrationEngine.prototype.start = function () { var self = this; this.engine.stopRenderLoop(); this.engine.runRenderLoop(this._loop); };
  TelestrationEngine.prototype.renderOnce = function () { this._loop(); };
  TelestrationEngine.prototype.dispose = function () {
    try { this.engine.stopRenderLoop(); } catch (e) {}
    window.removeEventListener('resize', this._onResize);
    try { this.registry.clear(); } catch (e) {}
    try { this.scene.dispose(); } catch (e) {}
    try { this.engine.dispose(); } catch (e) {}
    this.disposed = true;
  };
  TE.TelestrationEngine = TelestrationEngine;

  /* ── Self-contained test panel (Phase-1 acceptance scene) ───────────────── */
  function buildTestScene(engine) {
    engine.registry.clear();
    engine.registry.add(new TacticalZone({ id: 'zone-1', type: 'tactical-zone', z: 1, geometry: { a: { x: 58, y: 20 }, b: { x: 84, y: 52 } }, style: { color: '#5ec8ff', opacity: 0.85, stripeSpacing: 30, stripeAngle: 45 }, animation: { type: 'reveal', delay: 1.4, duration: 0.9, easing: 'easeInOutCubic' }, start: 0 }));
    engine.registry.add(new TacticalArrow({ id: 'arrow-1', type: 'tactical-arrow', z: 5, depth: 0.06, geometry: { start: { x: 30, y: 66 }, control: { x: 46, y: 40 }, end: { x: 70, y: 30 } }, style: { color: '#f2c230', thickness: 0.8, opacity: 0.96, glow: 0.35, shadow: 0.45, travel: true }, animation: { type: 'draw-on', delay: 0.3, duration: 1.4, easing: 'easeInOutCubic' }, start: 0 }));
    engine.registry.add(new PlayerRing({ id: 'ring-1', type: 'player-ring', z: 6, geometry: { at: { x: 70, y: 30 } }, style: { color: '#ffffff', radius: 2.3, opacity: 0.95 }, animation: { type: 'fade', delay: 1.7, duration: 0.4, easing: 'easeOutCubic' }, start: 0 }));
    engine.registry.add(new TacticalLabel({ id: 'label-1', type: 'tactical-label', z: 7, text: 'THIRD-MAN RUN', geometry: { at: { x: 70, y: 26 } }, style: { color: '#f2c230', height: 7 }, animation: { type: 'fade', delay: 2.0, duration: 0.4, easing: 'easeOutCubic' }, start: 0 }));
    engine.timeline.duration = 3.0;
  }

  /* ── Data converters: existing module data → engine scene specs ─────────── */
  // Video Intelligence: _vist annotations (normalized 0..1 coords) → engine specs.
  TE.fromViAnnotations = function (anns, opts) {
    opts = opts || {}; var specs = [], z = 0;
    function P(p) { return { x: (p.x || 0) * 100, y: (p.y || 0) * 100 }; }
    (anns || []).forEach(function (an) {
      if (!an || an.hidden || !an.tool) return; var col = an.color || '#f2c230'; var t = an.t || 0; z += 1;
      var anim = { type: 'fade', delay: 0, duration: 0.5 };
      try {
        if (an.tool === 'pass' || an.tool === 'arrow' || an.tool === 'curve' || an.tool === 'line') {
          var a = P(an.a), b = P(an.b); var mid = { x: (a.x + b.x) / 2 + (an.bend || -0.14) * (b.y - a.y) * 0.6, y: (a.y + b.y) / 2 - (an.bend || -0.14) * (b.x - a.x) * 0.6 };
          specs.push({ id: an.id || 'a' + z, type: 'tactical-arrow', z: z, depth: 0.06, geometry: { start: a, control: mid, end: b }, style: { color: col, thickness: 0.85, opacity: 0.95, headScale: 3.0, travel: an.tool === 'pass' }, animation: { type: 'draw-on', delay: 0.3, duration: 1.3 }, start: t });
        } else if (an.tool === 'run' || an.tool === 'darrow') {
          var ra = P(an.a), rb = P(an.b);
          specs.push({ id: an.id || 'r' + z, type: 'tactical-arrow', z: z, depth: 0.05, geometry: { start: ra, control: { x: (ra.x + rb.x) / 2, y: (ra.y + rb.y) / 2 }, end: rb }, style: { color: col, thickness: 0.55, opacity: 0.9, headScale: 2.4, travel: false }, animation: { type: 'draw-on', delay: 0.2, duration: 1.2 }, start: t });
        } else if (an.tool === 'szone' || an.tool === 'zone' || an.tool === 'polygon' || an.tool === 'farea') {
          var corners = an.pts ? an.pts.map(P) : (an.a && an.b ? [P(an.a), { x: P(an.b).x, y: P(an.a).y }, P(an.b), { x: P(an.a).x, y: P(an.b).y }] : null);
          if (corners) specs.push({ id: an.id || 'z' + z, type: 'tactical-zone', z: z, geometry: { corners: corners }, style: { color: col, opacity: 0.8, stripeSpacing: 30, stripeAngle: 45 }, animation: { type: 'reveal', delay: 0.4, duration: 0.8 }, start: t });
        } else if (an.tool === 'ring' || an.tool === 'dring' || an.tool === 'circle') {
          var c = P(an.a), e = P(an.b || an.a); var radp = Math.max(1.4, Math.hypot(e.x - c.x, e.y - c.y) * 0.9);
          specs.push({ id: an.id || 'g' + z, type: 'receiver-ring', z: z, geometry: { at: c }, style: { color: col, radius: radp }, animation: { type: 'fade', delay: 0.2, duration: 0.4 }, start: t });
        } else if (an.tool === 'spot') {
          var sc = P(an.a), se2 = P(an.b || an.a);
          specs.push({ id: an.id || 's' + z, type: 'spotlight', z: 0, geometry: { at: sc }, style: { color: col, radius: Math.max(6, Math.hypot(se2.x - sc.x, se2.y - sc.y) * 1.6), light: 0.7 }, animation: { type: 'fade', delay: 0, duration: 0.45 }, start: t });
        } else if (an.tool === 'distance') {
          specs.push({ id: an.id || 'c' + z, type: 'connection-line', z: z, geometry: { a: P(an.a), b: P(an.b) }, style: { color: col }, animation: { type: 'fade', delay: 0.5, duration: 0.5 }, start: t });
        } else if (an.tool === 'plabel' || an.tool === 'text' || an.tool === 'banner') {
          specs.push({ id: an.id || 'l' + z, type: 'tactical-label', z: z + 10, text: an.text || 'Label', geometry: { at: P(an.a) }, style: { color: col, height: 6 }, animation: { type: 'fade', delay: 0.4, duration: 0.4 }, start: t });
        }
      } catch (e) {}
    });
    return specs;
  };
  // AI Tactical Simulation: a drill/tactical timeline step (metres) → engine specs.
  TE.fromSimStep = function (tl, step, opts) {
    opts = opts || {}; var specs = [], z = 0; var LX = 105, LZ = 68; step = step || 0;
    function P(xz) { return { x: (xz[0] || 0) / LX * 100, y: (xz[1] || 0) / LZ * 100 }; }
    function pos(i) { var pl = tl.players && tl.players[i]; if (!pl || !pl.track) return null; var tr = pl.track[Math.min(step, pl.track.length - 1)]; return tr ? P(tr) : null; }
    var s = (tl.steps && tl.steps[step]) || {}; var ov = s.overlays || {};
    if (ov.zone) { var Z = ov.zone; var c0 = P([Z[0], Z[1]]), c1 = P([Z[0] + Z[2], Z[1] + Z[3]]); specs.push({ id: 'z0', type: 'tactical-zone', z: 1, geometry: { corners: [{ x: c0.x, y: c0.y }, { x: c1.x, y: c0.y }, { x: c1.x, y: c1.y }, { x: c0.x, y: c1.y }] }, style: { color: '#5ec8ff', opacity: 0.8, stripeSpacing: 30, stripeAngle: 45 }, animation: { type: 'reveal', delay: 1.4, duration: 0.8 }, start: 0 }); if (Z[4]) specs.push({ id: 'zl', type: 'tactical-label', z: 12, text: String(Z[4]).toUpperCase(), geometry: { at: { x: (c0.x + c1.x) / 2, y: c0.y } }, style: { color: '#5ec8ff', height: 5 }, animation: { type: 'fade', delay: 1.6, duration: 0.4 }, start: 0 }); }
    (ov.pass || []).forEach(function (pr, k) { var a = pos(pr[0]), b = pos(pr[1]); if (!a || !b) return; z++; specs.push({ id: 'pl' + k, type: 'passing-lane', z: 5, depth: 0.06, geometry: { start: a, control: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 6 }, end: b }, style: { color: '#f2c230', thickness: 1.0, opacity: 0.55 }, animation: { type: 'draw-on', delay: 0.35, duration: 1.4 }, start: 0 }); specs.push({ id: 'rr' + k, type: 'receiver-ring', z: 6, geometry: { at: b }, style: { color: '#ffffff', radius: 2.3 }, animation: { type: 'fade', delay: 2.0, duration: 0.4 }, start: 0 }); });
    (ov.run || []).forEach(function (i, k) { var a = pos(i); var pl = tl.players && tl.players[i]; var nxt = pl && pl.track ? pl.track[Math.min(step + 1, pl.track.length - 1)] : null; if (!a || !nxt) return; var b = P(nxt); specs.push({ id: 'ru' + k, type: 'tactical-arrow', z: 4, depth: 0.05, geometry: { start: a, control: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, end: b }, style: { color: '#eaf7ee', thickness: 0.55, headScale: 2.4, opacity: 0.9 }, animation: { type: 'draw-on', delay: 1.2, duration: 1.0 }, start: 0 }); });
    (ov.press || []).forEach(function (i, k) { var a = pos(i); if (!a) return; specs.push({ id: 'ps' + k, type: 'spotlight', z: 0, geometry: { at: a }, style: { color: '#f87171', radius: 7, light: 0.5 }, animation: { type: 'fade', delay: 0, duration: 0.5 }, start: 0 }); });
    if (ov.highlight != null) { var hp = pos(ov.highlight); if (hp) specs.push({ id: 'hl', type: 'spotlight', z: 0, geometry: { at: hp }, style: { color: '#ffffff', radius: 8, light: 0.7 }, animation: { type: 'fade', delay: 0, duration: 0.45 }, start: 0 }); }
    return specs;
  };

  /* ── Mount controller: run the engine inside an existing host element ────── */
  TE.mountOn = function (host, opts) {
    opts = opts || {}; var canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;z-index:' + (opts.zIndex || 40) + ';';
    var w = Math.max(2, host.clientWidth || 960), h = Math.max(2, host.clientHeight || 540);
    canvas.width = Math.round(w * Math.min(2, window.devicePixelRatio || 1)); canvas.height = Math.round(h * Math.min(2, window.devicePixelRatio || 1));
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(canvas);
    var eng = new TelestrationEngine(canvas, { transparent: opts.transparent !== false, noPitch: !!opts.noPitch, duration: opts.duration || 4 });
    eng.setProjectionMode(opts.mode || TE.MODES.PERSPECTIVE_PITCH);
    var ctrl = {
      engine: eng, canvas: canvas,
      setScene: function (specs) { eng.registry.clear(); var maxT = 0; (specs || []).forEach(function (s) { var o = TE.createObject(s); if (o) eng.registry.add(o); var a = s.animation || {}; maxT = Math.max(maxT, (s.start || 0) + (a.delay || 0) + (a.dur || a.duration || 1)); }); eng.timeline.duration = Math.max(2, maxT + 0.4); return ctrl; },
      setMode: function (m) { eng.setProjectionMode(m); return ctrl; },
      play: function () { eng.timeline.play(); return ctrl; }, pause: function () { eng.timeline.pause(); return ctrl; }, reset: function () { eng.timeline.reset(); return ctrl; }, seek: function (t) { eng.timeline.seek(t); return ctrl; },
      start: function () { eng.start(); return ctrl; },
      snapshot: function (t) { if (t != null) { eng.timeline.time = t; eng.timeline.playing = false; eng.registry.each(function (o) { if (o.updateAt) o.updateAt(t); }); } for (var i = 0; i < 3; i++) eng.scene.render(); return canvas.toDataURL('image/jpeg', 0.86); },
      resize: function () { var nw = Math.max(2, host.clientWidth), nh = Math.max(2, host.clientHeight); canvas.width = Math.round(nw * Math.min(2, window.devicePixelRatio || 1)); canvas.height = Math.round(nh * Math.min(2, window.devicePixelRatio || 1)); eng.engine.resize(); eng.projection.onResize(); return ctrl; },
      dispose: function () { try { eng.dispose(); } catch (e) {} if (canvas.parentNode) canvas.parentNode.removeChild(canvas); }
    };
    return ctrl;
  };

  TE.openTest = function () {
    if (document.getElementById('te-test-overlay')) return;
    var ov = document.createElement('div'); ov.id = 'te-test-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#05070b;display:flex;flex-direction:column;';
    ov.innerHTML = '<div style="flex:1;min-height:0;position:relative"><canvas id="te-test-canvas" style="width:100%;height:100%;display:block;touch-action:none"></canvas>'
      + '<div style="position:absolute;top:10px;left:12px;font:600 12px Inter,Arial;color:#8fe;letter-spacing:.4px">FAMILISTA · TELESTRATION ENGINE — PHASE 1 TEST</div>'
      + '<div id="te-mode-badge" style="position:absolute;top:10px;right:12px;font:600 11px Inter,Arial;color:#cfe;background:#12202b;border:1px solid #2a3b48;padding:4px 9px;border-radius:6px"></div></div>'
      + '<div style="display:flex;gap:6px;align-items:center;padding:9px 12px;background:#0b0f14;border-top:1px solid #1b232c;flex-wrap:wrap">'
      + tbtn('te-play', 'Play') + tbtn('te-pause', 'Pause') + tbtn('te-reset', 'Reset')
      + '<span style="width:10px"></span>' + tbtn('te-0_5', '0.5×') + tbtn('te-1', '1×') + tbtn('te-2', '2×')
      + '<span style="width:10px"></span>' + tbtn('te-mode', 'Perspective / Ortho')
      + '<span style="flex:1"></span>' + tbtn('te-close', 'Close ✕') + '</div>';
    document.body.appendChild(ov);
    var canvas = document.getElementById('te-test-canvas');
    TE.loadBabylon(function (ok) {
      if (!ok) { canvas.parentNode.insertAdjacentHTML('beforeend', '<div style="position:absolute;inset:0;display:grid;place-items:center;color:#f88;font:600 14px Inter">Failed to load Babylon.js (/vendor/babylon.js)</div>'); return; }
      var eng = new TelestrationEngine(canvas, { transparent: false, duration: 3 });
      buildTestScene(eng); eng.setProjectionMode(TE.MODES.PERSPECTIVE_PITCH); eng.timeline.play(); eng.start();
      TE._test = eng; var badge = document.getElementById('te-mode-badge');
      function setBadge() { badge.textContent = eng.projection.mode === TE.MODES.PERSPECTIVE_PITCH ? 'PERSPECTIVE_PITCH' : 'ORTHOGRAPHIC_TACTICAL'; }
      setBadge();
      on('te-play', function () { eng.timeline.play(); }); on('te-pause', function () { eng.timeline.pause(); }); on('te-reset', function () { eng.timeline.reset(); });
      on('te-0_5', function () { eng.timeline.setSpeed(0.5); }); on('te-1', function () { eng.timeline.setSpeed(1); }); on('te-2', function () { eng.timeline.setSpeed(2); });
      on('te-mode', function () { eng.setProjectionMode(eng.projection.mode === TE.MODES.PERSPECTIVE_PITCH ? TE.MODES.ORTHOGRAPHIC_TACTICAL : TE.MODES.PERSPECTIVE_PITCH); setBadge(); });
      on('te-close', function () { try { eng.dispose(); } catch (e) {} var o = document.getElementById('te-test-overlay'); if (o) o.parentNode.removeChild(o); TE._test = null; });
    });
    function on(id, fn) { var b = document.getElementById(id); if (b) b.onclick = fn; }
  };
  function tbtn(id, label) { return '<button id="' + id + '" type="button" style="font:600 12px Inter,Arial;color:#dfe8f0;background:#18222c;border:1px solid #2a3742;border-radius:7px;padding:7px 11px;cursor:pointer">' + label + '</button>'; }

  /* hash trigger: open the test panel at #telestration-engine-test (no nav changes) */
  function checkHash() { if ((location.hash || '').replace('#', '') === 'telestration-engine-test') TE.openTest(); }
  window.addEventListener('hashchange', checkHash);
  if (document.readyState !== 'loading') setTimeout(checkHash, 0); else document.addEventListener('DOMContentLoaded', checkHash);

  window.FamilistaTE = TE;
})();

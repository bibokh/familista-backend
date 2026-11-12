/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN STUDIO — DS-1c — the 3D view

   The garment of pd-garment.js, drawn with the platform's own Babylon.js
   (public/vendor/babylon.js, Apache-2.0), loaded on demand the way the Neural
   Digital Twin loads it. This file owns the WebGL scene and nothing else: the
   design, its history and its rules stay with the editor (product-design.js).
   When a surface needs painting this file asks the editor for that surface's
   artwork as SVG text, drawn by the same renderer the 2D canvas uses, and it
   tells the editor what a pointer picked or moved, in the surface's own
   millimetres. One document drives both views.

   What a viewer sees is a visual simulation: the fabric, the light and the
   colours on a screen are not measured materials, inks or a colour proof, and
   the form is a procedural prototype, not a production pattern.

   No network but the vendored script; no inline style attribute; every object
   it creates is disposed when the view is closed.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var G = window.FamilistaProductDesignGarment;

  /** Per quality level: texture pixels per millimetre of surface, the mesh's density, and the canvas's pixel scaling (0: the screen's own). */
  var QUALITY = {
    high: { pxPerMm: 3, rowMm: 6, cols: 72, scaling: 0 },
    balanced: { pxPerMm: 2, rowMm: 8, cols: 56, scaling: 1 },
    low: { pxPerMm: 1.2, rowMm: 14, cols: 36, scaling: 1.5 },
  };
  var LIGHTS = ['studio', 'daylight', 'stadium'];
  var FABRICS = ['smooth', 'mesh'];
  var COMPARE_OFFSET = 0.36;

  function now() { return window.performance && performance.now ? performance.now() : Date.now(); }
  function sorted(a) { return a.slice().sort(function (x, y) { return x - y; }); }
  function median(a) { return a.length ? sorted(a)[Math.floor(a.length / 2)] : null; }
  function p95(a) { var s = sorted(a); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : null; }
  function push(list, v, max) { list.push(v); if (list.length > max) list.shift(); }

  var webgl = null;
  /** Whether this browser can give a WebGL context at all; asked once. */
  function webglAvailable() {
    if (webgl !== null) return webgl;
    try { var c = document.createElement('canvas'); webgl = !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (_) { webgl = false; }
    return webgl;
  }
  var loading = null;
  /** The vendored Babylon build, once; the Neural Digital Twin may already have loaded it. */
  function loadBabylon() {
    if (window.BABYLON && window.BABYLON.Engine) return Promise.resolve(true);
    if (loading) return loading;
    loading = new Promise(function (resolve) {
      var el = document.createElement('script');
      el.src = '/vendor/babylon.js';
      el.async = true;
      el.onload = function () { resolve(!!(window.BABYLON && window.BABYLON.Engine)); };
      el.onerror = function () { loading = null; resolve(false); };
      document.head.appendChild(el);
    });
    return loading;
  }

  /**
   * Open a 3D view in `host`, an element the caller sizes. `opts`:
   *   template             the validated product template
   *   quality              'high' | 'balanced' | 'low'
   *   colours              { collar, cuffs } as #rrggbb
   *   seam                 the seam lines' colour, #rrggbb
   *   font, dir            for the comparison's labels
   *   texture(surface, w, h)        the surface's artwork as SVG text, w × h pixels
   *   onPick(surface, {x, y})       a press on the garment (surface null: on nothing); true starts a drag
   *   onDrag(surface, {x, y})       a drag in progress
   *   onDrop(moved)                 its end
   *   onError(code)                 the view stopped working: 'texture'
   * Resolves to the view's controller, or to { error } when 3D cannot run here.
   */
  function open(host, opts) {
    var t0 = now();
    if (!G) return Promise.resolve({ error: 'garment' });
    if (!webglAvailable()) return Promise.resolve({ error: 'webgl' });
    return loadBabylon().then(function (ok) {
      if (!ok) return { error: 'babylon' };
      try { return create(host, opts, t0); } catch (e) { return { error: 'engine', detail: String((e && e.message) || e).slice(0, 200) }; }
    });
  }

  function create(host, opts, t0) {
    var B = window.BABYLON;
    var canvas = document.createElement('canvas');
    canvas.className = 'pd3-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    var engine = new B.Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false, antialias: true, powerPreference: 'high-performance' }, true);
    // The editor's canvas keeps the focus: Babylon would otherwise make its own canvas a tab stop on every pointer move.
    engine.canvasTabIndex = -1;
    canvas.tabIndex = -1;
    var scene = new B.Scene(engine);
    scene.doNotHandleCursors = true;
    scene.clearColor = new B.Color4(0, 0, 0, 0);
    scene.skipPointerMovePicking = true;
    scene.preventDefaultOnPointerDown = false;
    scene.preventDefaultOnPointerUp = false;

    var state = {
      quality: QUALITY[opts.quality] ? opts.quality : 'balanced', lighting: 'studio', fabric: 'smooth', check: false, turntable: false,
      preset: 'front', disposed: false, dirty: 3, raf: 0, want: {}, painting: {}, urls: [], drag: null, anim: null, compare: null,
      builds: 0, renders: 0, frameMs: [], intervals: [], lastFrame: 0, textureMs: [], paints: 0, failed: null,
      // While the garment moves, the canvas may draw fewer pixels to keep the motion fluid; at rest it draws them all.
      boost: 1, moving: false, recent: [], still: 0,
    };
    var root = new B.TransformNode('pd3-root', scene);
    var garment = null, panels = {}, trims = [], seamLines = [], ground = null, lights = [], knit = {};

    // ── materials ───────────────────────────────────────────────────────────
    /**
     * The mesh fabric's relief: a normal map of knit holes, one hole every 3.2 mm of the surface, so one texture per
     * panel size (a texture's repeat is its own). Drawn, uploaded and shared; disposed with the scene or the quality.
     */
    function knitTile(size) {
      var key = size.w + 'x' + size.h;
      if (knit[key]) return knit[key];
      var px = 64, t = new B.DynamicTexture('pd3-knit-' + key, { width: px, height: px }, scene, true);
      var ctx = t.getContext(), img = ctx.createImageData(px, px);
      for (var y = 0; y < px; y++) for (var x = 0; x < px; x++) {
        var dx = (x + 0.5) / px - 0.5, dy = (y + 0.5) / px - 0.5, d = Math.sqrt(dx * dx + dy * dy);
        var k = d < 0.28 ? (0.28 - d) / 0.28 : 0, nx = d ? -dx / d * k * 0.9 : 0, ny = d ? -dy / d * k * 0.9 : 0, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        var i = (y * px + x) * 4;
        img.data[i] = Math.round((nx * 0.5 + 0.5) * 255); img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255); img.data[i + 2] = Math.round(nz * 255); img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      t.update(false);
      t.wrapU = t.wrapV = B.Texture.WRAP_ADDRESSMODE;
      t.uScale = size.w / 3.2;
      t.vScale = size.h / 3.2;
      t.level = 0.55;
      knit[key] = t;
      return t;
    }
    function applyFabric(m) {
      if (state.fabric === 'mesh') {
        m.roughness = 0.86;
        m.sheen.intensity = 0.22;
        m.bumpTexture = knitTile(m.pdSize);
      } else {
        m.roughness = 0.58;
        m.sheen.intensity = 0.38;
        m.bumpTexture = null;
      }
    }
    function fabricMaterial(name, tex, size) {
      var m = new B.PBRMaterial(name, scene);
      m.albedoTexture = tex;
      m.useAlphaFromAlbedoTexture = true;
      m.transparencyMode = B.PBRMaterial.PBRMATERIAL_ALPHATEST;
      m.alphaCutOff = 0.5;
      m.metallic = 0;
      m.backFaceCulling = false;
      m.twoSidedLighting = true;
      m.environmentIntensity = 0;
      m.sheen.isEnabled = true;
      m.sheen.color = new B.Color3(1, 1, 1);
      m.pdSize = size;
      applyFabric(m);
      return m;
    }
    function plainMaterial(name, hex) {
      var m = new B.PBRMaterial(name, scene);
      m.albedoColor = B.Color3.FromHexString(hex).toLinearSpace();
      m.metallic = 0;
      m.roughness = 0.62;
      m.environmentIntensity = 0;
      m.sheen.isEnabled = true;
      m.sheen.intensity = 0.3;
      return m;
    }
    function surfaceTexture(name, size) {
      var q = QUALITY[state.quality];
      var px = [Math.max(8, Math.round(size.w * q.pxPerMm)), Math.max(8, Math.round(size.h * q.pxPerMm))];
      var tex = new B.DynamicTexture(name, { width: px[0], height: px[1] }, scene, true);
      tex.hasAlpha = true;
      tex.wrapU = tex.wrapV = B.Texture.CLAMP_ADDRESSMODE;
      tex.anisotropicFilteringLevel = 8;
      return { tex: tex, px: px };
    }

    // ── the garment ─────────────────────────────────────────────────────────
    function tube(name, path, radius, material, parent) {
      var pts = path.map(function (p) { return new B.Vector3(p[0], p[1], p[2]); });
      var t = B.MeshBuilder.CreateTube(name, { path: pts, radius: radius, tessellation: 10, cap: B.Mesh.CAP_ALL }, scene);
      t.material = material;
      t.parent = parent;
      t.isPickable = false;
      return t;
    }
    function trimMeshes(parent, colours, prefix) {
      var out = [], collar = plainMaterial(prefix + '-collar', colours.collar), cuffs = plainMaterial(prefix + '-cuffs', colours.cuffs);
      garment.trims.collar.forEach(function (line, i) { out.push(tube(prefix + '-collar-' + i, line, 0.0075, collar, parent)); });
      Object.keys(garment.trims.cuffs).forEach(function (id) { out.push(tube(prefix + '-cuff-' + id, garment.trims.cuffs[id], 0.0065, cuffs, parent)); });
      return out;
    }
    function disposeAll(list) { list.forEach(function (m) { m.dispose(false, true); }); }
    function build() {
      var q = QUALITY[state.quality];
      garment = G.build(opts.template, { rowMm: q.rowMm, cols: q.cols });
      garment.panels.forEach(function (p) {
        var mesh = new B.Mesh('pd3-' + p.surface, scene);
        var vd = new B.VertexData(), normals = [];
        B.VertexData.ComputeNormals(p.mesh.positions, p.mesh.indices, normals);
        vd.positions = p.mesh.positions; vd.indices = p.mesh.indices; vd.uvs = p.mesh.uvs; vd.normals = normals;
        vd.applyToMesh(mesh, false);
        mesh.parent = root;
        mesh.metadata = { surface: p.surface };
        var st = surfaceTexture('pd3-tex-' + p.surface, p.size);
        mesh.material = fabricMaterial('pd3-mat-' + p.surface, st.tex, p.size);
        panels[p.surface] = { mesh: mesh, tex: st.tex, size: p.size, px: st.px };
      });
      trims = trimMeshes(root, opts.colours, 'pd3');
      var seamColour = B.Color3.FromHexString(opts.seam || '#9aa4c4');
      seamLines = Object.keys(garment.seams).map(function (id) {
        var l = B.MeshBuilder.CreateLines('pd3-seam-' + id, { points: garment.seams[id].map(function (p) { return new B.Vector3(p[0], p[1], p[2]); }) }, scene);
        l.color = seamColour;
        l.parent = root;
        l.isPickable = false;
        l.isVisible = state.check;
        return l;
      });
      buildGround();
      state.builds++;
    }
    function buildGround() {
      // A soft contact shadow under the garment: a radial gradient on a disc, no shadow map.
      var size = 256, t = new B.DynamicTexture('pd3-shadow', { width: size, height: size }, scene, false);
      var ctx = t.getContext(), g = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(0,0,0,0.5)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      t.update(false);
      t.hasAlpha = true;
      var m = new B.StandardMaterial('pd3-shadow-mat', scene);
      m.diffuseTexture = t;
      m.useAlphaFromDiffuseTexture = true;
      m.disableLighting = true;
      ground = B.MeshBuilder.CreateDisc('pd3-ground', { radius: 0.46, tessellation: 48 }, scene);
      ground.rotation.x = Math.PI / 2;
      ground.position.y = garment.bounds.min[1] - 0.02;
      ground.scaling.y = 0.55;
      ground.material = m;
      ground.isPickable = false;
    }

    // ── light ───────────────────────────────────────────────────────────────
    function setLighting(name) {
      if (LIGHTS.indexOf(name) === -1) return false;
      state.lighting = name;
      lights.forEach(function (l) { l.dispose(); });
      lights = [];
      function hemi(i, sky, groundC) { var l = new B.HemisphericLight('pd3-hemi', new B.Vector3(0, 1, 0), scene); l.intensity = i; l.diffuse = B.Color3.FromHexString(sky); l.groundColor = B.Color3.FromHexString(groundC); l.specular = new B.Color3(0, 0, 0); lights.push(l); }
      function dir(i, hex, x, y, z) { var l = new B.DirectionalLight('pd3-dir', new B.Vector3(x, y, z), scene); l.intensity = i; l.diffuse = B.Color3.FromHexString(hex); lights.push(l); }
      if (name === 'studio') {
        hemi(0.7, '#e6e9f5', '#262c48');
        dir(1.9, '#ffffff', 0.45, -0.55, 0.9);   // key, from the front left and above
        dir(0.8, '#d6ddff', -0.7, -0.2, 0.6);    // fill
        dir(1.2, '#ffffff', 0, -0.3, -1);        // rim, from behind
      } else if (name === 'daylight') {
        hemi(1.0, '#d4e6ff', '#6b5a48');
        dir(2.2, '#fff3df', -0.35, -0.85, 0.55); // the sun, high and warm
      } else {
        hemi(0.35, '#a7bbff', '#0b1020');
        dir(1.1, '#eef3ff', 0.6, -0.75, 0.6);
        dir(1.1, '#eef3ff', -0.6, -0.75, 0.6);
        dir(0.9, '#eef3ff', 0.6, -0.75, -0.6);
        dir(0.9, '#eef3ff', -0.6, -0.75, -0.6);
      }
      dirty();
      return true;
    }

    // ── the camera ──────────────────────────────────────────────────────────
    var P0 = G.PRESETS.front;
    var camera = new B.ArcRotateCamera('pd3-cam', P0.alpha, P0.beta, P0.radius, new B.Vector3(0, 0, 0), scene);
    camera.lowerRadiusLimit = 0.35;
    camera.upperRadiusLimit = 3.6;
    camera.lowerBetaLimit = 0.15;
    camera.upperBetaLimit = Math.PI - 0.15;
    camera.wheelDeltaPercentage = 0.01;
    camera.pinchDeltaPercentage = 0.004;
    camera.panningSensibility = 0;
    camera.minZ = 0.02;
    camera.fov = 0.6;
    // The editor drives the keyboard (its canvas keeps the focus); Babylon's own keys would answer twice.
    camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
    camera.attachControl(canvas, false);
    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    function goTo(p, instant) {
      var target = p.target ? new B.Vector3(p.target[0], p.target[1], p.target[2]) : new B.Vector3(0, 0, 0);
      var a = camera.alpha, b = p.alpha, twoPi = 2 * Math.PI;
      // The short way round.
      while (b - a > Math.PI) b -= twoPi;
      while (a - b > Math.PI) b += twoPi;
      camera.inertialAlphaOffset = camera.inertialBetaOffset = camera.inertialRadiusOffset = 0;
      if (instant || reduced) {
        camera.alpha = b; camera.beta = p.beta; camera.radius = p.radius; camera.setTarget(target, false, false, true);
        state.anim = null;
      } else {
        state.anim = { t0: now(), dur: 520, from: { a: a, b: camera.beta, r: camera.radius, t: camera.target.clone() }, to: { a: b, b: p.beta, r: p.radius, t: target } };
      }
      dirty();
    }
    function preset(name, instant) {
      var p = garment.presets[name];
      if (!p) return false;
      setTurntable(false);
      state.preset = name;
      goTo(state.compare ? { alpha: p.alpha, beta: p.beta, radius: G.PRESETS.front.radius + 1.1 } : p, instant);
      return true;
    }
    /** A close-up: face a point of a surface, given in its millimetres, from outside. */
    function focus(surface, x, y) {
      var at = garment && garment.mappers[surface];
      if (!at) return false;
      var p = at(x, y), n = G.outward(at, x, y), o = root.position;
      setTurntable(false);
      state.preset = null;
      goTo(G.facing([p[0] + o.x, p[1] + o.y, p[2] + o.z], n, 0.62));
      return true;
    }
    function orbit(da, db) {
      setTurntable(false);
      state.anim = null;
      state.preset = null;
      camera.alpha += da;
      camera.beta = Math.min(camera.upperBetaLimit, Math.max(camera.lowerBetaLimit, camera.beta + db));
      dirty();
    }
    function zoom(f) {
      state.anim = null;
      camera.radius = Math.min(camera.upperRadiusLimit, Math.max(camera.lowerRadiusLimit, camera.radius * f));
      dirty();
    }
    /** The 360° turntable. A reader who asked for reduced motion is not given one. */
    function setTurntable(on) {
      state.turntable = !!on && !reduced;
      camera.useAutoRotationBehavior = state.turntable;
      if (state.turntable) {
        camera.autoRotationBehavior.idleRotationSpeed = 0.42;
        camera.autoRotationBehavior.idleRotationWaitTime = 0;
        camera.autoRotationBehavior.idleRotationSpinupTime = 400;
        state.preset = null;
      }
      dirty();
      return state.turntable;
    }

    // ── textures: the editor's own drawing, painted onto each panel ─────────
    function drawSvg(text, target, px, done) {
      var url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
      state.urls.push(url);
      var img = new Image();
      function finish(ok) {
        URL.revokeObjectURL(url);
        state.urls = state.urls.filter(function (u) { return u !== url; });
        done(ok);
      }
      img.onload = function () {
        if (state.disposed) { finish(false); return; }
        try {
          var ctx = target.getContext();
          ctx.clearRect(0, 0, px[0], px[1]);
          ctx.drawImage(img, 0, 0, px[0], px[1]);
          target.update(true);
          finish(true);
        } catch (_) { finish(false); }
      };
      img.onerror = function () { finish(false); };
      img.src = url;
    }
    function paint(id) {
      var p = panels[id], t = now(), text;
      state.painting[id] = true;
      try { text = opts.texture(id, p.px[0], p.px[1]); } catch (_) { text = null; }
      if (!text) { state.painting[id] = false; fail('texture'); return; }
      drawSvg(text, p.tex, p.px, function (ok) {
        state.painting[id] = false;
        if (state.disposed) return;
        if (!ok) { fail('texture'); return; }
        state.paints++;
        push(state.textureMs, now() - t, 60);
        dirty();
        if (state.want[id]) schedule();
      });
    }
    function flush() {
      state.raf = 0;
      Object.keys(state.want).forEach(function (id) {
        if (state.want[id] && !state.painting[id] && panels[id]) { state.want[id] = false; paint(id); }
      });
    }
    function schedule() { if (!state.raf && !state.disposed) state.raf = window.requestAnimationFrame(flush); }
    /** Ask for these surfaces (all, by default) to be painted again: one image in flight per surface, the newest wins. */
    function invalidate(ids) {
      (ids && ids.length ? ids : Object.keys(panels)).forEach(function (id) { if (panels[id]) state.want[id] = true; });
      schedule();
    }
    function pending() {
      return Object.keys(panels).some(function (id) { return state.want[id] || state.painting[id]; });
    }
    function fail(code) {
      if (state.failed || state.disposed) return;
      state.failed = code;
      if (opts.onError) opts.onError(code);
    }
    function setColours(c) {
      opts.colours = c;
      disposeAll(trims);
      trims = trimMeshes(root, c, 'pd3');
      dirty();
    }

    // ── comparing with a saved version: a second garment beside this one ────
    function label(text, name) {
      var w = 512, h = 96, t = new B.DynamicTexture(name + '-tex', { width: w, height: h }, scene, false);
      var ctx = t.getContext();
      ctx.clearRect(0, 0, w, h);
      ctx.font = '600 40px ' + (opts.font || 'sans-serif');
      ctx.direction = opts.dir === 'rtl' ? 'rtl' : 'ltr';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(232,236,250,0.94)';
      ctx.fillText(text, w / 2, h / 2, w - 24);
      t.update(true);
      t.hasAlpha = true;
      var m = new B.StandardMaterial(name + '-mat', scene);
      m.diffuseTexture = t;
      m.emissiveColor = new B.Color3(1, 1, 1);
      m.useAlphaFromDiffuseTexture = true;
      m.disableLighting = true;
      var plane = B.MeshBuilder.CreatePlane(name, { width: 0.4, height: 0.075 }, scene);
      plane.material = m;
      plane.billboardMode = B.Mesh.BILLBOARDMODE_ALL;
      plane.isPickable = false;
      return plane;
    }
    function clearCompare() {
      if (!state.compare) return;
      disposeAll(state.compare.nodes);
      state.compare = null;
      root.position.x = 0;
      if (ground) ground.scaling.x = 1;
    }
    /**
     * Show another version of the design beside this one (`texture(surface, w, h)` draws
     * that version), or stop when `texture` is null. Neither design is changed by it.
     */
    function setCompare(texture, colours, labels) {
      clearCompare();
      if (!texture) { preset(state.preset || 'front'); return true; }
      var other = new B.TransformNode('pd3-compare', scene), nodes = [other];
      garment.panels.forEach(function (pg) {
        var m = panels[pg.surface].mesh.clone('pd3-cmp-' + pg.surface, other);
        m.isPickable = false;
        m.metadata = null;
        var st = surfaceTexture('pd3-cmp-tex-' + pg.surface, pg.size);
        m.material = fabricMaterial('pd3-cmp-mat-' + pg.surface, st.tex, pg.size);
        nodes.push(m);
        var text = null;
        try { text = texture(pg.surface, st.px[0], st.px[1]); } catch (_) { text = null; }
        if (text) drawSvg(text, st.tex, st.px, function () { dirty(); });
      });
      nodes = nodes.concat(trimMeshes(other, colours, 'pd3-cmp'));
      root.position.x = -COMPARE_OFFSET;
      other.position.x = COMPARE_OFFSET;
      ground.scaling.x = 2.4;
      var top = garment.bounds.max[1] + 0.08;
      var a = label(labels.current, 'pd3-label-current'), b = label(labels.other, 'pd3-label-other');
      a.position.set(-COMPARE_OFFSET, top, 0);
      b.position.set(COMPARE_OFFSET, top, 0);
      nodes.push(a, b);
      state.compare = { nodes: nodes };
      setTurntable(false);
      state.preset = 'front';
      goTo({ alpha: G.PRESETS.front.alpha, beta: G.PRESETS.front.beta, radius: G.PRESETS.front.radius + 1.1 });
      return true;
    }

    // ── the print check: seam lines on the garment (the editor draws the rest into the artwork) ──
    function setCheck(on) {
      state.check = !!on;
      seamLines.forEach(function (l) { l.isVisible = state.check; });
      dirty();
    }

    // ── fabric and quality ──────────────────────────────────────────────────
    function setFabric(name) {
      if (FABRICS.indexOf(name) === -1) return false;
      state.fabric = name;
      scene.materials.forEach(function (m) { if (m.pdSize) applyFabric(m); });
      dirty();
      return true;
    }
    /** A new quality level rebuilds the meshes and textures and asks for every surface again. */
    function setQuality(name) {
      if (!QUALITY[name] || name === state.quality) return false;
      state.quality = name;
      clearCompare();
      Object.keys(panels).forEach(function (k) { panels[k].mesh.dispose(false, true); });
      disposeAll(trims);
      seamLines.forEach(function (l) { l.dispose(); });
      if (ground) ground.dispose(false, true);
      Object.keys(knit).forEach(function (k) { knit[k].dispose(); });
      knit = {};
      panels = {};
      state.want = {};
      build();
      scaling();
      invalidate();
      return true;
    }
    function baseScaling() { var s = QUALITY[state.quality].scaling; return s || 1 / Math.min(2, window.devicePixelRatio || 1); }
    function scaling() {
      engine.setHardwareScalingLevel(baseScaling() * (state.moving ? state.boost : 1));
      engine.resize();
      dirty();
    }
    /**
     * Adaptive resolution in motion: when frames in motion come slower than 40 ms (a weak or software GPU), the canvas
     * draws fewer pixels, a step at a time, down to a third of its linear resolution; the level learnt is kept for the
     * next motion. The first frame at rest is drawn at full resolution, so a still garment is always sharp.
     */
    function adapt(inMotion, interval) {
      if (inMotion) {
        state.still = 0;
        if (!state.moving) { state.moving = true; state.recent = []; if (state.boost > 1) scaling(); return; }
        if (interval) state.recent.push(interval);
        if (state.recent.length >= 8) {
          var m = median(state.recent);
          state.recent = [];
          var next = m > 40 ? Math.min(3, state.boost * 1.25) : m < 22 && state.boost > 1 ? Math.max(1, state.boost / 1.25) : state.boost;
          if (next !== state.boost) { state.boost = next; scaling(); }
        }
      } else if (state.moving && ++state.still > 2) {
        state.moving = false;
        if (state.boost > 1) scaling();
      }
    }

    // ── pointer: pick an element, drag it across its surface ────────────────
    function pickAt(x, y, only) {
      var hit = scene.pick(x, y, function (m) { return !!(m.metadata && m.metadata.surface) && (!only || m === only); });
      if (!hit || !hit.hit) return null;
      var uv = hit.getTextureCoordinates();
      if (!uv) return null;
      var surface = hit.pickedMesh.metadata.surface, size = panels[surface].size;
      return { surface: surface, mesh: hit.pickedMesh, mm: { x: uv.x * size.w, y: (1 - uv.y) * size.h } };
    }
    function local(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function onDragMove(e) {
      var d = state.drag;
      if (!d || e.pointerId !== d.id) return;
      var p = local(e);
      if (!d.moved && Math.abs(p.x - d.x) + Math.abs(p.y - d.y) < 3) return;
      d.moved = true;
      var h = pickAt(p.x, p.y, d.mesh);
      if (h && opts.onDrag) opts.onDrag(d.surface, h.mm);
    }
    function onDragEnd(e) {
      var d = state.drag;
      if (!d || (e && e.pointerId !== d.id)) return;
      state.drag = null;
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragEnd);
      window.removeEventListener('pointercancel', onDragEnd);
      if (!state.disposed) camera.attachControl(canvas, false);
      if (opts.onDrop) opts.onDrop(d.moved);
    }
    // A press is read from Babylon's pick; the drag it starts follows the DOM pointer to its release, wherever that is.
    scene.onPointerObservable.add(function (pi) {
      var e = pi.event;
      if (e.button !== 0 || !opts.onPick || state.drag) return;
      var hit = pickAt(scene.pointerX, scene.pointerY);
      if (!hit) { opts.onPick(null, null); return; }
      if (opts.onPick(hit.surface, hit.mm)) {
        state.drag = { id: e.pointerId, surface: hit.surface, mesh: hit.mesh, moved: false, x: scene.pointerX, y: scene.pointerY };
        camera.detachControl();
        window.addEventListener('pointermove', onDragMove);
        window.addEventListener('pointerup', onDragEnd);
        window.addEventListener('pointercancel', onDragEnd);
      }
    }, B.PointerEventTypes.POINTERDOWN);
    camera.onViewMatrixChangedObservable.add(function () { dirty(); });

    /** Where a point of a surface, in its millimetres, appears on the canvas, in CSS pixels, and whether it faces the camera. */
    function project(surface, x, y) {
      var at = garment && garment.mappers[surface];
      if (!at) return null;
      var p = at(x, y), o = root.position, v = new B.Vector3(p[0] + o.x, p[1] + o.y, p[2] + o.z);
      var vp = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
      var s = B.Vector3.Project(v, B.Matrix.Identity(), scene.getTransformMatrix(), vp), k = engine.getHardwareScalingLevel();
      var n = G.outward(at, x, y), e = camera.position;
      var facing = n[0] * (e.x - v.x) + n[1] * (e.y - v.y) + n[2] * (e.z - v.z) > 0;
      return { x: s.x * k, y: s.y * k, facing: facing };
    }

    // ── drawing: only when something changed ────────────────────────────────
    function dirty() { state.dirty = Math.max(state.dirty, 2); }
    /** The field of view holds on the canvas's narrower side, so the whole garment fits a tall canvas and a wide one alike. */
    function fit() {
      camera.fovMode = engine.getRenderWidth() < engine.getRenderHeight() ? B.Camera.FOVMODE_HORIZONTAL_FIXED : B.Camera.FOVMODE_VERTICAL_FIXED;
      dirty();
    }
    var observer = null;
    if (window.ResizeObserver) {
      observer = new ResizeObserver(function () { if (!state.disposed) { engine.resize(); fit(); } });
      observer.observe(host);
    }
    function frame() {
      if (state.anim) {
        var a = state.anim, t = Math.min(1, (now() - a.t0) / a.dur), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        camera.alpha = a.from.a + (a.to.a - a.from.a) * e;
        camera.beta = a.from.b + (a.to.b - a.from.b) * e;
        camera.radius = a.from.r + (a.to.r - a.from.r) * e;
        camera.setTarget(B.Vector3.Lerp(a.from.t, a.to.t, e), false, false, true);
        if (t >= 1) state.anim = null;
        state.dirty = Math.max(state.dirty, 1);
      }
      var moving = !!(camera.inertialAlphaOffset || camera.inertialBetaOffset || camera.inertialRadiusOffset || state.anim || state.turntable || state.drag);
      if (!state.dirty && !moving) { adapt(false); state.lastFrame = 0; return; }
      if (state.dirty) state.dirty--;
      var f0 = now();
      scene.render();
      var f1 = now(), interval = state.lastFrame && f1 - state.lastFrame < 250 ? f1 - state.lastFrame : 0;
      push(state.frameMs, f1 - f0, 240);
      if (interval) push(state.intervals, interval, 240);
      state.lastFrame = f1;
      state.renders++;
      adapt(moving, interval);
    }
    engine.runRenderLoop(frame);

    build();
    scaling();
    fit();
    setLighting('studio');
    invalidate();
    var readyMs = now() - t0;

    function dispose() {
      if (state.disposed) return;
      state.disposed = true;
      onDragEnd(null);
      if (state.raf) window.cancelAnimationFrame(state.raf);
      if (observer) observer.disconnect();
      state.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (_) {} });
      state.urls = [];
      engine.stopRenderLoop();
      scene.dispose();
      engine.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }

    return {
      canvas: canvas, invalidate: invalidate, pending: pending, setColours: setColours,
      preset: preset, focus: focus, orbit: orbit, zoom: zoom, setTurntable: setTurntable,
      setLighting: setLighting, setFabric: setFabric, setQuality: setQuality, setCheck: setCheck, setCompare: setCompare,
      project: project, resize: function () { engine.resize(); dirty(); }, dispose: dispose,
      /** Read-only figures: what the browser proof measures. */
      metrics: function () {
        var iv = state.intervals;
        return {
          readyMs: readyMs, quality: state.quality, lighting: state.lighting, fabric: state.fabric, check: state.check, turntable: state.turntable,
          preset: state.preset, compare: !!state.compare, failed: state.failed, disposed: state.disposed, builds: state.builds,
          meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length, vertices: scene.getTotalVertices(),
          renders: state.renders, frameMsMedian: median(state.frameMs), frameMsP95: p95(state.frameMs),
          intervalMsMedian: median(iv), intervalMsP95: p95(iv), intervals: iv.length, lastIntervals: iv.slice(-45).map(function (x) { return Math.round(x * 10) / 10; }),
          paints: state.paints, pending: pending(), textureMsMedian: median(state.textureMs), textureMsMax: state.textureMs.length ? Math.max.apply(null, state.textureMs) : null,
          texturePx: Object.keys(panels).map(function (k) { return [k, panels[k].px[0], panels[k].px[1]]; }),
          camera: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius }, scaling: engine.getHardwareScalingLevel(), motionScale: state.boost, moving: state.moving,
          webgl: engine.webGLVersion, objectUrls: state.urls.length,
        };
      },
    };
  }

  window.FamilistaProductDesign3D = Object.freeze({ open: open, webglAvailable: webglAvailable, QUALITY: Object.keys(QUALITY), LIGHTS: LIGHTS, FABRICS: FABRICS });
}());

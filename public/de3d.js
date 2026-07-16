/* ════════════════════════════════════════════════════════════════════════════
   Familista — Drill Presentation Engine (genuine 3D, Babylon.js)
   Lazy-loaded only when a timeline drill is opened. Renders real GLB rigged
   humanoid players (skinned mesh + skeleton + skeletal walk animation), a PBR
   pitch with real directional light + shadows, a 3D ball, multiple smooth
   cameras and tactical overlays — driven entirely by the shared _DE_TL timeline.
   Exposes the SAME api surface as the 2.5D engine (+ ready/dispose/fps/info) so
   _dePlay can wire the existing controls and fall back on any failure.
   Assets: Babylon.js (Apache-2.0), player.glb = Khronos "CesiumMan" (CC-BY 4.0).
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var B = null; // BABYLON
  function has() { return typeof window !== 'undefined' && window.BABYLON; }

  window._de3dApi = function (host, tl, ac, drill, opts) {
    opts = opts || {};
    B = window.BABYLON;
    var canvas = host.querySelector('.de-pl-canvas');
    var capEl = host.querySelector('.de-pl-cap-t'), camEl = host.querySelector('.de-pl-cam');
    var stTitleEl = host.querySelector('.de-pl-steptitle'), stNumEl = host.querySelector('.de-pl-stepnum');
    var stepsEls = host.querySelectorAll('.de-pl-step');
    var accent = (ac || '52,215,122').split(',').map(Number);
    var TEAM = { att: [56, 120, 224], def: [214, 66, 66], gk: [244, 192, 78] };

    // ── timeline math (ported; identical semantics to the 2.5D engine) ──
    var steps = tl.steps, N = steps.length, players = tl.players, ball = tl.ball;
    var bounds = [], acc = 0; for (var i = 0; i < N; i++) { bounds.push(acc); acc += (steps[i].dur || 3.5); } var TOTAL = acc; bounds.push(acc);
    function c01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
    function easeF(u) { u = c01(u); return u * u * (3 - 2 * u); }
    function smoother(u) { u = c01(u); return u * u * u * (u * (u * 6 - 15) + 10); }
    function outEase(u) { u = c01(u); return 1 - (1 - u) * (1 - u); }
    function trk(pl, i) { var a = pl.track; return a[Math.min(i, a.length - 1)]; }
    function posAt(pl, st, lo) { var f = steps[st].freeze ? 1 : lo, e = smoother(f), a = trk(pl, st), b = trk(pl, st + 1); if (pl.bend && pl.bend[st]) { var bd = pl.bend[st], mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, cx = mx - dz / l * bd, cz = mz + dx / l * bd, k = 1 - e; return [k * k * a[0] + 2 * k * e * cx + e * e * b[0], k * k * a[1] + 2 * k * e * cz + e * e * b[1]]; } return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e]; }
    function ballAt(st, lo) { var a = ball.track[Math.min(st, ball.track.length - 1)], b = ball.track[Math.min(st + 1, ball.track.length - 1)], ty = (ball.seg && ball.seg[st]) || 'pass'; if (ty === 'cut') return [b[0], 0, b[1]]; if (ty === 'hold') return [a[0], 0, a[1]]; var f = steps[st].freeze ? 1 : lo, e = ty === 'pass' ? outEase(f) : ty === 'carry' ? easeF(f) : outEase(f), arc = ty === 'loft' ? 4.5 * Math.sin(Math.PI * f) : 0; return [a[0] + (b[0] - a[0]) * e, arc, a[1] + (b[1] - a[1]) * e]; }
    function stepAt() { var tt = c01(t / TOTAL) * TOTAL; for (var i = N - 1; i >= 0; i--) if (tt >= bounds[i]) return i; return 0; }
    function frac(st) { var d = steps[st].dur || 3.5; return c01((t - bounds[st]) / d); }
    // pitch(0..105,0..68) → world (centre origin, Y up)
    function WX(x) { return x - 52.5; } function WZ(z) { return z - 34; }

    // ── state ──
    var t = 0, playing = false, speed = 1, muted = false, disposed = false, lastStep = -1, lastCap = -1, lastCam = '';
    var camOverride = null, MODE_LB = { tactical: 'TACTICAL', broadcast: 'BROADCAST', top: 'TOP VIEW', side: 'SIDE VIEW', focus: 'FOCUS' }, MODES = ['broadcast', 'tactical', 'top', 'side', 'focus'];
    var engine = null, scene = null, cam = null, shadow = null, cb = null, playerNodes = [], ballMesh = null, container = null;
    var camPos = null, camTgt = null, zonePlane = null, zoneLabel = null, passLine = null, runLine = null, engType = 'webgl';
    var walkH = 1.8, footY = 0, MODEL_YAW = Math.PI; // CesiumMan forward calibration

    function col3(a) { return new B.Color3(a[0] / 255, a[1] / 255, a[2] / 255); }

    // ── PBR pitch with drawn markings ──
    function buildPitch() {
      var W = 105, Hh = 68;
      var ground = B.MeshBuilder.CreateGround('pitch', { width: W, height: Hh, subdivisions: 2 }, scene);
      var dt = new B.DynamicTexture('pitchTex', { width: 2048, height: 1327 }, scene, true);
      var c = dt.getContext(), TW = 2048, TH = 1327, sx = TW / W, sz = TH / Hh;
      for (var s = 0; s < 14; s++) { c.fillStyle = s % 2 ? '#2a8f4c' : '#238544'; c.fillRect(s * TW / 14, 0, TW / 14 + 1, TH); }
      c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 5; c.strokeRect(18, 18, TW - 36, TH - 36);
      c.beginPath(); c.moveTo(TW / 2, 18); c.lineTo(TW / 2, TH - 18); c.stroke();
      c.beginPath(); c.arc(TW / 2, TH / 2, 9.15 * sx, 0, 6.283); c.stroke();
      c.beginPath(); c.arc(TW / 2, TH / 2, 6, 0, 6.283); c.fillStyle = '#fff'; c.fill();
      function box(x0, z0, w, h) { c.strokeRect(x0 * sx, z0 * sz, w * sx, h * sz); }
      box(0, 13.85, 16.5, 40.3); box(105 - 16.5, 13.85, 16.5, 40.3); box(0, 24.85, 5.5, 18.3); box(105 - 5.5, 24.85, 5.5, 18.3);
      dt.update();
      var m = new B.PBRMaterial('pitchMat', scene); m.albedoTexture = dt; m.metallic = 0; m.roughness = 0.92; m.specularIntensity = 0.25; ground.material = m; ground.receiveShadows = true;
      // goals
      [-52.5, 52.5].forEach(function (gx) { var gm = new B.PBRMaterial('gm', scene); gm.albedoColor = new B.Color3(0.95, 0.96, 0.98); gm.metallic = 0.1; gm.roughness = 0.6; var w = 3.66; [[gx, -w], [gx, w]].forEach(function (p) { var post = B.MeshBuilder.CreateCylinder('post', { height: 2.44, diameter: 0.28 }, scene); post.position = new B.Vector3(p[0], 1.22, p[1]); post.material = gm; shadow && shadow.addShadowCaster(post); }); var bar = B.MeshBuilder.CreateCylinder('bar', { height: 2 * w, diameter: 0.28 }, scene); bar.rotation.x = Math.PI / 2; bar.position = new B.Vector3(gx, 2.44, 0); bar.material = gm; });
    }

    function numberTexture(team, num) {
      var dt = new B.DynamicTexture('num', { width: 128, height: 128 }, scene, false); var c = dt.getContext(); c.clearRect(0, 0, 128, 128);
      var t3 = TEAM[team] || [150, 160, 180]; c.fillStyle = 'rgba(' + t3[0] + ',' + t3[1] + ',' + t3[2] + ',.96)'; c.beginPath(); c.arc(64, 64, 54, 0, 6.283); c.fill(); c.lineWidth = 6; c.strokeStyle = 'rgba(255,255,255,.95)'; c.stroke();
      if (num !== '' && num != null) { c.fillStyle = team === 'gk' ? '#0a0f16' : '#fff'; c.font = '800 64px Inter,Arial,sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(num), 64, 68); }
      dt.hasAlpha = true; dt.update(); return dt;
    }

    // ── build one player from the shared GLB (genuine skinned mesh + skeleton + walk anim) ──
    function makePlayer(pl, idx) {
      var inst = container.instantiateModelsToScene(function (n) { return n + '_p' + idx; }, false, { doNotInstantiate: false });
      var root = inst.rootNodes[0];
      root.scaling = new B.Vector3(scaleUnit, scaleUnit, scaleUnit);
      var t3 = TEAM[pl.team] || [150, 160, 180];
      var mat = new B.PBRMaterial('kit_p' + idx, scene); mat.albedoColor = col3(t3); mat.metallic = 0.0; mat.roughness = 0.75;
      inst.rootNodes.forEach(function (rn) { (rn.getChildMeshes ? rn.getChildMeshes() : []).forEach(function (me) { me.material = mat; me.receiveShadows = true; if (shadow) shadow.addShadowCaster(me); }); });
      var ag = inst.animationGroups && inst.animationGroups[0]; if (ag) { ag.play(true); ag.speedRatio = 0.0001; }
      // number billboard above head
      var lbl = B.MeshBuilder.CreatePlane('lbl_p' + idx, { size: 1.15 }, scene); var lm = new B.StandardMaterial('lm' + idx, scene); lm.diffuseTexture = numberTexture(pl.team, pl.n); lm.opacityTexture = lm.diffuseTexture; lm.emissiveColor = new B.Color3(1, 1, 1); lm.disableLighting = true; lm.backFaceCulling = false; lbl.material = lm; lbl.billboardMode = B.Mesh.BILLBOARDMODE_ALL; lbl.parent = root; lbl.position = new B.Vector3(0, (walkH + 0.7) / scaleUnit, 0);
      return { pl: pl, root: root, ag: ag, prev: posAt(pl, 0, 0) };
    }
    var scaleUnit = 1;

    // ── overlays (3D, ground-projected so they read from every camera) ──
    function ensureOverlays() {
      zonePlane = B.MeshBuilder.CreateGround('zone', { width: 1, height: 1 }, scene); var zm = new B.StandardMaterial('zm', scene); zm.diffuseColor = col3(accent); zm.emissiveColor = col3(accent); zm.alpha = 0.16; zm.disableLighting = true; zonePlane.material = zm; zonePlane.position.y = 0.03; zonePlane.setEnabled(false);
      zoneLabel = B.MeshBuilder.CreatePlane('zlbl', { size: 6 }, scene); var zlm = new B.StandardMaterial('zlm', scene); zlm.emissiveColor = new B.Color3(1, 1, 1); zlm.disableLighting = true; zlm.backFaceCulling = false; zoneLabel.material = zlm; zoneLabel.billboardMode = B.Mesh.BILLBOARDMODE_ALL; zoneLabel.position.y = 1.6; zoneLabel.setEnabled(false);
    }
    function labelTex(text) { var dt = new B.DynamicTexture('zt', { width: 512, height: 128 }, scene, false); var c = dt.getContext(); c.clearRect(0, 0, 512, 128); c.font = '700 44px Inter,Arial,sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; var tw = c.measureText(text).width + 40; c.fillStyle = 'rgba(8,13,20,.82)'; c.fillRect(256 - tw / 2, 30, tw, 68); c.fillStyle = 'rgb(' + accent[0] + ',' + accent[1] + ',' + accent[2] + ')'; c.fillText(text.toUpperCase(), 256, 66); dt.hasAlpha = true; dt.update(); return dt; }
    function drawLine(mesh, a, b, color) { var pts = [new B.Vector3(WX(a[0]), 0.2, WZ(a[1])), new B.Vector3(WX(b[0]), 0.2, WZ(b[1]))]; if (mesh) { return B.MeshBuilder.CreateLines(null, { points: pts, instance: mesh }); } var lm = B.MeshBuilder.CreateLines('ln', { points: pts, updatable: true }, scene); lm.color = new B.Color3(color[0] / 255, color[1] / 255, color[2] / 255); return lm; }
    function updateOverlays(st, lo) {
      var ov = steps[st].overlays || {};
      if (ov.zone) { var z = ov.zone; zonePlane.setEnabled(true); zonePlane.scaling.x = z[2]; zonePlane.scaling.z = z[3]; zonePlane.position.x = WX(z[0] + z[2] / 2); zonePlane.position.z = WZ(z[1] + z[3] / 2); if (z[4]) { zoneLabel.setEnabled(true); if (zoneLabel._lbl !== z[4]) { zoneLabel.material.diffuseTexture = labelTex(z[4]); zoneLabel.material.opacityTexture = zoneLabel.material.diffuseTexture; zoneLabel._lbl = z[4]; } zoneLabel.position.x = WX(z[0] + z[2] / 2); zoneLabel.position.z = WZ(z[1]); } else zoneLabel.setEnabled(false); } else { zonePlane.setEnabled(false); zoneLabel.setEnabled(false); }
      if (ov.pass && ov.pass[0]) { var A = posAt(players[ov.pass[0][0]], st, lo), Bp = posAt(players[ov.pass[0][1]], st, lo); passLine = drawLine(passLine, A, Bp, accent); passLine.setEnabled(true); } else if (passLine) passLine.setEnabled(false);
      if (ov.run && ov.run.length) { var pl = players[ov.run[0]]; runLine = drawLine(runLine, trk(pl, st), trk(pl, st + 1), [234, 255, 242]); runLine.setEnabled(true); } else if (runLine) runLine.setEnabled(false);
    }

    // ── cameras ──
    function preset(md, b) {
      var fx = b ? WX(b[0]) : 0, fz = b ? WZ(b[2]) : 0;
      if (md === 'tactical') return { p: [0, 58, -40], t: [0, 0, 4], fov: 0.8 };
      if (md === 'top') return { p: [0, 82, 0.2], t: [0, 0, 0], fov: 0.8 };
      if (md === 'side') return { p: [0, 15, -54], t: [0, 1.2, 0], fov: 0.82 };
      if (md === 'focus') return { p: [fx - 3, 13, fz - 20], t: [fx, 1.2, fz], fov: 0.6 };
      return { p: [fx * 0.4 - 4, 24, -50], t: [fx * 0.55, 1.2, fz * 0.5], fov: 0.82 }; // broadcast
    }
    function applyCam(md, b, snap) {
      var pr = preset(md, b), P = new B.Vector3(pr.p[0], pr.p[1], pr.p[2]), Tt = new B.Vector3(pr.t[0], pr.t[1], pr.t[2]);
      if (!camPos || snap) { camPos = P.clone(); camTgt = Tt.clone(); } else { var k = 0.06; camPos = B.Vector3.Lerp(camPos, P, k); camTgt = B.Vector3.Lerp(camTgt, Tt, k); }
      cam.position.copyFrom(camPos); cam.setTarget(camTgt); cam.fov = cam.fov + (pr.fov - cam.fov) * 0.1;
    }

    function updateFrame(snap) {
      if (disposed || !scene) return; var st = stepAt(), lo = frac(st), b = ballAt(st, lo);
      for (var m = 0; m < playerNodes.length; m++) { var pn = playerNodes[m], p = posAt(pn.pl, st, lo); pn.root.position.x = WX(p[0]); pn.root.position.z = WZ(p[1]); pn.root.position.y = footY; var vx = p[0] - pn.prev[0], vz = p[1] - pn.prev[1], sp = Math.hypot(vx, vz); if (sp > 0.006) { pn.root.rotation.y = Math.atan2(vx, vz) + MODEL_YAW; } if (pn.ag) pn.ag.speedRatio = playing ? Math.min(2.4, 0.15 + sp * 34) : Math.max(0.0001, Math.min(2.4, sp * 34)); pn.prev = p; }
      if (ballMesh) { ballMesh.position.x = WX(b[0]); ballMesh.position.y = 0.32 + b[1]; ballMesh.position.z = WZ(b[2]); }
      updateOverlays(st, lo);
      applyCam(camOverride || steps[st].cam || 'broadcast', b, snap);
      // HUD
      var sd = steps[st];
      if (capEl && sd.note !== lastCap) { capEl.textContent = sd.note; lastCap = sd.note; }
      if (stTitleEl && st !== lastStep) { var tone = /mistake/i.test(sd.title) ? 'bad' : /correct/i.test(sd.title) ? 'good' : 'info'; stTitleEl.textContent = sd.title; stTitleEl.className = 'de-pl-steptitle de-tone-' + tone; if (stNumEl) stNumEl.textContent = 'STEP ' + (st + 1) + ' / ' + N; }
      var md = camOverride || sd.cam || 'broadcast'; if (camEl && MODE_LB[md] !== lastCam) { camEl.textContent = MODE_LB[md]; lastCam = MODE_LB[md]; }
      if (stepsEls.length && st !== lastStep) for (var q = 0; q < stepsEls.length; q++) stepsEls[q].classList.toggle('is-on', q === st);
      lastStep = st;
    }
    function emit() { if (cb) cb(t, TOTAL, playing, { step: stepAt(), steps: N, cam: (camOverride || steps[stepAt()].cam), camLabel: MODE_LB[camOverride || steps[stepAt()].cam] }); }

    // ── async init: engine (WebGPU→WebGL) + scene + GLB ──
    var readyCbs = [], readyState = null;
    function fireReady(ok) { readyState = ok; readyCbs.forEach(function (f) { try { f(ok); } catch (e) {} }); readyCbs = []; }
    function fail(e) { try { console.warn('[de3d] init failed, falling back:', e && e.message || e); } catch (x) {} try { dispose(); } catch (x2) {} fireReady(false); }

    function buildScene() {
      try {
        scene = new B.Scene(engine); scene.clearColor = new B.Color4(0.04, 0.07, 0.11, 1);
        cam = new B.UniversalCamera('cam', new B.Vector3(0, 24, -50), scene); cam.minZ = 0.3; cam.maxZ = 400; cam.fov = 0.82; cam.inputs.clear();
        var hemi = new B.HemisphericLight('h', new B.Vector3(0, 1, 0.2), scene); hemi.intensity = 0.78; hemi.groundColor = new B.Color3(0.16, 0.22, 0.16);
        var sun = new B.DirectionalLight('sun', new B.Vector3(-0.5, -1.1, 0.6), scene); sun.position = new B.Vector3(40, 70, -40); sun.intensity = 2.0;
        var q = opts.quality || 'high'; var sm = q === 'low' ? 0 : q === 'medium' ? 1024 : 2048;
        if (sm) { shadow = new B.ShadowGenerator(sm, sun); shadow.useBlurExponentialShadowMap = true; shadow.blurKernel = 16; shadow.darkness = 0.55; }
        buildPitch(); ensureOverlays();
        ballMesh = B.MeshBuilder.CreateSphere('ball', { diameter: 0.7, segments: 12 }, scene); var bm = new B.PBRMaterial('bm', scene); bm.albedoColor = new B.Color3(0.98, 0.98, 0.98); bm.metallic = 0; bm.roughness = 0.35; ballMesh.material = bm; if (shadow) shadow.addShadowCaster(ballMesh);
        var glbName = 'player.glb' + (opts.ver ? '?v=' + opts.ver : '');
        B.SceneLoader.LoadAssetContainerAsync('/vendor/', glbName, scene, null, '.glb').then(function (cont) {
          try {
            if (disposed) { try { cont.dispose(); } catch (e) {} return; }
            container = cont;
            // measure model height once from a temporary instance for foot placement + scale
            var probe = cont.instantiateModelsToScene(function (n) { return n + '_probe'; }, false, { doNotInstantiate: false });
            var pr = probe.rootNodes[0]; pr.computeWorldMatrix(true); var bb = pr.getHierarchyBoundingVectors(true); var hRaw = (bb.max.y - bb.min.y) || 1; scaleUnit = walkH / hRaw; footY = 0; MODEL_YAW = Math.PI;
            probe.rootNodes.forEach(function (n) { n.dispose(); }); (probe.animationGroups || []).forEach(function (a) { a.dispose(); });
            for (var i = 0; i < players.length; i++) playerNodes.push(makePlayer(players[i], i));
            updateFrame(true);
            engine.runRenderLoop(function () { if (disposed) return; scene.render(); });
            var ro; try { ro = new ResizeObserver(function () { try { engine.resize(); } catch (e) {} }); ro.observe(canvas); disposeRO = ro; } catch (e) {}
            fireReady(true);
          } catch (e) { fail(e); }
        }).catch(fail);
      } catch (e) { fail(e); }
    }
    var disposeRO = null;
    function boot() {
      try {
        var useGPU = !!(navigator.gpu && B.WebGPUEngine);
        if (useGPU && B.WebGPUEngine.IsSupportedAsync) {
          B.WebGPUEngine.IsSupportedAsync.then(function (sup) {
            if (sup) { try { var e = new B.WebGPUEngine(canvas, { antialias: true, stencil: true }); e.initAsync().then(function () { engine = e; engType = 'webgpu'; buildScene(); }).catch(function () { startWebGL(); }); } catch (x) { startWebGL(); } }
            else startWebGL();
          }).catch(startWebGL);
        } else startWebGL();
      } catch (e) { startWebGL(); }
    }
    function startWebGL() { try { engine = new B.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true, powerPreference: 'high-performance' }); engType = 'webgl'; buildScene(); } catch (e) { fail(e); } }

    // ── loop tick (drives time; render loop handles drawing) ──
    var raf = 0, last = 0;
    function tick(ts) { if (!playing || disposed) return; if (!last) last = ts; var dt = (ts - last) / 1000 * speed; last = ts; t += dt; if (t >= TOTAL) { t = TOTAL - 0.001; playing = false; } updateFrame(false); emit(); if (playing) raf = requestAnimationFrame(tick); }
    function gotoStep(i) { i = Math.max(0, Math.min(N - 1, i)); t = bounds[i] + 0.001; playing = false; if (raf) cancelAnimationFrame(raf); raf = 0; lastStep = -1; lastCap = -1; updateFrame(false); emit(); }

    function dispose() {
      disposed = true; if (raf) { try { cancelAnimationFrame(raf); } catch (e) {} raf = 0; }
      try { if (disposeRO) disposeRO.disconnect(); } catch (e) {}
      try { if (scene) { scene.dispose(); } } catch (e) {}
      try { if (engine) { engine.stopRenderLoop(); engine.dispose(); } } catch (e) {}
      scene = null; engine = null; container = null; playerNodes = [];
    }

    boot();
    return {
      ready: function (f) { if (readyState != null) f(readyState); else readyCbs.push(f); },
      play: function () { if (disposed || playing) return; if (t >= TOTAL - 0.01) { t = 0; lastStep = -1; } playing = true; last = 0; raf = requestAnimationFrame(tick); emit(); },
      pause: function () { playing = false; if (raf) { try { cancelAnimationFrame(raf); } catch (e) {} raf = 0; } updateFrame(false); emit(); },
      isPlaying: function () { return playing; },
      seek: function (f) { t = Math.max(0, Math.min(1, f)) * TOTAL; lastStep = -1; updateFrame(false); emit(); },
      setSpeed: function (x) { speed = x; }, toggleMute: function () { muted = !muted; return muted; }, setQuality: function () {},
      nextStep: function () { gotoStep(stepAt() + 1); }, prevStep: function () { gotoStep(stepAt() - 1); }, gotoStep: gotoStep,
      replay: function () { t = 0; lastStep = -1; this.play(); },
      cycleCam: function () { var cur = camOverride || steps[stepAt()].cam; camOverride = MODES[(MODES.indexOf(cur) + 1) % MODES.length]; lastCam = ''; updateFrame(false); emit(); return MODE_LB[camOverride]; },
      setCam: function (md) { if (MODE_LB[md]) { camOverride = md; lastCam = ''; updateFrame(false); emit(); } return MODE_LB[camOverride || steps[stepAt()].cam]; },
      on: function (f) { cb = f; },
      dispose: dispose,
      info: function () { return { engine: engType, players: playerNodes.length, skeletons: playerNodes.filter(function (p) { return p.root; }).length, anims: playerNodes.filter(function (p) { return p.ag; }).length, fps: engine ? Math.round(engine.getFps()) : 0, disposed: disposed }; },
      fps: function () { return engine ? Math.round(engine.getFps()) : 0; },
      engineType: function () { return engType; }
    };
  };
  window._de3dLoaded = true;
})();

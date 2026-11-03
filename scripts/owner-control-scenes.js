// Familista — the Owner Control room illustrations, as 3D scenes.
// ─────────────────────────────────────────────────────────────────────────────
// Browser code, run by scripts/owner-control-render.js inside a headless
// Chromium with the Babylon.js the app vendors. Each entry of OC_SCENES builds
// one scene; OC_RENDER(name) draws it and returns a WebP data URL. Nothing here
// ships to the page: the page shows the rendered images only.
//
// Rules the tests hold this file to: shapes, light and material only — no text
// is drawn (no fillText / strokeText), no figure appears, nothing is fetched.
/* global BABYLON */
(function () {
  'use strict';
  const B = BABYLON;
  let uid = 0;
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const C3 = (h, k) => B.Color3.FromHexString(h).scale(k == null ? 1 : k);
  const V = (x, y, z) => new B.Vector3(x, y, z);

  // ── materials ──────────────────────────────────────────────────────────────
  function mat(scene, o) {
    const m = new B.StandardMaterial('m' + (++uid), scene);
    m.diffuseColor = C3(o.d || '#1e293b');
    m.specularColor = C3(o.s || '#ffffff', o.sk == null ? 0.4 : o.sk);
    m.specularPower = o.sp || 64;
    m.emissiveColor = o.e ? C3(o.e, o.ek == null ? 1 : o.ek) : C3('#000000');
    if (o.a != null) m.alpha = o.a;
    if (o.tex) m.diffuseTexture = o.tex;
    // StandardMaterial adds an emissive texture to emissiveColor: the texture's level is its strength.
    if (o.etex) { m.emissiveTexture = o.etex; if (!o.e) m.emissiveColor = C3('#000000'); }
    if (o.op) m.opacityTexture = o.op;
    if (o.two) m.backFaceCulling = false;
    if (o.noLight) m.disableLighting = true;
    return m;
  }
  /** A lit, glowing material: what an LED, a neon edge or a screen is made of. */
  const neon = (scene, c, k, a) => mat(scene, { d: '#000000', e: c, ek: k == null ? 1 : k, sk: 0, a, noLight: true });

  // ── textures painted with shapes (never text) ──────────────────────────────
  function paint(scene, w, h, fn, alpha) {
    const t = new B.DynamicTexture('t' + (++uid), { width: w, height: h }, scene, true);
    const g = t.getContext();
    g.clearRect(0, 0, w, h);
    fn(g, w, h);
    t.hasAlpha = alpha !== false;
    t.update(true);
    return t;
  }
  const rr = (g, x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  function gridTex(scene, col, n, a) {
    return paint(scene, 512, 512, (g, w, h) => {
      g.strokeStyle = col; g.globalAlpha = a == null ? 0.35 : a; g.lineWidth = 2;
      for (let i = 1; i < n; i++) { const p = (i / n) * w; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, h); g.stroke(); g.beginPath(); g.moveTo(0, p); g.lineTo(w, p); g.stroke(); }
      g.globalAlpha = 1; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
    });
  }

  // ── geometry helpers ───────────────────────────────────────────────────────
  const box = (scene, o, m) => { const b = B.MeshBuilder.CreateBox('b' + (++uid), { width: o.w, height: o.h, depth: o.d }, scene); b.position = V(o.x || 0, (o.y || 0) + o.h / 2, o.z || 0); if (o.ry) b.rotation.y = o.ry; b.material = m; return b; };
  const cyl = (scene, o, m) => { const c = B.MeshBuilder.CreateCylinder('c' + (++uid), { height: o.h, diameterTop: o.dt == null ? o.dia : o.dt, diameterBottom: o.db == null ? o.dia : o.db, tessellation: o.t || 48, arc: o.arc, enclose: !!o.arc }, scene); c.position = V(o.x || 0, (o.y || 0) + o.h / 2, o.z || 0); if (o.rx) c.rotation.x = o.rx; if (o.ry) c.rotation.y = o.ry; if (o.rz) c.rotation.z = o.rz; c.material = m; return c; };
  const sph = (scene, o, m) => { const s = B.MeshBuilder.CreateSphere('s' + (++uid), { diameter: o.dia, segments: o.seg || 32 }, scene); s.position = V(o.x || 0, o.y || 0, o.z || 0); if (o.sx || o.sy || o.sz) s.scaling = V(o.sx || 1, o.sy || 1, o.sz || 1); s.material = m; return s; };
  const tor = (scene, o, m) => { const t = B.MeshBuilder.CreateTorus('r' + (++uid), { diameter: o.dia, thickness: o.th, tessellation: o.t || 96 }, scene); t.position = V(o.x || 0, o.y || 0, o.z || 0); if (o.rx) t.rotation.x = o.rx; if (o.rz) t.rotation.z = o.rz; if (o.ry) t.rotation.y = o.ry; if (o.sx || o.sz) t.scaling = V(o.sx || 1, 1, o.sz || 1); t.material = m; return t; };
  const tube = (scene, pts, r, m, cap) => { const t = B.MeshBuilder.CreateTube('u' + (++uid), { path: pts, radius: r, tessellation: 12, cap: cap === false ? B.Mesh.NO_CAP : B.Mesh.CAP_ALL }, scene); t.material = m; return t; };
  const plane = (scene, o, m) => { const p = B.MeshBuilder.CreatePlane('p' + (++uid), { width: o.w, height: o.h, sideOrientation: B.Mesh.DOUBLESIDE }, scene); p.position = V(o.x || 0, o.y || 0, o.z || 0); p.rotation = V(o.rx || 0, o.ry || 0, o.rz || 0); p.material = m; return p; };
  /** A beam of light from one point to another, widening as it goes: a tube along the exact path, so it cannot point the wrong way. */
  const beam = (scene, from, to, r0, r1, m) => {
    const L = B.Vector3.Distance(from, to), path = [];
    for (let i = 0; i <= 12; i++) path.push(B.Vector3.Lerp(from, to, i / 12));
    const t = B.MeshBuilder.CreateTube('beam' + (++uid), { path, radiusFunction: (i, d) => r0 + (r1 - r0) * (d / L), tessellation: 48, cap: B.Mesh.NO_CAP, sideOrientation: B.Mesh.DOUBLESIDE }, scene);
    t.material = m; return t;
  };
  const bez = (a, b, c, d, n) => { const out = []; for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; out.push(V(u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x, u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y, u * u * u * a.z + 3 * u * u * t * b.z + 3 * u * t * t * c.z + t * t * t * d.z)); } return out; };
  const ring = (cx, cz, rx, rz, y, n) => { const out = []; for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; out.push(V(cx + rx * Math.cos(a), y, cz + rz * Math.sin(a))); } return out; };
  /** A rounded-rectangle path on the floor plane. */
  const rrect = (w, d, r, y, n) => {
    const out = [], hw = w / 2 - r, hd = d / 2 - r, k = n || 8;
    const corner = (cx, cz, a0) => { for (let i = 0; i <= k; i++) { const a = a0 + (i / k) * Math.PI / 2; out.push(V(cx + r * Math.cos(a), y, cz + r * Math.sin(a))); } };
    corner(hw, hd, 0); corner(-hw, hd, Math.PI / 2); corner(-hw, -hd, Math.PI); corner(hw, -hd, Math.PI * 1.5); out.push(out[0].clone());
    return out;
  };
  function dust(scene, n, spread, y0, y1, col) {
    const m = neon(scene, col, 1.2);
    for (let i = 0; i < n; i++) sph(scene, { dia: 0.04 + rnd() * 0.07, x: (rnd() - 0.5) * spread, y: y0 + rnd() * (y1 - y0), z: (rnd() - 0.5) * spread, seg: 6 }, m);
  }

  // ── the stage every room stands on ─────────────────────────────────────────
  function stage(scene, o) {
    scene.clearColor = new B.Color4(0, 0, 0, 0);
    scene.ambientColor = C3('#0f172a');
    const cam = new B.ArcRotateCamera('cam', o.alpha == null ? -Math.PI / 4 : o.alpha, o.beta == null ? 1.02 : o.beta, o.radius || 18, V(...(o.target || [0, 1.2, 0])), scene);
    cam.fov = o.fov || 0.5;
    const hemi = new B.HemisphericLight('hemi', V(0, 1, 0), scene); hemi.intensity = 0.45; hemi.diffuse = C3('#dbeafe'); hemi.groundColor = C3('#0b1120'); hemi.specular = C3('#000000');
    const key = new B.DirectionalLight('key', V(-0.45, -1, 0.55), scene); key.position = V(9, 18, -10); key.intensity = 0.95; key.diffuse = C3('#e2e8f0'); key.specular = C3('#cbd5e1');
    const sg = new B.ShadowGenerator(2048, key); sg.usePercentageCloserFiltering = true; sg.filteringQuality = B.ShadowGenerator.QUALITY_HIGH; sg.darkness = 0.25; sg.bias = 0.0008;
    const rim = new B.PointLight('rim', V(-7, 7, 7), scene); rim.diffuse = C3(o.accent); rim.specular = C3(o.accent); rim.intensity = 1.1; rim.range = 30;
    const fill = new B.PointLight('fill', V(7, 4, -6), scene); fill.diffuse = C3(o.accent2 || o.accent); fill.specular = C3('#000000'); fill.intensity = 0.5; fill.range = 24;
    const glow = new B.GlowLayer('glow', scene, { mainTextureSamples: 4, blurKernelSize: o.blur || 48 }); glow.intensity = o.glow == null ? 0.75 : o.glow;
    const ip = scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true; ip.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_ACES; ip.exposure = o.exposure || 1.0; ip.contrast = 1.3;
    return { cam, sg, glow, rim, key, calm: (m) => glow.addExcludedMesh(m) };
  }
  /** A slab with a lit grid on top and a neon edge round it. */
  function platform(scene, S, o) {
    const w = o.w, d = o.d, h = o.h || 0.35;
    const slab = box(scene, { w, h, d, y: -h }, mat(scene, { d: o.slab || '#0f172a', sk: 0.6, sp: 96 }));
    slab.receiveShadows = true;
    const top = B.MeshBuilder.CreateGround('g' + (++uid), { width: w - 0.1, height: d - 0.1 }, scene);
    top.position.y = 0.002;
    top.material = mat(scene, { d: o.floor || '#0c1328', sk: 0.25, sp: 200, etex: gridTex(scene, o.grid || o.edge, o.cells || 10, 0.6) });
    top.material.emissiveTexture.level = 0.32;
    S.calm(top);
    top.receiveShadows = true;
    tube(scene, rrect(w, d, 0.25, 0.01, 6), 0.045, neon(scene, o.edge, 1.4));
    tube(scene, rrect(w, d, 0.25, -h, 6), 0.03, neon(scene, o.edge, 0.6));
    return top;
  }
  const casts = (S, meshes) => { for (const m of meshes) S.sg.addShadowCaster(m); return meshes; };
  /** A lit frame round a rectangle at height y: the neon edge of a top face. */
  const frame = (scene, cx, cz, w, d, y, col, k, r) => tube(scene, rrect(w, d, r == null ? 0.06 : r, y, 3).map((v) => v.add(V(cx, 0, cz))), 0.022, neon(scene, col, k == null ? 1 : k), false);
  /** A round stage: a dark glossy disc, a faint pattern on it, lit rings round it. */
  function disc(scene, S, o) {
    const r = o.r, h = o.h || 0.3;
    const base = cyl(scene, { h, dia: r * 2, y: -h, t: 96 }, mat(scene, { d: o.slab || '#0b1226', sk: 0.6, sp: 128 }));
    base.receiveShadows = true;
    const top = B.MeshBuilder.CreateDisc('d' + (++uid), { radius: r - 0.05, tessellation: 96 }, scene);
    top.rotation.x = Math.PI / 2; top.position.y = 0.003;
    top.material = mat(scene, { d: o.floor || '#0a1124', sk: 0.3, sp: 200, etex: o.tex || gridTex(scene, o.edge, 12, 0.5) });
    top.material.emissiveTexture.level = o.texk == null ? 0.3 : o.texk;
    top.receiveShadows = true; S.calm(top);
    tor(scene, { dia: r * 2, th: 0.07, y: 0.01 }, neon(scene, o.edge, 1.3));
    tor(scene, { dia: r * 2, th: 0.04, y: -h }, neon(scene, o.edge, 0.5));
    (o.rings || []).forEach(([f, k]) => tor(scene, { dia: r * 2 * f, th: 0.03, y: 0.02 }, neon(scene, o.edge2 || o.edge, k)));
    return top;
  }
  function hexTex(scene, col) {
    return paint(scene, 512, 512, (g, w, h) => {
      const R = 26; g.strokeStyle = col; g.lineWidth = 2;
      for (let row = -1; row < 13; row++) for (let c = -1; c < 13; c++) {
        const x = c * R * 1.5, y = row * R * 1.732 + (c % 2 ? R * 0.866 : 0);
        const dd = Math.hypot(x - w / 2, y - h / 2) / (w / 2);
        g.globalAlpha = Math.max(0, 0.7 - dd * 0.75);
        g.beginPath(); for (let k = 0; k <= 6; k++) { const a = Math.PI / 3 * k; g.lineTo(x + (R - 3) * Math.cos(a), y + (R - 3) * Math.sin(a)); } g.stroke();
        if (rnd() > 0.92 && dd < 0.7) { g.globalAlpha *= 0.4; g.fillStyle = col; g.fill(); }
      }
      g.globalAlpha = 1;
    });
  }
  function shieldShape(sc) {
    const right = [V(0, 1.25, 0), V(0.42, 1.14, 0), V(0.78, 1.0, 0), V(0.96, 0.96, 0), V(0.96, 0.2, 0)];
    for (let i = 1; i <= 14; i++) { const t = i / 14, u = 1 - t; right.push(V(u * u * 0.96 + 2 * u * t * 0.9 + t * t * 0, u * u * 0.2 + 2 * u * t * -0.72 + t * t * -1.28, 0)); }
    const pts = right.map((v) => v.scale(sc));
    for (let i = right.length - 2; i >= 1; i--) pts.push(V(-right[i].x * sc, right[i].y * sc, 0));
    return pts;
  }
  const check = (scene, cx, cy, cz, s, col, k) => tube(scene, [V(cx - 0.32 * s, cy, cz), V(cx - 0.08 * s, cy - 0.24 * s, cz), V(cx + 0.36 * s, cy + 0.26 * s, cz)], 0.06 * s, neon(scene, col, k == null ? 1.3 : k));

  // ── the scenes ─────────────────────────────────────────────────────────────
  const OC_SCENES = {};

  // SYSTEM: a command centre — server racks, a console with its screens, a holographic display.
  OC_SCENES.system = function (scene) {
    seed = 11;
    const S = stage(scene, { accent: '#818cf8', accent2: '#67e8f9', radius: 23.5, target: [0.2, 1.75, 0.3], beta: 1.0 });
    platform(scene, S, { w: 10.5, d: 9, edge: '#818cf8', grid: '#6366f1', cells: 12 });
    const rackM = mat(scene, { d: '#232056', sk: 0.8, sp: 160 });
    const ledsTex = (hotness) => paint(scene, 64, 256, (g, w, h) => {
      g.fillStyle = '#05041a'; g.fillRect(0, 0, w, h);
      for (let y = 10; y < h - 8; y += 12) {
        g.fillStyle = '#1e1b4b'; g.fillRect(6, y - 2, w - 12, 9);
        g.fillStyle = rnd() < hotness ? '#67e8f9' : '#818cf8'; g.globalAlpha = 0.6 + rnd() * 0.4; rr(g, 9, y, 24 + rnd() * 16, 4, 2); g.fill();
        g.fillStyle = rnd() < 0.3 ? '#4ade80' : '#a5b4fc'; g.globalAlpha = 0.95; g.fillRect(w - 13, y, 4, 4);
      }
      g.globalAlpha = 1;
    }, false);
    const racks = [];
    [[-3.6, 3.0, 3.4], [-2.25, 3.0, 4.2], [-0.9, 3.0, 3.0], [0.45, 3.0, 3.8], [1.8, 3.0, 2.8]].forEach(([x, z, h]) => {
      const r = box(scene, { w: 1.15, h, d: 1.0, x, z }, rackM); racks.push(r);
      const face = plane(scene, { w: 0.96, h: h - 0.22, x, y: h / 2, z: z - 0.506 }, mat(scene, { d: '#000000', etex: ledsTex(0.45), sk: 0, noLight: true }));
      face.material.emissiveTexture.level = 0.9; S.calm(face);
      for (const ex of [-0.575, 0.575]) box(scene, { w: 0.035, h, d: 0.035, x: x + ex, z: z - 0.5 }, neon(scene, '#818cf8', 0.9));
      frame(scene, x, z, 1.15, 1.0, h + 0.01, '#a5b4fc', 0.9, 0.02);
    });
    casts(S, racks);
    const deskM = mat(scene, { d: '#1e1b4b', sk: 0.7, sp: 128 });
    const desk = box(scene, { w: 4.6, h: 0.9, d: 1.3, x: -1.2, z: -1.6 }, deskM);
    frame(scene, -1.2, -1.6, 4.6, 1.3, 0.91, '#818cf8', 1.0, 0.03);
    casts(S, [desk]);
    const scr = (bars) => paint(scene, 256, 160, (g, w, h) => {
      g.fillStyle = '#070622'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#6366f1'; g.lineWidth = 4; g.strokeRect(2, 2, w - 4, h - 4);
      if (bars) { [0.4, 0.7, 0.5, 0.9, 0.65, 0.8].forEach((v, i) => { g.fillStyle = i % 2 ? '#67e8f9' : '#a5b4fc'; g.fillRect(22 + i * 36, h - 20 - v * (h - 50), 22, v * (h - 50)); }); }
      else { g.strokeStyle = '#c4b5fd'; g.lineWidth = 5; g.beginPath(); [0.6, 0.35, 0.5, 0.2, 0.42, 0.15, 0.3].forEach((v, i) => { const x = 16 + i * 37, y = 20 + v * (h - 40); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); g.fillStyle = '#67e8f9'; g.beginPath(); g.arc(w - 40, 40, 14, 0, Math.PI * 2); g.fill(); }
    }, false);
    [[-2.3, true], [-0.1, false]].forEach(([x, bars]) => {
      const st = box(scene, { w: 0.12, h: 0.55, d: 0.12, x, z: -1.75, y: 0.9 }, deskM); casts(S, [st]);
      const back = box(scene, { w: 1.95, h: 1.2, d: 0.1, x, z: -1.78, y: 1.4 }, mat(scene, { d: '#111033', sk: 0.6 })); casts(S, [back]);
      const sc = plane(scene, { w: 1.82, h: 1.08, x, y: 2.0, z: -1.84 }, mat(scene, { d: '#000000', etex: scr(bars), sk: 0, noLight: true }));
      sc.material.emissiveTexture.level = 0.95; S.calm(sc);
    });
    cyl(scene, { h: 0.18, dia: 1.3, x: 3.3, z: -0.8 }, mat(scene, { d: '#312e81', sk: 0.8 }));
    tor(scene, { dia: 1.3, th: 0.05, x: 3.3, y: 0.19, z: -0.8 }, neon(scene, '#67e8f9', 1.2));
    const cone = cyl(scene, { h: 2.0, dt: 2.4, db: 1.1, x: 3.3, y: 0.2, z: -0.8 }, mat(scene, { d: '#000000', e: '#818cf8', ek: 0.5, a: 0.1, sk: 0, noLight: true, two: true }));
    S.calm(cone);
    const holo = paint(scene, 320, 220, (g, w, h) => {
      g.fillStyle = 'rgba(99,102,241,0.22)'; rr(g, 4, 4, w - 8, h - 8, 16); g.fill();
      g.strokeStyle = '#a5b4fc'; g.lineWidth = 5; rr(g, 4, 4, w - 8, h - 8, 16); g.stroke();
      g.strokeStyle = '#67e8f9'; g.lineWidth = 10; g.beginPath(); g.arc(92, 110, 50, -Math.PI / 2, Math.PI * 0.95); g.stroke();
      g.strokeStyle = 'rgba(103,232,249,0.3)'; g.beginPath(); g.arc(92, 110, 50, Math.PI * 0.95, Math.PI * 1.5); g.stroke();
      g.fillStyle = '#e0e7ff'; [0.8, 0.55, 0.7].forEach((v, i) => { rr(g, 176, 60 + i * 40, 110 * v, 16, 8); g.fill(); });
    });
    const hp = plane(scene, { w: 2.6, h: 1.8, x: 3.3, y: 3.1, z: -0.8, ry: -0.6 }, mat(scene, { d: '#000000', etex: holo, op: holo, sk: 0, two: true, noLight: true }));
    hp.material.emissiveTexture.level = 0.9; S.calm(hp);
    tor(scene, { dia: 2.2, th: 0.035, x: 1.4, y: 0.02, z: 0.8 }, neon(scene, '#818cf8', 0.9));
    dust(scene, 36, 14, 0.5, 7, '#c7d2fe');
  };

  // CYBERSECURITY: an illuminated shield and lock above a field of protection.
  OC_SCENES.cyber = function (scene) {
    seed = 23;
    const S = stage(scene, { accent: '#818cf8', accent2: '#60a5fa', alpha: -Math.PI / 2 - 0.38, beta: 1.32, radius: 16.5, target: [0, 2.05, 0] });
    disc(scene, S, { r: 4.6, edge: '#818cf8', edge2: '#60a5fa', tex: hexTex(scene, '#818cf8'), texk: 0.6, rings: [[0.72, 0.7], [0.45, 0.9]] });
    const sh = B.MeshBuilder.ExtrudeShape('sh', { shape: shieldShape(1.75), path: [V(0, 0, -0.22), V(0, 0, 0.22)], cap: B.Mesh.CAP_ALL, sideOrientation: B.Mesh.DOUBLESIDE }, scene);
    sh.position = V(0, 2.35, 0); sh.rotation.x = -0.05; sh.rotation.y = -0.38; sh.material = mat(scene, { d: '#3730a3', sk: 0.9, sp: 180, e: '#1e1b4b', ek: 0.6 });
    const inner = B.MeshBuilder.ExtrudeShape('si', { shape: shieldShape(1.42), path: [V(0, 0, -0.1), V(0, 0, 0.1)], cap: B.Mesh.CAP_ALL, sideOrientation: B.Mesh.DOUBLESIDE }, scene);
    inner.position = V(0, 2.38, -0.24); inner.rotation.x = -0.05; inner.rotation.y = -0.38; inner.material = mat(scene, { d: '#4f46e5', sk: 1, sp: 220, e: '#312e81', ek: 0.5 });
    const rim = shieldShape(1.76); rim.push(rim[0].clone());
    const rimT = tube(scene, rim.map((v) => V(v.x, v.y, -0.24)), 0.05, neon(scene, '#c7d2fe', 1.3)); rimT.position = V(0, 2.35, 0); rimT.rotation.x = -0.05; rimT.rotation.y = -0.38;
    casts(S, [sh, inner]);
    // the lock, on the shield's face and turned with it
    const lock = new B.TransformNode('lock', scene); lock.position = V(0, 2.2, 0); lock.rotation.y = -0.38; lock.rotation.x = -0.05;
    const lockM = mat(scene, { d: '#c7d2fe', sk: 1, sp: 256, e: '#6366f1', ek: 0.3 });
    const body = box(scene, { w: 1.25, h: 0.95, d: 0.3, y: -0.62, z: -0.5 }, lockM); body.parent = lock;
    const arc = []; for (let i = 0; i <= 24; i++) { const t = Math.PI * i / 24; arc.push(V(0.38 * Math.cos(t), 0.36 + 0.42 * Math.sin(t), -0.5)); }
    const sh2 = tube(scene, [V(0.38, 0.3, -0.5), ...arc, V(-0.38, 0.3, -0.5)], 0.085, mat(scene, { d: '#e0e7ff', sk: 1, sp: 256, e: '#818cf8', ek: 0.35 })); sh2.parent = lock;
    const kh = cyl(scene, { h: 0.08, dia: 0.24, y: -0.22, z: -0.66, rx: Math.PI / 2 }, mat(scene, { d: '#1e1b4b', sk: 0.2 })); kh.parent = lock;
    const ks = box(scene, { w: 0.08, h: 0.26, d: 0.06, y: -0.46, z: -0.66 }, mat(scene, { d: '#1e1b4b', sk: 0.2 })); ks.parent = lock;
    casts(S, [body]);
    // scanning arcs round it, and circuits from its base
    for (const [r, a0, a1, k] of [[2.6, 0.2, 1.35, 1.0], [2.6, Math.PI - 1.35, Math.PI - 0.2, 1.0], [3.05, 0.5, 1.0, 0.7], [3.05, Math.PI - 1.0, Math.PI - 0.5, 0.7]]) {
      const pts = []; for (let i = 0; i <= 30; i++) { const t = a0 + (a1 - a0) * i / 30; pts.push(V(r * Math.cos(t), 2.0 + r * Math.sin(t), 0)); }
      tube(scene, pts, 0.03, neon(scene, '#93c5fd', k));
    }
    for (const sgn of [-1, 1]) for (const [z, x2] of [[-1.2, 3.6], [-0.4, 4.1], [0.8, 3.4]]) {
      tube(scene, [V(sgn * 0.6, 0.03, z * 0.3), V(sgn * 1.4, 0.03, z), V(sgn * x2, 0.03, z)], 0.025, neon(scene, '#60a5fa', 0.9));
      sph(scene, { dia: 0.16, x: sgn * x2, y: 0.05, z, seg: 12 }, neon(scene, '#bfdbfe', 1.3));
    }
    cyl(scene, { h: 0.5, dt: 1.7, db: 2.2, y: 0 }, mat(scene, { d: '#1e1b4b', sk: 0.8 }));
    tor(scene, { dia: 2.2, th: 0.05, y: 0.02 }, neon(scene, '#c7d2fe', 1.2));
    dust(scene, 34, 11, 0.5, 5.5, '#c7d2fe');
  };

  // ALGORITHMS: a neural network shaped as an AI brain, glass round it, its approval mark beside it.
  OC_SCENES.algo = function (scene) {
    seed = 37;
    const S = stage(scene, { accent: '#e879f9', accent2: '#a78bfa', alpha: -Math.PI / 2 - 0.3, beta: 1.26, radius: 13.5, target: [0, 2.05, 0] });
    disc(scene, S, { r: 3.4, edge: '#e879f9', edge2: '#a78bfa', rings: [[0.6, 0.8]], texk: 0.25 });
    const shellM = mat(scene, { d: '#3b0a4a', e: '#86198f', ek: 0.45, a: 0.42, sk: 1, sp: 200, two: true });
    shellM.emissiveFresnelParameters = new B.FresnelParameters(); shellM.emissiveFresnelParameters.leftColor = C3('#f5d0fe'); shellM.emissiveFresnelParameters.rightColor = C3('#3b0a4a'); shellM.emissiveFresnelParameters.power = 2.2; shellM.emissiveFresnelParameters.bias = 0.1;
    const lobes = [-0.62, 0.62];
    for (const lx of lobes) sph(scene, { dia: 2, x: lx, y: 2.1, sx: 1.12, sy: 0.95, sz: 1.42, seg: 48 }, shellM);
    const nodes = [];
    for (const lx of lobes) for (let i = 0; i < 46; i++) {
      // On the lobe's surface (a little inside it), the inner face pulled in to the fissure.
      const u = rnd() * Math.PI * 2, v = Math.acos(2 * rnd() - 1), k = 0.94 + rnd() * 0.05;
      let x = Math.sin(v) * Math.cos(u), y = Math.cos(v), z = Math.sin(v) * Math.sin(u);
      if (x * Math.sign(lx) < -0.55) x *= 0.6;
      nodes.push(V(lx + x * 1.1 * k, 2.1 + y * 0.92 * k, z * 1.4 * k));
    }
    for (let i = 0; i < 10; i++) nodes.push(V((rnd() - 0.5) * 0.9, 2.1 + (rnd() - 0.5) * 0.9, (rnd() - 0.5) * 1.6));
    const nodeM = neon(scene, '#fdf4ff', 1.6), hotM = neon(scene, '#f0abfc', 1.2);
    nodes.forEach((p, i) => sph(scene, { dia: i % 9 === 0 ? 0.16 : 0.09, x: p.x, y: p.y, z: p.z, seg: 10 }, i % 9 === 0 ? nodeM : hotM));
    const edgeM = neon(scene, '#e879f9', 0.75);
    nodes.forEach((p, i) => {
      nodes.map((q, j) => [B.Vector3.Distance(p, q), j]).filter(([d, j]) => j > i && d < 0.62).sort((a, b) => a[0] - b[0]).slice(0, 3)
        .forEach(([, j]) => tube(scene, [p, nodes[j]], 0.012, edgeM, false));
    });
    const core = sph(scene, { dia: 0.36, y: 2.12, z: -0.2, seg: 24 }, neon(scene, '#ffffff', 1.6)); void core;
    tor(scene, { dia: 4.4, th: 0.035, y: 2.05, rx: 1.35, rz: 0.22 }, neon(scene, '#f0abfc', 1.0));
    sph(scene, { dia: 0.18, x: 2.15, y: 2.4, z: -0.4, seg: 12 }, neon(scene, '#f5d0fe', 1.6));
    cyl(scene, { h: 1.0, dt: 0.5, db: 1.4, y: 0 }, mat(scene, { d: '#000000', e: '#e879f9', ek: 0.45, a: 0.16, sk: 0, noLight: true, two: true }));
    const badge = cyl(scene, { h: 0.14, dia: 0.95, x: 2.15, y: 0.95, z: -1.2, rx: Math.PI / 2 - 0.2 }, mat(scene, { d: '#2e0a3a', sk: 0.8 }));
    tor(scene, { dia: 0.95, th: 0.06, x: 2.15, y: 1.42, z: -1.28, rx: Math.PI / 2 - 0.2 }, neon(scene, '#86efac', 1.2));
    check(scene, 2.15, 1.42, -1.38, 0.9, '#86efac', 1.4);
    badge.position.y = 1.42 - 0.07;
    dust(scene, 32, 10, 0.4, 5, '#f5d0fe');
  };

  // DESIGN SYSTEM CONTROL: a creative workstation — UI components on screen, design layers beside it.
  OC_SCENES.design = function (scene) {
    seed = 41;
    const S = stage(scene, { accent: '#fbbf24', accent2: '#f472b6', alpha: -Math.PI / 2 - 0.5, beta: 1.12, radius: 19, target: [0.5, 1.6, 0] });
    platform(scene, S, { w: 9.5, d: 6.5, edge: '#fbbf24', grid: '#f59e0b', cells: 10, slab: '#17110a', floor: '#120d08' });
    const ui = paint(scene, 512, 320, (g, w, h) => {
      g.fillStyle = '#0c0a09'; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(251,191,36,0.16)'; g.fillRect(0, 0, w, 36); g.fillStyle = '#fde68a'; [18, 36, 54].forEach((x) => { g.beginPath(); g.arc(x, 18, 6, 0, Math.PI * 2); g.fill(); });
      g.fillStyle = 'rgba(251,191,36,0.10)'; rr(g, 14, 50, 96, 256, 10); g.fill(); g.strokeStyle = 'rgba(252,211,77,0.5)'; g.lineWidth = 2; rr(g, 14, 50, 96, 256, 10); g.stroke();
      g.fillStyle = '#fde68a'; [0.7, 0.5, 0.62, 0.42, 0.55].forEach((v, i) => { rr(g, 28, 72 + i * 30, 70 * v, 10, 5); g.fill(); });
      [['#fbbf24', 128], ['#f472b6', 254], ['#22d3ee', 380]].forEach(([c, x]) => { g.fillStyle = c; rr(g, x, 52, 112, 92, 12); g.fill(); g.fillStyle = 'rgba(12,10,9,0.35)'; rr(g, x + 14, 116, 60, 12, 6); g.fill(); });
      g.fillStyle = '#44403c'; rr(g, 128, 166, 240, 12, 6); g.fill(); g.fillStyle = '#fbbf24'; rr(g, 128, 166, 150, 12, 6); g.fill(); g.fillStyle = '#fffbeb'; g.beginPath(); g.arc(278, 172, 12, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#4ade80'; rr(g, 404, 158, 64, 30, 15); g.fill(); g.fillStyle = '#f0fdf4'; g.beginPath(); g.arc(452, 173, 11, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#fcd34d'; g.lineWidth = 3; g.fillStyle = 'rgba(251,191,36,0.25)'; rr(g, 128, 210, 160, 40, 20); g.fill(); g.stroke();
      g.strokeStyle = '#a78bfa'; rr(g, 306, 210, 160, 40, 20); g.stroke();
      g.strokeStyle = 'rgba(167,139,250,0.7)'; g.beginPath(); g.moveTo(128, 278); g.lineTo(468, 278); g.stroke();
    }, false);
    const bez = mat(scene, { d: '#1c1917', sk: 0.8, sp: 160 });
    const mon = box(scene, { w: 5.0, h: 3.2, d: 0.18, x: -0.4, y: 1.25, z: 0.6 }, bez);
    const scr = plane(scene, { w: 4.75, h: 2.95, x: -0.4, y: 2.85, z: 0.5 }, mat(scene, { d: '#000000', etex: ui, sk: 0, noLight: true }));
    scr.material.emissiveTexture.level = 1.0; S.calm(scr);
    tube(scene, rrect(5.0, 3.2, 0.12, 0, 4).map((v) => V(v.x - 0.4, v.z + 2.85, 0.49)), 0.035, neon(scene, '#fcd34d', 1.3), false);
    const neck = box(scene, { w: 0.35, h: 1.05, d: 0.25, x: -0.4, y: 0.2, z: 0.75 }, bez);
    const foot = box(scene, { w: 1.8, h: 0.12, d: 1.0, x: -0.4, y: 0.02, z: 0.6 }, bez);
    casts(S, [mon, neck, foot]);
    const kb = box(scene, { w: 3.0, h: 0.1, d: 0.9, x: -0.6, y: 0.02, z: -1.4 }, mat(scene, { d: '#292524', sk: 0.6 }));
    frame(scene, -0.6, -1.4, 3.0, 0.9, 0.13, '#f59e0b', 0.6, 0.05); casts(S, [kb]);
    // design layers, floating
    [['#22d3ee', 3.6], ['#f472b6', 3.0], ['#fbbf24', 2.4]].forEach(([c, y], i) => {
      const l = box(scene, { w: 2.0, h: 0.06, d: 1.5, x: 3.35, y, z: -0.3 }, mat(scene, { d: '#000000', e: c, ek: 0.25, a: 0.55, sk: 0.6 }));
      l.rotation.y = 0.6; l.rotation.z = 0.05 * i; S.calm(l);
      const f = frame(scene, 0, 0, 2.0, 1.5, 0, c, 1.3, 0.08); f.position = V(3.35, y + 0.04, -0.3); f.rotation.y = 0.6; f.rotation.z = 0.05 * i;
    });
    // the stylus and the palette
    const pen = cyl(scene, { h: 2.4, dia: 0.16, x: 2.4, y: 0.4, z: -1.7, rz: 0.95, rx: 0.2 }, mat(scene, { d: '#f59e0b', sk: 1, sp: 200, e: '#78350f', ek: 0.4 }));
    casts(S, [pen]);
    [['#fbbf24', -3.6], ['#f472b6', -3.0], ['#22d3ee', -2.4], ['#a78bfa', -1.8]].forEach(([c, x]) => sph(scene, { dia: 0.42, x, y: 0.22, z: -2.3, seg: 24 }, mat(scene, { d: c, e: c, ek: 0.55, sk: 1, sp: 200 })));
    dust(scene, 26, 12, 0.5, 6, '#fde68a');
  };

  // DATA VAULT: illuminated database tiers in secure storage, archive blocks beside them.
  OC_SCENES.vault = function (scene) {
    seed = 53;
    const S = stage(scene, { accent: '#22d3ee', accent2: '#3b82f6', alpha: -Math.PI / 4 - 0.15, beta: 1.08, radius: 19, target: [0, 1.85, 0] });
    disc(scene, S, { r: 4.4, edge: '#22d3ee', edge2: '#67e8f9', rings: [[0.8, 0.6], [0.58, 0.9]], texk: 0.3 });
    const band = paint(scene, 512, 64, (g, w, h) => {
      g.fillStyle = '#021f26'; g.fillRect(0, 0, w, h);
      for (let x = 10; x < w; x += 22) { g.fillStyle = rnd() > 0.6 ? '#67e8f9' : '#0e7490'; g.fillRect(x, 26, 10, 10); }
      g.fillStyle = 'rgba(103,232,249,0.45)'; g.fillRect(0, 52, w, 3);
    }, false);
    const tierM = mat(scene, { d: '#0b3a46', sk: 0.9, sp: 200, etex: band });
    tierM.emissiveTexture.level = 0.9;
    const tiers = [];
    [0.15, 1.2, 2.25].forEach((y) => {
      const t = cyl(scene, { h: 0.9, dia: 3.0, y, t: 64 }, tierM); tiers.push(t);
      tor(scene, { dia: 3.0, th: 0.07, y: y + 0.9 }, neon(scene, '#67e8f9', 1.3));
      tor(scene, { dia: 3.0, th: 0.04, y: y + 0.02 }, neon(scene, '#22d3ee', 0.8));
      const lid = cyl(scene, { h: 0.04, dia: 2.9, y: y + 0.88 }, mat(scene, { d: '#0e7490', sk: 1, sp: 256, e: '#083344', ek: 0.6 })); tiers.push(lid);
    });
    casts(S, tiers);
    const sh = B.MeshBuilder.ExtrudeShape('vs', { shape: shieldShape(0.75), path: [V(0, 0, -0.08), V(0, 0, 0.08)], cap: B.Mesh.CAP_ALL, sideOrientation: B.Mesh.DOUBLESIDE }, scene);
    sh.position = V(0, 4.05, -0.2); sh.rotation.y = -Math.PI / 4 - 0.15; sh.material = mat(scene, { d: '#0891b2', sk: 1, sp: 220, e: '#155e75', ek: 0.8 });
    const rim = shieldShape(0.76); rim.push(rim[0].clone());
    const rt = tube(scene, rim, 0.03, neon(scene, '#cffafe', 1.3)); rt.position = V(0, 4.05, -0.2); rt.rotation.y = -Math.PI / 4 - 0.15;
    const ck = check(scene, 0, 0, -0.1, 0.75, '#ecfeff', 1.5); ck.position = V(0, 4.0, -0.2); ck.rotation.y = -Math.PI / 4 - 0.15;
    const cubeM = mat(scene, { d: '#0e4a5a', sk: 0.8, sp: 160, e: '#083344', ek: 0.4 });
    const cubeB = mat(scene, { d: '#1e3a8a', sk: 0.8, sp: 160, e: '#0b1d47', ek: 0.4 });
    for (const [x, z, w, h, m, c] of [[-3.0, -0.6, 1.1, 1.1, cubeM, '#67e8f9'], [-2.6, 0.9, 0.8, 0.7, cubeM, '#67e8f9'], [2.9, -0.2, 1.0, 1.4, cubeB, '#93c5fd'], [2.7, 1.2, 0.7, 0.6, cubeM, '#67e8f9']]) {
      const b = box(scene, { w, h, d: w, x, z }, m); casts(S, [b]); frame(scene, x, z, w, w, h + 0.01, c, 1.0, 0.03);
    }
    for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2, r = 3.9 + rnd() * 0.3; for (let k = 0; k < 4; k++) box(scene, { w: 0.05, h: 0.25 + rnd() * 0.35, d: 0.05, x: r * Math.cos(a), z: r * Math.sin(a), y: 0.4 + k * 0.85 + rnd() * 0.3 }, neon(scene, '#22d3ee', 0.8)); }
    dust(scene, 30, 11, 0.4, 5.5, '#a5f3fc');
  };

  // INFRASTRUCTURE CITY: a miniature city, its rooftops wired into one network.
  OC_SCENES.city = function (scene) {
    seed = 67;
    const S = stage(scene, { accent: '#60a5fa', accent2: '#a78bfa', radius: 23.5, beta: 0.98, target: [0, 1.9, 0] });
    platform(scene, S, { w: 10, d: 9, edge: '#60a5fa', grid: '#3b82f6', cells: 14, slab: '#0a1230', floor: '#0a122c' });
    const winTex = (h) => paint(scene, 64, Math.max(64, Math.round(h * 40)), (g, w, H) => {
      g.fillStyle = '#081430'; g.fillRect(0, 0, w, H);
      for (let y = 6; y < H - 4; y += 10) for (let x = 6; x < w - 4; x += 12) { const r = rnd(); g.fillStyle = r > 0.82 ? '#fde68a' : r > 0.45 ? '#60a5fa' : '#1e3a8a'; g.globalAlpha = r > 0.45 ? 0.95 : 0.6; g.fillRect(x, y, 7, 5); }
      g.globalAlpha = 1;
    }, false);
    const B_ = [[-3.4, -3.0, 1.2, 1.6], [-1.9, -3.2, 1.0, 2.6], [-0.4, -3.0, 1.3, 1.8], [1.3, -3.1, 1.1, 2.9], [3.0, -2.9, 1.2, 1.4],
      [-3.3, -1.0, 1.0, 2.0], [-1.6, -1.1, 1.2, 3.3], [0.2, -1.0, 1.5, 5.0], [2.0, -1.2, 1.1, 2.4], [3.4, -0.9, 0.9, 1.6],
      [-3.0, 1.0, 1.1, 1.3], [-1.3, 1.1, 1.0, 2.1], [0.5, 1.3, 1.2, 1.5], [2.2, 1.0, 1.2, 2.7], [-2.0, 2.9, 1.1, 1.0], [1.4, 3.0, 1.0, 1.2]];
    const glass = (h) => { const m = mat(scene, { d: '#10204a', sk: 1, sp: 220, etex: winTex(h) }); m.emissiveTexture.level = 1.0; return m; };
    const tops = [];
    for (const [x, z, w, h] of B_) {
      const b = box(scene, { w, h, d: w, x, z }, glass(h)); casts(S, [b]);
      frame(scene, x, z, w, w, h + 0.01, h > 3 ? '#93c5fd' : '#60a5fa', h > 3 ? 1.2 : 0.8, 0.02);
      tops.push(V(x, h + 0.05, z));
    }
    const tallest = tops[7];
    cyl(scene, { h: 1.3, dt: 0.04, db: 0.18, x: tallest.x, y: tallest.y, z: tallest.z }, mat(scene, { d: '#bfdbfe', sk: 1 }));
    sph(scene, { dia: 0.26, x: tallest.x, y: tallest.y + 1.35, z: tallest.z, seg: 16 }, neon(scene, '#22d3ee', 1.8));
    const linkM = neon(scene, '#22d3ee', 1.1);
    [[7, 1], [7, 3], [7, 13], [7, 11], [6, 1], [8, 3], [12, 13], [10, 11], [5, 6], [2, 7], [9, 4], [14, 10], [15, 13]].forEach(([a, b]) => {
      const p = tops[a], q = tops[b], mid = V((p.x + q.x) / 2, Math.max(p.y, q.y) + 1.1, (p.z + q.z) / 2);
      tube(scene, bez(p, V(p.x, mid.y, p.z).add(mid).scale(0.5), V(q.x, mid.y, q.z).add(mid).scale(0.5), q, 24), 0.025, linkM, false);
    });
    tops.forEach((t) => sph(scene, { dia: 0.12, x: t.x, y: t.y + 0.02, z: t.z, seg: 8 }, neon(scene, '#cffafe', 1.5)));
    dust(scene, 30, 13, 3, 8, '#bfdbfe');
  };

  // SOURCE CORE: lineage — sources flowing through one core into what depends on them.
  OC_SCENES.core = function (scene) {
    seed = 79;
    const S = stage(scene, { accent: '#38bdf8', accent2: '#818cf8', alpha: -Math.PI / 2 - 0.25, beta: 1.12, radius: 15.5, target: [0, 1.3, 0.4], glow: 0.6 });
    disc(scene, S, { r: 5.2, edge: '#38bdf8', edge2: '#22d3ee', rings: [[0.4, 0.9], [0.62, 0.5]], texk: 0.28 });
    const tileM = mat(scene, { d: '#0b2a44', sk: 0.9, sp: 200, e: '#04203a', ek: 0.4 });
    const tile = (x, z, kind) => {
      const t = box(scene, { w: 1.0, h: 1.0, d: 0.28, x, y: 0.55, z }, tileM); casts(S, [t]);
      tube(scene, rrect(1.0, 1.0, 0.18, 0, 4).map((v) => V(v.x + x, v.z + 1.05, z - 0.15)), 0.025, neon(scene, '#7dd3fc', 1.2), false);
      const iconM = neon(scene, '#7dd3fc', 0.9);
      if (kind === 'db') { for (const y of [0.85, 1.05, 1.25]) cyl(scene, { h: 0.12, dia: 0.46, x, y, z: z - 0.18, rx: 0 }, iconM); }
      else if (kind === 'doc') { box(scene, { w: 0.42, h: 0.56, d: 0.04, x, y: 0.77, z: z - 0.17 }, mat(scene, { d: '#000000', e: '#bae6fd', ek: 0.8, noLight: true })); }
      else if (kind === 'cam') { box(scene, { w: 0.46, h: 0.34, d: 0.06, x: x - 0.06, y: 0.88, z: z - 0.17 }, iconM); cyl(scene, { h: 0.14, dt: 0.3, db: 0.14, x: x + 0.24, y: 0.98, z: z - 0.2, rz: Math.PI / 2 }, iconM); }
      else if (kind === 'ok') { check(scene, x, 1.05, z - 0.2, 0.9, '#86efac', 1.4); }
      return V(x, 1.05, z - 0.15);
    };
    const src = [tile(-4.2, -0.8, 'db'), tile(-4.5, 0.9, 'doc'), tile(-3.9, 2.4, 'cam')];
    const out = [tile(4.2, -0.8, 'ok'), tile(4.5, 0.9, 'ok'), tile(3.9, 2.4, 'ok')];
    const core = V(0, 1.6, 0.6);
    sph(scene, { dia: 2.6, x: core.x, y: core.y, z: core.z, seg: 48 }, mat(scene, { d: '#000000', e: '#0ea5e9', ek: 0.35, a: 0.18, sk: 1, sp: 200, two: true }));
    sph(scene, { dia: 1.3, x: core.x, y: core.y, z: core.z, seg: 48 }, mat(scene, { d: '#0c4a6e', e: '#0284c7', ek: 0.9, sk: 1, sp: 200 }));
    sph(scene, { dia: 0.55, x: core.x, y: core.y, z: core.z - 0.5, seg: 32 }, neon(scene, '#e0f2fe', 1.2));
    tor(scene, { dia: 3.2, th: 0.05, x: core.x, y: core.y, z: core.z, rx: 1.2, rz: 0.35 }, neon(scene, '#38bdf8', 1.1));
    tor(scene, { dia: 3.6, th: 0.04, x: core.x, y: core.y, z: core.z, rx: 1.8, rz: -0.6 }, neon(scene, '#818cf8', 0.9));
    const flowM = neon(scene, '#7dd3fc', 1.1);
    const mids = [V(-2.0, 1.3, 0.1), V(-2.1, 1.5, 1.6), V(2.0, 1.3, 0.1), V(2.1, 1.5, 1.6)];
    for (const n of mids) sph(scene, { dia: 0.28, x: n.x, y: n.y, z: n.z, seg: 16 }, neon(scene, '#bae6fd', 1.4));
    const link = (a, b) => { const mx = (a.x + b.x) / 2; tube(scene, bez(a, V(mx, a.y, a.z), V(mx, b.y, b.z), b, 30), 0.03, flowM, false); for (let i = 1; i < 3; i++) { const t = i / 3; sph(scene, { dia: 0.09, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + 0.02, z: a.z + (b.z - a.z) * t, seg: 8 }, neon(scene, '#f0f9ff', 1.6)); } };
    link(src[0], mids[0]); link(src[1], mids[0]); link(src[1], mids[1]); link(src[2], mids[1]);
    link(mids[0], core); link(mids[1], core); link(core, mids[2]); link(core, mids[3]);
    link(mids[2], out[0]); link(mids[2], out[1]); link(mids[3], out[1]); link(mids[3], out[2]);
    dust(scene, 30, 12, 0.4, 4.5, '#bae6fd');
  };

  // FAMILISTA VISION: an AI camera tracking the players and the ball across a pitch.
  OC_SCENES.vision = function (scene) {
    seed = 83;
    const S = stage(scene, { accent: '#a78bfa', accent2: '#22d3ee', alpha: -Math.PI / 2 - 0.3, beta: 1.0, radius: 19, target: [-0.3, 1.2, 0.5] });
    const pitchTex = paint(scene, 1024, 640, (g, w, h) => {
      for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? '#15803d' : '#166534'; g.fillRect(i * w / 10, 0, w / 10, h); }
      g.strokeStyle = 'rgba(240,253,244,0.85)'; g.lineWidth = 5;
      g.strokeRect(24, 24, w - 48, h - 48); g.beginPath(); g.moveTo(w / 2, 24); g.lineTo(w / 2, h - 24); g.stroke();
      g.beginPath(); g.arc(w / 2, h / 2, 80, 0, Math.PI * 2); g.stroke();
      g.strokeRect(24, h / 2 - 150, 150, 300); g.strokeRect(w - 174, h / 2 - 150, 150, 300); g.strokeRect(24, h / 2 - 70, 56, 140); g.strokeRect(w - 80, h / 2 - 70, 56, 140);
      const hg = g.createRadialGradient(w * 0.66, h * 0.55, 10, w * 0.66, h * 0.55, 170); hg.addColorStop(0, 'rgba(249,115,22,0.75)'); hg.addColorStop(0.45, 'rgba(250,204,21,0.35)'); hg.addColorStop(1, 'rgba(250,204,21,0)');
      g.fillStyle = hg; g.fillRect(0, 0, w, h);
    }, false);
    const pitch = B.MeshBuilder.CreateGround('pitch', { width: 10, height: 6.25 }, scene);
    pitch.material = mat(scene, { d: '#000000', etex: pitchTex, sk: 0.15 }); pitch.material.emissiveTexture.level = 0.95; pitch.receiveShadows = true; S.calm(pitch);
    box(scene, { w: 10.2, h: 0.25, d: 6.45, y: -0.28 }, mat(scene, { d: '#052e16', sk: 0.4 }));
    tube(scene, rrect(10.2, 6.45, 0.1, 0.01, 3), 0.04, neon(scene, '#4ade80', 0.9));
    const teamA = mat(scene, { d: '#22d3ee', e: '#0e7490', ek: 0.6, sk: 0.8 }), teamB = mat(scene, { d: '#facc15', e: '#a16207', ek: 0.6, sk: 0.8 });
    const head = mat(scene, { d: '#f8fafc', sk: 0.6 });
    const players = [[-3.2, -1.2, teamA], [-1.6, 1.0, teamB], [-0.6, -1.8, teamA], [0.8, 0.4, teamB], [1.6, -1.0, teamA], [2.6, 1.6, teamB], [3.4, -0.4, teamA], [-2.4, 2.0, teamB], [0.2, 2.2, teamA]];
    for (const [x, z, m] of players) {
      const b = B.MeshBuilder.CreateCapsule('pl' + (++uid), { radius: 0.17, height: 0.75, tessellation: 16 }, scene); b.position = V(x, 0.38, z); b.material = m;
      const hd = sph(scene, { dia: 0.24, x, y: 0.88, z, seg: 12 }, head);
      casts(S, [b, hd]);
      const tb = B.MeshBuilder.CreateBox('tb' + (++uid), { width: 0.62, height: 1.2, depth: 0.62 }, scene); tb.position = V(x, 0.6, z);
      tb.material = neon(scene, m === teamA ? '#67e8f9' : '#fde047', 1.1); tb.material.wireframe = true;
    }
    const ball = V(1.2, 0.12, -0.2);
    sph(scene, { dia: 0.22, x: ball.x, y: ball.y, z: ball.z, seg: 16 }, mat(scene, { d: '#f8fafc', e: '#fefce8', ek: 0.4 }));
    tube(scene, bez(V(-1.6, 0.3, 1.0), V(-0.8, 2.2, 0.6), V(0.4, 2.0, 0.1), ball, 40), 0.025, neon(scene, '#fef08a', 1.3), false);
    const camPos = V(-4.4, 3.4, 2.9), camTarget = V(0.6, 0, -0.2);
    cyl(scene, { h: 3.2, dia: 0.16, x: camPos.x - 0.05, z: camPos.z + 0.25 }, mat(scene, { d: '#475569', sk: 0.8 }));
    const bodyM = mat(scene, { d: '#5b21b6', sk: 1, sp: 200, e: '#2e1065', ek: 0.5 });
    const body = box(scene, { w: 0.6, h: 0.5, d: 1.2 }, bodyM); body.position = camPos.clone(); body.lookAt(camTarget);
    const lens = cyl(scene, { h: 0.3, dia: 0.42 }, mat(scene, { d: '#1e1b4b', sk: 1 })); lens.position = V(0, 0, 0); lens.rotation.x = Math.PI / 2; lens.bakeCurrentTransformIntoVertices();
    const dir = camTarget.subtract(camPos).normalize();
    lens.position = camPos.add(dir.scale(0.7)); lens.lookAt(camTarget);
    const ringL = tor(scene, { dia: 0.42, th: 0.06 }, neon(scene, '#22d3ee', 1.6)); ringL.rotation.x = Math.PI / 2; ringL.bakeCurrentTransformIntoVertices(); ringL.position = camPos.add(dir.scale(0.86)); ringL.lookAt(camTarget);
    casts(S, [body]);
    const beamV = beam(scene, camPos.add(dir.scale(0.9)), V(0.9, 0.02, -0.1), 0.18, 2.9, mat(scene, { d: '#000000', e: '#c4b5fd', ek: 0.8, a: 0.075, sk: 0, noLight: true, two: true }));
    S.calm(beamV);
    dust(scene, 22, 12, 1.5, 6, '#ddd6fe');
  };

  // CLUBS: a professional football stadium under its floodlights.
  OC_SCENES.clubs = function (scene) {
    seed = 97;
    const S = stage(scene, { accent: '#4ade80', accent2: '#22d3ee', alpha: -Math.PI / 2 - 0.35, beta: 0.98, radius: 21, target: [0, 1.0, 0.3] });
    const flood = new B.PointLight('flood', V(0, 4.5, 0), scene); flood.diffuse = C3('#f8fafc'); flood.intensity = 1.2; flood.range = 14;
    const seats = paint(scene, 1024, 128, (g, w, h) => {
      g.fillStyle = '#111827'; g.fillRect(0, 0, w, h);
      for (let y = 8; y < h; y += 10) for (let x = 3; x < w; x += 6) { const r = rnd(); g.fillStyle = r > 0.93 ? '#fde68a' : r > 0.55 ? '#64748b' : '#334155'; g.fillRect(x, y, 4, 5); }
    }, false);
    const prof = [V(3.25, 0.05, 0), V(3.4, 0.3, 0), V(5.0, 1.55, 0), V(5.25, 1.7, 0), V(5.45, 1.7, 0), V(5.45, 0, 0)];
    const bowl = B.MeshBuilder.CreateLathe('bowl', { shape: prof, tessellation: 96, sideOrientation: B.Mesh.DOUBLESIDE, closed: true }, scene);
    bowl.scaling = V(1, 1, 0.66); bowl.material = mat(scene, { d: '#475569', sk: 0.5, tex: seats, etex: seats }); bowl.material.emissiveTexture.level = 1.0;
    bowl.receiveShadows = true; casts(S, [bowl]);
    const roof = tor(scene, { dia: 10.6, th: 0.14, y: 1.75, sz: 0.66 }, neon(scene, '#4ade80', 1.4));
    void roof;
    tor(scene, { dia: 6.55, th: 0.05, y: 0.32, sz: 0.66 }, neon(scene, '#86efac', 1.0));
    const inner = B.MeshBuilder.CreateDisc('in', { radius: 3.3, tessellation: 96 }, scene); inner.rotation.x = Math.PI / 2; inner.scaling = V(1, 0.66, 1); inner.position.y = 0.04;
    inner.material = mat(scene, { d: '#052e16', sk: 0.2 }); inner.receiveShadows = true;
    const pt = paint(scene, 768, 480, (g, w, h) => {
      for (let i = 0; i < 12; i++) { g.fillStyle = i % 2 ? '#16a34a' : '#15803d'; g.fillRect(i * w / 12, 0, w / 12, h); }
      g.strokeStyle = 'rgba(240,253,244,0.9)'; g.lineWidth = 5; g.strokeRect(14, 14, w - 28, h - 28);
      g.beginPath(); g.moveTo(w / 2, 14); g.lineTo(w / 2, h - 14); g.stroke(); g.beginPath(); g.arc(w / 2, h / 2, 56, 0, Math.PI * 2); g.stroke();
      g.strokeRect(14, h / 2 - 110, 110, 220); g.strokeRect(w - 124, h / 2 - 110, 110, 220);
    }, false);
    const pitch = B.MeshBuilder.CreateGround('pt', { width: 4.6, height: 2.85 }, scene); pitch.position.y = 0.06;
    pitch.material = mat(scene, { d: '#000000', etex: pt, sk: 0.1 }); pitch.material.emissiveTexture.level = 1.0; pitch.receiveShadows = true; S.calm(pitch);
    const pole = mat(scene, { d: '#94a3b8', sk: 0.9 });
    for (const [x, z] of [[-5.2, -3.0], [5.2, -3.0], [-5.2, 3.2], [5.2, 3.2]]) {
      cyl(scene, { h: 3.6, dia: 0.16, x, z }, pole);
      const lamp = box(scene, { w: 0.9, h: 0.5, d: 0.12, x, y: 3.55, z }, neon(scene, '#f8fafc', 1.8)); lamp.lookAt(V(0, 0, 0));
      const bm = beam(scene, V(x * 0.97, 3.5, z * 0.97), V(x * 0.25, 0.08, z * 0.25), 0.25, 1.7, mat(scene, { d: '#000000', e: '#f8fafc', ek: 0.7, a: 0.05, sk: 0, noLight: true, two: true }));
      S.calm(bm);
    }
    dust(scene, 26, 13, 2, 6, '#f0fdf4');
  };

  // THE HUB: the Operations Room's AI agent — dark metal, lit by the room's amber, its visor alight.
  OC_SCENES.hub = function (scene) {
    seed = 101;
    const S = stage(scene, { accent: '#fcd34d', accent2: '#38bdf8', alpha: -Math.PI / 2 - 0.18, beta: Math.PI / 2 - 0.1, radius: 12.5, target: [0, 1.75, 0], fov: 0.5, glow: 0.9, exposure: 1.15 });
    S.rim.position = V(-5, 5, 4); S.rim.intensity = 1.6;
    const metal = mat(scene, { d: '#3b4a63', sk: 1, sp: 180, e: '#172033', ek: 0.6 });
    metal.emissiveFresnelParameters = new B.FresnelParameters(); metal.emissiveFresnelParameters.leftColor = C3('#fbbf24'); metal.emissiveFresnelParameters.rightColor = C3('#000000'); metal.emissiveFresnelParameters.power = 3; metal.emissiveFresnelParameters.bias = 0.05;
    const head = sph(scene, { dia: 3.0, y: 2.1, sx: 1.12, sy: 0.92, sz: 1.0, seg: 64 }, metal);
    const visorM = mat(scene, { d: '#020617', sk: 1, sp: 256 });
    visorM.emissiveFresnelParameters = new B.FresnelParameters(); visorM.emissiveFresnelParameters.leftColor = C3('#38bdf8', 0.9); visorM.emissiveFresnelParameters.rightColor = C3('#000000'); visorM.emissiveFresnelParameters.power = 4;
    const visor = sph(scene, { dia: 2.4, y: 2.1, z: -0.62, sx: 1.06, sy: 0.6, sz: 0.62, seg: 64 }, visorM);
    const eyeM = neon(scene, '#38bdf8', 1.8);
    for (const x of [-0.5, 0.5]) { const e = B.MeshBuilder.CreateCapsule('eye' + x, { radius: 0.16, height: 0.62, tessellation: 24, orientation: V(1, 0, 0) }, scene); e.position = V(x, 2.14, -1.35); e.material = eyeM; }
    for (const sgn of [-1, 1]) {
      cyl(scene, { h: 0.42, dia: 0.85, x: sgn * 1.72, y: 1.89, rz: Math.PI / 2 }, metal);
      tor(scene, { dia: 0.85, th: 0.08, x: sgn * 1.95, y: 2.1, rz: Math.PI / 2 }, neon(scene, '#fbbf24', 1.6));
    }
    cyl(scene, { h: 0.9, dia: 0.08, y: 3.2 }, mat(scene, { d: '#cbd5e1', sk: 1 }));
    sph(scene, { dia: 0.32, y: 4.15, seg: 24 }, neon(scene, '#fcd34d', 2.0));
    cyl(scene, { h: 0.45, dia: 0.9, y: 0.55 }, metal);
    const shoulders = sph(scene, { dia: 3.4, y: 0.2, sx: 1.0, sy: 0.42, sz: 0.7, seg: 48 }, metal);
    tor(scene, { dia: 2.2, th: 0.06, y: 0.62, sz: 0.62 }, neon(scene, '#fcd34d', 1.3));
    sph(scene, { dia: 0.22, y: 0.4, z: -1.12, seg: 16 }, neon(scene, '#38bdf8', 1.8));
    tor(scene, { dia: 4.6, th: 0.07, y: 2.1, z: 0.9, rx: Math.PI / 2 }, neon(scene, '#fcd34d', 1.1));
    tor(scene, { dia: 5.2, th: 0.03, y: 2.1, z: 1.0, rx: Math.PI / 2 }, neon(scene, '#fbbf24', 0.6));
    casts(S, [head, visor, shoulders]);
    dust(scene, 22, 7, 0, 4.5, '#fef3c7');
  };

  // AN AGENT ON THE ORBIT: a glass orb, lit at its rim in the agents' green; its glyph is drawn over it by the page.
  OC_SCENES.orb = function (scene) {
    seed = 7;
    const S = stage(scene, { accent: '#4ade80', alpha: -Math.PI / 2, beta: Math.PI / 2 - 0.25, radius: 6.2, target: [0, 0, 0], glow: 0.6, blur: 24 });
    S.rim.position = V(-3, 3, -3); S.rim.intensity = 1.4;
    const g = mat(scene, { d: '#052e16', sk: 1, sp: 256, e: '#022c16', ek: 0.6 });
    g.emissiveFresnelParameters = new B.FresnelParameters(); g.emissiveFresnelParameters.leftColor = C3('#4ade80'); g.emissiveFresnelParameters.rightColor = C3('#000000'); g.emissiveFresnelParameters.power = 2.4; g.emissiveFresnelParameters.bias = 0.05;
    sph(scene, { dia: 2.0, seg: 64 }, g);
    tor(scene, { dia: 2.08, th: 0.05, rx: Math.PI / 2 - 0.25 }, neon(scene, '#86efac', 1.2));
  };

  // ── render one scene to a WebP data URL ────────────────────────────────────
  const SIZES = { hub: [520, 520], orb: [128, 128] };
  window.OC_SCENES = OC_SCENES;
  window.OC_RENDER = async function (name) {
    const [OW, OH] = SIZES[name] || [576, 414];
    const RW = OW * 2, RH = OH * 2;
    const canvas = document.createElement('canvas'); canvas.width = RW; canvas.height = RH;
    document.body.appendChild(canvas);
    const engine = new B.Engine(canvas, true, { preserveDrawingBuffer: true, premultipliedAlpha: false, alpha: true, stencil: true, antialias: true }, false);
    engine.setHardwareScalingLevel(1);
    const scene = new B.Scene(engine);
    uid = 0;
    OC_SCENES[name](scene);
    await scene.whenReadyAsync();
    for (let i = 0; i < 4; i++) scene.render();
    const px = await engine.readPixels(0, 0, RW, RH);
    // Every pixel the renderer wrote is light over a transparent black canvas: what a solid
    // covers, what a translucent beam lets through, and the additive glow, which lands in the
    // colour channels even where nothing solid is. Give each pixel the opacity it needs to show
    // that light — its coverage, or its brightness where the light outshines it — and the
    // colour that, at that opacity, puts the same light back on the card.
    // The frame's edges are then feathered, the floor most, so a platform that runs past the
    // frame fades into the card instead of ending on a hard line.
    const img = new ImageData(RW, RH);
    const ease = (t) => (t >= 1 ? 1 : t <= 0 ? 0 : t * t * (3 - 2 * t));
    const fside = RW * 0.06, ftop = RH * 0.04, ffloor = RH * 0.16;
    for (let y = 0; y < RH; y++) {
      const fy = Math.min(ease(y / ftop), ease((RH - 1 - y) / ffloor));
      for (let x = 0; x < RW; x++) {
        const s = ((RH - 1 - y) * RW + x) * 4, d = (y * RW + x) * 4;
        const r = px[s], g = px[s + 1], b = px[s + 2], a = px[s + 3];
        const A = Math.max(a, r, g, b);
        if (A === 0) { img.data[d + 3] = 0; continue; }
        const k = 255 / A;
        const f = fy * Math.min(ease(x / fside), ease((RW - 1 - x) / fside));
        img.data[d] = Math.min(255, Math.round(r * k)); img.data[d + 1] = Math.min(255, Math.round(g * k)); img.data[d + 2] = Math.min(255, Math.round(b * k)); img.data[d + 3] = Math.round(A * f);
      }
    }
    const big = document.createElement('canvas'); big.width = RW; big.height = RH; big.getContext('2d').putImageData(img, 0, 0);
    const out = document.createElement('canvas'); out.width = OW; out.height = OH;
    const ctx = out.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(big, 0, 0, OW, OH);
    const data = out.toDataURL('image/webp', 0.84);
    scene.dispose(); engine.dispose(); canvas.remove();
    return { data, width: OW, height: OH };
  };
})();

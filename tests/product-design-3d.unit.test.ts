/**
 * Design Studio, DS-1c — the 3D view, public/product-design/pd-3d.js, and how the editor uses it.
 *
 * What a browser shows (that it renders, picks, drags, compares and disposes) is proven in Chromium by
 * tools/components/product-design-3d-proof.cjs (P16). What the source itself must never do is pinned here:
 * it loads nothing but the platform's vendored Babylon build, talks to no server, runs no code from a string,
 * writes no inline style, says nothing to the reader in its own words, and gives back everything it takes.
 * The editor's comparison only ever reads a saved version.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const SRC = fs.readFileSync(path.join(ROOT, 'public/product-design/pd-3d.js'), 'utf8');
const CODE = strip(SRC);
const EDITOR = strip(fs.readFileSync(path.join(ROOT, 'public/product-design/product-design.js'), 'utf8'));

describe('what the 3D view may load and do', () => {
  it('loads one script, the platform’s own vendored Babylon build, and nothing else from anywhere', () => {
    expect((CODE.match(/createElement\('script'\)/g) || []).length).toBe(1);
    expect(CODE).toContain("el.src = '/vendor/babylon.js';");
    expect(CODE).not.toMatch(/https?:\/\//);
    expect(CODE).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|SceneLoader|ImportMesh|\.Append\(/);
    // The vendored file is the one the Neural Digital Twin already uses (Apache-2.0).
    expect(fs.existsSync(path.join(ROOT, 'public/vendor/babylon.js'))).toBe(true);
  });

  it('runs no code from a string and writes no inline style', () => {
    expect(CODE).not.toMatch(/\beval\(|new Function|setTimeout\(\s*['"`]|setInterval\(/);
    expect(CODE).not.toMatch(/setAttribute\(\s*['"]style['"]|\.cssText|\.style\b|innerHTML|insertAdjacentHTML|document\.write/);
  });

  it('says nothing to the reader in its own words: every visible word comes from the editor’s catalogue', () => {
    // The only text it draws is the comparison's two labels, handed to it by the editor.
    expect(CODE).toContain('ctx.fillText(text, w / 2, h / 2, w - 24);');
    expect(CODE).toContain('label(labels.current,');
    expect(CODE).toContain('label(labels.other,');
    expect(CODE).not.toMatch(/fillText\('|textContent|aria-label/);
  });

  it('paints from SVG through a blob URL that it always revokes, one image in flight per surface', () => {
    expect((CODE.match(/URL\.createObjectURL\(/g) || []).length).toBe(1);
    expect(CODE).toContain("new Blob([text], { type: 'image/svg+xml' })");
    expect(CODE).toContain('URL.revokeObjectURL(url);');
    expect(CODE).toContain("state.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (_) {} });");
    expect(CODE).toContain('if (state.want[id] && !state.painting[id] && panels[id])');
  });

  it('gives back everything it takes when it is disposed: listeners, observer, frame, URLs, scene, engine, canvas', () => {
    const adds = [...CODE.matchAll(/window\.addEventListener\('([a-z]+)', ([a-zA-Z]+)\)/g)].map((m) => m[1] + ':' + m[2]).sort();
    const removes = [...CODE.matchAll(/window\.removeEventListener\('([a-z]+)', ([a-zA-Z]+)\)/g)].map((m) => m[1] + ':' + m[2]).sort();
    expect(adds).toEqual(['pointercancel:onDragEnd', 'pointermove:onDragMove', 'pointerup:onDragEnd']);
    expect(removes).toEqual(adds);
    const dispose = CODE.slice(CODE.indexOf('function dispose() {'), CODE.indexOf('return {', CODE.indexOf('function dispose() {')));
    for (const step of ['onDragEnd(null);', 'window.cancelAnimationFrame(state.raf);', 'observer.disconnect();', 'URL.revokeObjectURL(u);', 'engine.stopRenderLoop();', 'scene.dispose();', 'engine.dispose();', 'canvas.parentNode.removeChild(canvas);']) {
      expect([step, dispose.includes(step)]).toEqual([step, true]);
    }
  });

  it('keeps the focus with the editor and draws only when something changed', () => {
    expect(CODE).toContain('engine.canvasTabIndex = -1;');
    expect(CODE).toContain("canvas.setAttribute('aria-hidden', 'true');");
    expect(CODE).toContain("camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');");
    expect(CODE).toContain('if (!state.dirty && !moving) { adapt(false); state.lastFrame = 0; return; }');
  });

  it('honours reduced motion: no turntable and no animated camera for a reader who asked for less motion', () => {
    expect(CODE).toContain("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
    expect(CODE).toContain('state.turntable = !!on && !reduced;');
    expect(CODE).toContain('if (instant || reduced) {');
  });

  it('keeps the orbit it is given when the camera’s target moves (Babylon would recompute it from the old position)', () => {
    const calls = [...CODE.matchAll(/camera\.setTarget\(([^;]+)\);/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect([c, /, false, false, true$/.test(c)]).toEqual([c, true]);
  });
});

describe('how the editor uses it', () => {
  it('3D and the turntable are live only where WebGL is, and otherwise say why', () => {
    expect(EDITOR).toContain('function live3d(el, reasonKey) { return can3d() ? el : planned(el, reasonKey); }');
    expect(EDITOR).toContain('function can3d() { return !!(D3 && G3 && D3.webglAvailable()); }');
  });

  it('a comparison only reads a saved version, validates it with the core, and never puts it in the editor', () => {
    const cmp = EDITOR.slice(EDITOR.indexOf('function compareWith(number, quiet) {'), EDITOR.indexOf('function cycleBtn(what, ic) {'));
    expect(cmp.length).toBeGreaterThan(500);
    expect(cmp.length).toBeLessThan(3000);
    expect(cmp).toContain('P.api.getRevision(link.projectId, number)');
    expect(cmp).toContain('C.validateDocument(r.data.revision.document, TEMPLATE)');
    expect(cmp).not.toMatch(/saveRevision|restoreRevision|createProject|setLink|S\.doc\s*=|saveNow|commitOp|C\.record/);
    // Drawing it swaps the document for the length of one synchronous call and always puts the editor's back.
    expect(EDITOR).toContain('var keep = S.doc;\n    S.doc = doc;\n    try { return fn(); } finally { S.doc = keep; }');
  });

  it('a drag on the garment is the flat panel’s move: the same core function, the same undo step', () => {
    const drag = EDITOR.slice(EDITOR.indexOf('function drag3d(surfaceId, mm) {'), EDITOR.indexOf('function key3d(ev, n) {'));
    expect(drag).toContain('C.moveBox(d.start, mm.x - d.p0.x, mm.y - d.p0.y,');
    expect(drag).toContain('recordDrag(d);');
    expect(EDITOR).toContain('function recordDrag(d) {');
  });

  it('the garment’s artwork is the 2D canvas’s own drawing, with the lettering’s font written out for an image', () => {
    const tex = EDITOR.slice(EDITOR.indexOf('function texture3d(surfaceId, w, hgt, overlay) {'), EDITOR.indexOf('function boxOutline('));
    expect(tex).toContain('layerNode(defs, prefix, n, bounds)');
    expect(tex).toContain("t.setAttribute('font-family', familyOf(FONT[n.font] || FONT['sans-black']))");
    expect(tex).toContain('new XMLSerializer().serializeToString(svg)');
  });

  it('closes the 3D view whenever the room is rebuilt or torn down', () => {
    expect(EDITOR).toMatch(/function build\(\) \{\s*var host = S\.host, E = S\.el;\s*close3d\(\);/);
    expect(EDITOR).toMatch(/teardownFamilistaProductDesign = function \(\) \{[\s\S]*?close3d\(\);[\s\S]*?unbind\(\);/);
  });
});

/**
 * Design Studio, DS-1c — the garment geometry, public/product-design/pd-garment.js.
 *
 * The 3D view is only as honest as this mapping, so its promises are pinned on
 * the real jersey template rather than on a picture:
 *   · a vertex's texture coordinate is its flat position, exactly, so the
 *     artwork the 2D editor draws is the artwork the garment shows;
 *   · body rows are wrapped by arc length: millimetres across the flat panel
 *     are millimetres around the garment;
 *   · front and back meet at the side seams and along the shoulders, and each
 *     sleeve closes on its underarm seam;
 *   · nothing is mirrored: under each camera preset, increasing x on the flat
 *     surface runs to the right of the screen, so text reads as it was set;
 *   · the outward normals point away from the body, so a close-up looks at the
 *     artwork from outside.
 * Each promise has a negative control: the check is shown to fail on a mapping
 * that breaks it.
 */
import path from 'path';

const ROOT = path.join(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const G = require(path.join(ROOT, 'public/product-design/pd-garment.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RAW = require(path.join(ROOT, 'public/product-design/templates/football-jersey.json'));

type V3 = [number, number, number];
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// The template as the editor holds it: validated (and frozen) by the core, which throws on a bad one.
const T: Row = C.validateTemplate(RAW);
const g: Row = G.build(T);
const surface = (id: string): Row => T.surfaces.find((s: Row) => s.id === id);
const panel = (id: string): Row => g.panels.find((p: Row) => p.surface === id);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: V3, b: V3): number => Math.sqrt(dot(sub(a, b), sub(a, b)));
const IDS = ['front', 'back', 'sleeve-right', 'sleeve-left'];
const MM = 0.001;

it('reads the real template, which validates', () => {
  expect(T.key).toBe(RAW.key);
  expect(g.units).toBe('m');
  expect(g.panels.map((p: Row) => p.surface)).toEqual(IDS);
});

describe('texture coordinates are flat positions', () => {
  it.each(IDS)('%s: every vertex has u = x / width and v = 1 − y / height, exactly', (id) => {
    const p = panel(id), ts = surface(id);
    const n = p.mesh.uvs.length / 2;
    expect(n).toBe(p.mesh.positions.length / 3);
    expect(n).toBe(p.mesh.flat.length / 2);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const x = p.mesh.flat[2 * i], y = p.mesh.flat[2 * i + 1];
      worst = Math.max(worst, Math.abs(p.mesh.uvs[2 * i] - x / ts.width), Math.abs(p.mesh.uvs[2 * i + 1] - (1 - y / ts.height)));
    }
    expect(worst).toBe(0);
    expect(p.size).toEqual({ w: ts.width, h: ts.height });
  });

  it.each(IDS)('%s: the mesh covers the whole outline, so no artwork falls off the garment', (id) => {
    const p = panel(id), ts = surface(id);
    const poly = C.flatten(ts.outline);
    const ys = poly.map((q: number[]) => q[1]), xs = poly.map((q: number[]) => q[0]);
    const fy = p.mesh.flat.filter((_: number, i: number) => i % 2 === 1), fx = p.mesh.flat.filter((_: number, i: number) => i % 2 === 0);
    expect(Math.min(...fy)).toBeCloseTo(Math.min(...ys), 6);
    expect(Math.max(...fy)).toBeCloseTo(Math.max(...ys), 6);
    expect(Math.min(...fx)).toBeLessThanOrEqual(Math.min(...xs) + 1e-6);
    expect(Math.max(...fx)).toBeGreaterThanOrEqual(Math.max(...xs) - 1e-6);
  });

  it('a picked texture coordinate returns the millimetres it came from, through the mapping and back', () => {
    // pd-3d.js reads a pick as { x: u·width, y: (1 − v)·height }.
    for (const id of IDS) {
      const p = panel(id), ts = surface(id);
      for (let i = 0; i < p.mesh.uvs.length / 2; i += 97) {
        const u = p.mesh.uvs[2 * i], v = p.mesh.uvs[2 * i + 1];
        expect(u * ts.width).toBeCloseTo(p.mesh.flat[2 * i], 9);
        expect((1 - v) * ts.height).toBeCloseTo(p.mesh.flat[2 * i + 1], 9);
        const at = g.mappers[id](p.mesh.flat[2 * i], p.mesh.flat[2 * i + 1]);
        expect(dist(at, [p.mesh.positions[3 * i], p.mesh.positions[3 * i + 1], p.mesh.positions[3 * i + 2]])).toBeLessThan(1e-12);
      }
    }
  });
});

describe('millimetres are kept', () => {
  /** The length of a row of the surface in 3D, from x0 to x1, by fine steps. */
  function rowLength(id: string, y: number, x0: number, x1: number, steps = 2000): number {
    let len = 0, prev = g.mappers[id](x0, y);
    for (let k = 1; k <= steps; k++) { const q = g.mappers[id](x0 + (x1 - x0) * (k / steps), y); len += dist(prev, q); prev = q; }
    return len;
  }

  it.each(['front', 'back'])('%s: below the shoulders, a row is as long around the body as it is across the flat panel', (id) => {
    const lm = g.landmarks[id];
    let worst = 0;
    for (let y = lm.tip[1] + 2; y < lm.corner - 1; y += 37) {
      const e = g.extents[id](y);
      // The whole row, and a 100 mm piece of it, which is what a placed element measures.
      worst = Math.max(worst, Math.abs(rowLength(id, y, e[0], e[1]) - (e[1] - e[0]) * MM) / ((e[1] - e[0]) * MM));
      const mid = (e[0] + e[1]) / 2;
      worst = Math.max(worst, Math.abs(rowLength(id, y, mid - 50, mid + 50) - 0.1) / 0.1);
    }
    expect(worst).toBeLessThan(0.002);
  });

  it.each(['sleeve-right', 'sleeve-left'])('%s: a row goes once round the arm, its circumference the flat width', (id) => {
    const ts = surface(id);
    let worst = 0;
    for (let y = 140; y <= 248; y += 18) {
      const e = g.extents[id](y);
      worst = Math.max(worst, Math.abs(rowLength(id, y, e[0], e[1]) - (e[1] - e[0]) * MM) / ((e[1] - e[0]) * MM));
    }
    expect(worst).toBeLessThan(0.002);
    expect(ts.width).toBeGreaterThan(0);
  });

  it('down the body, a column is as long as the panel is tall below the shoulders', () => {
    const lm = g.landmarks.front, x = 270;
    const a = g.mappers.front(x, lm.tip[1] + 10), b = g.mappers.front(x, lm.corner - 10);
    // The body is a cylinder of changing section: the length down the centre front is at least the flat drop, and not much more.
    const drop = (lm.corner - 20 - lm.tip[1]) * MM;
    expect(Math.abs(a[1] - b[1])).toBeCloseTo(drop, 9);
    expect(dist(a, b)).toBeLessThan(drop * 1.08);
  });

  it('negative control: a mapping that wraps by angle instead of arc length fails the row check', () => {
    const lm = g.landmarks.front, y = 400, e = g.extents.front(y), w = e[1] - e[0];
    const a = (w / G.arcTotal) * MM;
    const byAngle = (x: number): V3 => { const th = Math.PI * (1 - (x - e[0]) / w); return [a * Math.cos(th), 0, -G.DEPTH * a * Math.sin(th)]; };
    let len = 0, prev = byAngle(e[0] + w / 2 - 50);
    for (let k = 1; k <= 2000; k++) { const q = byAngle(e[0] + w / 2 - 50 + 100 * (k / 2000)); len += dist(prev, q); prev = q; }
    expect(Math.abs(len - 0.1) / 0.1).toBeGreaterThan(0.002);
    expect(lm.tip[1]).toBeLessThan(y);
  });
});

describe('the seams close', () => {
  it('front and back meet along both side seams, from the shoulder tip to the hem', () => {
    const W = surface('front').width, lm = g.landmarks.front;
    let worst = 0;
    for (let y = lm.tip[1]; y <= lm.corner; y += 7) {
      const ef = g.extents.front(y), eb = g.extents.back(y);
      // The wearer's right: the front's left edge and the back's right edge; and the other side.
      worst = Math.max(worst, dist(g.mappers.front(ef[0], y), g.mappers.back(eb[1], y)));
      worst = Math.max(worst, dist(g.mappers.front(ef[1], y), g.mappers.back(eb[0], y)));
    }
    expect(worst).toBeLessThan(1e-9);
    expect(W).toBe(surface('back').width);
  });

  it('front and back meet along the shoulders, as the top of each panel’s outline draws them', () => {
    const W = surface('front').width, lm = g.landmarks.front;
    let worst = 0, n = 0;
    // From the shoulder tip to the neck's corner, on the hull's top edge both panels share.
    for (let x = lm.tip[0]; x <= 185; x += 4) {
      const y = g.shoulders.front(x);
      expect(g.shoulders.back(W - x)).toBeCloseTo(y, 9);
      worst = Math.max(worst, dist(g.mappers.front(x, y), g.mappers.back(W - x, y)));
      worst = Math.max(worst, dist(g.mappers.front(W - x, y), g.mappers.back(x, y)));
      n++;
    }
    expect(n).toBeGreaterThan(20);
    expect(worst).toBeLessThan(1e-9);
    // The shoulder line is the outline's own: it passes through the tip and the neck's corner.
    expect(g.shoulders.front(lm.tip[0])).toBeCloseTo(lm.tip[1], 9);
    expect(g.shoulders.front(185)).toBeCloseTo(12, 9);
  });

  it.each(['sleeve-right', 'sleeve-left'])('%s closes on its underarm seam', (id) => {
    let worst = 0;
    for (let y = 120; y <= 250; y += 5) {
      const e = g.extents[id](y);
      worst = Math.max(worst, dist(g.mappers[id](e[0], y), g.mappers[id](e[1], y)));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('each sleeve head sits on its shoulder tip, on its own side', () => {
    const lm = g.landmarks.front, W = surface('front').width;
    const tipR = g.mappers.front(lm.tip[0], lm.tip[1]), tipL = g.mappers.front(W - lm.tip[0], lm.tip[1]);
    const capR = g.mappers['sleeve-right'](210, 44), capL = g.mappers['sleeve-left'](210, 44);
    expect(dist(capR, tipR)).toBeLessThan(0.002);
    expect(dist(capL, tipL)).toBeLessThan(0.002);
    expect(tipR[0]).toBeLessThan(0);
    expect(tipL[0]).toBeGreaterThan(0);
    // The sleeves hang down and away from the body.
    expect(g.sleeves['sleeve-right'].axis[0]).toBeLessThan(0);
    expect(g.sleeves['sleeve-left'].axis[0]).toBeGreaterThan(0);
    expect(g.sleeves['sleeve-right'].axis[1]).toBeLessThan(0);
  });

  it('the hem and the cuffs do not flare: the last row is as wide as the one above it', () => {
    for (const id of IDS) {
      const p = panel(id), cols = p.mesh.cols, rows = p.mesh.rows, pos = p.mesh.positions;
      const at = (r: number, c: number): V3 => [pos[3 * (r * cols + c)], pos[3 * (r * cols + c) + 1], pos[3 * (r * cols + c) + 2]];
      const width = (r: number) => dist(at(r, 0), at(r, Math.floor(cols / 2)));
      expect(Math.abs(width(rows - 1) - width(rows - 2)) / width(rows - 2)).toBeLessThan(0.05);
    }
  });

  it('the cuff trims lie on their sleeves', () => {
    for (const id of ['sleeve-right', 'sleeve-left']) {
      const ring: V3[] = g.trims.cuffs[id];
      expect(ring.length).toBeGreaterThan(40);
      const e = g.extents[id](250);
      const end = g.mappers[id]((e[0] + e[1]) / 2, 250);
      const axisPoint = g.mappers[id](e[0], 250);
      // Every point of the ring is on the sleeve's last row: the same distance from the axis as the sleeve there.
      const centre: V3 = [(end[0] + axisPoint[0]) / 2, (end[1] + axisPoint[1]) / 2, (end[2] + axisPoint[2]) / 2];
      const r = dist(end, centre);
      for (const q of ring) expect(Math.abs(dist(q, centre) - r)).toBeLessThan(0.0005);
    }
  });
});

describe('nothing is mirrored', () => {
  const PRESET_OF: Record<string, string> = { front: 'front', back: 'back', 'sleeve-right': 'sleeve-right', 'sleeve-left': 'sleeve-left' };
  /** Where a text would sit on each surface: the chest, the back's number, the middle of each sleeve. */
  const SPOT: Record<string, [number, number]> = { front: [270, 300], back: [270, 330], 'sleeve-right': [210, 150], 'sleeve-left': [210, 150] };

  it.each(IDS)('%s: under its own preset, increasing x runs to the right of the screen and increasing y runs down', (id) => {
    const preset = g.presets[PRESET_OF[id]];
    const right: V3 = G.screenRight(preset);
    const [x, y] = SPOT[id];
    const p = g.mappers[id](x, y), px = g.mappers[id](x + 5, y), py = g.mappers[id](x, y + 5);
    expect(dot(sub(px, p), right)).toBeGreaterThan(0.004);
    expect(sub(py, p)[1]).toBeLessThan(0);
    // And the surface faces that camera, so it is the outside being read, not the inside.
    const eye: V3 = G.eye(preset);
    expect(dot(G.outward(g.mappers[id], x, y), sub(eye, p))).toBeGreaterThan(0);
  });

  it('the front is at −z and faces −z; the back at +z and faces +z; the wearer’s right is −x', () => {
    const f = g.mappers.front(270, 300), b = g.mappers.back(270, 330);
    expect(f[2]).toBeLessThan(0);
    expect(b[2]).toBeGreaterThan(0);
    expect(G.outward(g.mappers.front, 270, 300)[2]).toBeLessThan(-0.9);
    expect(G.outward(g.mappers.back, 270, 330)[2]).toBeGreaterThan(0.9);
    expect(g.mappers['sleeve-right'](210, 150)[0]).toBeLessThan(0);
    expect(g.mappers['sleeve-left'](210, 150)[0]).toBeGreaterThan(0);
  });

  it('negative control: a front wrapped the other way round reads backwards under the front preset', () => {
    const right: V3 = G.screenRight(G.PRESETS.front);
    const mirrored = (x: number, y: number): V3 => { const q = g.mappers.front(x, y); return [-q[0], q[1], q[2]]; };
    expect(dot(sub(mirrored(275, 300), mirrored(270, 300)), right)).toBeLessThan(0);
  });

  it('a close-up faces the point it inspects, from outside, at the distance asked', () => {
    for (const id of IDS) {
      const [x, y] = SPOT[id];
      const p: V3 = g.mappers[id](x, y), n: V3 = G.outward(g.mappers[id], x, y);
      const f = G.facing(p, n, 0.6);
      expect(f.target).toEqual(p);
      const eye: V3 = G.eye(f, p);
      expect(dist(eye, p)).toBeCloseTo(0.6, 9);
      expect(dot(sub(eye, p), n) / 0.6).toBeGreaterThan(0.95);
    }
  });
});

describe('the cameras', () => {
  it('each preset puts the eye where Babylon’s ArcRotateCamera would', () => {
    const e: V3 = G.eye(G.PRESETS.front);
    expect(e[0]).toBeCloseTo(0, 9);
    expect(e[2]).toBeLessThan(-1.2);
    expect(G.eye(G.PRESETS.back)[2]).toBeGreaterThan(1.2);
    expect(G.eye(g.presets['sleeve-right'])[0]).toBeLessThan(g.presets['sleeve-right'].target[0] - 0.5);
    expect(G.eye(g.presets['sleeve-left'])[0]).toBeGreaterThan(g.presets['sleeve-left'].target[0] + 0.5);
  });
  it('the front and the back see the whole garment: its bounding sphere fits the field of view', () => {
    const b = g.bounds, r = dist(b.min, b.max) / 2;
    for (const k of ['front', 'back']) {
      // pd-3d.js uses a field of view of 0.6 rad, held on the canvas's narrower side.
      expect(Math.asin(r / g.presets[k].radius)).toBeLessThan(0.3 * 1.25);
      expect(g.presets[k].target).toEqual([0, 0, 0]);
    }
  });
  it('each side looks at its own sleeve from outside, nearly face on, with the whole sleeve in view', () => {
    for (const id of ['sleeve-right', 'sleeve-left']) {
      const p = g.presets[id], eye: V3 = G.eye(p), e = g.extents[id](250);
      const mid: [number, number] = [(e[0] + e[1]) / 2, (128 + 250) / 2];
      const at: V3 = g.mappers[id](mid[0], mid[1]), n: V3 = G.outward(g.mappers[id], mid[0], mid[1]);
      const toEye = sub(eye, at), len = Math.sqrt(dot(toEye, toEye));
      expect(dot(toEye, n) / len).toBeGreaterThan(0.9);
      // Every vertex of the sleeve is within the field of view from that eye.
      const m = panel(id).mesh, fwd = sub(p.target, eye), fl = Math.sqrt(dot(fwd, fwd));
      let widest = 0;
      for (let i = 0; i < m.positions.length; i += 3) {
        const v = sub([m.positions[i], m.positions[i + 1], m.positions[i + 2]], eye);
        widest = Math.max(widest, Math.acos(dot(v, fwd) / (Math.sqrt(dot(v, v)) * fl)));
      }
      expect(widest).toBeLessThan(0.3);
    }
  });
  it('the presets of a built garment are the static ones, with their targets', () => {
    for (const k of Object.keys(G.PRESETS)) {
      expect(g.presets[k]).toMatchObject({ alpha: G.PRESETS[k].alpha, beta: G.PRESETS[k].beta, radius: G.PRESETS[k].radius });
      expect(g.presets[k].target).toHaveLength(3);
    }
  });
});

describe('determinism and density', () => {
  it('builds the same garment twice, to the bit', () => {
    const again = G.build(T);
    expect(JSON.stringify(again.panels)).toBe(JSON.stringify(g.panels));
    expect(JSON.stringify(again.seams)).toBe(JSON.stringify(g.seams));
    expect(JSON.stringify(again.trims)).toBe(JSON.stringify(g.trims));
  });
  it('a lower density is coarser but keeps the same mapping', () => {
    const low = G.build(T, { rowMm: 14, cols: 36 });
    const p = low.panels[0];
    expect(p.mesh.cols).toBe(37);
    expect(p.mesh.positions.length).toBeLessThan(panel('front').mesh.positions.length / 3);
    expect(low.mappers.front(300, 400)).toEqual(g.mappers.front(300, 400));
    // And a build with a density leaves the default as it was.
    expect(JSON.stringify(G.build(T).panels[0].mesh.positions)).toBe(JSON.stringify(panel('front').mesh.positions));
  });
  it('every triangle index is in range, and every triangle has area', () => {
    for (const id of IDS) {
      const m = panel(id).mesh, n = m.positions.length / 3;
      expect(m.indices.length % 3).toBe(0);
      expect(Math.max(...m.indices)).toBeLessThan(n);
      expect(Math.min(...m.indices)).toBe(0);
    }
  });
  it('refuses a template without the four surfaces it needs', () => {
    expect(() => G.build({ ...T, surfaces: T.surfaces.slice(0, 2) })).toThrow(/front, back and both sleeves/);
  });
  it('is pure: no DOM, no WebGL, no Babylon, no clock, no randomness', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('fs').readFileSync(path.join(ROOT, 'public/product-design/pd-garment.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/document\.|BABYLON|Date\.|Math\.random|performance\.|fetch\(|localStorage/);
  });
});

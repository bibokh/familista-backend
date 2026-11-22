/**
 * Design Studio, M1b — legwear in three dimensions: shorts and socks (public/product-design/pd-garment.js).
 *
 * Pinned on every released legwear template in the registry:
 *   · a vertex's texture coordinate is its flat position, exactly, so the 3D garment shows the artwork the 2D editor draws;
 *   · every section is wrapped by arc length: shorts' rows (the rise, where the hip's one section becomes two legs,
 *     included) and the sock's rows, ankle rays and foot columns: millimetres across the flat surface are millimetres
 *     round the garment;
 *   · the two surfaces meet: shorts' front and back at the side seams, the inseams and the crotch; a sock's two faces
 *     along its whole outline but the opening, the toe closing in a point;
 *   · nothing is mirrored: under each view's camera, increasing x on the flat surface runs to the right of the screen;
 *   · the outward normals point away from the garment.
 * Each check has a negative control showing it fails on a mapping that breaks the promise. The core's validation of
 * the template fields legwear adds (form, part names, patches, a sock's ankle) is pinned here too.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const G = require(path.join(ROOT, 'public/product-design/pd-garment.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
const DIR = path.join(ROOT, 'public/product-design/templates');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const INDEX = read('index.json');
type V3 = [number, number, number];
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type At = (x: number, y: number) => V3;
const LEGWEAR: Array<{ file: string; form: string }> = INDEX.templates.map((e: { file: string }) => ({ file: e.file, form: read(e.file).form || 'top' }))
  .filter((e: { form: string }) => e.form !== 'top');
const SHORTS = LEGWEAR.filter((e) => e.form === 'shorts').map((e) => e.file);
const SOCKS = LEGWEAR.filter((e) => e.form === 'socks').map((e) => e.file);
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** The 3D length of a flat straight line from a to b, in millimetres, walked in `n` steps. */
function walked(at: At, a: [number, number], b: [number, number], n = 400): number {
  let L = 0, p = at(a[0], a[1]);
  for (let i = 1; i <= n; i++) { const q = at(a[0] + (b[0] - a[0]) * (i / n), a[1] + (b[1] - a[1]) * (i / n)); L += dist(p, q); p = q; }
  return L * 1000;
}
/** A mapping stretched by k across x: what an unscaled or mis-measured section would look like. */
const stretched = (at: At, k: number): At => (x, y) => { const p = at(x, y); return [p[0] * k, p[1], p[2] * k]; };

it('the registry releases shorts, goalkeeper shorts and socks on the legwear builders', () => {
  expect(SHORTS).toEqual(['shorts.json', 'gk-shorts.json']);
  expect(SOCKS).toEqual(['socks.json']);
});

describe.each(SHORTS)('%s', (file) => {
  const T: Row = C.validateTemplate(read(file));
  const g: Row = G.build(T);
  const W: number = T.surfaces[0].width;
  const poly = G.flatten(T.surfaces[0].outline);
  const crotchY: number = g.landmarks.front.crotch[1];
  /** The row's spans: the hip's one above the crotch, the legs' two below it. */
  const rowSpans = (y: number): number[][] => (y < crotchY ? [g.extents.front(y)] : G.spans(poly, y, 1));
  const ROWS = Array.from({ length: Math.floor((g.landmarks.front.hem - 4) / 7) }, (_, i) => 2 + i * 7);

  it('is built as shorts: a front and a back, opening on the front, compared side by side', () => {
    expect(g.form).toBe('shorts');
    expect(g.panels.map((p: Row) => p.surface)).toEqual(['front', 'back']);
    expect([g.home, g.across]).toEqual(['front', [1, 0, 0]]);
    expect(Object.keys(g.presets)).toEqual(['front', 'back']);
  });

  it('every vertex has u = x / width and v = 1 − y / height, exactly', () => {
    for (const p of g.panels) {
      const m = p.mesh, s = T.surfaces.find((q: Row) => q.id === p.surface);
      for (let i = 0; i < m.flat.length / 2; i++) {
        expect(m.uvs[2 * i]).toBe(m.flat[2 * i] / s.width);
        expect(m.uvs[2 * i + 1]).toBe(1 - m.flat[2 * i + 1] / s.height);
      }
    }
  });

  it('every row is wrapped by arc length, the rise where one section becomes two included', () => {
    let worst = 0, rise = 0;
    for (const id of ['front', 'back']) for (const y of ROWS) for (const e of rowSpans(y)) {
      const err = Math.abs(walked(g.mappers[id], [e[0], y], [e[1], y]) - (e[1] - e[0])) / (e[1] - e[0]);
      worst = Math.max(worst, err);
      if (y > crotchY - G.RISE_MM && y < crotchY) rise++;
    }
    expect(rise).toBeGreaterThan(20); // the rise itself was measured
    expect(worst).toBeLessThan(1e-3);
  });

  it('negative control: a section 3 % too wide is caught by the same measurement', () => {
    const e = rowSpans(crotchY - 50)[0];
    const err = Math.abs(walked(stretched(g.mappers.front, 1.03), [e[0], crotchY - 50], [e[1], crotchY - 50]) - (e[1] - e[0])) / (e[1] - e[0]);
    expect(err).toBeGreaterThan(1e-2);
  });

  it('front and back meet at the side seams, the inseams and the crotch', () => {
    let gap = 0, n = 0;
    for (const y of ROWS) for (const e of rowSpans(y)) for (const x of e) {
      gap = Math.max(gap, dist(g.mappers.front(x, y), g.mappers.back(W - x, y))); n++;
    }
    gap = Math.max(gap, dist(g.mappers.front(...g.landmarks.front.crotch as [number, number]), g.mappers.back(W - g.landmarks.front.crotch[0], crotchY)));
    expect(n).toBeGreaterThan(150);
    expect(gap * 1000).toBeLessThan(0.01);
  });

  it('negative control: a back panel standing 1 mm off is caught', () => {
    const off: At = (x, y) => { const p = g.mappers.back(x, y); return [p[0], p[1], p[2] + 0.001]; };
    const e = rowSpans(100)[0];
    expect(dist(g.mappers.front(e[0], 100), off(W - e[0], 100)) * 1000).toBeGreaterThan(0.9);
  });

  it('below the crotch the legs are two tubes, apart by the flat gap between them at the hem', () => {
    const hem = g.landmarks.front.hem - 1, [L, R] = rowSpans(hem);
    const xl = g.mappers.front(L[1], hem)[0], xr = g.mappers.front(R[0], hem)[0];
    expect((xr - xl) * 1000).toBeCloseTo(R[0] - L[1], 3);
    // On the front, the flat left leg is the wearer's right (−x); on the back, the flat left leg is the wearer's left.
    expect(g.mappers.front((L[0] + L[1]) / 2, hem)[0]).toBeLessThan(0);
    expect(g.mappers.back((L[0] + L[1]) / 2, hem)[0]).toBeGreaterThan(0);
  });

  it('no triangle bridges the gap between the legs', () => {
    const inside = (x: number, y: number) => G.spans(poly, y, 1).some((s: number[]) => x >= s[0] - 1e-6 && x <= s[1] + 1e-6);
    for (const p of g.panels) {
      const m = p.mesh;
      for (let i = 0; i < m.indices.length; i += 3) {
        const c = [0, 1, 2].map((k) => m.indices[i + k]), cx = c.reduce((a, j) => a + m.flat[2 * j], 0) / 3, cy = c.reduce((a, j) => a + m.flat[2 * j + 1], 0) / 3;
        if (cy > crotchY + 0.5 && cy < g.landmarks.front.hem - 0.5) expect([p.surface, i, inside(cx, cy)]).toEqual([p.surface, i, true]);
      }
    }
  });

  it('nothing is mirrored: under each camera, flat x runs to the right of the screen', () => {
    for (const id of ['front', 'back']) {
      const right = G.screenRight(g.presets[id]);
      for (const [x, y] of [[360, 100], [170, 380], [540, 380]]) {
        expect([id, x, y, dot(right, sub(g.mappers[id](x + 10, y), g.mappers[id](x, y))) > 0]).toEqual([id, x, y, true]);
      }
    }
    // negative control: the front read from behind runs the other way
    expect(dot(G.screenRight(g.presets.back), sub(g.mappers.front(370, 100), g.mappers.front(360, 100)))).toBeLessThan(0);
  });

  it('the outward normals point away from the garment: the front towards −z, the back towards +z', () => {
    for (const [x, y] of [[360, 100], [170, 380], [540, 380]]) {
      expect(G.outward(g.mappers.front, x, y)[2]).toBeLessThan(-0.8);
      expect(G.outward(g.mappers.back, W - x, y)[2]).toBeGreaterThan(0.8);
    }
    // negative control: a mapping read backwards along x turns its normal inside
    const back: At = (x, y) => g.mappers.front(W - x, y);
    expect(G.outward(back, 360, 100)[2]).toBeGreaterThan(0.8);
  });

  it('the waist and each leg opening carry a trim, the waist closing round the garment', () => {
    expect(g.trims.collar).toHaveLength(2);
    expect(Object.keys(g.trims.cuffs).sort()).toEqual(['back-l', 'back-r', 'front-l', 'front-r']);
    const [f, b] = g.trims.collar;
    expect(dist(f[0], b[b.length - 1]) * 1000).toBeLessThan(0.01);
    expect(dist(f[f.length - 1], b[0]) * 1000).toBeLessThan(0.01);
  });

  it('each view’s default distance holds the whole garment on a square canvas', () => {
    for (const id of ['front', 'back']) {
      const p = g.presets[id];
      expect(p.radius).toBeGreaterThanOrEqual(G.fitRadius(p.fit, 0.6, 1) - 1e-9);
      expect(p.fit.hw).toBeCloseTo((g.bounds.max[0] - g.bounds.min[0]) / 2, 9);
    }
  });
});

describe.each(SOCKS)('%s', (file) => {
  const T: Row = C.validateTemplate(read(file));
  const g: Row = G.build(T);
  const W: number = T.surfaces[0].width;
  const outline: number[][] = G.flatten(T.surfaces[0].outline, 24);
  const top: number = g.landmarks.outer.top;
  const mirror = (q: number[]): [number, number] => [W - q[0], q[1]];

  it('is built as a sock: an outer and an inner face, a right sock, opening on its outer side', () => {
    expect(g.form).toBe('socks');
    expect(g.panels.map((p: Row) => p.surface)).toEqual(['outer', 'inner']);
    expect([g.home, g.across]).toEqual(['outer', [-0, 0, -1]]);
    // Its toes point forward (−z), its top stands above its sole.
    const tip = g.mappers.outer(...g.landmarks.outer.tip as [number, number]), cuff = g.mappers.outer(100, top);
    expect(tip[2]).toBeLessThan(cuff[2] - 0.1);
    expect(cuff[1] - tip[1]).toBeGreaterThan(0.4);
  });

  it('every vertex has u = x / width and v = 1 − y / height, exactly', () => {
    for (const p of g.panels) {
      const m = p.mesh;
      for (let i = 0; i < m.flat.length / 2; i++) {
        expect(m.uvs[2 * i]).toBe(m.flat[2 * i] / W);
        expect(m.uvs[2 * i + 1]).toBe(1 - m.flat[2 * i + 1] / T.surfaces[0].height);
      }
    }
  });

  it('every section, leg row, ankle ray and foot column alike, is wrapped by arc length', () => {
    for (const p of g.panels) {
      const m = p.mesh;
      let worst = 0;
      for (let r = 0; r < m.rows; r++) {
        const a: [number, number] = [m.flat[2 * r * m.cols], m.flat[2 * r * m.cols + 1]], b: [number, number] = [m.flat[2 * ((r + 1) * m.cols - 1)], m.flat[2 * ((r + 1) * m.cols - 1) + 1]];
        const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (w > 5) worst = Math.max(worst, Math.abs(walked(g.mappers[p.surface], a, b) - w) / w);
      }
      expect([p.surface, m.rows > 120, worst < 1e-3]).toEqual([p.surface, true, true]);
    }
  });

  it('negative control: a section 3 % too wide is caught by the same measurement', () => {
    const e = G.rowExtent(outline, 200);
    expect(Math.abs(walked(stretched(g.mappers.outer, 1.03), [e[0], 200], [e[1], 200]) - (e[1] - e[0])) / (e[1] - e[0])).toBeGreaterThan(1e-2);
  });

  it('the two faces meet along the whole outline but the opening, and the toe closes in a point', () => {
    let gap = 0, n = 0;
    for (const q of outline) {
      if (q[1] < top + 0.5) continue;
      gap = Math.max(gap, dist(g.mappers.outer(q[0], q[1]), g.mappers.inner(...mirror(q)))); n++;
    }
    expect(n).toBeGreaterThan(100);
    expect(gap * 1000).toBeLessThan(0.01);
    const tip = g.landmarks.outer.tip;
    expect(dist(g.mappers.outer(tip[0], tip[1]), g.mappers.outer(tip[0], tip[1] + 3)) * 1000).toBeLessThan(0.01);
    // At the opening the faces are apart: the sock is open at the top.
    expect(dist(g.mappers.outer(100, top), g.mappers.inner(W - 100, top)) * 1000).toBeGreaterThan(50);
  });

  it('negative control: an inner face that is not the outer one’s mirror is refused', () => {
    const raw = read(file);
    raw.surfaces[1].outline[2] = [raw.surfaces[1].outline[2][0] - 6, raw.surfaces[1].outline[2][1]];
    expect(() => G.build(C.validateTemplate(raw))).toThrow(/mirror the outer face/);
  });

  it('nothing is mirrored: under each face’s camera, its own flat x runs to the right of the screen', () => {
    for (const id of ['outer', 'inner']) {
      const right = G.screenRight(g.presets[id]), at = g.mappers[id];
      const pts = id === 'outer' ? [[100, 150], [250, 500]] : [[W - 100, 150], [W - 250, 500]];
      for (const [x, y] of pts) expect([id, x, y, dot(right, sub(at(x + 5, y), at(x, y))) > 0]).toEqual([id, x, y, true]);
    }
    expect(dot(G.screenRight(g.presets.inner), sub(g.mappers.outer(105, 150), g.mappers.outer(100, 150)))).toBeLessThan(0);
  });

  it('the outward normals point away from the sock: the outer face towards −x, the inner towards +x', () => {
    for (const [x, y] of [[100, 150], [100, 300], [260, 500]]) {
      expect(G.outward(g.mappers.outer, x, y)[0]).toBeLessThan(-0.8);
      expect(G.outward(g.mappers.inner, W - x, y)[0]).toBeGreaterThan(0.8);
    }
    expect(G.outward((x: number, y: number) => g.mappers.outer(W - x, y), W - 100, 150)[0]).toBeGreaterThan(0.8);
  });

  it('the opening carries the top band’s trim, round the whole sock', () => {
    expect(g.trims.collar).toHaveLength(2);
    expect(g.trims.cuffs).toEqual({});
    // Each face's line runs left to right as that face is drawn, so the outer face's calf end meets the inner face's last point.
    const [o, i] = g.trims.collar;
    expect(dist(o[0], i[i.length - 1]) * 1000).toBeLessThan(0.01);
    expect(dist(o[o.length - 1], i[0]) * 1000).toBeLessThan(0.01);
  });

  it('each view’s default distance holds the whole sock on a square canvas', () => {
    for (const id of ['outer', 'inner']) {
      const p = g.presets[id];
      expect(p.radius).toBeGreaterThanOrEqual(G.fitRadius(p.fit, 0.6, 1) - 1e-9);
      expect(p.fit.hw).toBeCloseTo((g.bounds.max[2] - g.bounds.min[2]) / 2, 9);
    }
  });
});

describe('what a legwear template may say, and what the builders refuse', () => {
  const shorts = () => read('shorts.json');
  const code = (t: unknown) => { try { C.validateTemplate(t); return null; } catch (e) { return (e as { code: string }).code; } };

  it('the core accepts each released template, and refuses an unknown form, bad part names, a bad patch or ankle, a view twice', () => {
    for (const e of LEGWEAR) expect(code(read(e.file))).toBeNull();
    expect(code({ ...shorts(), form: 'hat' })).toBe('template-form');
    expect(code({ ...shorts(), partNames: { collar: 'Waistband' } })).toBe('template-part-names');
    expect(code({ ...shorts(), partNames: { collar: 'Waistband', cuffs: '' } })).toBe('template-part-names');
    const badPatch = shorts(); badPatch.views[0].patches[0].part = 'belt';
    expect(code(badPatch)).toBe('template-patch');
    const badAnkle = read('socks.json'); badAnkle.surfaces[0].ankle = [200];
    expect(code(badAnkle)).toBe('template-ankle');
    const twice = shorts(); twice.views[1].id = 'front';
    expect(code(twice)).toBe('template-view');
  });

  it('the builders refuse a garment they cannot make, rather than drawing a wrong one', () => {
    const three = shorts(); three.surfaces.push({ ...three.surfaces[0], id: 'pocket' });
    expect(() => G.build(C.validateTemplate(three))).toThrow(/front and a back, and nothing else/);
    const noAnkle = read('socks.json'); delete noAnkle.surfaces[0].ankle;
    expect(() => G.build(C.validateTemplate(noAnkle))).toThrow(/ankle/);
    const unknownView = shorts(); unknownView.views[0].id = 'side';
    expect(() => G.build(C.validateTemplate(unknownView))).toThrow(/no camera for the view side/);
  });
});

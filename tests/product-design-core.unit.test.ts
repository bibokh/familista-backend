/**
 * tests/product-design-core.unit.test.ts
 *
 * Familista Design Studio, DS-1a — the core: the product-design document, the
 * football-jersey template, the reversible operations, the millimetre geometry
 * and the design check (public/product-design/pd-core.js).
 *
 * Every rule is held from both sides: what is accepted, and a negative control
 * showing that the same check refuses or reports when the rule is broken. A
 * check that could pass whatever the core did is not a check.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
const RAW_TEMPLATE = JSON.parse(read('public/product-design/templates/football-jersey.json'));
const T = C.validateTemplate(RAW_TEMPLATE);
const CORE = read('public/product-design/pd-core.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = any;
const fresh = (): Doc => C.createDocument(T, 'Home kit');
const codes = (fn: () => unknown): string[] => {
  try { fn(); return []; } catch (e: any) { return (e.errors || [e]).map((x: any) => x.code); }
};
const layer = (doc: Doc, id: string) => C.findLayer(doc, id).layer;
const box = (id: string, x: number, y: number, w = 40, h = 40, r = 0) => ({
  id, type: 'shape', name: 'S ' + id, visible: true, locked: false, shape: 'circle', color: 'c4', outline: null, x, y, w, h, r, w0: w, h0: h,
});

describe('the template', () => {
  it('validates, is frozen, and has one surface per view it names', () => {
    expect(Object.isFrozen(T)).toBe(true);
    expect(T.surfaces.map((s: any) => s.id)).toEqual(['front', 'back', 'sleeve-right', 'sleeve-left']);
    for (const v of T.views) expect(C.templateSurface(T, v.surface)).not.toBeNull();
  });

  it('every safe zone lies inside its printable outline (the zone a design is checked against is never wider than the cloth)', () => {
    for (const s of T.surfaces) {
      const print = C.flatten(s.outline);
      for (const p of s.safe) expect([s.id, p, C.pointInPolygon(p, print)]).toEqual([s.id, p, true]);
    }
  });

  it('refuses a template that is not one (negative controls)', () => {
    expect(codes(() => C.validateTemplate({ ...RAW_TEMPLATE, format: 'x' }))).toEqual(['template-format']);
    expect(codes(() => C.validateTemplate({ ...RAW_TEMPLATE, surfaces: [] }))).toEqual(['template-surfaces']);
    const badOutline = JSON.parse(JSON.stringify(RAW_TEMPLATE));
    badOutline.surfaces[0].outline = [[0, 0], [1, 1]];
    expect(codes(() => C.validateTemplate(badOutline))).toEqual(['template-outline']);
    const badView = JSON.parse(JSON.stringify(RAW_TEMPLATE));
    badView.views[0].surface = 'nowhere';
    expect(codes(() => C.validateTemplate(badView))).toEqual(['template-view']);
  });
});

describe('the document and what it refuses', () => {
  it('a new design is valid, has every template surface in order, and serializes to one text that round-trips byte for byte', () => {
    const doc = fresh();
    expect(doc.format).toBe('familista.product-design');
    expect(doc.version).toBe(1);
    expect(doc.surfaces.map((s: any) => s.id)).toEqual(T.surfaces.map((s: any) => s.id));
    const text = C.serializeDocument(doc);
    expect(C.serializeDocument(C.parseDocument(text, T))).toBe(text);
    // the starting design passes the design check
    expect(C.checkDesign(doc, T)).toEqual([]);
  });

  it('names are worded in the reader’s language at creation, and are the design’s own data from then on', () => {
    const doc = C.createDocument(T, 'Heimtrikot', { Pattern: 'Muster', Navy: 'Marineblau' });
    expect(layer(doc, 'l1').name).toBe('Muster');
    expect(doc.palette[0].label).toBe('Marineblau');
  });

  it('validation builds a fresh copy and never keeps the input object', () => {
    const doc = fresh();
    const out = C.validateDocument(doc, T);
    expect(out).not.toBe(doc);
    expect(out.surfaces[0].layers[0]).not.toBe(doc.surfaces[0].layers[0]);
  });

  it('refuses text over the size limit before parsing it, and text that is not JSON', () => {
    expect(codes(() => C.parseDocument('x'.repeat(C.LIMITS.bytes + 1), T))).toEqual(['too-large']);
    expect(codes(() => C.parseDocument('{nope', T))).toEqual(['not-json']);
  });

  it('refuses a wrong format, version or template, and a surface list that is not the template’s', () => {
    const doc = fresh();
    expect(codes(() => C.validateDocument({ ...doc, format: 'familista.studio.document' }, T))).toContain('bad-format');
    expect(codes(() => C.validateDocument({ ...doc, version: 2 }, T))).toContain('bad-version');
    expect(codes(() => C.validateDocument({ ...doc, template: { key: 'other', version: 1 } }, T))).toContain('unknown-template');
    expect(codes(() => C.validateDocument({ ...doc, surfaces: doc.surfaces.slice(1) }, T))).toContain('bad-surfaces');
  });

  it('refuses an unknown field, a missing field and a __proto__ key, and pollutes nothing', () => {
    const doc = fresh();
    doc.surfaces[0].layers[1].onclick = 'x';
    expect(codes(() => C.validateDocument(doc, T))).toContain('unknown-field');
    const d2 = fresh();
    delete d2.surfaces[0].layers[1].font;
    expect(codes(() => C.validateDocument(d2, T))).toContain('missing-field');
    const text = C.serializeDocument(fresh()).replace('"name": "Home kit"', '"__proto__": { "polluted": 1 }, "name": "Home kit"');
    expect(codes(() => C.parseDocument(text, T))).toContain('unknown-field');
    expect(({} as any).polluted).toBeUndefined();
  });

  it('refuses malformed and repeated ids, including an id a palette colour already uses', () => {
    const d1 = fresh(); d1.surfaces[0].layers[1].id = 'Bad Id';
    expect(codes(() => C.validateDocument(d1, T))).toContain('bad-id');
    const d2 = fresh(); d2.surfaces[1].layers[1].id = 'l2';
    expect(codes(() => C.validateDocument(d2, T))).toContain('duplicate-id');
    const d3 = fresh(); d3.surfaces[1].layers[1].id = 'c1';
    expect(codes(() => C.validateDocument(d3, T))).toContain('duplicate-id');
  });

  it('a number is millimetres to a tenth, inside its limits; a rotation is whole degrees in (-180, 180]', () => {
    const ok = fresh(); ok.surfaces[0].layers[1].x = 166.4;
    expect(codes(() => C.validateDocument(ok, T))).toEqual([]);
    for (const [k, v] of [['x', 166.45], ['x', 0.1 + 0.2], ['x', 5000], ['w', 1], ['w', 'wide'], ['r', 12.5], ['r', -180], ['r', 181], ['h', NaN]] as const) {
      const d = fresh(); d.surfaces[0].layers[1][k] = v;
      expect([k, v, codes(() => C.validateDocument(d, T))]).toEqual([k, v, ['bad-number']]);
    }
  });

  it('colours: a palette colour is #rrggbb; every colour reference names a palette colour; a trim names one too', () => {
    const d1 = fresh(); d1.palette[0].srgb = 'red';
    expect(codes(() => C.validateDocument(d1, T))).toContain('bad-colour');
    const d2 = fresh(); d2.palette[0].srgb = '#0B1F5B';
    expect(codes(() => C.validateDocument(d2, T))).toContain('bad-colour');
    const d3 = fresh(); d3.surfaces[0].layers[1].color = 'c99';
    expect(codes(() => C.validateDocument(d3, T))).toContain('bad-color-ref');
    const d4 = fresh(); d4.parts.collar = 'c99';
    expect(codes(() => C.validateDocument(d4, T))).toContain('bad-color-ref');
    const d5 = fresh(); d5.surfaces[0].base = 'var(--x)';
    expect(codes(() => C.validateDocument(d5, T))).toContain('bad-color-ref');
  });

  it('closed lists: a pattern, shape, font or roster field that is not on its list is refused', () => {
    const cases: Array<[number, number, string, unknown, string]> = [
      [0, 0, 'pattern', 'tartan', 'bad-pattern'], [0, 2, 'shape', 'skull', 'bad-shape'], [0, 1, 'font', 'Comic Sans', 'bad-font'], [1, 1, 'field', 'dateOfBirth', 'bad-field'],
    ];
    for (const [s, l, k, v, code] of cases) {
      const d = fresh(); d.surfaces[s].layers[l][k] = v;
      expect(codes(() => C.validateDocument(d, T))).toContain(code);
    }
  });

  it('a roster layer is a placeholder: it cannot carry a name, a number or any person’s text', () => {
    const d = fresh();
    d.surfaces[1].layers[1].text = 'MÜLLER';
    expect(codes(() => C.validateDocument(d, T))).toContain('unknown-field');
    const d2 = fresh();
    expect(codes(() => C.applyOp(d2, { op: 'set', target: { kind: 'layer', id: 'l6' }, key: 'text', value: 'MÜLLER' }))).toEqual(['not-settable']);
    expect(codes(() => C.applyOp(d2, { op: 'set', target: { kind: 'layer', id: 'l6' }, key: 'field', value: 'number' }))).toEqual(['not-settable']);
    expect(C.KEYS.roster).not.toContain('text');
  });

  it('text: 1 to 60 characters, no control characters; Arabic and other scripts are text like any other', () => {
    const d = fresh();
    expect(codes(() => C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'l4' }, key: 'text', value: 'فاميليستا' }))).toEqual([]);
    for (const bad of ['', '   ', 'x'.repeat(61), 'a\u0000b', 'a\nb']) {
      expect(codes(() => C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'l4' }, key: 'text', value: bad }))).toEqual(['bad-text']);
    }
  });

  it('limits: at most 60 layers on a surface and 24 palette colours', () => {
    const d = fresh();
    for (let i = d.surfaces[2].layers.length; i < C.LIMITS.layers; i++) C.applyOp(d, { op: 'insert', surface: 'sleeve-right', index: i, layer: box('x' + i, 200, 150) });
    expect(codes(() => C.applyOp(d, { op: 'insert', surface: 'sleeve-right', index: 0, layer: box('x-over', 200, 150) }))).toEqual(['too-many-layers']);
    for (let i = d.palette.length; i < C.LIMITS.palette; i++) C.applyOp(d, { op: 'paletteInsert', index: i, swatch: { id: 'k' + i, label: 'K', srgb: '#123456' } });
    expect(codes(() => C.applyOp(d, { op: 'paletteInsert', index: 0, swatch: { id: 'k-over', label: 'K', srgb: '#123456' } }))).toEqual(['too-many-colours']);
  });
});

describe('operations, undo and the history', () => {
  it('every operation returns the operation that undoes it exactly', () => {
    const ops = [
      { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'x', value: 300 },
      { op: 'set', target: { kind: 'doc' }, key: 'name', value: 'Away kit' },
      { op: 'set', target: { kind: 'surface', id: 'back' }, key: 'base', value: 'c2' },
      { op: 'set', target: { kind: 'swatch', id: 'c3' }, key: 'srgb', value: '#c0ffee' },
      { op: 'set', target: { kind: 'part', id: 'collar' }, key: 'color', value: 'c4' },
      { op: 'insert', surface: 'front', index: 2, layer: box('n1', 270, 400) },
      { op: 'remove', id: 'l2' },
      { op: 'move', id: 'l4', index: 0 },
      { op: 'paletteInsert', index: 1, swatch: { id: 'c9', label: 'Teal', srgb: '#14b8a6' } },
      { op: 'batch', ops: [{ op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'w', value: 80 }, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'r', value: 15 }] },
    ];
    for (const op of ops) {
      const d = fresh(), before = C.serializeDocument(d);
      const inv = C.applyOp(d, op);
      expect(C.serializeDocument(d)).not.toBe(before);
      C.applyOp(d, inv);
      expect([op.op, C.serializeDocument(d)]).toEqual([op.op, before]);
    }
  });

  it('a refused operation throws its own code and changes nothing; a batch is all or nothing', () => {
    const d = fresh(), before = C.serializeDocument(d);
    expect(codes(() => C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'nope' }, key: 'x', value: 1 }))).toEqual(['not-found']);
    expect(codes(() => C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'type', value: 'text' }))).toEqual(['not-settable']);
    expect(codes(() => C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'id', value: 'z' }))).toEqual(['not-settable']);
    expect(codes(() => C.applyOp(d, { op: 'paletteRemove', id: 'c1' }))).toEqual(['colour-in-use']);
    expect(codes(() => C.applyOp(d, { op: 'batch', ops: [{ op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'x', value: 10 }, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'x', value: 'bad' }] }))).toEqual(['bad-number']);
    expect(C.serializeDocument(d)).toBe(before);
  });

  it('a long random sequence of real operations undoes to the starting bytes and redoes to the same end bytes (deterministic seed)', () => {
    let seed = 20261110;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const d = fresh(), h = C.createHistory(1000), start = C.serializeDocument(d);
    let n = 0;
    for (let i = 0; i < 400; i++) {
      const s = d.surfaces[Math.floor(rnd() * d.surfaces.length)];
      const boxes = s.layers.filter((l: any) => C.BOX_TYPES.includes(l.type));
      const pick = rnd();
      let op: any;
      if (pick < 0.35 && boxes.length) { const l = boxes[Math.floor(rnd() * boxes.length)]; op = { op: 'set', target: { kind: 'layer', id: l.id }, key: rnd() < 0.5 ? 'x' : 'y', value: C.mm(rnd() * 400) }; }
      else if (pick < 0.5 && boxes.length) { const l = boxes[Math.floor(rnd() * boxes.length)]; op = { op: 'set', target: { kind: 'layer', id: l.id }, key: 'r', value: C.normAngle(Math.floor(rnd() * 720) - 360) }; }
      else if (pick < 0.65 && s.layers.length < 20) { op = { op: 'insert', surface: s.id, index: Math.floor(rnd() * (s.layers.length + 1)), layer: box(C.nextId(d, 'l'), C.mm(rnd() * 300), C.mm(rnd() * 300)) }; }
      else if (pick < 0.75 && s.layers.length > 1) { op = { op: 'remove', id: s.layers[Math.floor(rnd() * s.layers.length)].id }; }
      else if (pick < 0.85 && s.layers.length > 1) { op = { op: 'move', id: s.layers[0].id, index: s.layers.length - 1 }; }
      else op = { op: 'set', target: { kind: 'surface', id: s.id }, key: 'base', value: d.palette[Math.floor(rnd() * d.palette.length)].id };
      C.commit(d, h, op, 'r');
      n++;
    }
    const end = C.serializeDocument(d);
    expect(n).toBe(400);
    while (C.undo(d, h)) { /* back to the start */ }
    expect(C.serializeDocument(d)).toBe(start);
    while (C.redo(d, h)) { /* forward to the end */ }
    expect(C.serializeDocument(d)).toBe(end);
    expect(C.validateDocument(d, T)).toBeTruthy();
  });

  it('keeps 200 undo steps by default, drops the oldest, and a new change clears the redo stack', () => {
    const d = fresh(), h = C.createHistory();
    for (let i = 0; i < 205; i++) C.commit(d, h, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'x', value: 100 + i }, 'move');
    expect(h.past.length).toBe(200);
    C.undo(d, h);
    expect(h.future.length).toBe(1);
    C.commit(d, h, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'y', value: 210 }, 'move');
    expect(h.future.length).toBe(0);
  });

  it('a drag applied a little at a time is recorded as one step that undoes to where it began', () => {
    const d = fresh(), h = C.createHistory(), before = C.serializeDocument(d);
    for (const x of [380, 390, 400]) C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'x', value: x });
    C.record(h, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'x', value: 400 }, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'x', value: 376 }, 'move');
    expect(h.past.length).toBe(1);
    C.undo(d, h);
    expect(C.serializeDocument(d)).toBe(before);
    C.redo(d, h);
    expect(layer(d, 'l3').x).toBe(400);
  });

  it('a colour cannot be removed while it is used, nor the last colour; an unused one can, and comes back on undo', () => {
    const d = fresh(), h = C.createHistory();
    C.commit(d, h, { op: 'paletteInsert', index: 4, swatch: { id: 'c5', label: 'Spare', srgb: '#888888' } }, 'add');
    expect(C.swatchInUse(d, 'c5')).toBe(false);
    C.commit(d, h, { op: 'paletteRemove', id: 'c5' }, 'remove');
    expect(C.findSwatch(d, 'c5')).toBeNull();
    C.undo(d, h);
    expect(C.findSwatch(d, 'c5').swatch.srgb).toBe('#888888');
    const one = fresh();
    one.palette = [one.palette[0]];
    one.parts = { collar: 'c1', cuffs: 'c1' };
    one.surfaces.forEach((s: any) => { s.base = 'c1'; s.layers = []; });
    expect(codes(() => C.applyOp(one, { op: 'paletteRemove', id: 'c1' }))).toEqual(['last-colour']);
  });

  it('ids: the next free number, never one a colour or layer already has', () => {
    const d = fresh();
    expect(C.nextId(d, 'l')).toBe('l10');
    expect(C.nextId(d, 'c')).toBe('c5');
    expect(C.nextId(d, 'l', { l10: 1 })).toBe('l11');
  });
});

describe('geometry, in millimetres', () => {
  const front = T.surfaces[0];
  const print = C.flatten(front.outline);

  it('flattening is deterministic: twelve points per curve, the same every time', () => {
    const a = C.flatten(front.outline), b = C.flatten(front.outline);
    expect(a).toEqual(b);
    const curves = front.outline.filter((p: number[]) => p.length === 4).length, lines = front.outline.length - 1 - curves;
    expect(a.length).toBe(1 + lines + curves * 12);
    expect(C.outlinePath(front.outline)).toMatch(/^M185 12 L48 44 Q64 200 14 258 /);
    expect(C.outlinePath(front.outline)).not.toMatch(/[<>"'&]/);
  });

  it('a box inside the printable area is inside; one straddling the V-neck notch is caught even with every corner inside (negative control)', () => {
    expect(C.boxInPolygon({ x: 270, y: 400, w: 200, h: 100, r: 0 }, print)).toBe(true);
    const straddle = { x: 270, y: 60, w: 140, h: 6, r: 0 };
    expect(C.boxCorners(straddle).every((p: number[]) => C.pointInPolygon(p, print))).toBe(true);
    expect(C.boxInPolygon(straddle, print)).toBe(false);
    expect(C.boxInPolygon({ x: 270, y: 760, w: 100, h: 60, r: 0 }, print)).toBe(false);
  });

  it('a rotated box is checked by its rotated corners', () => {
    const tall = { x: 40, y: 400, w: 20, h: 120, r: 0 };
    expect(C.boxInPolygon(tall, print)).toBe(true);
    expect(C.boxInPolygon({ ...tall, r: 90 }, print)).toBe(false);
  });

  it('hit testing finds the topmost visible, unlocked box, and never a pattern, a hidden or a locked layer', () => {
    const d = fresh(), s = d.surfaces[0];
    expect(C.hitTest(s, { x: 376, y: 200 })).toBe('l3');
    expect(C.hitTest(s, { x: 270, y: 600 })).toBeNull();
    C.applyOp(d, { op: 'insert', surface: 'front', index: s.layers.length, layer: box('top', 376, 200, 30, 30) });
    expect(C.hitTest(s, { x: 376, y: 200 })).toBe('top');
    C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'top' }, key: 'visible', value: false });
    expect(C.hitTest(s, { x: 376, y: 200 })).toBe('l3');
    C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'locked', value: true });
    expect(C.hitTest(s, { x: 376, y: 200 })).toBeNull();
  });

  it('resizing from a handle keeps the opposite edge where it was, whatever the rotation; a corner keeps the proportions unless free', () => {
    for (const r of [0, 30, -75, 180]) {
      const b = { x: 200, y: 300, w: 80, h: 40, r, w0: 80, h0: 40 };
      const anchor = C.boxCorners(b)[0];
      const out = C.resizeBox(b, 1, 1, { x: C.boxCorners(b)[2][0] + 25, y: C.boxCorners(b)[2][1] + 25 }, false);
      const after = C.boxCorners({ ...b, ...out })[0];
      expect([r, Math.abs(after[0] - anchor[0]) < 0.2, Math.abs(after[1] - anchor[1]) < 0.2]).toEqual([r, true, true]);
      expect(Math.abs(out.w / out.h - 2)).toBeLessThan(0.01);
    }
    const free = C.resizeBox({ x: 0, y: 0, w: 80, h: 40, r: 0 }, 1, 1, { x: 60, y: 60 }, true);
    expect([free.w, free.h]).toEqual([100, 80]);
    const side = C.resizeBox({ x: 0, y: 0, w: 80, h: 40, r: 0 }, 1, 0, { x: 100, y: 999 }, false);
    expect([side.w, side.h, side.y]).toEqual([140, 40, 0]);
    expect(C.resizeBox({ x: 0, y: 0, w: 80, h: 40, r: 0 }, 1, 1, { x: -500, y: -500 }, true).w).toBe(C.LIMITS.minSize);
  });

  it('scale reads the size a box was placed at; rotation points at the pointer and snaps in 15° steps', () => {
    expect(C.scaleBox({ w0: 64, h0: 76 }, 150)).toEqual({ w: 96, h: 114 });
    expect(C.scaleOf({ w: 96, w0: 64 })).toBe(150);
    const b = { x: 0, y: 0 };
    expect(C.rotateToward(b, { x: 0, y: -10 })).toBe(0);
    expect(C.rotateToward(b, { x: 10, y: 0 })).toBe(90);
    expect(C.rotateToward(b, { x: 0, y: 10 })).toBe(180);
    expect(C.rotateToward(b, { x: -10, y: 0 })).toBe(-90);
    expect(C.rotateToward(b, { x: 10, y: -9 }, 15)).toBe(45);
  });

  it('moving snaps to the surface centre line inside the threshold, and to the grid when one is on', () => {
    expect(C.moveBox({ x: 260, y: 300 }, 7, 0, { centerX: 270, threshold: 4 })).toEqual({ x: 270, y: 300, guides: [{ axis: 'x', at: 270 }] });
    expect(C.moveBox({ x: 260, y: 300 }, 2, 0, { centerX: 270, threshold: 4 })).toEqual({ x: 262, y: 300, guides: [] });
    expect(C.moveBox({ x: 101, y: 203 }, 1.3, 0.6, { grid: 5 })).toEqual({ x: 100, y: 205, guides: [] });
  });

  it('the camera: a view box is shown whole and centred, a surface point stays under the pointer while zooming, and zoom has limits', () => {
    const vb = T.views[0].viewBox;
    const cam = C.fitCamera(vb, 385, 433, 18);
    const shown = C.viewBoxOf(cam, 385, 433);
    expect(shown[0]).toBeLessThanOrEqual(vb[0] + 1e-6);
    expect(shown[1]).toBeLessThanOrEqual(vb[1] + 1e-6);
    const at = { x: 100, y: 120 }, before = C.toWorld(cam, 385, 433, at);
    const z = C.zoomAt(cam, 385, 433, cam.z * 2.5, at), after = C.toWorld(z, 385, 433, at);
    expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeLessThan(1e-9);
    expect(C.clampZoom(1000)).toBe(C.ZOOM.max);
    expect(C.clampZoom(0)).toBe(C.ZOOM.min);
    expect(C.panBy({ cx: 0, cy: 0, z: 2 }, 10, -4)).toEqual({ cx: -5, cy: 2, z: 2 });
  });
});

describe('the design check: the template’s rules and nothing else', () => {
  it('reports a box outside the printable area as a blocker, one across the safe zone as a warning, and short lettering as a warning', () => {
    const d = fresh();
    C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'x', value: 600 });
    C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'l2' }, key: 'x', value: 80 });
    C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'l6' }, key: 'h', value: 6 });
    expect(C.checkDesign(d, T)).toEqual([
      { severity: 'warning', code: 'crosses-safe-zone', surface: 'front', layer: 'l2' },
      { severity: 'blocker', code: 'outside-print-area', surface: 'front', layer: 'l3' },
      { severity: 'warning', code: 'text-too-small', surface: 'back', layer: 'l6' },
    ]);
  });

  it('a hidden layer is not printed and so is not reported', () => {
    const d = fresh();
    C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'x', value: 600 });
    C.applyOp(d, { op: 'set', target: { kind: 'layer', id: 'l3' }, key: 'visible', value: false });
    expect(C.checkDesign(d, T)).toEqual([]);
  });

  it('says nothing about suppliers, prices or manufacturing: no such field exists in the document or the check', () => {
    const code = CORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\b(price|prices|quote|quotation|currency|supplier|checkout|payment)\b|€|\$\d/i);
    const doc = fresh();
    expect(Object.keys(doc).sort()).toEqual(['format', 'name', 'palette', 'parts', 'surfaces', 'template', 'version']);
  });
});

describe('the core is pure', () => {
  it('no DOM, storage, network, clock or randomness', () => {
    const code = CORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // `document.name` and the like are the core's own error paths into the design document, not the DOM.
    for (const re of [/\bdocument\.(createElement|getElement|querySelector|body|head|addEventListener|cookie)/, /\bwindow\b/, /localStorage|sessionStorage/, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/, /\bDate\b|Math\.random|performance\.|setTimeout|setInterval/, /\beval\(|new Function/]) {
      expect([String(re), re.test(code)]).toEqual([String(re), false]);
    }
  });

  it('a file name for an export is the design’s name in safe characters, never a path', () => {
    expect(C.exportFileName('Home kit 2025/26')).toBe('home-kit-2025-26.familista-product-design.json');
    expect(C.exportFileName('../../etc')).toBe('etc.familista-product-design.json');
    expect(C.exportFileName('')).toBe('design.familista-product-design.json');
    expect(C.exportFileName('فاميليستا')).toBe('design.familista-product-design.json');
  });
});

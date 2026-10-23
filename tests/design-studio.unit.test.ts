/**
 * Familista Design Studio — Slice 1a
 *
 * The platform owner's design tool, a product of its own beside Design System Control. What Jest can prove:
 *   - the core (public/design-studio/studio-core.js): the document, its validation, every operation and its undo, the
 *     history, the geometry of a drag, a resize and the camera, with the expected values written out, not recomputed;
 *   - the editor's source is safe by construction: no markup strings, no inline style attribute, no script, no eval,
 *     frames sandboxed with allow-same-origin only, nothing sent anywhere;
 *   - it is wired as a separate owner-only page that asks the server for nothing, with no new route, CSP or renderer change;
 *   - its English, German and Arabic catalogues cover everything it says;
 *   - its stylesheets read only tokens that exist and keep the owner rooms' rules.
 * What it cannot prove (real pointer input, layout, the sandbox, CSP in a browser) is proved by sections 14 and 14a of
 * tools/components/lab-browser-proof.cjs.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(path.join(ROOT, 'public/design-studio/studio-core.js'));

const STUDIO = read('public/design-studio/studio.js');
const CORE = read('public/design-studio/studio-core.js');
const CSS = read('public/design-studio/studio.css');
const FRAME_CSS = read('public/design-studio/studio-frame.css');
const APP = read('public/app.js');
const TOKENS_CSS = read('public/tokens/familista-tokens.css');
const declared = new Set([...TOKENS_CSS.matchAll(/(--fam-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = any;
const frame = (id: string, x = 0, y = 0, children: any[] = []) => ({ id, type: 'frame', name: 'F ' + id, x, y, w: 360, h: 480, fill: 'surface-base', children });
const rect = (id: string, x = 10, y = 10) => ({ id, type: 'rect', name: 'R ' + id, x, y, w: 100, h: 50, fill: 'surface-raised', radius: 'radius-md' });
const text = (id: string, t = 'Hello') => ({ id, type: 'text', name: 'T ' + id, x: 10, y: 100, w: 200, h: 40, text: t, style: 'body', color: 'text-primary' });
const docOf = (frames: any[], name = 'Design'): Doc => ({ format: 'familista.studio.document', version: 1, name, frames });
const codes = (r: any) => (r.ok ? [] : r.errors.map((e: any) => e.code));

describe('the core: the document and what it refuses', () => {
  it('validates a well-formed document into a fresh copy, and serializes it to one canonical text that round-trips byte for byte', () => {
    const input = docOf([frame('frame-1', 0, 0, [rect('rect-1'), text('text-1')])]);
    const r = C.validateDocument(input);
    expect(r.ok).toBe(true);
    expect(r.doc).not.toBe(input);
    expect(r.doc.frames[0]).not.toBe(input.frames[0]);
    const s = C.serializeDocument(r.doc);
    expect(s.endsWith('}\n')).toBe(true);
    const back = C.parseDocument(s);
    expect(back.ok).toBe(true);
    expect(C.serializeDocument(back.doc)).toBe(s);
    expect(JSON.parse(s)).toEqual(input);
  });

  it('refuses text that is not JSON, a file over 1 MB counted in UTF-8 bytes, and anything that is not an object', () => {
    expect(codes(C.parseDocument('{"format":'))).toEqual(['not-json']);
    expect(codes(C.parseDocument(' '.repeat(C.LIMITS.bytes + 1)))).toEqual(['too-large']);
    // 600,000 characters of a two-byte letter: under the limit in characters, over it in bytes.
    expect(codes(C.parseDocument('"' + 'é'.repeat(600000) + '"'))).toEqual(['too-large']);
    expect(codes(C.parseDocument('[]'))).toEqual(['not-object']);
    expect(codes(C.parseDocument('null'))).toEqual(['not-object']);
    expect(codes(C.parseDocument(42 as any))).toEqual(['not-json']);
  });

  it('refuses a __proto__ key as an unknown field, and parsing it pollutes nothing', () => {
    const text = '{"__proto__":{"stPolluted":true},' + JSON.stringify(docOf([])).slice(1);
    const r = C.parseDocument(text);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toEqual({ code: 'unknown-field', path: '$.__proto__' });
    expect(({} as any).stPolluted).toBeUndefined();
    const nested = docOf([{ ...frame('frame-1'), constructor: 'x' }]);
    expect(codes(C.validateDocument(nested))).toEqual(['unknown-field']);
  });

  it('refuses a wrong format or version, an unknown or missing field, and names the path of each problem safely', () => {
    expect(codes(C.validateDocument({ ...docOf([]), format: 'figma' }))).toEqual(['format']);
    expect(codes(C.validateDocument({ ...docOf([]), version: 2 }))).toEqual(['version']);
    const extra = C.validateDocument({ ...docOf([]), '<b>x</b>': 1 });
    expect(extra.errors[0]).toEqual({ code: 'unknown-field', path: '$.?b?x??b?' });
    const missing = docOf([frame('frame-1')]);
    delete missing.frames[0].fill;
    expect(C.validateDocument(missing).errors).toEqual([{ code: 'missing-field', path: '$.frames[0].fill' }, { code: 'bad-token', path: '$.frames[0].fill' }]);
  });

  it('refuses malformed and repeated ids, and an element of the wrong type in the wrong place', () => {
    for (const id of ['Frame-1', '1frame', 'frame_1', 'a'.repeat(65), 'x<y', '', 7]) expect(codes(C.validateDocument(docOf([{ ...frame('frame-1'), id }])))).toEqual(['bad-id']);
    expect(codes(C.validateDocument(docOf([frame('a'), frame('a')])))).toEqual(['duplicate-id']);
    expect(codes(C.validateDocument(docOf([frame('a', 0, 0, [rect('a')])])))).toEqual(['duplicate-id']);
    expect(codes(C.validateDocument(docOf([rect('r') as any])))).toEqual(['bad-type']);
    expect(codes(C.validateDocument(docOf([frame('f', 0, 0, [frame('g')])])))).toEqual(['bad-type']);
    expect(codes(C.validateDocument(docOf([frame('f', 0, 0, [{ ...rect('r'), type: 'script' }])])))).toEqual(['bad-type']);
    expect(codes(C.validateDocument(docOf([{ ...frame('f'), children: {} }])))).toEqual(['bad-children']);
  });

  it('refuses names that are empty, too long or carry control characters; text keeps tabs and line breaks but nothing else below a space', () => {
    for (const name of ['', 'x'.repeat(121), 'a\u0007b', 'line\nbreak', 3]) expect(codes(C.validateDocument(docOf([{ ...frame('f'), name }])))).toEqual(['bad-name']);
    expect(C.validateDocument(docOf([{ ...frame('f'), name: 'x'.repeat(120) }])).ok).toBe(true);
    expect(C.validateDocument(docOf([frame('f', 0, 0, [text('t', 'tab\tand\nline')])])).ok).toBe(true);
    for (const t of ['nul\u0000', 'bell\u0007', 'x'.repeat(5001), 5]) expect(codes(C.validateDocument(docOf([frame('f', 0, 0, [text('t', t as any)])])))).toEqual(['bad-text']);
    // Markup is text: it validates, and the renderer writes it with textContent (proved in the browser, section 14).
    expect(C.validateDocument(docOf([frame('f', 0, 0, [text('t', '<img src=x onerror=alert(1)>')])])).ok).toBe(true);
  });

  it('refuses every number that is not a whole number inside the limits', () => {
    const bad = [{ x: 1.5 }, { y: -100001 }, { x: Infinity }, { w: 0 }, { h: -3 }, { w: 20001 }, { h: 2.5 }, { x: '10' }];
    for (const b of bad) {
      const r = C.validateDocument(docOf([{ ...frame('f'), ...b }]));
      expect(r.ok).toBe(false);
      expect(['bad-number', 'bad-size']).toContain(r.errors[0].code);
    }
    expect(codes(C.parseDocument(JSON.stringify(docOf([frame('f')])).replace('"x":0', '"x":1e999')))).toEqual(['bad-number']);
    expect(C.validateDocument(docOf([{ ...frame('f'), x: -100000, y: 100000, w: 20000, h: 1 }])).ok).toBe(true);
  });

  it('refuses any colour, radius or text style that is not a name on its closed token list, so no CSS string can enter a document', () => {
    const fills = ['red', '#fff', 'rgb(0,0,0)', 'var(--fam-surface-raised)', 'surface-raised; background-image: url(https://evil.test/x)', 'url(https://evil.test)', 'text-primary', ''];
    for (const fill of fills) expect(codes(C.validateDocument(docOf([{ ...frame('f'), fill }])))).toEqual(['bad-token']);
    expect(codes(C.validateDocument(docOf([frame('f', 0, 0, [{ ...rect('r'), radius: '8px' }])])))).toEqual(['bad-token']);
    expect(C.validateDocument(docOf([frame('f', 0, 0, [{ ...rect('r'), radius: null }])])).ok).toBe(true);
    expect(codes(C.validateDocument(docOf([frame('f', 0, 0, [{ ...text('t'), style: 'comic' }])])))).toEqual(['bad-token']);
    expect(codes(C.validateDocument(docOf([frame('f', 0, 0, [{ ...text('t'), color: 'surface-base' }])])))).toEqual(['bad-token']);
  });

  it('refuses more than 50 frames or 2,000 elements', () => {
    expect(codes(C.validateDocument(docOf(Array.from({ length: 51 }, (_, i) => frame('f' + i)))))).toContain('too-many-frames');
    const crowded = Array.from({ length: 2 }, (_, i) => frame('f' + i, 0, 0, Array.from({ length: 1000 }, (_x, j) => rect(`r${i}-${j}`))));
    expect(codes(C.validateDocument(docOf(crowded)))).toEqual(['too-many-nodes']);
    const full = [frame('f0', 0, 0, Array.from({ length: 1998 }, (_x, j) => rect('r' + j)))];
    expect(C.validateDocument(docOf(full)).ok).toBe(true);   // 1 frame + 1998 = 1999
  });

  it('every token on the core\'s lists, and every type token a text style uses, is declared by the published token stylesheet', () => {
    const names = [...C.TOKENS.fill, ...C.TOKENS.radius, ...C.TOKENS.color];
    for (const s of Object.values(C.TEXT_STYLES) as any[]) names.push(s.size, s.weight, s.lineHeight);
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter((n) => !declared.has('--fam-' + n))).toEqual([]);
    expect(Object.isFrozen(C.TOKENS) && Object.isFrozen(C.TOKENS.fill) && Object.isFrozen(C.LIMITS)).toBe(true);
  });
});

describe('the core: operations, undo and the history', () => {
  const fresh = () => {
    const d = C.createDocument('Test');
    const h = C.createHistory();
    return { d, h };
  };

  it('every operation returns the operation that undoes it exactly', () => {
    const { d } = fresh();
    const s0 = C.serializeDocument(d);
    const f = C.makeNode(d, 'frame', { x: 0, y: 0 }, 'Frame 1');
    const inv1 = C.applyOp(d, C.insertOp(d, null, f)).inverse;
    expect(inv1).toEqual({ kind: 'remove', id: 'frame-1' });
    const s1 = C.serializeDocument(d);
    const inv2 = C.applyOp(d, C.insertOp(d, 'frame-1', C.makeNode(d, 'rect', { x: 5, y: 5 }, 'Rectangle 1'))).inverse;
    const s2 = C.serializeDocument(d);
    const inv3 = C.applyOp(d, { kind: 'set', id: 'rect-1', props: { x: 40, fill: 'brand-accent', radius: null } }).inverse;
    expect(inv3).toEqual({ kind: 'set', id: 'rect-1', props: { x: 5, fill: 'surface-raised', radius: 'radius-md' } });
    const s3 = C.serializeDocument(d);
    const inv4 = C.applyOp(d, { kind: 'meta', props: { name: 'Renamed' } }).inverse;
    const inv5 = C.applyOp(d, { kind: 'remove', id: 'frame-1' }).inverse;
    expect(inv5.kind).toBe('insert');
    expect(inv5.node.children).toHaveLength(1);
    const replaceInv = C.applyOp(d, { kind: 'replace', doc: docOf([frame('frame-9')], 'Other') }).inverse;
    C.applyOp(d, replaceInv);
    C.applyOp(d, inv5); C.applyOp(d, inv4);
    expect(C.serializeDocument(d)).toBe(s3);
    C.applyOp(d, inv3); expect(C.serializeDocument(d)).toBe(s2);
    C.applyOp(d, inv2); expect(C.serializeDocument(d)).toBe(s1);
    C.applyOp(d, inv1); expect(C.serializeDocument(d)).toBe(s0);
  });

  it('an invalid operation throws its own code and changes nothing', () => {
    const { d } = fresh();
    C.applyOp(d, C.insertOp(d, null, C.makeNode(d, 'frame', { x: 0, y: 0 }, 'Frame 1')));
    C.applyOp(d, C.insertOp(d, 'frame-1', C.makeNode(d, 'rect', { x: 0, y: 0 }, 'Rectangle 1')));
    const s = C.serializeDocument(d);
    const bad: [any, string][] = [
      [{ kind: 'set', id: 'rect-1', props: { fill: 'red' } }, 'bad-token'],
      [{ kind: 'set', id: 'rect-1', props: { x: 1, w: 0 } }, 'bad-size'],
      [{ kind: 'set', id: 'rect-1', props: { id: 'other' } }, 'unknown-field'],
      [{ kind: 'set', id: 'rect-1', props: { type: 'frame' } }, 'unknown-field'],
      [{ kind: 'set', id: 'frame-1', props: { children: [] } }, 'unknown-field'],
      [{ kind: 'set', id: 'frame-1', props: { text: 'x' } }, 'unknown-field'],
      [{ kind: 'set', id: 'missing', props: { x: 1 } }, 'not-found'],
      [{ kind: 'set', id: 'rect-1', props: {} }, 'bad-op'],
      [{ kind: 'remove', id: 'missing' }, 'not-found'],
      [{ kind: 'insert', parent: null, index: 0, node: rect('rect-9') }, 'bad-type'],
      [{ kind: 'insert', parent: 'frame-1', index: 0, node: rect('rect-1') }, 'duplicate-id'],
      [{ kind: 'insert', parent: 'frame-1', index: 5, node: rect('rect-9') }, 'bad-index'],
      [{ kind: 'insert', parent: 'rect-1', index: 0, node: rect('rect-9') }, 'bad-parent'],
      [{ kind: 'meta', props: { name: '' } }, 'bad-name'],
      [{ kind: 'meta', props: { name: 'x', extra: 1 } }, 'bad-op'],
      [{ kind: 'replace', doc: { format: 'x' } }, 'missing-field'],
      [{ kind: 'eval' }, 'bad-op'],
      [null, 'bad-op'],
    ];
    for (const [op, code] of bad) {
      let got = '';
      try { C.applyOp(d, op); } catch (e: any) { got = e.code; }
      expect(`${JSON.stringify(op)} → ${got}`).toBe(`${JSON.stringify(op)} → ${code}`);
      expect(C.serializeDocument(d)).toBe(s);
    }
  });

  it('a long random sequence of real operations undoes to the empty design and redoes to the same bytes (deterministic seed)', () => {
    // mulberry32: a small, well-distributed 32-bit generator, so the sequence is the same on every run.
    let seed = 1234567;
    const next = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const rnd = (n: number) => Math.floor(next() * n);
    const { d, h } = fresh();
    h.limit = 10000;
    const s0 = C.serializeDocument(d);
    let done = 0;
    for (let i = 0; i < 600; i++) {
      const ids = C.orderedIds(d);
      const pick = ids.length ? ids[rnd(ids.length)] : null;
      const l = pick ? C.locate(d, pick) : null;
      const kind = rnd(8);
      let op: any = null;
      if ((kind === 0 && d.frames.length < 40) || !d.frames.length) op = C.insertOp(d, null, C.makeNode(d, 'frame', { x: rnd(2000) - 1000, y: rnd(2000) }, 'Frame'));
      else if (kind === 1 || kind === 2) {
        const f = d.frames[rnd(d.frames.length)];
        const type = kind === 1 ? 'rect' : 'text';
        op = C.insertOp(d, f.id, C.makeNode(d, type, { x: rnd(300), y: rnd(400) }, 'Node', { text: 'T' + i }));
      } else if (kind === 3 && l) op = { kind: 'set', id: pick, props: C.moveBy(l.node, rnd(41) - 20, rnd(41) - 20) };
      else if (kind === 4 && l) op = { kind: 'set', id: pick, props: C.resize(l.node, C.HANDLES[rnd(8)], rnd(61) - 30, rnd(61) - 30, { keepRatio: !!rnd(2), fromCenter: !!rnd(2) }) };
      else if (kind === 5 && l && l.node.type !== 'text') op = { kind: 'set', id: pick, props: { fill: C.TOKENS.fill[rnd(C.TOKENS.fill.length)] } };
      else if (kind === 6 && l && (l.frame || d.frames.length < 40)) op = C.duplicateOp(d, pick);
      else if (kind === 7 && l && rnd(3) === 0) op = { kind: 'remove', id: pick };
      if (!op) continue;
      C.commit(d, h, op, 'op ' + i);
      done++;
      expect(C.validateDocument(JSON.parse(C.serializeDocument(d))).ok).toBe(true);
    }
    expect(done).toBeGreaterThan(400);
    const sN = C.serializeDocument(d);
    while (C.undo(d, h));
    expect(C.serializeDocument(d)).toBe(s0);
    while (C.redo(d, h));
    expect(C.serializeDocument(d)).toBe(sN);
  });

  it('keeps 200 undo steps, drops the oldest, and a new change clears the redo stack', () => {
    const { d, h } = fresh();
    C.commit(d, h, C.insertOp(d, null, C.makeNode(d, 'frame', { x: 0, y: 0 }, 'Frame 1')), 'add');
    for (let i = 1; i <= 249; i++) C.commit(d, h, { kind: 'set', id: 'frame-1', props: { x: i } }, 'move');
    expect(h.past).toHaveLength(200);
    let n = 0;
    while (C.undo(d, h)) n++;
    expect(n).toBe(200);
    expect(d.frames[0].x).toBe(49);
    C.redo(d, h);
    expect(h.future).toHaveLength(199);
    C.commit(d, h, { kind: 'set', id: 'frame-1', props: { y: 5 } }, 'move');
    expect(h.future).toHaveLength(0);
    expect(C.redo(d, h)).toBeNull();
  });

  it('names and ids: the next free number, and a duplicate gets new ids throughout, beside the original', () => {
    const d = C.validateDocument(docOf([frame('frame-1', 0, 0, [rect('rect-1'), text('text-4')]), frame('frame-3', 500, 0)])).doc;
    expect(C.nextId(d, 'frame')).toBe('frame-4');
    expect(C.nextId(d, 'text')).toBe('text-5');
    d.frames[0].name = 'Frame 7';
    expect(C.nextName(d, 'frame', 'Frame')).toBe('Frame 8');
    expect(C.nextName(d, 'rect', 'Rechteck')).toBe('Rechteck 1');
    expect(C.nextName(d, 'rect', 'a.b*')).toBe('a.b* 1');
    const dup = C.duplicateOp(d, 'frame-1');
    expect(dup.node.id).toBe('frame-4');
    expect(dup.node.children.map((c: any) => c.id)).toEqual(['rect-2', 'text-5']);
    expect([dup.node.x, dup.index, dup.parent]).toEqual([400, 1, null]);
    const dupRect = C.duplicateOp(d, 'rect-1');
    expect([dupRect.node.id, dupRect.node.x, dupRect.node.y, dupRect.parent, dupRect.index]).toEqual(['rect-2', 20, 20, 'frame-1', 1]);
  });
});

describe('the core: geometry', () => {
  it('a screen drag is the canvas distance at the zoom, in whole pixels, never -0', () => {
    expect(C.worldDelta(100, 50, 0.5)).toEqual({ dx: 200, dy: 100 });
    expect(C.worldDelta(100, 50, 1)).toEqual({ dx: 100, dy: 50 });
    expect(C.worldDelta(100, 50, 2)).toEqual({ dx: 50, dy: 25 });
    expect(C.worldDelta(1, 1, 4)).toEqual({ dx: 0, dy: 0 });
    expect(Object.is(C.worldDelta(-1, -1, 4).dx, -0)).toBe(false);
  });

  it('the camera: screen and canvas points convert both ways, zoom keeps the point under the pointer, and stays between 10% and 400%', () => {
    const cam = { x: 120, y: -40, z: 1.5 };
    expect(C.toWorld(cam, C.toScreen(cam, { x: 33, y: -7 }))).toEqual({ x: 33, y: -7 });
    const at = { x: 400, y: 300 };
    const before = C.toWorld(cam, at);
    const z2 = C.zoomAt(cam, 3, at);
    expect(z2.z).toBe(3);
    const after = C.toWorld(z2, at);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(C.clampZoom(0.01)).toBe(0.1);
    expect(C.clampZoom(99)).toBe(4);
    expect(C.clampZoom(NaN)).toBe(1);
    expect([C.zoomStep(1, 1), C.zoomStep(1, -1), C.zoomStep(4, 1), C.zoomStep(0.1, -1), C.zoomStep(0.6, 1)]).toEqual([1.25, 0.75, 4, 0.1, 0.67]);
  });

  it('each of the eight handles moves only its own edges; Shift keeps the ratio, Alt resizes from the centre, never below 1 px or above 20,000', () => {
    const g = { x: 80, y: 190, w: 200, h: 100 };
    const want: Record<string, object> = {
      nw: { x: 100, y: 200, w: 180, h: 90 }, n: { x: 80, y: 200, w: 200, h: 90 }, ne: { x: 80, y: 200, w: 220, h: 90 }, e: { x: 80, y: 190, w: 220, h: 100 },
      se: { x: 80, y: 190, w: 220, h: 110 }, s: { x: 80, y: 190, w: 200, h: 110 }, sw: { x: 100, y: 190, w: 180, h: 110 }, w: { x: 100, y: 190, w: 180, h: 100 },
    };
    for (const hd of C.HANDLES) expect([hd, C.resize(g, hd, 20, 10)]).toEqual([hd, want[hd]]);
    expect(C.resize(g, 'se', 20, 10, { keepRatio: true })).toEqual({ x: 80, y: 190, w: 220, h: 110 });
    expect(C.resize(g, 'e', 20, 0, { fromCenter: true })).toEqual({ x: 60, y: 190, w: 240, h: 100 });
    expect(C.resize(g, 'e', 40, 0, { keepRatio: true })).toEqual({ x: 80, y: 180, w: 240, h: 120 });
    expect(C.resize(g, 'e', -500, 0)).toEqual({ x: 80, y: 190, w: 1, h: 100 });
    expect(C.resize(g, 'w', 500, 0)).toEqual({ x: 279, y: 190, w: 1, h: 100 });
    expect(C.resize(g, 'se', 30000, 30000).w).toBe(20000);
    expect(() => C.resize(g, 'middle', 1, 1)).toThrow('bad-handle');
  });

  it('hit testing finds the topmost element, else the frame, never what a frame clips, and nothing outside every frame', () => {
    const d = C.validateDocument(docOf([frame('f1', 0, 0, [rect('r1', 10, 10), { ...rect('r2', 50, 30) }, { ...rect('r3', 340, 10) }]), frame('f2', 1000, 0)])).doc;
    expect(C.hitTest(d, { x: 60, y: 40 })).toEqual({ frame: 'f1', id: 'r2' });
    expect(C.hitTest(d, { x: 20, y: 20 })).toEqual({ frame: 'f1', id: 'r1' });
    expect(C.hitTest(d, { x: 300, y: 400 })).toEqual({ frame: 'f1', id: 'f1' });
    expect(C.hitTest(d, { x: 380, y: 20 })).toBeNull();          // r3 sticks out past the frame's right edge: clipped
    expect(C.hitTest(d, { x: 1010, y: 10 })).toEqual({ frame: 'f2', id: 'f2' });
    expect(C.hitTest(d, { x: -5, y: 5 })).toBeNull();
    expect(C.worldRect(d, 'r2')).toEqual({ x: 50, y: 30, w: 100, h: 50 });
  });

  it('fit shows every frame whole, centred, never above 100%; a rubber band is normalised; an export file name is safe', () => {
    const d = C.validateDocument(docOf([frame('a', 0, 0), frame('b', 1000, 200)])).doc;
    expect(C.bounds(d)).toEqual({ x: 0, y: 0, w: 1360, h: 680 });
    const cam = C.fitCamera(C.bounds(d), 1000, 800, 48);
    expect(cam.z).toBeCloseTo(904 / 1360, 3);
    expect(C.fitCamera({ x: 0, y: 0, w: 100, h: 100 }, 1000, 800, 48).z).toBe(1);
    expect(C.fitCamera(null, 1000, 800, 48)).toEqual({ x: 48, y: 48, z: 1 });
    // Each corner is rounded to a whole pixel: 20.6 → 21 and 10.4 → 10.
    expect(C.band({ x: 10.4, y: 50 }, { x: -20, y: 20.6 })).toEqual({ x: -20, y: 21, w: 30, h: 29 });
    expect(C.band({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, w: 1, h: 1 });
    expect(C.exportFileName('Squad / <Overview> 2026')).toBe('squad-overview-2026.familista-design.json');
    expect(C.exportFileName('تصميم')).toBe('design.familista-design.json');
  });

  it('the core is pure: no DOM, storage, network, clock or randomness', () => {
    const code = CORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bdocument\.|\bwindow\.|localStorage|sessionStorage|\bfetch\(|XMLHttpRequest|Date\.|Math\.random|setTimeout|requestAnimationFrame/);
  });
});

describe('the editor is safe by construction', () => {
  const code = STUDIO.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('writes no markup: no innerHTML, outerHTML, insertAdjacentHTML, document.write, DOMParser or srcdoc', () => {
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|srcdoc/);
  });

  it('never runs code from a string, and creates no script and no style element', () => {
    expect(code).not.toMatch(/\beval\(|new Function|setTimeout\(\s*['"`]|setInterval\(\s*['"`]/);
    expect(code).not.toMatch(/createElement\(\s*['"`](script|style|object|embed|base|meta)['"`]\s*\)/);
    // The only link elements are the stylesheets each frame loads, created inside the frame's own document; the only iframe is the frame.
    expect(code.match(/createElement\(\s*'link'\s*\)/g)).toEqual(["createElement('link')"]);
    expect(code).toContain("var link = fd.createElement('link');");
    expect(code.match(/h\('iframe'/g)).toEqual(["h('iframe'"]);
    expect(code).toContain("link.rel = 'stylesheet';");
  });

  it('writes styles only through the CSSOM: no style attribute, no cssText, no style key handed to the element builder', () => {
    expect(code).not.toMatch(/setAttribute\(\s*['"`]style['"`]|\.cssText|style:\s*['"`]/);
    expect(code).toMatch(/el\.style\.setProperty\(prop, value\)/);
    const builder = /function h\(tag, attrs, kids\) \{[\s\S]*?\n {2}\}/.exec(code)![0];
    expect(builder).not.toMatch(/style/);
  });

  it('sandboxes every frame with allow-same-origin and nothing else, gives it no src, and keeps it out of the tab order and the pointer\'s way', () => {
    expect((code.match(/sandbox:/g) || []).length).toBe(1);
    expect(code).toContain("sandbox: 'allow-same-origin', title: f.name, 'aria-hidden': 'true', tabindex: '-1'");
    expect(code).not.toMatch(/allow-scripts|allow-top-navigation|allow-popups|allow-forms|\.src\s*=/);
    expect(CSS).toMatch(/\.st-frame-doc \{[^}]*pointer-events: none;/);
  });

  it('builds token references only from the core\'s lists, and writes user text only with textContent or value', () => {
    expect(code).toContain("function tokenVar(list, name) { return list.indexOf(name) !== -1 ? 'var(--fam-' + name + ')' : ''; }");
    const varRefs = [...code.matchAll(/'var\(--fam-' \+ ([\w.]+) \+ '\)'/g)].map((m) => m[1]);
    expect(varRefs.sort()).toEqual(['name', 'ts.lineHeight', 'ts.size', 'ts.weight']);
    expect(code).toContain('var ts = C.TEXT_STYLES[n.style] || C.TEXT_STYLES.body;');
    expect(code).toContain('el.textContent = n.text;');
    expect(code).not.toMatch(/\.textContent = [^;]*\+ *['"`]</);
  });

  it('talks to nothing: one fetch, for its own catalogue; no XHR, socket, beacon or form; three storage keys of its own', () => {
    expect((code.match(/\bfetch\(/g) || []).length).toBe(1);
    expect(code).toContain("fetch('/design-studio/i18n/' + LANG + '.json')");
    expect(code).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|\.submit\(|postMessage/);
    const keys = [...code.matchAll(/(?:get|set)Item\(([A-Z_]+|'[^']+')/g)].map((m) => m[1]);
    expect([...new Set(keys)].sort()).toEqual(['LOCALE_KEY', 'STORE_KEY', 'STORE_UNREADABLE']);
    expect(code).toContain("var STORE_KEY = 'familista_design_studio_document';");
  });

  it('checks every imported or stored file through the core, refuses one over 1 MB before reading it, and every storage call is guarded', () => {
    expect(code).toContain('if (file.size > LIMITS.bytes)');
    expect(code).toContain('var r = C.parseDocument(text);');
    expect(code).toContain('var r = C.parseDocument(raw);');
    for (const m of code.matchAll(/localStorage\.(getItem|setItem)/g)) {
      const before = code.slice(Math.max(0, m.index! - 160), m.index);
      expect(before).toMatch(/try \{/);
    }
  });

  it('cleans up after itself: every listener goes through listen(), and teardown removes them all', () => {
    const adds = (code.match(/addEventListener\(/g) || []).length;
    // listen() itself, plus the panel's own controls, which are rebuilt with the panel and die with it.
    expect(code).toContain('function listen(target, type, fn, opts) {');
    expect(code).toContain('S.off.push(function () { target.removeEventListener(type, fn, opts); });');
    // listen(), the panel's three kinds of control (name, number, token select) and the Enter/Escape return to the canvas.
    expect(adds).toBe(5);
    expect(code).toMatch(/listen\(document, 'keydown', onKeyDown\);/);
    expect(code).toMatch(/listen\(window, 'keyup', onKeyUp\);/);
    expect(code).toMatch(/function unbind\(\) \{[\s\S]*?S\.off\[i\]\(\)[\s\S]*?S\.ro\.disconnect\(\)/);
  });
});

describe('wiring: a separate product, for the platform owner only, asking the server for nothing', () => {
  it('app.js loads it on demand behind the same platform-owner check as Design System Control, three files under one version, the core first', () => {
    const loader = APP.slice(APP.indexOf('function _loadDesignStudio(done) {'), APP.indexOf('// ── NAVIGATION ──'));
    expect(loader).toContain('ask = _isPlatformOwner().then(function (yes) {');
    expect(loader).toContain("var v = '20261020-design-studio-1a';");
    expect(loader).toContain("var scripts = ['/design-studio/studio-core.js?v=' + v, '/design-studio/studio.js?v=' + v];");
    expect(loader).toContain("link.href = '/design-studio/studio.css?v=' + v;");
    expect(loader).toContain('script.async = false;');
    expect(loader).toContain("if (!yes) { finish(false); return; }");
    expect(APP).toContain("if (page === 'design-studio' && !(_ST_ROOM && _ST_ROOM.state === 'ready')) {");
    expect(APP).toMatch(/_loadDesignStudio\(function \(ok\) \{\s*try \{ navTo\(ok \? page : 'owner-home', ok \? el : null, _opts\); \} catch \(_\) \{\}/);
  });

  it('is its own page: allow-listed, its own template behind data-no-i18n in the owner token context, its own shell class and teardown, drawn on entry', () => {
    const allow = /var _ALLOWED_PAGES = \{([\s\S]*?)\};/.exec(APP)![1];
    expect(allow).toMatch(/'design-studio': 1,/);
    expect(APP).toContain("'design-studio':               renderDesignStudioHTML,");
    expect(APP).toContain('return `<div class="page" id="pg-design-studio" data-no-i18n data-fam-context="owner"><div id="st-root"></div></div>`;');
    expect(APP).toContain("document.body.classList.toggle('st-studio-open', page === 'design-studio');");
    expect(APP).toContain("if (_wasStudio && page !== 'design-studio' && typeof window.teardownFamilistaDesignStudio === 'function') {");
    const nav = APP.slice(APP.indexOf('function navTo(page, el, _opts) {'));
    const ds = nav.indexOf("window.renderFamilistaDesignSystem(_dsRoot);");
    const st = nav.indexOf("window.renderFamilistaDesignStudio(_stRoot);");
    expect(st).toBeGreaterThan(ds);
    expect(nav.slice(st - 300, st)).toContain("&& _stRoot && (_leaving !== 'pg-design-studio' || !_stRoot.__famDrawn)) {");
    expect(APP).toContain("'design-system':'Design System', 'design-studio':'Design Studio',");
  });

  it('is not a section of Design System Control, is not linked from the page, and changed no production screen renderer', () => {
    expect(read('public/design-system/design-system.js')).not.toMatch(/studio/i);
    expect(fs.readdirSync(path.join(ROOT, 'public/design-system')).some((f) => /studio/.test(f))).toBe(false);
    expect(read('public/index.html')).not.toContain('/design-studio/');
    const home = APP.slice(APP.indexOf('function renderOwnerHomeHTML() {'), APP.indexOf('function renderOwnerHome() {'));
    expect(home).not.toContain('design-studio');
  });

  it('adds no route, permission or CSP change: the server knows nothing of it and the policy is the one it was', () => {
    const src = (d: string): string[] => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? src(path.join(d, e.name)) : /\.ts$/.test(e.name) ? [path.join(d, e.name)] : []));
    const mentions = src('src').filter((f) => /design-studio|DesignStudio/.test(read(f)));
    expect(mentions).toEqual([]);
    const app = read('src/app.ts');
    expect(app).toContain(`scriptSrc:   ["'self'"],`);
    expect(app).toContain(`styleSrc:    ["'self'", 'https://fonts.googleapis.com'],`);
    expect(app).toContain(`frameSrc:    ["'none'"],`);
    const directives = app.slice(app.indexOf('directives: {'), app.indexOf('upgradeInsecureRequests'));
    expect(directives).not.toMatch(/unsafe-inline|unsafe-eval|'self'".*frameSrc|frameSrc:\s*\[\s*"'self'"/);
  });

  it('the Design Core knows it as a consumer: the token verifier allows it, and the production inventory lists its two stylesheets as a surface of their own', () => {
    expect(read('tools/tokens/scripts/verify.mjs')).toContain("const CONSUMERS = ['public/design-system/', 'public/design-studio/', 'public/agents-room/'];");
    expect(read('tools/tokens/lib/production.mjs')).toContain("{ id: 'studio', label: 'Familista Design Studio, loaded on demand by the main app', files: ['public/design-studio/studio.css', 'public/design-studio/studio-frame.css'] },");
  });

  it('frames load the same versioned token stylesheet as the page, and the frame stylesheet under the Studio\'s own version', () => {
    expect(STUDIO).toContain('link[rel="stylesheet"][href*="/tokens/familista-tokens.css"]');
    expect(STUDIO).toContain("return '/design-studio/studio-frame.css' + (v ? '?v=' + v[1] : '');");
  });
});

describe('English, German and Arabic — one catalogue each, in step', () => {
  const dict = (t: string) => JSON.parse(read(`public/design-studio/i18n/${t}.json`)) as Record<string, string>;
  const en = dict('en'); const de = dict('de'); const ar = dict('ar');
  const slots = (s: string) => (s.match(/%[ds]/g) || []).join('');
  // Words that read the same in German, and the product's own name for it there.
  const SAME_DE = new Set(['Design Studio', 'Display', 'Hand', 'Name', 'Text', 'Zoom']);

  it('has the same keys in all three, and English maps each key to itself', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(en)) expect(v).toBe(k);
  });

  it('translates every key, keeping every %s and %d slot in its order', () => {
    for (const k of Object.keys(en)) {
      for (const d of [de, ar]) {
        expect(d[k].trim().length).toBeGreaterThan(0);
        expect(`${k} → ${slots(d[k])}`).toBe(`${k} → ${slots(k)}`);
      }
      if (!SAME_DE.has(k)) expect(de[k]).not.toBe(k);
      expect(ar[k]).not.toBe(k);
      expect(ar[k]).toMatch(/[؀-ۿ]/);
    }
  });

  it('covers every literal the editor passes through T() and tf(), and every label in its vocabulary maps', () => {
    const calls = [...STUDIO.matchAll(/\b(?:T|tf)\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
    const maps = ['TYPE_LABEL', 'TOOL_LABEL', 'STYLE_LABEL', 'PROBLEM'].flatMap((n) => {
      const i = STUDIO.indexOf('var ' + n + ' = {');
      return [...STUDIO.slice(i, STUDIO.indexOf('};', i)).matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
    });
    const kb = STUDIO.slice(STUDIO.indexOf('var keys = [['), STUDIO.indexOf(']];', STUDIO.indexOf('var keys = [[')));
    const shortcuts = [...kb.matchAll(/\['[^']*', '([^']*)'\]/g)].map((m) => m[1]);
    const keys = [...new Set([...calls, ...maps, ...shortcuts, 'That change could not be made.'])].filter((k) => /[A-Za-z]{2}/.test(k));
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter((k) => !keys.includes(k))).toEqual([]);
  });

  it('is limited to English, German and Arabic, right to left for Arabic, behind the page\'s own boundary, and leaves the platform\'s catalogues alone', () => {
    expect(STUDIO).toContain("var LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];");
    expect(fs.readdirSync(path.join(ROOT, 'public/design-studio/i18n')).sort()).toEqual(['ar.json', 'de.json', 'en.json']);
    expect(STUDIO).not.toMatch(/\bI18N\b|\/i18n\/locales|\/i18n\/catalogue|familista\.locale/);
    expect(STUDIO).toMatch(/Object\.prototype\.hasOwnProperty\.call\(DICT, s\) \? DICT\[s\] : s/);
    expect(STUDIO).toContain("dir: 'ltr' }, [E.world, E.overlay, E.empty, E.textEdit]);");
  });
});

describe('stylesheets: tokens only, the owner rooms\' rules', () => {
  it('reads only --fam-* names the published token stylesheet declares, in the room, the frames and the editor', () => {
    const used = new Set([CSS, FRAME_CSS, STUDIO].flatMap((t) => [...t.matchAll(/var\((--fam-[a-z0-9-]+)\)/g)].map((m) => m[1])));
    expect(used.size).toBeGreaterThan(30);
    expect([...used].filter((n) => !declared.has(n))).toEqual([]);
  });

  it('declares no custom property and types no colour of its own', () => {
    for (const t of [CSS, FRAME_CSS]) {
      const body = t.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(body).not.toMatch(/(^|[;{\s])--[a-z][\w-]*\s*:/);
      expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
    }
  });

  it('owns the shell only while open, keeps every motion on a token duration, and has the escape hatch for small windows', () => {
    expect(CSS).toMatch(/body\.st-studio-open \.sidebar,/);
    expect(CSS).toContain('#pg-design-studio [hidden] { display: none !important; }');
    expect(CSS).not.toMatch(/^\[hidden\]/m);
    for (const m of CSS.matchAll(/transition:\s*([^;]+);/g)) expect(m[1]).toMatch(/var\(--fam-duration-/);
    expect(CSS).not.toMatch(/animation:/);
    expect(CSS).toContain('@media (max-width: 980px), (max-height: 620px) {');
    expect(CSS).toMatch(/\.st-panel \{[^}]*scrollbar-gutter: stable;/);
  });
});

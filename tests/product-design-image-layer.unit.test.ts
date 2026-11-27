/**
 * Design Studio, M2c-2 — a logo on the garment: the core's image layer (public/product-design/pd-core.js).
 *
 * An image layer names a brand-kit logo (its id) and that PNG's pixel size; it is a box like the others, held to the
 * printable area and the safe zone, and it is checked for print resolution at the size it is placed. Pinned here, each
 * refusal beside the acceptance it mirrors:
 *   · its shape: a UUID asset, a whole pixel size, nothing else; which logo it is cannot be changed by `set`;
 *   · the print-resolution warning below 150 dpi, on the lower of its two axes, and none at or above it;
 *   · it is a box: outside the printable area it is a blocker, as every box is.
 * Whether the logo is the design's club's is the server's question (product-design-persistence.integration.test.ts).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
const T = C.validateTemplate(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates/football-jersey.json'), 'utf8')));
const ASSET = '0f3c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function withLogo(layer: Row): Row {
  const doc = JSON.parse(C.serializeDocument(C.createDocument(T, 'Kit', {})));
  doc.surfaces[0].layers.push({ id: 'logo', type: 'image', name: 'Home crest', visible: true, locked: false, asset: ASSET, px: [600, 700], x: 270, y: 220, w: 60, h: 70, r: 0, w0: 60, h0: 70, ...layer });
  return doc;
}
const problems = (doc: Row): string[] => { try { C.validateDocument(doc, T); return []; } catch (e) { return ((e as Row).errors || [e]).map((x: Row) => x.code); } };
const findings = (doc: Row) => C.checkDesign(C.validateDocument(doc, T), T).filter((f: Row) => f.layer === 'logo');

describe('the image layer', () => {
  it('is a box layer whose logo and pixel size cannot be set, only placed', () => {
    expect(C.LAYER_TYPES).toContain('image');
    expect(C.BOX_TYPES).toContain('image');
    expect(C.KEYS.image).toEqual(['id', 'type', 'name', 'visible', 'locked', 'asset', 'px', 'x', 'y', 'w', 'h', 'r', 'w0', 'h0']);
    expect(C.SETTABLE.image).not.toContain('asset');
    expect(C.SETTABLE.image).not.toContain('px');
  });

  it('is accepted with a UUID logo and a whole pixel size, and refused otherwise (each beside the accepted one)', () => {
    expect(problems(withLogo({}))).toEqual([]);
    expect(problems(withLogo({ asset: 'logo.png' }))).toContain('bad-asset');
    expect(problems(withLogo({ asset: '../../etc/passwd' }))).toContain('bad-asset');
    expect(problems(withLogo({ px: [600] }))).toContain('bad-number');
    expect(problems(withLogo({ px: [600.5, 700] }))).toContain('bad-number');
    expect(problems(withLogo({ px: [0, 700] }))).toContain('bad-number');
    expect(problems(withLogo({ href: 'https://example.com/x.png' }))).toContain('unknown-field');
    expect(problems(withLogo({ color: 'c1' }))).toContain('unknown-field');
  });

  it('cannot be made to show another logo by an operation', () => {
    const doc = C.validateDocument(withLogo({}), T);
    expect(() => C.applyOp(doc, { op: 'set', target: { kind: 'layer', id: 'logo' }, key: 'asset', value: '11111111-1111-4111-8111-111111111111' })).toThrow();
    expect(() => C.applyOp(doc, { op: 'set', target: { kind: 'layer', id: 'logo' }, key: 'px', value: [4000, 4000] })).toThrow();
    expect(() => C.applyOp(doc, { op: 'set', target: { kind: 'layer', id: 'logo' }, key: 'w', value: 80 })).not.toThrow();
  });
});

describe('the print-resolution check', () => {
  it('reports a logo printed below 150 dpi, on the lower of its two axes, and none at or above it', () => {
    // 600 × 700 px at 60 × 70 mm: 254 dpi both ways.
    expect(C.imageDpi({ px: [600, 700], w: 60, h: 70 })).toBe(254);
    expect(findings(withLogo({}))).toEqual([]);
    // 600 px over 120 mm is 127 dpi: soft.
    const low = findings(withLogo({ w: 120, h: 70, w0: 120 }));
    expect(low).toEqual([{ severity: 'warning', code: 'low-resolution', surface: 'front', layer: 'logo', dpi: 127 }]);
    // exactly 150 dpi is not reported (negative control on the threshold): 600 px over 101.6 mm.
    expect(C.imageDpi({ px: [600, 700], w: 101.6, h: 70 })).toBe(150);
    expect(findings(withLogo({ w: 101.6, w0: 101.6 })).filter((f: Row) => f.code === 'low-resolution')).toEqual([]);
  });

  it('is a box like the others: outside the printable area it is a blocker', () => {
    expect(findings(withLogo({ x: 2000 - 40 })).map((f: Row) => f.code)).toContain('outside-print-area');
  });
});

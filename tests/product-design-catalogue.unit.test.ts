/**
 * Design Studio, M1a — the product catalogue.
 *
 * Released garments are reviewed template files listed in one registry, public/product-design/templates/index.json.
 * The editor offers exactly those, the server accepts designs for exactly those, and every other catalogue entry
 * stays Planned. Pinned here:
 *   · the registry is well formed, and every file it names is a valid template whose key is the one listed;
 *   · each released garment's starter design is valid, inside its safe areas, and says nothing untranslated;
 *   · the server accepts a design of each released garment and refuses one of a garment it does not know;
 *   · the editor's catalogue lists every released product, and no product is marked available by hand.
 * The garment geometry of every released template is pinned in product-design-garment.unit.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DesignDocumentError, validateDesignDocument } from '../src/platform/product-design/core';

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'public/product-design/templates');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const INDEX = read(path.join(DIR, 'index.json'));
type Entry = { product: string; file: string; key: string };
const ENTRIES: Entry[] = INDEX.templates;
const EDITOR = fs.readFileSync(path.join(ROOT, 'public/product-design/product-design.js'), 'utf8');
const LANGS = ['en', 'de', 'fr', 'es', 'ar'];
const CATALOGUES: Record<string, Record<string, string>> = Object.fromEntries(LANGS.map((l) => [l, read(path.join(ROOT, `public/product-design/i18n/${l}.json`))]));

describe('the registry', () => {
  it('is a template index, listing the match shirt and each released garment once', () => {
    expect(INDEX.format).toBe('familista.product-template-index');
    expect(INDEX.version).toBe(1);
    expect(ENTRIES.map((e) => e.product)).toEqual(['match-shirt', 'gk-shirt', 'training-top', 't-shirt']);
    expect(new Set(ENTRIES.map((e) => e.key)).size).toBe(ENTRIES.length);
    expect(new Set(ENTRIES.map((e) => e.file)).size).toBe(ENTRIES.length);
  });

  it.each(ENTRIES.map((e) => [e.product, e]))('%s: its file is a valid template with the key the registry lists', (_p, e) => {
    const entry = e as Entry;
    expect(entry.file).toMatch(/^[a-z0-9-]+\.json$/);
    const t = C.validateTemplate(read(path.join(DIR, entry.file)));
    expect(t.key).toBe(entry.key);
    expect(t.surfaces.map((s: { id: string }) => s.id)).toEqual(['front', 'back', 'sleeve-right', 'sleeve-left']);
  });

  it('negative control: a template whose key is not the registry’s is caught by the same comparison', () => {
    const t = C.validateTemplate({ ...read(path.join(DIR, 'goalkeeper-shirt.json')), key: 'something-else' });
    expect(t.key).not.toBe(ENTRIES[1].key);
  });
});

describe('each released garment', () => {
  it.each(ENTRIES.map((e) => [e.product, e]))('%s: the starter design is valid, inside its safe areas, and names nothing untranslated', (_p, e) => {
    const t = C.validateTemplate(read(path.join(DIR, (e as Entry).file)));
    const doc = C.createDocument(t, t.name, {});
    expect(C.checkDesign(doc, t)).toEqual([]);
    // What a new design shows of the template's own words: its name, its colours' names and its layers' names.
    const words = new Set<string>([t.name]);
    t.start.palette.forEach((c: { label: string }) => words.add(c.label));
    Object.values(t.start.surfaces as Record<string, { layers: Array<{ name: string }> }>).forEach((s) => s.layers.forEach((n) => words.add(n.name)));
    for (const w of words) for (const l of LANGS) expect([l, w, typeof CATALOGUES[l][w]]).toEqual([l, w, 'string']);
    // and the editor translates the colours a starter design names
    t.start.palette.forEach((c: { label: string }) => expect(EDITOR).toContain(`'${c.label}'`));
  });

  it('the long-sleeve garments have sleeves of at least 600 mm; the short-sleeve ones keep the match shirt’s', () => {
    const sleeve = (file: string) => C.validateTemplate(read(path.join(DIR, file))).surfaces.find((s: { id: string }) => s.id === 'sleeve-right');
    // From the top of the sleeve head (the apex of its quadratic curve, at t = ½) to the cuff.
    const len = (s: { outline: number[][] }) => Math.max(...s.outline.map((q) => q[1])) - (s.outline[0][1] + 2 * s.outline[1][3] + s.outline[1][1]) / 4;
    expect(len(sleeve('goalkeeper-shirt.json'))).toBeGreaterThanOrEqual(600);
    expect(len(sleeve('training-top.json'))).toBeGreaterThanOrEqual(600);
    expect(sleeve('t-shirt.json').outline).toEqual(sleeve('football-jersey.json').outline);
  });
});

describe('the server', () => {
  it.each(ENTRIES.map((e) => [e.product, e]))('%s: a design of it is accepted, on its own template', (_p, e) => {
    const t = C.validateTemplate(read(path.join(DIR, (e as Entry).file)));
    const v = validateDesignDocument(JSON.parse(C.serializeDocument(C.createDocument(t, t.name, {}))));
    expect(v.document.template).toEqual({ key: t.key, version: t.templateVersion });
    expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a design of a garment it does not know, with the core’s own reason', () => {
    const t = C.validateTemplate(read(path.join(DIR, 't-shirt.json')));
    const doc = JSON.parse(C.serializeDocument(C.createDocument(t, t.name, {})));
    doc.template = { key: 'polo-shirt.classic', version: 1 };
    let err: unknown = null;
    try { validateDesignDocument(doc); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DesignDocumentError);
    expect((err as DesignDocumentError).problems.map((p) => p.code)).toContain('unknown-template');
  });

  it('refuses a design that names a released garment but an older or newer version of it', () => {
    const t = C.validateTemplate(read(path.join(DIR, 'goalkeeper-shirt.json')));
    const doc = JSON.parse(C.serializeDocument(C.createDocument(t, t.name, {})));
    doc.template.version = t.templateVersion + 1;
    expect(() => validateDesignDocument(doc)).toThrow(DesignDocumentError);
  });
});

describe('the editor’s catalogue', () => {
  it('lists every released product, reads availability from the registry, and marks nothing available by hand', () => {
    for (const e of ENTRIES) expect(EDITOR).toContain(`{ id: '${e.product}', label: L(`);
    expect(EDITOR).toContain("var e = entryForProduct(it.id), current = !!e && e.key === TEMPLATE.key;");
    expect(EDITOR).toContain("if (!e) { planned(b, 'product'); b.appendChild(chip(T('Planned'), 'muted')); }");
    expect(EDITOR).not.toMatch(/\blive: true\b/);
  });

  it('switches garments behind the unsaved-change guard, and opens a saved or imported design on its own garment', () => {
    expect(EDITOR).toContain("replacing('product', id, function () { switchTemplate(e.key, startNew); });");
    expect(EDITOR).toContain("if (typeof key === 'string' && key !== TEMPLATE.key && entryFor(key)) switchTemplate(key, opened); else opened();");
    expect(EDITOR).toContain("if (typeof key === 'string' && key !== TEMPLATE.key && entryFor(key)) { switchTemplate(key, function () { return importText(text); }); return; }");
    // A document that cannot be put in place leaves the editor on the garment it was on.
    expect(EDITOR).toContain('if (then() === false) TEMPLATE = prev;');
  });
});
